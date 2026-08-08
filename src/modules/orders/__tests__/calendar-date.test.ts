/**
 * The guard that crashed on its own job (live-test finding, Phase 2 PO intake).
 *
 * `calendarDate` refuses "a date that parses in JS but does not exist" — and its refine
 * called `Date#toISOString`, which THROWS `RangeError: Invalid time value` on an invalid
 * date. So a model emitting a regex-shaped impossible date ("0000-00-00") did not get a
 * zod issue naming the field; it crashed the whole extraction with "Invalid time value"
 * and the job retried an error that would never heal. Five modules carried the same copy;
 * these vectors run against the orders one, the copy the live PO intake hit.
 */
import { describe, expect, it } from 'vitest'

import { calendarDate } from '../zod'

describe('calendarDate', () => {
  it('accepts a real date', () => {
    expect(calendarDate.parse('2026-11-15')).toBe('2026-11-15')
  })

  it('refuses a shape that is not a date at all', () => {
    expect(calendarDate.safeParse('15 NOV 2026').success).toBe(false)
    expect(calendarDate.safeParse('').success).toBe(false)
  })

  it('refuses an impossible date WITHOUT throwing — a refusal is an issue, not a crash', () => {
    // Each of these matches the regex and used to crash the refine.
    for (const value of ['0000-00-00', '2026-02-30', '2026-13-01', '2026-11-31']) {
      const result = calendarDate.safeParse(value)
      expect(result.success, value).toBe(false)
    }
  })
})
