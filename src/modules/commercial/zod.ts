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

export const COMMERCIAL_ZOD_MAP = {
  ud_from_scan_v1: udFromScanDraft,
  ud_override_v1: udOverrideDraft,
} as const

export type CreateUdPayload = z.infer<typeof createUdPayload>
export type UdOverrideDraft = z.infer<typeof udOverrideDraft>
