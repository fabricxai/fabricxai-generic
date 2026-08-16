/**
 * Which order an hour of output belongs to. Pure — no database.
 *
 * `daily_line_plans` is the record of what a line ran on a date, so an hour is attributed by
 * the plan for the day it was PRODUCED on — not by what the line is running now, and not by
 * whatever the client worked out. The catch-up screen used to send today's order while writing
 * a sheet from last week, which booked a whole day against no order, and would have booked it
 * against the wrong one had anything been planned that day (§9, F44).
 */

/** `lineId|producedOn` — a line's day, which is the grain a plan is kept at. */
export function lineDayKey(entry: { lineId: string; producedOn: string }): string {
  return `${entry.lineId}|${entry.producedOn}`
}

/**
 * The order to store for one entry.
 *
 * The plan for that line-day wins. The caller's own `orderId` is a fallback for a day with no
 * plan — seeds and `/api/production/outputs` name one directly — which narrows what is
 * trusted rather than widening it. Neither means null: a day nobody planned is attributed to
 * nothing, because the alternative is guessing, and a guess written where a buyer's order
 * looks at it is believed.
 */
export function orderForEntry(
  planned: ReadonlyMap<string, string>,
  entry: { lineId: string; producedOn: string; orderId?: string | undefined },
): string | null {
  return planned.get(lineDayKey(entry)) ?? entry.orderId ?? null
}

/**
 * How an order is named to somebody on the floor.
 *
 * A supervisor confirming which order a day goes against needs the PO number they see on
 * paperwork and the style the floor calls the work — "NKA-PO-70318 · ST-2815". An order with
 * no PO recorded falls back to a stub of its id, which is ugly but findable; showing nothing
 * would leave the confirmation sentence with a blank where the whole point is.
 */
export function orderLabel(input: {
  orderId: string
  poNumbers: readonly string[]
  styleCode: string | null
}): string {
  const po = input.poNumbers[0] ?? input.orderId.slice(0, 8)
  return input.styleCode ? `${po} · ${input.styleCode}` : po
}
