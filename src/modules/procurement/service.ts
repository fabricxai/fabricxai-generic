/**
 * 3.2 Procurement & Suppliers — service layer ⚖
 *
 * The gate here is BTB headroom (rule 8, `GATES.btbHeadroom`): an import PO may not be
 * issued without a back-to-back LC that still has room under its master. A back-to-back
 * funds the fabric and trims for an order against the LC the buyer opened, and
 * over-opening BTBs against a master is how a factory ends up owing its suppliers more
 * than the buyer will ever pay it.
 *
 * The headroom answer comes from module 2.1 Commercial, which owns `btb_lcs` and `lcs`
 * (rule 11). This module reads the decision, never those tables.
 *
 * Supplier scores are computed from GRN and inspection records — the brief's "never
 * manual vibes". There is no operation in this file that writes a score by hand.
 */
import { and, desc, eq, gte, inArray, lt, lte, sql } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { assertGate, GATES } from '../core/gates'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { PROCUREMENT_EVENTS } from './events'
import {
  compareQuotes,
  matchReceipt,
  ProcurementError,
  comparablePrices,
  supplierScore,
  type ComparisonRequirement,
  type QuoteComparison,
  type QuoteForComparison,
} from './procurement'
import {
  purchaseRequisitionLines,
  purchaseRequisitions,
  suppliers,
  supplierPoLines,
  supplierPos,
  supplierQuoteLines,
  supplierQuotes,
  supplierScores,
} from './schema'
import {
  issuePoPayload,
  purchaseRequisitionPayload,
  supplierPayload,
  supplierQuotePayload,
  type IssuePoPayload,
} from './zod'

/** ⚖ — a supplier PO is the factory committing its own money. */
registerAuditedTables('supplier_pos', 'supplier_po_lines')

/**
 * The PO lifecycle. `cancelled` is reachable until goods start arriving: once anything is
 * received the PO is a partly-settled account, and cancelling it would orphan a receipt
 * the store has already booked into stock.
 */
export const supplierPoMachine = defineStateMachine({
  field: 'status',
  initial: 'issued',
  transitions: {
    issued: ['confirmed', 'cancelled'],
    confirmed: ['in_production', 'shipped', 'received_partial', 'received', 'cancelled'],
    in_production: ['shipped', 'received_partial', 'received', 'cancelled'],
    shipped: ['received_partial', 'received'],
    received_partial: ['received'],
    received: [],
    cancelled: [],
  },
})

export type SupplierPoStatus = (typeof supplierPoMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface ProcurementPolicy {
  /** BTB ceiling as a percentage of the master LC. Required for import POs. */
  btbLimitPct?: number
  /** Receiving more than ordered by more than this is reported, not absorbed. */
  overReceiptTolerancePct: string
}

function wrapProcurementError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof ProcurementError) {
      throw new AppError('validation_failed', 'procurement.errors.uncomputable', {
        reason: error.message,
      })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Suppliers, PRs, quotes
// ─────────────────────────────────────────────────────────────────────────────

export async function createSupplier(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ supplierId: string }> {
  return withTenantTx(ctx, (tx) => createSupplierIn(ctx, tx, input))
}

/**
 * Commit a supplier drafted through the approve inbox.
 *
 * `suppliers` was a pending target with no handler, so core wrote the row generically and
 * refused `paymentTerms` and `defaultCurrency` as invalid column identifiers — every
 * drafted supplier failed at the click.
 */
export async function commitSupplierDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    throw new AppError('validation_failed', 'procurement.errors.supplier_draft_insert_only', {
      operation: input.operation,
    })
  }
  const result = await createSupplierIn(ctx, tx, input.payload)
  return { rowId: result.supplierId, before: null, after: { supplierId: result.supplierId } }
}

async function createSupplierIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ supplierId: string }> {
  const payload = supplierPayload.parse(input)

  return (async () => {
    const [existing] = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(scoped(suppliers, ctx, eq(suppliers.code, payload.code)))

    // A typed conflict rather than the `suppliers_company_code_key` violation a generic
    // insert would have surfaced. Supplier codes collide for ordinary reasons — two people
    // adding the same mill — and the person should be told which code.
    if (existing) {
      throw conflict('procurement.errors.supplier_code_exists', { code: payload.code })
    }

    const [row] = await tx
      .insert(suppliers)
      .values({
        companyId: ctx.companyId,
        code: payload.code,
        name: payload.name,
        type: payload.type,
        origin: payload.origin,
        paymentTerms: payload.paymentTerms ?? null,
        contacts: payload.contacts,
        defaultCurrency: payload.defaultCurrency,
        createdBy: ctx.userId,
      })
      .returning({ id: suppliers.id })

    if (!row) throw new Error('suppliers insert returned nothing')
    return { supplierId: row.id }
  })()
}

/**
 * Raise a purchase requisition (brief: "PR from order material plan").
 *
 * `requisitionId` traces the purchase back to the store requisition that could not be met
 * from stock, and through it to the order. Without that link nobody can answer "why did we
 * buy this", which is the first question asked when the fabric arrives after shipment.
 */
export async function createPurchaseRequisition(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ purchaseRequisitionId: string; lineCount: number }> {
  return withTenantTx(ctx, (tx) => createPurchaseRequisitionIn(ctx, tx, input))
}

/**
 * Commit a PR drafted through the approve inbox.
 *
 * Core's generic write refused `orderId`, `requisitionId`, `prNo` and `neededBy` as invalid
 * identifiers — but the deeper reason for a handler is `purchase_requisition_lines`: a PR is
 * a header AND its lines, and a row write would have inserted the header alone. A PR with no
 * lines is one nobody can quote against, and it looks complete in the list.
 */
export async function commitPurchaseRequisitionDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    throw new AppError('validation_failed', 'procurement.errors.pr_draft_insert_only', {
      operation: input.operation,
    })
  }
  const result = await createPurchaseRequisitionIn(ctx, tx, input.payload)
  return {
    rowId: result.purchaseRequisitionId,
    before: null,
    after: { purchaseRequisitionId: result.purchaseRequisitionId, lineCount: result.lineCount },
  }
}

async function createPurchaseRequisitionIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ purchaseRequisitionId: string; lineCount: number }> {
  const payload = purchaseRequisitionPayload.parse(input)

  return (async () => {
    const [existingPr] = await tx
      .select({ id: purchaseRequisitions.id })
      .from(purchaseRequisitions)
      .where(scoped(purchaseRequisitions, ctx, eq(purchaseRequisitions.prNo, payload.prNo)))

    if (existingPr) {
      throw conflict('procurement.errors.pr_no_exists', { prNo: payload.prNo })
    }

    const [row] = await tx
      .insert(purchaseRequisitions)
      .values({
        companyId: ctx.companyId,
        orderId: payload.orderId ?? null,
        requisitionId: payload.requisitionId ?? null,
        prNo: payload.prNo,
        neededBy: payload.neededBy,
        createdBy: ctx.userId,
      })
      .returning({ id: purchaseRequisitions.id })

    if (!row) throw new Error('purchase_requisitions insert returned nothing')

    await tx.insert(purchaseRequisitionLines).values(
      payload.lines.map((line) => ({
        companyId: ctx.companyId,
        purchaseRequisitionId: row.id,
        itemId: line.itemId,
        qty: line.qty,
        unit: line.unit,
      })),
    )

    await emit(ctx, tx, {
      eventName: PROCUREMENT_EVENTS.prRaised,
      payload: { purchaseRequisitionId: row.id, prNo: payload.prNo, neededBy: payload.neededBy },
      aggregateTable: 'purchase_requisitions',
      aggregateId: row.id,
    })

    return { purchaseRequisitionId: row.id, lineCount: payload.lines.length }
  })()
}

export async function recordSupplierQuote(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ supplierQuoteId: string }> {
  return withTenantTx(ctx, (tx) => recordSupplierQuoteIn(ctx, tx, input))
}

/**
 * Commit a quote drafted through the approve inbox — the transcription this module's
 * registration singled out as the one MARBIM should draft.
 *
 * It could not commit. Core's generic write refused `purchaseRequisitionId`, `supplierId`,
 * `quotedOn` and `validUntil` as invalid identifiers, and would have written the quote
 * header without its `supplier_quote_lines` — leaving a quote with no prices, which
 * `compareQuotesForItem` reads as a supplier who quoted nothing rather than one whose
 * lines were dropped.
 *
 * The PR existence check and the `open → quoted` transition come with it.
 */
export async function commitSupplierQuoteDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    // A revised quote is a new quote. Rewriting one in place would change the comparison a
    // PO was already awarded on, with nothing recording that it moved.
    throw new AppError('validation_failed', 'procurement.errors.quote_draft_insert_only', {
      operation: input.operation,
    })
  }
  const result = await recordSupplierQuoteIn(ctx, tx, input.payload)
  return {
    rowId: result.supplierQuoteId,
    before: null,
    after: { supplierQuoteId: result.supplierQuoteId },
  }
}

async function recordSupplierQuoteIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ supplierQuoteId: string }> {
  const payload = supplierQuotePayload.parse(input)

  return (async () => {
    const [pr] = await tx
      .select()
      .from(purchaseRequisitions)
      .where(scoped(purchaseRequisitions, ctx, eq(purchaseRequisitions.id, payload.purchaseRequisitionId)))

    if (!pr) {
      throw notFound('procurement.errors.pr_not_found', {
        purchaseRequisitionId: payload.purchaseRequisitionId,
      })
    }

    const [row] = await tx
      .insert(supplierQuotes)
      .values({
        companyId: ctx.companyId,
        purchaseRequisitionId: payload.purchaseRequisitionId,
        supplierId: payload.supplierId,
        currency: payload.currency,
        quotedOn: payload.quotedOn,
        validUntil: payload.validUntil ?? null,
        documentId: payload.documentId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: supplierQuotes.id })

    if (!row) throw new Error('supplier_quotes insert returned nothing')

    await tx.insert(supplierQuoteLines).values(
      payload.lines.map((line) => ({
        companyId: ctx.companyId,
        supplierQuoteId: row.id,
        itemId: line.itemId,
        unitPrice: line.unitPrice,
        leadTimeDays: line.leadTimeDays,
        // Absent stays absent all the way to the column (nullable since plan 5.x fix F3).
        moq: line.moq ?? null,
        freight: line.freight ?? null,
        dutyPct: line.dutyPct ?? null,
      })),
    )

    if (pr.status === 'open') {
      await tx
        .update(purchaseRequisitions)
        .set({ status: 'quoted', updatedAt: new Date() })
        .where(scoped(purchaseRequisitions, ctx, eq(purchaseRequisitions.id, pr.id)))
    }

    await emit(ctx, tx, {
      eventName: PROCUREMENT_EVENTS.quoteReceived,
      payload: {
        supplierQuoteId: row.id,
        purchaseRequisitionId: pr.id,
        supplierId: payload.supplierId,
      },
      aggregateTable: 'supplier_quotes',
      aggregateId: row.id,
    })

    return { supplierQuoteId: row.id }
  })()
}

/**
 * Compare every quote on a PR for one item (brief: "quote comparison").
 *
 * Ranked on LANDED cost — price × the quantity actually charged, plus duty and freight —
 * and quotes that cannot arrive by the PR's needed-by date are excluded rather than ranked
 * last. A late quote is not a worse option; leaving it in the list is how somebody picks
 * it because the price column looked good.
 */
export async function compareQuotesForItem(
  ctx: AnyCtx,
  input: {
    purchaseRequisitionId: string
    itemId: string
    baseCurrency?: string
    rates?: Record<string, string>
  },
): Promise<QuoteComparison> {
  return withTenantRead(ctx, async (tx) => {
    const [pr] = await tx
      .select()
      .from(purchaseRequisitions)
      .where(scoped(purchaseRequisitions, ctx, eq(purchaseRequisitions.id, input.purchaseRequisitionId)))

    if (!pr) {
      throw notFound('procurement.errors.pr_not_found', {
        purchaseRequisitionId: input.purchaseRequisitionId,
      })
    }

    const [prLine] = await tx
      .select({ qty: purchaseRequisitionLines.qty, unit: purchaseRequisitionLines.unit })
      .from(purchaseRequisitionLines)
      .where(scoped(purchaseRequisitionLines, ctx, 
        and(
          eq(purchaseRequisitionLines.purchaseRequisitionId, pr.id),
          eq(purchaseRequisitionLines.itemId, input.itemId),
        ),
      ))

    if (!prLine) {
      throw notFound('procurement.errors.pr_line_not_found', {
        purchaseRequisitionId: pr.id,
        itemId: input.itemId,
      })
    }

    const rows = await tx
      .select({
        quoteId: supplierQuotes.id,
        supplierId: supplierQuotes.supplierId,
        currency: supplierQuotes.currency,
        quotedOn: supplierQuotes.quotedOn,
        unitPrice: supplierQuoteLines.unitPrice,
        leadTimeDays: supplierQuoteLines.leadTimeDays,
        moq: supplierQuoteLines.moq,
        freight: supplierQuoteLines.freight,
        dutyPct: supplierQuoteLines.dutyPct,
      })
      .from(supplierQuoteLines)
      .innerJoin(supplierQuotes, eq(supplierQuoteLines.supplierQuoteId, supplierQuotes.id))
      .where(scoped(supplierQuoteLines, ctx, 
        and(
          eq(supplierQuotes.purchaseRequisitionId, pr.id),
          eq(supplierQuoteLines.itemId, input.itemId),
        ),
      ))

    if (rows.length === 0) {
      throw notFound('procurement.errors.no_quotes', {
        purchaseRequisitionId: pr.id,
        itemId: input.itemId,
      })
    }

    const quotes: QuoteForComparison[] = rows.map((row) => ({
      quoteId: row.quoteId,
      supplierId: row.supplierId,
      unitPrice: row.unitPrice,
      currency: row.currency,
      leadTimeDays: row.leadTimeDays,
      moq: row.moq,
      freight: row.freight,
      dutyPct: row.dutyPct,
    }))

    // Lead time is counted from the LATEST quote date in the set. Counting each from its
    // own date would let a quote received three weeks ago look like it still arrives on
    // time, because its clock started before the decision is being made.
    const quotedOn = rows.map((row) => row.quotedOn).sort().at(-1)!

    const requirement: ComparisonRequirement = {
      qty: prLine.qty,
      unit: prLine.unit,
      neededBy: pr.neededBy,
      quotedOn,
      baseCurrency: input.baseCurrency,
      rates: input.rates,
    }

    return wrapProcurementError(() => compareQuotes(quotes, requirement))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Issuing a PO — the BTB gate
// ─────────────────────────────────────────────────────────────────────────────

export interface IssuePoResult {
  supplierPoId: string
  totalValue: string
  currency: string
}

/**
 * Issue a purchase order ⚖ (brief: "import PO requires btb_lc link before issue").
 *
 * The gate is on the SUPPLIER's origin, not on the currency. A local mill invoicing in USD
 * is still a local purchase; an import is an import even when it prices in taka. Getting
 * that backwards would gate the wrong half of the supplier book.
 */
export async function issuePo(
  ctx: RequestCtx,
  input: unknown,
  policy: ProcurementPolicy,
): Promise<IssuePoResult> {
  const payload: IssuePoPayload = issuePoPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [supplier] = await tx
      .select()
      .from(suppliers)
      .where(scoped(suppliers, ctx, eq(suppliers.id, payload.supplierId)))

    if (!supplier) {
      throw notFound('procurement.errors.supplier_not_found', { supplierId: payload.supplierId })
    }
    if (!supplier.isActive) {
      throw conflict('procurement.errors.supplier_inactive', { supplierId: supplier.id })
    }

    /*
     * The order's value, computed BEFORE the gate rather than after it.
     *
     * This sat below the gate, which meant the one figure the gate most needed did not exist
     * when the gate ran — and so the gate could only ever check that a credit was attached,
     * never that it covered anything. PO-2815-F (USD 123,190) was issued against a credit
     * worth USD 34,500 and saved without a word.
     */
    const totalValue = payload.lines.reduce(
      (sum, line) => sum + mulScaled4Truncating(toMinor(line.qty), toMinor(line.unitPrice)),
      0n,
    )

    if (supplier.origin === 'import') {
      if (!payload.btbLcId) {
        throw new AppError('gate_blocked', 'gates.btb_headroom.no_btb', {
          gate: GATES.btbHeadroom,
          supplierId: supplier.id,
        })
      }
      if (policy.btbLimitPct === undefined) {
        // Checking headroom against an unstated ceiling would produce a pass that means
        // nothing. Refuse rather than invent a limit.
        throw new AppError('validation_failed', 'procurement.errors.no_btb_limit', {})
      }

      // Inside THIS transaction, with the master credit locked. The wrapper opens its own
      // read, which meant a second connection held open while this transaction was live —
      // the deadlock shape `saveBreakdownIn` documents — and a headroom answer already
      // stale by the time the PO was written. `openBtb` locks the master on its own path;
      // now both callers deciding against one ceiling queue instead of racing.
      const { btbCreditIn, checkBtbHeadroomIn } = await import('../commercial/service')
      assertGate(
        GATES.btbHeadroom,
        await checkBtbHeadroomIn(ctx, tx, {
          btbLcId: payload.btbLcId,
          limitPct: policy.btbLimitPct,
          lock: true,
        }),
      )

      /*
       * And now the question the gate above never asked: does this credit fund THIS order?
       *
       * Headroom is about the credits fitting under their master. It passes happily while a
       * purchase order four times the size of its credit is written against it — the factory
       * committed to a mill with nothing behind the difference, discovered at the bank, months
       * later, when the mill presents documents. The supplier has already woven the fabric by
       * then; the PO is what they wove it on.
       *
       * Counted against every other PO already riding the same credit, because two orders
       * that each fit alone can still overdraw it together.
       */
      const btb = await btbCreditIn(ctx, tx, payload.btbLcId)
      if (!btb) {
        throw new AppError('gate_blocked', 'gates.btb_headroom.btb_not_found', {
          gate: GATES.btbHeadroom,
          btbLcId: payload.btbLcId,
        })
      }

      if (btb.currency !== payload.currency) {
        // Netting an order against a credit in another currency needs a rate nobody has
        // stated. Same refusal the headroom check makes for a BTB against its master.
        throw new AppError('gate_blocked', 'gates.btb_headroom.po_currency_mismatch', {
          gate: GATES.btbHeadroom,
          btbNumber: btb.number,
          btbCurrency: btb.currency,
          poCurrency: payload.currency,
        })
      }

      const committedRows = await tx
        .select({ value: supplierPos.totalValue })
        .from(supplierPos)
        .where(
          scoped(
            supplierPos,
            ctx,
            and(eq(supplierPos.btbLcId, payload.btbLcId), sql`${supplierPos.status} <> 'cancelled'`),
          ),
        )

      const committed = sumMinor(...committedRows.map((row) => toMinor(row.value)))
      const credit = toMinor(btb.value)
      const wanted = sumMinor(committed, totalValue)

      if (wanted > credit) {
        throw new AppError('gate_blocked', 'gates.btb_headroom.po_exceeds_btb', {
          gate: GATES.btbHeadroom,
          btbNumber: btb.number,
          creditValue: btb.value,
          committed: fromMinor(committed),
          poValue: fromMinor(totalValue),
          shortfall: fromMinor(sumMinor(wanted, -credit)),
          currency: btb.currency,
        })
      }
    }

    const [row] = await tx
      .insert(supplierPos)
      .values({
        companyId: ctx.companyId,
        supplierId: payload.supplierId,
        purchaseRequisitionId: payload.purchaseRequisitionId ?? null,
        supplierQuoteId: payload.supplierQuoteId ?? null,
        poNumber: payload.poNumber,
        currency: payload.currency,
        totalValue: fromMinor(totalValue),
        btbLcId: payload.btbLcId ?? null,
        expectedDeliveryDate: payload.expectedDeliveryDate ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: supplierPos.id })

    if (!row) throw new Error('supplier_pos insert returned nothing')

    await tx.insert(supplierPoLines).values(
      payload.lines.map((line) => ({
        companyId: ctx.companyId,
        supplierPoId: row.id,
        itemId: line.itemId,
        qty: line.qty,
        unit: line.unit,
        unitPrice: line.unitPrice,
      })),
    )

    if (payload.purchaseRequisitionId) {
      await tx
        .update(purchaseRequisitions)
        .set({ status: 'ordered', updatedAt: new Date() })
        .where(scoped(purchaseRequisitions, ctx, eq(purchaseRequisitions.id, payload.purchaseRequisitionId)))
    }

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'supplier_pos',
      targetId: row.id,
      after: {
        poNumber: payload.poNumber,
        supplierId: payload.supplierId,
        totalValue: fromMinor(totalValue),
        currency: payload.currency,
        btbLcId: payload.btbLcId ?? null,
      },
    })

    await emit(ctx, tx, {
      eventName: PROCUREMENT_EVENTS.poIssued,
      payload: {
        supplierPoId: row.id,
        poNumber: payload.poNumber,
        supplierId: payload.supplierId,
        totalValue: fromMinor(totalValue),
        currency: payload.currency,
      },
      aggregateTable: 'supplier_pos',
      aggregateId: row.id,
    })

    return { supplierPoId: row.id, totalValue: fromMinor(totalValue), currency: payload.currency }
  })
}

export async function setPoStatus(
  ctx: RequestCtx,
  input: { supplierPoId: string; status: SupplierPoStatus },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [po] = await tx
      .select()
      .from(supplierPos)
      .where(scoped(supplierPos, ctx, eq(supplierPos.id, input.supplierPoId)))
      .for('update')

    if (!po) {
      throw notFound('procurement.errors.po_not_found', { supplierPoId: input.supplierPoId })
    }

    supplierPoMachine.assert(po.status as SupplierPoStatus, input.status)

    await tx
      .update(supplierPos)
      .set({ status: input.status, updatedAt: new Date() })
      .where(scoped(supplierPos, ctx, eq(supplierPos.id, po.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'supplier_pos',
      targetId: po.id,
      before: { status: po.status },
      after: { status: input.status },
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// PO ↔ GRN matching
// ─────────────────────────────────────────────────────────────────────────────

export interface ReceiptResult {
  supplierPoLineId: string
  receivedQty: string
  outstandingQty: string
  overReceiptQty: string
  withinTolerance: boolean
  closed: boolean
  poStatus: SupplierPoStatus
}

/**
 * Apply a receipt to a PO line (brief: "PO↔GRN line matching closes lines").
 *
 * The PO's own status follows its lines rather than being set by hand: a PO is `received`
 * when every line is, `received_partial` when some are. A status somebody types drifts from
 * the lines within a week, and it is the status the overdue alert reads.
 */
export async function applyReceipt(
  ctx: RequestCtx,
  input: { supplierPoLineId: string; qty: string; grnId?: string },
  policy: ProcurementPolicy,
): Promise<ReceiptResult> {
  return withTenantTx(ctx, async (tx) => {
    const [line] = await tx
      .select()
      .from(supplierPoLines)
      .where(scoped(supplierPoLines, ctx, eq(supplierPoLines.id, input.supplierPoLineId)))
      .for('update')

    if (!line) {
      throw notFound('procurement.errors.po_line_not_found', {
        supplierPoLineId: input.supplierPoLineId,
      })
    }

    const match = wrapProcurementError(() =>
      matchReceipt(
        {
          orderedQty: line.qty,
          receivedQty: line.receivedQty,
          closed: line.status === 'received' || line.status === 'short_closed',
        },
        { qty: input.qty },
        { overReceiptTolerancePct: policy.overReceiptTolerancePct },
      ),
    )

    await tx
      .update(supplierPoLines)
      .set({
        receivedQty: match.receivedQty,
        status: match.closed ? 'received' : 'received_partial',
        closedAt: match.closed ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(scoped(supplierPoLines, ctx, eq(supplierPoLines.id, line.id)))

    // The PO's status is derived from its lines, in this transaction, from the rows as
    // they now are.
    const siblings = await tx
      .select({ status: supplierPoLines.status })
      .from(supplierPoLines)
      .where(scoped(supplierPoLines, ctx, eq(supplierPoLines.supplierPoId, line.supplierPoId)))

    const allClosed = siblings.every((s) => s.status === 'received' || s.status === 'short_closed')
    const anyReceived = siblings.some((s) => s.status !== 'open')
    const nextStatus: SupplierPoStatus = allClosed
      ? 'received'
      : anyReceived
        ? 'received_partial'
        : 'issued'

    const [po] = await tx
      .select()
      .from(supplierPos)
      .where(scoped(supplierPos, ctx, eq(supplierPos.id, line.supplierPoId)))
      .for('update')

    if (po && po.status !== nextStatus && po.status !== 'cancelled') {
      await tx
        .update(supplierPos)
        .set({ status: nextStatus, updatedAt: new Date() })
        .where(scoped(supplierPos, ctx, eq(supplierPos.id, po.id)))
    }

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'supplier_po_lines',
      targetId: line.id,
      before: { receivedQty: line.receivedQty, status: line.status },
      after: {
        receivedQty: match.receivedQty,
        status: match.closed ? 'received' : 'received_partial',
        grnId: input.grnId ?? null,
      },
    })

    if (match.closed) {
      await emit(ctx, tx, {
        eventName: PROCUREMENT_EVENTS.poLineClosed,
        payload: { supplierPoLineId: line.id, supplierPoId: line.supplierPoId },
        aggregateTable: 'supplier_po_lines',
        aggregateId: line.id,
      })
    }

    if (!match.withinTolerance) {
      // Past the allowance somebody is paying for material nobody ordered.
      await emit(ctx, tx, {
        eventName: PROCUREMENT_EVENTS.overReceipt,
        payload: {
          supplierPoLineId: line.id,
          supplierPoId: line.supplierPoId,
          orderedQty: line.qty,
          receivedQty: match.receivedQty,
          overReceiptQty: match.overReceiptQty,
          tolerancePct: policy.overReceiptTolerancePct,
        },
        aggregateTable: 'supplier_po_lines',
        aggregateId: line.id,
      })
    }

    return {
      supplierPoLineId: line.id,
      receivedQty: match.receivedQty,
      outstandingQty: match.outstandingQty,
      overReceiptQty: match.overReceiptQty,
      withinTolerance: match.withinTolerance,
      closed: match.closed,
      poStatus: nextStatus,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Scores and alerts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute one month's supplier scores from the record (brief job: "never manual vibes").
 *
 * On-time is measured against the PO's expected delivery date; rejects come from the GRN
 * inspection status recorded by 3.1. Nothing in this function accepts a number from a
 * caller, which is the whole point.
 */
export async function computeSupplierScores(
  // `AnyCtx`, because the nightly job runs this and the job has no user. Nothing here
  // reads `ctx.userId` — a score is derived from receipts and quotes, not authored.
  ctx: AnyCtx,
  input: { period: string },
): Promise<{ scored: number }> {
  const periodStart = input.period
  const periodEnd = addMonth(periodStart)

  return withTenantTx(ctx, async (tx) => {
    const supplierRows = await tx
      .select({ id: suppliers.id })
      .from(suppliers)
      .where(scoped(suppliers, ctx, eq(suppliers.isActive, true)))

    if (supplierRows.length === 0) return { scored: 0 }

    const pos = await tx
      .select({
        id: supplierPos.id,
        supplierId: supplierPos.supplierId,
        expectedDeliveryDate: supplierPos.expectedDeliveryDate,
      })
      .from(supplierPos)
      .where(scoped(supplierPos, ctx, 
        and(
          gte(supplierPos.createdAt, new Date(`${periodStart}T00:00:00Z`)),
          lt(supplierPos.createdAt, new Date(`${periodEnd}T00:00:00Z`)),
          inArray(
            supplierPos.supplierId,
            supplierRows.map((s) => s.id),
          ),
        ),
      ))

    const linesByPo = new Map<string, { receivedQty: string; closedAt: Date | null }[]>()
    if (pos.length > 0) {
      const lineRows = await tx
        .select({
          supplierPoId: supplierPoLines.supplierPoId,
          receivedQty: supplierPoLines.receivedQty,
          closedAt: supplierPoLines.closedAt,
        })
        .from(supplierPoLines)
        .where(scoped(supplierPoLines, ctx, 
          inArray(
            supplierPoLines.supplierPoId,
            pos.map((p) => p.id),
          ),
        ))

      for (const row of lineRows) {
        linesByPo.set(row.supplierPoId, [...(linesByPo.get(row.supplierPoId) ?? []), row])
      }
    }

    const quotesBySupplier = await tx
      .select({ supplierId: supplierQuotes.supplierId, id: supplierQuotes.id })
      .from(supplierQuotes)
      .where(scoped(supplierQuotes, ctx, 
        and(
          gte(supplierQuotes.quotedOn, periodStart),
          lt(supplierQuotes.quotedOn, periodEnd),
        ),
      ))

    /**
     * The price index, compared like with like.
     *
     * This used to be passed as `null` for every supplier, so the column was permanently
     * blank — a metric the schema carried, the pure function computed and nothing ever fed.
     *
     * The comparison only means anything ITEM BY ITEM: averaging a supplier's fabric price
     * against the field's button prices produces a number that moves with what they happened
     * to be asked to quote. So the basket is the set of items where this supplier quoted AND
     * somebody else did too, and both sides of the ratio are summed over exactly that set.
     *
     * Items only one supplier quoted are excluded rather than treated as their own baseline,
     * which would score every sole quote at exactly 100 and hide the fact that nobody
     * competed for it.
     */
    const quoteLineRows =
      quotesBySupplier.length > 0
        ? await tx
            .select({
              supplierQuoteId: supplierQuoteLines.supplierQuoteId,
              itemId: supplierQuoteLines.itemId,
              unitPrice: supplierQuoteLines.unitPrice,
              currency: supplierQuotes.currency,
            })
            .from(supplierQuoteLines)
            .innerJoin(supplierQuotes, eq(supplierQuotes.id, supplierQuoteLines.supplierQuoteId))
            .where(scoped(supplierQuoteLines, ctx, 
              inArray(
                supplierQuoteLines.supplierQuoteId,
                quotesBySupplier.map((q) => q.id),
              ),
            ))
        : []

    const supplierOfQuote = new Map(quotesBySupplier.map((q) => [q.id, q.supplierId]))

    /**
     * `item|currency` → supplier → the prices they quoted this period.
     *
     * Keyed on the currency as well as the item, so a BDT quote is never averaged against a
     * USD one. See `comparablePrices` for what that produced when it was not.
     */
    const pricesByItem = new Map<string, Map<string, string[]>>()
    for (const line of quoteLineRows) {
      const supplierId = supplierOfQuote.get(line.supplierQuoteId)
      if (!supplierId) continue
      const key = `${line.itemId}|${line.currency}`
      const bySupplier = pricesByItem.get(key) ?? new Map<string, string[]>()
      bySupplier.set(supplierId, [...(bySupplier.get(supplierId) ?? []), line.unitPrice])
      pricesByItem.set(key, bySupplier)
    }

    let scored = 0
    for (const supplier of supplierRows) {
      const theirPos = pos.filter((p) => p.supplierId === supplier.id)
      const receipts = theirPos.flatMap((po) =>
        (linesByPo.get(po.id) ?? [])
          .filter((line) => line.closedAt !== null)
          .map((line) => ({
            // Null when the PO promised no date — that receipt is evidence a delivery
            // happened, and no evidence at all about whether it was on time.
            onTime:
              po.expectedDeliveryDate === null
                ? null
                : line.closedAt!.toISOString().slice(0, 10) <= po.expectedDeliveryDate,
            // Null, NOT '0'. Rejects are found by quality's inspections and recorded
            // against rolls, not against a PO line — the chain roll → GRN → PO does not
            // exist yet (docs/STUBS.md). Passing '0' told the scorecard every supplier
            // had a spotless record; passing null makes it say the rate is not measured,
            // which is the truth.
            rejectedQty: null,
            receivedQty: line.receivedQty,
          })),
      )

      const quotesReturned = quotesBySupplier.filter((q) => q.supplierId === supplier.id).length

      // Their prices against the field's, over the items both quoted. The arithmetic is
      // in `procurement.ts` where the money helpers and their tests live; this only
      // gathers the rows.
      const prices = comparablePrices(pricesByItem, supplier.id)

      const score = wrapProcurementError(() =>
        supplierScore({
          receipts,
          quotesRequested: quotesReturned,
          quotesReturned,
          avgUnitPrice: prices?.avgUnitPrice ?? null,
          basketAvgUnitPrice: prices?.basketAvgUnitPrice ?? null,
        }),
      )

      await tx
        .insert(supplierScores)
        .values({
          companyId: ctx.companyId,
          supplierId: supplier.id,
          period: periodStart,
          onTimePct: score.onTimePct,
          qualityRejectPct: score.qualityRejectPct,
          priceIndex: score.priceIndex,
          responsivenessPct: score.responsivenessPct,
          observations: score.observations,
        })
        .onConflictDoUpdate({
          target: [supplierScores.supplierId, supplierScores.period],
          set: {
            onTimePct: score.onTimePct,
            qualityRejectPct: score.qualityRejectPct,
            priceIndex: score.priceIndex,
            responsivenessPct: score.responsivenessPct,
            observations: score.observations,
            computedAt: new Date(),
          },
        })

      scored += 1
    }

    await emit(ctx, tx, {
      eventName: PROCUREMENT_EVENTS.scoresComputed,
      payload: { period: periodStart, scored },
      aggregateTable: 'supplier_scores',
      aggregateId: periodStart,
    })

    return { scored }
  })
}

/** POs past their expected delivery date with anything still outstanding. */
export async function overduePos(
  ctx: AnyCtx,
  input: { asOf: string },
): Promise<{ supplierPoId: string; poNumber: string; expectedDeliveryDate: string }[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        supplierPoId: supplierPos.id,
        poNumber: supplierPos.poNumber,
        expectedDeliveryDate: supplierPos.expectedDeliveryDate,
      })
      .from(supplierPos)
      .where(scoped(supplierPos, ctx, 
        and(
          lte(supplierPos.expectedDeliveryDate, input.asOf),
          sql`${supplierPos.status} not in ('received', 'cancelled')`,
        ),
      ))
      .orderBy(supplierPos.expectedDeliveryDate)

    return rows.map((row) => ({
      supplierPoId: row.supplierPoId,
      poNumber: row.poNumber,
      expectedDeliveryDate: row.expectedDeliveryDate!,
    }))
  })
}

/** The latest score on record for each supplier — the comparison screen's left column. */
export async function latestScores(
  ctx: AnyCtx,
): Promise<(typeof supplierScores.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx.select().from(supplierScores).orderBy(desc(supplierScores.period)),
  )
}

// Exact decimal helpers — money and quantity are numeric and never floats.
function toMinor(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(4, '0').slice(0, 4))
}

/** Two 4-minor-digit values → one 2-minor-digit money amount, rounded once. */
/**
 * Two scale-2 minors multiplied at scale 4, truncating.
 *
 * Renamed from `mulMinor` (plan 2.9). Scale 4 because a unit price times a quantity carries
 * four minor digits before it is rounded to a currency — see `finance/service.ts` for why
 * three functions sharing this name was the actual finding.
 */
function mulScaled4Truncating(a: bigint, b: bigint): bigint {
  return (a * b) / 10_000n
}

/**
 * Sum scaled integers. Named, not inline, for the reason `procurement.ts` gives at its own
 * copy: `no-float-money` reads variable NAMES, and `committed + totalValue` looks exactly
 * like the float arithmetic the rule exists to stop. Routing it through here says "these are
 * scaled integers" where a reader would otherwise have to infer it.
 */
const sumMinor = (...values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n)

function fromMinor(minor: bigint): string {
  const rounded = (minor + 50n) / 100n
  const digits = rounded.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

function addMonth(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCMonth(parsed.getUTCMonth() + 1)
  return parsed.toISOString().slice(0, 10)
}

export { conflict, type TenantDb }
