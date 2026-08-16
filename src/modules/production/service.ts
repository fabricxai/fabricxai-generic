/**
 * 6.1 Line Tracking ⚡ — service layer.
 *
 * This is the burst-write path. Fifty lines all post the hour's count within the same
 * minute, while twenty dashboards poll the board. The brief's target is p95 write
 * < 500ms and p95 board read < 800ms on VPS-class hardware, and `k6/production_burst.js`
 * is what proves it.
 *
 * Two decisions the shape of this file follows from:
 *
 * **The whole batch is ONE statement.** A fifty-row batch as fifty round trips is fifty
 * network hops and fifty index descents; as a single multi-row upsert it is one. That is
 * most of the difference between hitting the target and not, and it is why nothing here
 * loops over entries issuing queries.
 *
 * **Idempotency is the natural key, not a ledger lookup.** `(line_id, produced_on,
 * hour_slot)` is unique, so `ON CONFLICT DO UPDATE` makes a replayed batch a no-op *and*
 * makes a supervisor's correction to the 14:00 count work by the same mechanism. The
 * `offline_keys` ledger still guards the batch as a whole; this guards each cell.
 */
import { and, eq, inArray, isNull, sql } from 'drizzle-orm'

import { lines } from '@/modules/planning/schema'

import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, forbidden, notFound } from '../core/errors'
import { notify } from '../core/notifications'
import { registerSyncHandler } from '../core/offline-sync'
import { emit } from '../core/outbox'
import { scoped } from '../core/scoped'
import { type TenantDb, withTenantRead, withTenantTx } from '../core/tenancy'

import { PRODUCTION_EVENTS } from './events'
import {
  computeDhu,
  computeEfficiency,
  forecastCompletion,
  ProductionError,
  planForEfficiency,
  workedMinutes,
  type ForecastResult,
  type SkipReason,
} from './metrics'
import { trailingOutput } from './queries'
import { lineDayKey, orderForEntry } from './attribution'
import { refusedLines } from './scope'
import {
  dailyLinePlans,
  downtimes,
  efficiencyDaily,
  endlineCounts,
  hourlyOutputs,
} from './schema'
import { closeDowntime, dayPlan, endlineCount, hourlyOutputBatch, openDowntime } from './zod'

/**
 * Plan one line's day: which order it runs, at what target, with how many people.
 *
 * `daily_line_plans` was written only by the seed (live-test finding, Phase 6) — no
 * screen, no action, no tool — so on a real tenant the hourly board had no targets,
 * outputs attached to no order, and the efficiency day-close skipped every line. This is
 * the record everything on the floor hangs off, and it had no origin.
 *
 * Upsert on (line, date): re-planning a day is a correction, not a second plan.
 */
export async function planLineDay(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ planId: string }> {
  const payload = dayPlan.parse(input)

  return withTenantTx(ctx, async (tx) => {
    // A chief who supervises L1 and L2 does not plan L5's day either (§9, F45).
    await assertLinesInScope(ctx, tx, [payload.lineId])

    const [row] = await tx
      .insert(dailyLinePlans)
      .values({
        companyId: ctx.companyId,
        lineId: payload.lineId,
        orderId: payload.orderId,
        planDate: payload.planDate,
        targetPerHour: payload.targetPerHour,
        manpowerPlanned: payload.manpowerPlanned,
        smv: payload.smv ?? null,
        createdBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [dailyLinePlans.lineId, dailyLinePlans.planDate],
        set: {
          orderId: payload.orderId,
          targetPerHour: payload.targetPerHour,
          manpowerPlanned: payload.manpowerPlanned,
          smv: payload.smv ?? null,
          updatedAt: new Date(),
        },
      })
      .returning({ id: dailyLinePlans.id })

    if (!row) throw new Error('daily_line_plans upsert returned nothing')
    return { planId: row.id }
  })
}

export interface RecordOutputResult {
  written: number
  /** Per entry, so a device can reconcile exactly which cells landed. */
  results: { lineId: string; producedOn: string; hourSlot: number; status: 'upserted' }[]
}

/**
 * Record an hour of output for one or many lines.
 *
 * Single multi-row upsert — see the file header. `ON CONFLICT DO UPDATE` is what makes
 * this idempotent: replaying the batch rewrites the same cells with the same values, and
 * a supervisor correcting a count uses the identical path.
 *
 * `updated_at` moves on every upsert so the board can tell a stale cell from a confirmed
 * one; `created_at` does not, so "when was this hour first reported" survives a
 * correction.
 */
/**
 * Company policy for the floor. Read from X.3 Settings by the caller, like every other
 * module's — a threshold hardcoded in a screen is a threshold no factory can change.
 */
export interface ProductionPolicy {
  /**
   * Achievement against the day's target below which a line counts as behind.
   *
   * Not "any shortfall". A sewing line finishes a few pieces under target most days, and a
   * board that flags every one of them flags all six lines at once — at which point the
   * word stops carrying information and a supervisor stops reading it. The number that
   * matters is the line far enough behind that somebody has to do something.
   */
  behindTargetPct?: string
}

/**
 * A supervisor writes to the lines they supervise, and to no others.
 *
 * `roles.scope.lines` has narrowed what the line screens SHOW since a line chief scoped to
 * L1/L2 saw all eight — but it narrowed nothing else. It was read in exactly four places,
 * every one a `.filter()` in a page component, and no service, query or handler consulted it.
 * Posting another line's uuid through the screen's own queue endpoint came back `applied`:
 * 999 pieces written to L3 by a supervisor who does not supervise it (§9, F45). That is the
 * shape rule 8 exists to forbid — *"gates are server-side and structured. Never UI-only."*
 *
 * What this is and is not: it is not a tenancy wall. `scoped()` already refuses another
 * company's line and that is the wall that matters. This is the narrower promise the product
 * makes to a factory that divides its floor between chiefs — and a promise that does not hold
 * is one the system should not make.
 *
 * **Costs nothing for the unscoped**, which is nearly everybody: no `lineScope` on the ctx
 * means no query. A scoped caller pays one indexed read of a table with eight rows in it,
 * which the burst path can afford.
 *
 * Scope is kept as line CODES — "L1", the thing a person says — and payloads name uuids, so
 * the codes have to be looked up. Resolving the other way (codes to ids, once) would cache a
 * mapping that a renamed line invalidates silently.
 */
async function assertLinesInScope(
  ctx: AnyCtx,
  tx: TenantDb,
  lineIds: readonly string[],
): Promise<void> {
  const scope = 'lineScope' in ctx ? ctx.lineScope : undefined
  // Undefined means the whole floor: either an unscoped role, or one unscoped role widening
  // the narrower ones (session.ts). A job carries no scope at all and is not narrowed here.
  if (!scope) return

  const ids = [...new Set(lineIds)]
  if (ids.length === 0) return

  const rows = await tx
    .select({ id: lines.id, code: lines.code })
    .from(lines)
    .where(scoped(lines, ctx, inArray(lines.id, ids)))

  // The decision itself is pure and lives in `scope.ts`, where it can be read and tested
  // without a database. Refused lines are named by CODE — the person reading this knows
  // their floor by "L3", and a uuid tells them nothing they can act on.
  const { refused } = refusedLines({
    lineIds: ids,
    scope,
    known: new Map(rows.map((row) => [row.id, row.code])),
  })

  if (refused.length > 0) {
    throw forbidden('production.errors.line_out_of_scope', {
      lines: refused,
      scope: [...scope],
    })
  }
}

/**
 * Which order each line was running on the day being written.
 *
 * **The day decides, not the clock.** `daily_line_plans` is the record of what a line ran on
 * a given date, and it is the only thing that knows — so the write resolves the order from
 * the plan for `producedOn` rather than trusting whatever the caller worked out. Three
 * callers, and two of them were wrong without this:
 *
 *  - the day catch-up reads a sheet for a PAST day and took its order from TODAY's plan. On
 *    Nordkap that booked 1,295 pieces against no order at all; had a different order been
 *    planned today it would have attached the day to the wrong one, silently, and overstated
 *    one order's sewn quantity while another ran short (§9, F44);
 *  - the board's hour edit sent no order at all, orphaning every cell corrected from it.
 *
 * The caller's own `orderId` survives only as a fallback for a day with no plan — seeds and
 * `/api/production/outputs` name it directly — so this narrows what is trusted rather than
 * widening it.
 */
async function plannedOrderByLineDay(
  ctx: AnyCtx,
  tx: TenantDb,
  entries: readonly { lineId: string; producedOn: string }[],
): Promise<Map<string, string>> {
  const lineIds = [...new Set(entries.map((e) => e.lineId))]
  const dates = [...new Set(entries.map((e) => e.producedOn))]
  if (lineIds.length === 0 || dates.length === 0) return new Map()

  // One query for the whole batch, matching the file's rule that nothing here loops issuing
  // queries. The line × date cross-product may fetch a few plans this batch does not need;
  // they are keyed exactly on the way into the map, so they cost a row and change nothing.
  const rows = await tx
    .select({
      lineId: dailyLinePlans.lineId,
      planDate: dailyLinePlans.planDate,
      orderId: dailyLinePlans.orderId,
    })
    .from(dailyLinePlans)
    .where(
      scoped(
        dailyLinePlans,
        ctx,
        and(inArray(dailyLinePlans.lineId, lineIds), inArray(dailyLinePlans.planDate, dates)),
      ),
    )

  return new Map(
    rows.map((row) => [lineDayKey({ lineId: row.lineId, producedOn: row.planDate }), row.orderId]),
  )
}

export async function recordHourlyOutputsIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
  offlineKey?: string,
): Promise<RecordOutputResult> {
  const payload = hourlyOutputBatch.parse(input)

  await assertLinesInScope(ctx, tx, payload.entries.map((entry) => entry.lineId))

  // What each line was running on the day being written — see above. One query, before the
  // insert, so the batch is still a single statement.
  const planned = await plannedOrderByLineDay(ctx, tx, payload.entries)

  // One statement for the whole batch. Fifty round trips would be fifty network hops and
  // fifty index descents; this is one of each.
  await tx
    .insert(hourlyOutputs)
    .values(
      payload.entries.map((entry) => ({
        companyId: ctx.companyId,
        lineId: entry.lineId,
        orderId: orderForEntry(planned, entry),
        producedOn: entry.producedOn,
        hourSlot: entry.hourSlot,
        target: entry.target,
        actual: entry.actual,
        remark: entry.remark ?? null,
        offlineKey: offlineKey ?? null,
        enteredBy: ctx.userId,
      })),
    )
    .onConflictDoUpdate({
      target: [hourlyOutputs.lineId, hourlyOutputs.producedOn, hourlyOutputs.hourSlot],
      set: {
        actual: sql`excluded.actual`,
        target: sql`excluded.target`,
        orderId: sql`excluded.order_id`,
        /*
         * A write that says nothing about the remark leaves it alone.
         *
         * The hourly keypad enters one number per line and has no remark field, so a plain
         * `excluded.remark` would blank the explanation somebody typed off the sheet every
         * time the hour was corrected — the same silent discard this column exists to end
         * (§9, F43). Absent means no opinion; an empty string is how the box that DOES ask
         * says "clear it".
         */
        remark: sql`case
          when excluded.remark is null then ${hourlyOutputs.remark}
          when excluded.remark = '' then null
          else excluded.remark
        end`,
        updatedAt: new Date(),
      },
    })

  // Deliberately ONE event for the batch, not one per row. Fifty lines posting at 17:00
  // would otherwise put 500 events through the relay every hour to say the same thing.
  await emit(ctx, tx, {
    eventName: PRODUCTION_EVENTS.outputRecorded,
    payload: {
      entries: payload.entries.length,
      lines: [...new Set(payload.entries.map((e) => e.lineId))].length,
      producedOn: payload.entries[0]?.producedOn ?? null,
    },
    aggregateTable: 'hourly_outputs',
    ...(payload.entries[0] ? { aggregateId: payload.entries[0].lineId } : {}),
  })

  await warnIfBehindPlan(ctx, tx, payload.entries)

  return {
    written: payload.entries.length,
    results: payload.entries.map((entry) => ({
      lineId: entry.lineId,
      producedOn: entry.producedOn,
      hourSlot: entry.hourSlot,
      status: 'upserted' as const,
    })),
  }
}

/**
 * The run-rate slip, said while there is still shift left (mobile contract §3 — the Hour
 * app's first push; also the `runrate_miss` signal the exceptions feed has listed as
 * "coverage: false" since 11.2 shipped).
 *
 * A line is BEHIND when its day so far trails the plan by at least one full hour's target
 * — "an hour behind" rather than a percentage, because it is the unit the floor already
 * thinks in and it needs no policy knob nobody will tune. Checked only for lines with a
 * day plan (a line without one has no rate to slip against), only against hours already
 * recorded, and said ONCE per line per day: the dedupe key means the 15:00 entry that
 * confirms the 14:00 slip buzzes nobody twice.
 *
 * Push rides the same row the bell shows. A supervisor standing at the machine gets the
 * buzz; everyone else sees it in-app.
 */
async function warnIfBehindPlan(
  ctx: AnyCtx,
  tx: TenantDb,
  entries: readonly { lineId: string; producedOn: string }[],
): Promise<void> {
  const lineDays = [...new Map(entries.map((e) => [`${e.lineId}|${e.producedOn}`, e])).values()]

  for (const { lineId, producedOn } of lineDays) {
    const [plan] = await tx
      .select({ targetPerHour: dailyLinePlans.targetPerHour })
      .from(dailyLinePlans)
      .where(scoped(dailyLinePlans, ctx, and(eq(dailyLinePlans.lineId, lineId), eq(dailyLinePlans.planDate, producedOn))))
    if (!plan || plan.targetPerHour <= 0) continue

    const recorded = await tx
      .select({ actual: hourlyOutputs.actual })
      .from(hourlyOutputs)
      .where(scoped(hourlyOutputs, ctx, 
        and(eq(hourlyOutputs.lineId, lineId), eq(hourlyOutputs.producedOn, producedOn)),
      ))

    const made = recorded.reduce((sum, row) => sum + row.actual, 0)
    const expected = recorded.length * plan.targetPerHour
    if (expected - made < plan.targetPerHour) continue

    const [line] = await tx
      .select({ code: lines.code })
      .from(lines)
      .where(scoped(lines, ctx, eq(lines.id, lineId)))

    await notify(ctx, {
      role: 'production',
      kind: 'production.runrate.slip',
      severity: 'warning',
      titleKey: 'production.notifications.runrate_slip.title',
      bodyKey: 'production.notifications.runrate_slip.body',
      params: {
        line: line?.code ?? 'a line',
        made,
        expected,
        behind: expected - made,
      },
      moduleId: 'production',
      entityTable: 'hourly_outputs',
      entityId: lineId,
      href: '/lines/hourly',
      dedupeKey: `runrate-slip:${lineId}:${producedOn}`,
      channels: ['in_app', 'push'],
    })
  }
}

export async function recordHourlyOutputs(
  ctx: RequestCtx,
  input: unknown,
): Promise<RecordOutputResult> {
  return withTenantTx(ctx, (tx) => recordHourlyOutputsIn(ctx, tx, input))
}

/**
 * The board: one company's day, all lines, all hours.
 *
 * Reads a single partition thanks to the equality on `produced_on` — the whole reason the
 * table is partitioned by month. `EXPLAIN` on this query shows the other partitions
 * removed from the plan rather than scanned.
 */
export async function getBoard(
  ctx: AnyCtx,
  input: { producedOn: string },
): Promise<(typeof hourlyOutputs.$inferSelect)[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select()
      .from(hourlyOutputs)
      .where(scoped(hourlyOutputs, ctx, eq(hourlyOutputs.producedOn, input.producedOn)))
      .orderBy(hourlyOutputs.lineId, hourlyOutputs.hourSlot),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Downtime
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a downtime. A machine stoppage emits its own event so module 9.1 can raise a
 * maintenance ticket and link back — the brief calls for that link to be automatic,
 * because a supervisor with a stopped line does not stop to file paperwork.
 */
export async function openLineDowntime(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ downtimeId: string }> {
  return withTenantTx(ctx, (tx) => openLineDowntimeIn(ctx, tx, input))
}

/**
 * The body of `openLineDowntime`, callable from the offline sync handler's transaction.
 *
 * A stoppage is logged by a supervisor standing at a dead line, on a tablet, in the part of
 * the building where the wifi is worst — so it has to survive the network being gone. Until
 * this was extracted there was no handler at all: `openLineDowntime` was exported and
 * reachable from nothing, so a stopped line could be seeded but never reported.
 */
export async function openLineDowntimeIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ downtimeId: string }> {
  const payload = openDowntime.parse(input)

  await assertLinesInScope(ctx, tx, [payload.lineId])

  {
    // One open downtime per line: two would double-count lost minutes, and the second
    // close would silently do nothing.
    const [existing] = await tx
      .select()
      .from(downtimes)
      .where(scoped(downtimes, ctx, and(eq(downtimes.lineId, payload.lineId), isNull(downtimes.endedAt))))

    if (existing) {
      throw conflict('production.errors.downtime_already_open', {
        lineId: payload.lineId,
        downtimeId: existing.id,
        since: existing.startedAt.toISOString(),
      })
    }

    const [row] = await tx
      .insert(downtimes)
      .values({
        companyId: ctx.companyId,
        lineId: payload.lineId,
        startedAt: new Date(payload.startedAt),
        reason: payload.reason,
        machineId: payload.machineId ?? null,
        note: payload.note ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: downtimes.id })

    if (!row) throw new Error('downtimes insert returned nothing')

    await emit(ctx, tx, {
      eventName:
        payload.reason === 'machine'
          ? PRODUCTION_EVENTS.machineDowntime
          : PRODUCTION_EVENTS.downtimeOpened,
      payload: {
        downtimeId: row.id,
        lineId: payload.lineId,
        reason: payload.reason,
        machineId: payload.machineId ?? null,
        startedAt: payload.startedAt,
      },
      aggregateTable: 'downtimes',
      aggregateId: row.id,
    })

    return { downtimeId: row.id }
  }
}

export async function closeLineDowntime(
  // `AnyCtx`, not `RequestCtx`: 9.1's ticket-resolved consumer closes the stoppage as a
  // system actor. `closeLineDowntimeIn` already accepted one; only this wrapper was narrow.
  ctx: AnyCtx,
  input: unknown,
): Promise<{ downtimeId: string; minutes: number }> {
  return withTenantTx(ctx, (tx) => closeLineDowntimeIn(ctx, tx, input))
}

/** The body of `closeLineDowntime`, callable from the offline sync handler. */
export async function closeLineDowntimeIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ downtimeId: string; minutes: number }> {
  const payload = closeDowntime.parse(input)

  {
    const [row] = await tx
      .select()
      .from(downtimes)
      .where(scoped(downtimes, ctx, eq(downtimes.id, payload.downtimeId)))
      .for('update')

    if (!row) throw notFound('production.errors.downtime_not_found', { id: payload.downtimeId })

    // Resolved from the row rather than the payload — closing another chief's stoppage is
    // the same act as opening one, and this call names only the downtime (§9, F45).
    await assertLinesInScope(ctx, tx, [row.lineId])

    if (row.endedAt) {
      throw conflict('production.errors.downtime_already_closed', { id: row.id })
    }

    const endedAt = new Date(payload.endedAt)
    if (endedAt < row.startedAt) {
      throw new AppError('validation_failed', 'production.errors.downtime_ends_before_start', {
        startedAt: row.startedAt.toISOString(),
        endedAt: payload.endedAt,
      })
    }

    await tx
      .update(downtimes)
      .set({ endedAt, note: payload.note ?? row.note })
      .where(scoped(downtimes, ctx, eq(downtimes.id, row.id)))

    const minutes = Math.round((endedAt.getTime() - row.startedAt.getTime()) / 60_000)

    await emit(ctx, tx, {
      eventName: PRODUCTION_EVENTS.downtimeClosed,
      payload: { downtimeId: row.id, lineId: row.lineId, reason: row.reason, minutes },
      aggregateTable: 'downtimes',
      aggregateId: row.id,
    })

    return { downtimeId: row.id, minutes }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Endline counts (shared table — production is the only writer, rule 11)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record the endline QC count. Module 7.1 Quality co-writes THROUGH here rather than
 * touching the table, so there stays exactly one writer (architecture §2.3).
 */
export async function recordEndlineCount(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ dhu: string; passRatePct: string }> {
  return withTenantTx(ctx, (tx) => recordEndlineCountIn(ctx, tx, input))
}

/**
 * The body of `recordEndlineCount`, callable from the offline sync handler.
 *
 * Endline QC is counted at the end of a sewing line by somebody with a clicker and a
 * tablet — the same device, the same dead spots, the same need to replay. It had no
 * handler either, so the DHU every quality screen reads could be seeded and never entered.
 */
export async function recordEndlineCountIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ dhu: string; passRatePct: string }> {
  const payload = endlineCount.parse(input)

  await assertLinesInScope(ctx, tx, [payload.lineId])

  if (payload.passed + payload.defective > payload.checked) {
    throw new AppError('validation_failed', 'production.errors.count_exceeds_checked', {
      checked: payload.checked,
      passed: payload.passed,
      defective: payload.defective,
    })
  }

  {
    await tx
      .insert(endlineCounts)
      .values({
        companyId: ctx.companyId,
        lineId: payload.lineId,
        countedOn: payload.countedOn,
        checked: payload.checked,
        passed: payload.passed,
        defective: payload.defective,
        defects: payload.defects,
        rework: payload.rework,
      })
      .onConflictDoUpdate({
        target: [endlineCounts.lineId, endlineCounts.countedOn],
        set: {
          checked: sql`excluded.checked`,
          passed: sql`excluded.passed`,
          defective: sql`excluded.defective`,
          defects: sql`excluded.defects`,
          rework: sql`excluded.rework`,
          updatedAt: new Date(),
        },
      })

    const dhu = payload.checked > 0 ? computeDhu(payload).dhu : '0.00'
    const passRate =
      payload.checked > 0
        ? ((payload.passed * 10_000) / payload.checked / 100).toFixed(2)
        : '0.00'

    return { dhu, passRatePct: passRate }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Derived
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Day-close efficiency for every line that ran. Idempotent — safe to re-run, and safe to
 * rebuild from `hourly_outputs` at any time (architecture §4, derived tables).
 *
 * **The day is as long as the hours the line recorded**, not a nominal 480 minutes. The same
 * rows this sums for output also say how long the line was manned, and dividing a nine-hour
 * day by eight reported Nordkap's L-3 at 73.80% where the floor did 65.60% — an error that
 * grew with every hour of overtime and always in the flattering direction (§9, F42).
 * `workedMinutes` carries the reasoning.
 *
 * `workingMinutes` stays as an explicit override for a factory that states its own shift
 * length, but nothing passes one by default any more.
 */
export async function closeDay(
  ctx: AnyCtx,
  input: { forDate: string; workingMinutes?: number },
): Promise<{ lines: number; skipped: { lineId: string; reason: SkipReason }[] }> {
  return withTenantTx(ctx, async (tx) => {
    const rows = await tx
      .select({
        lineId: hourlyOutputs.lineId,
        output: sql<string>`sum(${hourlyOutputs.actual})::text`,
        // One row per hour — the unique index on (line, date, hour) makes this the count of
        // hours the line was manned, not a count of writes.
        hoursRecorded: sql<string>`count(*)::text`,
      })
      .from(hourlyOutputs)
      .where(scoped(hourlyOutputs, ctx, eq(hourlyOutputs.producedOn, input.forDate)))
      .groupBy(hourlyOutputs.lineId)

    let written = 0
    /*
     * Lines that produced and got no efficiency, and why.
     *
     * Skipping is right — there is nothing to compute against — but it was SILENT, so a
     * supervisor entered a day's output believing it was being measured and no number was
     * ever produced from it. The floor's own screen now says a line has no plan before the
     * hour is entered, and the day-close says which lines it could not close after (§9, F47).
     */
    const skipped: { lineId: string; reason: SkipReason }[] = []

    for (const row of rows) {
      const [plan] = await tx
        .select()
        .from(dailyLinePlans)
        .where(scoped(dailyLinePlans, ctx, 
          and(eq(dailyLinePlans.lineId, row.lineId), eq(dailyLinePlans.planDate, input.forDate)),
        ))

      // No plan means no SMV and no manpower — there is nothing to compute an efficiency
      // against, and inventing one would put a fabricated number on a board.
      // The decision, and the reason it carries, are pure and live in `metrics.ts`.
      const measurable = planForEfficiency(plan ?? null)
      if (!measurable.ok) {
        skipped.push({ lineId: row.lineId, reason: measurable.reason })
        continue
      }

      const output = Number(row.output)
      let efficiency
      try {
        efficiency = computeEfficiency({
          smv: measurable.smv,
          output,
          manpower: measurable.manpower,
          workingMinutes: input.workingMinutes ?? workedMinutes(Number(row.hoursRecorded)),
        })
      } catch (error) {
        if (error instanceof ProductionError) {
          // A plan that passed the precondition and still would not compute — a zero-hour
          // day, say. Reported as the half-filled case: something about the plan is wrong.
          skipped.push({ lineId: row.lineId, reason: 'plan_missing_smv_or_manpower' })
          continue
        }
        throw error
      }

      await tx
        .insert(efficiencyDaily)
        .values({
          companyId: ctx.companyId,
          lineId: row.lineId,
          forDate: input.forDate,
          earnedMinutes: efficiency.earnedMinutes,
          availableMinutes: efficiency.availableMinutes,
          efficiencyPct: efficiency.efficiencyPct,
          outputTotal: output,
        })
        .onConflictDoUpdate({
          target: [efficiencyDaily.lineId, efficiencyDaily.forDate],
          set: {
            earnedMinutes: efficiency.earnedMinutes,
            availableMinutes: efficiency.availableMinutes,
            efficiencyPct: efficiency.efficiencyPct,
            outputTotal: output,
            computedAt: new Date(),
          },
        })

      written += 1
    }

    await emit(ctx, tx, {
      eventName: PRODUCTION_EVENTS.dayClosed,
      payload: { forDate: input.forDate, lines: written, skipped: skipped.length },
      aggregateTable: 'efficiency_daily',
    })

    return { lines: written, skipped }
  })
}

/**
 * Forecast an order's completion from its trailing sewing rate, and compare it against
 * the TNA sewing milestone (brief §Operations: `runRate`).
 *
 * Takes `remainingQty` from the caller because the risk job forecasts against a target that
 * is not always the contracted quantity — a split shipment burns down its own tranche. The
 * order screen wants the plain contracted burn-down and reads `orderRunRate` instead; both
 * share `trailingOutput`, so there is one window and one rate, not two that drift.
 */
export async function runRate(
  ctx: AnyCtx,
  input: {
    orderId: string
    remainingQty: number
    asOf: string
    trailingDays?: number
    milestoneDate?: string | null
  },
): Promise<ForecastResult> {
  const trailing = await trailingOutput(ctx, {
    orderId: input.orderId,
    asOf: input.asOf,
    days: input.trailingDays ?? 3,
  })

  // Always a full window, zeros included, so an order nobody has sewn yields
  // confidence `none` rather than throwing — "we cannot forecast because nothing has been
  // sewn" is a useful answer to put on a screen; an exception is not.
  return forecastCompletion({
    remainingQty: input.remainingQty,
    trailing,
    fromDate: input.asOf,
    milestoneDate: input.milestoneDate ?? null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline sync
// ─────────────────────────────────────────────────────────────────────────────

export function registerProductionSyncHandlers(): void {
  registerSyncHandler('production', 'record_hourly_outputs', { roles: ['production'] }, async (ctx, tx, row) => {
    await recordHourlyOutputsIn(ctx, tx, row.payload, row.offlineKey)
    // The batch has no single row id; the offline key IS its identity, which is what the
    // device reconciles against anyway.
    return { rowId: row.offlineKey }
  })

  // Everything below is floor-facing (rule 7) and had NO handler: the service functions
  // were exported and unreachable from any client, so a stoppage could be seeded but never
  // reported, and the DHU every quality screen reads could never be entered by the person
  // holding the clicker. All three are logged on a tablet at a dead line or the end of a
  // sewing line, which is exactly where the network is worst.
  registerSyncHandler('production', 'open_downtime', { roles: ['production'] }, async (ctx, tx, row) => {
    const result = await openLineDowntimeIn(ctx, tx, row.payload)
    return { rowId: result.downtimeId }
  })

  registerSyncHandler('production', 'close_downtime', { roles: ['production'] }, async (ctx, tx, row) => {
    const result = await closeLineDowntimeIn(ctx, tx, row.payload)
    return { rowId: result.downtimeId }
  })

  registerSyncHandler('production', 'record_endline_count', { roles: ['production'] }, async (ctx, tx, row) => {
    await recordEndlineCountIn(ctx, tx, row.payload)
    // One count per line per day — the row's identity is the pair, not a generated id.
    return { rowId: row.offlineKey }
  })
}
