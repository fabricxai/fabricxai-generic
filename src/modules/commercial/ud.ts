/**
 * UD balance arithmetic and the bonded-issue gate (brief 2.2, §Operations).
 *
 * A Utilization Declaration is the customs document that lets a factory import fabric and
 * trims duty-free, against a promise that they leave again as exported garments. It
 * authorises named items in named quantities. Issuing more bonded material than the UD
 * covers is not an inventory discrepancy — it is a customs violation, and the exposure is
 * duty plus penalty on goods the factory has already cut and sewn.
 *
 * Consequences of that, all deliberate:
 *
 *  - **Hard block, not a warning.** `checkUdDraw` returns a decision, and the service
 *    layer refuses the issue. Never UI-only (CLAUDE.md rule 8, architecture §1.3).
 *  - **Exact arithmetic.** Quantities are `numeric(12,2)` decimal strings. Scaled BigInt
 *    throughout; no float ever touches a bonded quantity, for the same reason none touches
 *    money — except the reader at the end is a customs inspector.
 *  - **Units are never converted.** 500 kg of a fabric authorised in metres is not 500
 *    metres, and a guessed conversion factor is how a factory ends up over-drawn on paper
 *    and short on cloth.
 *  - **Unknown is not unlimited.** An item absent from the UD is refused outright.
 *
 * Pure: no database, no clock. `today` is a parameter so the gate, the nightly expiry
 * scan and the tests all agree.
 */

export class UdError extends Error {
  override readonly name = 'UdError'
}

/** Metres, kilograms, pieces, dozens — whatever the declaration itself says. */
export type UdUnit = string

export interface UdAuthorizedItem {
  itemRef: string
  /** Decimal string. */
  qty: string
  unit: UdUnit
}

export interface UdConsumption {
  itemRef: string
  qty: string
  unit: UdUnit
}

export type UdStatus = 'active' | 'exhausted' | 'expired' | 'closed'

export interface UdForCheck {
  id: string
  number: string
  status: UdStatus
  /** Inclusive: a draw on this date is still valid. */
  validUntil: string | null
  authorizedItems: readonly UdAuthorizedItem[]
}

export interface UdItemBalance {
  itemRef: string
  unit: UdUnit
  authorized: string
  consumed: string
  free: string
}

export interface UdDrawDecision {
  allowed: boolean
  /** i18n key — never a display string. */
  reasonKey?: string
  itemRef: string
  unit: UdUnit | null
  authorized: string | null
  consumed: string | null
  free: string | null
  /** What the balance would be if this draw went through. Null when refused. */
  remainingAfter: string | null
  /** How much is missing. Only set on an insufficient-balance refusal. */
  shortfall?: string
  facts: Record<string, string | number | null>
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact decimal quantities — scaled BigInt, never a float
// ─────────────────────────────────────────────────────────────────────────────

/** numeric(12,2). Declarations are sometimes written to three places; we round to two. */
const QTY_SCALE = 2
const DECIMAL = /^-?\d+(\.\d+)?$/

function toMinor(qty: string, what = 'quantity'): bigint {
  const trimmed = qty.trim()
  if (!DECIMAL.test(trimmed)) throw new UdError(`"${qty}" is not a decimal ${what}`)

  const negative = trimmed.startsWith('-')
  const [whole = '0', fraction = ''] = trimmed.replace('-', '').split('.')

  if (fraction.length > QTY_SCALE && /[1-9]/.test(fraction.slice(QTY_SCALE))) {
    throw new UdError(
      `"${qty}" has more than ${QTY_SCALE} decimal places — round explicitly before drawing`,
    )
  }

  const minor = BigInt(whole + fraction.padEnd(QTY_SCALE, '0').slice(0, QTY_SCALE))
  return negative ? -minor : minor
}

function toDecimal(minor: bigint): string {
  const negative = minor < 0n
  const digits = (negative ? -minor : minor).toString().padStart(QTY_SCALE + 1, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -QTY_SCALE)}.${digits.slice(-QTY_SCALE)}`
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function assertDate(date: string): string {
  if (!ISO_DATE.test(date)) throw new UdError(`"${date}" is not a calendar date (YYYY-MM-DD)`)
  return date
}

// ─────────────────────────────────────────────────────────────────────────────
// Balance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Per-item authorised / consumed / free, keyed by item reference.
 *
 * Throws on a unit mismatch rather than skipping the row: a consumption recorded in the
 * wrong unit means the ledger is already wrong, and quietly ignoring it would make the
 * free balance look healthier than it is — the exact direction of error that gets a
 * factory in trouble.
 */
export function computeUdBalance(input: {
  authorizedItems: readonly UdAuthorizedItem[]
  consumptions: readonly UdConsumption[]
}): Map<string, UdItemBalance> {
  const balance = new Map<string, { unit: UdUnit; authorized: bigint; consumed: bigint }>()

  for (const item of input.authorizedItems) {
    const existing = balance.get(item.itemRef)
    if (existing) {
      if (existing.unit !== item.unit) {
        throw new UdError(
          `UD authorises "${item.itemRef}" in both ${existing.unit} and ${item.unit}`,
        )
      }
      // A declaration may list the same item on more than one line; they add up.
      existing.authorized += toMinor(item.qty)
      continue
    }

    balance.set(item.itemRef, {
      unit: item.unit,
      authorized: toMinor(item.qty),
      consumed: 0n,
    })
  }

  for (const consumption of input.consumptions) {
    const entry = balance.get(consumption.itemRef)
    if (!entry) {
      throw new UdError(
        `consumption recorded against "${consumption.itemRef}", which this UD does not authorise`,
      )
    }
    if (entry.unit !== consumption.unit) {
      throw new UdError(
        `consumption of "${consumption.itemRef}" is in ${consumption.unit} but the UD authorises ${entry.unit} — units are never converted`,
      )
    }
    entry.consumed += toMinor(consumption.qty)
  }

  const result = new Map<string, UdItemBalance>()
  for (const [itemRef, entry] of balance) {
    result.set(itemRef, {
      itemRef,
      unit: entry.unit,
      authorized: toDecimal(entry.authorized),
      consumed: toDecimal(entry.consumed),
      free: toDecimal(entry.authorized - entry.consumed),
    })
  }

  return result
}

/**
 * The gate. Can this bonded issue draw this quantity of this item against this UD?
 *
 * Returns a decision rather than throwing for business refusals, because the caller shows
 * the numbers to a storekeeper and may route an override to the owner through
 * `pending_changes`. Malformed input still throws — a quantity that is not a number is a
 * bug, not a business outcome.
 */
export function checkUdDraw(input: {
  ud: UdForCheck
  consumptions: readonly UdConsumption[]
  itemRef: string
  qty: string
  unit: UdUnit
  today: string
}): UdDrawDecision {
  const requested = toMinor(input.qty)
  if (requested <= 0n) {
    // A zero draw is not "free", it is a malformed issue. Letting it through would put a
    // bonded issue line in the ledger that consumes nothing and reconciles to nothing.
    throw new UdError(`a bonded draw must be positive, got "${input.qty}"`)
  }
  assertDate(input.today)

  const base = {
    itemRef: input.itemRef,
    unit: null,
    authorized: null,
    consumed: null,
    free: null,
    remainingAfter: null,
  }

  if (input.ud.status !== 'active') {
    return {
      ...base,
      allowed: false,
      reasonKey: 'commercial.ud.not_active',
      facts: {
        udNumber: input.ud.number,
        status: input.ud.status,
        reason: `${input.ud.number} is ${input.ud.status}, so nothing may be drawn against it.`,
      },
    }
  }

  if (input.ud.validUntil && input.today > assertDate(input.ud.validUntil)) {
    // String comparison is safe and exact for YYYY-MM-DD, and avoids dragging a Date and
    // its timezone into a customs decision.
    return {
      ...base,
      allowed: false,
      reasonKey: 'commercial.ud.expired',
      facts: {
        udNumber: input.ud.number,
        validUntil: input.ud.validUntil,
        today: input.today,
        reason:
          `${input.ud.number} was valid until ${input.ud.validUntil} and today is ` +
          `${input.today}. Bonded material cannot leave the warehouse against an expired ` +
          `declaration — customs needs a fresh one.`,
      },
    }
  }

  const balance = computeUdBalance({
    authorizedItems: input.ud.authorizedItems,
    consumptions: input.consumptions,
  })

  const item = balance.get(input.itemRef)
  if (!item) {
    return {
      ...base,
      allowed: false,
      reasonKey: 'commercial.ud.item_not_authorized',
      facts: {
        udNumber: input.ud.number,
        itemRef: input.itemRef,
        reason:
          `${input.ud.number} does not authorise "${input.itemRef}". A declaration covers ` +
          `named materials only, and this is not one of them.`,
      },
    }
  }

  if (item.unit !== input.unit) {
    return {
      ...base,
      allowed: false,
      unit: item.unit,
      reasonKey: 'commercial.ud.unit_mismatch',
      facts: {
        udNumber: input.ud.number,
        itemRef: input.itemRef,
        authorizedUnit: item.unit,
        requestedUnit: input.unit,
        reason:
          `${input.ud.number} authorises "${input.itemRef}" in ${item.unit}, and this asks ` +
          `for ${input.unit}. Converting one to the other is a customs question, not an ` +
          `arithmetic one.`,
      },
    }
  }

  const free = toMinor(item.free)
  const shared = {
    itemRef: input.itemRef,
    unit: item.unit,
    authorized: item.authorized,
    consumed: item.consumed,
    free: item.free,
  }

  if (requested > free) {
    return {
      ...shared,
      allowed: false,
      reasonKey: 'commercial.ud.insufficient_balance',
      remainingAfter: null,
      shortfall: toDecimal(requested - free),
      facts: {
        udNumber: input.ud.number,
        itemRef: input.itemRef,
        requested: input.qty,
        free: item.free,
        shortfall: toDecimal(requested - free),
        /*
         * The sentence the storekeeper actually reads, composed where the figures exist.
         *
         * Only `reason` survives a server action's boundary (lib/action-failure.ts), and
         * these five refusals had no catalogue copy at all — the copy written for this one
         * sits under `gates.ud_balance.insufficient`, which nothing throws. So a bonded
         * overdraw, the hardest block in the building, reached the floor as a generic
         * sentence with no numbers in it. An overdraw is legal exposure; the figures are
         * how somebody decides whether to split the issue or fetch an owner.
         */
        reason:
          `${input.ud.number} has ${item.free} ${item.unit} free for "${input.itemRef}" ` +
          `and this asks for ${input.qty} — ${toDecimal(requested - free)} ${item.unit} ` +
          `more than the declaration allows. An owner can approve a deliberate overdraw.`,
      },
    }
  }

  return {
    ...shared,
    allowed: true,
    remainingAfter: toDecimal(free - requested),
    facts: {
      udNumber: input.ud.number,
      itemRef: input.itemRef,
      requested: input.qty,
      remainingAfter: toDecimal(free - requested),
    },
  }
}

/** Exported for the reconciliation report and the nightly balance alert. */
export const udQty = { toMinor, toDecimal }
