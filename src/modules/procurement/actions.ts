'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { getPolicy } from '@/modules/settings/service'

import type { QuoteComparison } from './procurement'
import {
  applyReceipt,
  compareQuotesForItem,
  createPurchaseRequisition as createPurchaseRequisitionIn,
  createSupplier as createSupplierIn,
  issuePo,
  recordSupplierQuote,
  setPoStatus,
  type ProcurementPolicy,
  type ReceiptResult,
} from './service'

function refresh(prId?: string): void {
  revalidatePath('/procurement')
  if (prId) revalidatePath(`/procurement/${prId}`)
}

/**
 * Add a supplier (plan 5.5 — every root record must be creatable from a screen).
 *
 * `createSupplier` has existed since 3.2 with no action over it, so the only way a supplier
 * got into the system was the approve inbox committing a MARBIM draft — and with no provider
 * registered, that path does not run. A factory with no suppliers cannot raise a quote,
 * cannot compare one, and cannot issue a purchase order.
 *
 * `origin` is not a label. Local and import are different purchases: an import PO needs BTB
 * headroom and its fabric needs a UD, and the gates key off this field.
 */
export async function createSupplier(input: {
  code: string
  name: string
  type: 'fabric_mill' | 'trims' | 'embellishment' | 'subcontract' | 'yarn'
  origin: 'local' | 'import'
  paymentTerms?: string
  defaultCurrency?: string
  contacts?: { name: string; role?: string; email?: string; phone?: string }[]
}): Promise<{ supplierId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement')
  return surfaced(async () => {
    const result = await createSupplierIn(ctx, input)

    refresh()
    return result
  })
}

/**
 * Raise a purchase requisition.
 *
 * The other half of the same gap. A requisition with no lines buys nothing — the zod refuses
 * an empty list rather than filing a header somebody fills in later, because a PR sitting
 * open with nothing on it looks like procurement in progress.
 */
export async function createPurchaseRequisition(input: {
  prNo: string
  neededBy: string
  orderId?: string
  requisitionId?: string
  lines: { itemId: string; qty: string; unit: string }[]
}): Promise<{ purchaseRequisitionId: string; lineCount: number } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement', 'merchandiser')
  return surfaced(async () => {
    const result = await createPurchaseRequisitionIn(ctx, input)

    refresh()
    return result
  })
}

/**
 * Record a supplier's quote by hand (canvas P2).
 *
 * Lead time and MOQ are part of the quote, not decoration. A cheaper unit price with a
 * 45-day lead time on fabric needed in three weeks is not a cheaper quote — it is a quote
 * that cannot be used, and the comparison refuses to rank it as feasible.
 */
export async function recordQuote(input: {
  purchaseRequisitionId: string
  supplierId: string
  currency: string
  quotedOn: string
  /** The date the price stops standing. Absent when the paper did not say. */
  validUntil?: string
  /** The proforma itself, so an approver can check the figures against it. */
  documentId?: string
  lines: {
    itemId: string
    unitPrice: string
    leadTimeDays: number
    moq?: string
    freight?: string
    dutyPct?: string
  }[]
}): Promise<{ supplierQuoteId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement', 'commercial')
  return surfaced(async () => {
    const result = await recordSupplierQuote(ctx, input)
    refresh(input.purchaseRequisitionId)
    return result
  })
}

/**
 * Rank the quotes for one item on landed cost.
 *
 * Landed, never the unit price on the proforma: duty and freight are the difference between
 * a quote that looks cheapest and a quote that is. The comparison also separates infeasible
 * quotes rather than ranking them last — a quote that arrives after the fabric is needed is
 * not a worse option, it is not an option.
 *
 * The cheapest is highlighted and never pre-selected. Choosing a supplier weighs quality
 * history and a relationship the screen cannot see, so the act stays a person's.
 */
export async function compareQuotes(input: {
  purchaseRequisitionId: string
  itemId: string
  baseCurrency?: string
  /** `{ BDT: '0.0083' }` — one unit of the quoted currency in the base currency. */
  rates?: Record<string, string>
}): Promise<QuoteComparison | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement', 'commercial')
  return surfaced(() => compareQuotesForItem(ctx, input))
}

/**
 * Issue a purchase order.
 *
 * `GATES.btbHeadroom` fires here for import suppliers: a foreign mill is paid from a
 * back-to-back credit, and a PO the BTB cannot fund is a commitment with no money behind
 * it. The gate refuses and writes nothing — never a warning, because the supplier starts
 * weaving on the PO, not on the credit.
 *
 * Local trims in BDT need no BTB, and the gate does not ask for one.
 */
export async function issuePurchaseOrder(input: {
  supplierId: string
  purchaseRequisitionId?: string
  supplierQuoteId?: string
  poNumber: string
  currency: string
  btbLcId?: string
  expectedDeliveryDate?: string
  lines: { itemId: string; qty: string; unit: string; unitPrice: string }[]
}): Promise<{ supplierPoId: string; totalValue: string; currency: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement', 'commercial')
  return surfaced(async () => {
    const policy = await getPolicy<ProcurementPolicy>(ctx, 'procurement')

    const result = await issuePo(ctx, input, policy)

    refresh(input.purchaseRequisitionId)
    return result
  })
}

/** Move a PO along its own states — acknowledged, in transit, closed. */
export async function updatePoStatus(input: {
  supplierPoId: string
  status:
    | 'issued'
    | 'confirmed'
    | 'in_production'
    | 'shipped'
    | 'received_partial'
    | 'received'
    | 'cancelled'
}): Promise<void | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement', 'commercial')
  return surfaced(async () => {
    await setPoStatus(ctx, input)
    refresh()
  })
}

/**
 * Record what actually turned up against a PO line.
 *
 * This is the far end of a purchase order, and nothing called it. Every consequence hangs
 * off it: a line closes, the PO's status follows its lines, and `closedAt` against the PO's
 * expected date is the ONLY thing that makes a supplier's on-time percentage anything but
 * blank. A factory using this system saw every supplier scored `no closed receipts` forever,
 * because there was no screen through which a receipt could be recorded.
 *
 * The over-receipt tolerance comes from Settings, not from the caller — it is the allowance
 * the factory negotiated, and a caller-supplied one is an allowance somebody widens on the
 * day they need it to fit.
 */
export async function recordReceipt(input: {
  supplierPoLineId: string
  qty: string
  grnId?: string
}): Promise<ReceiptResult | ActionFailure> {
  const ctx = await requireRole(await headers(), 'procurement', 'store')
  return surfaced(async () => {
    const policy = await getPolicy<ProcurementPolicy>(ctx, 'procurement')

    const result = await applyReceipt(ctx, input, policy)

    refresh()
    revalidatePath('/procurement/receipts')
    revalidatePath('/procurement/scorecard')

    return result
  })
}
