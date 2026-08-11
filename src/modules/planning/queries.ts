/**
 * Read models for the Planning Board.
 *
 * The board's honesty rests on one distinction: a line-day that is
 * over-committed ON PURPOSE is different from one that is over-committed by
 * accident. `allocations.accepted_violations` records the first, so the board
 * shows an accepted overload as a decision somebody made rather than as a
 * problem to fix — and shows an unaccepted one as exactly the opposite.
 */
import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import { z } from 'zod'

import type { AnyCtx } from '@/modules/core/ctx'
import { readJsonbArray, readJsonbObject } from '@/modules/core/jsonb'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderStyles, orders } from '@/modules/orders/schema'

import { allocations, lineCalendars, lines, scenarios } from './schema'

/**
 * `allocations.accepted_violations` — the overloads a planner signed off.
 *
 * Parsed at the boundary because an unreadable entry would silently turn an
 * accepted overload back into an alarm, and a board that cries wolf about a
 * decision already taken is one planners stop reading.
 */
const acceptedViolation = z.object({
  date: z.string(),
  reason: z.string().optional(),
  kind: z.string().optional(),
})

/**
 * `allocations.planned_daily` — date → pieces, NOT a flat daily rate.
 *
 * The distinction matters: a new style ramps up a learning curve, so day one
 * and day ten of the same allocation are different numbers. Treating the map
 * as a constant would overstate the first days of every run and understate the
 * last, which is exactly the period a planner is trying to get right.
 */
const plannedDailyMap = z.record(z.string(), z.number())

export interface LineDay {
  date: string
  /** Minutes the line is actually available after planned downtime. */
  availableMinutes: number
  manpower: number | null
  /** Pieces committed to this line on this date, across all allocations. */
  committed: number
}

export interface AllocationRow {
  id: string
  orderId: string
  poNumber: string | null
  styleCode: string | null
  lineId: string
  lineCode: string
  startDate: string
  endDate: string
  /** date → pieces planned that day. Empty when the stored map would not parse. */
  plannedDaily: Record<string, number>
  /** Total across the allocation's own days. */
  plannedTotal: number
  status: string
  /** Overloads the planner accepted deliberately. */
  acceptedViolations: { date: string; reason?: string; kind?: string }[]
  acceptedUnreadable: number
}

export interface BoardLine {
  lineId: string
  code: string
  name: string
  capacityManpower: number | null
  machinesCount: number | null
  days: LineDay[]
  allocations: AllocationRow[]
}

function dateRange(from: string, days: number): string[] {
  const start = new Date(`${from}T00:00:00Z`).getTime()
  return Array.from({ length: days }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  )
}

export async function board(
  ctx: AnyCtx,
  input: { from: string; days: number },
): Promise<BoardLine[]> {
  const dates = dateRange(input.from, input.days)
  const to = dates[dates.length - 1]!

  return withTenantRead(ctx, async (tx) => {
    const [lineRows, calendars, allocRows] = await Promise.all([
      tx
        .select({
          id: lines.id,
          code: lines.code,
          name: lines.name,
          capacityManpower: lines.capacityManpower,
          machinesCount: lines.machinesCount,
        })
        .from(lines)
        .where(scoped(lines, ctx, eq(lines.isActive, true)))
        .orderBy(asc(lines.code)),
      tx
        .select({
          lineId: lineCalendars.lineId,
          calendarDate: lineCalendars.calendarDate,
          shiftMinutes: lineCalendars.shiftMinutes,
          plannedDowntimeMinutes: lineCalendars.plannedDowntimeMinutes,
          manpower: lineCalendars.manpower,
        })
        .from(lineCalendars)
        .where(scoped(lineCalendars, ctx, 
          and(gte(lineCalendars.calendarDate, input.from), lte(lineCalendars.calendarDate, to)),
        )),
      // Anything overlapping the window, not merely starting inside it — a run
      // that began last week still consumes this week's capacity.
      tx
        .select({
          id: allocations.id,
          orderId: allocations.orderId,
          orderStyleId: allocations.orderStyleId,
          lineId: allocations.lineId,
          startDate: allocations.startDate,
          endDate: allocations.endDate,
          plannedDaily: allocations.plannedDaily,
          status: allocations.status,
          acceptedViolations: allocations.acceptedViolations,
        })
        .from(allocations)
        .where(scoped(allocations, ctx, and(lte(allocations.startDate, to), gte(allocations.endDate, input.from)))),
    ])

    const orderIds = [...new Set(allocRows.map((a) => a.orderId))]
    // An allocation may name an order without naming a style — a line booked
    // for an order whose style is not yet settled is a real planning state.
    const styleIds = [
      ...new Set(allocRows.map((a) => a.orderStyleId).filter((id): id is string => !!id)),
    ]

    const [orderRows, styleRows] = await Promise.all([
      orderIds.length > 0
        ? tx
            .select({ id: orders.id, poNumbers: orders.poNumbers })
            .from(orders)
            .where(scoped(orders, ctx, inArray(orders.id, orderIds)))
        : Promise.resolve([] as { id: string; poNumbers: string[] | null }[]),
      styleIds.length > 0
        ? tx
            .select({ id: orderStyles.id, styleCode: orderStyles.styleCode })
            .from(orderStyles)
            .where(scoped(orderStyles, ctx, inArray(orderStyles.id, styleIds)))
        : Promise.resolve([] as { id: string; styleCode: string }[]),
    ])

    return lineRows.map((line): BoardLine => {
      const mine = allocRows.filter((a) => a.lineId === line.id)

      const allocationRows = mine.map((a): AllocationRow => {
        const accepted = readJsonbArray(
          acceptedViolation,
          a.acceptedViolations,
          'allocations.accepted_violations',
        )
        const daily =
          readJsonbObject(plannedDailyMap, a.plannedDaily, 'allocations.planned_daily') ?? {}
        return {
          id: a.id,
          orderId: a.orderId,
          poNumber: orderRows.find((o) => o.id === a.orderId)?.poNumbers?.[0] ?? null,
          styleCode: styleRows.find((s) => s.id === a.orderStyleId)?.styleCode ?? null,
          lineId: a.lineId,
          lineCode: line.code,
          startDate: a.startDate,
          endDate: a.endDate,
          plannedDaily: daily,
          plannedTotal: Object.values(daily).reduce((n, q) => n + q, 0),
          status: a.status,
          acceptedViolations: accepted.items,
          acceptedUnreadable: accepted.unreadable,
        }
      })

      return {
        lineId: line.id,
        code: line.code,
        name: line.name,
        capacityManpower: line.capacityManpower,
        machinesCount: line.machinesCount,
        days: dates.map((date): LineDay => {
          const cal = calendars.find((c) => c.lineId === line.id && c.calendarDate === date)
          const shift = cal?.shiftMinutes ?? 0
          const down = cal?.plannedDowntimeMinutes ?? 0

          return {
            date,
            // A day with no calendar row has NO available minutes — the line is
            // not working, which is different from working at zero efficiency.
            availableMinutes: Math.max(0, shift - down),
            manpower: cal?.manpower ?? null,
            // Read per date from each allocation's own map rather than assuming
            // a flat rate across the run.
            committed: allocationRows
              .filter((a) => a.startDate <= date && a.endDate >= date)
              .reduce((n, a) => n + (a.plannedDaily[date] ?? 0), 0),
          }
        }),
        allocations: allocationRows,
      }
    })
  })
}

/** Draft what-ifs a planner has open. */
export async function openScenarios(
  ctx: AnyCtx,
): Promise<{ id: string; name: string; status: string; baseSnapshotAt: Date }[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: scenarios.id,
        name: scenarios.name,
        status: scenarios.status,
        baseSnapshotAt: scenarios.baseSnapshotAt,
      })
      .from(scenarios)
      .where(scoped(scenarios, ctx, eq(scenarios.status, 'draft')))
      .orderBy(asc(scenarios.createdAt)),
  )
}

/**
 * The id behind a line code — `L1`, the way the floor says it.
 *
 * Unique per company by `lines_company_code_key`, and case-insensitive: the board prints
 * `L1`, a supervisor types `l1`, and they are the same sewing line.
 */
export async function lineIdByCode(ctx: AnyCtx, code: string): Promise<string | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: lines.id })
      .from(lines)
      .where(scoped(lines, ctx, sql`lower(${lines.code}) = lower(${code})`))
      .limit(1)
    return row?.id ?? null
  })
}
