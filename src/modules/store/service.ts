/**
 * 3.1 Fabric & Trims Store — service layer.
 *
 * The first floor-facing module, and the first consumer of two things built earlier:
 *
 *  - **the UD gate (2.2).** A bonded issue calls `drawUd` inside this transaction, so the
 *    issue and the customs draw commit together. An issue without its draw is a
 *    reconciliation that will not balance; a draw without its issue is material customs
 *    thinks left the warehouse and never did.
 *  - **offline sync (core).** Both operations register a sync handler, so a tablet can
 *    replay its whole batch and get the original result back rather than a duplicate.
 *
 * Shade mixing WARNS and does not block — the brief is explicit that the UI decides.
 * Blocking would get people working around the system by not recording the shade, which
 * is strictly worse than a warning nobody reads.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'

import { fromMinor, toMinor } from '@/lib/quantity'

import { drawUd } from '../commercial/service'
import { getRequisitionConsumption } from '../costing/queries'
import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { assertGate, GATES } from '../core/gates'
import { registerSyncHandler } from '../core/offline-sync'
import { defineStateMachine } from '../core/state-machine'
import { emit } from '../core/outbox'
import { scoped } from '../core/scoped'
import { type TenantDb, withTenantRead, withTenantTx } from '../core/tenancy'

import { STORE_EVENTS } from './events'
import { checkFabricInspection } from './gates'
import {
  grnLines,
  grns,
  inspectionStatusEnum,
  issueLines,
  issues,
  items,
  requisitionLines,
  requisitions,
  rolls,
  stockAdjustments,
} from './schema'
import {
  checkShadeMix,
  computeRequisitionLines,
  computeStock,
  type ItemStock,
  type StoreWarning,
} from './stock'
import { grnReceipt, issueRequest, requisitionRequest, stockAdjustmentDraft } from './zod'

/** ⚖ — adjustments move stock value; GRNs are the customs-facing record of receipt. */
registerAuditedTables('grns', 'stock_adjustments')

/**
 * A fabric roll's life (audit BE-M1).
 *
 * `rolls.status` was set by raw update in two places. The states are not decorative: the
 * fabric-inspection gate and the UD draw both read a roll's status to decide whether it may
 * be issued, so a roll moved back from `issued` to `in_stock` is fabric that exists twice
 * on paper — once in the store and once in a cutting room.
 *
 * `returned` goes back to stock deliberately: goods do come back from the floor, and that
 * IS the roll being available again. `adjusted_out` is terminal because writing a roll off
 * is a decision that went through the approve inbox.
 */
export const rollMachine = defineStateMachine({
  field: 'status',
  initial: 'in_stock',
  transitions: {
    in_stock: ['issued', 'adjusted_out'],
    issued: ['returned', 'adjusted_out'],
    returned: ['issued', 'adjusted_out'],
    adjusted_out: [],
  },
})

export type RollStatus = (typeof rollMachine.states)[number]

// ─────────────────────────────────────────────────────────────────────────────
// Stock reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * On-hand / reserved / free per item.
 *
 * Reads rolls and open requisitions and computes free — never a stored balance
 * (architecture §4). The covering indexes on `(company_id, item_id, status)` are what
 * keep this honest at 10^5 rolls, which the brief calls out explicitly.
 */
export async function getStock(
  ctx: AnyCtx,
  filter: { itemIds?: readonly string[] } = {},
): Promise<Map<string, ItemStock>> {
  return withTenantRead(ctx, async (tx) => {
    const rollRows = await tx
      .select()
      .from(rolls)
      .where(scoped(rolls, ctx, filter.itemIds?.length ? inArray(rolls.itemId, [...filter.itemIds]) : undefined))

    const reservationRows = await tx
      .select({
        itemId: requisitionLines.itemId,
        requiredQty: requisitionLines.requiredQty,
        issuedQty: requisitionLines.issuedQty,
        unit: requisitionLines.unit,
        status: requisitions.status,
      })
      .from(requisitionLines)
      .innerJoin(requisitions, eq(requisitions.id, requisitionLines.requisitionId))

    return computeStock({
      rolls: rollRows.map((roll) => ({
        rollId: roll.id,
        itemId: roll.itemId,
        qty: roll.qty,
        unit: roll.unit,
        status: roll.status,
        locationId: roll.locationId,
        shadeGroup: roll.shadeGroup,
      })),
      // Only the UNISSUED remainder of an open requisition still reserves stock.
      reservations: reservationRows.map((row) => ({
        itemId: row.itemId,
        qty: remaining(row.requiredQty, row.issuedQty),
        unit: row.unit,
        status: row.status === 'open' || row.status === 'partial' ? 'open' : 'fulfilled',
      })),
    })
  })
}

/** required − issued, exactly. */
function remaining(required: string, issued: string): string {
  const toMinor = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(2, '0').slice(0, 2))
  }
  const left = toMinor(required) - toMinor(issued)
  const clamped = left < 0n ? 0n : left
  const digits = clamped.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Goods in
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Receive a delivery. Creates the GRN, its lines, and a roll per physical roll.
 *
 * A bonded receipt REQUIRES a UD. Enforced here, and by a check constraint on the table,
 * because a bonded receipt with no declaration behind it is a customs problem rather than
 * a data-entry preference — and the two walls cost nothing.
 *
 * Note what receiving does NOT do: it does not draw the UD. Receiving bonded material is
 * not consuming it; the draw happens when it leaves the bonded warehouse on an issue.
 */
export async function receiveGrnIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ grnId: string; rolls: number }> {
  const payload = grnReceipt.parse(input)

  if (payload.bonded && !payload.udId) {
    throw new AppError('gate_blocked', 'store.errors.bonded_requires_ud', {
      gate: 'ud_balance',
      challanNo: payload.challanNo,
    })
  }

  const [grn] = await tx
    .insert(grns)
    .values({
      companyId: ctx.companyId,
      challanNo: payload.challanNo,
      receivedAt: payload.receivedAt,
      supplierPoId: payload.supplierPoId ?? null,
      bonded: payload.bonded,
      udId: payload.udId ?? null,
      documentId: payload.documentId ?? null,
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: grns.id })

  if (!grn) throw new Error('grns insert returned nothing')

  let rollCount = 0
  for (const line of payload.lines) {
    const [item] = await tx.select().from(items).where(scoped(items, ctx, eq(items.id, line.itemId)))
    if (!item) throw notFound('store.errors.item_not_found', { itemId: line.itemId })

    if (item.uom !== line.unit) {
      // The item's UoM is the truth. A challan recorded in the wrong unit would make
      // every stock figure for that item meaningless.
      throw new AppError('validation_failed', 'store.errors.unit_mismatch', {
        itemId: line.itemId,
        itemUom: item.uom,
        receivedUnit: line.unit,
      })
    }

    const [grnLine] = await tx
      .insert(grnLines)
      .values({
        companyId: ctx.companyId,
        grnId: grn.id,
        itemId: line.itemId,
        qty: line.qty,
        unit: line.unit,
        unitPrice: line.unitPrice ?? null,
        currency: line.currency ?? null,
      })
      .returning({ id: grnLines.id })

    if (!grnLine) throw new Error('grn_lines insert returned nothing')

    if (line.rolls.length > 0) {
      await tx.insert(rolls).values(
        line.rolls.map((roll) => ({
          companyId: ctx.companyId,
          grnLineId: grnLine.id,
          itemId: line.itemId,
          rollNo: roll.rollNo,
          lot: roll.lot ?? null,
          dyeLot: roll.dyeLot ?? null,
          shadeGroup: roll.shadeGroup ?? null,
          qty: roll.qty,
          unit: line.unit,
          locationId: roll.locationId,
        })),
      )
      rollCount += line.rolls.length
    }
  }

  await recordChange(ctx, tx, {
    action: 'insert',
    targetTable: 'grns',
    targetId: grn.id,
    after: {
      challanNo: payload.challanNo,
      bonded: payload.bonded,
      udId: payload.udId ?? null,
      lines: payload.lines.length,
      rolls: rollCount,
    },
  })

  await emit(ctx, tx, {
    eventName: STORE_EVENTS.grnReceived,
    payload: { grnId: grn.id, challanNo: payload.challanNo, bonded: payload.bonded, rolls: rollCount },
    aggregateTable: 'grns',
    aggregateId: grn.id,
  })

  return { grnId: grn.id, rolls: rollCount }
}

export async function receiveGrn(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ grnId: string; rolls: number }> {
  return withTenantTx(ctx, (tx) => receiveGrnIn(ctx, tx, input))
}

/**
 * The ONE way a GRN's `inspection_status` changes (CLAUDE.md rule 11: `grns` has one
 * writer, and it is this module). Quality's inspection roll-up calls this rather than
 * updating the table itself — `grns` is ⚖, so the change must carry an audit row, and
 * only the owner can promise that.
 */
export async function setGrnInspectionStatus(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { grnId: string; status: (typeof inspectionStatusEnum.enumValues)[number] },
): Promise<void> {
  const [before] = await tx
    .select({ inspectionStatus: grns.inspectionStatus })
    .from(grns)
    .where(scoped(grns, ctx, eq(grns.id, input.grnId)))

  if (!before) throw notFound('store.errors.grn_not_found', { grnId: input.grnId })
  if (before.inspectionStatus === input.status) return

  await tx
    .update(grns)
    .set({ inspectionStatus: input.status, updatedAt: new Date() })
    .where(scoped(grns, ctx, eq(grns.id, input.grnId)))

  await recordChange(ctx, tx, {
    action: 'update',
    targetTable: 'grns',
    targetId: input.grnId,
    before: { inspectionStatus: before.inspectionStatus },
    after: { inspectionStatus: input.status },
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Requisitions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Size an order's material need.
 *
 * Two ways in, and the first is the one that should be used: give a `bomId` and the
 * consumption is read from module 1.5, so the requisition is sized from the very numbers
 * the order was PRICED on. A quote built on 1.4523 m per garment and a requisition built
 * on someone's memory of "about 1.45" is how an order quietly runs short.
 *
 * Explicit `lines` remain accepted for the cases with no cost sheet behind them — a
 * sample run, a re-cut, a style being made before it has been costed.
 */
export async function createRequisition(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ requisitionId: string; lines: number; source: 'bom' | 'explicit' }> {
  const payload = requisitionRequest.parse(input)

  let sourceLines = payload.lines ?? []
  let source: 'bom' | 'explicit' = 'explicit'
  let wastagePct = payload.wastagePct

  if (payload.bomId) {
    // Cross-module read through the OWNER's queries.ts, never its tables (rule 11).
    const bom = await getRequisitionConsumption(ctx, payload.bomId)
    const items = await resolveItemsByRef(
      ctx,
      bom.map((line) => line.itemRef),
    )

    sourceLines = bom.map((line) => {
      const itemId = items.get(line.itemRef)
      if (!itemId) {
        // The BOM names something the store has never received. Refuse rather than drop
        // the line — a requisition missing an item is one a line stops waiting for.
        throw new AppError('validation_failed', 'store.errors.bom_item_unknown', {
          itemRef: line.itemRef,
        })
      }
      return { itemId, consumptionPerPiece: line.consumptionPerPiece, unit: line.unit }
    })

    // The BOM's own per-line wastage is the authority when it has one.
    wastagePct = bom[0]?.wastagePct ?? payload.wastagePct
    source = 'bom'
  }

  if (sourceLines.length === 0) {
    throw new AppError('validation_failed', 'store.errors.requisition_has_no_lines', {})
  }

  const computed = computeRequisitionLines({
    orderQty: payload.orderQty,
    wastagePct,
    lines: sourceLines,
  })

  return withTenantTx(ctx, async (tx) => {
    const [requisition] = await tx
      .insert(requisitions)
      .values({
        companyId: ctx.companyId,
        orderId: payload.orderId,
        // Kept so a requisition can be explained months later — including WHERE the
        // consumption figures came from.
        basis: {
          orderQty: payload.orderQty,
          wastagePct,
          source,
          bomId: payload.bomId ?? null,
          lines: sourceLines,
        },
        createdBy: ctx.userId,
      })
      .returning({ id: requisitions.id })

    if (!requisition) throw new Error('requisitions insert returned nothing')

    await tx.insert(requisitionLines).values(
      computed.map((line) => ({
        companyId: ctx.companyId,
        requisitionId: requisition.id,
        itemId: line.itemId,
        requiredQty: line.requiredQty,
        unit: line.unit,
      })),
    )

    return { requisitionId: requisition.id, lines: computed.length, source }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Goods out
// ─────────────────────────────────────────────────────────────────────────────

export interface IssueResult {
  issueId: string
  lines: number
  warnings: StoreWarning[]
  /** Set when bonded rolls were drawn against a UD. */
  udDraws: { udId: string; itemRef: string; qty: string }[]
}

/**
 * Issue stock to an order.
 *
 * The order of operations matters and is not arbitrary:
 *   1. lock the rolls — two storekeepers must not issue the same roll;
 *   2. validate against the requisition remainder;
 *   3. draw the UD for anything bonded — the gate can still refuse here;
 *   4. write the issue, flip the rolls, advance the requisition.
 *
 * All in one transaction. A partial issue — rolls marked out with no UD draw behind them —
 * is exactly the discrepancy a customs reconciliation surfaces months later.
 */
export async function issueStockIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<IssueResult> {
  const payload = issueRequest.parse(input)

  // Lock every roll up front, in a stable order, so two concurrent issues cannot
  // interleave into a deadlock.
  const rollIds = [...new Set(payload.lines.map((line) => line.rollId).filter(Boolean))] as string[]
  const picked = rollIds.length
    ? await tx
        .select()
        .from(rolls)
        .where(scoped(rolls, ctx, inArray(rolls.id, rollIds)))
        .orderBy(rolls.id)
        .for('update')
    : []

  const rollById = new Map(picked.map((roll) => [roll.id, roll]))

  /*
   * Which declaration covers each picked roll: roll → GRN line → GRN. Resolved HERE and
   * never trusted from the client, because the client never sent it — the receive screen
   * names the UD on the GRN, the roll carries its GRN line, and the first live bonded
   * issue left the warehouse with no draw recorded and the customs gate never consulted
   * (live-test finding, Phase 4: the workbench balance sat still while 6,000 bonded yards
   * walked). An explicit `line.udId` still wins — trims issued by quantity have no roll
   * to resolve through.
   */
  const grnLineIds = [...new Set(picked.map((roll) => roll.grnLineId))]
  const udByGrnLine = new Map<string, string>()
  if (grnLineIds.length > 0) {
    const covered = await tx
      .select({ grnLineId: grnLines.id, udId: grns.udId })
      .from(grnLines)
      .innerJoin(grns, eq(grns.id, grnLines.grnId))
      .where(scoped(grnLines, ctx, inArray(grnLines.id, grnLineIds)))
    for (const row of covered) {
      if (row.udId) udByGrnLine.set(row.grnLineId, row.udId)
    }
  }

  for (const line of payload.lines) {
    if (!line.rollId) continue
    const roll = rollById.get(line.rollId)
    if (!roll) throw notFound('store.errors.roll_not_found', { rollId: line.rollId })
    if (roll.status !== 'in_stock') {
      throw conflict('store.errors.roll_not_in_stock', { rollId: roll.id, status: roll.status })
    }
  }

  // 4-point inspection (rule 8, `GATES.fabricInspection`). Checked AFTER the rolls are
  // locked and their status verified, so the gate reasons about rolls that are genuinely
  // issuable, and BEFORE anything is written — a gate that fires mid-transaction still
  // rolls back, but the error it produces names the wrong step.
  assertGate(
    GATES.fabricInspection,
    await checkFabricInspection(ctx, tx, { rollIds }),
  )

  // Shade mixing: what this order already holds, plus what is being picked now.
  const alreadyIssued = await tx
    .select({ shadeGroup: rolls.shadeGroup })
    .from(issueLines)
    .innerJoin(issues, eq(issues.id, issueLines.issueId))
    .innerJoin(rolls, eq(rolls.id, issueLines.rollId))
    .where(scoped(issueLines, ctx, eq(issues.orderId, payload.orderId)))

  const shade = checkShadeMix({
    alreadyIssued: alreadyIssued.map((row) => row.shadeGroup),
    picking: picked.map((roll) => roll.shadeGroup),
  })

  // Requisition remainder — issuing beyond it is how one order eats another's cloth.
  if (payload.requisitionId) {
    for (const line of payload.lines) {
      const [reqLine] = await tx
        .select()
        .from(requisitionLines)
        .where(scoped(requisitionLines, ctx, 
          and(
            eq(requisitionLines.requisitionId, payload.requisitionId),
            eq(requisitionLines.itemId, line.itemId),
          ),
        ))
        .for('update')

      if (!reqLine) {
        throw new AppError('validation_failed', 'store.errors.item_not_requisitioned', {
          itemId: line.itemId,
        })
      }

      const left = remaining(reqLine.requiredQty, reqLine.issuedQty)
      if (compareDecimal(line.qty, left) > 0) {
        throw new AppError('validation_failed', 'store.errors.exceeds_requisition', {
          itemId: line.itemId,
          requested: line.qty,
          remaining: left,
        })
      }
    }
  }

  const [issue] = await tx
    .insert(issues)
    .values({
      companyId: ctx.companyId,
      requisitionId: payload.requisitionId ?? null,
      orderId: payload.orderId,
      offlineKey: payload.offlineKey ?? null,
      warnings: shade.warnings as unknown[],
      createdBy: ctx.userId,
    })
    .returning({ id: issues.id })

  if (!issue) throw new Error('issues insert returned nothing')

  const udDraws: IssueResult['udDraws'] = []

  for (const line of payload.lines) {
    const roll = line.rollId ? rollById.get(line.rollId) : undefined

    // Bonded material leaving the warehouse draws the declaration. In THIS transaction,
    // so the issue and the draw share a fate (module 2.2 owns the gate itself).
    //
    // Keyed on `udId` alone, NOT on a roll being named. Trims and accessories are issued
    // by quantity with no roll behind them, and an earlier version that required a roll
    // let those lines skip the customs gate entirely — bonded material leaving with no
    // draw recorded against it. A roll's declaration is resolved through its GRN when the
    // caller did not name one.
    const udId = line.udId ?? (roll ? udByGrnLine.get(roll.grnLineId) : undefined)
    if (udId) {
      const [item] = await tx.select().from(items).where(scoped(items, ctx, eq(items.id, line.itemId)))
      const itemRef = item?.code ?? line.itemId

      const draw = await drawUd(ctx, tx, {
        udId,
        itemRef,
        // A scanned declaration speaks the paper's prose, the store speaks codes — the
        // draw resolves to whichever the declaration authorizes.
        itemRefAliases: item?.name ? [item.name] : [],
        qty: line.qty,
        unit: line.unit,
        storeIssueId: issue.id,
      })

      udDraws.push({ udId, itemRef: draw.decision.itemRef ?? itemRef, qty: line.qty })
    }

    await tx.insert(issueLines).values({
      companyId: ctx.companyId,
      issueId: issue.id,
      itemId: line.itemId,
      rollId: line.rollId ?? null,
      qty: line.qty,
      unit: line.unit,
    })

    if (roll) {
      // Issuing a roll that is already issued would be the same fabric leaving the store
      // twice — the machine is what turns that into a 409 instead of a silent overwrite.
      rollMachine.assert(roll.status as RollStatus, 'issued')
      await tx
        .update(rolls)
        .set({ status: 'issued', updatedAt: new Date() })
        .where(scoped(rolls, ctx, eq(rolls.id, roll.id)))
    }

    if (payload.requisitionId) {
      await tx
        .update(requisitionLines)
        .set({ issuedQty: sql`${requisitionLines.issuedQty} + ${line.qty}`, updatedAt: new Date() })
        .where(scoped(requisitionLines, ctx, 
          and(
            eq(requisitionLines.requisitionId, payload.requisitionId),
            eq(requisitionLines.itemId, line.itemId),
          ),
        ))
    }
  }

  if (payload.requisitionId) await advanceRequisitionStatus(ctx, tx, payload.requisitionId)

  await emit(ctx, tx, {
    eventName: STORE_EVENTS.stockIssued,
    payload: {
      issueId: issue.id,
      orderId: payload.orderId,
      lines: payload.lines.length,
      shadeMixed: shade.mixed,
      udDraws: udDraws.length,
    },
    aggregateTable: 'issues',
    aggregateId: issue.id,
  })

  return { issueId: issue.id, lines: payload.lines.length, warnings: shade.warnings, udDraws }
}

export async function issueStock(ctx: RequestCtx, input: unknown): Promise<IssueResult> {
  return withTenantTx(ctx, (tx) => issueStockIn(ctx, tx, input))
}

/** open → partial → fulfilled, derived from what has actually been issued. */
async function advanceRequisitionStatus(
  // `ctx` so both queries name the company (plan 1.3). A requisition's status is what the
  // floor plans issues against; deriving it from another factory's lines would be silent.
  ctx: AnyCtx,
  tx: TenantDb,
  requisitionId: string,
): Promise<void> {
  const lines = await tx
    .select()
    .from(requisitionLines)
    .where(scoped(requisitionLines, ctx, eq(requisitionLines.requisitionId, requisitionId)))

  const anyIssued = lines.some((line) => compareDecimal(line.issuedQty, '0') > 0)
  const allDone = lines.every((line) => compareDecimal(line.issuedQty, line.requiredQty) >= 0)

  await tx
    .update(requisitions)
    .set({
      status: allDone ? 'fulfilled' : anyIssued ? 'partial' : 'open',
      updatedAt: new Date(),
    })
    .where(scoped(requisitions, ctx, eq(requisitions.id, requisitionId)))
}

function compareDecimal(a: string, b: string): number {
  const toMinor = (value: string): bigint => {
    const [whole = '0', fraction = ''] = value.split('.')
    return BigInt(whole + fraction.padEnd(2, '0').slice(0, 2))
  }
  const left = toMinor(a)
  const right = toMinor(b)
  return left < right ? -1 : left > right ? 1 : 0
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Register the floor operations with the core batch endpoint.
 *
 * Both handlers take the sync transaction, so the write, the `offline_keys` claim and any
 * UD draw all commit together — which is what makes "replay the batch" safe rather than
 * merely convenient.
 */
export function registerStoreSyncHandlers(): void {
  registerSyncHandler('store', 'receive_grn', { roles: ['store'] }, async (ctx, tx, row) => {
    // The device's key goes onto the GRN itself, so a storekeeper reconciling a tablet
    // can find the record without being shown an internal ledger table.
    const result = await receiveGrnIn(ctx, tx, { ...row.payload, offlineKey: row.offlineKey })
    return { rowId: result.grnId }
  })

  registerSyncHandler('store', 'issue_stock', { roles: ['store'] }, async (ctx, tx, row) => {
    const result = await issueStockIn(ctx, tx, { ...row.payload, offlineKey: row.offlineKey })
    return { rowId: result.issueId }
  })
}

/** Map BOM item references onto store item ids. */
async function resolveItemsByRef(
  ctx: AnyCtx,
  refs: readonly string[],
): Promise<Map<string, string>> {
  if (refs.length === 0) return new Map()

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ id: items.id, code: items.code })
      .from(items)
      .where(scoped(items, ctx, inArray(items.code, [...refs])))

    return new Map(rows.map((row) => [row.code, row.id]))
  })
}

/**
 * Commit an approved stock adjustment ⚖.
 *
 * Until this existed, `stock_adjustments` was a registered pending target with no handler:
 * approving one fell through to core's generic writer, which uses the payload's keys as
 * column names and rejected `itemId` against a snake_case identifier check. So a store
 * count correction — a damaged roll, a miscount, a shortage found at inspection — could be
 * drafted and never applied. It is routine work in a store, and it silently did nothing.
 *
 * **The delta is applied to the ROLL, not kept as a separate ledger.** Stock in this module
 * is derived from rolls (`computeStock` reads rolls and reservations, nothing else), so an
 * adjustment that only inserted its own row would leave on-hand unchanged and the screen
 * would disagree with the correction somebody just approved. Writing the roll is what makes
 * the number move; the `stock_adjustments` row is the reason it moved.
 *
 * A write-off that reaches zero sets the roll to `adjusted_out` rather than storing a zero
 * quantity — `rolls_qty_positive` forbids the latter, and a roll that exists with no cloth
 * on it is not a thing a storekeeper can be shown.
 */
export async function commitStockAdjustment(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; before: Record<string, unknown> | null; after: Record<string, unknown> }> {
  const payload = stockAdjustmentDraft.parse(input.payload)
  /*
   * Exact, because this quantity is bonded fabric.
   *
   * This was `Number(payload.qtyDelta)` and `Number(roll.qty) + delta`, rounded back with
   * `.toFixed(2)` — float arithmetic on the roll quantity that UD reconciliation is
   * computed against, i.e. the number a customs inspector checks. `no-float-money` never
   * saw it because `qty`/`qtyDelta` are not money-shaped names, which is exactly how a
   * quantity ends up being the one thing in the module that is not exact.
   */
  const deltaMinor = toMinor(payload.qtyDelta, 'adjustment quantity')

  let before: Record<string, unknown> | null = null

  if (payload.rollId) {
    const [roll] = await tx
      .select({ id: rolls.id, qty: rolls.qty, unit: rolls.unit, status: rolls.status, itemId: rolls.itemId })
      .from(rolls)
      .where(scoped(rolls, ctx, eq(rolls.id, payload.rollId)))

    if (!roll) throw notFound('store.errors.roll_not_found', { rollId: payload.rollId })

    if (roll.itemId !== payload.itemId) {
      // The draft names both; disagreeing means the reviewer approved an adjustment
      // against a different item than the roll belongs to.
      throw new AppError('validation_failed', 'store.errors.roll_item_mismatch', {
        rollId: payload.rollId,
        itemId: payload.itemId,
      })
    }
    if (roll.unit !== payload.unit) {
      throw new AppError('validation_failed', 'store.errors.unit_mismatch', {
        rollId: payload.rollId,
        rollUnit: roll.unit,
        payloadUnit: payload.unit,
      })
    }

    const nextMinor = toMinor(roll.qty, 'roll quantity') + deltaMinor
    if (nextMinor < 0n) {
      // Taking more off a roll than is on it is a miscount in the correction itself.
      throw new AppError('validation_failed', 'store.errors.adjustment_below_zero', {
        rollId: payload.rollId,
        qty: roll.qty,
        qtyDelta: payload.qtyDelta,
      })
    }

    before = { rollId: roll.id, qty: roll.qty, status: roll.status }

    // Only the write-off changes state; adjusting a quantity down to something above zero
    // leaves the roll where it is.
    if (nextMinor === 0n) rollMachine.assert(roll.status as RollStatus, 'adjusted_out')

    await tx
      .update(rolls)
      .set(
        nextMinor === 0n
          ? { status: 'adjusted_out', updatedAt: new Date() }
          : { qty: fromMinor(nextMinor), updatedAt: new Date() },
      )
      .where(scoped(rolls, ctx, eq(rolls.id, payload.rollId)))
  }

  const [row] = await tx
    .insert(stockAdjustments)
    .values({
      companyId: ctx.companyId,
      itemId: payload.itemId,
      rollId: payload.rollId ?? null,
      qtyDelta: payload.qtyDelta,
      unit: payload.unit,
      reasonCode: payload.reasonCode,
      note: payload.note,
      createdBy: ctx.userId,
    })
    .returning({ id: stockAdjustments.id })

  if (!row) throw new Error('stock_adjustments insert returned nothing')

  return {
    rowId: row.id,
    before,
    after: {
      itemId: payload.itemId,
      rollId: payload.rollId ?? null,
      qtyDelta: payload.qtyDelta,
      reasonCode: payload.reasonCode,
    },
  }
}
