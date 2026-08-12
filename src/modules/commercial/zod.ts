/**
 * Payload schemas for module 2 (commercial), including every `pending_changes` payload.
 *
 * Quantities are decimal STRINGS, like money. A bonded quantity that becomes a JS number
 * is the same class of bug as a float on an invoice, with a customs inspector at the end
 * of it rather than an accountant.
 */
import { z } from 'zod'

/** numeric(12,2) as a string — metres, kilograms, pieces. */
export const quantity = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,3})?$/, 'expected a positive decimal quantity')

export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    // Date#toISOString THROWS on an invalid date — the old guard crashed with "Invalid
    // time value" on exactly the input it exists to refuse ("0000-00-00" matches the
    // regex). Date.parse returns NaN instead, which a refine can answer false to.
    const time = Date.parse(`${value}T00:00:00Z`)
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
  }, {
    message: 'not a real calendar date',
  })

/**
 * One line of the customs declaration. `unit` is free text because declarations use
 * whatever the customs office wrote — normalising it here would silently equate YDS and
 * YD, and the gate refuses to convert units precisely so that never matters.
 */
export const udAuthorizedItem = z.object({
  itemRef: z.string().min(1),
  qty: quantity,
  unit: z.string().min(1).max(12),
})

export const udAuthorizedItems = z.array(udAuthorizedItem).min(1)

export const createUdPayload = z.object({
  number: z.string().min(1),
  issueDate: calendarDate.optional(),
  validUntil: calendarDate.optional(),
  authorizedItems: udAuthorizedItems,
  // `.catch(undefined)`, same reasoning as costing's sourceDocumentId: offered a uuid
  // field, the extract model fills it with whatever id-shaped string the scan has
  // ("UD-131", the bond licence) — no paper carries a UUID. An invalid value becomes
  // absence; the manual path's picker always supplies a real id.
  documentId: z.uuid().optional().catch(undefined),
})

/** What MARBIM extracts from a scanned UD. Every field is uncertain, hence the review. */
export const udFromScanDraft = createUdPayload

/**
 * A deliberate overdraw, routed to the owner (brief §Operations: "insufficient ⇒ block +
 * optional override pending_change routed to owner").
 *
 * `reason` is required and minimum length is enforced: an approved customs overdraw with
 * no stated justification is exactly the row an auditor will ask about.
 */
export const udOverrideDraft = z.object({
  udId: z.uuid(),
  itemRef: z.string().min(1),
  qty: quantity,
  unit: z.string().min(1),
  storeIssueId: z.uuid().optional(),
  reason: z.string().min(10, 'an overdraw needs a stated reason'),
})

export const createLcPayload = z.object({
  /** Required. A letter of credit is opened by a specific buyer's bank in the factory's
   *  favour — an LC belonging to nobody cannot be reconciled against a shipment. */
  buyerId: z.uuid(),
  number: z.string().min(1).max(60),
  value: quantity,
  currency: z.string().length(3),
  /** The shipping band the LC allows. 8.1 reads it; it is not a display preference. */
  tolerancePct: quantity.default('0'),
  issueDate: calendarDate.optional(),
  /**
   * The two dates that cause every LC crisis. Latest shipment is when goods must be ON the
   * vessel; expiry is when documents must be AT the bank. A shipment that meets one and
   * misses the other is still unpaid.
   */
  latestShipmentDate: calendarDate.optional(),
  expiryDate: calendarDate.optional(),
  /**
   * `{ commercial_invoice: true, packing_list: true, bl: true }` — a MAP, not a list,
   * because 8.1 looks documents up by kind when it assembles a presentation. A list would
   * make every lookup a scan and every typo silently absent.
   */
  docsRequired: z.record(z.string().min(1), z.boolean()).default({}),
  documentId: z.uuid().optional(),
})

export type CreateLcPayload = z.infer<typeof createLcPayload>

/**
 * The document kinds a credit can call for.
 *
 * Closed, and the same six the LC register offers, because this is what a MODEL fills in:
 * an open `record<string, boolean>` invites `"full set clean on board bills of lading": true`
 * — a true statement about the paper and a key the bank-presentation checklist will never
 * look up, so the requirement silently disappears at the counter. A closed set turns a
 * document's own wording into this system's vocabulary at the moment of reading, which is
 * the only moment anybody is checking.
 */
export const lcDocKind = z.enum([
  'commercial_invoice',
  'packing_list',
  'bl',
  'certificate_of_origin',
  'beneficiary_certificate',
  'inspection_certificate',
  'exp_form',
])

/**
 * A letter of credit read off a SWIFT MT700 (or the bank's advice of one).
 *
 * `createLcPayload` with two differences, both because a MODEL is filling this in rather
 * than a person at the register:
 *
 *  · no `documentId` — offered a uuid field the extractor fills it with whatever id-shaped
 *    string the page carries (the credit number, the bank's reference), and no paper
 *    contains a uuid. The intake pipeline attaches the real document itself.
 *  · `docsRequired` is keyed by a closed enum, for the reason above.
 *
 * `buyerId` stays required and arrives from the intake context picker: a credit belonging
 * to nobody cannot be reconciled against a shipment, and 59/50 name a company, never an id
 * this system would recognise.
 */
/** "USD 244,800.00" or 244800 → "244800.00". Tolerated on the way in, strict underneath. */
const transcribedAmount = z.preprocess((value) => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return value
  const match = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(value)
  if (!match) return value
  const [whole, fraction = ''] = match[0].replace(/,/g, '').split('.')
  const trimmed = fraction.length > 2 ? fraction.replace(/0+$/, '') : fraction
  return trimmed ? `${whole}.${trimmed}` : whole
}, quantity)

/**
 * The documents a credit calls for, however the model hands them over.
 *
 * 46A is a numbered list on the page — "1. Commercial invoice in triplicate 2. Packing
 * list…" — and a model reading it returns a list, which a `partialRecord` refuses key by key
 * ("docsRequired.1 Invalid key in record"). Both shapes are accepted here and normalised to
 * the map the presentation checklist looks documents up by.
 *
 * A name that is not one of the seven kinds is DROPPED rather than kept: the closed set is
 * this system's vocabulary, and a key nothing will ever look up is a requirement that
 * silently disappears at the bank counter — see `lcDocKind`.
 */
const transcribedDocs = z.preprocess((value) => {
  const kinds = new Set(lcDocKind.options as readonly string[])
  if (Array.isArray(value)) {
    const out: Record<string, boolean> = {}
    for (const entry of value) {
      if (typeof entry === 'string' && kinds.has(entry)) out[entry] = true
      else if (entry && typeof entry === 'object') {
        const record = entry as Record<string, unknown>
        const name = typeof record.kind === 'string' ? record.kind : undefined
        if (name && kinds.has(name)) out[name] = record.required !== false
      }
    }
    return out
  }
  if (value && typeof value === 'object') {
    // A map keyed by position ("1", "2") rather than by kind — same list, different wrapper.
    const record = value as Record<string, unknown>
    const out: Record<string, boolean> = {}
    for (const [key, entry] of Object.entries(record)) {
      if (kinds.has(key)) out[key] = Boolean(entry)
      else if (typeof entry === 'string' && kinds.has(entry)) out[entry] = true
    }
    return out
  }
  return value
}, z.partialRecord(lcDocKind, z.boolean()).default({}))

export const lcFromSwiftDraft = z.object({
  /**
   * OPTIONAL here and required at commit, which is the opposite of how it reads.
   *
   * A uuid is the one value no document contains, and asking a model for one under a
   * structured-output schema does not get an absence — it gets an invention, and the whole
   * extraction is then thrown away for "buyerId Invalid UUID". This schema had never once
   * produced a successful reading for that reason: no LC extraction job has ever finished.
   *
   * The buyer arrives from the intake context picker and is merged over the model's answer at
   * confidence 1, because which record in this factory's book "BESTSELLER A/S" maps to is a
   * judgement a person makes. `createLcPayload` still requires it, so a credit belonging to
   * nobody cannot be committed.
   */
  buyerId: z.uuid().optional().catch(undefined),
  number: z.string().min(1).max(60),
  value: transcribedAmount,
  currency: z.string().length(3),
  tolerancePct: transcribedAmount.default('0'),
  issueDate: calendarDate.optional(),
  /** 44C and 31D — the two dates every LC crisis is about. */
  latestShipmentDate: calendarDate.optional(),
  expiryDate: calendarDate.optional(),
  docsRequired: transcribedDocs,
})

export const COMMERCIAL_ZOD_MAP = {
  ud_from_scan_v1: udFromScanDraft,
  ud_override_v1: udOverrideDraft,
  lc_from_swift_v1: lcFromSwiftDraft,
} as const

export type LcFromSwiftDraft = z.infer<typeof lcFromSwiftDraft>
export type CreateUdPayload = z.infer<typeof createUdPayload>
export type UdOverrideDraft = z.infer<typeof udOverrideDraft>
