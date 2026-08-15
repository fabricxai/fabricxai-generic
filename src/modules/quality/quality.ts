/**
 * Quality arithmetic (brief 7.1 §Operations). Pure — no database, no clock.
 *
 * The brief is explicit that AQL is "computed server-side from tables (never client
 * math)", and the sampling plan therefore comes from seeded, versioned rows rather than
 * from anything in this file. What lives here is the judgement applied to those rows, and
 * the four things that judgement gets wrong in every system that reimplements it:
 *
 *  1. **Major and minor defects are two independent verdicts.** A buyer specifies "2.5
 *     major / 4.0 minor". Netting them into one count is how a shipment passes on eight
 *     major defects against a combined allowance of seventeen.
 *  2. **A critical defect has no acceptance number.** A needle in a garment fails on
 *     sight.
 *  3. **Fabric is judged as a RATE** — points per hundred square yards. The same twelve
 *     points is a pass on a wide roll and a fail on a narrow one.
 *  4. **Measurement tolerances are asymmetric.** +1/2" and −1/4" is normal; treating
 *     tolerance as one number rejects half the garments that should pass.
 */
import { fromMinor, toMinor } from '@/lib/quantity'
import { compositeKey, splitKey } from '@/lib/keys'

export class QualityError extends Error {
  override readonly name = 'QualityError'
}

/**
 * The fallback operation list for inline capture, in sewing order.
 *
 * Only used on a line that has never been checked before — after that the screen offers what
 * the line has actually been checked against. It is a starting point so the first QC of a new
 * line is not staring at an empty list, not a definition of how anything is made: every
 * factory sews a different bulletin, and the screen always allows typing an operation in.
 */
export const STANDARD_SEWING_OPERATIONS: readonly string[] = [
  'Shoulder join',
  'Collar attach',
  'Sleeve attach',
  'Side seam',
  'Armhole topstitch',
  'Cuff attach',
  'Placket',
  'Hem',
  'Button attach',
  'Buttonhole',
  'Label attach',
  'Final trim',
]

const DECIMAL = /^\d+(\.\d+)?$/

function assertWholeNonNegative(value: number, what: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new QualityError(`${what} must be a whole number of zero or more, got ${value}`)
  }
  return value
}

function assertDecimal(value: string, what: string): string {
  if (!DECIMAL.test(value)) throw new QualityError(`"${value}" is not a decimal ${what}`)
  return value
}

// ─────────────────────────────────────────────────────────────────────────────
// AQL — the plan comes from the table, the judgement lives here
// ─────────────────────────────────────────────────────────────────────────────

export type InspectionLevel = 'I' | 'II' | 'III'

/** One seeded row of ANSI/ASQ Z1.4, as `aql_tables` stores it. */
export interface AqlTableRow {
  inspectionLevel: string
  aqlLevel: string
  lotFrom: number
  lotTo: number
  sampleSize: number
  accept: number
  reject: number
}

export interface AqlPlan {
  lotQty: number
  sampleSize: number
  /** True when the table's sample size met or exceeded the lot, so everything is checked. */
  hundredPercent: boolean
  inspectionLevel: string
  majorAql: string
  majorAccept: number
  majorReject: number
  minorAql: string
  minorAccept: number
  minorReject: number
}

function findRow(
  table: readonly AqlTableRow[],
  input: { inspectionLevel: string; aqlLevel: string; lotQty: number },
): AqlTableRow {
  const row = table.find(
    (r) =>
      r.inspectionLevel === input.inspectionLevel &&
      r.aqlLevel === input.aqlLevel &&
      input.lotQty >= r.lotFrom &&
      input.lotQty <= r.lotTo,
  )

  if (!row) {
    // Substituting the nearest row would silently apply a stricter or looser standard than
    // the buyer's terms. A missing row is a seeding problem, not a rounding one.
    throw new QualityError(
      `no AQL row for level ${input.inspectionLevel}, AQL ${input.aqlLevel}, lot ${input.lotQty}`,
    )
  }
  return row
}

/**
 * Resolve the sampling plan for a lot.
 *
 * Major and minor are looked up SEPARATELY, because they are separate AQL levels against
 * the same physical sample. One inspection, one sample size, two acceptance numbers.
 */
export function resolveAqlPlan(
  table: readonly AqlTableRow[],
  input: {
    lotQty: number
    inspectionLevel: string
    majorAql: string
    minorAql: string
  },
): AqlPlan {
  if (!Number.isInteger(input.lotQty) || input.lotQty <= 0) {
    throw new QualityError(`lot quantity must be a positive whole number, got ${input.lotQty}`)
  }

  const major = findRow(table, {
    inspectionLevel: input.inspectionLevel,
    aqlLevel: input.majorAql,
    lotQty: input.lotQty,
  })
  const minor = findRow(table, {
    inspectionLevel: input.inspectionLevel,
    aqlLevel: input.minorAql,
    lotQty: input.lotQty,
  })

  if (major.sampleSize !== minor.sampleSize) {
    // Both AQL levels index the same sample-size code letter for a given lot, so a
    // mismatch means the seeded table is inconsistent. Picking one would report a plan
    // that was not the one inspected.
    throw new QualityError(
      `AQL table disagrees on sample size for lot ${input.lotQty}: ` +
        `${input.majorAql} says ${major.sampleSize}, ${input.minorAql} says ${minor.sampleSize}`,
    )
  }

  // You cannot draw 200 pieces from a lot of 8. Sampling 8 while reporting a plan of 200
  // would make the acceptance number meaningless.
  const hundredPercent = major.sampleSize >= input.lotQty
  const sampleSize = hundredPercent ? input.lotQty : major.sampleSize

  return {
    lotQty: input.lotQty,
    sampleSize,
    hundredPercent,
    inspectionLevel: input.inspectionLevel,
    majorAql: input.majorAql,
    majorAccept: major.accept,
    majorReject: major.reject,
    minorAql: input.minorAql,
    minorAccept: minor.accept,
    minorReject: minor.reject,
  }
}

export interface DefectCounts {
  critical: number
  major: number
  minor: number
}

export interface AqlReason {
  code: 'critical_defect' | 'major_over_aql' | 'minor_over_aql'
  found: number
  accept: number | null
  aqlLevel: string | null
}

export interface AqlOutcome {
  verdict: 'pass' | 'fail'
  reasons: AqlReason[]
  plan: AqlPlan
}

/**
 * Judge an inspection against its plan.
 *
 * Three independent tests, all of them reported. A verdict that stopped at the first
 * failure would tell an inspector to fix the majors and re-present a lot that also fails
 * on minors.
 */
export function aqlVerdict(plan: AqlPlan, found: DefectCounts): AqlOutcome {
  assertWholeNonNegative(found.critical, 'critical defect count')
  assertWholeNonNegative(found.major, 'major defect count')
  assertWholeNonNegative(found.minor, 'minor defect count')

  for (const [label, count] of [
    ['critical', found.critical],
    ['major', found.major],
    ['minor', found.minor],
  ] as const) {
    if (count > plan.sampleSize) {
      // More defects of one class than pieces inspected means somebody counted against
      // the lot rather than the sample, and comparing that to the table is meaningless.
      throw new QualityError(
        `${count} ${label} defects in a sample of ${plan.sampleSize} — counted against the lot?`,
      )
    }
  }

  const reasons: AqlReason[] = []

  if (found.critical > 0) {
    // A needle in a garment or a choking hazard. There is no acceptance number.
    reasons.push({
      code: 'critical_defect',
      found: found.critical,
      accept: 0,
      aqlLevel: null,
    })
  }

  if (found.major > plan.majorAccept) {
    reasons.push({
      code: 'major_over_aql',
      found: found.major,
      accept: plan.majorAccept,
      aqlLevel: plan.majorAql,
    })
  }

  if (found.minor > plan.minorAccept) {
    reasons.push({
      code: 'minor_over_aql',
      found: found.minor,
      accept: plan.minorAccept,
      aqlLevel: plan.minorAql,
    })
  }

  return { verdict: reasons.length === 0 ? 'pass' : 'fail', reasons, plan }
}

// ─────────────────────────────────────────────────────────────────────────────
// DHU
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Defects per hundred units.
 *
 * Deliberately uncapped: one garment can carry three defects, so a line at 150 DHU is
 * real and is in serious trouble. Clamping at 100 would hide exactly how much.
 */
export function dhu(input: { defects: number; checked: number }): string {
  assertWholeNonNegative(input.defects, 'defect count')
  assertWholeNonNegative(input.checked, 'checked count')

  if (input.checked === 0) {
    // Zero checked is not zero defects — it is no measurement, and a 0 on a DHU trend
    // reads as a perfect day.
    throw new QualityError('nothing was checked — DHU is undefined, not zero')
  }

  return ratio(BigInt(input.defects) * 100n, BigInt(input.checked))
}

// ─────────────────────────────────────────────────────────────────────────────
// The 4-point system
// ─────────────────────────────────────────────────────────────────────────────

/** Defect counts by penalty band. A band-3 defect is worth 3 points. */
export interface FourPointBands {
  1: number
  2: number
  3: number
  4: number
}

export interface FourPointOutcome {
  totalPoints: number
  pointsPer100SqYd: string
  result: 'pass' | 'fail'
  thresholdPer100SqYd: string
}

/**
 * Score a fabric roll (brief entity `fabric_inspections.points_4`).
 *
 * `points × 3600 / (yards × inches)` converts a raw count into points per hundred square
 * yards: 100 sq yd is 129,600 sq in, and a yard of cloth is 36 in long, so the 129,600/36
 * folds to 3,600. Judging on the raw count would call a narrow roll and a wide one the
 * same when they carry the same defects but not the same cloth.
 *
 * The threshold is INCLUSIVE — 40 points/100 sq yd is the acceptance limit, and rejecting
 * exactly at the limit fails rolls the buyer accepts.
 */
export function fourPointResult(input: {
  points: FourPointBands
  lengthYards: string
  widthInches: string
  maxPointsPer100SqYd: string
}): FourPointOutcome {
  const bands = [1, 2, 3, 4] as const
  let totalPoints = 0
  for (const band of bands) {
    assertWholeNonNegative(input.points[band], `band-${band} defect count`)
    totalPoints += input.points[band] * band
  }

  const length = toMinor(assertDecimal(input.lengthYards, 'length'))
  const width = toMinor(assertDecimal(input.widthInches, 'width'))

  if (length === 0n || width === 0n) {
    throw new QualityError('a roll with no length or no width has no area to score against')
  }

  // `length` and `width` each carry two minor digits, so their product carries four —
  // hence the 10,000 that cancels it. The further 1,000 computes one extra digit so the
  // half-up rounding below decides on a digit that was actually calculated.
  //   points × 3600 × 10^4 × 10^3
  const numerator = BigInt(totalPoints) * 36_000_000_000n
  const pointsPer100SqYd = fromMinor((numerator / (length * width) + 5n) / 10n)
  const threshold = assertDecimal(input.maxPointsPer100SqYd, 'threshold')

  return {
    totalPoints,
    pointsPer100SqYd,
    result: toMinor(pointsPer100SqYd) <= toMinor(threshold) ? 'pass' : 'fail',
    thresholdPer100SqYd: threshold,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurements
// ─────────────────────────────────────────────────────────────────────────────

export interface MeasurementPoint {
  name: string
  spec: string
  tolPlus: string
  tolMinus: string
}

export interface MeasurementDeviation {
  name: string
  spec: string
  value: string
  /** Signed: negative means under spec. */
  deviation: string
  allowedPlus: string
  allowedMinus: string
}

export interface MeasurementOutcome {
  passed: boolean
  deviations: MeasurementDeviation[]
  outOfTolerance: MeasurementDeviation[]
  /** Spec points with no value recorded. An unmeasured point is not a good point. */
  missing: string[]
  /** Values recorded against points the spec does not define. */
  unknownPoints: string[]
}

/**
 * Compare measured values against a spec.
 *
 * Tolerances are asymmetric by nature — a chest at +1/2" is fine and at −1/2" is not, and
 * a single tolerance number would reject half the garments that should pass.
 *
 * A missing value fails the check rather than being skipped: a partial measurement that
 * reads as clean is worse than one that says it is partial.
 */
export function measurementVariance(
  points: readonly MeasurementPoint[],
  values: Readonly<Record<string, string>>,
): MeasurementOutcome {
  if (points.length === 0) {
    throw new QualityError('no measurement points — there is nothing to check against')
  }

  const deviations: MeasurementDeviation[] = []
  const outOfTolerance: MeasurementDeviation[] = []
  const missing: string[] = []

  for (const point of points) {
    const raw = values[point.name]
    if (raw === undefined) {
      missing.push(point.name)
      continue
    }

    const spec = toMinor(assertDecimal(point.spec, `spec for ${point.name}`))
    const measured = toMinor(assertDecimal(raw, `value for ${point.name}`))
    const plus = toMinor(assertDecimal(point.tolPlus, `+tolerance for ${point.name}`))
    const minus = toMinor(assertDecimal(point.tolMinus, `−tolerance for ${point.name}`))

    const delta = measured - spec
    const deviation: MeasurementDeviation = {
      name: point.name,
      spec: point.spec,
      value: raw,
      deviation: fromMinor(delta),
      allowedPlus: point.tolPlus,
      allowedMinus: point.tolMinus,
    }
    deviations.push(deviation)

    // Inclusive on both sides: exactly on the limit is in spec.
    const withinTolerance = delta >= 0n ? delta <= plus : -delta <= minus
    if (!withinTolerance) outOfTolerance.push(deviation)
  }

  const specNames = new Set(points.map((p) => p.name))
  const unknownPoints = Object.keys(values).filter((name) => !specNames.has(name))

  return {
    passed: outOfTolerance.length === 0 && missing.length === 0,
    deviations,
    outOfTolerance,
    missing,
    unknownPoints,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Repeat-defect pattern (brief §Jobs)
// ─────────────────────────────────────────────────────────────────────────────

export interface DefectOccurrence {
  date: string
  code: string
  operation: string
}

export interface DefectRun {
  code: string
  operation: string
  days: number
  from: string
  to: string
}

/**
 * Find defect codes recurring at the same operation on consecutive days.
 *
 * A gap breaks the run, deliberately. The alert exists to surface a problem that is STILL
 * there — three occurrences with a clean day in the middle is noise, and an alert that
 * fires on noise stops being read.
 *
 * Several occurrences on one day count as one day: a bad day is a bad day, not a pattern.
 */
export function repeatDefectRuns(
  occurrences: readonly DefectOccurrence[],
  options: { minConsecutiveDays: number },
): DefectRun[] {
  if (!Number.isInteger(options.minConsecutiveDays) || options.minConsecutiveDays < 2) {
    throw new QualityError('a repeat pattern needs at least two consecutive days')
  }

  const byKey = new Map<string, Set<string>>()
  for (const occurrence of occurrences) {
    const key = compositeKey(occurrence.code, occurrence.operation)
    const dates = byKey.get(key) ?? new Set<string>()
    dates.add(occurrence.date)
    byKey.set(key, dates)
  }

  const runs: DefectRun[] = []

  for (const [key, dateSet] of byKey) {
    const [code = '', operation = ''] = splitKey(key)
    const dates = [...dateSet].sort()

    let runStart = 0
    for (let i = 1; i <= dates.length; i += 1) {
      const consecutive = i < dates.length && dayGap(dates[i - 1]!, dates[i]!) === 1
      if (consecutive) continue

      const days = i - runStart
      if (days >= options.minConsecutiveDays) {
        runs.push({ code, operation, days, from: dates[runStart]!, to: dates[i - 1]! })
      }
      runStart = i
    }
  }

  // Longest run first — the most entrenched problem is the one to look at.
  return runs.sort((a, b) => b.days - a.days)
}

function dayGap(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  if (Number.isNaN(a) || Number.isNaN(b)) {
    throw new QualityError(`"${from}" or "${to}" is not a date`)
  }
  return Math.round((b - a) / 86_400_000)
}

// ─────────────────────────────────────────────────────────────────────────────
// Exact decimal helpers — rates are numeric(x,2) and never floats
// ─────────────────────────────────────────────────────────────────────────────

const SCALE = 100n

/** `a / b` at two decimals, rounded half-up once. */
function ratio(a: bigint, b: bigint): string {
  if (b === 0n) throw new QualityError('division by zero')
  return fromMinor((a * SCALE * 10n / b + 5n) / 10n)
}

/**
 * What the 4-point gate says when it holds an issue back.
 *
 * Composed rather than filed as catalogue copy with `{rolls}` in it: only `reason` survives
 * a server action's boundary (lib/action-failure.ts), so the placeholders were reaching the
 * floor as literal braces. The roll numbers ARE the refusal — a storekeeper's next act is to
 * pull those exact rolls off the issue and send the rest.
 *
 * Long lists are trimmed. Twenty roll numbers in a toast is a wall nobody reads at a
 * delivery bay; the first few and a count is what someone can act on, and the full list is
 * in the inspection screen.
 */
export function fabricInspectionRefusal(
  kind: 'failed' | 'not_inspected',
  facts: { rolls: readonly string[]; points?: string | null },
): string {
  const shown = facts.rolls.slice(0, 3).join(', ')
  const rest = facts.rolls.length - 3
  const list = rest > 0 ? `${shown} and ${rest} more` : shown
  const one = facts.rolls.length === 1
  const plural = one ? 'roll' : 'rolls'

  if (kind === 'failed') {
    const points = facts.points ? ` at ${facts.points} points per 100 yd²` : ''
    return (
      `${facts.rolls.length} ${plural} failed 4-point inspection${points}: ${list}. ` +
      `Cloth this far out of grade becomes a buyer claim after it is cut.`
    )
  }

  return (
    `${facts.rolls.length} ${plural} ${one ? 'has' : 'have'} not been 4-point inspected ` +
    `yet: ${list}. ` +
    `Inspection comes before cutting, not after — a fault found on the table is fabric ` +
    `already paid for.`
  )
}
