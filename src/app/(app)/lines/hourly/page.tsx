import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { lines } from '@/modules/planning/schema'
import { board } from '@/modules/production/queries'
import { dailyLinePlans, downtimes } from '@/modules/production/schema'

import { HourlyClient } from './hourly-client'
import { factoryToday } from '@/lib/dates'

/**
 * 6.1 Line tracking · hourly entry (canvas P1).
 *
 * The most-used screen in the building: a supervisor enters one number per line per hour,
 * on a tablet, standing on the floor. Everything about it is shaped by that —
 *
 *  - the write goes through the offline queue, idempotent on (line, hour), because the
 *    sewing floor is behind concrete and the network is not something a supervisor can fix;
 *  - the hour defaults to the current one, because typing the hour is the error nobody
 *    catches until the day's numbers are wrong;
 *  - a stoppage is logged from the same screen, because a supervisor with a dead line does
 *    not walk to an office to file paperwork.
 */
export const dynamic = 'force-dynamic'

/** A normal Bangladeshi sewing shift: 8 hours plus two of overtime. */
const SHIFT_HOURS = 10
const SHIFT_START = 8

export default async function HourlyPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const today = factoryToday()

  const [allRows, planRows, openStoppages] = await Promise.all([
    board(ctx, { producedOn: today, shiftHours: SHIFT_HOURS }),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          lineId: dailyLinePlans.lineId,
          orderId: dailyLinePlans.orderId,
          targetPerHour: dailyLinePlans.targetPerHour,
        })
        .from(dailyLinePlans)
        .where(eq(dailyLinePlans.planDate, today)),
    ),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          id: downtimes.id,
          lineId: downtimes.lineId,
          startedAt: downtimes.startedAt,
          reason: downtimes.reason,
          note: downtimes.note,
          lineCode: lines.code,
        })
        .from(downtimes)
        .innerJoin(lines, eq(lines.id, downtimes.lineId))
        .where(and(isNull(downtimes.endedAt))),
    ),
  ])

  // The caller's line narrowing, honoured — a chief scoped to L1/L2 enters L1/L2.
  const rows = ctx.lineScope
    ? allRows.filter((row) => ctx.lineScope!.includes(row.code))
    : allRows
  const stoppages = ctx.lineScope
    ? openStoppages.filter((s) => ctx.lineScope!.includes(s.lineCode))
    : openStoppages

  if (rows.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
          eyebrow={tui(locale, 'ui.production.hourly_eyebrow')}
          title={tui(locale, 'ui.production.no_lines_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.production.hourly_empty_title')}
          body={tui(locale, 'ui.production.hourly_empty_body')}
        />
      </FloorScreen>
    )
  }

  const planByLine = new Map(planRows.map((p) => [p.lineId, p]))

  // The hour the floor is in now. Outside shift hours it clamps to the last one rather
  // than offering hour 23 — a supervisor entering at 6pm is catching up, not time-travelling.
  const nowHour = new Date().getHours()
  const currentHour = Math.min(
    Math.max(nowHour, SHIFT_START),
    SHIFT_START + SHIFT_HOURS - 1,
  )

  return (
    <FloorScreen>
      <PageHeader
        eyebrow={tui(locale, 'ui.production.hourly_eyebrow_dated', { date: today })}
        title={tui(locale, 'ui.production.hour_title', { hour: currentHour })}
        meta={
          stoppages.length > 0
            ? tui(
                locale,
                stoppages.length === 1
                  ? 'ui.production.lines_stopped_one'
                  : 'ui.production.lines_stopped_other',
                { count: stoppages.length },
              )
            : undefined
        }
        ownsAmber
      />
      <HourlyClient
        producedOn={today}
        hour={currentHour}
        lines={rows.map((row) => ({
          lineId: row.lineId,
          code: row.code,
          name: row.name,
          target: planByLine.get(row.lineId)?.targetPerHour ?? 0,
          orderId: planByLine.get(row.lineId)?.orderId ?? null,
          alreadyEntered: row.hours.some((h) => h.hourSlot === currentHour),
        }))}
        stoppages={stoppages.map((s) => ({
          id: s.id,
          lineId: s.lineId,
          lineCode: s.lineCode,
          reason: s.reason,
          note: s.note,
          startedAt: s.startedAt.toISOString(),
        }))}
      />
    </FloorScreen>
  )
}
