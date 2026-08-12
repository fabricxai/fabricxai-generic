/**
 * 8.1 Finishing, Cartons & Shipment — service layer ⚖
 *
 * Three of the six named gates live here (rule 8):
 *
 *  1. **EXP number before bank documents.** An export permit number is mandatory per
 *     export shipment before the documents go to the bank. `handoffDocsToBank` refuses
 *     without it, and the refusal is recorded — somebody tried, and could not.
 *  2. **LC latest-shipment.** Confirming ex-factory after the LC's latest-shipment date is
 *     a discrepancy the bank can refuse the whole presentation on, so it is checked at the
 *     moment goods leave, against 2.1's own conflict detector.
 *  3. **Final inspection passed before departure** (7.1 → 8.1). This one BLOCKS, unlike the
 *     LC checks: the goods have not left yet — that is what `confirmExFactory` records — so
 *     refusing is still actionable, and shipping a lot the factory's own inspection failed
 *     is the one thing final inspection exists to prevent. Waivable by owner or commercial,
 *     never silently.
 *
 * Plus the LC tolerance band, which is a WARNING that escalates rather than a hard block:
 * a factory that has already made 1,060 pieces against a 1,050 ceiling cannot un-make
 * them, and the decision that matters is whether a manager accepts the discrepancy. That
 * acceptance goes through `pending_changes` and is stored on the shipment.
 */
import { and, asc, desc, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { assertGate, GATES } from '../core/gates'
import { notify } from '../core/notifications'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { SHIPMENT_EVENTS } from './events'
import {
  cartonCbm,
  chargeableWeightKg,
  latestShipmentCountdown,
  lcToleranceCheck,
  packingMismatches,
  remainingToPack,
  ShipmentError,
  type CellMap,
  type CountdownResult,
  type PackingMismatchReport,
  type ToleranceResult,
} from './shipment'
import {
  cartons,
  finishingOutputs,
  packingLists,
  shipmentDocs,
  shipments,
} from './schema'
import {
  cartonPayload,
  finishingOutputPayload,
  shipmentDocPayload,
  shipmentPayload,
  type ToleranceOverridePayload,
} from './zod'

/** ⚖ — a shipment and its packing list are what the bank is presented with. */
registerAuditedTables('shipments', 'packing_lists')

/**
 * planned → ex_factory → at_port → on_board → delivered.
 *
 * Strictly forward. Goods do not return to the factory from a vessel, and a status that
 * can go backwards is a status somebody will use to "fix" a mis-scan, destroying the only
 * record of when the container actually moved.
 */
export const portStatusMachine = defineStateMachine({
  field: 'portStatus',
  initial: 'planned',
  transitions: {
    planned: ['ex_factory'],
    ex_factory: ['at_port'],
    at_port: ['on_board'],
    on_board: ['delivered'],
    delivered: [],
  },
})

export const packingListMachine = defineStateMachine({
  field: 'status',
  initial: 'draft',
  transitions: {
    draft: ['approved', 'superseded'],
    approved: ['superseded'],
    superseded: [],
  },
})

export type PortStatus = (typeof portStatusMachine.states)[number]
export type PackingListStatus = (typeof packingListMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface ShipmentPolicy {
  /** Days a bank needs between shipment and document presentation. */
  presentationDays?: number
}

function wrapShipmentError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof ShipmentError) {
      throw new AppError('validation_failed', 'shipment.errors.invalid', {
        reason: error.message,
        // The per-cell detail the brief asks for, carried to the UI rather than flattened
        // into a message a packer cannot act on.
        cells: error.cells,
      })
    }
    throw error
  }
}

const sumCells = (cells: CellMap): number => Object.values(cells).reduce((a, b) => a + b, 0)

/**
 * Total pieces across a set of cartons. A named helper rather than an inline reduce at
 * three call sites: pieces are whole integers, but the `no-float-money` rule reads variable
 * NAMES and `sum + c.totalQty` looks exactly like the money arithmetic it exists to stop.
 */
const sumPieces = (rows: readonly { totalQty: number }[]): number =>
  // Destructured to `pieces` so the one place this addition happens says what it adds.
  rows.reduce((count, { totalQty: pieces }) => count + pieces, 0)

// ─────────────────────────────────────────────────────────────────────────────
// Finishing
// ─────────────────────────────────────────────────────────────────────────────

/** Record what came off finishing. Floor-facing, so offline-queued (rule 7). */
export async function recordFinishingOutput(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ finishingOutputId: string; totalQty: number }> {
  const payload = finishingOutputPayload.parse(input)
  return withTenantTx(ctx, async (tx) => recordFinishingOutputIn(ctx, tx, payload))
}

async function recordFinishingOutputIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof finishingOutputPayload.parse>,
): Promise<{ finishingOutputId: string; totalQty: number }> {
  // Postgres runs foreign-key checks with RLS bypassed, so verify the order is ours before
  // referencing it (rule 2 — the app layer is the first wall).
  await assertOwnOrder(ctx, tx, payload.orderId)

  const totalQty = sumCells(payload.cells)

  const [row] = await tx
    .insert(finishingOutputs)
    .values({
      companyId: ctx.companyId,
      orderId: payload.orderId,
      orderStyleId: payload.orderStyleId ?? null,
      outputDate: payload.outputDate,
      cells: payload.cells,
      totalQty,
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: finishingOutputs.id })

  if (!row) throw new Error('finishing_outputs insert returned nothing')

  await emit(ctx, tx, {
    eventName: SHIPMENT_EVENTS.finishingRecorded,
    payload: {
      finishingOutputId: row.id,
      orderId: payload.orderId,
      outputDate: payload.outputDate,
      totalQty,
    },
    aggregateTable: 'finishing_outputs',
    aggregateId: row.id,
  })

  /*
   * The Walk app's buzz (mobile contract §3): the FIRST pieces off finishing are what turn
   * an order from "nothing to sample" into a lot an inspector can draw from — the exact
   * boundary the final-inspection queue now sizes by. Once per order, by dedupe key: the
   * second day's output is not news, the first carton's worth is.
   */
  const { orders: ordersTable } = await import('@/modules/orders/schema')
  const [order] = await tx
    .select({ poNumbers: ordersTable.poNumbers })
    .from(ordersTable)
    .where(scoped(ordersTable, ctx, eq(ordersTable.id, payload.orderId)))
  await notify(ctx, {
    role: 'quality',
    kind: 'quality.lot.inspectable',
    titleKey: 'quality.notifications.lot_inspectable.title',
    params: { poNumber: order?.poNumbers?.[0] ?? '', pieces: totalQty },
    moduleId: 'quality',
    entityTable: 'finishing_outputs',
    entityId: payload.orderId,
    href: '/quality/final',
    dedupeKey: `lot-inspectable:${payload.orderId}`,
    channels: ['in_app', 'push'],
  })

  return { finishingOutputId: row.id, totalQty }
}

async function assertOwnOrder(ctx: AnyCtx, tx: TenantDb, orderId: string): Promise<void> {
  const { orders } = await import('@/modules/orders/schema')
  const [order] = await tx.select({ id: orders.id }).from(orders).where(scoped(orders, ctx, eq(orders.id, orderId)))
  if (!order) throw notFound('shipment.errors.order_not_found', { orderId })
}

/** Everything finishing has produced for an order, as one grid. */
async function finishedCells(ctx: AnyCtx, tx: TenantDb, orderId: string): Promise<CellMap> {
  const rows = await tx
    .select({ cells: finishingOutputs.cells })
    .from(finishingOutputs)
    .where(scoped(finishingOutputs, ctx, eq(finishingOutputs.orderId, orderId)))

  const total: CellMap = {}
  for (const row of rows) {
    for (const [cell, qty] of Object.entries(row.cells)) {
      total[cell] = (total[cell] ?? 0) + qty
    }
  }
  return total
}

/** Everything already in cartons for an order, as one grid. */
async function packedCells(
  ctx: AnyCtx,
  tx: TenantDb,
  orderId: string,
  options: { excludeCartonId?: string } = {},
): Promise<CellMap> {
  const rows = await tx
    .select({ id: cartons.id, contents: cartons.contents })
    .from(cartons)
    .where(scoped(cartons, ctx, eq(cartons.orderId, orderId)))

  const total: CellMap = {}
  for (const row of rows) {
    if (row.id === options.excludeCartonId) continue
    for (const [cell, qty] of Object.entries(row.contents)) {
      total[cell] = (total[cell] ?? 0) + qty
    }
  }
  return total
}

/** What is still available to pack. The packer's worklist. */
export async function remainingToPackFor(
  ctx: AnyCtx,
  input: { orderId: string },
): Promise<{ remaining: CellMap; finished: CellMap; packed: CellMap; ordered: CellMap }> {
  return withTenantRead(ctx, async (tx) => {
    const [finished, packed, ordered] = await Promise.all([
      finishedCells(ctx, tx, input.orderId),
      packedCells(ctx, tx, input.orderId),
      // The buyer's grid, so the worklist has cells BEFORE the first finished piece is
      // reported. Built only from finished ∪ packed, the screen was a chicken-and-egg:
      // "report finished pieces first" with the report button living inside a cell that
      // could not exist yet (live-test finding, Phase 7). An order with no breakdown
      // yet is an empty grid, not an error — the packer cannot fix a missing revision.
      orderedCells(ctx, tx, input.orderId).catch(() => ({}) as CellMap),
    ])

    // `allowOverPack` so the report shows an existing over-pack rather than refusing to
    // render at all — a packer needs to see the problem to fix it.
    return {
      remaining: wrapShipmentError(() => remainingToPack(finished, packed, { allowOverPack: true })),
      finished,
      packed,
      ordered,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Cartons
// ─────────────────────────────────────────────────────────────────────────────

export interface PackCartonResult {
  cartonId: string
  totalQty: number
  cbm: string | null
  remainingAfter: CellMap
}

/**
 * Build a carton (brief: "Carton build validates against remaining-to-pack; over-pack
 * rejected with cell detail").
 *
 * The check counts every OTHER carton on the order, so packing is validated against the
 * real remaining balance rather than against finishing alone.
 */
export async function packCarton(ctx: RequestCtx, input: unknown): Promise<PackCartonResult> {
  const payload = cartonPayload.parse(input)
  return withTenantTx(ctx, async (tx) => packCartonIn(ctx, tx, payload))
}

/**
 * Commit a carton drafted through the approve inbox.
 *
 * Not the floor path — that is `offlinePackCarton`, and it stays that way: a packer at the
 * bench should never wait for an office. This is the back-entry one, for a carton packed
 * while the tablet was down and reconstructed from the paper list afterwards.
 *
 * It could not commit. Core's generic write refused `orderId`, `cartonNo`, `grossKg`,
 * `lengthCm` and `offlineKey` as invalid column identifiers — and, worse, it would have
 * skipped the over-pack check entirely. A drafted carton is exactly the one nobody watched
 * being packed, so writing it without validating against remaining-to-pack is how an order
 * ships more pieces than finishing ever produced. `cbm` and `totalQty` are computed here
 * too; a raw insert would have left both null and quietly understated the freight.
 */
export async function commitCartonDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    // A carton is opened and repacked on the floor, not edited in a queue: the packing
    // list and the shipped quantity are both derived from these rows.
    throw new AppError('validation_failed', 'shipment.errors.carton_draft_insert_only', {
      operation: input.operation,
    })
  }

  const result = await packCartonIn(ctx, tx, cartonPayload.parse(input.payload))
  return {
    rowId: result.cartonId,
    before: null,
    after: { cartonId: result.cartonId, totalQty: result.totalQty, cbm: result.cbm },
  }
}

async function packCartonIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof cartonPayload.parse>,
): Promise<PackCartonResult> {
  await assertOwnOrder(ctx, tx, payload.orderId)

  const finished = await finishedCells(ctx, tx, payload.orderId)
  const alreadyPacked = await packedCells(ctx, tx, payload.orderId)

  // This carton on top of everything already packed. Throws with per-cell detail if the
  // result would exceed what finishing produced.
  const proposed: CellMap = { ...alreadyPacked }
  for (const [cell, qty] of Object.entries(payload.contents)) {
    proposed[cell] = (proposed[cell] ?? 0) + qty
  }

  const remainingAfter = wrapShipmentError(() => remainingToPack(finished, proposed))

  const cbm =
    payload.lengthCm && payload.widthCm && payload.heightCm
      ? wrapShipmentError(() =>
          cartonCbm({
            lengthCm: payload.lengthCm!,
            widthCm: payload.widthCm!,
            heightCm: payload.heightCm!,
          }),
        )
      : null

  const totalQty = sumCells(payload.contents)

  const [row] = await tx
    .insert(cartons)
    .values({
      companyId: ctx.companyId,
      orderId: payload.orderId,
      cartonNo: payload.cartonNo,
      contents: payload.contents,
      totalQty,
      grossKg: payload.grossKg ?? null,
      netKg: payload.netKg ?? null,
      lengthCm: payload.lengthCm ?? null,
      widthCm: payload.widthCm ?? null,
      heightCm: payload.heightCm ?? null,
      cbm,
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: cartons.id })

  if (!row) throw new Error('cartons insert returned nothing')

  await emit(ctx, tx, {
    eventName: SHIPMENT_EVENTS.cartonPacked,
    payload: {
      cartonId: row.id,
      orderId: payload.orderId,
      cartonNo: payload.cartonNo,
      totalQty,
      cbm,
    },
    aggregateTable: 'cartons',
    aggregateId: row.id,
  })

  return { cartonId: row.id, totalQty, cbm, remainingAfter }
}

/** Freight units for a set of cartons — the greater of actual and volumetric. */
export async function freightSummary(
  ctx: AnyCtx,
  input: { orderId: string; mode: 'sea' | 'air' },
): Promise<{ cartons: number; totalCbm: string; totalGrossKg: string; chargeable: ReturnType<typeof chargeableWeightKg> }> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ cbm: cartons.cbm, grossKg: cartons.grossKg })
      .from(cartons)
      .where(scoped(cartons, ctx, eq(cartons.orderId, input.orderId)))

    if (rows.length === 0) {
      throw notFound('shipment.errors.no_cartons', { orderId: input.orderId })
    }

    let cbmMinor = 0n
    let grossMinor = 0n
    for (const row of rows) {
      cbmMinor += toMinorScaled(row.cbm ?? '0', 6)
      grossMinor += toMinorScaled(row.grossKg ?? '0', 2)
    }

    const totalCbm = fromMinorScaled(cbmMinor, 6)
    const totalGrossKg = fromMinorScaled(grossMinor, 2)

    return {
      cartons: rows.length,
      totalCbm,
      totalGrossKg,
      chargeable: wrapShipmentError(() =>
        chargeableWeightKg({ mode: input.mode, grossKg: totalGrossKg, cbm: totalCbm }),
      ),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Packing lists
// ─────────────────────────────────────────────────────────────────────────────

/** The buyer's ordered grid, from the active breakdown revision (orders owns it). */
/*
 * The four helpers above and below all took a `ctx` rather than an exemption (plan 1.3).
 *
 * They are the arithmetic behind the packing gate: ordered vs finished vs packed, cell by
 * cell. A count read from another factory's order would let a shipment close short — or
 * refuse one that was complete — and nothing downstream re-checks it, because these cells
 * ARE the check.
 */
async function orderedCells(ctx: AnyCtx, tx: TenantDb, orderId: string): Promise<CellMap> {
  const { orderBreakdowns, orderStyles } = await import('@/modules/orders/schema')

  const styles = await tx
    .select({ id: orderStyles.id, activeRevision: orderStyles.activeRevision })
    .from(orderStyles)
    .where(scoped(orderStyles, ctx, eq(orderStyles.orderId, orderId)))

  if (styles.length === 0) {
    throw notFound('shipment.errors.no_order_styles', { orderId })
  }

  const total: CellMap = {}
  for (const style of styles) {
    const rows = await tx
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

    for (const row of rows) {
      const cell = `${row.color}|${row.size}`
      total[cell] = (total[cell] ?? 0) + row.qty
    }
  }

  return total
}

export interface PackingListResult {
  packingListId: string
  version: number
  report: PackingMismatchReport
  totalCartons: number
}

/**
 * Generate a packing list.
 *
 * The mismatch report is computed HERE and stored on the row: the order's breakdown can be
 * revised after a list is generated, and a list whose mismatches recompute against a newer
 * grid would silently disagree with the one the buyer holds.
 */
export async function generatePackingList(
  ctx: RequestCtx,
  input: { orderId: string; shipmentId?: string },
): Promise<PackingListResult> {
  return withTenantTx(ctx, async (tx) => {
    await assertOwnOrder(ctx, tx, input.orderId)

    const cartonRows = await tx
      .select()
      .from(cartons)
      .where(scoped(cartons, ctx, eq(cartons.orderId, input.orderId)))
      .orderBy(asc(cartons.cartonNo))

    if (cartonRows.length === 0) {
      throw notFound('shipment.errors.no_cartons', { orderId: input.orderId })
    }

    const [ordered, packed] = await Promise.all([
      orderedCells(ctx, tx, input.orderId),
      packedCells(ctx, tx, input.orderId),
    ])

    const report = wrapShipmentError(() => packingMismatches(ordered, packed))

    const [latest] = await tx
      .select({ version: packingLists.version })
      .from(packingLists)
      .where(scoped(packingLists, ctx, eq(packingLists.orderId, input.orderId)))
      .orderBy(desc(packingLists.version))
      .limit(1)

    const version = (latest?.version ?? 0) + 1

    const [row] = await tx
      .insert(packingLists)
      .values({
        companyId: ctx.companyId,
        orderId: input.orderId,
        shipmentId: input.shipmentId ?? null,
        version,
        generated: {
          cartons: cartonRows.map((c) => ({
            cartonNo: c.cartonNo,
            contents: c.contents,
            totalQty: c.totalQty,
            grossKg: c.grossKg,
            netKg: c.netKg,
            cbm: c.cbm,
          })),
          ordered,
          packed,
        },
        mismatches: report.mismatches,
        totalCartons: cartonRows.length,
        totalQty: report.totalPacked,
        createdBy: ctx.userId,
      })
      .returning({ id: packingLists.id })

    if (!row) throw new Error('packing_lists insert returned nothing')

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.packingListGenerated,
      payload: {
        packingListId: row.id,
        orderId: input.orderId,
        version,
        totalCartons: cartonRows.length,
        totalQty: report.totalPacked,
      },
      aggregateTable: 'packing_lists',
      aggregateId: row.id,
    })

    if (!report.matches) {
      // Merchandising needs to know before the buyer does.
      await emit(ctx, tx, {
        eventName: SHIPMENT_EVENTS.packingMismatch,
        payload: {
          packingListId: row.id,
          orderId: input.orderId,
          version,
          mismatches: report.mismatches,
        },
        aggregateTable: 'packing_lists',
        aggregateId: row.id,
      })
    }

    return { packingListId: row.id, version, report, totalCartons: cartonRows.length }
  })
}

/**
 * Approve a packing list, which LOCKS it ⚖.
 *
 * The mismatch report is re-derived from the stored `generated` snapshot and compared to
 * what was stored. If they disagree the list has been tampered with, and approving it
 * would bless a document nobody can reproduce — the same re-validation a cost sheet gets.
 */
export async function approvePackingList(
  ctx: RequestCtx,
  input: { packingListId: string; acceptMismatches?: boolean },
): Promise<{ packingListId: string; version: number; supersededCount: number }> {
  return withTenantTx(ctx, async (tx) => {
    const [list] = await tx
      .select()
      .from(packingLists)
      .where(scoped(packingLists, ctx, eq(packingLists.id, input.packingListId)))
      .for('update')

    if (!list) {
      throw notFound('shipment.errors.packing_list_not_found', {
        packingListId: input.packingListId,
      })
    }

    packingListMachine.assert(list.status as PackingListStatus, 'approved')

    const snapshot = list.generated as { ordered?: CellMap; packed?: CellMap }
    if (snapshot.ordered && snapshot.packed) {
      const recomputed = wrapShipmentError(() =>
        packingMismatches(snapshot.ordered!, snapshot.packed!),
      )
      if (recomputed.mismatches.length !== list.mismatches.length) {
        throw new AppError('conflict', 'shipment.errors.packing_list_stale', {
          storedMismatches: list.mismatches.length,
          recomputedMismatches: recomputed.mismatches.length,
        })
      }
    }

    if (list.mismatches.length > 0 && !input.acceptMismatches) {
      // A list that does not match the buyer's grid can be approved, but only knowingly.
      throw new AppError('validation_failed', 'shipment.errors.packing_list_has_mismatches', {
        packingListId: list.id,
        mismatches: list.mismatches,
      })
    }

    // Supersede the list currently in force for this order — on APPROVAL, so an abandoned
    // draft never invalidates the list the buyer is holding.
    const superseded = await tx
      .update(packingLists)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(scoped(packingLists, ctx, and(eq(packingLists.orderId, list.orderId), eq(packingLists.status, 'approved'))))
      .returning({ id: packingLists.id })

    await tx
      .update(packingLists)
      .set({
        status: 'approved',
        approvedBy: ctx.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(scoped(packingLists, ctx, eq(packingLists.id, list.id)))

    await recordChange(ctx, tx, {
      action: 'approve',
      targetTable: 'packing_lists',
      targetId: list.id,
      before: { status: list.status },
      after: {
        status: 'approved',
        approvedBy: ctx.userId,
        mismatchesAccepted: list.mismatches.length,
        supersededCount: superseded.length,
      },
    })

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.packingListApproved,
      payload: {
        packingListId: list.id,
        orderId: list.orderId,
        version: list.version,
        mismatchesAccepted: list.mismatches.length,
      },
      aggregateTable: 'packing_lists',
      aggregateId: list.id,
    })

    return {
      packingListId: list.id,
      version: list.version,
      supersededCount: superseded.length,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Shipments
// ─────────────────────────────────────────────────────────────────────────────

export async function createShipment(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ shipmentId: string }> {
  const payload = shipmentPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    await assertOwnOrder(ctx, tx, payload.orderId)

    if (payload.lcId) {
      // Same reason as the order check: an FK does not enforce tenancy.
      const { lcs } = await import('@/modules/commercial/schema')
      const [lc] = await tx.select({ id: lcs.id }).from(lcs).where(scoped(lcs, ctx, eq(lcs.id, payload.lcId)))
      if (!lc) throw notFound('shipment.errors.lc_not_found', { lcId: payload.lcId })
    }

    const [row] = await tx
      .insert(shipments)
      .values({
        companyId: ctx.companyId,
        orderId: payload.orderId,
        lcId: payload.lcId ?? null,
        partialNo: payload.partialNo,
        plannedExFactory: payload.plannedExFactory,
        forwarder: payload.forwarder ?? null,
        bookingRef: payload.bookingRef ?? null,
        mode: payload.mode,
        createdBy: ctx.userId,
      })
      .returning({ id: shipments.id })

    if (!row) throw new Error('shipments insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'shipments',
      targetId: row.id,
      after: {
        orderId: payload.orderId,
        partialNo: payload.partialNo,
        plannedExFactory: payload.plannedExFactory,
        lcId: payload.lcId ?? null,
      },
    })

    return { shipmentId: row.id }
  })
}

/** Assign packed cartons to a shipment. A carton already on another shipment is refused. */
export async function loadCartons(
  ctx: RequestCtx,
  input: { shipmentId: string; cartonIds: readonly string[] },
): Promise<{ loaded: number }> {
  return withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }
    if (shipment.portStatus !== 'planned') {
      // Once goods are ex-factory the manifest is what left. Adding a carton after the
      // fact would change a document already presented.
      throw conflict('shipment.errors.shipment_already_departed', {
        shipmentId: shipment.id,
        portStatus: shipment.portStatus,
      })
    }

    const rows = await tx
      .select({ id: cartons.id, shipmentId: cartons.shipmentId, orderId: cartons.orderId })
      .from(cartons)
      .where(scoped(cartons, ctx, inArray(cartons.id, [...input.cartonIds])))

    if (rows.length !== input.cartonIds.length) {
      throw notFound('shipment.errors.carton_not_found', {
        requested: input.cartonIds.length,
        found: rows.length,
      })
    }

    const alreadyLoaded = rows.filter((r) => r.shipmentId !== null && r.shipmentId !== shipment.id)
    if (alreadyLoaded.length > 0) {
      throw conflict('shipment.errors.carton_already_loaded', {
        cartonIds: alreadyLoaded.map((r) => r.id),
      })
    }

    const wrongOrder = rows.filter((r) => r.orderId !== shipment.orderId)
    if (wrongOrder.length > 0) {
      throw conflict('shipment.errors.carton_wrong_order', {
        cartonIds: wrongOrder.map((r) => r.id),
      })
    }

    await tx
      .update(cartons)
      .set({ shipmentId: shipment.id, updatedAt: new Date() })
      .where(scoped(cartons, ctx, inArray(cartons.id, [...input.cartonIds])))

    return { loaded: rows.length }
  })
}

export interface ExFactoryResult {
  shipmentId: string
  shippedQty: number
  tolerance: ToleranceResult | null
  lcConflicts: unknown[]
}

/**
 * Confirm ex-factory ⚖ (brief: "→ TNA final milestone actualize + Finance invoice draft").
 *
 * Three things are checked as the goods leave, and none of them blocks the record: the
 * container is on a truck, and refusing to record reality does not put it back. What they
 * do is raise the discrepancies while somebody can still act on them —
 *
 *  - the LC tolerance band, which needs a manager's acceptance if breached;
 *  - the LC latest-shipment date, via 2.1's own conflict detector;
 *  - whether a packing list has been approved at all.
 */
export async function confirmExFactory(
  ctx: RequestCtx,
  input: { shipmentId: string; actualExFactory: string },
  policy: ShipmentPolicy = {},
): Promise<ExFactoryResult> {
  return withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
      .for('update')

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }

    portStatusMachine.assert(shipment.portStatus as PortStatus, 'ex_factory')

    const loaded = await tx
      .select({ totalQty: cartons.totalQty })
      .from(cartons)
      .where(scoped(cartons, ctx, eq(cartons.shipmentId, shipment.id)))

    if (loaded.length === 0) {
      throw new AppError('validation_failed', 'shipment.errors.no_cartons_loaded', {
        shipmentId: shipment.id,
      })
    }

    const shippedQty = sumPieces(loaded)

    // ── The final-inspection gate ──
    //
    // Unlike the LC checks below, this one BLOCKS. The goods have not left yet — that is
    // exactly what this call is recording — so refusing is still actionable, and shipping a
    // lot the factory's own inspection failed is the one thing final inspection exists to
    // prevent. A waiver on the shipment clears it, because a buyer does sometimes accept a
    // failed lot at a discount; nothing else does.
    if (!shipment.qcWaiver) {
      const { resolveFinalInspectionGate } = await import('../quality/service')
      const qc = await resolveFinalInspectionGate(ctx, tx, { orderId: shipment.orderId })

      if (!qc.passed) {
        // Recorded in its own transaction, for the same reason the EXP refusal is: emitting
        // inside this one would roll the trail back with the throw.
        await withTenantTx(ctx, async (trail) => {
          await emit(ctx, trail, {
            eventName: SHIPMENT_EVENTS.finalInspectionBlocked,
            payload: {
              shipmentId: shipment.id,
              orderId: shipment.orderId,
              reasonKey: qc.reasonKey ?? 'gates.final_inspection.blocked',
              attemptedBy: ctx.userId,
              ...qc.facts,
            },
            aggregateTable: 'shipments',
            aggregateId: shipment.id,
          })
        })

        assertGate(GATES.finalInspection, qc)
      }
    }

    // ── The LC checks ──
    let tolerance: ToleranceResult | null = null
    let lcConflicts: unknown[] = []

    if (shipment.lcId) {
      const { lcs } = await import('@/modules/commercial/schema')
      const [lc] = await tx.select().from(lcs).where(scoped(lcs, ctx, eq(lcs.id, shipment.lcId)))

      if (lc) {
        const ordered = await orderedCells(ctx, tx, shipment.orderId)
        const lcQty = Object.values(ordered).reduce((a, b) => a + b, 0)

        if (lcQty > 0) {
          tolerance = wrapShipmentError(() =>
            lcToleranceCheck({ lcQty, shippedQty, tolerancePct: lc.tolerancePct }),
          )
        }

        const { detectLcConflicts } = await import('../commercial/lc-conflicts')
        const { orders } = await import('@/modules/orders/schema')
        const [order] = await tx
          .select({ id: orders.id, poNumbers: orders.poNumbers, status: orders.status })
          .from(orders)
          .where(scoped(orders, ctx, eq(orders.id, shipment.orderId)))

        if (order) {
          lcConflicts = detectLcConflicts({
            lc: {
              id: lc.id,
              number: lc.number,
              latestShipmentDate: lc.latestShipmentDate,
              expiryDate: lc.expiryDate,
              status: lc.status,
            },
            orders: [
              {
                id: order.id,
                poNumbers: order.poNumbers,
                // The ACTUAL date, not the planned one — this is the check that matters,
                // and checking the plan would clear a shipment that actually left late.
                plannedExFactoryDate: input.actualExFactory,
                status: order.status,
              },
            ],
            presentationDays: policy.presentationDays,
          })
        }
      }
    }

    /*
     * ── The LC date gate (CLAUDE.md rule 8, audit BE-H2) ──
     *
     * `GATES.lcLatestShipment` was declared and never referenced: the conflict was
     * computed, counted into the audit blob, returned to the caller — and blocked nothing.
     * A container could leave against a credit that was already dead, and the first
     * objection came from the bank refusing the presentation weeks later, when the goods
     * were overseas and the remedy was a discount.
     *
     * This function RECORDS a departure, and the codebase argued with itself about what
     * that means: the final-inspection gate above blocks because "the goods have not left
     * yet", while the test for these same LC checks said "the container is on a truck, and
     * refusing does not put it back". Both are right about different moments, and a gate
     * that makes reality unrecordable is the worse failure — an ERP that refuses to admit
     * a shipment left is lying about the floor.
     *
     * The waiver is what resolves it. Blocked by default, so the decision to ship against
     * a dead credit is made deliberately by somebody who may make it; waivable BEFORE the
     * departure is recorded, so reality is never unrecordable — it just costs a signature.
     *
     * Scope is the two conflicts about the DATE ITSELF: `latest_shipment` and `expiry`.
     * Both mean the credit as it stands cannot accept this shipment. `presentation_window`
     * is deliberately excluded — there the shipping date is fine and the risk is document
     * turnaround, which is a reason to hurry, not to hold the truck.
     */
    const blockingConflicts = lcConflicts.filter(
      (conflict): conflict is { kind: string; facts?: Record<string, unknown> } =>
        typeof conflict === 'object' &&
        conflict !== null &&
        'kind' in conflict &&
        (conflict.kind === 'latest_shipment' || conflict.kind === 'expiry'),
    )

    if (blockingConflicts.length > 0 && !shipment.lcWaiver) {
      const blocked = blockingConflicts[0]!
      const reasonKey =
        blocked.kind === 'expiry' ? 'gates.lc_date.expired' : 'gates.lc_date.after_latest_shipment'
      const facts = { shipmentId: shipment.id, lcId: shipment.lcId, ...(blocked.facts ?? {}) }

      // Its own transaction, for the same reason the EXP and QC refusals use one: emitting
      // inside this one would roll the trail back with the throw that follows.
      await withTenantTx(ctx, async (trail) => {
        await emit(ctx, trail, {
          eventName: SHIPMENT_EVENTS.lcDateBlocked,
          payload: { ...facts, kind: blocked.kind, reasonKey, attemptedBy: ctx.userId },
          aggregateTable: 'shipments',
          aggregateId: shipment.id,
        })
      })

      assertGate(GATES.lcLatestShipment, { passed: false, reasonKey, facts })
    }

    await tx
      .update(shipments)
      .set({
        actualExFactory: input.actualExFactory,
        portStatus: 'ex_factory',
        updatedAt: new Date(),
      })
      .where(scoped(shipments, ctx, eq(shipments.id, shipment.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'shipments',
      targetId: shipment.id,
      before: { portStatus: shipment.portStatus, actualExFactory: shipment.actualExFactory },
      after: {
        portStatus: 'ex_factory',
        actualExFactory: input.actualExFactory,
        shippedQty,
        toleranceBreached: tolerance ? !tolerance.withinTolerance : null,
        lcConflictCount: lcConflicts.length,
      },
    })

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.exFactoryConfirmed,
      payload: {
        shipmentId: shipment.id,
        orderId: shipment.orderId,
        actualExFactory: input.actualExFactory,
        shippedQty,
        cartons: loaded.length,
        // 1.3 actualises the final milestone off this; 11.1 drafts the invoice.
        lcId: shipment.lcId,
      },
      aggregateTable: 'shipments',
      aggregateId: shipment.id,
    })

    if (tolerance && !tolerance.withinTolerance) {
      await emit(ctx, tx, {
        eventName: SHIPMENT_EVENTS.toleranceBreach,
        payload: {
          shipmentId: shipment.id,
          orderId: shipment.orderId,
          direction: tolerance.direction,
          shippedQty,
          minQty: tolerance.minQty,
          maxQty: tolerance.maxQty,
          varianceQty: tolerance.varianceQty,
          tolerancePct: tolerance.tolerancePct,
        },
        aggregateTable: 'shipments',
        aggregateId: shipment.id,
      })
    }

    return { shipmentId: shipment.id, shippedQty, tolerance, lcConflicts }
  })
}

export async function advancePortStatus(
  ctx: RequestCtx,
  input: { shipmentId: string; portStatus: PortStatus; blAwb?: string },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
      .for('update')

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }

    portStatusMachine.assert(shipment.portStatus as PortStatus, input.portStatus)

    await tx
      .update(shipments)
      .set({
        portStatus: input.portStatus,
        blAwb: input.blAwb ?? shipment.blAwb,
        updatedAt: new Date(),
      })
      .where(scoped(shipments, ctx, eq(shipments.id, shipment.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'shipments',
      targetId: shipment.id,
      before: { portStatus: shipment.portStatus },
      after: { portStatus: input.portStatus, blAwb: input.blAwb ?? shipment.blAwb },
    })

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.portStatusChanged,
      payload: {
        shipmentId: shipment.id,
        orderId: shipment.orderId,
        from: shipment.portStatus,
        to: input.portStatus,
      },
      aggregateTable: 'shipments',
      aggregateId: shipment.id,
    })
  })
}

/** Record the EXP number the bank issued for this shipment. */
export async function setExpNumber(
  ctx: RequestCtx,
  input: { shipmentId: string; expNumber: string },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
      .for('update')

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }
    if (shipment.expNumber && shipment.expNumber !== input.expNumber) {
      // An EXP number is issued once per shipment by the bank. Overwriting one is either a
      // typo correction that needs a trail or a different shipment's number.
      throw conflict('shipment.errors.exp_already_set', {
        shipmentId: shipment.id,
        existing: shipment.expNumber,
      })
    }

    await tx
      .update(shipments)
      .set({ expNumber: input.expNumber, updatedAt: new Date() })
      .where(scoped(shipments, ctx, eq(shipments.id, shipment.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'shipments',
      targetId: shipment.id,
      before: { expNumber: shipment.expNumber },
      after: { expNumber: input.expNumber },
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents, and the EXP gate
// ─────────────────────────────────────────────────────────────────────────────

/** Build the checklist for a shipment from its LC's `docs_required`. */
export async function buildDocChecklist(
  ctx: RequestCtx,
  input: { shipmentId: string; fallbackKinds?: readonly string[] },
): Promise<{ kinds: string[] }> {
  return withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }

    let kinds: string[] = [...(input.fallbackKinds ?? [])]

    if (shipment.lcId) {
      const { lcs } = await import('@/modules/commercial/schema')
      const [lc] = await tx.select({ docsRequired: lcs.docsRequired }).from(lcs).where(scoped(lcs, ctx, eq(lcs.id, shipment.lcId)))
      const required = lc?.docsRequired as Record<string, unknown> | undefined
      if (required && Object.keys(required).length > 0) kinds = Object.keys(required)
    }

    if (kinds.length === 0) {
      // An empty checklist would let the EXP gate be the only thing standing between a
      // shipment and the bank.
      throw new AppError('validation_failed', 'shipment.errors.no_doc_kinds', {
        shipmentId: shipment.id,
      })
    }

    for (const kind of kinds) {
      await tx
        .insert(shipmentDocs)
        .values({ companyId: ctx.companyId, shipmentId: shipment.id, kind })
        .onConflictDoNothing({ target: [shipmentDocs.shipmentId, shipmentDocs.kind] })
    }

    return { kinds }
  })
}

export async function setDocStatus(ctx: RequestCtx, input: unknown): Promise<void> {
  const payload = shipmentDocPayload.parse(input)

  await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(shipmentDocs)
      .where(scoped(shipmentDocs, ctx, 
        and(eq(shipmentDocs.shipmentId, payload.shipmentId), eq(shipmentDocs.kind, payload.kind)),
      ))
      .for('update')

    if (!row) {
      throw notFound('shipment.errors.doc_not_on_checklist', {
        shipmentId: payload.shipmentId,
        kind: payload.kind,
      })
    }

    if (payload.status !== 'pending' && !payload.documentId && !row.documentId) {
      // The check constraint enforces this too; failing here gives the UI a typed error
      // instead of a driver message.
      throw new AppError('validation_failed', 'shipment.errors.doc_needs_file', {
        kind: payload.kind,
      })
    }

    await tx
      .update(shipmentDocs)
      .set({
        status: payload.status,
        documentId: payload.documentId ?? row.documentId,
        submittedAt: payload.status === 'submitted' ? new Date() : row.submittedAt,
        updatedAt: new Date(),
      })
      .where(scoped(shipmentDocs, ctx, eq(shipmentDocs.id, row.id)))
  })
}

export interface BankHandoffResult {
  shipmentId: string
  expNumber: string
  submitted: string[]
}

/**
 * Hand the document set to the bank (brief gate: "blocked until `exp_number` present —
 * server-enforced").
 *
 * The EXP number is mandatory per export shipment under Bangladesh Bank rules. Without it
 * the presentation is not merely incomplete — it cannot legally be made, which is why this
 * is a hard block and not a warning. The refusal is emitted, because a trail of somebody
 * trying to submit without one is worth having.
 */
export async function handoffDocsToBank(
  ctx: RequestCtx,
  input: { shipmentId: string },
): Promise<BankHandoffResult> {
  // The refusal is recorded in its OWN transaction, before the throw. Emitting it inside
  // the transaction that then throws would roll the event back with everything else — the
  // trail would silently not exist, which is the failure this shape exists to avoid.
  const preflight = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: shipments.id, orderId: shipments.orderId, expNumber: shipments.expNumber })
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
    return row
  })

  if (!preflight) {
    throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
  }

  if (!preflight.expNumber) {
    await withTenantTx(ctx, async (tx) => {
      await emit(ctx, tx, {
        eventName: SHIPMENT_EVENTS.expMissing,
        payload: {
          shipmentId: preflight.id,
          orderId: preflight.orderId,
          attemptedBy: ctx.userId,
        },
        aggregateTable: 'shipments',
        aggregateId: preflight.id,
      })
    })

    throw new AppError('gate_blocked', 'gates.exp_number.missing', {
      gate: GATES.expNumber,
      shipmentId: preflight.id,
      orderId: preflight.orderId,
    })
  }

  return withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
      .for('update')

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }

    // Re-checked under the lock. The preflight above decides whether to leave a trail; THIS
    // is the check that decides whether the handoff happens, so a number cleared between
    // the two cannot slip through.
    if (!shipment.expNumber) {
      throw new AppError('gate_blocked', 'gates.exp_number.missing', {
        gate: GATES.expNumber,
        shipmentId: shipment.id,
        orderId: shipment.orderId,
      })
    }

    const docs = await tx
      .select()
      .from(shipmentDocs)
      .where(scoped(shipmentDocs, ctx, eq(shipmentDocs.shipmentId, shipment.id)))

    if (docs.length === 0) {
      throw notFound('shipment.errors.no_checklist', { shipmentId: shipment.id })
    }

    const notReady = docs.filter((d) => d.status === 'pending')
    if (notReady.length > 0) {
      throw new AppError('validation_failed', 'shipment.errors.docs_not_ready', {
        shipmentId: shipment.id,
        pending: notReady.map((d) => d.kind),
      })
    }

    await tx
      .update(shipmentDocs)
      .set({ status: 'submitted', submittedAt: new Date(), updatedAt: new Date() })
      .where(scoped(shipmentDocs, ctx, and(eq(shipmentDocs.shipmentId, shipment.id), eq(shipmentDocs.status, 'ready'))))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'shipments',
      targetId: shipment.id,
      after: {
        docsSubmitted: docs.map((d) => d.kind),
        expNumber: shipment.expNumber,
      },
    })

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.docsReadyForBank,
      payload: {
        shipmentId: shipment.id,
        orderId: shipment.orderId,
        expNumber: shipment.expNumber,
        kinds: docs.map((d) => d.kind),
      },
      aggregateTable: 'shipments',
      aggregateId: shipment.id,
    })

    return {
      shipmentId: shipment.id,
      expNumber: shipment.expNumber,
      submitted: docs.map((d) => d.kind),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The tolerance override — through pending_changes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Propose accepting an LC quantity discrepancy (brief: "structured warning requiring
 * manager pending_change").
 *
 * The numbers travel on the draft so an approver sees exactly what they are signing. A
 * bank refusing a presentation over a quantity discrepancy costs real money, and the record
 * of who accepted that risk has to exist.
 */
export async function proposeToleranceOverride(
  ctx: RequestCtx,
  input: { shipmentId: string; reason: string },
): Promise<{ pendingChangeId: string }> {
  const { propose } = await import('../core/pending-changes')

  const assessment = await withTenantRead(ctx, async (tx) => {
    const [shipment] = await tx.select().from(shipments).where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }
    if (!shipment.lcId) {
      throw new AppError('validation_failed', 'shipment.errors.no_lc_on_shipment', {
        shipmentId: shipment.id,
      })
    }

    const { lcs } = await import('@/modules/commercial/schema')
    const [lc] = await tx.select().from(lcs).where(scoped(lcs, ctx, eq(lcs.id, shipment.lcId)))
    if (!lc) throw notFound('shipment.errors.lc_not_found', { lcId: shipment.lcId })

    const loaded = await tx
      .select({ totalQty: cartons.totalQty })
      .from(cartons)
      .where(scoped(cartons, ctx, eq(cartons.shipmentId, shipment.id)))

    const shippedQty = sumPieces(loaded)
    const ordered = await orderedCells(ctx, tx, shipment.orderId)
    const lcQty = Object.values(ordered).reduce((a, b) => a + b, 0)

    const tolerance = wrapShipmentError(() =>
      lcToleranceCheck({ lcQty, shippedQty, tolerancePct: lc.tolerancePct }),
    )

    return { shipment, lcQty, shippedQty, tolerance }
  })

  if (assessment.tolerance.withinTolerance) {
    // Nothing to override. Raising a draft anyway would put an approval in the inbox for a
    // decision nobody needs to make.
    throw new AppError('validation_failed', 'shipment.errors.tolerance_not_breached', {
      shipmentId: input.shipmentId,
    })
  }

  const payload: ToleranceOverridePayload = {
    shipmentId: input.shipmentId,
    lcQty: assessment.lcQty,
    shippedQty: assessment.shippedQty,
    tolerancePct: assessment.tolerance.tolerancePct,
    direction: assessment.tolerance.direction as 'over' | 'short',
    varianceQty: assessment.tolerance.varianceQty,
    reason: input.reason,
  }

  const { id } = await propose(ctx, {
    moduleId: 'shipment',
    targetTable: 'shipments',
    targetId: input.shipmentId,
    operation: 'update',
    payload: payload as unknown as Record<string, unknown>,
    zodSchemaKey: 'tolerance_override',
    source: 'user_draft',
  })

  return { pendingChangeId: id }
}

/** Commit handler for an approved tolerance override (registered in `register.ts`). */
export async function commitToleranceOverride(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }> {
  const { toleranceOverridePayload } = await import('./zod')
  const payload = toleranceOverridePayload.parse(input.payload)

  const [shipment] = await tx
    .select()
    .from(shipments)
    .where(scoped(shipments, ctx, eq(shipments.id, payload.shipmentId)))
    .for('update')

  if (!shipment) {
    throw notFound('shipment.errors.shipment_not_found', { shipmentId: payload.shipmentId })
  }

  const override = {
    ...payload,
    acceptedBy: ctx.userId,
    acceptedAt: new Date().toISOString(),
  }

  await tx
    .update(shipments)
    .set({ toleranceOverride: override, updatedAt: new Date() })
    .where(scoped(shipments, ctx, eq(shipments.id, shipment.id)))

  await emit(ctx, tx, {
    eventName: SHIPMENT_EVENTS.toleranceOverridden,
    payload: override,
    aggregateTable: 'shipments',
    aggregateId: shipment.id,
  })

  return {
    rowId: shipment.id,
    before: { toleranceOverride: shipment.toleranceOverride },
    after: { toleranceOverride: override },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The latest-shipment countdown (brief §Jobs)
// ─────────────────────────────────────────────────────────────────────────────

export interface CountdownAlert extends CountdownResult {
  orderId: string
  lcId: string
  lcNumber: string
  latestShipmentDate: string | null
}

/**
 * LC latest-shipment countdown on the UNSHIPPED balance (shared with 1.3 and 2.1).
 *
 * The balance is ordered minus what has actually left. An order fully shipped before the
 * deadline goes quiet — a countdown that keeps firing on settled orders trains people to
 * ignore the one that matters.
 */
export async function latestShipmentAlerts(
  ctx: AnyCtx,
  input: { today: string; withinDays: number },
): Promise<CountdownAlert[]> {
  const { lcs } = await import('@/modules/commercial/schema')

  return withTenantRead(ctx, async (tx) => {
    const horizon = addDays(input.today, input.withinDays)

    const liveLcs = await tx
      .select({
        id: lcs.id,
        number: lcs.number,
        latestShipmentDate: lcs.latestShipmentDate,
      })
      .from(lcs)
      .where(scoped(lcs, ctx, 
        and(
          inArray(lcs.status, ['draft', 'active']),
          // A null date cannot be counted down; it is reported by the per-shipment path
          // instead, so the scan does not have to carry every LC in the book.
          lte(lcs.latestShipmentDate, horizon),
        ),
      ))

    if (liveLcs.length === 0) return []

    const rows = await tx
      .select({
        orderId: shipments.orderId,
        lcId: shipments.lcId,
        actualExFactory: shipments.actualExFactory,
      })
      .from(shipments)
      .where(scoped(shipments, ctx, 
        inArray(
          shipments.lcId,
          liveLcs.map((lc) => lc.id),
        ),
      ))

    const alerts: CountdownAlert[] = []
    const seen = new Set<string>()

    for (const lc of liveLcs) {
      for (const row of rows.filter((r) => r.lcId === lc.id)) {
        const key = `${lc.id}:${row.orderId}`
        if (seen.has(key)) continue
        seen.add(key)

        const ordered = await orderedCells(ctx, tx, row.orderId)
        const orderedQty = Object.values(ordered).reduce((a, b) => a + b, 0)

        // Only cartons on shipments that have actually left count as shipped.
        const shipped = await tx
          .select({ totalQty: cartons.totalQty })
          .from(cartons)
          .innerJoin(shipments, eq(cartons.shipmentId, shipments.id))
          .where(scoped(cartons, ctx, 
            and(
              eq(shipments.orderId, row.orderId),
              isNotNull(shipments.actualExFactory),
            ),
          ))

        const shippedQty = sumPieces(shipped)
        const result = wrapShipmentError(() =>
          latestShipmentCountdown({
            latestShipmentDate: lc.latestShipmentDate,
            today: input.today,
            unshippedQty: Math.max(0, orderedQty - shippedQty),
          }),
        )

        if (!result.relevant) continue

        alerts.push({
          ...result,
          orderId: row.orderId,
          lcId: lc.id,
          lcNumber: lc.number,
          latestShipmentDate: lc.latestShipmentDate,
        })
      }
    }

    // Most urgent first — a breach beats a countdown.
    return alerts.sort((a, b) => (a.daysRemaining ?? 0) - (b.daysRemaining ?? 0))
  })
}

/** Raise the countdown events for today. */
export async function emitLatestShipmentCountdown(
  // `AnyCtx`, not `RequestCtx`: this is a nightly job and the scheduler runs it as a system
  // actor. It reads nothing off the caller but the company — nobody authored these alerts.
  ctx: AnyCtx,
  input: { today: string; withinDays: number },
): Promise<{ raised: number }> {
  const alerts = await latestShipmentAlerts(ctx, input)
  if (alerts.length === 0) return { raised: 0 }

  return withTenantTx(ctx, async (tx) => {
    for (const alert of alerts) {
      await emit(ctx, tx, {
        eventName: SHIPMENT_EVENTS.latestShipmentCountdown,
        payload: { ...alert, asOf: input.today },
        aggregateTable: 'shipments',
        aggregateId: alert.orderId,
      })
    }
    return { raised: alerts.length }
  })
}

/**
 * Waive a FAILED final inspection so a shipment may depart ⚖.
 *
 * Restricted to owner and commercial in code, not in approval config — the same shape as
 * costing's below-the-floor rule, and for the same reason: a control that lives only in
 * `approval_rules` is a control somebody can edit their way past.
 *
 * Refused when the inspection actually passed. A waiver on a clean lot is a waiver nobody
 * needs, and it would sit on the row implying a problem that never existed.
 */
export async function waiveFinalInspection(
  ctx: RequestCtx,
  input: { shipmentId: string; reason: string },
): Promise<{ shipmentId: string; waivedBy: string }> {
  if (!ctx.roles.some((role) => role === 'owner' || role === 'commercial')) {
    throw new AppError('forbidden', 'shipment.errors.waiver_needs_commercial', {
      gate: GATES.finalInspection,
      roles: ctx.roles,
    })
  }

  if (input.reason.trim().length < 10) {
    // "ok" is not a reason. This field is the entire justification a later auditor has.
    throw new AppError('validation_failed', 'shipment.errors.waiver_needs_reason', {})
  }

  return withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
      .for('update')

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }
    if (shipment.portStatus !== 'planned') {
      // The goods have already left. Waiving after the fact would backdate a decision.
      throw conflict('shipment.errors.shipment_already_departed', {
        shipmentId: shipment.id,
        portStatus: shipment.portStatus,
      })
    }

    const { resolveFinalInspectionGate } = await import('../quality/service')
    const qc = await resolveFinalInspectionGate(ctx, tx, { orderId: shipment.orderId })

    if (qc.passed) {
      throw new AppError('validation_failed', 'shipment.errors.nothing_to_waive', {
        shipmentId: shipment.id,
      })
    }

    const waiver = {
      reasonKey: qc.reasonKey ?? 'gates.final_inspection.blocked',
      facts: qc.facts ?? {},
      reason: input.reason,
      waivedBy: ctx.userId,
      waivedAt: new Date().toISOString(),
    }

    await tx
      .update(shipments)
      .set({ qcWaiver: waiver, updatedAt: new Date() })
      .where(scoped(shipments, ctx, eq(shipments.id, shipment.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'shipments',
      targetId: shipment.id,
      before: { qcWaiver: shipment.qcWaiver },
      after: { qcWaiver: waiver },
    })

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.finalInspectionWaived,
      payload: { shipmentId: shipment.id, orderId: shipment.orderId, ...waiver },
      aggregateTable: 'shipments',
      aggregateId: shipment.id,
    })

    return { shipmentId: shipment.id, waivedBy: ctx.userId }
  })
}

/**
 * Accept, on the record, that this shipment goes against a credit that cannot take its date.
 *
 * The escape hatch for the gate in `confirmExFactory`. A factory does ship late and then
 * negotiates — the buyer amends the credit, or accepts the discrepancy at the counter, or
 * takes the goods on collection — and none of that is visible to this system at the moment
 * the truck leaves. So the decision is allowed, and recorded: who made it, when, against
 * which conflict, and why in their own words.
 *
 * Same shape as `waiveFinalInspection` on purpose: owner or commercial only, a reason long
 * enough to be a reason, and refused once the departure is already recorded. Backdating a
 * decision after the fact is the thing an auditor is looking for.
 */
export async function waiveLcDate(
  ctx: RequestCtx,
  input: { shipmentId: string; reason: string },
): Promise<{ shipmentId: string; waivedBy: string }> {
  if (!ctx.roles.some((role) => role === 'owner' || role === 'commercial')) {
    // The credit is commercial's instrument. A shipment clerk deciding to ship against a
    // dead one is exactly the decision this gate exists to lift out of the loading bay.
    throw new AppError('forbidden', 'shipment.errors.waiver_needs_commercial', {
      gate: GATES.lcLatestShipment,
      roles: ctx.roles,
    })
  }

  if (input.reason.trim().length < 10) {
    throw new AppError('validation_failed', 'shipment.errors.waiver_needs_reason', {})
  }

  return withTenantTx(ctx, async (tx) => {
    const [shipment] = await tx
      .select()
      .from(shipments)
      .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
      .for('update')

    if (!shipment) {
      throw notFound('shipment.errors.shipment_not_found', { shipmentId: input.shipmentId })
    }
    if (shipment.portStatus !== 'planned') {
      throw conflict('shipment.errors.shipment_already_departed', {
        shipmentId: shipment.id,
        portStatus: shipment.portStatus,
      })
    }

    const waiver = {
      reason: input.reason,
      waivedBy: ctx.userId,
      waivedAt: new Date().toISOString(),
      lcId: shipment.lcId,
    }

    await tx
      .update(shipments)
      .set({ lcWaiver: waiver, updatedAt: new Date() })
      .where(scoped(shipments, ctx, eq(shipments.id, shipment.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'shipments',
      targetId: shipment.id,
      before: { lcWaiver: shipment.lcWaiver },
      after: { lcWaiver: waiver },
    })

    await emit(ctx, tx, {
      eventName: SHIPMENT_EVENTS.lcDateWaived,
      payload: { shipmentId: shipment.id, orderId: shipment.orderId, ...waiver },
      aggregateTable: 'shipments',
      aggregateId: shipment.id,
    })

    return { shipmentId: shipment.id, waivedBy: ctx.userId }
  })
}

/** Cartons packed but not yet on any shipment — the loading floor's worklist. */
export async function unloadedCartons(
  ctx: AnyCtx,
  input: { orderId: string },
): Promise<(typeof cartons.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(cartons)
      .where(scoped(cartons, ctx, and(eq(cartons.orderId, input.orderId), isNull(cartons.shipmentId))))
      .orderBy(asc(cartons.cartonNo)),
  )
}

function toMinorScaled(value: string, scale: number): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(scale, '0').slice(0, scale))
}

function fromMinorScaled(minor: bigint, scale: number): string {
  const digits = minor.toString().padStart(scale + 1, '0')
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

/** Offline sync bodies, shared with the batch endpoint. */
export const offlineRecordFinishingOutput = recordFinishingOutputIn
export const offlinePackCarton = packCartonIn

export { conflict }
