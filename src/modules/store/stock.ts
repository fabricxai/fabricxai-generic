/**
 * Store stock arithmetic (brief 3.1 §Operations). Pure — no database, no clock.
 *
 * **free = on-hand − reserved, computed and never stored.** Architecture §4 says
 * reservation semantics expose on-hand / reserved / free as first-class computed reads
 * "because multi-order contention is the normal state". A stored free balance is wrong
 * the moment two merchandisers reserve against the same roll, and it is wrong silently.
 *
 * Quantities go through `lib/quantity`: exact decimal strings on scaled BigInt. A float
 * here over-issues a cutting floor by a roll and nobody finds out until the shortfall.
 */
import {
  addQty,
  compareQty,
  fromMinor,
  isNegativeQty,
  multiplyDecimalStrings,
  type Quantity,
  quantity,
  roundToScale,
  subtractQty,
  toMinor,
  zeroQty,
} from '@/lib/quantity'

export class StoreError extends Error {
  override readonly name = 'StoreError'
}

export type RollStatus = 'in_stock' | 'issued' | 'returned' | 'adjusted_out'
export type ReservationStatus = 'open' | 'fulfilled' | 'cancelled'

export interface RollInput {
  rollId: string
  itemId: string
  qty: string
  unit: string
  status: RollStatus
  locationId: string
  /** Dye-lot grouping. Null for trims and anything without a shade. */
  shadeGroup: string | null
}

export interface ReservationInput {
  itemId: string
  qty: string
  unit: string
  status: ReservationStatus
}

export interface ItemStock {
  itemId: string
  unit: string
  onHand: string
  reserved: string
  free: string
  /** True when more is promised than exists — real, and worth surfacing loudly. */
  overReserved: boolean
  /** On-hand split by location: a bonded roll is not interchangeable with a general one. */
  byLocation: Record<string, string>
}

/** Only these count as being in the store. Issued stock is on the floor. */
const COUNTS_AS_ON_HAND: readonly RollStatus[] = ['in_stock', 'returned']

export function computeStock(input: {
  rolls: readonly RollInput[]
  reservations: readonly ReservationInput[]
}): Map<string, ItemStock> {
  const byItem = new Map<
    string,
    { unit: string; onHand: Quantity; reserved: Quantity; byLocation: Map<string, Quantity> }
  >()

  const entryFor = (itemId: string, unit: string) => {
    const existing = byItem.get(itemId)
    if (existing) {
      if (existing.unit !== unit) {
        // The same item in two units means the UoM is wrong somewhere. Summing them
        // would produce a confident, meaningless number.
        throw new StoreError(
          `item "${itemId}" appears in both ${existing.unit} and ${unit} — units are never converted`,
        )
      }
      return existing
    }

    const created = {
      unit,
      onHand: zeroQty(unit),
      reserved: zeroQty(unit),
      byLocation: new Map<string, Quantity>(),
    }
    byItem.set(itemId, created)
    return created
  }

  for (const roll of input.rolls) {
    const entry = entryFor(roll.itemId, roll.unit)
    if (!COUNTS_AS_ON_HAND.includes(roll.status)) continue

    const qty = quantity(roll.qty, roll.unit)
    entry.onHand = addQty(entry.onHand, qty)
    entry.byLocation.set(
      roll.locationId,
      addQty(entry.byLocation.get(roll.locationId) ?? zeroQty(roll.unit), qty),
    )
  }

  for (const reservation of input.reservations) {
    // A fulfilled or cancelled requisition no longer holds anything back.
    if (reservation.status !== 'open') continue
    const entry = entryFor(reservation.itemId, reservation.unit)
    entry.reserved = addQty(entry.reserved, quantity(reservation.qty, reservation.unit))
  }

  const result = new Map<string, ItemStock>()
  for (const [itemId, entry] of byItem) {
    const free = subtractQty(entry.onHand, entry.reserved)

    result.set(itemId, {
      itemId,
      unit: entry.unit,
      onHand: entry.onHand.value,
      reserved: entry.reserved.value,
      // Negative free is NOT clamped: two orders promised the same cloth, and that
      // contention is exactly what a planner needs to see.
      free: free.value,
      overReserved: isNegativeQty(free),
      byLocation: Object.fromEntries(
        [...entry.byLocation].map(([location, qty]) => [location, qty.value]),
      ),
    })
  }

  return result
}

// ─────────────────────────────────────────────────────────────────────────────
// Requisition sizing
// ─────────────────────────────────────────────────────────────────────────────

export interface RequisitionInputLine {
  itemId: string
  /** From the cost sheet (module 1.5). Metres or pieces per garment. */
  consumptionPerPiece: string
  unit: string
}

export interface RequisitionLine {
  itemId: string
  requiredQty: string
  unit: string
}

/**
 * What an order needs: consumption × order quantity × (1 + wastage).
 *
 * Wastage is not padding — it is the cloth lost to the marker, to end bits, to shrinkage.
 * Under-issue and the line stops mid-run; over-issue and the margin goes. Both are
 * expensive, which is why this is exact and rounds once.
 */
export function computeRequisitionLines(input: {
  orderQty: number
  /** Percentage as a decimal string, e.g. '5' or '2.5'. */
  wastagePct: string
  lines: readonly RequisitionInputLine[]
}): RequisitionLine[] {
  if (!Number.isInteger(input.orderQty) || input.orderQty <= 0) {
    throw new StoreError(`order quantity must be a positive whole number, got ${input.orderQty}`)
  }
  if (!/^\d+(\.\d+)?$/.test(input.wastagePct)) {
    throw new StoreError(`wastage must be a non-negative percentage, got "${input.wastagePct}"`)
  }

  // (1 + pct/100) as an exact decimal factor — never a float.
  const wastageMinor = toMinor(input.wastagePct, 'wastage percentage')
  const factor = fromMinor(10_000n + wastageMinor)

  return input.lines.map((line) => {
    // Consumption arrives at the BOM's precision — four places, because 1.4523 m per
    // garment is a real figure. Rounding it to 1.45 first loses 2.3 metres per thousand
    // garments, which is enough to stop a line. So the whole product stays exact and the
    // single rounding happens at the end.
    const exact = multiplyDecimalStrings(
      multiplyDecimalStrings(line.consumptionPerPiece, String(input.orderQty)),
      divideBy100(factor),
    )

    return {
      itemId: line.itemId,
      requiredQty: roundToScale(exact),
      unit: line.unit,
    }
  })
}

/** `105.00` → `1.0500`, without touching a float. */
function divideBy100(value: string): string {
  const [whole = '0', fraction = ''] = value.split('.')
  const digits = (whole + fraction).padStart(fraction.length + 3, '0')
  const scale = fraction.length + 2
  return `${digits.slice(0, -scale) || '0'}.${digits.slice(-scale)}`
}

// ─────────────────────────────────────────────────────────────────────────────
// Shade mixing
// ─────────────────────────────────────────────────────────────────────────────

export interface StoreWarning {
  code: string
  /** i18n key — never a display string. */
  messageKey: string
  facts: Record<string, unknown>
}

/**
 * Would this issue mix dye lots on the order?
 *
 * A garment cut from two shade groups is a rejection at final inspection — the panels
 * do not match under the buyer's lightbox. But the brief is explicit that this WARNS and
 * the UI decides: mixing across a size break, or on an unseen inner panel, is sometimes
 * the right call and the storekeeper knows why. Blocking here would have people working
 * around the system by not recording the shade at all, which is strictly worse.
 */
export function checkShadeMix(input: {
  alreadyIssued: readonly (string | null)[]
  picking: readonly (string | null)[]
}): { mixed: boolean; warnings: StoreWarning[] } {
  // Trims have no shade group; their nulls are not a mix.
  const existing = [...new Set(input.alreadyIssued.filter((s): s is string => Boolean(s)))]
  const picked = [...new Set(input.picking.filter((s): s is string => Boolean(s)))]

  const combined = new Set([...existing, ...picked])
  if (combined.size <= 1) return { mixed: false, warnings: [] }

  return {
    mixed: true,
    warnings: [
      {
        code: 'shade_mix',
        messageKey: 'store.warnings.shade_mix',
        facts: { existing, picked, groups: [...combined] },
      },
    ],
  }
}

/** Is there enough free stock for this line? Used by the issue path before it commits. */
export function hasFreeStock(stock: ItemStock | undefined, needed: Quantity): boolean {
  if (!stock) return false
  return compareQty(quantity(stock.free, stock.unit), needed) >= 0
}

/**
 * The rows on a read challan that actually name a material.
 *
 * A challan book restates: `ZJH-DC-8842` writes its one fabric on row 1 and the same
 * delivery again on row 2 as a roll count, which is how the paper is kept. A row carrying
 * neither a code nor a name is that restatement, not a second material, and receiving it as
 * one puts a phantom item in the store.
 *
 * It lives here rather than in the zod because that schema is handed to the extract model as
 * JSON Schema, and neither a transform nor a refinement can be expressed in one — the read
 * schema describes the shape of the paper, and judging the rows is a separate job.
 */
export function challanMaterials<T extends { itemCode?: string | undefined; itemName?: string | undefined }>(
  rows: readonly T[],
): T[] {
  return rows.filter((row) => (row.itemCode ?? '').trim() !== '' || (row.itemName ?? '').trim() !== '')
}
