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
import { and, eq, isNull, sql } from 'drizzle-orm'

import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
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
  type ForecastResult,
} from './metrics'
import { trailingOutput } from './queries'
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

export async function recordHourlyOutputsIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
  offlineKey?: string,
): Promise<RecordOutputResult> {
  const payload = hourlyOutputBatch.parse(input)

  // One statement for the whole batch. Fifty round trips would be fifty network hops and
  // fifty index descents; this is one of each.
  await tx
    .insert(hourlyOutputs)
    .values(
      payload.entries.map((entry) => ({
        companyId: ctx.companyId,
        lineId: entry.lineId,
        orderId: entry.orderId ?? null,
        producedOn: entry.producedOn,
        hourSlot: entry.hourSlot,
        target: entry.target,
        actual: entry.actual,
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
 */
export async function closeDay(
  ctx: AnyCtx,
  input: { forDate: string; workingMinutes?: number },
): Promise<{ lines: number }> {
  const workingMinutes = input.workingMinutes ?? 480

  return withTenantTx(ctx, async (tx) => {
    const rows = await tx
      .select({
        lineId: hourlyOutputs.lineId,
        output: sql<string>`sum(${hourlyOutputs.actual})::text`,
      })
      .from(hourlyOutputs)
      .where(scoped(hourlyOutputs, ctx, eq(hourlyOutputs.producedOn, input.forDate)))
      .groupBy(hourlyOutputs.lineId)

    let written = 0

    for (const row of rows) {
      const [plan] = await tx
        .select()
        .from(dailyLinePlans)
        .where(scoped(dailyLinePlans, ctx, 
          and(eq(dailyLinePlans.lineId, row.lineId), eq(dailyLinePlans.planDate, input.forDate)),
        ))

      // No plan means no SMV and no manpower — there is nothing to compute an efficiency
      // against, and inventing one would put a fabricated number on a board.
      if (!plan?.smv || !plan.manpowerPlanned) continue

      const output = Number(row.output)
      let efficiency
      try {
        efficiency = computeEfficiency({
          smv: plan.smv,
          output,
          manpower: plan.manpowerPlanned,
          workingMinutes,
        })
      } catch (error) {
        if (error instanceof ProductionError) continue
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
      payload: { forDate: input.forDate, lines: written },
      aggregateTable: 'efficiency_daily',
    })

    return { lines: written }
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
