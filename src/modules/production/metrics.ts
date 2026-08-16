/**
 * Production metrics (brief 6.1). Pure — no clock, no database.
 *
 * These three numbers are quoted every morning in a meeting where somebody is held
 * responsible for them, which is why the edge cases here refuse rather than guess:
 *
 *  - a line with nobody on it has no efficiency, not 0%;
 *  - nothing checked is not the same as nothing wrong;
 *  - a line that has not run cannot be forecast to "finish today".
 *
 * Each of those wrong answers is worse than a blank, because it is plausible.
 *
 * Arithmetic is scaled BigInt throughout. SMV is quoted to two decimals and a floor's
 * whole efficiency figure hangs off it.
 */

import { QuantityError, fromMinor, toMinor } from '@/lib/quantity'

export class ProductionError extends Error {
  override readonly name = 'ProductionError'
}

/**
 * A positive decimal, as scaled BigInt (plan 2.9, audit BE-M8).
 *
 * The conversion itself is `lib/quantity`'s — one implementation, one set of tests, one
 * place to change when a rounding convention does. This file used to carry its own copy,
 * exact and unshared, which is the debt rule 4's structural half exists to remove.
 *
 * Two things it adds, and both were in the local copy rather than in the shared one:
 *
 *  - **positivity.** `lib/quantity.toMinor` accepts a negative, correctly — a stock
 *    adjustment is signed. An SMV or an output is not, and swapping in the shared function
 *    without this check would have LOOSENED what this file accepts, which is the way a
 *    consolidation quietly becomes a behaviour change.
 *  - **the error type.** `service.ts` catches `ProductionError` to skip a bad line and carry
 *    on with the rest of the floor; a `QuantityError` escaping instead would take the whole
 *    board down with a 500.
 */
function positiveMinor(value: string | number, what: string): bigint {
  let minor: bigint
  try {
    minor = toMinor(String(value).trim(), what)
  } catch (error) {
    if (error instanceof QuantityError) throw new ProductionError(error.message)
    throw error
  }

  if (minor < 0n) throw new ProductionError(`"${value}" is not a positive decimal ${what}`)
  return minor
}

const toDecimal = (minor: bigint): string => fromMinor(minor)

function divideRoundHalfUp(numerator: bigint, denominator: bigint): bigint {
  const quotient = numerator / denominator
  const remainder = numerator % denominator
  return remainder * 2n >= denominator ? quotient + 1n : quotient
}

// ─────────────────────────────────────────────────────────────────────────────
// Efficiency
// ─────────────────────────────────────────────────────────────────────────────

export interface EfficiencyResult {
  earnedMinutes: string
  availableMinutes: string
  /** Can exceed 100 — see below. */
  efficiencyPct: string
}

const MINUTES_PER_HOUR = 60

/**
 * How long the day actually was, from the hours the line recorded.
 *
 * The denominator of every efficiency figure in the product used to be the constant 480 —
 * a nominal eight-hour shift — in both the day-close and the floor board. Almost no day is
 * eight hours. A Bangladeshi line runs eight plus two of overtime, breaks for lunch, and
 * stops when the fabric runs out, and the error ran in both directions at once:
 *
 *  - **the day-close flattered.** Nordkap's L-3 sewed 1,295 pieces across NINE hours and
 *    was reported at 73.80% because it was divided by eight. The floor did 65.60%. Overtime
 *    was credited as if it were free, and the more overtime a line ran the better it looked
 *    (live test §9, F42).
 *  - **the wall board starved.** It is read mid-shift. At ten in the morning a line with two
 *    hours on the clipboard was divided by a whole shift and shown at a quarter of its real
 *    efficiency, climbing all day towards the truth and only arriving at knocking-off time.
 *
 * An hour is in this count because somebody recorded it, which means the line was manned for
 * it — including an hour it made nothing, which is a real efficiency loss and belongs in the
 * denominator. The lunch hour is absent because nobody records it, which is exactly why the
 * hourly sheet reading refuses to invent a zero for the band ruled through (`hourlySheetDraft`).
 *
 * A factory that wants to state its own shift length still can: both callers take an explicit
 * override, and planning's working-week calendar keeps its own `shiftMinutes` for FORECASTING
 * capacity. This is the other thing — measuring a day that has already happened.
 */
export function workedMinutes(hoursRecorded: number): number {
  if (!Number.isInteger(hoursRecorded) || hoursRecorded <= 0) {
    // A day nobody recorded an hour for has no length. Falling back to a nominal shift here
    // would put a 0% against a line that never ran — the same fabricated number the rest of
    // this file refuses.
    throw new ProductionError(
      `a day with no hours recorded has no length, got ${hoursRecorded}`,
    )
  }

  return hoursRecorded * MINUTES_PER_HOUR
}

/**
 * earned ÷ available, as a percentage.
 *
 * **Not capped at 100.** A line that beats its SMV is telling you the SMV is wrong, and
 * that is worth more than the flattering number a cap would show. Industrial engineering
 * re-times operations off exactly this signal.
 */
export function computeEfficiency(input: {
  /** Standard minute value per garment. */
  smv: string
  output: number
  manpower: number
  workingMinutes: number
}): EfficiencyResult {
  if (!Number.isInteger(input.output) || input.output < 0) {
    throw new ProductionError(`output must be a whole number of pieces, got ${input.output}`)
  }

  const available = BigInt(input.manpower) * BigInt(input.workingMinutes) * 100n
  if (available <= 0n) {
    // A line with nobody on it has no efficiency. Returning 0% would drag a factory
    // average down for a line that never ran, which is a different and worse lie.
    throw new ProductionError(
      'available minutes must be positive — a line with no manpower has no efficiency',
    )
  }

  const earned = positiveMinor(input.smv, 'SMV') * BigInt(input.output)

  return {
    earnedMinutes: toDecimal(earned),
    availableMinutes: toDecimal(available),
    efficiencyPct: toDecimal(divideRoundHalfUp(earned * 10_000n, available)),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DHU
// ─────────────────────────────────────────────────────────────────────────────

export interface DhuResult {
  checked: number
  defects: number
  /** Defects per hundred units. Exceeds 100 when garments carry several defects each. */
  dhu: string
}

/**
 * Defects per hundred units.
 *
 * Counts DEFECTS, not defective garments — one garment can carry three. Conflating the
 * two understates a quality problem by exactly the amount that matters.
 */
export function computeDhu(input: { checked: number; defects: number }): DhuResult {
  if (!Number.isInteger(input.checked) || input.checked <= 0) {
    // Nothing checked is not the same as nothing wrong. A board showing 0.00 DHU for an
    // unchecked line is worse than a blank, because it looks like good news.
    throw new ProductionError('DHU needs a positive checked quantity')
  }
  if (!Number.isInteger(input.defects) || input.defects < 0) {
    throw new ProductionError(`defects must be a non-negative whole number, got ${input.defects}`)
  }

  const dhu = divideRoundHalfUp(BigInt(input.defects) * 100n * 100n, BigInt(input.checked))
  return { checked: input.checked, defects: input.defects, dhu: toDecimal(dhu) }
}

// ─────────────────────────────────────────────────────────────────────────────
// Run rate
// ─────────────────────────────────────────────────────────────────────────────

export interface TrailingDay {
  date: string
  output: number
}

export interface ForecastResult {
  ratePerDay: string
  daysNeeded: number | null
  forecastDate: string | null
  /** How much a milestone would be missed by. Zero when it would not. */
  slipDays: number
  atRisk: boolean
  /** `none` when the line has not run; `low` on a single day of data. */
  confidence: 'none' | 'low' | 'normal'
}

const MS_PER_DAY = 86_400_000
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function addDays(date: string, days: number): string {
  if (!ISO_DATE.test(date)) throw new ProductionError(`"${date}" is not a calendar date`)
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * MS_PER_DAY).toISOString().slice(0, 10)
}

const diffDays = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY)

/**
 * When will this order finish, at the rate it has actually been running?
 *
 * The trailing window is the honest input: a line's plan says what it should do, the last
 * three days say what it does. Comparing the forecast against the TNA sewing milestone is
 * what turns that into an alert somebody can act on.
 */
export function forecastCompletion(input: {
  remainingQty: number
  trailing: readonly TrailingDay[]
  /** The day the forecast is made from — usually the last day with output. */
  fromDate: string
  /** TNA sewing-end milestone, when there is one to compare against. */
  milestoneDate?: string | null
}): ForecastResult {
  if (input.trailing.length === 0) {
    throw new ProductionError('a run-rate forecast needs at least one day of output')
  }
  if (!Number.isInteger(input.remainingQty) || input.remainingQty < 0) {
    throw new ProductionError(`remaining quantity must be a whole number, got ${input.remainingQty}`)
  }

  const total = input.trailing.reduce((sum, day) => sum + day.output, 0)
  // Divided by the WINDOW, not by the days that happened to run. Callers pass a day the
  // floor was idle as an explicit zero, and it has to stay in the denominator: a line that
  // made 1,200 on two of the last three days runs at 800 a day, not 1,200. Averaging only
  // the good days forecasts a date the floor has already demonstrated it cannot hit.
  const rateMinor = divideRoundHalfUp(BigInt(total) * 100n, BigInt(input.trailing.length))

  // Confidence, though, is about how much evidence there is — so it counts the days that
  // actually reported. A three-day window with one day of output is still one day of
  // evidence, however wide the window was.
  const daysWithOutput = input.trailing.filter((day) => day.output > 0).length
  const confidence: ForecastResult['confidence'] =
    total === 0 ? 'none' : daysWithOutput < 2 ? 'low' : 'normal'

  if (total === 0) {
    // Rate zero. "Completes today" is the dangerous answer and Infinity is not an answer,
    // so the honest one is that there is no forecast.
    return {
      ratePerDay: toDecimal(rateMinor),
      daysNeeded: null,
      forecastDate: null,
      slipDays: 0,
      atRisk: Boolean(input.milestoneDate),
      confidence,
    }
  }

  // Ceiling: a part day is still a day on a shipping calendar.
  const daysNeeded = Number(
    (BigInt(input.remainingQty) * 100n + rateMinor - 1n) / rateMinor,
  )
  const forecastDate = addDays(input.fromDate, daysNeeded)

  const slipDays = input.milestoneDate
    ? Math.max(0, diffDays(input.milestoneDate, forecastDate))
    : 0

  return {
    ratePerDay: toDecimal(rateMinor),
    daysNeeded,
    forecastDate,
    slipDays,
    atRisk: slipDays > 0,
    confidence,
  }
}
