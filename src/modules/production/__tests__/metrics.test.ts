/**
 * Production metric vectors — written before the implementation.
 *
 * Three numbers a sewing floor is run on, and every one of them is quoted in a morning
 * meeting where somebody is held responsible:
 *
 *   efficiency = earned minutes (SMV × output) ÷ available minutes
 *   DHU        = defects per hundred units
 *   run rate   = trailing output per day, forecast to a completion date
 *
 * Pure — no clock, no database. `today` and the trailing window are parameters, so the
 * nightly day-close, the live board and these tests all agree.
 */
import { describe, expect, it } from 'vitest'

import {
  computeDhu,
  computeEfficiency,
  forecastCompletion,
  ProductionError,
  workedMinutes,
} from '../metrics'

describe('computeEfficiency', () => {
  it('1 · earned = SMV × output; available = manpower × minutes', () => {
    // 40 operators for a 480-minute shift = 19,200 available minutes.
    // 1,200 pieces at 12.5 SMV = 15,000 earned minutes.
    const result = computeEfficiency({
      smv: '12.5',
      output: 1200,
      manpower: 40,
      workingMinutes: 480,
    })

    expect(result.earnedMinutes).toBe('15000.00')
    expect(result.availableMinutes).toBe('19200.00')
    expect(result.efficiencyPct).toBe('78.13')
  })

  it('2 · reports over 100% rather than capping it', () => {
    // A good line beats the SMV. Capping at 100 would hide the fact that the SMV is
    // wrong, which is worth more than the flattering number.
    const result = computeEfficiency({ smv: '10', output: 2500, manpower: 40, workingMinutes: 480 })
    expect(result.efficiencyPct).toBe('130.21')
  })

  it('3 · zero output is zero efficiency, not an error', () => {
    const result = computeEfficiency({ smv: '10', output: 0, manpower: 40, workingMinutes: 480 })
    expect(result.efficiencyPct).toBe('0.00')
  })

  it('4 · refuses zero available minutes instead of dividing by zero', () => {
    // A line with nobody on it has no efficiency — not 0%, not Infinity. Reporting 0%
    // would drag a factory average down for a line that never ran.
    expect(() =>
      computeEfficiency({ smv: '10', output: 100, manpower: 0, workingMinutes: 480 }),
    ).toThrow(ProductionError)
  })

  it('5 · is exact — SMV is quoted to two decimals and must not drift', () => {
    const result = computeEfficiency({ smv: '0.33', output: 3, manpower: 1, workingMinutes: 1 })
    expect(result.earnedMinutes).toBe('0.99')
  })
})

describe('workedMinutes', () => {
  it('1 · the day is as long as the hours the line recorded', () => {
    expect(workedMinutes(8)).toBe(480)
    expect(workedMinutes(9)).toBe(540)
    expect(workedMinutes(10)).toBe(600)
  })

  it('2 · Nordkap L-3: nine hours reads 65.60%, eight would have read 73.80%', () => {
    // The live-test day (§9, F42). 1,295 pieces at 18.60 SMV, 68 operators, and NINE hours
    // on the sheet — the 13:00 band is ruled through for lunch and is not one of them.
    const day = { smv: '18.60', output: 1295, manpower: 68 }

    const truth = computeEfficiency({ ...day, workingMinutes: workedMinutes(9) })
    expect(truth.earnedMinutes).toBe('24087.00')
    expect(truth.availableMinutes).toBe('36720.00')
    expect(truth.efficiencyPct).toBe('65.60')

    // What the fixed 480-minute denominator reported instead. Two hours of overtime credited
    // as if they were free, and the error flatters — the direction nobody questions.
    const flattered = computeEfficiency({ ...day, workingMinutes: 480 })
    expect(flattered.efficiencyPct).toBe('73.80')
  })

  it('3 · mid-shift on the wall board, the denominator grows with the day', () => {
    // The same line two hours in. Against a whole shift this read 14.76% at ten in the
    // morning; against the hours actually worked it reads what the line is doing.
    const twoHoursIn = computeEfficiency({
      smv: '18.60',
      output: 259,
      manpower: 68,
      workingMinutes: workedMinutes(2),
    })
    expect(twoHoursIn.efficiencyPct).toBe('59.04')

    const againstAWholeShift = computeEfficiency({
      smv: '18.60',
      output: 259,
      manpower: 68,
      workingMinutes: 480,
    })
    expect(againstAWholeShift.efficiencyPct).toBe('14.76')
  })

  it('4 · a day with no hours recorded has no length, rather than a nominal one', () => {
    // Falling back to 480 here would put a 0% against a line that never ran.
    expect(() => workedMinutes(0)).toThrow(ProductionError)
    expect(() => workedMinutes(-1)).toThrow(ProductionError)
    expect(() => workedMinutes(2.5)).toThrow(ProductionError)
  })
})

describe('computeDhu', () => {
  it('6 · defects per hundred units', () => {
    expect(computeDhu({ checked: 1200, defects: 36 }).dhu).toBe('3.00')
  })

  it('7 · counts DEFECTS, not defective garments', () => {
    // One garment can carry three defects. DHU counts defects; the pass rate counts
    // garments. Conflating them understates quality problems.
    const result = computeDhu({ checked: 100, defects: 150 })
    expect(result.dhu).toBe('150.00')
  })

  it('8 · refuses a zero check count rather than reporting a clean line', () => {
    // Nothing checked is not the same as nothing wrong, and a board showing 0.00 DHU for
    // an unchecked line is worse than a blank.
    expect(() => computeDhu({ checked: 0, defects: 0 })).toThrow(ProductionError)
  })

  it('9 · is exact on awkward ratios', () => {
    expect(computeDhu({ checked: 3, defects: 1 }).dhu).toBe('33.33')
  })
})

describe('forecastCompletion · run rate', () => {
  const trailing = [
    { date: '2026-06-10', output: 900 },
    { date: '2026-06-11', output: 1100 },
    { date: '2026-06-12', output: 1000 },
  ]

  it('10 · averages the trailing window and forecasts a completion date', () => {
    // 3,000 over three days = 1,000/day. 2,500 remaining = 3 more days (rounded up).
    const result = forecastCompletion({
      remainingQty: 2500,
      trailing,
      fromDate: '2026-06-12',
    })

    expect(result.ratePerDay).toBe('1000.00')
    expect(result.daysNeeded).toBe(3)
    expect(result.forecastDate).toBe('2026-06-15')
  })

  it('11 · rounds days UP — a part day is still a day on a shipping calendar', () => {
    const result = forecastCompletion({ remainingQty: 2001, trailing, fromDate: '2026-06-12' })
    expect(result.daysNeeded).toBe(3)
  })

  it('12 · says it cannot forecast when the line has not run', () => {
    // Rate zero would divide by zero, and "completes today" is the dangerous answer.
    const result = forecastCompletion({
      remainingQty: 500,
      trailing: [{ date: '2026-06-12', output: 0 }],
      fromDate: '2026-06-12',
    })

    expect(result.ratePerDay).toBe('0.00')
    expect(result.forecastDate).toBeNull()
    expect(result.confidence).toBe('none')
  })

  it('12a · an idle day stays in the denominator and slows the forecast', () => {
    // The floor made 1,200 on two of the last three days and nothing on the third. Its rate
    // is 800/day, not 1,200 — averaging only the days it ran promises a date it has already
    // shown it cannot hit. Callers pass the idle day as an explicit zero for exactly this.
    const patchy = [
      { date: '2026-06-10', output: 1200 },
      { date: '2026-06-11', output: 0 },
      { date: '2026-06-12', output: 1200 },
    ]

    const result = forecastCompletion({ remainingQty: 2400, trailing: patchy, fromDate: '2026-06-12' })

    expect(result.ratePerDay).toBe('800.00')
    expect(result.daysNeeded).toBe(3)
  })

  it('12b · confidence counts the days that reported, not the width of the window', () => {
    // A three-day window with one day of output is still one day of evidence. The rate is
    // averaged over three, but nobody should read the date as firm.
    const oneDay = [
      { date: '2026-06-10', output: 0 },
      { date: '2026-06-11', output: 0 },
      { date: '2026-06-12', output: 900 },
    ]

    const result = forecastCompletion({ remainingQty: 600, trailing: oneDay, fromDate: '2026-06-12' })

    expect(result.ratePerDay).toBe('300.00')
    expect(result.confidence).toBe('low')
  })

  it('13 · flags a forecast that lands after the sewing milestone', () => {
    const result = forecastCompletion({
      remainingQty: 5000,
      trailing,
      fromDate: '2026-06-12',
      milestoneDate: '2026-06-14',
    })

    // 5 days needed, milestone in 2 — the order is late unless something changes.
    expect(result.forecastDate).toBe('2026-06-17')
    expect(result.slipDays).toBe(3)
    expect(result.atRisk).toBe(true)
  })

  it('14 · is quiet when the forecast comfortably beats the milestone', () => {
    const result = forecastCompletion({
      remainingQty: 1000,
      trailing,
      fromDate: '2026-06-12',
      milestoneDate: '2026-06-20',
    })

    expect(result.atRisk).toBe(false)
    expect(result.slipDays).toBe(0)
  })

  it('15 · marks a one-day window as low confidence', () => {
    // A single day is a data point, not a rate. The forecast is still given — a planner
    // would rather have a weak number than none — but it says how weak it is.
    const result = forecastCompletion({
      remainingQty: 1000,
      trailing: [{ date: '2026-06-12', output: 1000 }],
      fromDate: '2026-06-12',
    })

    expect(result.confidence).toBe('low')
    expect(result.forecastDate).toBe('2026-06-13')
  })

  it('16 · refuses an empty trailing window', () => {
    expect(() =>
      forecastCompletion({ remainingQty: 100, trailing: [], fromDate: '2026-06-12' }),
    ).toThrow(ProductionError)
  })
})
