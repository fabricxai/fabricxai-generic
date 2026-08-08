/**
 * Payload schemas for 3.1, including every `pending_changes` payload.
 *
 * These arrive from a tablet on a factory floor, so validation is where a fat-fingered
 * roll quantity gets caught. Quantities are decimal strings; a JS number here is a stock
 * count that drifts.
 */
import { z } from 'zod'

export const quantity = z
  .string()
  .regex(/^\d{1,10}(\.\d{1,2})?$/, 'expected a positive decimal quantity')

export const moneyAmount = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'expected a decimal amount')

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

export const rollReceipt = z.object({
  rollNo: z.string().min(1),
  qty: quantity,
  locationId: z.uuid(),
  lot: z.string().optional(),
  dyeLot: z.string().optional(),
  /** Rolls sharing a shade group may be cut together. Trims have none. */
  shadeGroup: z.string().optional(),
})

export const grnReceipt = z.object({
  challanNo: z.string().min(1),
  receivedAt: calendarDate,
  supplierPoId: z.uuid().optional(),
  /** Duty-free receipt. The service and a check constraint both require `udId` with it. */
  bonded: z.boolean().default(false),
  udId: z.uuid().optional(),
  documentId: z.uuid().optional(),
  offlineKey: z.string().min(1).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        qty: quantity,
        unit: z.string().min(1),
        unitPrice: moneyAmount.optional(),
        currency: z.string().length(3).optional(),
        rolls: z.array(rollReceipt).default([]),
      }),
    )
    .min(1),
})

/**
 * Either a `bomId` — the normal path, sizing from what the order was priced on — or
 * explicit lines, for a sample run or a style not yet costed. One of the two is required;
 * a requisition with neither would size to nothing and stop a line.
 */
export const requisitionRequest = z
  .object({
    orderId: z.uuid(),
    orderQty: z.number().int().positive(),
    /** Cloth lost to the marker, end bits and shrinkage — not padding. */
    wastagePct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).default('0'),
    bomId: z.uuid().optional(),
    lines: z
      .array(
        z.object({
          itemId: z.uuid(),
          /** Accepts the BOM's four-decimal precision; the RESULT is what gets rounded. */
          consumptionPerPiece: z.string().regex(/^\d{1,10}(\.\d{1,4})?$/),
          unit: z.string().min(1),
        }),
      )
      .optional(),
  })
  .refine((value) => Boolean(value.bomId) || (value.lines?.length ?? 0) > 0, {
    message: 'a requisition needs either a bomId or explicit lines',
  })

export const issueRequest = z.object({
  orderId: z.uuid(),
  requisitionId: z.uuid().optional(),
  offlineKey: z.string().min(1).optional(),
  lines: z
    .array(
      z.object({
        itemId: z.uuid(),
        rollId: z.uuid().optional(),
        qty: quantity,
        unit: z.string().min(1),
        /** Required when the roll is bonded — draws the declaration. */
        udId: z.uuid().optional(),
      }),
    )
    .min(1),
})

/**
 * A stock correction ⚖. Always drafted, never written directly: an adjustment is somebody
 * saying the count is wrong, and a reason is what makes that reviewable.
 */
export const stockAdjustmentDraft = z.object({
  itemId: z.uuid(),
  rollId: z.uuid().optional(),
  /** Signed — negative writes stock off. */
  qtyDelta: z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/),
  unit: z.string().min(1),
  reasonCode: z.string().min(1),
  note: z.string().min(10, 'an adjustment needs a stated reason'),
})

export const STORE_ZOD_MAP = {
  stock_adjustment_v1: stockAdjustmentDraft,
} as const

export type GrnReceipt = z.infer<typeof grnReceipt>
export type IssueRequest = z.infer<typeof issueRequest>
