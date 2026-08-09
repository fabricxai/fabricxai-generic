/**
 * The factory's today (audit INFRA-H2).
 *
 * Every case here pins an instant, because the bug this file exists to prevent is invisible
 * for eighteen hours a day and certain for the other six. A test using the real clock would
 * pass all afternoon and fail on the night shift, which is precisely the failure mode.
 */
import { describe, expect, it } from 'vitest'

import {
  FACTORY_TIMEZONE,
  daysBetween,
  factoryHour,
  factoryMonth,
  factoryToday,
  nextFactoryDate,
  startOfFactoryDay,
  toFactoryDate,
} from '@/lib/dates'

describe('the six hours that were wrong', () => {
  it('is already tomorrow in Dhaka when UTC says otherwise', () => {
    // 18:30 UTC on 5 August is 00:30 on 6 August in Dhaka. The old
    // `toISOString().slice(0,10)` answered the 5th — so an hourly output booked at half
    // past midnight landed on the previous production day.
    const instant = new Date('2026-08-05T18:30:00Z')

    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-05')
    expect(factoryToday(FACTORY_TIMEZONE, instant)).toBe('2026-08-06')
  })

  it('agrees with UTC during the working day', () => {
    // 09:00 Dhaka. Most of the time the two answers match, which is why this survived.
    const instant = new Date('2026-08-05T03:00:00Z')

    expect(factoryToday(FACTORY_TIMEZONE, instant)).toBe('2026-08-05')
    expect(instant.toISOString().slice(0, 10)).toBe('2026-08-05')
  })

  it('rolls the month at the factory boundary, not UTC s', () => {
    // 23:00 UTC on 31 July is already 1 August in Dhaka — the boundary where a payroll
    // period gets filed against the wrong month.
    const instant = new Date('2026-07-31T23:00:00Z')

    expect(factoryMonth(FACTORY_TIMEZONE, instant)).toBe('2026-08')
    expect(instant.toISOString().slice(0, 7)).toBe('2026-07')
  })

  it('honours a company that is not in Dhaka', () => {
    // The timezone column exists on company_profiles and nothing read it; the helper takes
    // it so a second factory elsewhere is not silently on Bangladeshi time.
    const instant = new Date('2026-08-05T18:30:00Z')

    expect(toFactoryDate(instant, 'Asia/Dhaka')).toBe('2026-08-06')
    expect(toFactoryDate(instant, 'UTC')).toBe('2026-08-05')
    expect(toFactoryDate(instant, 'America/New_York')).toBe('2026-08-05')
  })
})

describe('calendar arithmetic', () => {
  it('starts a factory day six hours before UTC midnight', () => {
    // 00:00 on 6 August in Dhaka is 18:00 on the 5th, UTC. This is the bound a
    // timestamptz query needs; comparing a date string to a timestamp is the same bug.
    expect(startOfFactoryDay('2026-08-06').toISOString()).toBe('2026-08-05T18:00:00.000Z')
  })

  it('steps to the next day across a month end', () => {
    expect(nextFactoryDate('2026-08-31')).toBe('2026-09-01')
    expect(nextFactoryDate('2026-02-28')).toBe('2026-03-01')
  })

  it('counts whole days in both directions', () => {
    expect(daysBetween('2026-08-01', '2026-08-06')).toBe(5)
    expect(daysBetween('2026-08-06', '2026-08-01')).toBe(-5)
    expect(daysBetween('2026-08-06', '2026-08-06')).toBe(0)
  })

  it('is stable across a day it spans', () => {
    // The pair a timestamptz range query uses. If these drifted, a production board would
    // show one shift twice or not at all.
    const start = startOfFactoryDay('2026-08-06')
    const end = startOfFactoryDay(nextFactoryDate('2026-08-06'))

    expect(end.getTime() - start.getTime()).toBe(86_400_000)
  })
})

describe('factoryHour', () => {
  it('reads the FACTORY clock, not the server’s', () => {
    // 23:30 UTC is 05:30 the next morning in Dhaka. The old code used the server's own
    // hour, so an evening deploy pinned the hourly screen to the shift's first hour all
    // day — and a supervisor entering the 10:00 count would have overwritten 8:00.
    const instant = new Date('2026-08-08T23:30:00Z')
    expect(factoryHour('Asia/Dhaka', instant)).toBe(5)
    expect(factoryHour('UTC', instant)).toBe(23)
  })

  it('midnight is hour zero, whichever way ICU spells it', () => {
    // 18:10 UTC is 00:10 in Dhaka; some ICU builds format that as "24".
    expect(factoryHour('Asia/Dhaka', new Date('2026-08-08T18:10:00Z'))).toBe(0)
  })

  it('tracks the working day', () => {
    // 04:00 UTC is 10:00 on the floor — mid-morning, the hour a supervisor is entering.
    expect(factoryHour('Asia/Dhaka', new Date('2026-08-09T04:00:00Z'))).toBe(10)
  })
})
