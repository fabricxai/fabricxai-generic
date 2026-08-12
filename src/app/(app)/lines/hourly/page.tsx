import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { and, eq, isNull } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { DayCatchupButton } from './day-catchup'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { machines } from '@/modules/maintenance/schema'
import { lines } from '@/modules/planning/schema'
import { board } from '@/modules/production/queries'
import { dailyLinePlans, downtimes } from '@/modules/production/schema'

import { HourlyClient } from './hourly-client'
import { factoryHour, factoryToday } from '@/lib/dates'

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

  /*
   * The machines a stoppage can name. `downtimes.machine_id` has existed since 6.1 and
   * the dialog offered only free text, so every machine stoppage reached maintenance as
   * "machine not identified" — a mechanic walking to a floor to find out which machine
   * (live-test finding, Phase 6). Read across the module boundary through the owner's
   * table only for the picker's labels; the write still goes through production's zod.
   */
  const machineRows = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: machines.id,
        machineType: machines.machineType,
        serial: machines.serial,
        lineId: machines.lineId,
      })
      .from(machines)
      .orderBy(machines.machineType),
  )

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
        back={{ href: '/lines', label: 'Line tracking' }}
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

  // The hour the floor is in now, on the FACTORY's clock — the server is UTC and Dhaka is
  // six hours ahead, so `new Date().getHours()` pinned this screen to 8:00 every evening.
  // Outside shift hours it clamps to the last one rather than offering hour 23 — a
  // supervisor entering at 6pm is catching up, not time-travelling.
  const nowHour = factoryHour()
  const currentHour = Math.min(
    Math.max(nowHour, SHIFT_START),
    SHIFT_START + SHIFT_HOURS - 1,
  )

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/lines', label: 'Line tracking' }}
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
        actions={
          <DayCatchupButton
            lines={rows.map((row) => ({
              lineId: row.lineId,
              code: row.code,
              orderId: planByLine.get(row.lineId)?.orderId ?? null,
            }))}
          />
        }
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
        machines={machineRows.map((m) => ({
          id: m.id,
          label: `${m.serial ?? m.machineType} · ${m.machineType}`,
          lineId: m.lineId,
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
