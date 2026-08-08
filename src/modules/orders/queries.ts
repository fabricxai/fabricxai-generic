/**
 * Read models for the Order Desk.
 *
 * Nothing here writes, and nothing here recomputes a schedule — milestone dates
 * and statuses come from the rows the TNA engine wrote. A screen that re-derived
 * "is this late?" would eventually disagree with the job that escalates it, and
 * then the desk and the alert would be telling a merchandiser different things.
 */
import { and, asc, desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'

import { buyers } from '@/modules/buyers/schema'
import { likePattern } from '@/lib/search-text'
import type { AnyCtx } from '@/modules/core/ctx'
import { readJsonbArray } from '@/modules/core/jsonb'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'

import { users } from '@/db/schema/core'

import {
  orderBreakdowns,
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
