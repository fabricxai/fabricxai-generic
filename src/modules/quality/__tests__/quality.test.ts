/**
 * Quality vectors — written before the implementation.
 *
 * Four separate arithmetics live in this module and each has a well-known way of being
 * wrong:
 *
 *  1. **AQL** decides whether a shipment goes. The brief says it is computed server-side
 *     from seeded tables, "never client math" — and the mistake that survives every
 *     rewrite is netting major and minor defects into one count. A buyer specifies
 *     "2.5 major / 4.0 minor"; those are two independent verdicts, and a critical defect
 *     fails on sight regardless of either.
 *  2. **The 4-point system** for fabric is a points-per-100-square-yards rate, not a
 *     count. The same twelve points is a pass on a wide roll and a fail on a narrow one.
 *  3. **Measurement tolerances are asymmetric.** +1/2" and −1/4" is normal, and treating
 *     tolerance as a single number rejects half the garments that should pass.
 *  4. **DHU** is defects per hundred UNITS, not per hundred defect opportunities, and one
 *     garment can carry three defects — so DHU above 100 is real and must not be clamped.
 */
import { describe, expect, it } from 'vitest'

import {
  aqlVerdict,
  styleCodeFrom,
  dhu,
  fabricInspectionRefusal,
  fourPointResult,
  measurementVariance,
  QualityError,
  repeatDefectRuns,
  resolveAqlPlan,
  type AqlTableRow,
  type MeasurementPoint,
} from '../quality'

/** A slice of ANSI/ASQ Z1.4 general inspection level II, as the seed stores it. */
const TABLE: AqlTableRow[] = [
  { inspectionLevel: 'II', aqlLevel: '2.5', lotFrom: 1201, lotTo: 3200, sampleSize: 125, accept: 7, reject: 8 },
  { inspectionLevel: 'II', aqlLevel: '4.0', lotFrom: 1201, lotTo: 3200, sampleSize: 125, accept: 10, reject: 11 },
  { inspectionLevel: 'II', aqlLevel: '2.5', lotFrom: 3201, lotTo: 10000, sampleSize: 200, accept: 10, reject: 11 },
  { inspectionLevel: 'II', aqlLevel: '4.0', lotFrom: 3201, lotTo: 10000, sampleSize: 200, accept: 14, reject: 15 },
  { inspectionLevel: 'II', aqlLevel: '2.5', lotFrom: 1, lotTo: 8, sampleSize: 200, accept: 10, reject: 11 },
  { inspectionLevel: 'II', aqlLevel: '4.0', lotFrom: 1, lotTo: 8, sampleSize: 200, accept: 14, reject: 15 },
]

const plan = (lotQty: number) =>
  resolveAqlPlan(TABLE, {
    lotQty,
    inspectionLevel: 'II',
    majorAql: '2.5',
    minorAql: '4.0',
  })

describe('resolveAqlPlan · the sampling plan comes from the table', () => {
  it('1 · picks the row whose lot range contains the lot', () => {
    const result = plan(2000)

    expect(result.sampleSize).toBe(125)
    expect(result.majorAccept).toBe(7)
    expect(result.minorAccept).toBe(10)
  })

  it('2 · a bigger lot gets a bigger sample', () => {
    expect(plan(5000).sampleSize).toBe(200)
  })

  it('3 · major and minor come from DIFFERENT rows of the same table', () => {
    // "2.5 major / 4.0 minor" is one inspection against two acceptance numbers. Reading
    // one row and applying it to both is how a shipment passes on 10 major defects.
    const result = plan(2000)
    expect(result.majorAccept).not.toBe(result.minorAccept)
    expect(result.majorAql).toBe('2.5')
    expect(result.minorAql).toBe('4.0')
  })

  it('4 · inspects the whole lot when the sample size exceeds it', () => {
    // The table says 200 for this AQL, but there are only 8 garments. You cannot draw 200
    // pieces from a lot of 8, and quietly sampling 8 while reporting a plan of 200 makes
    // the acceptance number meaningless.
    const result = plan(8)

    expect(result.sampleSize).toBe(8)
    expect(result.hundredPercent).toBe(true)
  })

  it('5 · refuses a lot size no row covers rather than guessing the nearest', () => {
    expect(() =>
      resolveAqlPlan(TABLE, {
        lotQty: 50_000,
        inspectionLevel: 'II',
        majorAql: '2.5',
        minorAql: '4.0',
      }),
    ).toThrow(QualityError)
  })

  it('6 · refuses an AQL level the table does not carry', () => {
    // A buyer term of "1.0 AQL" against a table that only has 2.5 and 4.0 is a missing
    // seed, not a reason to substitute a stricter or looser number.
    expect(() =>
      resolveAqlPlan(TABLE, {
        lotQty: 2000,
        inspectionLevel: 'II',
        majorAql: '1.0',
        minorAql: '4.0',
      }),
    ).toThrow(/1\.0/)
  })

  it('7 · refuses a non-positive lot', () => {
    expect(() => plan(0)).toThrow(QualityError)
  })
})

describe('aqlVerdict · two independent verdicts, plus zero tolerance', () => {
  it('8 · passes when both counts are at or under their acceptance numbers', () => {
    const result = aqlVerdict(plan(2000), { critical: 0, major: 7, minor: 10 })

    expect(result.verdict).toBe('pass')
    expect(result.reasons).toEqual([])
  })

  it('9 · fails on one more major than allowed', () => {
    const result = aqlVerdict(plan(2000), { critical: 0, major: 8, minor: 0 })

    expect(result.verdict).toBe('fail')
    expect(result.reasons[0]).toMatchObject({
      code: 'major_over_aql',
      found: 8,
      accept: 7,
      aqlLevel: '2.5',
    })
  })

  it('10 · fails on minors alone, even with no majors at all', () => {
    const result = aqlVerdict(plan(2000), { critical: 0, major: 0, minor: 11 })

    expect(result.verdict).toBe('fail')
    expect(result.reasons.map((r) => r.code)).toEqual(['minor_over_aql'])
  })

  it('11 · does NOT net majors against minors', () => {
    // 8 major and 0 minor is a fail. A single "total defects = 8 against a combined
    // allowance of 17" reading would pass it, and the shipment would go.
    const netted = aqlVerdict(plan(2000), { critical: 0, major: 8, minor: 0 })
    expect(netted.verdict).toBe('fail')
  })

  it('12 · one critical defect fails whatever the counts say', () => {
    // A critical defect is a needle in a garment or a choking hazard. There is no
    // acceptance number for it.
    const result = aqlVerdict(plan(2000), { critical: 1, major: 0, minor: 0 })

    expect(result.verdict).toBe('fail')
    expect(result.reasons[0]!.code).toBe('critical_defect')
  })

  it('13 · reports every reason, not just the first', () => {
    const result = aqlVerdict(plan(2000), { critical: 1, major: 20, minor: 20 })
    expect(result.reasons.map((r) => r.code)).toEqual([
      'critical_defect',
      'major_over_aql',
      'minor_over_aql',
    ])
  })

  it('14 · refuses defect counts larger than the sample inspected', () => {
    // 200 major defects in a 125-piece sample means somebody counted defects against the
    // lot, not the sample. Accepting it would compare the wrong number to the table.
    expect(() => aqlVerdict(plan(2000), { critical: 0, major: 130, minor: 0 })).toThrow(
      QualityError,
    )
  })

  it('15 · a negative count is refused, not treated as zero', () => {
    expect(() => aqlVerdict(plan(2000), { critical: 0, major: -1, minor: 0 })).toThrow(
      QualityError,
    )
  })
})

describe('dhu · defects per hundred units', () => {
  it('16 · is defects over units checked, times one hundred', () => {
    // 12 defects in 400 garments = 3 DHU.
    expect(dhu({ defects: 12, checked: 400 })).toBe('3.00')
  })

  it('17 · can exceed 100 and is not clamped', () => {
    // One garment can carry three defects. A line running at 150 DHU is in trouble, and
    // capping the number at 100 would hide exactly how much.
    expect(dhu({ defects: 600, checked: 400 })).toBe('150.00')
  })

  it('18 · is exact to two decimals', () => {
    // 7 / 300 × 100 = 2.333…
    expect(dhu({ defects: 7, checked: 300 })).toBe('2.33')
  })

  it('19 · refuses to divide by nothing checked', () => {
    // Zero checked with zero defects is not 0% quality — it is no measurement at all,
    // and a zero on a DHU trend reads as a perfect day.
    expect(() => dhu({ defects: 0, checked: 0 })).toThrow(QualityError)
  })
})

describe('fourPointResult · fabric is a RATE, not a count', () => {
  const roll = { lengthYards: '100', widthInches: '60' }

  it('20 · converts points to points per hundred square yards', () => {
    // 20 points on 100 yd × 60" → 20 × 3600 / 6000 = 12 points/100 sq yd.
    const result = fourPointResult({
      ...roll,
      points: { 1: 8, 2: 6, 3: 0, 4: 0 },
      maxPointsPer100SqYd: '40',
    })

    // 8×1 + 6×2 = 20 raw points.
    expect(result.totalPoints).toBe(20)
    expect(result.pointsPer100SqYd).toBe('12.00')
    expect(result.result).toBe('pass')
  })

  it('21 · weights each defect band', () => {
    // 1 + 2 + 3 + 4 = 10 for one defect of each size.
    const result = fourPointResult({
      ...roll,
      points: { 1: 1, 2: 1, 3: 1, 4: 1 },
      maxPointsPer100SqYd: '40',
    })
    expect(result.totalPoints).toBe(10)
  })

  it('22 · the same points fail on a narrower roll', () => {
    // Identical defects, less cloth: the rate goes up. A pass/fail on raw point count
    // would call these two rolls the same.
    // 16 band-4 defects = 64 points on 100 linear yards.
    //   60" wide → 64 × 3600 / 6000 = 38.40 → pass
    //   36" wide → 64 × 3600 / 3600 = 64.00 → fail
    const wide = fourPointResult({
      lengthYards: '100',
      widthInches: '60',
      points: { 1: 0, 2: 0, 3: 0, 4: 16 },
      maxPointsPer100SqYd: '40',
    })
    const narrow = fourPointResult({
      lengthYards: '100',
      widthInches: '36',
      points: { 1: 0, 2: 0, 3: 0, 4: 16 },
      maxPointsPer100SqYd: '40',
    })

    expect(wide.result).toBe('pass')
    expect(wide.pointsPer100SqYd).toBe('38.40')
    expect(narrow.result).toBe('fail')
    expect(narrow.pointsPer100SqYd).toBe('64.00')
  })

  it('23 · exactly at the threshold passes', () => {
    // 40 points/100 sq yd is the acceptance limit, and a limit is inclusive. Rejecting at
    // exactly the limit fails rolls the buyer accepted.
    const result = fourPointResult({
      lengthYards: '100',
      widthInches: '36',
      points: { 1: 0, 2: 0, 3: 0, 4: 10 },
      maxPointsPer100SqYd: '40',
    })

    expect(result.pointsPer100SqYd).toBe('40.00')
    expect(result.result).toBe('pass')
  })

  it('24 · refuses a roll with no measurable area', () => {
    expect(() =>
      fourPointResult({
        lengthYards: '0',
        widthInches: '60',
        points: { 1: 1, 2: 0, 3: 0, 4: 0 },
        maxPointsPer100SqYd: '40',
      }),
    ).toThrow(QualityError)
  })

  it('25 · refuses a fractional defect count', () => {
    expect(() =>
      fourPointResult({
        ...roll,
        points: { 1: 1.5, 2: 0, 3: 0, 4: 0 },
        maxPointsPer100SqYd: '40',
      }),
    ).toThrow(QualityError)
  })
})

describe('measurementVariance · tolerances are asymmetric', () => {
  const points: MeasurementPoint[] = [
    { name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.25' },
    { name: 'Length', spec: '72.00', tolPlus: '1.00', tolMinus: '1.00' },
  ]

  it('26 · accepts a value inside an asymmetric band', () => {
    // +1/2" is allowed, −1/4" is not. 52.40 is in; the same deviation below would be out.
    const result = measurementVariance(points, { Chest: '52.40', Length: '72.00' })

    expect(result.outOfTolerance).toEqual([])
    expect(result.passed).toBe(true)
  })

  it('27 · rejects the same deviation on the tighter side', () => {
    const result = measurementVariance(points, { Chest: '51.60', Length: '72.00' })

    expect(result.passed).toBe(false)
    expect(result.outOfTolerance[0]).toMatchObject({
      name: 'Chest',
      value: '51.60',
      deviation: '-0.40',
      allowedMinus: '0.25',
    })
  })

  it('28 · exactly on the tolerance limit passes', () => {
    const result = measurementVariance(points, { Chest: '52.50', Length: '71.00' })
    expect(result.passed).toBe(true)
  })

  it('29 · a point with no value recorded is reported as missing, not as passing', () => {
    // An unmeasured point is not a good point. Silently passing it would let a partial
    // check read as a clean one.
    const result = measurementVariance(points, { Chest: '52.00' })

    expect(result.passed).toBe(false)
    expect(result.missing).toEqual(['Length'])
  })

  it('30 · reports a value for a point that is not in the spec', () => {
    const result = measurementVariance(points, {
      Chest: '52.00',
      Length: '72.00',
      Sleeve: '24.00',
    })
    expect(result.unknownPoints).toEqual(['Sleeve'])
  })
})

describe('repeatDefectRuns · the pattern alert', () => {
  const day = (date: string, code: string, operation: string) => ({ date, code, operation })

  it('31 · flags the same code and operation on three consecutive days', () => {
    const runs = repeatDefectRuns(
      [
        day('2026-07-28', 'BROKEN_STITCH', 'side-seam'),
        day('2026-07-29', 'BROKEN_STITCH', 'side-seam'),
        day('2026-07-30', 'BROKEN_STITCH', 'side-seam'),
      ],
      { minConsecutiveDays: 3 },
    )

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      code: 'BROKEN_STITCH',
      operation: 'side-seam',
      days: 3,
      from: '2026-07-28',
      to: '2026-07-30',
    })
  })

  it('32 · a gap breaks the run', () => {
    // Three occurrences are not a pattern if the middle day was clean. The point of the
    // alert is a problem that is still there.
    const runs = repeatDefectRuns(
      [
        day('2026-07-27', 'BROKEN_STITCH', 'side-seam'),
        day('2026-07-29', 'BROKEN_STITCH', 'side-seam'),
        day('2026-07-30', 'BROKEN_STITCH', 'side-seam'),
      ],
      { minConsecutiveDays: 3 },
    )
    expect(runs).toEqual([])
  })

  it('33 · the same code at a different operation is a different problem', () => {
    const runs = repeatDefectRuns(
      [
        day('2026-07-28', 'BROKEN_STITCH', 'side-seam'),
        day('2026-07-29', 'BROKEN_STITCH', 'hem'),
        day('2026-07-30', 'BROKEN_STITCH', 'side-seam'),
      ],
      { minConsecutiveDays: 3 },
    )
    expect(runs).toEqual([])
  })

  it('34 · several occurrences on one day count as one day', () => {
    const runs = repeatDefectRuns(
      [
        day('2026-07-28', 'SKIP_STITCH', 'hem'),
        day('2026-07-28', 'SKIP_STITCH', 'hem'),
        day('2026-07-29', 'SKIP_STITCH', 'hem'),
      ],
      { minConsecutiveDays: 3 },
    )
    expect(runs).toEqual([])
  })

  it('35 · reports the longest run and keeps counting past the threshold', () => {
    const runs = repeatDefectRuns(
      ['2026-07-26', '2026-07-27', '2026-07-28', '2026-07-29', '2026-07-30'].map((d) =>
        day(d, 'OIL_STAIN', 'finishing'),
      ),
      { minConsecutiveDays: 3 },
    )

    expect(runs[0]!.days).toBe(5)
  })
})

describe('fabricInspectionRefusal · the roll numbers ARE the refusal', () => {
  it('names the rolls a storekeeper must pull off the issue', () => {
    // Composed rather than filed as copy with {rolls} in it: only `reason` survives a server
    // action's boundary, so the placeholders were reaching the delivery bay as braces.
    const sentence = fabricInspectionRefusal('failed', {
      rolls: ['R-F-17', 'R-F-44', 'R-F-58'],
      points: '24',
    })

    expect(sentence).toContain('R-F-17, R-F-44, R-F-58')
    expect(sentence).toContain('24 points per 100 yd²')
    expect(sentence).toContain('3 rolls')
    expect(sentence).not.toMatch(/[{}]/)
  })

  it('trims a long list to what somebody can act on', () => {
    // Twenty roll numbers in a toast at a delivery bay is a wall nobody reads.
    const sentence = fabricInspectionRefusal('not_inspected', {
      rolls: Array.from({ length: 12 }, (_, i) => `R-F-${String(i + 1).padStart(2, '0')}`),
    })

    expect(sentence).toContain('12 rolls')
    expect(sentence).toContain('R-F-01, R-F-02, R-F-03 and 9 more')
  })

  it('says "roll", not "rolls", when there is one', () => {
    const sentence = fabricInspectionRefusal('not_inspected', { rolls: ['R-F-07'] })
    // "1 rolls have not been" is the kind of sentence that tells a storekeeper the
    // system was written by somebody not paying attention.
    expect(sentence).toContain('1 roll has not been')
    expect(sentence).toContain('R-F-07')
  })
})

describe('styleCodeFrom · a header line is not a style code', () => {
  it('takes the style out of everything a chart prints beside it', () => {
    // The live failure: fifty correct points filed under a string no lookup matches, because
    // `measurementSpecs` is found by exact code and the order's style is ST-2815.
    expect(styleCodeFrom('ST-2815 · NK-90455 · Rev 2')).toBe('ST-2815')
    expect(styleCodeFrom('ST-2815 | NK-90455')).toBe('ST-2815')
    expect(styleCodeFrom('ST-2815, NK-90455, Rev 2')).toBe('ST-2815')
    expect(styleCodeFrom('ST-2815 — Rev 3')).toBe('ST-2815')
  })

  it('strips a revision written without a separator', () => {
    expect(styleCodeFrom('ST-2815 Rev 2')).toBe('ST-2815')
    expect(styleCodeFrom('ST-2815 rev.4')).toBe('ST-2815')
  })

  it('leaves a code that is already a code exactly alone', () => {
    expect(styleCodeFrom('ST-2815')).toBe('ST-2815')
    expect(styleCodeFrom('  ST-2815  ')).toBe('ST-2815')
  })

  it('does not cut on a plain space', () => {
    // "ST 2815" is a style code some factories really use. Splitting there would trade one
    // filing error for another, and this one would be silent in the other direction.
    expect(styleCodeFrom('ST 2815')).toBe('ST 2815')
    expect(styleCodeFrom('POLO SHIRT 2244')).toBe('POLO SHIRT 2244')
  })
})
