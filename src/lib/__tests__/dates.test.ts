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
  fromDateInputText,
  maskDateInput,
  nextFactoryDate,
  startOfFactoryDay,
  toDateInputText,
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

describe('typed dates — dd/mm/yyyy in, ISO out', () => {
  it('round-trips the date that caused this', () => {
    // Live test, Phase 3: LC-4471's expiry is 5 December 2026. Typed dd/mm into a field
    // the browser was reading as mm/dd, it was stored as 12 May and refused by the
    // expiry-after-latest-shipment CHECK as an unreadable React #441.
    expect(fromDateInputText('05/12/2026')).toBe('2026-12-05')
    expect(toDateInputText('2026-12-05')).toBe('05/12/2026')
  })

  it('never lets an impossible day roll forward', () => {
    // `new Date('2026-02-31')` is 3 March in a lenient parser. A silently moved date is
    // worse than a refused one — this is an ex-factory commitment or a CAP deadline.
    expect(fromDateInputText('31/02/2026')).toBeNull()
    expect(fromDateInputText('31/04/2026')).toBeNull()
    expect(fromDateInputText('29/02/2026')).toBeNull()
    // 2028 is a leap year, so this one is real.
    expect(fromDateInputText('29/02/2028')).toBe('2028-02-29')
  })

  it('refuses what is merely incomplete, without guessing', () => {
    expect(fromDateInputText('')).toBeNull()
    expect(fromDateInputText('05/12')).toBeNull()
    expect(fromDateInputText('5/12/2026')).toBeNull()
    expect(fromDateInputText('2026-12-05')).toBeNull()
    expect(fromDateInputText('05/13/2026')).toBeNull()
  })

  it('shows nothing rather than a half-parsed date', () => {
    expect(toDateInputText('')).toBe('')
    expect(toDateInputText(null)).toBe('')
    expect(toDateInputText('2026-12')).toBe('')
  })

  it('supplies separators while typing, and lets them be deleted', () => {
    expect(maskDateInput('0')).toBe('0')
    expect(maskDateInput('05')).toBe('05')
    expect(maskDateInput('051')).toBe('05/1')
    expect(maskDateInput('05122026')).toBe('05/12/2026')
    // Backspacing over the separator must not immediately re-add it, or the field
    // cannot be cleared: '05/' minus its slash is '05', and stays '05'.
    expect(maskDateInput('05/')).toBe('05')
    // Paste of an already-formatted date, and of one from elsewhere.
    expect(maskDateInput('05/12/2026')).toBe('05/12/2026')
    expect(maskDateInput('05-12-2026')).toBe('05/12/2026')
    // Nothing beyond eight digits survives.
    expect(maskDateInput('0512202699')).toBe('05/12/2026')
  })
})
