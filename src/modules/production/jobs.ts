/**
 * Scheduled work for 6.1 (brief §Jobs).
 *
 * The partition roll-forward is the one that matters most and is easiest to forget: the
 * migration seeded twelve months ahead, and twelve months from now that window closes.
 * Rows would still land — the DEFAULT partition catches them, deliberately, because a
 * refused insert on a floor tablet is a lost hour of production — but they would stop
 * being pruned, and the board read would degrade quietly rather than break loudly.
 */
import { inArray, sql } from 'drizzle-orm'

import type { SystemCtx } from '../core/ctx'
import { notify } from '../core/notifications'
import { emit } from '../core/outbox'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx } from '../core/tenancy'
// `orders` and `tna_milestones` belong to 1.3 (rule 11) — production forecasts against
// them through the order module's own read model rather than joining their tables here.
import { lines } from '@/modules/planning/schema'
import { ordersInProduction } from '../orders/queries'

import { PRODUCTION_EVENTS } from './events'
import { orderRunRate } from './queries'
import { closeDay } from './service'
import { factoryMonth, factoryToday } from '@/lib/dates'

/** Months kept ahead of today. A scheduler outage has to be survivable. */
const PARTITION_LOOKAHEAD_MONTHS = 12

/**
 * Keep the monthly window open.
 *
 * Company-agnostic — partitions are physical storage, not tenant data — but it runs under
 * a scoped ctx like every other job, and the function it calls is the narrow
 * SECURITY DEFINER one from migration 0019 that also applies RLS to each new partition.
 */
export async function ensureOutputPartitions(
  ctx: SystemCtx,
  input: { monthsAhead?: number } = {},
): Promise<{ ensured: number; inDefault: number }> {
  const months = input.monthsAhead ?? PARTITION_LOOKAHEAD_MONTHS

  return withTenantTx(ctx, async (tx) => {
    for (let i = 0; i <= months; i += 1) {
      await tx.execute(
        sql`select app.ensure_hourly_output_partition((date_trunc('month', now()) + (${i} || ' month')::interval)::date)`,
      )
    }

    // Rows in DEFAULT mean the window ran out at some point. Not a correctness problem —
    // the data is safe and queryable — but it stops being pruned, so it is worth saying.
    const result = await tx.execute<{ n: string }>(
      sql`select count(*)::text as n from only hourly_outputs_default`,
    )
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const inDefault = Number((rows[0] as { n: string } | undefined)?.n ?? 0)

    if (inDefault > 0) {
      await notify(ctx, {
        role: 'admin',
        kind: 'production.partitions.default_in_use',
        severity: 'warning',
        titleKey: 'production.notifications.partition_default.title',
        params: { rows: inDefault },
        moduleId: 'production',
        dedupeKey: `production.partition_default:${factoryMonth()}`,
      })
    }

    return { ensured: months + 1, inDefault }
  })
}

/** Day-close efficiency for yesterday, plus the owner digest trigger. */
export async function runDayClose(
  ctx: SystemCtx,
  input: { forDate?: string } = {},
): Promise<{ lines: number; forDate: string; skipped: number }> {
  const forDate =
    input.forDate ??
    new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)

  const result = await closeDay(ctx, { forDate })

  /*
   * A line that sewed all day and got no efficiency figure is worth saying out loud.
   *
   * The skip itself is right — with no SMV and no manpower there is nothing to compute, and
   * inventing a number would put a fabricated one on a board. What was wrong is that it
   * happened in silence: the output was entered, the day closed, and the line simply never
   * appeared in the figures. Whoever plans the floor is the one who can fix it, so they are
   * the one told, once per day (§9, F47).
   */
  if (result.skipped.length > 0) {
    const codes = await withTenantRead(ctx, (tx) =>
      tx
        .select({ code: lines.code })
        .from(lines)
        .where(scoped(lines, ctx, inArray(lines.id, result.skipped.map((s) => s.lineId))))
        .orderBy(lines.code),
    )

    await notify(ctx, {
      role: 'planner',
      kind: 'production.dayclose.skipped',
      severity: 'warning',
      titleKey: 'production.notifications.dayclose_skipped.title',
      bodyKey: 'production.notifications.dayclose_skipped.body',
      params: {
        forDate,
        count: result.skipped.length,
        lines: codes.map((c) => c.code).join(', '),
      },
      moduleId: 'production',
      entityTable: 'efficiency_daily',
      href: '/lines',
      // Once per day, however many times the close is re-run — it is rebuildable by design.
      dedupeKey: `dayclose-skipped:${forDate}`,
      channels: ['in_app'],
    })
  }

  return { lines: result.lines, forDate, skipped: result.skipped.length }
}

/** Hourly WIP snapshot per order — cut / sewn / finished (brief §Jobs). */
export async function snapshotWip(ctx: SystemCtx): Promise<{ orders: number }> {
  return withTenantTx(ctx, async (tx) => {
    // Sewn comes from this module. Cut and finished belong to 5.1 and 8.1, which do not
    // exist yet — recorded as zero rather than guessed, so the gap is visible on the
    // dashboard instead of being papered over with a plausible number.
    const result = await tx.execute<{ n: string }>(sql`
      insert into wip_snapshots (company_id, order_id, taken_at, cut, sewn, finished)
      select h.company_id, h.order_id, now(), 0, sum(h.actual)::int, 0
      from hourly_outputs h
      where h.order_id is not null
      group by h.company_id, h.order_id
      returning 1`)

    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    return { orders: rows.length }
  })
}

/**
 * Run-rate risk alerts (brief §Jobs).
 *
 * Every night, forecast each live order from its trailing sewing rate and raise the ones
 * that will land after their sewing milestone. This is the alert behind the owner digest's
 * "one order will miss its date" — and it is the only place the slip is noticed early, since
 * nobody opens an order page to check a date that was fine yesterday.
 *
 * It deliberately says nothing about orders that are on track. A digest listing forty
 * healthy orders buries the one that is not.
 */
export async function runRunRateAlerts(
  ctx: SystemCtx,
  input: { today?: string } = {},
): Promise<{ checked: number; atRisk: number }> {
  const today = input.today ?? factoryToday()
  const live = await ordersInProduction(ctx)

  let atRisk = 0

  for (const order of live) {
    // No sewing milestone means nothing to be late against. The order still gets a forecast
    // on its own page; it just cannot generate a slip alert, and inventing a deadline to
    // measure it against would be worse than staying quiet.
    if (!order.sewingEndDate) continue

    const forecast = await orderRunRate(ctx, {
      orderId: order.id,
      contractedQty: order.contractedQty,
      asOf: today,
      milestoneDate: order.sewingEndDate,
    })

    // `confidence: 'none'` means nothing has been sewn in the window. That is not evidence
    // the order is late — it is the absence of evidence either way, and an order that has
    // not started sewing yet would otherwise alarm every single night until it did.
    if (!forecast.atRisk || forecast.confidence === 'none') continue

    atRisk += 1

    await withTenantTx(ctx, (tx) =>
      emit(ctx, tx, {
        eventName: PRODUCTION_EVENTS.runRateAtRisk,
        aggregateTable: 'orders',
        aggregateId: order.id,
        payload: {
          orderId: order.id,
          slipDays: forecast.slipDays,
          forecastDate: forecast.forecastDate,
          milestoneDate: order.sewingEndDate,
          ratePerDay: forecast.ratePerDay,
        },
      }),
    )

    await notify(ctx, {
      role: 'merchandiser',
      kind: 'production.run_rate.at_risk',
      severity: forecast.slipDays > 7 ? 'critical' : 'warning',
      titleKey: 'production.notifications.run_rate_at_risk.title',
      params: {
        poNumber: order.poNumber ?? order.id.slice(0, 8),
        slipDays: forecast.slipDays,
        forecastDate: forecast.forecastDate ?? '',
        milestoneDate: order.sewingEndDate,
        ratePerDay: forecast.ratePerDay,
      },
      moduleId: 'production',
      entityTable: 'orders',
      entityId: order.id,
      // Slip length is in the key, so a slip that widens from 2 days to 9 alerts again —
      // it has become a different problem — while a steady 2-day slip stays quiet.
      dedupeKey: `production.run_rate_at_risk:${order.id}:${forecast.slipDays}`,
    })
  }

  return { checked: live.length, atRisk }
}

export async function countOpenLines(ctx: SystemCtx): Promise<number> {
  const rows = await withTenantRead(ctx, (tx) =>
    tx.execute<{ n: string }>(sql`select count(*)::text as n from lines where is_active`),
  )
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
  return Number((list[0] as { n: string } | undefined)?.n ?? 0)
}
