/**
 * Payloads for 1.2, including every `pending_changes` payload.
 *
 * `rfqPayload` is what MARBIM drafts from a buyer's enquiry email or PDF — the brief's
 * "text/PDF/photo → pending_change" path. Every field a win later requires is optional
 * HERE, because an enquiry genuinely arrives incomplete; the refusal happens at `markWon`,
 * where the missing size ratio actually stops an order being created.
 */
import { z } from 'zod'

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const money = (scale = 4) =>
  z.string().regex(new RegExp(`^\\d{1,14}(\\.\\d{1,${scale}})?$`), 'expected a money amount')

export const rfqPayload = z.object({
  buyerId: z.string().uuid(),
  title: z.string().min(1).max(200),
  productType: z.string().min(1).max(80),
  description: z.string().max(4000).optional(),
  styleCode: z.string().max(60).optional(),
  quantity: z.number().int().min(1),
  unit: z.string().min(1).max(10).default('pcs'),
  /** size → parts. Optional on an enquiry; required by the time it is won. */
  sizeRatio: z.record(z.string().min(1), z.number().int().min(0)).default({}),
  targetPrice: money().optional(),
  targetCurrency: z.string().length(3).optional(),
  currency: z.string().length(3).default('USD'),
  deadline: isoDate.optional(),
  requestedShipDate: isoDate.optional(),
  source: z.enum(['manual', 'ai_extracted']).default('manual'),
  ownerUserId: z.string().optional(),
})

/**
 * What `markWon` may be handed: the id, plus whichever winning terms the buyer's acceptance
 * fixed. An enquiry genuinely arrives without a firm ship date ("mid-November window") or a
 * size ratio — those get agreed in the acceptance, and the moment of winning is the last
 * honest place to record them. Absent here means "the RFQ already has it"; `wonPayload`
 * still refuses a win that ends up with neither.
 */
export const wonInput = z.object({
  rfqId: z.string().uuid(),
  requestedShipDate: isoDate.optional(),
  sizeRatio: z.record(z.string().min(1), z.number().int().min(1)).optional(),
})

export const clarificationPayload = z.object({
  rfqId: z.string().uuid(),
  question: z.string().min(1).max(2000),
  askedAt: isoDate,
})

/* ────────────────────────────────────────────────────────────────────────────
 * What the extractor may hand back, which is not what `createRfq` accepts
 * ──────────────────────────────────────────────────────────────────────────── */

/** "USD 8.40" → "8.40" · 8.4 → "8.4" · "12,500.00" → "12500.00". Never rounds. */
const transcribedMoney = z.preprocess((value) => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return value
  const match = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(value)
  if (!match) return value
  return match[0].replace(/,/g, '')
}, money())

/** "42,000" or "42,000 pcs" → 42000. */
const transcribedCount = z.preprocess((value) => {
  if (typeof value === 'string') {
    const digits = /\d+/.exec(value.replace(/,/g, ''))?.[0]
    if (digits) return Number(digits)
  }
  return value
}, z.number().int().min(1))

/**
 * A buyer's enquiry, as a model transcribes it. Strict twin: `rfqPayload`.
 *
 * This exists because `rfqPayload` — the manual-entry payload — was wired straight to the
 * `buyer_enquiry` intake kind, and no extraction against it had ever finished. Two reasons,
 * both fatal on their own, and both already solved once for `orderFromPoDraft` and
 * `lcFromSwiftDraft` without the lesson reaching here:
 *
 * 1. `buyerId` was a REQUIRED uuid. No document contains one — an enquiry names the buyer in
 *    words. Under structured output a model cannot answer "absent", so it invents an
 *    id-shaped string and the whole reading is thrown away for "buyerId Invalid UUID". The
 *    intake context picker does supply the real id, but `service.ts` folds `contextValues` in
 *    AFTER the provider call has already validated against this schema, so a required field
 *    here can never be satisfied by a value that arrives later.
 *
 * 2. `targetPrice` used `money()`, which is string-only and unpadded. A model reading
 *    "USD 8.40 per piece" returns `8.40` as a number, or the string with its currency still
 *    attached; both were rejected.
 *
 * Everything a document states in prose rather than as a value is `.catch(undefined)`: an
 * enquiry that says "last week of January 2027" should lose the ship date, not the reading.
 * `rfqPayload` still guards the commit — `commitRfq` re-parses with it — so an RFQ with no
 * buyer remains impossible to create.
 */
export const rfqFromEnquiryDraft = rfqPayload.extend({
  buyerId: z.uuid().optional().catch(undefined),
  quantity: transcribedCount,
  targetPrice: transcribedMoney.optional().catch(undefined),
  targetCurrency: z.string().length(3).optional().catch(undefined),
  currency: z.string().length(3).catch('USD').default('USD'),
  deadline: isoDate.optional().catch(undefined),
  requestedShipDate: isoDate.optional().catch(undefined),
  sizeRatio: z.record(z.string().min(1), z.number().int().min(0)).catch({}).default({}),
  // A reading is an extraction whatever the paper looks like; the manual path sets 'manual'.
  source: z.enum(['manual', 'ai_extracted']).catch('ai_extracted').default('ai_extracted'),
  ownerUserId: z.string().optional().catch(undefined),
})

export const RFQ_ZOD_MAP = {
  // Kept, and not merely for the manual path: drafts raised before the enquiry door had its
  // own schema carry this key, and `resolvePendingSchema` re-reads it at approve time.
  rfq: rfqPayload,
  rfq_from_enquiry_v1: rfqFromEnquiryDraft,
} as const

export type RfqPayload = z.infer<typeof rfqPayload>
export type RfqFromEnquiryDraft = z.infer<typeof rfqFromEnquiryDraft>
