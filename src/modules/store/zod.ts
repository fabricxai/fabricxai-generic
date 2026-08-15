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

/**
 * A new item on the master list.
 *
 * There was no way to create one. Not an action, not a screen, not a tool — the only
 * writer was the seed script, so a factory that signed up this morning could never receive
 * anything, because a GRN line needs an `itemId` and no `itemId` could come into being.
 * Everything downstream (issue, cutting, production) sat behind that.
 *
 * `spec` is free-form on purpose: a fabric is described by construction, composition, gsm
 * and width; a trim by nothing of the sort. Pinning a shape here would make the form lie
 * to one of them.
 */
export const itemPayload = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  kind: z.enum(['fabric', 'trim', 'accessory', 'yarn', 'greige']),
  /**
   * Fixed once the item has been transacted, and free until then — see `upsertItem`. It is
   * never converted implicitly anywhere in this module, so it is chosen once, here.
   */
  uom: z.string().min(1).max(20),
  spec: z.record(z.string(), z.unknown()).default({}),
  isActive: z.boolean().default(true),
})

/**
 * A new store location.
 *
 * `kind` has no default. A bonded location holds duty-free material that may only leave
 * against a UD, and a system that guessed "general" for a store somebody meant as bonded
 * would route customs-liable fabric through the gate that does not exist.
 */
export const locationPayload = z.object({
  code: z.string().min(1).max(60),
  name: z.string().min(1).max(200),
  kind: z.enum(['bonded', 'general', 'floor']),
  isActive: z.boolean().default(true),
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

/**
 * A delivery challan, as a model reads it off a photograph.
 *
 * The receive screen has photographed the challan since it was built — uploaded it, stored
 * it against the GRN, shown its filename — and never once read it. The storekeeper takes the
 * picture and then types what is in the picture. This is the single highest-volume retype in
 * the building: every delivery, every day, on a tablet, standing next to a truck.
 *
 * ## Codes, not ids
 *
 * `grnReceipt` names items by uuid because that is what the database needs. A challan names
 * them the way the supplier writes them — "30/1 combed cotton yarn", sometimes a code the
 * factory shares with them, never a uuid. So this reads `itemCode` and `itemName` as text and
 * the screen resolves them against the master list, showing what it matched. A model asked
 * for a uuid invents one; a model asked what the paper says reads what the paper says.
 *
 * ## What it does not read
 *
 * The bonded flag and the UD. Whether a receipt is duty-free is a customs position, not a
 * line on a delivery note, and reading it wrong in either direction is a legal problem rather
 * than a typing one — the storekeeper says so, deliberately, every time.
 */
/**
 * "10,600 KG" or 10600 → "10600". Tolerated on the way in, strict underneath.
 *
 * A challan writes quantities the way a person writes them, with thousands separators and
 * the unit alongside. The strict `quantity` regex refuses all of that, and refusing the whole
 * reading over a comma is how an extractor gets a reputation for not working.
 */
const transcribedQty = z.preprocess((value) => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return value
  const match = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(value)
  if (!match) return value
  const [whole, fraction = ''] = match[0].replace(/,/g, '').split('.')
  const trimmed = fraction.length > 2 ? fraction.slice(0, 2) : fraction
  return trimmed ? `${whole}.${trimmed}` : whole
}, quantity)

export const grnFromChallanDraft = z.object({
  challanNo: z.string().min(1),
  receivedAt: calendarDate.optional(),
  /** What the supplier calls itself on its own paper — matched against the supplier list. */
  supplierName: z.string().optional(),
  /*
   * Permissive per row, strict about the SET.
   *
   * `itemName` was `.min(1)` with a comment saying it is always present. A challan book
   * breaks that: `ZJH-DC-8842` restates its one material on a second row as a roll count,
   * the model returned that row with an empty name, and one strict field then threw away a
   * perfectly good first line — the storekeeper, standing next to a truck, got "that
   * document could not be read" and a blank form.
   *
   * So a row is parsed loosely, rows with no material identity are dropped as the
   * restatements they are, and the reading is refused only if NOTHING readable survives.
   * The screen already treats a row that names a different material as a separate line, so
   * a real second material still arrives as one.
   */
  lines: z
    .array(
      z.object({
        /** The code if the challan prints one — many do, shared with the supplier. */
        itemCode: z.string().optional(),
        /** What the paper calls the material. Often the only identity a challan carries. */
        itemName: z.string().optional(),
        qty: transcribedQty.optional(),
        unit: z.string().max(20).optional(),
        /** Rolls or bales listed individually, when the challan itemises them. */
        rolls: z
          .array(
            z.object({
              rollNo: z.string().min(1),
              qty: transcribedQty,
              lot: z.string().optional(),
              shadeGroup: z.string().optional(),
            }),
          )
          .default([]),
      }),
    )
    .transform((rows) =>
      rows.filter((row) => (row.itemCode ?? '').trim() !== '' || (row.itemName ?? '').trim() !== ''),
    )
    .refine((rows) => rows.length > 0, {
      message: 'no line on this challan names a material',
    }),
})

export const STORE_ZOD_MAP = {
  grn_from_challan_v1: grnFromChallanDraft,
  stock_adjustment_v1: stockAdjustmentDraft,
} as const

export type GrnReceipt = z.infer<typeof grnReceipt>
export type IssueRequest = z.infer<typeof issueRequest>
