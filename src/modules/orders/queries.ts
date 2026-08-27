/**
 * Read models for the Order Desk.
 *
 * Nothing here writes, and nothing here recomputes a schedule — milestone dates
 * and statuses come from the rows the TNA engine wrote. A screen that re-derived
 * "is this late?" would eventually disagree with the job that escalates it, and
 * then the desk and the alert would be telling a merchandiser different things.
 */
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'

import { buyers } from '@/modules/buyers/schema'
import { likePattern } from '@/lib/search-text'
import type { AnyCtx } from '@/modules/core/ctx'
import { readJsonbArray } from '@/modules/core/jsonb'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'

import { auditLog, documents, pendingChanges, users } from '@/db/schema/core'

import {
  orderBreakdowns,
  orderFiles,
  orderRevisions,
  orderStyles,
  orders,
  tnaMilestones,
  tnaTemplates,
} from './schema'
import { milestoneDependency } from './zod'

/** How a row reads on the desk: the worst thing true about the order. */
export type OrderHealth = 'ok' | 'risk' | 'late' | 'done'

export interface OrderListRow {
  id: string
  poNumbers: string[]
  buyerName: string | null
  /**
   * The headline style's id. Needed by anything that acts ON the style rather than merely
   * naming it — the planning board books a line against a style, and without this an
   * allocation was written with no style at all and the board printed "style not set" for
   * work it had just planned.
   */
  orderStyleId: string | null
  styleCode: string | null
  description: string | null
  contractedQty: number | null
  totalValue: string | null
  currency: string
  plannedExFactoryDate: string | null
  status: string
  health: OrderHealth
  /** The milestone driving the health, so the row can say WHY. */
  headline: string | null
  daysToExFactory: number | null
}

function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000)
}

/**
 * Health is derived from milestones, not stored.
 *
 * A stored health column is a cache that goes stale the moment a date moves,
 * and the failure mode is silent: the desk shows green while the critical path
 * is four days gone.
 */
function healthOf(
  status: string,
  milestones: readonly { status: string | null; critical: boolean | null; name: string }[],
): { health: OrderHealth; headline: string | null } {
  if (status === 'closed' || status === 'cancelled') return { health: 'done', headline: null }

  const late = milestones.filter((m) => m.status === 'late')
  if (late.length > 0) {
    // The critical-path one first — it is the one that moves the ship date.
    const worst = late.find((m) => m.critical) ?? late[0]!
    return { health: 'late', headline: worst.name }
  }

  // `at_risk` is the only status anybody can still act on, so it surfaces as
  // the headline even though nothing has actually slipped yet.
  const atRisk = milestones.find((m) => m.status === 'at_risk')
  if (atRisk) return { health: 'risk', headline: atRisk.name }

  return { health: 'ok', headline: null }
}

export async function orderList(ctx: AnyCtx, input: { now: Date } = { now: new Date() }): Promise<OrderListRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        totalValue: orders.totalValue,
        currency: orders.currency,
        status: orders.status,
        plannedExFactoryDate: orders.plannedExFactoryDate,
        buyerName: buyers.name,
      })
      .from(orders)
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .orderBy(desc(orders.createdAt))
      .limit(200)

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)

    const [styles, milestones] = await Promise.all([
      tx
        .select({
          id: orderStyles.id,
          orderId: orderStyles.orderId,
          styleCode: orderStyles.styleCode,
          description: orderStyles.description,
          contractedQty: orderStyles.contractedQty,
        })
        .from(orderStyles)
        .where(scoped(orderStyles, ctx, inArray(orderStyles.orderId, ids))),
      tx
        .select({
          orderId: tnaMilestones.orderId,
          name: tnaMilestones.name,
          status: tnaMilestones.status,
          critical: tnaMilestones.critical,
        })
        .from(tnaMilestones)
        .where(scoped(tnaMilestones, ctx, inArray(tnaMilestones.orderId, ids))),
    ])

    return rows.map((row) => {
      // First style is the headline one; multi-style orders show the rest in detail.
      const style = styles.find((s) => s.orderId === row.id) ?? null
      const mine = milestones.filter((m) => m.orderId === row.id)
      const { health, headline } = healthOf(row.status, mine)

      return {
        id: row.id,
        poNumbers: row.poNumbers ?? [],
        buyerName: row.buyerName,
        orderStyleId: style?.id ?? null,
        styleCode: style?.styleCode ?? null,
        description: style?.description ?? null,
        contractedQty: style?.contractedQty ?? null,
        totalValue: row.totalValue,
        currency: row.currency,
        plannedExFactoryDate: row.plannedExFactoryDate,
        status: row.status,
        health,
        headline,
        daysToExFactory: row.plannedExFactoryDate
          ? daysBetween(input.now, new Date(row.plannedExFactoryDate))
          : null,
      }
    })
  })
}

export interface MilestoneRow {
  id: string
  name: string
  plannedDate: string | null
  actualDate: string | null
  /**
   * What this milestone waits on. The engine stores two shapes — a bare name,
   * or `{name, gapDays}` when the gap is deliberate rather than bare spacing
   * (PP approval → cutting is 4 days for a reason). Both are normalised here so
   * a screen cannot silently drop the ones that carry a gap.
   */
  dependsOn: { name: string; gapDays: number | null }[]
  /** Dependencies stored on the row that would not parse. Non-zero means the
      list above is incomplete and the screen must say so. */
  dependsOnUnreadable: number
  critical: boolean
  ownerRole: string | null
  status: string
}

export interface BreakdownCell {
  color: string
  size: string
  qty: number
}

export interface OrderDetail {
  id: string
  poNumbers: string[]
  buyerName: string | null
  status: string
  totalValue: string | null
  currency: string
  plannedExFactoryDate: string | null
  qtyTolerancePct: string | null
  style: {
    id: string
    styleCode: string
    description: string | null
    contractedQty: number | null
    unitPrice: string | null
    currency: string
    activeRevision: number
    /* The dossier fields — the style as the buyer describes it. Null where nobody has
       said yet, which for a hand-entered style is most of them. */
    season: string | null
    customerLabel: string | null
    patternNo: string | null
    basedOnStyle: string | null
    packingMethod: string | null
  } | null
  milestones: MilestoneRow[]
  breakdown: BreakdownCell[]
  /**
   * Why each revision happened, newest first. Written as evidence since the module
   * shipped — cell-level before/after, reason, author — and read by NOTHING until a live
   * tester approved an amendment and asked "where does it show the changes?". The row
   * that answers "the buyer says they never asked for that" answers nobody while only
   * the database can see it.
   */
  revisions: RevisionRow[]
  health: OrderHealth
}

export interface RevisionRow {
  revision: number
  reason: string | null
  /** `{from: null}` is a new cell; `{to: null}` a removed one. */
  cells: { key: string; from: number | null; to: number | null }[]
  totalBefore: number | null
  totalAfter: number | null
  byName: string | null
  at: Date
}

export async function orderDetail(ctx: AnyCtx, orderId: string): Promise<OrderDetail | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        status: orders.status,
        totalValue: orders.totalValue,
        currency: orders.currency,
        plannedExFactoryDate: orders.plannedExFactoryDate,
        qtyTolerancePct: orders.qtyTolerancePct,
        buyerName: buyers.name,
      })
      .from(orders)
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .where(scoped(orders, ctx, eq(orders.id, orderId)))

    if (!row) return null

    const [style] = await tx
      .select()
      .from(orderStyles)
      .where(scoped(orderStyles, ctx, eq(orderStyles.orderId, orderId)))
      .orderBy(asc(orderStyles.createdAt))

    const milestones = await tx
      .select()
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.orderId, orderId)))
      .orderBy(asc(tnaMilestones.plannedDate))

    // Only the ACTIVE revision. Showing every revision's cells at once is how a
    // cutting floor ends up working from a grid nobody approved.
    const breakdown = style
      ? await tx
          .select({
            color: orderBreakdowns.color,
            size: orderBreakdowns.size,
            qty: orderBreakdowns.qty,
          })
          .from(orderBreakdowns)
          .where(scoped(orderBreakdowns, ctx, 
            and(
              eq(orderBreakdowns.orderStyleId, style.id),
              eq(orderBreakdowns.revision, style.activeRevision),
            ),
          ))
      : []

    // The name is joined THROUGH the tenant-scoped revisions row — `users` is global and
    // must never be reached bare (rule 2; same shape as the approvals trail).
    const revisionRows = await tx
      .select({
        revision: orderRevisions.revision,
        reason: orderRevisions.reason,
        diff: orderRevisions.diff,
        at: orderRevisions.createdAt,
        byName: users.name,
      })
      .from(orderRevisions)
      .leftJoin(users, eq(users.id, orderRevisions.createdBy))
      .where(scoped(orderRevisions, ctx, eq(orderRevisions.orderId, orderId)))
      .orderBy(desc(orderRevisions.revision))

    const revisions: RevisionRow[] = revisionRows.map((r) => {
      const diff = (r.diff ?? {}) as {
        cells?: Record<string, { from?: number | null; to?: number | null }>
        totalBefore?: number
        totalAfter?: number
      }
      return {
        revision: r.revision,
        reason: r.reason,
        cells: Object.entries(diff.cells ?? {}).map(([key, change]) => ({
          key,
          from: change?.from ?? null,
          to: change?.to ?? null,
        })),
        totalBefore: diff.totalBefore ?? null,
        totalAfter: diff.totalAfter ?? null,
        byName: r.byName,
        at: r.at,
      }
    })

    const { health } = healthOf(row.status, milestones)

    return {
      id: row.id,
      poNumbers: row.poNumbers ?? [],
      buyerName: row.buyerName,
      status: row.status,
      totalValue: row.totalValue,
      currency: row.currency,
      plannedExFactoryDate: row.plannedExFactoryDate,
      qtyTolerancePct: row.qtyTolerancePct,
      style: style
        ? {
            id: style.id,
            styleCode: style.styleCode,
            description: style.description,
            contractedQty: style.contractedQty,
            unitPrice: style.unitPrice,
            currency: style.currency,
            activeRevision: style.activeRevision,
            season: style.season,
            customerLabel: style.customerLabel,
            patternNo: style.patternNo,
            basedOnStyle: style.basedOnStyle,
            packingMethod: style.packingMethod,
          }
        : null,
      milestones: milestones.map((m) => {
        const deps = readJsonbArray(
          milestoneDependency,
          m.dependsOn,
          'tna_milestones.depends_on',
        )
        return {
          id: m.id,
          name: m.name,
          plannedDate: m.plannedDate,
          actualDate: m.actualDate,
          dependsOn: deps.items,
          dependsOnUnreadable: deps.unreadable,
          critical: m.critical ?? false,
          ownerRole: m.ownerRole,
          status: m.status,
        }
      }),
      breakdown,
      revisions,
      health,
    }
  })
}

export interface CoverableOrder {
  id: string
  poNumbers: string[]
  plannedExFactoryDate: string | null
  status: string
}

/**
 * A buyer's live orders, for commercial to pick which one a credit covers.
 *
 * Lives here because the rows are this module's (rule 11) while the LINK is commercial's
 * decision — its `linkOrder` writes `order_lcs`, and this is the list its screen picks
 * from. Settled orders are out: a credit tied to an order that already shipped in full is
 * an entry in a drawer, not a cover.
 */
export async function coverableOrders(ctx: AnyCtx, buyerId: string): Promise<CoverableOrder[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        plannedExFactoryDate: orders.plannedExFactoryDate,
        status: orders.status,
      })
      .from(orders)
      .where(
        scoped(
          orders,
          ctx,
          and(
            eq(orders.buyerId, buyerId),
            sql`${orders.status} NOT IN ('shipped_full', 'closed', 'cancelled')`,
          ),
        ),
      )
      .orderBy(asc(orders.plannedExFactoryDate))

    return rows.map((row) => ({ ...row, poNumbers: row.poNumbers ?? [] }))
  })
}

export interface OrderInProduction {
  id: string
  poNumber: string | null
  contractedQty: number
  /** TNA `sewing_end`, or null when the schedule does not set one. */
  sewingEndDate: string | null
  totalValue: string | null
  currency: string
}

/**
 * Orders the sewing floor is still burning down — the input to 6.1's run-rate risk alerts.
 *
 * Lives here because `orders`, `order_styles` and `tna_milestones` are the order module's
 * tables (rule 11). Production forecasts against them; it does not read them raw.
 *
 * Shipped, closed and cancelled orders are excluded: an order that has left the building
 * cannot be brought back on schedule, and an alert nobody can act on is one that teaches
 * people to ignore the rest. Orders with no contracted quantity are excluded too — there is
 * nothing to burn down against, so "at risk" would be meaningless rather than false.
 */
export async function ordersInProduction(ctx: AnyCtx): Promise<OrderInProduction[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        totalValue: orders.totalValue,
        currency: orders.currency,
        contractedQty: orderStyles.contractedQty,
      })
      .from(orders)
      .innerJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(scoped(orders, ctx, inArray(orders.status, ['confirmed', 'in_production'])))

    if (rows.length === 0) return []

    const sewingEnds = await tx
      .select({ orderId: tnaMilestones.orderId, plannedDate: tnaMilestones.plannedDate })
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, 
        and(
          inArray(
            tnaMilestones.orderId,
            rows.map((r) => r.id),
          ),
          eq(tnaMilestones.name, 'sewing_end'),
        ),
      ))

    const endByOrder = new Map(sewingEnds.map((m) => [m.orderId, m.plannedDate]))

    return rows
      .filter((row) => (row.contractedQty ?? 0) > 0)
      .map((row) => ({
        id: row.id,
        poNumber: (row.poNumbers ?? [])[0] ?? null,
        contractedQty: row.contractedQty!,
        sewingEndDate: endByOrder.get(row.id) ?? null,
        totalValue: row.totalValue,
        currency: row.currency,
      }))
  })
}


/** One order as the command bar shows it. */
export interface OrderSearchRow {
  id: string
  poNumber: string | null
  buyerName: string | null
  styleCode: string | null
}

/**
 * Orders matching a typed fragment of a PO number, buyer name or style code.
 *
 * Owned here rather than assembled by the shell (rule 11): the PO-number match has to
 * reach into a text[] column, and the de-duplication exists because the style join
 * multiplies rows per order. Both are facts about how 1.3 stores an order, and neither
 * belongs in a search box.
 */
export async function searchOrders(
  ctx: AnyCtx,
  input: { term: string; limit: number },
): Promise<OrderSearchRow[]> {
  const like = likePattern(input.term)

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        buyerName: buyers.name,
        styleCode: orderStyles.styleCode,
      })
      .from(orders)
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .leftJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(
        scoped(
          orders,
          ctx,
          or(
            sql`${orders.poNumbers}::text ilike ${like} escape '\\'`,
            ilike(buyers.name, like),
            ilike(orderStyles.styleCode, like),
          ),
        ),
      )
      .limit(input.limit * 2)

    const seen = new Set<string>()
    const hits: OrderSearchRow[] = []
    for (const row of rows) {
      if (seen.has(row.id)) continue
      seen.add(row.id)
      hits.push({
        id: row.id,
        poNumber: (row.poNumbers ?? [])[0] ?? null,
        buyerName: row.buyerName,
        styleCode: row.styleCode,
      })
      if (hits.length >= input.limit) break
    }
    return hits
  })
}

/**
 * The active TNA templates, as a picker's option list.
 *
 * For the desk's "generate the schedule" control. An order booked from a PO drop has no
 * TNA until somebody asks for one — `generateOrderTna` existed for exactly that ask and no
 * screen ever offered it, so a PO-born order's schedule tab was permanently empty while
 * the action that fills it sat unreachable.
 */
export async function tnaTemplateChoices(
  ctx: AnyCtx,
): Promise<{ id: string; name: string; productType: string }[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({ id: tnaTemplates.id, name: tnaTemplates.name, productType: tnaTemplates.productType })
      .from(tnaTemplates)
      .where(scoped(tnaTemplates, ctx, eq(tnaTemplates.isActive, true)))
      .orderBy(asc(tnaTemplates.name)),
  )
}

/**
 * The id behind a PO number — `PO-BF-2044`, as the buyer wrote it.
 *
 * `po_numbers` is an array because one order routinely answers to several: the buyer's own
 * number and the supplier reference their system issues. Any of them identifies the order,
 * which is exactly why a person asking about "PO-BF-2044" expects an answer whichever of the
 * two they happened to be handed.
 *
 * Exact containment, not a pattern — the GIN index makes it cheap, and a `LIKE` here would
 * make `PO-BF-204` match the wrong year's order.
 *
 * Ambiguity resolves to nothing rather than to the first row. Two orders sharing a PO number
 * should not exist, no constraint forbids it, and picking one silently is how the wrong
 * order gets shipped.
 */
export async function orderIdByPoNumber(ctx: AnyCtx, poNumber: string): Promise<string | null> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(scoped(orders, ctx, sql`${orders.poNumbers} @> ARRAY[${poNumber}]::text[]`))
      .limit(2)
    return rows.length === 1 ? rows[0]!.id : null
  })
}

export interface OrderFileRef {
  documentId: string
  filename: string
  /** What the filer called it — "buyer PO scan" — when they said; the filename otherwise. */
  label: string | null
  /** The document's domain kind ('buyer_po', 'lc', …) — the Documents tab groups by it. */
  kind: string | null
  filedAt: Date
}

/**
 * The order's filed documents, for the peek and (later) the workspace Documents tab.
 *
 * `order_files` has been the order↔document registry since the schema shipped and was
 * read by nothing; this is its first reader. Joined to core's `documents` for the
 * filename the way this file already joins `buyers` and `users` — a read, so rule 11's
 * single-writer concern does not arise, and soft-deleted files stay out the same way
 * `documentMeta` keeps them out.
 */
export async function orderFileRefs(ctx: AnyCtx, orderId: string): Promise<OrderFileRef[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        documentId: orderFiles.documentId,
        filename: documents.filename,
        label: orderFiles.label,
        kind: documents.kind,
        filedAt: orderFiles.createdAt,
      })
      .from(orderFiles)
      .innerJoin(
        documents,
        and(eq(documents.id, orderFiles.documentId), isNull(documents.deletedAt)),
      )
      .where(scoped(orderFiles, ctx, eq(orderFiles.orderId, orderId)))
      .orderBy(desc(orderFiles.createdAt)),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// The Order File timeline (specs/order-centric-core.md §2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One entry in the order's life, whichever table it left its trace in.
 *
 * A discriminated union rather than a prose string: the screen renders each kind in its
 * own shape, and a future consumer (the Pulse, a MARBIM narration) reads facts, not
 * sentences.
 */
export type TimelineEvent =
  | { kind: 'created'; at: Date; byName: string | null }
  | { kind: 'status'; at: Date; byName: string | null; from: string | null; to: string | null }
  | {
      kind: 'approval'
      at: Date
      byName: string | null
      targetTable: string
      source: string
    }
  | {
      kind: 'document'
      at: Date
      byName: string | null
      documentId: string
      filename: string
      label: string | null
    }
  | { kind: 'milestone'; at: Date; byName: string | null; name: string }
  | { kind: 'revision'; at: Date; byName: string | null; revision: number; reason: string | null }

/**
 * Everything that ever happened to this order, newest first — the Order File's spine.
 *
 * A READ MODEL, not a new store (spec §2 decided): the traces already exist — the ⚖
 * interceptor's `audit_log` rows, committed `pending_changes`, `order_files`, actualised
 * TNA milestones, `order_revisions` — and this merges them live. Nothing writes here, so
 * nothing can drift; if volume ever demands it, a materialised projection is an
 * optimisation behind the same shape, not a redesign.
 *
 * `audit_log` and `pending_changes` are CORE tables, read here the way this file already
 * reads `users` and `documents` — rule 11 is about the other MODULES' tables, and their
 * rows (requests, when X-4 lands) will come through their owners' queries.
 */
export async function orderTimeline(
  ctx: AnyCtx,
  orderId: string,
  input: { limit?: number } = {},
): Promise<TimelineEvent[]> {
  const limit = input.limit ?? 200

  return withTenantRead(ctx, async (tx) => {
    const [orderRow] = await tx
      .select({ at: orders.createdAt, byName: users.name })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.createdBy))
      .where(scoped(orders, ctx, eq(orders.id, orderId)))
    // Tenant-invisible and nonexistent are the same answer, as everywhere.
    if (!orderRow) return []

    const statusRows = await tx
      .select({
        at: auditLog.occurredAt,
        byName: users.name,
        before: auditLog.before,
        after: auditLog.after,
      })
      .from(auditLog)
      .leftJoin(users, eq(users.id, auditLog.actorUserId))
      .where(
        scoped(
          auditLog,
          ctx,
          and(
            eq(auditLog.targetTable, 'orders'),
            eq(auditLog.targetId, orderId),
            eq(auditLog.action, 'update'),
            sql`'status' = ANY(${auditLog.changedFields})`,
          ),
        ),
      )

    const approvalRows = await tx
      .select({
        at: pendingChanges.committedAt,
        byName: users.name,
        targetTable: pendingChanges.targetTable,
        source: pendingChanges.source,
      })
      .from(pendingChanges)
      .leftJoin(users, eq(users.id, pendingChanges.reviewedBy))
      .where(
        scoped(
          pendingChanges,
          ctx,
          and(
            eq(pendingChanges.moduleId, 'orders'),
            eq(pendingChanges.committedRowId, orderId),
            eq(pendingChanges.status, 'committed'),
          ),
        ),
      )

    const fileRows = await tx
      .select({
        at: orderFiles.createdAt,
        documentId: orderFiles.documentId,
        filename: documents.filename,
        label: orderFiles.label,
      })
      .from(orderFiles)
      .innerJoin(
        documents,
        and(eq(documents.id, orderFiles.documentId), isNull(documents.deletedAt)),
      )
      .where(scoped(orderFiles, ctx, eq(orderFiles.orderId, orderId)))

    const milestoneRows = await tx
      .select({ name: tnaMilestones.name, actualDate: tnaMilestones.actualDate })
      .from(tnaMilestones)
      .where(
        scoped(
          tnaMilestones,
          ctx,
          and(eq(tnaMilestones.orderId, orderId), sql`${tnaMilestones.actualDate} IS NOT NULL`),
        ),
      )

    const revisionRows = await tx
      .select({
        at: orderRevisions.createdAt,
        byName: users.name,
        revision: orderRevisions.revision,
        reason: orderRevisions.reason,
      })
      .from(orderRevisions)
      .leftJoin(users, eq(users.id, orderRevisions.createdBy))
      .where(scoped(orderRevisions, ctx, eq(orderRevisions.orderId, orderId)))

    const events: TimelineEvent[] = [
      { kind: 'created', at: orderRow.at, byName: orderRow.byName },
      ...statusRows.map(
        (row): TimelineEvent => ({
          kind: 'status',
          at: row.at,
          byName: row.byName,
          from: typeof row.before?.status === 'string' ? row.before.status : null,
          to: typeof row.after?.status === 'string' ? row.after.status : null,
        }),
      ),
      ...approvalRows.flatMap((row): TimelineEvent[] =>
        // committedAt is set in the same statement that marks the row committed; a null
        // here would be a corrupt row, and the timeline skips rather than invents a date.
        row.at
          ? [
              {
                kind: 'approval',
                at: row.at,
                byName: row.byName,
                targetTable: row.targetTable,
                source: row.source,
              },
            ]
          : [],
      ),
      ...fileRows.map(
        (row): TimelineEvent => ({
          kind: 'document',
          at: row.at,
          byName: null,
          documentId: row.documentId,
          filename: row.filename,
          label: row.label,
        }),
      ),
      ...milestoneRows.map(
        (row): TimelineEvent => ({
          kind: 'milestone',
          // A date column, not a timestamp: the completion is a factory-day fact, pinned
          // to midnight UTC so it sorts stably among the timestamped rows.
          at: new Date(`${row.actualDate}T00:00:00Z`),
          byName: null,
          name: row.name,
        }),
      ),
      ...revisionRows.map(
        (row): TimelineEvent => ({
          kind: 'revision',
          at: row.at,
          byName: row.byName,
          revision: row.revision,
          reason: row.reason,
        }),
      ),
    ]

    return events.sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit)
  })
}

/* ── The week, and the book's headline figures ────────────── */

/**
 * Every milestone falling in a window, across every open order (design canvas,
 * "Your week").
 *
 * The desk could already say which ORDERS were late. It could not say what a
 * merchandiser is supposed to DO today, which is the question the Excel order book
 * answered by being sorted by date — and the reason the book survived the app. This is
 * that column, read from the same `tna_milestones` rows the nightly scan escalates, so
 * the week and the alert cannot disagree.
 *
 * Milestones owned by other departments are included deliberately. A merchandiser is
 * accountable for the order, not for their own rows in it: trims landing late is
 * store's task and the merchandiser's problem, and a week that hid it would be a
 * calendar of only the things that were already under control.
 *
 * Closed and cancelled orders drop out — their dates are history, and history does not
 * belong in a week somebody is planning.
 */
export interface WeekMilestone {
  id: string
  orderId: string
  poNumber: string | null
  buyerName: string | null
  name: string
  plannedDate: string
  actualDate: string | null
  status: string
  critical: boolean
  ownerRole: string | null
}

export async function weekMilestones(
  ctx: AnyCtx,
  input: { from: string; to: string },
): Promise<WeekMilestone[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: tnaMilestones.id,
        orderId: tnaMilestones.orderId,
        name: tnaMilestones.name,
        plannedDate: tnaMilestones.plannedDate,
        actualDate: tnaMilestones.actualDate,
        status: tnaMilestones.status,
        critical: tnaMilestones.critical,
        ownerRole: tnaMilestones.ownerRole,
        poNumbers: orders.poNumbers,
        buyerName: buyers.name,
        orderStatus: orders.status,
      })
      .from(tnaMilestones)
      .innerJoin(orders, eq(orders.id, tnaMilestones.orderId))
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .where(
        scoped(
          tnaMilestones,
          ctx,
          and(
            sql`${tnaMilestones.plannedDate} >= ${input.from}`,
            sql`${tnaMilestones.plannedDate} <= ${input.to}`,
          ),
        ),
      )
      .orderBy(asc(tnaMilestones.plannedDate))
      .limit(300)

    return rows
      .filter((row) => row.orderStatus !== 'closed' && row.orderStatus !== 'cancelled')
      .map((row) => ({
        id: row.id,
        orderId: row.orderId,
        poNumber: row.poNumbers?.[0] ?? null,
        buyerName: row.buyerName,
        name: row.name,
        plannedDate: row.plannedDate,
        actualDate: row.actualDate,
        status: row.status,
        critical: row.critical,
        ownerRole: row.ownerRole,
      }))
  })
}

/**
 * The four figures across the top of the order desk (design canvas, "Your week").
 *
 * Every one is a sum over rows this module already owns, computed on read rather than
 * stored — the same reasoning as `healthOf` above. A cached book value is a number that
 * is wrong from the first amendment onward, and nobody would ever see it go stale.
 *
 * `bookValue` is summed PER CURRENCY and returned as a list. A factory quoting one buyer
 * in EUR and the rest in USD has two book values and no single one; adding them would
 * invent an exchange rate this module has no business holding an opinion about.
 */
export interface OrderBookSummary {
  openOrders: number
  lateOrders: number
  bookValue: { currency: string; total: string }[]
  /** Pieces whose planned ex-factory falls in the named month — what ships next. */
  shipping: { month: string; qty: number; poNumbers: string[] } | null
  /** Milestones not yet done that the scan has flagged, across the open book. */
  atRiskMilestones: number
  lateMilestones: number
}

/** Decimal strings added as scaled integers — these are money (rule 4). */
function sumMoney(amounts: readonly (string | null)[]): string {
  const total = amounts.reduce((acc, amount) => {
    if (!amount) return acc
    const negative = amount.startsWith('-')
    const [whole = '0', frac = ''] = (negative ? amount.slice(1) : amount).split('.')
    const scaled = BigInt(whole + frac.padEnd(2, '0').slice(0, 2))
    return negative ? acc - scaled : acc + scaled
  }, 0n)
  const negative = total < 0n
  const digits = (negative ? -total : total).toString().padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

export async function orderBookSummary(
  ctx: AnyCtx,
  input: { now: Date } = { now: new Date() },
): Promise<OrderBookSummary> {
  return withTenantRead(ctx, async (tx) => {
    const openRows = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        totalValue: orders.totalValue,
        currency: orders.currency,
        plannedExFactoryDate: orders.plannedExFactoryDate,
      })
      .from(orders)
      .where(
        scoped(orders, ctx, sql`${orders.status} NOT IN ('closed', 'cancelled')`),
      )
      .limit(500)

    if (openRows.length === 0) {
      return {
        openOrders: 0,
        lateOrders: 0,
        bookValue: [],
        shipping: null,
        atRiskMilestones: 0,
        lateMilestones: 0,
      }
    }

    const ids = openRows.map((row) => row.id)

    const [milestones, styles] = await Promise.all([
      tx
        .select({
          orderId: tnaMilestones.orderId,
          status: tnaMilestones.status,
        })
        .from(tnaMilestones)
        .where(scoped(tnaMilestones, ctx, inArray(tnaMilestones.orderId, ids))),
      tx
        .select({ orderId: orderStyles.orderId, contractedQty: orderStyles.contractedQty })
        .from(orderStyles)
        .where(scoped(orderStyles, ctx, inArray(orderStyles.orderId, ids))),
    ])

    // An order still being negotiated has no total yet. It counts as open, but it must not
    // conjure a currency bucket of its own — a book value of "0.00 EUR" reads as a real
    // figure somebody could act on, and it is the absence of one.
    const byCurrency = new Map<string, string[]>()
    for (const row of openRows) {
      if (row.totalValue === null) continue
      byCurrency.set(row.currency, [...(byCurrency.get(row.currency) ?? []), row.totalValue])
    }

    const lateOrderIds = new Set(
      milestones.filter((m) => m.status === 'late').map((m) => m.orderId),
    )

    /*
     * "Shipping in <month>" is the EARLIEST month still ahead that has orders in it —
     * not the current one. Asked at the end of a month, the current month's answer is
     * usually zero and reads as though the factory has nothing to ship, when what it
     * has is nothing to ship THIS WEEK.
     */
    const todayIso = input.now.toISOString().slice(0, 10)
    const upcoming = openRows
      .filter((row) => row.plannedExFactoryDate && row.plannedExFactoryDate >= todayIso)
      .sort((a, b) => (a.plannedExFactoryDate! < b.plannedExFactoryDate! ? -1 : 1))

    const month = upcoming[0]?.plannedExFactoryDate?.slice(0, 7) ?? null
    const qtyByOrder = new Map(styles.map((s) => [s.orderId, s.contractedQty ?? 0]))
    const inMonth = month
      ? upcoming.filter((row) => row.plannedExFactoryDate!.startsWith(month))
      : []

    return {
      openOrders: openRows.length,
      lateOrders: lateOrderIds.size,
      bookValue: [...byCurrency.entries()]
        .map(([currency, amounts]) => ({ currency, total: sumMoney(amounts) }))
        .sort((a, b) => a.currency.localeCompare(b.currency)),
      shipping: month
        ? {
            month,
            qty: inMonth.reduce((sum, row) => sum + (qtyByOrder.get(row.id) ?? 0), 0),
            poNumbers: inMonth.flatMap((row) => row.poNumbers?.slice(0, 1) ?? []),
          }
        : null,
      atRiskMilestones: milestones.filter((m) => m.status === 'at_risk').length,
      lateMilestones: milestones.filter((m) => m.status === 'late').length,
    }
  })
}
