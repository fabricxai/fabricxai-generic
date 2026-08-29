/**
 * Read models for Procurement.
 *
 * Two things this screen has to keep straight, because getting either backwards
 * is expensive:
 *
 *  - **Import vs local is a property of the SUPPLIER, not the currency.** A
 *    local mill invoicing in USD is still a local purchase; an import is an
 *    import even when it prices in taka. The BTB requirement follows origin,
 *    so the board groups on origin too.
 *  - **Received is per LINE, not per PO.** A PO half-received is not "in
 *    progress" in any useful sense — some items are on the floor and some are
 *    still on the water, and the shortfall is what a merchandiser chases.
 */
import { and, desc, eq, gt, ilike, inArray, isNotNull, ne, or, sql } from 'drizzle-orm'

import { likePattern } from '@/lib/search-text'
import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { btbLcs } from '@/modules/commercial/schema'

import {
  purchaseRequisitions,
  supplierPoLines,
  supplierPos,
  supplierScores,
  suppliers,
} from './schema'

export type PoStatus =
  | 'issued'
  | 'confirmed'
  | 'in_production'
  | 'shipped'
  | 'received_partial'
  | 'received'
  | 'cancelled'

export interface PoRow {
  id: string
  poNumber: string
  supplierName: string
  supplierType: string
  /** 'local' or 'import' — decides whether a BTB is required. */
  origin: string
  currency: string
  totalValue: string | null
  status: PoStatus
  expectedDeliveryDate: string | null
  /** Negative once the expected date has passed with lines still open. */
  daysToDelivery: number | null
  btbLcId: string | null
  btbNumber: string | null
  /** An import PO with no BTB linked — the gate should have prevented this. */
  importWithoutBtb: boolean
  lines: { total: number; open: number; received: number; shortClosed: number }
}

function daysUntil(dateIso: string, now: Date): number {
  const target = new Date(`${dateIso}T00:00:00Z`).getTime()
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.round((target - today) / 86_400_000)
}

export async function purchaseOrders(ctx: AnyCtx, input: { now: Date }): Promise<PoRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: supplierPos.id,
        poNumber: supplierPos.poNumber,
        currency: supplierPos.currency,
        totalValue: supplierPos.totalValue,
        status: supplierPos.status,
        expectedDeliveryDate: supplierPos.expectedDeliveryDate,
        btbLcId: supplierPos.btbLcId,
        supplierName: suppliers.name,
        supplierType: suppliers.type,
        origin: suppliers.origin,
      })
      .from(supplierPos)
      .innerJoin(suppliers, eq(suppliers.id, supplierPos.supplierId))
      .orderBy(desc(supplierPos.createdAt))
      .limit(150)

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)
    const btbIds = rows.map((r) => r.btbLcId).filter((id): id is string => !!id)

    const [lineRows, btbRows] = await Promise.all([
      tx
        .select({ supplierPoId: supplierPoLines.supplierPoId, status: supplierPoLines.status })
        .from(supplierPoLines)
        .where(scoped(supplierPoLines, ctx, inArray(supplierPoLines.supplierPoId, ids))),
      btbIds.length > 0
        ? tx
            .select({ id: btbLcs.id, number: btbLcs.number })
            .from(btbLcs)
            .where(scoped(btbLcs, ctx, inArray(btbLcs.id, btbIds)))
        : Promise.resolve([] as { id: string; number: string }[]),
    ])

    return rows.map((r): PoRow => {
      const mine = lineRows.filter((l) => l.supplierPoId === r.id)
      const open = mine.filter((l) => l.status === 'open' || l.status === 'received_partial').length

      return {
        id: r.id,
        poNumber: r.poNumber,
        supplierName: r.supplierName,
        supplierType: r.supplierType,
        origin: r.origin,
        currency: r.currency,
        totalValue: r.totalValue,
        status: r.status as PoStatus,
        expectedDeliveryDate: r.expectedDeliveryDate,
        // Only meaningful while something is still outstanding — a fully
        // received PO cannot be late.
        daysToDelivery:
          r.expectedDeliveryDate && open > 0 ? daysUntil(r.expectedDeliveryDate, input.now) : null,
        btbLcId: r.btbLcId,
        btbNumber: btbRows.find((b) => b.id === r.btbLcId)?.number ?? null,
        importWithoutBtb: r.origin === 'import' && !r.btbLcId && r.status !== 'cancelled',
        lines: {
          total: mine.length,
          open,
          received: mine.filter((l) => l.status === 'received').length,
          // A short close is a decision somebody made, not a delivery — the
          // balance will never arrive and the PO is finished anyway.
          shortClosed: mine.filter((l) => l.status === 'short_closed').length,
        },
      }
    })
  })
}

export interface SupplierRow {
  id: string
  code: string
  name: string
  type: string
  origin: string
  defaultCurrency: string
  openPos: number
}

export async function supplierBook(ctx: AnyCtx): Promise<SupplierRow[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: suppliers.id,
        code: suppliers.code,
        name: suppliers.name,
        type: suppliers.type,
        origin: suppliers.origin,
        defaultCurrency: suppliers.defaultCurrency,
        openPos: sql<number>`count(${supplierPos.id}) filter (
          where ${supplierPos.status} not in ('received', 'cancelled')
        )`.mapWith(Number),
      })
      .from(suppliers)
      .leftJoin(supplierPos, eq(supplierPos.supplierId, suppliers.id))
      .where(scoped(suppliers, ctx, eq(suppliers.isActive, true)))
      .groupBy(suppliers.id)
      .orderBy(suppliers.name),
  )
}

/** Requisitions still waiting on quotes or an order. */
export async function openRequisitions(
  ctx: AnyCtx,
  input: { now: Date },
): Promise<{ id: string; prNo: string; neededBy: string | null; status: string; daysToNeeded: number | null }[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: purchaseRequisitions.id,
        prNo: purchaseRequisitions.prNo,
        neededBy: purchaseRequisitions.neededBy,
        status: purchaseRequisitions.status,
      })
      .from(purchaseRequisitions)
      .where(scoped(purchaseRequisitions, ctx, inArray(purchaseRequisitions.status, ['open', 'quoted'])))
      .orderBy(purchaseRequisitions.neededBy)

    return rows.map((r) => ({
      ...r,
      daysToNeeded: r.neededBy ? daysUntil(r.neededBy, input.now) : null,
    }))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The scorecard
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One supplier's standing, for the period asked for.
 *
 * Every metric is nullable and stays nullable all the way to the screen. `supplierScore`
 * returns null when it has nothing to divide by — no closed receipts, no quotes requested —
 * and collapsing that to 0 would read as "delivered nothing on time" rather than "has not
 * delivered yet". Those two say opposite things about whether to place an order.
 *
 * `observations` is carried for the same reason: 100% on-time from one receipt and 100%
 * from forty are the same number and not the same fact.
 */
export interface SupplierScoreRow {
  supplierId: string
  code: string
  name: string
  type: string
  origin: string
  period: string
  onTimePct: string | null
  qualityRejectPct: string | null
  priceIndex: string | null
  responsivenessPct: string | null
  observations: number
  computedAt: Date
}

/**
 * The most recent period that has been scored at all.
 *
 * Returned rather than assumed: a screen that defaults to "this month" and finds nothing
 * cannot tell an unscored month from a month with no activity, and shows an empty
 * scorecard either way.
 */
export async function latestScoredPeriod(ctx: AnyCtx): Promise<string | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ period: supplierScores.period })
      .from(supplierScores)
      .orderBy(desc(supplierScores.period))
      .limit(1)
    return row?.period ?? null
  })
}

/**
 * Every active supplier's score for a period — including the ones with none.
 *
 * A LEFT JOIN from suppliers, deliberately. Joining the other way would list only suppliers
 * the scorer had something to say about, and a supplier who has been sent no work in six
 * months is exactly the row a procurement officer should see before sending them more.
 */
export async function supplierScorecard(
  ctx: AnyCtx,
  input: { period: string },
): Promise<SupplierScoreRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        supplierId: suppliers.id,
        code: suppliers.code,
        name: suppliers.name,
        type: suppliers.type,
        origin: suppliers.origin,
        onTimePct: supplierScores.onTimePct,
        qualityRejectPct: supplierScores.qualityRejectPct,
        priceIndex: supplierScores.priceIndex,
        responsivenessPct: supplierScores.responsivenessPct,
        observations: supplierScores.observations,
        computedAt: supplierScores.computedAt,
      })
      .from(suppliers)
      .leftJoin(
        supplierScores,
        and(eq(supplierScores.supplierId, suppliers.id), eq(supplierScores.period, input.period)),
      )
      .where(scoped(suppliers, ctx, eq(suppliers.isActive, true)))
      .orderBy(suppliers.name)

    return rows.map((row) => ({
      ...row,
      period: input.period,
      observations: row.observations ?? 0,
      computedAt: row.computedAt ?? new Date(0),
    }))
  })
}

/** The periods that have been scored, newest first — what the period selector offers. */
export async function scoredPeriods(ctx: AnyCtx, limit = 12): Promise<string[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ period: supplierScores.period })
      .from(supplierScores)
      .orderBy(desc(supplierScores.period))
      .limit(limit)
    return rows.map((r) => r.period)
  })
}

/**
 * The newest period that actually has something in it, other than the one being viewed.
 *
 * "Scored" and "has a record" are different questions. The nightly job writes a row for
 * every active supplier every night, so the current month is always scored and, for the
 * first days of it, always empty. A screen that cannot tell those apart shows a blank table
 * and lets the reader supply their own explanation — usually that the suppliers are doing
 * badly, rather than that the month is three days old.
 */
export async function lastPeriodWithRecord(
  ctx: AnyCtx,
  input: { excluding: string },
): Promise<string | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ period: supplierScores.period })
      .from(supplierScores)
      .where(scoped(supplierScores, ctx, 
        and(
          ne(supplierScores.period, input.excluding),
          // Any evidence at all: a closed receipt, or a quote somebody returned.
          or(
            gt(supplierScores.observations, 0),
            isNotNull(supplierScores.onTimePct),
            isNotNull(supplierScores.priceIndex),
            isNotNull(supplierScores.responsivenessPct),
          ),
        ),
      ))
      .orderBy(desc(supplierScores.period))
      .limit(1)

    return row?.period ?? null
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Goods in
// ─────────────────────────────────────────────────────────────────────────────

export interface AwaitingLine {
  lineId: string
  supplierPoId: string
  poNumber: string
  supplierName: string
  currency: string
  itemCode: string
  itemName: string
  orderedQty: string
  receivedQty: string
  /** What is still owed. Zero only on a line that has been over-received. */
  outstandingQty: string
  unit: string
  unitPrice: string
  status: string
  expectedDeliveryDate: string | null
  /** Negative once the expected date has passed. Null when the PO gave no date. */
  daysToDelivery: number | null
}

/**
 * PO lines still waiting on goods.
 *
 * A cancelled PO's lines are not awaited and a fully `received` one has nothing left, but
 * everything in between is here — including `received_partial`, which is the status a PO
 * takes the moment anything is received against it. Leaving it out made the first partial
 * receipt a one-way trap: the balance disappeared from this screen and could never be
 * received, while the line sat open forever and the supplier scored nothing.
 *
 * Closed LINES are excluded by status rather than by comparing quantities, because a
 * short-closed line has an outstanding balance somebody has deliberately written off, and
 * re-offering it invites a second receipt against a settled account.
 *
 * Ordered by how late they are: a line three weeks past its date is what somebody should
 * chase before they walk to the goods-in bay.
 */
export async function awaitingReceipt(
  ctx: AnyCtx,
  input: { now: Date },
): Promise<AwaitingLine[]> {
  return withTenantRead(ctx, async (tx) => {
    const { items } = await import('@/modules/store/schema')

    const rows = await tx
      .select({
        lineId: supplierPoLines.id,
        supplierPoId: supplierPos.id,
        poNumber: supplierPos.poNumber,
        supplierName: suppliers.name,
        currency: supplierPos.currency,
        itemCode: items.code,
        itemName: items.name,
        orderedQty: supplierPoLines.qty,
        receivedQty: supplierPoLines.receivedQty,
        unit: supplierPoLines.unit,
        unitPrice: supplierPoLines.unitPrice,
        status: supplierPoLines.status,
        expectedDeliveryDate: supplierPos.expectedDeliveryDate,
        // Subtracted by Postgres on the numerics themselves. Doing it in JS would mean
        // Number() on a quantity, and a decimal string parsed to a float and back is
        // exactly the rounding this repo keeps out of quantities and money alike.
        outstandingQty: sql<string>`greatest(
          ${supplierPoLines.qty} - ${supplierPoLines.receivedQty}, 0
        )::text`,
      })
      .from(supplierPoLines)
      .innerJoin(supplierPos, eq(supplierPos.id, supplierPoLines.supplierPoId))
      .innerJoin(suppliers, eq(suppliers.id, supplierPos.supplierId))
      .innerJoin(items, eq(items.id, supplierPoLines.itemId))
      .where(scoped(supplierPoLines, ctx, 
        and(
          inArray(supplierPoLines.status, ['open', 'received_partial']),
          inArray(supplierPos.status, [
            'issued',
            'confirmed',
            'in_production',
            'shipped',
            'received_partial',
          ]),
        ),
      ))

    return rows
      .map((row) => ({
        ...row,
        daysToDelivery: row.expectedDeliveryDate
          ? daysUntil(row.expectedDeliveryDate, input.now)
          : null,
      }))
      .sort(
        (a, b) =>
          (a.daysToDelivery ?? 9_999) - (b.daysToDelivery ?? 9_999) ||
          a.poNumber.localeCompare(b.poNumber),
      )
  })
}


/** A purchase requisition, as the command bar shows it. */
export interface RequisitionSearchRow {
  id: string
  prNo: string
  status: string
  neededBy: string | null
}

/** Requisitions matching a PR number fragment. */
export async function searchRequisitions(
  ctx: AnyCtx,
  input: { term: string; limit: number },
): Promise<RequisitionSearchRow[]> {
  const like = likePattern(input.term)

  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: purchaseRequisitions.id,
        prNo: purchaseRequisitions.prNo,
        status: purchaseRequisitions.status,
        neededBy: purchaseRequisitions.neededBy,
      })
      .from(purchaseRequisitions)
      .where(scoped(purchaseRequisitions, ctx, ilike(purchaseRequisitions.prNo, like)))
      .limit(input.limit),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// What has been booked against one order
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderMaterialPo {
  id: string
  poNumber: string
  supplierName: string
  origin: 'local' | 'import'
  totalValue: string
  currency: string
  expectedDeliveryDate: string | null
  status: PoStatus
  /** An import PO must sit on a back-to-back credit; a local one need not — which is why
   *  `origin` travels beside it rather than the reader inferring it from the currency. */
  onBtb: boolean
}

/**
 * The supplier POs booked for an order — the "fabric booking → mill PI" row of its
 * sign-off panel (design canvas).
 *
 * Reached through the requisition, which is the only thing that knows about the order:
 * `supplier_pos` has no `order_id` and should not gain one, because one PO can serve
 * several orders' requisitions. `purchase_requisitions.order_id` is indexed for exactly
 * this lookup.
 *
 * `onBtb` is reported rather than judged. Whether an import PO lacking a BTB is a problem
 * is the import-PO gate's question and it already refuses at issue time (rule 8); a read
 * model repeating that judgement would be a second opinion that can disagree with the
 * first.
 */
export async function orderMaterialPos(
  ctx: AnyCtx,
  orderId: string,
): Promise<OrderMaterialPo[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: supplierPos.id,
        poNumber: supplierPos.poNumber,
        supplierName: suppliers.name,
        origin: suppliers.origin,
        totalValue: supplierPos.totalValue,
        currency: supplierPos.currency,
        expectedDeliveryDate: supplierPos.expectedDeliveryDate,
        status: supplierPos.status,
        onBtb: sql<boolean>`${supplierPos.btbLcId} is not null`,
      })
      .from(supplierPos)
      .innerJoin(
        purchaseRequisitions,
        eq(purchaseRequisitions.id, supplierPos.purchaseRequisitionId),
      )
      .innerJoin(suppliers, eq(suppliers.id, supplierPos.supplierId))
      .where(scoped(supplierPos, ctx, eq(purchaseRequisitions.orderId, orderId)))
      // Soonest expected first: the one that will hold up cutting is the one to look at.
      .orderBy(supplierPos.expectedDeliveryDate, supplierPos.poNumber),
  )
}
