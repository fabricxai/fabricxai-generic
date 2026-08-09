/**
 * 11.1 Commercial Finance — service layer ⚖
 *
 * The brief's non-goal is the design: **no general ledger.** No journals, no accounts, no
 * double entry. A factory that already runs Tally does not need a second one; it needs to
 * know when cash arrives and whether an order made money.
 *
 * Nothing in this file accepts a cost figure from a caller. Materials come from 3.1's issues,
 * commercial from 2.1's bank charges, CM from a stated allocation model. A cost somebody can
 * type is a cost somebody will type, and the entire value of a variance report is that
 * neither side of it was chosen by the person the report is about.
 */
import { fromMinor, toMinor, toMinorAtScale } from '@/lib/quantity'
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import { isSystemCtx, type AnyCtx, type RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { notify } from '../core/notifications'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { FINANCE_EVENTS } from './events'

/**
 * `bom_lines.consumption` is `numeric(12, 4)`; `cost_sheets.fx_rate_local_to_base` is
 * `numeric(12, 6)`. This file used to read both at two — see the call sites (plan 2.9).
 */
const CONSUMPTION_SCALE = 4
const FX_SCALE = 6
import {
  cashTimeline,
  expectedRealizationDate,
  FinanceError,
  orderProfitability,
  varianceWaterfall,
  type CashTimeline,
  type CostComponents,
  type ProfitabilityResult,
  type VarianceWaterfall,
} from './finance'
import {
  invoices,
  orderCostsActual,
  orderProfitabilityRows,
  payables,
  receivables,
} from './schema'
import { invoicePayload, payablePayload, payPayablePayload } from './zod'

/** ⚖ — every row here is money the factory is owed or owes. */
registerAuditedTables('invoices', 'receivables', 'payables', 'order_profitability')

/**
 * What money owed to the factory may do next (audit BE-M1).
 *
 * Both columns were set by an inline ternary with no declaration of a legal move, on ⚖
 * tables. The guards existed — realized and written-off were refused earlier in each
 * function — but as a condition somebody remembered to write, not as a rule the next
 * writer inherits.
 *
 * `part_realized` is reachable and currently unused: nothing produces a genuinely partial
 * credit against a part shipment yet (docs/STUBS.md). It stays in the machine because the
 * column has it and a machine that omitted it would refuse the day it lands.
 */
export const receivableMachine = defineStateMachine({
  field: 'status',
  initial: 'open',
  transitions: {
    open: ['part_realized', 'realized', 'written_off'],
    part_realized: ['realized', 'written_off'],
    // Terminal: a credit that has been realized is settled, and a correction is a new
    // document rather than a status moved back.
    realized: [],
    written_off: [],
  },
})

/** The same, for money the factory owes. */
export const payableMachine = defineStateMachine({
  field: 'status',
  initial: 'open',
  transitions: {
    open: ['part_paid', 'paid', 'cancelled'],
    part_paid: ['paid', 'cancelled'],
    paid: [],
    cancelled: [],
  },
})

export type ReceivableStatus = (typeof receivableMachine.states)[number]
export type PayableStatus = (typeof payableMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface FinancePolicy {
  /** Days to assume for a buyer with no realization history. Required — never zero. */
  defaultRealizationLagDays: number
  /** Actual margin below quoted by more than this raises the erosion alert. */
  marginErosionPct?: string
  /**
   * Loaded cost of one line-day, in the local currency. The CM allocation model v1 the brief
   * names: line-days × loaded rate. A number, stated by the company, not derived here —
   * deriving it would need a payroll allocation this module has no business owning.
   */
  loadedLineDayRate?: string
}

function wrapFinanceError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof FinanceError) {
      throw new AppError('validation_failed', 'finance.errors.uncomputable', {
        reason: error.message,
      })
    }
    throw error
  }
}

async function assertOwnOrder(ctx: AnyCtx, tx: TenantDb, orderId: string): Promise<void> {
  /*
   * Postgres runs foreign-key checks with RLS bypassed, so the FK alone does not enforce
   * tenancy (rule 2 — the app layer is the first wall).
   *
   * Which makes this the single best illustration of why wall 1 exists: the whole point of
   * the function is that the database's own integrity check cannot be trusted to be
   * tenant-aware, and until plan 1.3 the query PROVING ownership was itself relying on RLS.
   */
  const { orders } = await import('@/modules/orders/schema')
  const [order] = await tx.select({ id: orders.id }).from(orders).where(scoped(orders, ctx, eq(orders.id, orderId)))
  if (!order) throw notFound('finance.errors.order_not_found', { orderId })
}

// ─────────────────────────────────────────────────────────────────────────────
// Invoices and receivables
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Draft an invoice ⚖ and open its receivable.
 *
 * The receivable's `expectedAt` comes from the buyer's own realization-lag model, not from
 * payment terms: terms say 30 days and the bank takes 45, and a cash forecast built on the
 * terms is a forecast that is always early. The basis is stored so a wrong forecast can be
 * explained rather than argued about.
 */
export async function draftInvoice(
  ctx: RequestCtx,
  input: unknown,
  policy: FinancePolicy,
): Promise<{ invoiceId: string; receivableId: string; expectedAt: string }> {
  const payload = invoicePayload.parse(input)
  return withTenantTx(ctx, (tx) => draftInvoiceIn(ctx, tx, payload, policy))
}

/** Raise an invoice and its receivable inside the caller's transaction. */
export async function draftInvoiceIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof invoicePayload.parse>,
  policy: FinancePolicy,
): Promise<{ invoiceId: string; receivableId: string; expectedAt: string }> {
  {
    await assertOwnOrder(ctx, tx, payload.orderId)

    const [invoice] = await tx
      .insert(invoices)
      .values({
        companyId: ctx.companyId,
        orderId: payload.orderId,
        shipmentId: payload.shipmentId ?? null,
        number: payload.number,
        invoiceDate: payload.invoiceDate,
        value: payload.value,
        currency: payload.currency,
        documentId: payload.documentId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: invoices.id })

    if (!invoice) throw new Error('invoices insert returned nothing')

    // The buyer's own lag, from 2.1. Falls back to the stated company default — never to
    // zero, which would forecast the money arriving the day the invoice was raised.
    const lag = await resolveBuyerLag(ctx, tx, payload.orderId)
    const expectedAt = wrapFinanceError(() =>
      expectedRealizationDate({
        submittedAt: payload.invoiceDate,
        medianLagDays: lag.medianDays,
        fallbackDays: policy.defaultRealizationLagDays,
      }),
    )

    const [receivable] = await tx
      .insert(receivables)
      .values({
        companyId: ctx.companyId,
        invoiceId: invoice.id,
        amount: payload.value,
        currency: payload.currency,
        expectedAt,
        expectedBasis: {
          source: lag.medianDays === null ? 'company_default' : 'buyer_median_lag',
          medianLagDays: lag.medianDays,
          observations: lag.observations,
          fallbackDays: policy.defaultRealizationLagDays,
        },
      })
      .returning({ id: receivables.id })

    if (!receivable) throw new Error('receivables insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'invoices',
      targetId: invoice.id,
      after: {
        number: payload.number,
        value: payload.value,
        currency: payload.currency,
        orderId: payload.orderId,
        expectedAt,
      },
    })

    await emit(ctx, tx, {
      eventName: FINANCE_EVENTS.invoiceDrafted,
      payload: {
        invoiceId: invoice.id,
        receivableId: receivable.id,
        orderId: payload.orderId,
        value: payload.value,
        currency: payload.currency,
        expectedAt,
      },
      aggregateTable: 'invoices',
      aggregateId: invoice.id,
    })

    return { invoiceId: invoice.id, receivableId: receivable.id, expectedAt }
  }
}

/** The buyer's realization lag, read through 2.1's own surface (rule 11). */
async function resolveBuyerLag(
  ctx: AnyCtx,
  tx: TenantDb,
  orderId: string,
): Promise<{ medianDays: number | null; observations: number }> {
  const { orders } = await import('@/modules/orders/schema')
  const [order] = await tx
    .select({ buyerId: orders.buyerId })
    .from(orders)
    .where(scoped(orders, ctx, eq(orders.id, orderId)))

  if (!order?.buyerId) return { medianDays: null, observations: 0 }

  const { buyerRealizationLag } = await import('../commercial/service')
  return buyerRealizationLag(ctx, { buyerId: order.buyerId })
}

/**
 * Close a receivable against what the bank actually credited ⚖.
 *
 * Called from 2.1's `finance.realized` event. The shortfall is recorded, not absorbed: the
 * bank's deduction is a real cost that belongs in the commercial component of the order's
 * actual cost, and a receivable marked fully realized at the invoice value would lose it.
 */
export async function postRealizationToReceivable(
  // AnyCtx: the 2.1 → 11.1 consumer closes receivables as a system actor.
  ctx: AnyCtx,
  input: {
    invoiceId: string
    submissionId?: string
    realizedAmount: string
    realizedAt: string
  },
): Promise<{ receivableId: string; shortfall: string; status: string }> {
  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(receivables)
      .where(scoped(receivables, ctx, eq(receivables.invoiceId, input.invoiceId)))
      .for('update')

    if (!row) {
      throw notFound('finance.errors.receivable_not_found', { invoiceId: input.invoiceId })
    }
    if (row.status === 'realized' || row.status === 'written_off') {
      // A settled receivable that could be re-posted is a receivable that can be paid twice.
      throw conflict('finance.errors.receivable_already_settled', {
        receivableId: row.id,
        status: row.status,
      })
    }

    const shortfall = fromMinor(sumMinor(toMinor(row.amount), -toMinor(input.realizedAmount)))
    // Short by anything means the bank kept something; that is normal, and the receivable is
    // still closed. `part_realized` is for a genuinely partial credit against a part shipment.
    const status = toMinor(input.realizedAmount) <= 0n ? 'open' : 'realized'
    // `open → open` is a legal no-op the machine allows for; anything else is asserted.
    if (status !== row.status) receivableMachine.assert(row.status, status)

    await tx
      .update(receivables)
      .set({
        realizedAmount: input.realizedAmount,
        realizedAt: input.realizedAt,
        shortfall,
        submissionId: input.submissionId ?? row.submissionId,
        status,
        updatedAt: new Date(),
      })
      .where(scoped(receivables, ctx, eq(receivables.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'receivables',
      targetId: row.id,
      before: { status: row.status, realizedAmount: row.realizedAmount },
      after: { status, realizedAmount: input.realizedAmount, shortfall },
    })

    await emit(ctx, tx, {
      eventName: FINANCE_EVENTS.receivableRealized,
      payload: {
        receivableId: row.id,
        invoiceId: input.invoiceId,
        realizedAmount: input.realizedAmount,
        realizedAt: input.realizedAt,
        shortfall,
        currency: row.currency,
      },
      aggregateTable: 'receivables',
      aggregateId: row.id,
    })

    return { receivableId: row.id, shortfall, status }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Payables
// ─────────────────────────────────────────────────────────────────────────────

export async function openPayable(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ payableId: string }> {
  const payload = payablePayload.parse(input)
  return withTenantTx(ctx, (tx) => openPayableIn(ctx, tx, payload))
}

/**
 * Open a payable inside the caller's transaction.
 *
 * Extracted so the approve path can commit one without nesting transactions — the same
 * split the store and production modules use for their own commit handlers.
 */
export async function openPayableIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof payablePayload.parse>,
): Promise<{ payableId: string }> {
  {
    const [row] = await tx
      .insert(payables)
      .values({
        companyId: ctx.companyId,
        supplierPoId: payload.supplierPoId ?? null,
        grnId: payload.grnId ?? null,
        reference: payload.reference,
        amount: payload.amount,
        currency: payload.currency,
        dueAt: payload.dueAt,
        createdBy: isSystemCtx(ctx) ? null : ctx.userId,
      })
      .returning({ id: payables.id })

    if (!row) throw new Error('payables insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'payables',
      targetId: row.id,
      after: {
        reference: payload.reference,
        amount: payload.amount,
        currency: payload.currency,
        dueAt: payload.dueAt,
      },
    })

    await emit(ctx, tx, {
      eventName: FINANCE_EVENTS.payableOpened,
      payload: { payableId: row.id, ...payload },
      aggregateTable: 'payables',
      aggregateId: row.id,
    })

    return { payableId: row.id }
  }
}

export async function payPayable(
  ctx: RequestCtx,
  input: { payableId: string; paidAmount: string; paidAt: string },
): Promise<{ payableId: string; status: string }> {
  return withTenantTx(ctx, (tx) => payPayableIn(ctx, tx, input))
}

/** Record a payment inside the caller's transaction — see `openPayableIn`. */
export async function payPayableIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payableId: string; paidAmount: string; paidAt: string },
): Promise<{ payableId: string; status: string }> {
  {
    const [row] = await tx
      .select()
      .from(payables)
      .where(scoped(payables, ctx, eq(payables.id, input.payableId)))
      .for('update')

    if (!row) throw notFound('finance.errors.payable_not_found', { payableId: input.payableId })
    if (row.status === 'paid' || row.status === 'cancelled') {
      throw conflict('finance.errors.payable_already_settled', {
        payableId: row.id,
        status: row.status,
      })
    }

    const paid = sumMinor(toMinor(row.paidAmount ?? '0.00'), toMinor(input.paidAmount))
    const status = paid >= toMinor(row.amount) ? 'paid' : 'part_paid'
    if (status !== row.status) payableMachine.assert(row.status, status)

    await tx
      .update(payables)
      .set({
        paidAmount: fromMinor(paid),
        paidAt: input.paidAt,
        status,
        updatedAt: new Date(),
      })
      .where(scoped(payables, ctx, eq(payables.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'payables',
      targetId: row.id,
      before: { status: row.status, paidAmount: row.paidAmount },
      after: { status, paidAmount: fromMinor(paid) },
    })

    if (status === 'paid') {
      await emit(ctx, tx, {
        eventName: FINANCE_EVENTS.payablePaid,
        payload: { payableId: row.id, paidAmount: fromMinor(paid), paidAt: input.paidAt },
        aggregateTable: 'payables',
        aggregateId: row.id,
      })
    }

    return { payableId: row.id, status }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The cash timeline
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Eight weeks of cash in and out (brief: "cash timeline query (8-week in/out)").
 *
 * Reads only OPEN receivables and payables — a realized receivable is money already in the
 * bank, and counting it as arriving again is how a forecast promises the same cash twice.
 */
export async function cashTimelineFor(
  ctx: AnyCtx,
  input: { from: string; weeks?: number; currency: string; openingBalance?: string },
): Promise<CashTimeline> {
  return withTenantRead(ctx, async (tx) => {
    const [openReceivables, openPayables] = await Promise.all([
      tx
        .select({
          expectedAt: receivables.expectedAt,
          amount: receivables.amount,
          realizedAt: receivables.realizedAt,
          currency: receivables.currency,
        })
        .from(receivables)
        .where(scoped(receivables, ctx, inArray(receivables.status, ['open', 'part_realized']))),
      tx
        .select({
          dueAt: payables.dueAt,
          amount: payables.amount,
          paidAt: payables.paidAt,
          currency: payables.currency,
        })
        .from(payables)
        .where(scoped(payables, ctx, inArray(payables.status, ['open', 'part_paid']))),
    ])

    return wrapFinanceError(() =>
      cashTimeline({
        from: input.from,
        weeks: input.weeks ?? 8,
        currency: input.currency,
        openingBalance: input.openingBalance,
        receivables: openReceivables,
        payables: openPayables,
      }),
    )
  })
}

/** Raise the shortfall alert when the forecast dips below zero. */
export async function emitCashShortfall(
  // `AnyCtx`, not `RequestCtx`: this is a nightly job and the scheduler runs it as a system
  // actor. It reads nothing off the caller but the company — nobody authored these alerts.
  ctx: AnyCtx,
  input: { from: string; weeks?: number; currency: string; openingBalance?: string },
): Promise<{ raised: boolean; week: string | null }> {
  const timeline = await cashTimelineFor(ctx, input)
  if (!timeline.firstNegativeWeek) return { raised: false, week: null }

  return withTenantTx(ctx, async (tx) => {
    await emit(ctx, tx, {
      eventName: FINANCE_EVENTS.cashShortfallForecast,
      payload: {
        firstNegativeWeek: timeline.firstNegativeWeek,
        currency: timeline.currency,
        totalInflow: timeline.totalInflow,
        totalOutflow: timeline.totalOutflow,
        asOf: input.from,
      },
      aggregateTable: 'receivables',
      aggregateId: timeline.firstNegativeWeek!,
    })

    // The event alone reaches the `notify` queue, which has no worker — so it is a fact in
    // the outbox that nobody is told. Every other nightly alert in this product writes a
    // notification row directly, and the week cash first goes negative is the most
    // actionable figure finance produces: it is only useful while there is still time to
    // move a payment.
    await notify(ctx, {
      role: 'owner',
      kind: 'finance.cash.shortfall',
      severity: 'critical',
      titleKey: 'finance.notifications.cash_shortfall.title',
      params: {
        week: timeline.firstNegativeWeek,
        currency: timeline.currency,
        inflow: timeline.totalInflow,
        outflow: timeline.totalOutflow,
      },
      moduleId: 'finance',
      // The week in the key: a forecast that moves to a different week is a new warning,
      // while the same week re-forecast every night stays quiet.
      dedupeKey: `finance.cash_shortfall:${timeline.firstNegativeWeek}`,
    })

    return { raised: true, week: timeline.firstNegativeWeek }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The accrual and the P&L
// ─────────────────────────────────────────────────────────────────────────────

export interface AccrualResult {
  orderId: string
  components: CostComponents
  totalPerPiece: string
  pieces: number
  currency: string
  basis: Record<string, unknown>
}

/**
 * Accrue what the order actually cost ⚖ (brief entity `order_costs_actual`).
 *
 * Every component is read from the module that owns it — materials from 3.1's issues,
 * commercial from 2.1's bank charges, CM from the stated allocation model. Recomputed from
 * source every time rather than incremented: a drifting accrual is worse than a slow read for
 * the number an owner uses to decide whether to take that buyer's next order.
 *
 * A component whose source module cannot answer is recorded as ZERO with its basis marked
 * unavailable, never omitted. Omitting it would make the total look smaller and the margin
 * look better, which is the wrong direction to be wrong in.
 */
export async function accrueOrderCosts(
  // AnyCtx: the order-closed consumer accrues as a system actor — which is the module's
  // own philosophy made literal: nothing may HAND this module a cost figure, so the caller
  // with no hands is the right caller.
  ctx: AnyCtx,
  input: { orderId: string; pieces: number; currency: string },
  policy: FinancePolicy,
): Promise<AccrualResult> {
  if (!Number.isInteger(input.pieces) || input.pieces <= 0) {
    // A per-piece cost divided by nothing is not a cost.
    throw new AppError('validation_failed', 'finance.errors.pieces_required', {
      pieces: input.pieces,
    })
  }

  return withTenantTx(ctx, async (tx) => {
    await assertOwnOrder(ctx, tx, input.orderId)

    const components: CostComponents = {}
    const basis: Record<string, unknown> = {}

    // ── Materials: Σ store issues × price ──
    const { issueLines, issues } = await import('@/modules/store/schema')
    const materialRows = await tx
      .select({ qty: issueLines.qty, itemId: issueLines.itemId })
      .from(issueLines)
      .innerJoin(issues, eq(issueLines.issueId, issues.id))
      .where(scoped(issueLines, ctx, eq(issues.orderId, input.orderId)))

    // The issue records a quantity; the price it was received at lives on the GRN line. The
    // join is deliberately per-item rather than per-roll — a roll's price is its GRN line's.
    let materialMinor = 0n
    for (const row of materialRows) {
      const { grnLines } = await import('@/modules/store/schema')
      const [priced] = await tx
        .select({ unitPrice: grnLines.unitPrice })
        .from(grnLines)
        .where(scoped(grnLines, ctx, eq(grnLines.itemId, row.itemId)))
        .orderBy(desc(grnLines.createdAt))
        .limit(1)

      if (!priced?.unitPrice) continue
      materialMinor = sumMinor(materialMinor, mulScaled2HalfUp(toMinor(row.qty), toMinor(priced.unitPrice)))
    }

    components.materials = fromMinor(materialMinor / BigInt(input.pieces))
    basis.materials = {
      source: 'store.issue_lines × grn_lines.unit_price',
      issueLines: materialRows.length,
      totalValue: fromMinor(materialMinor),
      // Flagged when the store had no priced GRN lines to value the issues against.
      unavailable: materialRows.length > 0 && materialMinor === 0n,
    }

    // ── Commercial: bank charges + freight ──
    const { bankCharges, docSubmissions } = await import('../commercial/schema')
    const chargeRows = await tx
      .select({ amount: bankCharges.amount })
      .from(bankCharges)
      .leftJoin(docSubmissions, eq(bankCharges.submissionId, docSubmissions.id))
      .where(scoped(bankCharges, ctx, 
        sql`${docSubmissions.shipmentId} IS NOT NULL OR ${bankCharges.lcId} IS NOT NULL`,
      ))

    let commercialMinor = 0n
    for (const row of chargeRows) commercialMinor = sumMinor(commercialMinor, toMinor(row.amount))

    components.commercial = fromMinor(commercialMinor / BigInt(input.pieces))
    basis.commercial = {
      source: 'commercial.bank_charges',
      charges: chargeRows.length,
      totalValue: fromMinor(commercialMinor),
      // Freight is not included: it belongs to 3.2's landed cost and to the forwarder's
      // invoice, neither of which is attributable to an order yet. See docs/STUBS.md.
      excludes: ['freight'],
    }

    // ── CM: the allocation model v1 the brief names ──
    if (policy.loadedLineDayRate) {
      const { allocations } = await import('@/modules/planning/schema')
      const allocated = await tx
        .select({ plannedDaily: allocations.plannedDaily })
        .from(allocations)
        .where(scoped(allocations, ctx, eq(allocations.orderId, input.orderId)))

      const lineDays = allocated.reduce(
        (days, row) => days + Object.keys(row.plannedDaily).length,
        0,
      )

      components.cm = fromMinor(
        mulScaled2HalfUp(BigInt(lineDays) * 100n, toMinor(policy.loadedLineDayRate)) /
          BigInt(input.pieces),
      )
      basis.cm = {
        source: 'planning.allocations line-days × loaded rate (model v1)',
        lineDays,
        loadedLineDayRate: policy.loadedLineDayRate,
      }
    } else {
      // Recorded as zero with the reason, not omitted. Omitting it would make the total look
      // smaller and the margin look better — the wrong direction to be wrong in.
      components.cm = '0.00'
      basis.cm = { source: 'unavailable', reason: 'no loadedLineDayRate configured' }
    }

    let totalMinor = 0n
    for (const amount of Object.values(components)) totalMinor = sumMinor(totalMinor, toMinor(amount))
    const totalPerPiece = fromMinor(totalMinor)

    await tx
      .insert(orderCostsActual)
      .values({
        companyId: ctx.companyId,
        orderId: input.orderId,
        components,
        totalPerPiece,
        currency: input.currency,
        pieces: input.pieces,
        basis,
      })
      .onConflictDoUpdate({
        target: [orderCostsActual.orderId],
        set: {
          components,
          totalPerPiece,
          currency: input.currency,
          pieces: input.pieces,
          basis,
          computedAt: new Date(),
        },
      })

    await emit(ctx, tx, {
      eventName: FINANCE_EVENTS.orderCostsAccrued,
      payload: { orderId: input.orderId, components, totalPerPiece, currency: input.currency },
      aggregateTable: 'order_costs_actual',
      aggregateId: input.orderId,
    })

    return {
      orderId: input.orderId,
      components,
      totalPerPiece,
      pieces: input.pieces,
      currency: input.currency,
      basis,
    }
  })
}

export interface PnlResult {
  profitability: ProfitabilityResult
  waterfall: VarianceWaterfall
}

/**
 * Per-order P&L with the variance waterfall ⚖.
 *
 * The quote comes from 1.5's approved cost sheet — including its margin BASIS, which is read
 * rather than assumed. Margin on price and margin on cost differ by several percent, and a
 * variance between two figures computed on different bases is made entirely of arithmetic.
 */
export async function orderPnl(
  // AnyCtx for the same reason as `accrueOrderCosts` — the close consumer freezes the row.
  ctx: AnyCtx,
  input: { orderId: string; styleCode: string },
  policy: FinancePolicy,
): Promise<PnlResult> {
  return withTenantTx(ctx, async (tx) => {
    const [actual] = await tx
      .select()
      .from(orderCostsActual)
      .where(scoped(orderCostsActual, ctx, eq(orderCostsActual.orderId, input.orderId)))

    if (!actual) {
      throw notFound('finance.errors.no_accrual', { orderId: input.orderId })
    }

    // The approved sheet, through costing's own surface (rule 11).
    const { getApprovedSheet } = await import('../costing/service')
    const sheet = await getApprovedSheet(ctx, input.styleCode)

    const sections = sheet.sections as {
      marginBasis?: 'price' | 'cost'
      fabric?: unknown[]
      trims?: unknown[]
    }
    const marginBasis = sections.marginBasis
    if (marginBasis !== 'price' && marginBasis !== 'cost') {
      // Guessing would produce a variance made of arithmetic rather than of facts.
      throw new AppError('validation_failed', 'finance.errors.no_margin_basis', {
        styleCode: input.styleCode,
      })
    }

    const quoted: CostComponents = {
      materials: sheet.sections
        ? sumQuotedMaterials(sheet.sections as Record<string, unknown>)
        : '0.00',
      cm: sheet.cmLocalPerPiece && sheet.fxRateLocalToBase
        ? fromMinor(
            (toMinor(sheet.cmLocalPerPiece) *
                toMinorAtScale(sheet.fxRateLocalToBase, FX_SCALE, 'fx rate') +
                500_000n) /
                1_000_000n,
          )
        : '0.00',
      commercial: fromMinor(
        sumMinor(
          toMinor(sheet.totalCost),
          -toMinor(sumQuotedMaterials(sheet.sections as Record<string, unknown>)),
          -toMinor(
            sheet.cmLocalPerPiece && sheet.fxRateLocalToBase
              ? fromMinor(
                  (toMinor(sheet.cmLocalPerPiece) *
                toMinorAtScale(sheet.fxRateLocalToBase, FX_SCALE, 'fx rate') +
                500_000n) /
                1_000_000n,
                )
              : '0.00',
          ),
        ),
      ),
    }

    const profitability = wrapFinanceError(() =>
      orderProfitability({
        fobPrice: sheet.fobPrice,
        quotedMarginPct: sheet.marginPct,
        marginBasis,
        actual: actual.components,
      }),
    )

    const waterfall = wrapFinanceError(() => varianceWaterfall(quoted, actual.components))

    await tx
      .insert(orderProfitabilityRows)
      .values({
        companyId: ctx.companyId,
        orderId: input.orderId,
        fobPrice: sheet.fobPrice,
        currency: sheet.currency,
        quotedMarginPct: sheet.marginPct,
        actualMarginPct: profitability.actualMarginPct,
        marginBasis,
        variance: waterfall.steps,
      })
      .onConflictDoUpdate({
        target: [orderProfitabilityRows.orderId],
        set: {
          fobPrice: sheet.fobPrice,
          currency: sheet.currency,
          quotedMarginPct: sheet.marginPct,
          actualMarginPct: profitability.actualMarginPct,
          marginBasis,
          variance: waterfall.steps,
          computedAt: new Date(),
        },
      })

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'order_profitability',
      targetId: input.orderId,
      after: {
        quotedMarginPct: sheet.marginPct,
        actualMarginPct: profitability.actualMarginPct,
        marginBasis,
        totalVariance: waterfall.totalVariance,
      },
    })

    if (
      policy.marginErosionPct &&
      toMinor(profitability.marginVariancePct) < -toMinor(policy.marginErosionPct)
    ) {
      await emit(ctx, tx, {
        eventName: FINANCE_EVENTS.marginErosion,
        payload: {
          orderId: input.orderId,
          styleCode: input.styleCode,
          quotedMarginPct: sheet.marginPct,
          actualMarginPct: profitability.actualMarginPct,
          marginVariancePct: profitability.marginVariancePct,
          thresholdPct: policy.marginErosionPct,
          worstComponent: waterfall.steps
            .filter((step) => toMinor(step.variance) > 0n)
            .sort((a, b) => (toMinor(b.variance) > toMinor(a.variance) ? 1 : -1))[0]?.component,
        },
        aggregateTable: 'order_profitability',
        aggregateId: input.orderId,
      })
    }

    return { profitability, waterfall }
  })
}

/** Sum the fabric and trims lines of a cost sheet's stored sections. */
function sumQuotedMaterials(sections: Record<string, unknown>): string {
  let total = 0n
  for (const group of ['fabric', 'trims']) {
    const lines = sections[group]
    if (!Array.isArray(lines)) continue
    for (const line of lines) {
      const entry = line as { consumption?: string; ratePerUom?: string }
      if (!entry.consumption || !entry.ratePerUom) continue

      /*
       * Consumption at SCALE 4 — `bom_lines.consumption` is `numeric(12, 4)` (plan 2.9).
       * Read at two, a trims line of 0.0083 kg per piece became 0.00, so the PLANNED side of
       * this variance lost it while the ACTUAL side, which comes from real issues, counted
       * it in full. The waterfall then reported a material variance that was partly an
       * arithmetic artefact.
       *
       *   cost×10²  =  consumption×10⁴ · rate×10²  /  10⁴, half up
       */
      const consumption = toMinorAtScale(entry.consumption, CONSUMPTION_SCALE, 'consumption')
      total = sumMinor(total, (consumption * toMinor(entry.ratePerUom) + 5_000n) / 10_000n)
    }
  }
  return fromMinor(total)
}

/** Receivables never realized and past their expected date — the chase list. */
export async function overdueReceivables(
  ctx: AnyCtx,
  input: { asOf: string },
): Promise<(typeof receivables.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(receivables)
      .where(scoped(receivables, ctx, 
        and(
          isNull(receivables.realizedAt),
          inArray(receivables.status, ['open', 'part_realized']),
          sql`${receivables.expectedAt} < ${input.asOf}`,
        ),
      ))
      .orderBy(receivables.expectedAt),
  )
}

// Exact decimal helpers — money is numeric(14,2) and never a float.
function sumMinor(...values: readonly bigint[]): bigint {
  return values.reduce((carried, next) => carried + next, 0n)
}

/** Two 2-minor-digit values → one, rounded once at the end. */
/**
 * Two scale-2 minors multiplied back to scale 2, rounding HALF UP.
 *
 * Renamed from `mulMinor` (plan 2.9): three files defined that name and the three rounded
 * differently — half up here, truncating at scale 2 in rfq, truncating at scale 4 in
 * procurement. One name over three conventions invites the reader to assume they agree.
 *
 * Half up because this is money leaving the company: a truncating multiply on a payable pays
 * a supplier one paisa short every time, forever.
 */
function mulScaled2HalfUp(a: bigint, b: bigint): bigint {
  return (a * b + 50n) / 100n
}

export { conflict }

// ─────────────────────────────────────────────────────────────────────────────
// Commit handlers for the pending targets registered in `register.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commit an approved payable — either opening one, or recording a payment against it.
 *
 * One handler, dispatched on the operation, because `pending_changes` keys commit handlers
 * by TARGET TABLE and both of these land on `payables`.
 *
 * Payment is the one that matters. The canvas routes it through the approve inbox with the
 * owner as approver, and that is not ceremony: a payment is money leaving the factory, and
 * the person who negotiated the delivery should not also be the person who releases the
 * cash for it. The draft carries the amount and the date, so the owner is signing a number
 * rather than a supplier's name.
 */
export async function commitPayable(
  ctx: AnyCtx,
  tx: TenantDb,
  input: {
    operation: 'insert' | 'update' | 'delete'
    payload: Record<string, unknown>
  },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  if (input.operation === 'update') {
    const payload = payPayablePayload.parse(input.payload)
    const result = await payPayableIn(ctx, tx, payload)
    return {
      rowId: result.payableId,
      after: { paidAmount: payload.paidAmount, paidAt: payload.paidAt, status: result.status },
    }
  }

  const payload = payablePayload.parse(input.payload)
  const result = await openPayableIn(ctx, tx, payload)
  return { rowId: result.payableId, after: { ...payload } }
}

/** Commit an approved invoice, raising its receivable with it. */
export async function commitInvoice(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
  policy: FinancePolicy,
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const payload = invoicePayload.parse(input.payload)
  const result = await draftInvoiceIn(ctx, tx, payload, policy)
  return {
    rowId: result.invoiceId,
    after: {
      number: payload.number,
      value: payload.value,
      currency: payload.currency,
      receivableId: result.receivableId,
      expectedAt: result.expectedAt,
    },
  }
}
