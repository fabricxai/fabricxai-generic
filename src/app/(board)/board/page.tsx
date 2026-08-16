import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'

import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { computeEfficiency, workedMinutes } from '@/modules/production/metrics'
import { board } from '@/modules/production/queries'
import { dailyLinePlans } from '@/modules/production/schema'

import { TvBoard } from './tv-board'
import { factoryToday } from '@/lib/dates'

/**
 * 6.1 Line tracking · the wall board (canvas P2).
 *
 * A screen bolted to a pillar and read from thirty feet away, by people who are working.
 * That is the whole brief, and it is why this is not the hourly screen with bigger type:
 * two numbers dominate, a stopped line takes the middle of the board, and nobody touches
 * it — there are no controls at all, it refreshes itself.
 *
 * It reuses `board()`, the same query the hourly screen reads. A wall display that computes
 * its own totals is a wall display that eventually disagrees with the screen the supervisor
 * is holding, and the argument that follows is unwinnable.
 */
export const dynamic = 'force-dynamic'

/** A normal Bangladeshi sewing shift: 8 hours plus two of overtime. */
const SHIFT_HOURS = 10

export default async function BoardPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const today = factoryToday()

  const [rows, plans] = await Promise.all([
    board(ctx, { producedOn: today, shiftHours: SHIFT_HOURS }),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          lineId: dailyLinePlans.lineId,
          smv: dailyLinePlans.smv,
          manpower: dailyLinePlans.manpowerPlanned,
        })
        .from(dailyLinePlans)
        .where(eq(dailyLinePlans.planDate, today)),
    ),
  ])

  const planByLine = new Map(plans.map((p) => [p.lineId, p]))

  // Floor efficiency is total earned minutes over total available minutes — NOT the mean of
  // the per-line percentages, which would weight a 12-operator line the same as a 44-operator
  // one and let one small idle line drag the whole floor's number down.
  let earned = 0
  let available = 0
  for (const row of rows) {
    const plan = planByLine.get(row.lineId)
    if (!plan?.smv || plan.manpower <= 0) continue
    // A line with nothing entered yet is not running at 0% — it has no efficiency, and the
    // board leaves it out of the floor figure rather than dragging everyone down with it.
    if (row.hours.length === 0) continue
    const result = computeEfficiency({
      smv: plan.smv,
      output: row.actual,
      manpower: plan.manpower,
      // The hours entered so far, NOT a whole shift. This board is read at ten in the
      // morning: dividing two hours of work by eight showed a line running perfectly at a
      // quarter of its efficiency, and the number climbed all day towards the truth without
      // ever being it (§9, F42).
      workingMinutes: workedMinutes(row.hours.length),
    })
    earned += Number(result.earnedMinutes)
    available += Number(result.availableMinutes)
  }

  return (
    <TvBoard
      lines={rows.map((r) => ({
        code: r.code,
        target: r.target,
        actual: r.actual,
        stopped: r.openDowntime !== null,
      }))}
      target={rows.reduce((n, r) => n + r.target, 0)}
      actual={rows.reduce((n, r) => n + r.actual, 0)}
      floorEfficiency={available > 0 ? ((earned / available) * 100).toFixed(1) : null}
      stoppages={rows
        .filter((r) => r.openDowntime !== null)
        .map((r) => ({
          lineCode: r.code,
          reason: r.openDowntime!.reason,
          startedAt: r.openDowntime!.startedAt.toISOString(),
        }))}
    />
  )
}
