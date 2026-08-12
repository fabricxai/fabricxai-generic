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

/** "USD 3.35/YD" or 3.35 → "3.3500". Tolerated on the way in, strict underneath. */
const transcribedMoney = z.preprocess((value) => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return value
  const match = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(value)
  if (!match) return value
  return match[0].replace(/,/g, '')
}, money(4))

/** "23,500 YDS" or 23500 → "23500". */
const transcribedQty = z.preprocess((value) => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return value
  const match = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(value)
  if (!match) return value
  return match[0].replace(/,/g, '')
}, qty)

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

/**
 * A supplier's proforma invoice, as a model reads it.
 *
 * The strict twin is `supplierQuotePayload`, which names the requisition, the supplier and
 * every item by uuid — three things no proforma carries and a model can only invent. This
 * reads what the paper actually says: the supplier's own words for the material, the price,
 * and the terms buried in the prose. The screen resolves those against this factory's own
 * lists and shows what it matched.
 *
 * ## The terms are prose, and they are the expensive part
 *
 * "SHIPMENT: WITHIN 25 DAYS AFTER RECEIPT OF WORKABLE L/C" is a lead time. "PRICE TERM: CFR
 * CHATTOGRAM" says freight is already in the price and duty is not. "QUANTITY +/-2PCT" is a
 * tolerance. A procurement officer comparing two quotes on unit price alone and missing that
 * one is FOB and the other CFR has compared nothing — `compareQuotesForItem` ranks on landed
 * cost precisely because of this, and it can only do that if somebody transcribed the terms.
 * That transcription is the tedious, skippable step this exists to remove.
 */
/**
 * A field the paper may simply not state.
 *
 * Under a non-strict structured-output schema a model fills EVERY field it is shown — a
 * quote that says nothing about duty comes back as `""` or `"N/A"`, and one strict optional
 * then refuses the whole reading over a value the document never had. `.catch(undefined)`
 * turns "there was nothing here" into absence, which is what the instruction asks for and
 * what the comparison needs: a missing freight figure must stay missing, because a zero
 * would be ranked as free shipping.
 */
const stated = <T extends z.ZodTypeAny>(schema: T) => schema.optional().catch(undefined)

export const quoteFromProformaDraft = z.object({
  /** The supplier's own reference for the quote — "PI No", "Quotation No". */
  reference: stated(z.string().max(80)),
  quotedOn: stated(isoDate),
  validUntil: stated(isoDate),
  currency: currency.catch('USD').default('USD'),
  /** CFR, FOB, CIF, EXW — what the price already includes. */
  priceTerm: stated(z.string().max(40)),
  lines: z
    .array(
      z.object({
        /** An article or style number, when the mill prints one. */
        itemCode: stated(z.string().max(80)),
        /** What the proforma calls the material, word for word. */
        itemName: z.string().min(1),
        qty: stated(transcribedQty),
        unit: stated(z.string().max(20)),
        unitPrice: transcribedMoney,
        /** Days after order — read out of the shipment clause when it is stated there. */
        leadTimeDays: stated(
          z.preprocess((v) => {
            if (typeof v === 'string') {
              const digits = /\d+/.exec(v)?.[0]
              return digits ? Number(digits) : v
            }
            return v
          }, z.number().int().min(0)),
        ),
        moq: stated(transcribedQty),
        freight: stated(transcribedMoney),
        dutyPct: stated(pct),
      }),
    )
    .min(1),
})

export const PROCUREMENT_ZOD_MAP = {
  quote_from_proforma_v1: quoteFromProformaDraft,
  supplier: supplierPayload,
  supplier_quote: supplierQuotePayload,
  purchase_requisition: purchaseRequisitionPayload,
} as const

export type SupplierPayload = z.infer<typeof supplierPayload>
export type PurchaseRequisitionPayload = z.infer<typeof purchaseRequisitionPayload>
export type SupplierQuotePayload = z.infer<typeof supplierQuotePayload>
export type IssuePoPayload = z.infer<typeof issuePoPayload>
