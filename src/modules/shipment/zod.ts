/**
 * Payloads for 8.1, including every `pending_changes` payload.
 *
 * `toleranceOverridePayload` is the important one. The brief says a shipment outside the
 * LC's tolerance needs "a structured warning requiring manager pending_change" — so
 * overriding it is not a boolean somebody flips, it is a proposal carrying the numbers and
 * a reason, reviewed by a human. A bank refusing documents over a quantity discrepancy
 * costs real money, and the record of who accepted the risk has to exist.
 */
import { z } from 'zod'

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const decimal = (max = 10) =>
  z.string().regex(new RegExp(`^\\d{1,${max}}(\\.\\d{1,2})?$`), 'expected a positive decimal')

/** `Colour|Size`. Same separator as cutting and quality — one grid language repo-wide. */
export const CELL_SEPARATOR = '|'
const cellKeyPattern = /^[^|]+\|[^|]+$/

export const cellMap = z.record(
  z.string().regex(cellKeyPattern, 'expected "Colour|Size"'),
  z.number().int().min(0),
)

export const finishingOutputPayload = z.object({
  orderId: z.string().uuid(),
  orderStyleId: z.string().uuid().optional(),
  outputDate: isoDate,
  cells: cellMap.refine((m) => Object.keys(m).length > 0, { message: 'no cells reported' }),
  offlineKey: z.string().min(1).max(120).optional(),
})

export const cartonPayload = z.object({
  orderId: z.string().uuid(),
  cartonNo: z.string().min(1).max(60),
  contents: cellMap.refine((m) => Object.values(m).some((q) => q > 0), {
    message: 'an empty carton is not a carton',
  }),
  grossKg: decimal().optional(),
  netKg: decimal().optional(),
  lengthCm: decimal(8).optional(),
  widthCm: decimal(8).optional(),
  heightCm: decimal(8).optional(),
  offlineKey: z.string().min(1).max(120).optional(),
})

export const shipmentPayload = z.object({
  orderId: z.string().uuid(),
  lcId: z.string().uuid().optional(),
  partialNo: z.number().int().min(1).default(1),
  plannedExFactory: isoDate,
  forwarder: z.string().max(200).optional(),
  bookingRef: z.string().max(120).optional(),
  mode: z.enum(['sea', 'air']).default('sea'),
})

export const shipmentDocPayload = z.object({
  shipmentId: z.string().uuid(),
  kind: z.string().min(1).max(60),
  documentId: z.string().uuid().optional(),
  status: z.enum(['pending', 'ready', 'submitted']),
})

/**
 * A knowingly-accepted LC quantity discrepancy. Carries the numbers so an approver sees
 * exactly what they are signing, not just a flag.
 */
export const toleranceOverridePayload = z.object({
  shipmentId: z.string().uuid(),
  lcQty: z.number().int().min(1),
  shippedQty: z.number().int().min(0),
  tolerancePct: z.string(),
  direction: z.enum(['over', 'short']),
  varianceQty: z.number().int().min(1),
  reason: z.string().min(1).max(500),
})

/**
 * A packing list, as the packing floor or a forwarder writes it.
 *
 * `cartonPayload` names the order by uuid and keys contents by "colour|size"; a packing list
 * prints a carton number, what is in it, and its weights. This reads that and the screen
 * attaches it to the order it is already open on.
 *
 * Weights are read because they are what a forwarder charges on and what the B/L must agree
 * with — a packing list whose gross weight disagrees with the bill of lading is a discrepancy
 * at the bank, and it is caught by somebody comparing two pieces of paper.
 */
export const packingListDraft = z.object({
  reference: z.string().max(80).optional().catch(undefined),
  cartons: z
    .array(
      z.object({
        cartonNo: z.string().min(1).max(60),
        contents: z
          .array(
            z.object({
              color: z.string().min(1).max(60),
              size: z.string().min(1).max(20),
              qty: z.number().int().min(0),
            }),
          )
          .min(1),
        grossKg: z.string().regex(/^\d{1,8}(\.\d{1,3})?$/).optional().catch(undefined),
        netKg: z.string().regex(/^\d{1,8}(\.\d{1,3})?$/).optional().catch(undefined),
      }),
    )
    .min(1)
    .max(500),
})

export const SHIPMENT_ZOD_MAP = {
  packing_list_v1: packingListDraft,
  tolerance_override: toleranceOverridePayload,
  carton: cartonPayload,
} as const

export type FinishingOutputPayload = z.infer<typeof finishingOutputPayload>
export type CartonPayload = z.infer<typeof cartonPayload>
export type ShipmentPayload = z.infer<typeof shipmentPayload>
export type ToleranceOverridePayload = z.infer<typeof toleranceOverridePayload>
