/**
 * 1.3 Order Desk & TNA — service layer (brief §Operations).
 *
 * All business logic lives here; the pure scheduling arithmetic lives in `tna.ts` and is
 * called from here. Every function takes `ctx` and runs inside `withTenantTx`, so the
 * audit row and the outbox event commit with the data change or not at all.
 *
 * `orders` is a ⚖ table: every mutation writes `audit_log` through the core interceptor.
 * When a buyer disputes a quantity eighteen months later, the answer has to be a row,
 * not a recollection.
 */
import { and, asc, eq, inArray, sql } from 'drizzle-orm'

import { factoryToday } from '@/lib/dates'
import { compositeKey } from '@/lib/keys'
import { roundToScale, toMinor } from '@/lib/quantity'

import {
  orderBreakdowns,
  orderRevisions,
  orderStyles,
  orders,
  tnaMilestones,
  tnaTemplates,
} from '@/modules/orders/schema'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { type TenantDb, withTenantRead, withTenantTx } from '../core/tenancy'

import { ORDER_EVENTS } from './events'
import {
  deriveMilestoneStatus,
  EX_FACTORY_MILESTONE,
  generateSchedule,
  previewRipple as previewRipplePure,
  type ResolvedDependency,
  type RipplePreview,
  type ScheduledMilestone,
  type TnaTemplate,
  TnaError,
} from './tna'
import {
  breakdownCell,
  createOrderPayload,
  orderFromPoDraft,
  orderRevisionDraft,
  orderStylePayload,
  tnaTemplatePayload,
  type SaveBreakdownPayload,
} from './zod'

/** ⚖ — money-bearing and disputed years later. */
registerAuditedTables('orders', 'order_breakdowns', 'order_revisions')

/**
 * Order lifecycle (brief §Entities). Transitions only as declared; anything else is a
 * typed 409 rather than a silently-ignored update.
 *
 * `cancelled` is reachable only before anything has shipped — once goods are on a vessel
 * the order is settled through shipment and finance, not by cancelling the record.
 */
export const orderStatusMachine = defineStateMachine({
  field: 'status',
  initial: 'confirmed',
  transitions: {
    confirmed: ['in_production', 'cancelled'],
    in_production: ['shipped_partial', 'shipped_full', 'cancelled'],
    shipped_partial: ['shipped_full', 'closed'],
    shipped_full: ['closed'],
    closed: [],
    cancelled: [],
  },
})

export type OrderStatus = (typeof orderStatusMachine.states)[number]

/** Once production has started, a breakdown edit is a revision, not a correction. */
const PRODUCTION_STARTED: readonly OrderStatus[] = [
  'in_production',
  'shipped_partial',
  'shipped_full',
  'closed',
]

// ─────────────────────────────────────────────────────────────────────────────
// Breakdown
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Total pieces across the grid, and whether that total is acceptable against what the
 * buyer contracted.
 *
 * Pure and exported so the check is unit-testable and so the UI can show the same number
 * before submitting — the gate itself is still enforced here, server-side (rule 8).
 */
export function checkBreakdownTotal(input: {
  cells: readonly { qty: number }[]
  contractedQty: number | null
  tolerancePct: string
}): { totalQty: number; withinTolerance: boolean; allowedMin: number; allowedMax: number } {
  const totalQty = input.cells.reduce((sum, cell) => sum + cell.qty, 0)

  if (input.contractedQty === null) {
    return { totalQty, withinTolerance: true, allowedMin: totalQty, allowedMax: totalQty }
  }

  // Tolerance is a percentage as a decimal string. Integer maths on basis points keeps
  // it exact — a float here would put the boundary case on the wrong side. toMinor is
  // ×100 with no float in between; roundToScale first so a 3-decimal input rounds
  // half-up (what Math.round did) instead of throwing.
  const basisPoints = Number(toMinor(roundToScale(input.tolerancePct), 'tolerance percentage'))
  const slack = Math.floor((input.contractedQty * basisPoints) / 10_000)

  const allowedMin = input.contractedQty - slack
  const allowedMax = input.contractedQty + slack

  return {
    totalQty,
    withinTolerance: totalQty >= allowedMin && totalQty <= allowedMax,
    allowedMin,
    allowedMax,
  }
}

/**
 * Write the colour × size grid.
 *
 * Two paths, and which one you are on is a business fact rather than a UI preference:
 *
 *  - **Correction** — before production starts and not buyer-driven. Overwrites the
 *    active revision. A typo fixed the same afternoon is not history worth keeping.
 *  - **Revision** — the buyer asked, or production has already started. Writes a NEW
 *    revision and an `order_revisions` row with the diff. Someone is going to ask who
 *    authorised the change and against which document.
 */
export async function saveBreakdown(
  ctx: RequestCtx,
  input: SaveBreakdownPayload,
): Promise<BreakdownResult> {
  return withTenantTx(ctx, (tx) => saveBreakdownIn(ctx, tx, input))
}

export interface BreakdownResult {
  revision: number
  totalQty: number
  isNewRevision: boolean
  orderId: string
  before: Record<string, unknown>
  after: Record<string, unknown>
}

/**
 * The body of `saveBreakdown`, taking a transaction rather than opening one.
 *
 * Split out because the approve path needs to run it inside the transaction that already
 * holds the pending-change row locked. Calling the wrapper there would open a SECOND
 * transaction on another connection, which would then block forever waiting for locks the
 * first one holds — a deadlock that only shows up under approval, i.e. in production.
 */
export async function saveBreakdownIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: SaveBreakdownPayload,
): Promise<BreakdownResult> {
  const cells = input.cells.map((cell) => breakdownCell.parse(cell))

  // The grid is keyed by (colour, size); the same cell twice is a client bug that would
  // otherwise silently lose one of the two quantities to the unique index.
  const seen = new Set<string>()
  for (const cell of cells) {
    const key = compositeKey(cell.color, cell.size)
    if (seen.has(key)) {
      throw new AppError('validation_failed', 'orders.errors.duplicate_breakdown_cell', {
        color: cell.color,
        size: cell.size,
      })
    }
    seen.add(key)
  }

  {
    const [style] = await tx
      .select()
      .from(orderStyles)
      .where(scoped(orderStyles, ctx, eq(orderStyles.id, input.orderStyleId)))
      .for('update')

    if (!style) throw notFound('orders.errors.style_not_found', { id: input.orderStyleId })

    const [order] = await tx.select().from(orders).where(scoped(orders, ctx, eq(orders.id, style.orderId))).for('update')
    if (!order) throw notFound('orders.errors.order_not_found', { id: style.orderId })

    const totals = checkBreakdownTotal({
      cells,
      contractedQty: style.contractedQty,
      tolerancePct: order.qtyTolerancePct,
    })

    if (!totals.withinTolerance) {
      throw new AppError('validation_failed', 'orders.errors.breakdown_outside_tolerance', {
        totalQty: totals.totalQty,
        contractedQty: style.contractedQty,
        allowedMin: totals.allowedMin,
        allowedMax: totals.allowedMax,
        tolerancePct: order.qtyTolerancePct,
      })
    }

    const productionStarted = PRODUCTION_STARTED.includes(order.status as OrderStatus)
    const isNewRevision = input.buyerRevision || productionStarted
    const revision = isNewRevision ? style.activeRevision + 1 : style.activeRevision

    const before = await tx
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

    if (!isNewRevision) {
      // Replace the active revision wholesale: a partial update would leave cells the
      // new grid does not mention, and "the size ratio still has an XXL nobody ordered"
      // is a real way to over-cut.
      await tx
        .delete(orderBreakdowns)
        .where(scoped(orderBreakdowns, ctx, 
          and(eq(orderBreakdowns.orderStyleId, style.id), eq(orderBreakdowns.revision, revision)),
        ))
    }

    await tx.insert(orderBreakdowns).values(
      cells.map((cell) => ({
        companyId: ctx.companyId,
        orderStyleId: style.id,
        revision,
        color: cell.color,
        size: cell.size,
        qty: cell.qty,
      })),
    )

    if (isNewRevision) {
      await tx
        .update(orderStyles)
        .set({ activeRevision: revision, updatedAt: new Date() })
        .where(scoped(orderStyles, ctx, eq(orderStyles.id, style.id)))

      await tx.insert(orderRevisions).values({
        companyId: ctx.companyId,
        orderId: order.id,
        revision,
        diff: diffBreakdown(before, cells),
        reason: input.reason ?? null,
        documentId: input.documentId ?? null,
        createdBy: ctx.userId,
      })
    }

    const beforeImage = { revision: style.activeRevision, cells: before }
    const afterImage = { revision, cells }

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'order_breakdowns',
      targetId: style.id,
      before: beforeImage,
      after: afterImage,
    })

    await emit(ctx, tx, {
      eventName: ORDER_EVENTS.breakdownRevised,
      payload: {
        orderId: order.id,
        orderStyleId: style.id,
        revision,
        buyerRevision: input.buyerRevision,
        totalQty: totals.totalQty,
      },
      aggregateTable: 'orders',
      aggregateId: order.id,
    })

    return {
      revision,
      totalQty: totals.totalQty,
      isNewRevision,
      orderId: order.id,
      before: beforeImage,
      after: afterImage,
    }
  }
}

/**
 * Commit an approved buyer amendment (brief §Operations: `applyRevision`).
 *
 * This is the far end of the propose → approve → commit loop for 1.3: MARBIM drafts a
 * revision from the buyer's amendment email, a human approves it, and it lands here.
 *
 * `buyerRevision` is forced true regardless of what the draft said. An approved change
 * that came in through a buyer document is by definition the expensive kind, and letting
 * a payload field decide would allow a draft to overwrite the active revision and erase
 * what the floor was cutting to.
 */
export async function applyRevision(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }> {
  const payload = orderRevisionDraft.parse(input.payload)

  const result = await saveBreakdownIn(ctx, tx, {
    orderStyleId: payload.orderStyleId,
    cells: payload.cells,
    buyerRevision: true,
    reason: payload.reason,
    ...(payload.documentId === undefined ? {} : { documentId: payload.documentId }),
  })

  return { rowId: result.orderId, before: result.before, after: result.after }
}

/** Cell-level diff, computed server-side — never taken from the client. */
function diffBreakdown(
  before: readonly { color: string; size: string; qty: number }[],
  after: readonly { color: string; size: string; qty: number }[],
): Record<string, unknown> {
  const key = (cell: { color: string; size: string }) => `${cell.color}/${cell.size}`
  const beforeMap = new Map(before.map((c) => [key(c), c.qty]))
  const afterMap = new Map(after.map((c) => [key(c), c.qty]))

  const changes: Record<string, { from: number | null; to: number | null }> = {}
  for (const cellKey of new Set([...beforeMap.keys(), ...afterMap.keys()])) {
    const from = beforeMap.get(cellKey) ?? null
    const to = afterMap.get(cellKey) ?? null
    if (from !== to) changes[cellKey] = { from, to }
  }

  return {
    cells: changes,
    totalBefore: before.reduce((sum, c) => sum + c.qty, 0),
    totalAfter: after.reduce((sum, c) => sum + c.qty, 0),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// TNA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the order's calendar from a template and persist it.
 *
 * Regenerating replaces only milestones that have not happened yet. A schedule is not a
 * document you overwrite — actual dates are the record of what the factory did, and a
 * template change months later must not erase them.
 */
export async function generateTna(
  // AnyCtx: the rfq.won consumer generates a schedule as a system actor.
  ctx: AnyCtx,
  input: { orderId: string; templateId: string; exFactoryDate: string },
): Promise<{ milestones: ScheduledMilestone[]; preserved: number }> {
  return withTenantTx(ctx, async (tx) => {
    const [order] = await tx.select().from(orders).where(scoped(orders, ctx, eq(orders.id, input.orderId))).for('update')
    if (!order) throw notFound('orders.errors.order_not_found', { id: input.orderId })

    const [template] = await tx
      .select()
      .from(tnaTemplates)
      .where(scoped(tnaTemplates, ctx, eq(tnaTemplates.id, input.templateId)))
    if (!template) throw notFound('orders.errors.template_not_found', { id: input.templateId })

    const parsed = tnaTemplatePayload.safeParse({
      name: template.name,
      productType: template.productType,
      milestones: template.milestones,
    })
    if (!parsed.success) {
      // A template stored before a schema tightening, or hand-edited in the database.
      throw new AppError('validation_failed', 'orders.errors.template_invalid', {
        templateId: template.id,
        issues: parsed.error.issues.map((i) => i.message),
      })
    }

    let schedule: ScheduledMilestone[]
    try {
      schedule = generateSchedule({
        exFactoryDate: input.exFactoryDate,
        template: parsed.data as TnaTemplate,
      })
    } catch (error) {
      if (error instanceof TnaError) {
        throw new AppError('validation_failed', 'orders.errors.tna_template_unschedulable', {
          templateId: template.id,
          reason: error.message,
        })
      }
      throw error
    }

    const existing = await tx
      .select()
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.orderId, order.id)))

    const actualized = new Map(
      existing.filter((m) => m.actualDate).map((m) => [m.name, m.actualDate!]),
    )

    // Wipe only what has not happened. Recorded history stays.
    const replaceable = existing.filter((m) => !m.actualDate).map((m) => m.id)
    if (replaceable.length > 0) {
      await tx.delete(tnaMilestones).where(scoped(tnaMilestones, ctx, inArray(tnaMilestones.id, replaceable)))
    }

    const today = factoryToday()
    const rows = schedule
      .filter((milestone) => !actualized.has(milestone.name))
      .map((milestone) => ({
        companyId: ctx.companyId,
        orderId: order.id,
        name: milestone.name,
        plannedDate: milestone.plannedDate,
        dependsOn: milestone.dependsOn as unknown[],
        critical: milestone.critical,
        ownerRole: (milestone.ownerRole ?? null) as never,
        status: deriveMilestoneStatus({ plannedDate: milestone.plannedDate, today }) as never,
      }))

    if (rows.length > 0) await tx.insert(tnaMilestones).values(rows)

    const exFactory = schedule.find((m) => m.name === EX_FACTORY_MILESTONE)
    if (exFactory) {
      await tx
        .update(orders)
        .set({ plannedExFactoryDate: exFactory.plannedDate, updatedAt: new Date() })
        .where(scoped(orders, ctx, eq(orders.id, order.id)))
    }

    await emit(ctx, tx, {
      eventName: ORDER_EVENTS.tnaGenerated,
      payload: {
        orderId: order.id,
        templateId: template.id,
        exFactoryDate: input.exFactoryDate,
        milestoneCount: rows.length,
      },
      aggregateTable: 'orders',
      aggregateId: order.id,
    })

    return { milestones: schedule, preserved: actualized.size }
  })
}

/** Load an order's milestones in the shape the pure engine expects. */
async function loadSchedule(
  // `ctx`: the TNA is what every downstream date ripples from, so a schedule read from
  // another factory's order would move this one's milestones.
  ctx: AnyCtx,
  tx: TenantDb,
  orderId: string,
): Promise<ScheduledMilestone[]> {
  const rows = await tx
    .select()
    .from(tnaMilestones)
    .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.orderId, orderId)))
    .orderBy(asc(tnaMilestones.plannedDate))

  return rows.map((row) => ({
    name: row.name,
    plannedDate: row.plannedDate,
    actualDate: row.actualDate,
    dependsOn: (row.dependsOn ?? []) as ResolvedDependency[],
    critical: row.critical,
    ...(row.ownerRole ? { ownerRole: row.ownerRole } : {}),
  }))
}

/**
 * What actualizing this milestone WOULD do. Read-only by construction — the UI shows it
 * before the user commits, and a preview that wrote anything would make the cancel button
 * a lie (brief: "returns ripple preview first").
 */
export async function previewRipple(
  ctx: AnyCtx,
  input: { milestoneId: string; actualDate: string },
): Promise<RipplePreview & { orderId: string; milestoneName: string }> {
  return withTenantRead(ctx, async (tx) => {
    const [milestone] = await tx
      .select()
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.id, input.milestoneId)))

    if (!milestone) throw notFound('orders.errors.milestone_not_found', { id: input.milestoneId })

    const schedule = await loadSchedule(ctx, tx, milestone.orderId)
    const preview = previewRipplePure({
      schedule,
      milestone: milestone.name,
      actualDate: input.actualDate,
    })

    return { ...preview, orderId: milestone.orderId, milestoneName: milestone.name }
  })
}

/**
 * Record that a milestone actually happened, and move everything the slip pushes.
 *
 * The ripple is applied in the same transaction as the actual date. A version that wrote
 * the actual first and rescheduled after would leave the calendar inconsistent for
 * however long the second write took — and permanently, if it failed.
 */
export async function actualizeMilestone(
  // AnyCtx: the cutting- and shipment-completion consumers actualise milestones as a
  // system actor, and they must go through this rather than writing the table.
  ctx: AnyCtx,
  input: { milestoneId: string; actualDate: string },
): Promise<RipplePreview & { orderId: string }> {
  return withTenantTx(ctx, async (tx) => {
    const [milestone] = await tx
      .select()
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.id, input.milestoneId)))
      .for('update')

    if (!milestone) throw notFound('orders.errors.milestone_not_found', { id: input.milestoneId })
    if (milestone.actualDate) {
      throw conflict('orders.errors.milestone_already_actualized', {
        id: milestone.id,
        actualDate: milestone.actualDate,
      })
    }

    const schedule = await loadSchedule(ctx, tx, milestone.orderId)
    const ripple = previewRipplePure({
      schedule,
      milestone: milestone.name,
      actualDate: input.actualDate,
    })

    const today = factoryToday()

    await tx
      .update(tnaMilestones)
      .set({
        actualDate: input.actualDate,
        status: deriveMilestoneStatus({
          plannedDate: milestone.plannedDate,
          actualDate: input.actualDate,
          today,
        }) as never,
        updatedAt: new Date(),
      })
      .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.id, milestone.id)))

    for (const change of ripple.changes) {
      await tx
        .update(tnaMilestones)
        .set({
          plannedDate: change.toDate,
          status: deriveMilestoneStatus({ plannedDate: change.toDate, today }) as never,
          updatedAt: new Date(),
        })
        .where(scoped(tnaMilestones, ctx, 
          and(eq(tnaMilestones.orderId, milestone.orderId), eq(tnaMilestones.name, change.name)),
        ))
    }

    if (ripple.newExFactoryDate) {
      const [order] = await tx.select().from(orders).where(scoped(orders, ctx, eq(orders.id, milestone.orderId)))

      await tx
        .update(orders)
        .set({ plannedExFactoryDate: ripple.newExFactoryDate, updatedAt: new Date() })
        .where(scoped(orders, ctx, eq(orders.id, milestone.orderId)))

      await emit(ctx, tx, {
        eventName: ORDER_EVENTS.exFactorySlipped,
        payload: {
          orderId: milestone.orderId,
          fromDate: order?.plannedExFactoryDate ?? null,
          toDate: ripple.newExFactoryDate,
          slipDays: ripple.exFactorySlipDays,
          // The LC check runs in the consumer, which reads live credits under its own
          // scope — embedding a stale answer here would age badly in a queue.
          lcConflict: null,
        },
        aggregateTable: 'orders',
        aggregateId: milestone.orderId,
      })
    }

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'orders',
      targetId: milestone.orderId,
      before: { milestone: milestone.name, actualDate: null },
      after: {
        milestone: milestone.name,
        actualDate: input.actualDate,
        rippled: ripple.changes.length,
      },
    })

    await emit(ctx, tx, {
      eventName: ORDER_EVENTS.milestoneActualized,
      payload: {
        orderId: milestone.orderId,
        milestoneId: milestone.id,
        name: milestone.name,
        actualDate: input.actualDate,
        rippledCount: ripple.changes.length,
      },
      aggregateTable: 'orders',
      aggregateId: milestone.orderId,
    })

    return { ...ripple, orderId: milestone.orderId }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

export async function setOrderStatus(
  ctx: RequestCtx,
  input: { orderId: string; status: OrderStatus },
): Promise<{ from: OrderStatus; to: OrderStatus }> {
  return withTenantTx(ctx, async (tx) => {
    const [order] = await tx.select().from(orders).where(scoped(orders, ctx, eq(orders.id, input.orderId))).for('update')
    if (!order) throw notFound('orders.errors.order_not_found', { id: input.orderId })

    const from = order.status as OrderStatus
    // Throws a typed 409 listing the legal targets (CLAUDE.md rule 5).
    orderStatusMachine.assert(from, input.status)

    await tx
      .update(orders)
      .set({ status: input.status as never, updatedAt: new Date() })
      .where(scoped(orders, ctx, eq(orders.id, order.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'orders',
      targetId: order.id,
      before: { status: from },
      after: { status: input.status },
    })

    await emit(ctx, tx, {
      eventName: ORDER_EVENTS.statusChanged,
      payload: { orderId: order.id, from, to: input.status },
      aggregateTable: 'orders',
      aggregateId: order.id,
    })

    return { from, to: input.status }
  })
}


/** Recompute derived statuses for a set of orders. Used by the nightly scan. */
export async function refreshMilestoneStatuses(
  ctx: AnyCtx,
  input: { today?: string; riskWindowDays?: number } = {},
): Promise<{ updated: number }> {
  const today = input.today ?? factoryToday()

  return withTenantTx(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, sql`${tnaMilestones.actualDate} IS NULL`))

    let updated = 0
    for (const row of rows) {
      const status = deriveMilestoneStatus({
        plannedDate: row.plannedDate,
        today,
        ...(input.riskWindowDays === undefined ? {} : { riskWindowDays: input.riskWindowDays }),
      })
      if (status === row.status) continue

      await tx
        .update(tnaMilestones)
        .set({ status: status as never, updatedAt: new Date() })
        .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.id, row.id)))
      updated += 1
    }

    return { updated }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Creating an order ⚖
// ─────────────────────────────────────────────────────────────────────────────

export interface CreateOrderResult {
  orderId: string
  orderStyleIds: string[]
}

/**
 * Create an order and its styles ⚖.
 *
 * The entry point 1.2 reaches through when an RFQ is won, and the reason it lives here
 * rather than in the consumer: `orders` and `order_styles` have one writer module (rule 11),
 * and an order created by another module's INSERT would bypass the audit interceptor these
 * tables exist behind.
 *
 * **No breakdown is created.** An order breakdown is a colour × size grid, and an RFQ
 * carries a size RATIO — the colours come from the buyer's purchase order, which arrives
 * after the win. Inventing a placeholder colour to fill the grid would put a number on the
 * cutting floor that no buyer ever asked for. The gap is not silent: 5.1 already refuses to
 * spread a lay against a style with no breakdown, so the missing grid is caught by a gate
 * that exists rather than papered over here.
 */
export async function createOrder(
  ctx: AnyCtx,
  input: {
    order: unknown
    styles: unknown[]
    /** Set when this order came from a won RFQ, for the trail back to the quote. */
    sourceRfqId?: string
  },
): Promise<CreateOrderResult> {
  return withTenantTx(ctx, (tx) => createOrderIn(ctx, tx, input))
}

/**
 * The same creation, inside a transaction somebody else opened.
 *
 * Split out for the pending-change commit handler, which is handed core's `tx` and must
 * write in it — the audit row, the outbox event and the order have to land together or
 * not at all. Same shape as `saveBreakdown` / `saveBreakdownIn` above.
 */
export async function createOrderIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { order: unknown; styles: unknown[]; sourceRfqId?: string },
): Promise<CreateOrderResult> {
  const orderInput = createOrderPayload.parse(input.order)
  const styleInputs = input.styles.map((style) => orderStylePayload.parse(style))

  if (styleInputs.length === 0) {
    // An order with no style is an order nobody can cost, cut or ship.
    throw new AppError('validation_failed', 'orders.errors.no_styles', {})
  }

  return (async () => {
    const { buyers } = await import('@/modules/buyers/schema')
    const [buyer] = await tx
      .select({ id: buyers.id })
      .from(buyers)
      .where(scoped(buyers, ctx, eq(buyers.id, orderInput.buyerId)))

    // Postgres runs foreign-key checks with RLS bypassed, so the FK alone does not enforce
    // tenancy (rule 2 — the app layer is the first wall).
    if (!buyer) {
      throw notFound('orders.errors.buyer_not_found', { buyerId: orderInput.buyerId })
    }

    const [order] = await tx
      .insert(orders)
      .values({
        companyId: ctx.companyId,
        buyerId: orderInput.buyerId,
        poNumbers: orderInput.poNumbers,
        totalValue: orderInput.totalValue ?? null,
        currency: orderInput.currency,
        plannedExFactoryDate: orderInput.plannedExFactoryDate ?? null,
        ownerUserId: orderInput.ownerUserId ?? null,
        agentSnapshot: orderInput.agentSnapshot ?? {},
        sourceRfqId: input.sourceRfqId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: orders.id })

    if (!order) throw new Error('orders insert returned nothing')

    const orderStyleIds: string[] = []
    for (const style of styleInputs) {
      const [row] = await tx
        .insert(orderStyles)
        .values({
          companyId: ctx.companyId,
          orderId: order.id,
          styleCode: style.styleCode,
          description: style.description ?? null,
          contractedQty: style.contractedQty ?? null,
          unitPrice: style.unitPrice ?? null,
          currency: style.currency,
        })
        .returning({ id: orderStyles.id })

      if (!row) throw new Error('order_styles insert returned nothing')
      orderStyleIds.push(row.id)
    }

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'orders',
      targetId: order.id,
      after: {
        buyerId: orderInput.buyerId,
        poNumbers: orderInput.poNumbers,
        currency: orderInput.currency,
        plannedExFactoryDate: orderInput.plannedExFactoryDate ?? null,
        styles: styleInputs.map((s) => s.styleCode),
        sourceRfqId: input.sourceRfqId ?? null,
      },
    })

    await emit(ctx, tx, {
      eventName: ORDER_EVENTS.created,
      payload: {
        orderId: order.id,
        buyerId: orderInput.buyerId,
        poNumbers: orderInput.poNumbers,
        orderStyleIds,
        sourceRfqId: input.sourceRfqId ?? null,
      },
      aggregateTable: 'orders',
      aggregateId: order.id,
    })

    return { orderId: order.id, orderStyleIds }
  })()
}

/**
 * Commit an order drafted from a buyer's PO ⚖ — the far end of intake for 1.3.
 *
 * Core's generic write cannot do this, and the failure was not subtle: it treats payload
 * keys as literal column names, so `poNumbers` was refused as an invalid identifier and
 * every PO draft ever made was uncommittable. Going through `createOrderIn` also gets the
 * things a row write would have skipped — the buyer's tenancy re-check, the style rows,
 * the audit entry and `orders.created` for the TNA to hang off.
 */
export async function applyOrderFromPo(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    // Amending an existing order is `order_revisions` work, and routing an update here
    // would let a draft rewrite a confirmed order's quantities with no revision trail.
    throw new AppError('validation_failed', 'orders.errors.po_draft_insert_only', {
      operation: input.operation,
    })
  }

  const { styles, ...order } = orderFromPoDraft.parse(input.payload)

  const result = await createOrderIn(ctx, tx, { order, styles })

  /*
   * The grid the PO carried, saved with the order rather than left for somebody to re-type.
   *
   * `createOrderIn` returns the style ids in the order it was given the styles, which is
   * what makes this mapping safe — and the reason it is asserted here rather than assumed
   * is that a silent misalignment would attach one style's sizes to another's.
   *
   * A breakdown that does not add up to the contracted quantity is NOT corrected here.
   * `saveBreakdownIn` has the gate for that and it belongs there; the point of committing
   * the grid at all is that the approver saw both numbers before signing.
   */
  const breakdowns: number[] = []
  for (const [i, style] of styles.entries()) {
    const cells = (style as { breakdown?: { color: string; size: string; qty: number }[] }).breakdown
    if (!cells?.length) continue

    const orderStyleId = result.orderStyleIds[i]
    if (!orderStyleId) throw new Error('createOrderIn returned fewer style ids than styles')

    const saved = await saveBreakdownIn(ctx, tx, {
      orderStyleId,
      cells,
      buyerRevision: false,
      reason: 'read from the buyer’s purchase order',
    })
    breakdowns.push(saved.totalQty)
  }

  return {
    rowId: result.orderId,
    before: null,
    after: {
      orderId: result.orderId,
      orderStyleIds: result.orderStyleIds,
      ...(breakdowns.length > 0 ? { breakdownTotals: breakdowns } : {}),
    },
  }
}

/**
 * The milestone with this name on this order, if there is one.
 *
 * Exposed so a consumer can reach `actualizeMilestone` — which takes a milestone ID —
 * from an event that only knows the order and what happened to it.
 */
export async function findMilestone(
  ctx: AnyCtx,
  input: { orderId: string; name: string },
): Promise<typeof tnaMilestones.$inferSelect | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, and(eq(tnaMilestones.orderId, input.orderId), eq(tnaMilestones.name, input.name))))
    return row ?? null
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Default TNA templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Give a company the default TNA templates.
 *
 * Idempotent and non-destructive: a template a factory has already customised is left
 * exactly as it is. These are a starting point, and overwriting somebody's tuned lead times
 * on a re-run would be the worst kind of helpful.
 *
 * Every template is validated through `tnaTemplatePayload` on the way in, so a default that
 * contradicts the milestone schema fails here rather than at the first order that uses it.
 */
export async function seedDefaultTnaTemplates(
  ctx: AnyCtx,
): Promise<{ created: string[]; existing: string[] }> {
  const { DEFAULT_TNA_TEMPLATES } = await import('./tna-defaults')

  return withTenantTx(ctx, async (tx) => {
    const created: string[] = []
    const existing: string[] = []

    for (const template of DEFAULT_TNA_TEMPLATES) {
      const parsed = tnaTemplatePayload.parse(template)

      const [already] = await tx
        .select({ id: tnaTemplates.id })
        .from(tnaTemplates)
        .where(scoped(tnaTemplates, ctx, eq(tnaTemplates.productType, parsed.productType)))

      if (already) {
        existing.push(parsed.productType)
        continue
      }

      await tx.insert(tnaTemplates).values({
        companyId: ctx.companyId,
        name: parsed.name,
        productType: parsed.productType,
        milestones: parsed.milestones,
      })
      created.push(parsed.productType)
    }

    return { created, existing }
  })
}

/**
 * The active template for a product type, or null.
 *
 * Resolves the merchandiser's free-text product type through the alias map first — "tee",
 * "t-shirt" and "polo" all run on the knit calendar. Null rather than a fallback: the
 * shortest template would silently flatter every unfamiliar product, and an order given a
 * 90-day schedule when it needed 150 has a wrong ship date from the day it was created.
 */
export async function findTemplateForProductType(
  ctx: AnyCtx,
  input: { productType: string },
): Promise<typeof tnaTemplates.$inferSelect | null> {
  const { resolveProductType } = await import('./tna-defaults')
  const resolved = resolveProductType(input.productType)

  return withTenantRead(ctx, async (tx) => {
    // The raw value first: a factory that added its own "swimwear" template should get it
    // even though the alias map has never heard of swimwear.
    for (const candidate of [input.productType, resolved].filter(Boolean) as string[]) {
      const [row] = await tx
        .select()
        .from(tnaTemplates)
        .where(scoped(tnaTemplates, ctx, and(eq(tnaTemplates.productType, candidate), eq(tnaTemplates.isActive, true))))
      if (row) return row
    }
    return null
  })
}
