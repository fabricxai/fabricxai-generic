/**
 * Dates. The factory operates in Asia/Dhaka; buyers, LCs and shipping schedules do not.
 * Every helper here is timezone-explicit for that reason — a shipment date that drifts by
 * a day across a timezone boundary is an LC latest-shipment breach.
 *
 * ## Why this file stopped being a constant
 *
 * `new Date().toISOString().slice(0, 10)` is UTC. Dhaka is UTC+6, so between 00:00 and
 * 05:59 local it answers YESTERDAY — which is the night shift, and every nightly cron
 * (audit INFRA-H2). An hourly output booked at 01:00 lands on the previous production day;
 * a UD validity check at 02:00 measures against a date that has already passed; an LC
 * discrepancy raised at 03:00 is dated a day early, and that date is one a bank counts.
 *
 * Four modules had already worked this out and each wrote its own copy of the same
 * `Intl.DateTimeFormat('en-CA')` trick, all four hardcoding `'Asia/Dhaka'` rather than
 * reading the `timezone` column the settings module has collected since day one. This is
 * that function, once, next to the constant it belongs with.
 *
 * ## The thing to understand before using these
 *
 * A "factory date" is a calendar day in the factory's own terms — the thing on a challan,
 * a production board, a UD. It is NOT an instant. Comparing one to a `Date` is a bug that
 * only shows for six hours a day, which is why everything here takes and returns
 * `YYYY-MM-DD` strings.
 */

export const FACTORY_TIMEZONE = 'Asia/Dhaka'

/**
 * `YYYY-MM-DD` for an instant, in a named timezone.
 *
 * `en-CA` is the locale trick that makes `Intl` emit ISO order. It is not a preference
 * about Canada; it is the widely-supported locale whose short date format happens to be
 * exactly what every date column in this schema stores.
 */
export function toFactoryDate(instant: Date, timeZone: string = FACTORY_TIMEZONE): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant)
}

/**
 * Today, on the factory floor.
 *
 * Pass the company's own `timezone` where you have it — `company_profiles.timezone` exists
 * and defaults to Asia/Dhaka. The default here is for paths that genuinely have no company
 * in hand, not an invitation to skip it.
 */
export function factoryToday(timeZone: string = FACTORY_TIMEZONE, now: Date = new Date()): string {
  return toFactoryDate(now, timeZone)
}

/**
 * The hour on the factory clock, 0–23.
 *
 * `new Date().getHours()` is the SERVER's hour, and the server is UTC. Dhaka is six hours
 * ahead, so an evening deploy made the hourly screen open on 8:00 all day: at 23:00 UTC
 * the floor is at 05:00, below the shift start, and the clamp pinned it to the first hour
 * (live-test finding, Phase 6 — a supervisor entering the 10:00 count would have
 * overwritten 8:00 without noticing).
 */
export function factoryHour(timeZone: string = FACTORY_TIMEZONE, now: Date = new Date()): number {
  const hour = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    hour12: false,
  }).format(now)
  // '24' is midnight in some ICU builds; both spellings mean hour zero.
  return Number(hour) % 24
}

/**
 * The instant a factory day begins, as a real `Date`.
 *
 * For querying a `timestamptz` column by calendar day: `>= startOfFactoryDay(d)` and
 * `< startOfFactoryDay(nextFactoryDate(d))`. Comparing a date string to a timestamp is the
 * same UTC bug wearing different clothes.
 */
export function startOfFactoryDay(date: string, timeZone: string = FACTORY_TIMEZONE): Date {
  // Measure the zone's offset at that moment by formatting a probe instant both ways.
  // Dhaka has no DST, but this file should not be the reason a factory that does is wrong.
  const probe = new Date(`${date}T00:00:00Z`)
  const asLocal = new Date(probe.toLocaleString('en-US', { timeZone }))
  const asUtc = new Date(probe.toLocaleString('en-US', { timeZone: 'UTC' }))
  return new Date(probe.getTime() + (asUtc.getTime() - asLocal.getTime()))
}

/** The calendar day after this one. Pure string arithmetic — no zone involved. */
export function nextFactoryDate(date: string): string {
  const next = new Date(`${date}T00:00:00Z`)
  next.setUTCDate(next.getUTCDate() + 1)
  return next.toISOString().slice(0, 10)
}

/**
 * `days` calendar days before or after this one. Pure string arithmetic — no zone involved.
 *
 * The generalisation of `nextFactoryDate`, and what a report window is built from: "the last
 * fourteen days" has to mean fourteen whole FACTORY days, or a query run at 09:00 in Dhaka
 * starts its window mid-afternoon on the first day and quietly drops half of it.
 */
export function shiftFactoryDate(date: string, days: number): string {
  const shifted = new Date(`${date}T00:00:00Z`)
  shifted.setUTCDate(shifted.getUTCDate() + days)
  return shifted.toISOString().slice(0, 10)
}

/** Whole days from `from` to `to`. Negative when `to` is the earlier one. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`)
  const b = Date.parse(`${to}T00:00:00Z`)
  return Math.round((b - a) / 86_400_000)
}

/**
 * The current month, `YYYY-MM`, in factory terms.
 *
 * Payroll periods and UD reconciliation months are keyed by this, and the UTC version is
 * wrong for the same six hours — on the 1st of a month it answers the PREVIOUS month,
 * which is the boundary where a payroll run gets filed against the wrong period.
 */
export function factoryMonth(timeZone: string = FACTORY_TIMEZONE, now: Date = new Date()): string {
  return factoryToday(timeZone, now).slice(0, 7)
}

/**
 * A date as Bangladesh reads it: dd/mm/yyyy (live-test feedback, Phase 9).
 *
 * Takes either a calendar date string ('2026-11-15' — reformatted directly, no timezone
 * arithmetic, because a calendar date has no instant) or a timestamp (formatted in the
 * FACTORY's day, which is also what fixes the class of bug where an approval made after
 * 6 pm UTC displayed as yesterday). Displays only — storage and APIs stay ISO.
 */
export function formatFactoryDate(
  value: string | Date | null | undefined,
  timeZone: string = FACTORY_TIMEZONE,
): string {
  if (value === null || value === undefined || value === '') return '—'

  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
    if (m) return `${m[3]}/${m[2]}/${m[1]}`
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    value = parsed
  }

  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(value)
}

/**
 * ## Typing a date, as opposed to reading one
 *
 * `formatFactoryDate` fixed how dates are DISPLAYED. It did nothing for how they are
 * ENTERED, and that is the half that corrupts data: `<input type="date">` renders in the
 * BROWSER's locale, which no page can override, so on a machine configured for en-US the
 * field asks for mm/dd/yyyy while its Bangladeshi operator types dd/mm.
 *
 * The failure is silent for every day ≤ 12. Live test, Phase 3: an LC expiry of 5 December
 * was typed `05/12/2026`, stored as 12 May, and only surfaced because it landed before the
 * latest-shipment date and a CHECK constraint caught it — as an unreadable React #441.
 * A mis-keyed ex-factory date, CAP deadline or wage period has no constraint behind it and
 * would simply have been wrong.
 *
 * These two functions are the boundary: everything above them speaks dd/mm/yyyy, everything
 * below stays `YYYY-MM-DD`. Storage, APIs and zod are untouched.
 */

/** `2026-12-05` → `05/12/2026`. Anything that is not a calendar date → `''`. */
export function toDateInputText(iso: string | null | undefined): string {
  if (!iso) return ''
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  return m ? `${m[3]}/${m[2]}/${m[1]}` : ''
}

/**
 * `05/12/2026` → `2026-12-05`, or `null` when it is not yet a real date.
 *
 * Strict on purpose. A lenient parser is how `31/02` becomes 3 March: `Date` rolls overflow
 * forward without complaint, so the round-trip comparison below is what rejects a day that
 * does not exist in that month rather than quietly moving it.
 */
export function fromDateInputText(text: string): string | null {
  const m = text.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/)
  if (!m) return null

  const iso = `${m[3]}-${m[2]}-${m[1]}`
  const parsed = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) return null
  return parsed.toISOString().slice(0, 10) === iso ? iso : null
}

/**
 * What the field should show after this keystroke: digits, with the separators supplied.
 *
 * The trailing slash is added only once a digit follows it, or backspacing out of
 * `05/` re-adds the slash the person just deleted and the field cannot be cleared.
 */
export function maskDateInput(raw: string): string {
  /*
   * A pasted ISO date is accepted as itself.
   *
   * Everything in this product speaks `YYYY-MM-DD` — the API, the seeds, the buyer's own
   * systems more often than not — so pasting one into a date field is the obvious thing to
   * do and it produced `20/26/1220`: the digits of 2026-12-20, masked as if they had been
   * typed day-first. Visibly wrong rather than silently wrong, but a person then has to
   * work out that the field wanted the same date backwards.
   *
   * Matched on the SHAPE before the digits are stripped, so it cannot catch a half-typed
   * date: only a complete `\\d{4}-\\d{2}-\\d{2}` reorders, and everything else masks as
   * before.
   */
  const iso = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`

  const digits = raw.replace(/\D/g, '').slice(0, 8)
  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}
