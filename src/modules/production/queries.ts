/**
 * Read models for the line-tracking board.
 *
 * The board answers one question a supervisor asks all day: is this line ahead
 * or behind, right now. So every cell carries target AND actual — a bare output
 * number cannot be acted on, because 108 pieces is good against a target of 100
 * and a problem against 140.
 *
 * Cumulative variance matters more than the current hour: one bad hour is a
 * machine jam, four bad hours is a line that will not make the day.
 */
import { and, asc, eq, gte, isNull, lte, sql } from 'drizzle-orm'

import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
// `lines` belongs to planning (rule 11: one writer module per shared table);
// production reads it rather than owning it. Same for orders — read here only to name the
// order a line's day belongs to, never written.
import { orderStyles, orders } from '@/modules/orders/schema'
import { lines } from '@/modules/planning/schema'

import { forecastCompletion, type ForecastResult } from './metrics'
import { dailyLinePlans, downtimes, hourlyOutputs } from './schema'

export interface HourCell {
  hourSlot: number
  target: number
  actual: number
  /** Why the hour went the way it did, when somebody said — usually nothing (§9, F43). */
  remark: string | null
}

export interface LineRow {
  lineId: string
  code: string
  name: string
  hours: HourCell[]
  target: number
  actual: number
  /** actual − target across the hours that have been entered. */
  variance: number
  /** Null until at least one hour has a target — a ratio needs a denominator. */
  achievedPct: string | null
  /** Hours with no entry yet. Not zeros: nobody has said what happened. */
  hoursNotEntered: number
  openDowntime: { reason: string; startedAt: Date; note: string | null } | null
}

export async function board(
  ctx: AnyCtx,
  input: { producedOn: string; shiftHours: number },
): Promise<LineRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const [lineRows, cells, open] = await Promise.all([
      tx
        .select({ id: lines.id, code: lines.code, name: lines.name })
        .from(lines)
        .where(scoped(lines, ctx, eq(lines.isActive, true)))
        .orderBy(asc(lines.code)),
      tx
        .select({
          lineId: hourlyOutputs.lineId,
          hourSlot: hourlyOutputs.hourSlot,
          target: hourlyOutputs.target,
          actual: hourlyOutputs.actual,
          remark: hourlyOutputs.remark,
        })
        .from(hourlyOutputs)
        .where(scoped(hourlyOutputs, ctx, eq(hourlyOutputs.producedOn, input.producedOn)))
        .orderBy(asc(hourlyOutputs.hourSlot)),
      tx
        .select({
          lineId: downtimes.lineId,
          reason: downtimes.reason,
          startedAt: downtimes.startedAt,
          note: downtimes.note,
        })
        .from(downtimes)
        // A downtime with no end is still happening — that is the one the board
        // has to show, because it explains the hour that is going wrong now.
        .where(scoped(downtimes, ctx, isNull(downtimes.endedAt))),
    ])

    return lineRows.map((line): LineRow => {
      const hours = cells.filter((c) => c.lineId === line.id)
      const target = hours.reduce((n, h) => n + h.target, 0)
      const actual = hours.reduce((n, h) => n + h.actual, 0)
      const downtime = open.find((d) => d.lineId === line.id) ?? null

      return {
        lineId: line.id,
        code: line.code,
        name: line.name,
        hours,
        target,
        actual,
        variance: actual - target,
        achievedPct: target > 0 ? ((actual / target) * 100).toFixed(0) : null,
        hoursNotEntered: Math.max(0, input.shiftHours - hours.length),
        openDowntime: downtime
          ? { reason: downtime.reason, startedAt: downtime.startedAt, note: downtime.note }
          : null,
      }
    })
  })
}

export interface OrderRunRate extends ForecastResult {
  /** Sewn against this order across every line, all time. */
  sewnQty: number
  remainingQty: number
  /** Days of output the rate was averaged over — the assumption behind the date. */
  trailingDays: number
  /** Days in that window that actually had output. Fewer means a thinner average. */
  daysWithOutput: number
  milestoneDate: string | null
}

/**
 * Run rate for one order (canvas P4) — the read behind the card on the order page.
 *
 * Lives here, not in the order module, because `hourly_outputs` has exactly one writer and
 * that is production (rule 11). A merchandiser reading the sewing floor reads it through
 * production's own query or the two modules drift.
 *
 * The trailing window is deliberately short. Three days tracks a floor that has just been
 * re-manned or lost a line; a fortnight's average smooths over precisely the change somebody
 * opened this card to find out about.
 */
export async function orderRunRate(
  ctx: AnyCtx,
  input: {
    orderId: string
    contractedQty: number
    asOf: string
    trailingDays?: number
    milestoneDate?: string | null
  },
): Promise<OrderRunRate> {
  const days = input.trailingDays ?? 3

  const [sewnQty, trailing] = await Promise.all([
    sewnAgainstOrder(ctx, input.orderId),
    trailingOutput(ctx, { orderId: input.orderId, asOf: input.asOf, days }),
  ])

  // Never negative: shipping over the contracted quantity inside tolerance means the order
  // is finished, not that the floor owes pieces backwards.
  const remainingQty = Math.max(0, input.contractedQty - sewnQty)

  return {
    ...forecastCompletion({
      remainingQty,
      trailing,
      fromDate: input.asOf,
      milestoneDate: input.milestoneDate ?? null,
    }),
    sewnQty,
    remainingQty,
    trailingDays: days,
    daysWithOutput: trailing.filter((d) => d.output > 0).length,
    milestoneDate: input.milestoneDate ?? null,
  }
}

/** Everything sewn against an order, across every line, all time. */
export async function sewnAgainstOrder(ctx: AnyCtx, orderId: string): Promise<number> {
  const [row] = await withTenantRead(ctx, (tx) =>
    tx
      .select({ sewn: sql<string>`coalesce(sum(${hourlyOutputs.actual}), 0)::text` })
      .from(hourlyOutputs)
      .where(scoped(hourlyOutputs, ctx, eq(hourlyOutputs.orderId, orderId))),
  )
  return Number(row?.sewn ?? 0)
}

/**
 * Daily output for an order over the trailing window, **zero-filled**.
 *
 * The zero-fill is the whole point of this living in one place. A day the floor did not run
 * has to reach the forecast as an explicit zero, because `forecastCompletion` divides by the
 * length of what it is given — hand it only the days that reported and it silently averages
 * the good days and promises a date nobody can hit. Two call sites doing this by hand is two
 * forecasts for one order, and the argument that starts when they disagree is unwinnable.
 */
export async function trailingOutput(
  ctx: AnyCtx,
  input: { orderId: string; asOf: string; days: number },
): Promise<{ date: string; output: number }[]> {
  const from = dayOffset(input.asOf, -(input.days - 1))

  const rows = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        date: hourlyOutputs.producedOn,
        output: sql<string>`sum(${hourlyOutputs.actual})::text`,
      })
      .from(hourlyOutputs)
      .where(scoped(hourlyOutputs, ctx, 
        and(
          eq(hourlyOutputs.orderId, input.orderId),
          gte(hourlyOutputs.producedOn, from),
          lte(hourlyOutputs.producedOn, input.asOf),
        ),
      ))
      .groupBy(hourlyOutputs.producedOn)
      .orderBy(asc(hourlyOutputs.producedOn)),
  )

  const byDate = new Map(rows.map((r) => [r.date, Number(r.output)]))
  return Array.from({ length: input.days }, (_, i) => {
    const date = dayOffset(from, i)
    return { date, output: byDate.get(date) ?? 0 }
  })
}

function dayOffset(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
}

/** Lines a supervisor can enter against. */
export async function activeLines(
  ctx: AnyCtx,
): Promise<{ id: string; code: string; name: string }[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({ id: lines.id, code: lines.code, name: lines.name })
      .from(lines)
      .where(scoped(lines, ctx, and(eq(lines.isActive, true))))
      .orderBy(asc(lines.code)),
  )
}

/**
 * What a line was running on a given day, for the screen to say so before anything is saved.
 *
 * The catch-up dialog enters a day that has already happened, and the order that day belongs
 * to is settled by the plan for THAT date — not by what the line is running now. The write
 * resolves this itself (`plannedOrderByLineDay`); this is so the supervisor is told, because
 * the alternative is a day saved against nothing with no indication that it happened
 * (§9, F44).
 *
 * Returns null when nothing was planned, which is a real answer and the one worth showing.
 */
export async function whatTheLineRan(
  ctx: AnyCtx,
  input: { lineId: string; planDate: string },
): Promise<{ orderId: string; label: string } | null> {
  const rows = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        orderId: dailyLinePlans.orderId,
        poNumbers: orders.poNumbers,
        styleCode: orderStyles.styleCode,
      })
      .from(dailyLinePlans)
      .innerJoin(orders, eq(orders.id, dailyLinePlans.orderId))
      // A style is what a floor calls the work; the PO is what the office calls it. Left,
      // because an order with no style row still has a plan and still has a name.
      .leftJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(
        scoped(
          dailyLinePlans,
          ctx,
          and(
            eq(dailyLinePlans.lineId, input.lineId),
            eq(dailyLinePlans.planDate, input.planDate),
          ),
        ),
      )
      .limit(1),
  )

  const row = rows[0]
  if (!row) return null

  const po = row.poNumbers[0] ?? row.orderId.slice(0, 8)
  return { orderId: row.orderId, label: row.styleCode ? `${po} · ${row.styleCode}` : po }
}
