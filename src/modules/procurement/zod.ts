/**
 * Payloads for 3.2, including every `pending_changes` payload.
 *
 * Every money field here is a string and every price carries a currency. A quote line
 * with a price and no currency is the input to an addition that will happen somewhere
 * downstream and be wrong.
 */
import { z } from 'zod'

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const currency = z.string().length(3)
export const money = (scale = 2) =>
  z.string().regex(new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`), 'expected a money amount')
export const qty = z.string().regex(/^\d{1,12}(\.\d{1,2})?$/, 'expected a quantity')
export const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'expected a percentage')

export const supplierPayload = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  type: z.enum(['fabric_mill', 'trims', 'embellishment', 'subcontract', 'yarn']),
  origin: z.enum(['local', 'import']),
  paymentTerms: z.string().max(200).optional(),
  contacts: z
    .array(
      z.object({
        name: z.string().min(1),
        role: z.string().optional(),
        email: z.email().optional(),
        phone: z.string().optional(),
      }),
    )
    .default([]),
  defaultCurrency: currency.default('USD'),
})

export const purchaseRequisitionPayload = z.object({
  orderId: z.string().uuid().optional(),
  requisitionId: z.string().uuid().optional(),
  prNo: z.string().min(1).max(60),
  neededBy: isoDate,
  lines: z
    .array(z.object({ itemId: z.string().uuid(), qty, unit: z.string().min(1) }))
    .min(1, 'a purchase requisition with no lines buys nothing'),
})

export const supplierQuotePayload = z.object({
  purchaseRequisitionId: z.string().uuid(),
  supplierId: z.string().uuid(),
  currency,
  quotedOn: isoDate,
  validUntil: isoDate.optional(),
  documentId: z.string().uuid().optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        unitPrice: money(4),
        leadTimeDays: z.number().int().min(0),
        moq: qty.default('0'),
        freight: money().default('0'),
        dutyPct: pct.default('0'),
      }),
    )
    .min(1),
})

export const issuePoPayload = z.object({
  supplierId: z.string().uuid(),
  purchaseRequisitionId: z.string().uuid().optional(),
  supplierQuoteId: z.string().uuid().optional(),
  poNumber: z.string().min(1).max(60),
  currency,
  /** Required before an IMPORT PO may be issued — the BTB headroom gate. */
  btbLcId: z.string().uuid().optional(),
  expectedDeliveryDate: isoDate.optional(),
  lines: z
    .array(
      z.object({
        itemId: z.string().uuid(),
        qty,
        unit: z.string().min(1),
        unitPrice: money(4),
      }),
    )
    .min(1, 'a purchase order with no lines commits nothing'),
})

export const receiptMatchPayload = z.object({
  supplierPoLineId: z.string().uuid(),
  qty,
  /** The GRN this receipt came from — the trace back to what physically arrived. */
  grnId: z.string().uuid().optional(),
})

export const PROCUREMENT_ZOD_MAP = {
  supplier: supplierPayload,
  supplier_quote: supplierQuotePayload,
  purchase_requisition: purchaseRequisitionPayload,
} as const

export type SupplierPayload = z.infer<typeof supplierPayload>
export type PurchaseRequisitionPayload = z.infer<typeof purchaseRequisitionPayload>
export type SupplierQuotePayload = z.infer<typeof supplierQuotePayload>
export type IssuePoPayload = z.infer<typeof issuePoPayload>
