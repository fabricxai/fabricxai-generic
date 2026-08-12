/**
 * 4.1 Capacity & Line Planning — service layer.
 *
 * The rule that shapes this whole file: **violations are returned, never silently
 * clamped** (brief §Operations). `allocate()` refuses an overloaded plan by default and
 * will commit one only when the caller passes `acceptViolations` — which is recorded on
 * the row and emitted as its own event. A planner may knowingly over-commit a line; the
 * system must never do it on their behalf, and must never lose the fact that it happened.
 *
 * The arithmetic lives in `capacity.ts` and is pure. This file only fetches the state that
 * arithmetic needs and writes the decisions back.
 */
import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import {
  allocationMachine,
  answerCapacityQuery,
  checkLineDayLoad,
  efficiencyForDay,
  PlanningError,
  scenarioMachine,
  type AllocationStatus,
  type CapacityAnswer,
  type LineDayCapacity,
  type LineDayLoadResult,
  type PlannedLoad,
  type PlanningViolation,
  type ScenarioStatus,
} from './capacity'
import { PLANNING_EVENTS } from './events'
import {
  allocations,
  factoryUnits,
  floors,
  learningCurves,
  lineCalendars,
  lines,
  scenarios,
  smvRecords,
} from './schema'
import {
  allocationPayload,
  lineCalendarRangePayload,
  linePayload,
  smvRecordPayload,
  type AllocationPayload,
} from './zod'

/** ⚖ — an allocation is what the factory has promised its capacity to. */
registerAuditedTables('allocations', 'smv_records')

/**
 * planned → active → done. There is no `cancelled`: an allocation that is not happening
 * is deleted, because a cancelled row that still sits on the board is a line somebody
 * thinks is busy.
 */
/*
 * The two machines live in `capacity.ts`, which is pure (plan 5.4).
 *
 * Re-exported here because every caller reads them from the service. They MOVED because the
 * planning board's own buttons need the legal transitions — offering a move the server
 * refuses is how somebody learns to distrust a board — and a client component importing this
 * file drags the database client, and therefore `postgres`, into the browser bundle. The
 * build says so, eventually, in a message about `fs`.
 */
export {
  allocationMachine,
  scenarioMachine,
  type AllocationStatus,
  type ScenarioStatus,
} from './capacity'

/**
 * Company planning defaults. Owned by Settings (X.3); passed in until that module exists.
 * There is deliberately no built-in fallback efficiency — see `resolveEfficiency`.
 */
export interface PlanningPolicy {
  defaultEfficiencyPct?: string
  defaultShiftMinutes?: number
}

function wrapPlanningError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof PlanningError) {
      // A plan the arithmetic refuses is a 422 the planner can act on, not a 500.
      throw new AppError('validation_failed', 'planning.errors.uncomputable', {
        reason: error.message,
      })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the state the arithmetic needs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an SMV for a style ⚖.
 *
 * Append-only, and that is the design: `requireSmv` takes the newest by `measured_at`, and
 * the older rows are the variance history an IE reads to see whether a study moved. Editing
 * one in place would erase the comparison that makes the newest number mean anything.
 *
 * Nothing created these rows before this — the table was read by the capacity arithmetic and
 * written only by the seed, so a factory with a new style had no way to enter its SMV except
 * a draft, and the draft could not commit.
 */
export async function recordSmv(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ smvRecordId: string }> {
  return withTenantTx(ctx, (tx) => recordSmvIn(ctx, tx, input))
}

/**
 * Create or update a sewing line, creating its floor and unit on the way if they are new.
 *
 * The whole chain in one call, because it is one thing a planner is doing: putting a line
 * on the board. Three separate forms — unit, then floor, then line — is three chances to
 * stop, and the day-one walkthrough found nobody could complete even the first.
 *
 * Codes are upserted, so re-submitting the same unit or floor attaches to it rather than
 * colliding on an index the planner cannot see.
 */
export async function upsertLine(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ lineId: string; floorId: string; created: boolean }> {
  const payload = linePayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    let floorId = payload.floorId ?? null

    if (!floorId) {
      const floor = payload.floor
      if (!floor) {
        throw new AppError('validation_failed', 'planning.errors.line_needs_floor', {
          code: payload.code,
        })
      }

      let unitId = floor.factoryUnitId ?? null
      if (!unitId) {
        const [unit] = await tx
          .insert(factoryUnits)
          .values({ companyId: ctx.companyId, code: floor.factoryUnit!.code, name: floor.factoryUnit!.name })
          .onConflictDoUpdate({
            target: [factoryUnits.companyId, factoryUnits.code],
            set: { name: floor.factoryUnit!.name },
          })
          .returning({ id: factoryUnits.id })
        unitId = unit!.id
      }

      const [row] = await tx
        .insert(floors)
        .values({ companyId: ctx.companyId, factoryUnitId: unitId, code: floor.code, name: floor.name })
        .onConflictDoUpdate({
          target: [floors.companyId, floors.code],
          set: { name: floor.name, factoryUnitId: unitId },
        })
        .returning({ id: floors.id })
      floorId = row!.id
    }

    const [before] = await tx
      .select({ id: lines.id })
      .from(lines)
      .where(scoped(lines, ctx, eq(lines.code, payload.code)))

    const [row] = await tx
      .insert(lines)
      .values({
        companyId: ctx.companyId,
        code: payload.code,
        name: payload.name,
        capacityManpower: payload.capacityManpower ?? null,
        machinesCount: payload.machinesCount ?? null,
        floorId,
        isActive: payload.isActive,
      })
      .onConflictDoUpdate({
        target: [lines.companyId, lines.code],
        set: {
          name: payload.name,
          capacityManpower: payload.capacityManpower ?? null,
          machinesCount: payload.machinesCount ?? null,
          floorId,
          isActive: payload.isActive,
        },
      })
      .returning({ id: lines.id })

    if (!row) throw new Error('lines upsert returned nothing')
    return { lineId: row.id, floorId, created: !before }
  })
}

/**
 * Say when a set of lines is working.
 *
 * **Nothing in the product wrote `line_calendars`.** Only the seed and the tests did, which
 * meant a factory that set up its own lines through the setup screen got eight lines with no
 * working days at all — and the planning board, whose every cell is read from this table,
 * drew a permanently blank grid. Booking anything on it then reported "these pieces have
 * nowhere to be made", correctly and unhelpfully, because there was no screen anywhere that
 * could tell the system a line works on Sundays (order-journey walk, stage 6).
 *
 * Capacity is what this table is: `shift_minutes` minus planned downtime, times manpower, is
 * the minutes a line can earn in a day, and every overload decision on the board is that
 * number against the SMV of what is on it.
 *
 * A day already on the calendar is UPDATED rather than duplicated — re-running a month with a
 * corrected shift length is the normal way this gets used, and the unique index on
 * (line, date) would otherwise turn a correction into an error.
 */
export async function setLineCalendar(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ lineDays: number; from: string; to: string }> {
  const payload = lineCalendarRangePayload.parse(input)

  if (payload.to < payload.from) {
    throw new AppError('validation_failed', 'planning.errors.calendar_range_backwards', {
      from: payload.from,
      to: payload.to,
    })
  }
  if (payload.plannedDowntimeMinutes >= payload.shiftMinutes) {
    // The check constraint says the same thing; this gives it a sentence rather than a
    // driver error somebody has to decode.
    throw new AppError('validation_failed', 'planning.errors.downtime_exceeds_shift', {
      shiftMinutes: payload.shiftMinutes,
      plannedDowntimeMinutes: payload.plannedDowntimeMinutes,
    })
  }

  const working = new Set(payload.weekdays)
  const dates: string[] = []
  const cursor = new Date(`${payload.from}T00:00:00Z`)
  const end = new Date(`${payload.to}T00:00:00Z`)
  // A year at a time, which is more than any factory plans and short of a runaway loop.
  while (cursor <= end && dates.length <= 400) {
    // getUTCDay is 0..6 from Sunday; ISO is 1..7 from Monday.
    const iso = cursor.getUTCDay() === 0 ? 7 : cursor.getUTCDay()
    if (working.has(iso)) dates.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  if (dates.length === 0) {
    throw new AppError('validation_failed', 'planning.errors.calendar_no_working_days', {
      from: payload.from,
      to: payload.to,
    })
  }

  return withTenantTx(ctx, async (tx) => {
    const owned = await tx
      .select({ id: lines.id })
      .from(lines)
      .where(scoped(lines, ctx, inArray(lines.id, payload.lineIds)))

    if (owned.length !== payload.lineIds.length) {
      throw notFound('planning.errors.line_not_found', {
        requested: payload.lineIds.length,
        found: owned.length,
      })
    }

    const rows = owned.flatMap((line) =>
      dates.map((calendarDate) => ({
        companyId: ctx.companyId,
        lineId: line.id,
        calendarDate,
        shiftMinutes: payload.shiftMinutes,
        plannedDowntimeMinutes: payload.plannedDowntimeMinutes,
        manpower: payload.manpower ?? null,
      })),
    )

    for (let i = 0; i < rows.length; i += 500) {
      await tx
        .insert(lineCalendars)
        .values(rows.slice(i, i + 500))
        .onConflictDoUpdate({
          target: [lineCalendars.lineId, lineCalendars.calendarDate],
          set: {
            shiftMinutes: payload.shiftMinutes,
            plannedDowntimeMinutes: payload.plannedDowntimeMinutes,
            manpower: payload.manpower ?? null,
            updatedAt: new Date(),
          },
        })
    }

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'line_calendars',
      targetId: payload.lineIds[0]!,
      after: {
        lines: payload.lineIds.length,
        from: payload.from,
        to: payload.to,
        days: dates.length,
        shiftMinutes: payload.shiftMinutes,
      },
    })

    return { lineDays: rows.length, from: payload.from, to: payload.to }
  })
}

/**
 * Commit an SMV drafted through the approve inbox — a study transcribed from an IE sheet.
 *
 * `smv_records` was a pending target with no handler, so core's generic write took it and
 * refused `styleCode` and `measuredAt` as invalid column identifiers. An SMV is what every
 * capacity promise is computed from, so a draft that could not commit meant the number had
 * no way in at all.
 */
export async function commitSmvRecord(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    // A restudy is a new record, not an edit — see `recordSmv`.
    throw new AppError('validation_failed', 'planning.errors.smv_draft_insert_only', {
      operation: input.operation,
    })
  }

  const result = await recordSmvIn(ctx, tx, input.payload)
  return { rowId: result.smvRecordId, before: null, after: { smvRecordId: result.smvRecordId } }
}

/** The insert itself, inside a transaction the caller owns. */
async function recordSmvIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ smvRecordId: string }> {
  const payload = smvRecordPayload.parse(input)

  const [row] = await tx
    .insert(smvRecords)
    .values({
      companyId: ctx.companyId,
      styleCode: payload.styleCode,
      smv: payload.smv,
      source: payload.source,
      measuredAt: payload.measuredAt ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: smvRecords.id })

  if (!row) throw new Error('smv_records insert returned nothing')

  await recordChange(ctx, tx, {
    action: 'insert',
    targetTable: 'smv_records',
    targetId: row.id,
    after: {
      styleCode: payload.styleCode,
      smv: payload.smv,
      source: payload.source,
      measuredAt: payload.measuredAt ?? null,
    },
  })

  return { smvRecordId: row.id }
}

/** The newest SMV on record for a style. Refuses rather than guessing one. */
/*
 * The five helpers here all took a `ctx` rather than an exemption (plan 1.3). They are the
 * inputs to a capacity plan — the SMV, the learning curve, the line's available days and
 * what is already committed on them — and a plan built from another factory's numbers would
 * look entirely reasonable and be wrong about when a shipment can leave.
 */
async function requireSmv(ctx: AnyCtx, tx: TenantDb, styleCode: string): Promise<string> {
  const [row] = await tx
    .select({ smv: smvRecords.smv })
    .from(smvRecords)
    .where(scoped(smvRecords, ctx, eq(smvRecords.styleCode, styleCode)))
    .orderBy(sql`${smvRecords.measuredAt} desc nulls last`, sql`${smvRecords.createdAt} desc`)
    .limit(1)

  if (!row) {
    // Planning a style with no SMV means inventing one, and an invented SMV is how a
    // factory commits to a date it cannot make.
    throw notFound('planning.errors.no_smv', { styleCode })
  }
  return row.smv
}

async function loadCurve(
  ctx: AnyCtx,
  tx: TenantDb,
  productType: string,
): Promise<{ dayIndex: number; efficiencyPct: string }[]> {
  return tx
    .select({ dayIndex: learningCurves.dayIndex, efficiencyPct: learningCurves.efficiencyPct })
    .from(learningCurves)
    .where(scoped(learningCurves, ctx, eq(learningCurves.productType, productType)))
    .orderBy(learningCurves.dayIndex)
}

/**
 * Assemble the line-day capacities for a window.
 *
 * A date with no `line_calendars` row falls back to the company default shift. A date with
 * no default configured is REFUSED rather than assumed to be 480 minutes — a hard-coded
 * shift is how a plan quietly counts capacity on Eid.
 */
async function loadLineDays(
  ctx: AnyCtx,
  tx: TenantDb,
  input: {
    lineIds: readonly string[]
    dates: readonly string[]
    efficiencyFor: (lineId: string, date: string) => string
    policy: PlanningPolicy
  },
): Promise<LineDayCapacity[]> {
  if (input.lineIds.length === 0 || input.dates.length === 0) return []

  const sorted = [...input.dates].sort()
  const from = sorted[0]!
  const to = sorted[sorted.length - 1]!

  const lineRows = await tx
    .select({ id: lines.id, capacityManpower: lines.capacityManpower, isActive: lines.isActive })
    .from(lines)
    .where(scoped(lines, ctx, inArray(lines.id, [...input.lineIds])))

  const byLine = new Map(lineRows.map((row) => [row.id, row]))
  for (const lineId of input.lineIds) {
    const line = byLine.get(lineId)
    if (!line) throw notFound('planning.errors.line_not_found', { lineId })
    if (!line.isActive) {
      throw conflict('planning.errors.line_inactive', { lineId })
    }
  }

  const calendars = await tx
    .select()
    .from(lineCalendars)
    .where(scoped(lineCalendars, ctx, 
      and(
        inArray(lineCalendars.lineId, [...input.lineIds]),
        gte(lineCalendars.calendarDate, from),
        lte(lineCalendars.calendarDate, to),
      ),
    ))

  const byKey = new Map(calendars.map((row) => [`${row.lineId}:${row.calendarDate}`, row]))
  const out: LineDayCapacity[] = []

  for (const lineId of input.lineIds) {
    const line = byLine.get(lineId)!
    for (const date of input.dates) {
      const calendar = byKey.get(`${lineId}:${date}`)

      const shiftMinutes = calendar?.shiftMinutes ?? input.policy.defaultShiftMinutes
      if (shiftMinutes === undefined) {
        throw new AppError('validation_failed', 'planning.errors.no_shift_for_day', {
          lineId,
          date,
        })
      }

      const manpower = calendar?.manpower ?? line.capacityManpower
      if (manpower === null || manpower === undefined) {
        throw new AppError('validation_failed', 'planning.errors.no_manpower', { lineId, date })
      }

      out.push({
        lineId,
        date,
        shiftMinutes,
        plannedDowntimeMinutes: calendar?.plannedDowntimeMinutes ?? 0,
        manpower,
        expectedEfficiencyPct: input.efficiencyFor(lineId, date),
      })
    }
  }

  return out
}

/**
 * What is already committed on these line-days, as loads the checker understands.
 *
 * `excludeAllocationId` exists for the move case: re-checking a plan against a window that
 * still counts the allocation being moved would compare it with itself.
 */
async function loadCommitted(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { lineIds: readonly string[]; from: string; to: string; excludeAllocationId?: string },
): Promise<{ loads: Map<string, PlannedLoad[]>; unmeasured: { orderId: string; reason: string }[] }> {
  const rows = await tx
    .select({
      id: allocations.id,
      orderId: allocations.orderId,
      orderStyleId: allocations.orderStyleId,
      lineId: allocations.lineId,
      plannedDaily: allocations.plannedDaily,
      startDate: allocations.startDate,
      endDate: allocations.endDate,
    })
    .from(allocations)
    .where(scoped(allocations, ctx, 
      and(
        inArray(allocations.lineId, [...input.lineIds]),
        lte(allocations.startDate, input.to),
        gte(allocations.endDate, input.from),
        inArray(allocations.status, ['planned', 'active']),
      ),
    ))

  const relevant = rows.filter((row) => row.id !== input.excludeAllocationId)
  const { styles, unmeasured } = await resolveOrderStyles(ctx, tx, relevant)

  const loads = new Map<string, PlannedLoad[]>()

  for (const row of relevant) {
    const style = styles.get(row.orderId)
    // An unmeasurable committed row understates the load rather than blocking the plan.
    // The caller reports it — see the `committed_load_unmeasured` violation.
    if (!style) continue

    for (const [date, qty] of Object.entries(row.plannedDaily)) {
      if (date < input.from || date > input.to || qty <= 0) continue
      const key = `${row.lineId}:${date}`
      const bucket = loads.get(key) ?? []
      bucket.push({ orderId: row.orderId, styleCode: style.styleCode, smv: style.smv, qty })
      loads.set(key, bucket)
    }
  }

  return { loads, unmeasured }
}

/**
 * Committed work we could not price in minutes. Reported, never ignored: a line that looks
 * free because two of its allocations have no SMV is worse than one that looks full.
 */
function unmeasuredViolations(
  unmeasured: readonly { orderId: string; reason: string }[],
): PlanningViolation[] {
  return unmeasured.map((entry) => ({
    code: 'committed_load_unmeasured',
    messageKey: 'planning.violations.committed_load_unmeasured',
    facts: { orderId: entry.orderId, reason: entry.reason },
  }))
}

/**
 * Resolve each allocation's style and its SMV. Read through the owning module's table
 * (rule 11) — orders own `order_styles`, planning only reads them.
 *
 * The style is where the minutes come from: SMV is a property of a style, and an order
 * that carries three of them has no single SMV. A multi-style order must therefore say
 * which style is on the line; `orderStyleId` is how it does that.
 *
 * `strict` distinguishes the two callers. When checking a plan being submitted, an order
 * we cannot measure must be refused. When summing what is ALREADY on the board, an
 * unmeasurable row is skipped and reported, because refusing there would make an old bad
 * row block every new plan on that line.
 */
async function resolveOrderStyles(
  ctx: AnyCtx,
  tx: TenantDb,
  refs: readonly { orderId: string; orderStyleId?: string | null }[],
  options: { strict?: boolean } = {},
): Promise<{
  styles: Map<string, { styleCode: string; smv: string }>
  unmeasured: { orderId: string; reason: string }[]
}> {
  const styles = new Map<string, { styleCode: string; smv: string }>()
  const unmeasured: { orderId: string; reason: string }[] = []
  if (refs.length === 0) return { styles, unmeasured }

  const { orderStyles } = await import('@/modules/orders/schema')
  const orderIds = [...new Set(refs.map((r) => r.orderId))]

  const rows = await tx
    .select({ id: orderStyles.id, orderId: orderStyles.orderId, styleCode: orderStyles.styleCode })
    .from(orderStyles)
    .where(scoped(orderStyles, ctx, inArray(orderStyles.orderId, orderIds)))

  const byOrder = new Map<string, typeof rows>()
  for (const row of rows) {
    byOrder.set(row.orderId, [...(byOrder.get(row.orderId) ?? []), row])
  }

  const seen = new Set<string>()
  for (const ref of refs) {
    if (seen.has(ref.orderId)) continue
    seen.add(ref.orderId)

    const candidates = byOrder.get(ref.orderId) ?? []
    const chosen = ref.orderStyleId
      ? candidates.find((c) => c.id === ref.orderStyleId)
      : candidates.length === 1
        ? candidates[0]
        : undefined

    if (!chosen) {
      const reason =
        candidates.length === 0
          ? 'planning.errors.order_has_no_style'
          : 'planning.errors.order_style_ambiguous'
      if (options.strict) throw notFound(reason, { orderId: ref.orderId })
      unmeasured.push({ orderId: ref.orderId, reason })
      continue
    }

    try {
      styles.set(ref.orderId, {
        styleCode: chosen.styleCode,
        smv: await requireSmv(ctx, tx, chosen.styleCode),
      })
    } catch (error) {
      if (options.strict) throw error
      unmeasured.push({ orderId: ref.orderId, reason: 'planning.errors.no_smv' })
    }
  }

  return { styles, unmeasured }
}

// ─────────────────────────────────────────────────────────────────────────────
// Operations
// ─────────────────────────────────────────────────────────────────────────────

export interface AllocateResult {
  allocationId: string | null
  fits: boolean
  lineDays: LineDayLoadResult[]
  violations: PlanningViolation[]
}

function datesOf(payload: AllocationPayload): string[] {
  return Object.keys(payload.plannedDaily).sort()
}

/**
 * Place an order on a line (brief: `allocate()`).
 *
 * Checks every line-day the plan touches against what is already committed there, and
 * returns the violations. Nothing is written unless the plan fits or the caller explicitly
 * accepts the violations — and an accepted overload is stored on the row so the next
 * reader knows the line was over-committed on purpose.
 */
export async function allocate(
  ctx: RequestCtx,
  input: unknown,
  options: { acceptViolations?: boolean; productType?: string; policy?: PlanningPolicy } = {},
): Promise<AllocateResult> {
  const payload = allocationPayload.parse(input)
  const policy = options.policy ?? {}

  return withTenantTx(ctx, async (tx) => {
    const dates = datesOf(payload)
    // strict: a plan being submitted must be measurable, or it is not a plan.
    const { styles } = await resolveOrderStyles(ctx, tx, [payload], { strict: true })
    const style = styles.get(payload.orderId)!

    const curve = options.productType ? await loadCurve(ctx, tx, options.productType) : []
    // Day 1 of the run is the first day of THIS allocation — the learning curve is per
    // style run, not per calendar.
    const dayIndex = new Map(dates.map((date, i) => [date, i + 1]))

    const lineDays = await loadLineDays(ctx, tx, {
      lineIds: [payload.lineId],
      dates,
      efficiencyFor: (_lineId, date) =>
        wrapPlanningError(() =>
          efficiencyForDay(curve, dayIndex.get(date)!, policy.defaultEfficiencyPct),
        ),
      policy,
    })

    const committed = await loadCommitted(ctx, tx, {
      lineIds: [payload.lineId],
      from: dates[0]!,
      to: dates[dates.length - 1]!,
    })

    const results: LineDayLoadResult[] = []
    for (const day of lineDays) {
      const qty = payload.plannedDaily[day.date] ?? 0
      const existing = committed.loads.get(`${day.lineId}:${day.date}`) ?? []
      const proposed: PlannedLoad[] =
        qty > 0
          ? [...existing, { orderId: payload.orderId, styleCode: style.styleCode, smv: style.smv, qty }]
          : existing

      results.push(wrapPlanningError(() => checkLineDayLoad(day, proposed)))
    }

    const violations = [
      ...results.flatMap((r) => r.violations),
      ...unmeasuredViolations(committed.unmeasured),
    ]
    const fits = violations.every((v) => v.code !== 'line_day_overloaded')

    if (!fits && !options.acceptViolations) {
      // Return the numbers rather than throwing: the planner needs to see how far over
      // they are to decide whether to accept it, shorten the run or split the order.
      return { allocationId: null, fits: false, lineDays: results, violations }
    }

    const [row] = await tx
      .insert(allocations)
      .values({
        companyId: ctx.companyId,
        orderId: payload.orderId,
        orderStyleId: payload.orderStyleId ?? null,
        lineId: payload.lineId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        plannedDaily: payload.plannedDaily,
        acceptedViolations: fits ? [] : violations,
        createdBy: ctx.userId,
      })
      .returning({ id: allocations.id })

    if (!row) throw new Error('allocations insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'allocations',
      targetId: row.id,
      after: {
        orderId: payload.orderId,
        lineId: payload.lineId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        acceptedViolationCount: fits ? 0 : violations.length,
      },
    })

    await emit(ctx, tx, {
      eventName: PLANNING_EVENTS.allocationCreated,
      payload: {
        allocationId: row.id,
        orderId: payload.orderId,
        lineId: payload.lineId,
        startDate: payload.startDate,
        endDate: payload.endDate,
      },
      aggregateTable: 'allocations',
      aggregateId: row.id,
    })

    // 1.3 TNA moves every milestone downstream of sewing when this window changes.
    await emit(ctx, tx, {
      eventName: PLANNING_EVENTS.sewingWindowChanged,
      payload: {
        orderId: payload.orderId,
        allocationId: row.id,
        startDate: payload.startDate,
        endDate: payload.endDate,
      },
      aggregateTable: 'allocations',
      aggregateId: row.id,
    })

    if (!fits) {
      await emit(ctx, tx, {
        eventName: PLANNING_EVENTS.overloadAccepted,
        payload: {
          allocationId: row.id,
          lineId: payload.lineId,
          acceptedBy: ctx.userId,
          violations,
        },
        aggregateTable: 'allocations',
        aggregateId: row.id,
      })
    }

    return { allocationId: row.id, fits, lineDays: results, violations }
  })
}

/**
 * Move an allocation to a new window and/or line (brief: ripple preview shared with TNA).
 *
 * `preview: true` runs the whole check and returns it without writing — which is what the
 * drag-and-drop board calls on every drop before asking the planner to confirm.
 */
export async function moveAllocation(
  ctx: RequestCtx,
  input: {
    allocationId: string
    lineId?: string
    startDate: string
    endDate: string
    plannedDaily: Record<string, number>
    preview?: boolean
    acceptViolations?: boolean
    productType?: string
    policy?: PlanningPolicy
  },
): Promise<AllocateResult> {
  const policy = input.policy ?? {}

  return withTenantTx(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(allocations)
      .where(scoped(allocations, ctx, eq(allocations.id, input.allocationId)))
      .for('update')

    if (!existing) {
      throw notFound('planning.errors.allocation_not_found', { allocationId: input.allocationId })
    }
    if (existing.status === 'done') {
      // A finished run is history. Re-planning it would rewrite what actually happened.
      throw conflict('planning.errors.allocation_done', { allocationId: existing.id })
    }

    const payload = allocationPayload.parse({
      orderId: existing.orderId,
      orderStyleId: existing.orderStyleId ?? undefined,
      lineId: input.lineId ?? existing.lineId,
      startDate: input.startDate,
      endDate: input.endDate,
      plannedDaily: input.plannedDaily,
    })

    const dates = datesOf(payload)
    const { styles } = await resolveOrderStyles(ctx, tx, [payload], { strict: true })
    const style = styles.get(payload.orderId)!

    const curve = input.productType ? await loadCurve(ctx, tx, input.productType) : []
    const dayIndex = new Map(dates.map((date, i) => [date, i + 1]))

    const lineDays = await loadLineDays(ctx, tx, {
      lineIds: [payload.lineId],
      dates,
      efficiencyFor: (_lineId, date) =>
        wrapPlanningError(() =>
          efficiencyForDay(curve, dayIndex.get(date)!, policy.defaultEfficiencyPct),
        ),
      policy,
    })

    // Exclude the row being moved, or the check would compare the plan with itself.
    const committed = await loadCommitted(ctx, tx, {
      lineIds: [payload.lineId],
      from: dates[0]!,
      to: dates[dates.length - 1]!,
      excludeAllocationId: existing.id,
    })

    const results: LineDayLoadResult[] = []
    for (const day of lineDays) {
      const qty = payload.plannedDaily[day.date] ?? 0
      const base = committed.loads.get(`${day.lineId}:${day.date}`) ?? []
      const proposed: PlannedLoad[] =
        qty > 0
          ? [...base, { orderId: payload.orderId, styleCode: style.styleCode, smv: style.smv, qty }]
          : base
      results.push(wrapPlanningError(() => checkLineDayLoad(day, proposed)))
    }

    const violations = [
      ...results.flatMap((r) => r.violations),
      ...unmeasuredViolations(committed.unmeasured),
    ]
    const fits = violations.every((v) => v.code !== 'line_day_overloaded')

    if (input.preview) {
      return { allocationId: existing.id, fits, lineDays: results, violations }
    }
    if (!fits && !input.acceptViolations) {
      return { allocationId: null, fits: false, lineDays: results, violations }
    }

    await tx
      .update(allocations)
      .set({
        lineId: payload.lineId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        plannedDaily: payload.plannedDaily,
        acceptedViolations: fits ? [] : violations,
        updatedAt: new Date(),
      })
      .where(scoped(allocations, ctx, eq(allocations.id, existing.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'allocations',
      targetId: existing.id,
      before: {
        lineId: existing.lineId,
        startDate: existing.startDate,
        endDate: existing.endDate,
      },
      after: {
        lineId: payload.lineId,
        startDate: payload.startDate,
        endDate: payload.endDate,
        acceptedViolationCount: fits ? 0 : violations.length,
      },
    })

    await emit(ctx, tx, {
      eventName: PLANNING_EVENTS.allocationMoved,
      payload: {
        allocationId: existing.id,
        orderId: existing.orderId,
        fromLineId: existing.lineId,
        toLineId: payload.lineId,
        fromStartDate: existing.startDate,
        toStartDate: payload.startDate,
      },
      aggregateTable: 'allocations',
      aggregateId: existing.id,
    })

    if (payload.startDate !== existing.startDate || payload.endDate !== existing.endDate) {
      await emit(ctx, tx, {
        eventName: PLANNING_EVENTS.sewingWindowChanged,
        payload: {
          orderId: existing.orderId,
          allocationId: existing.id,
          startDate: payload.startDate,
          endDate: payload.endDate,
        },
        aggregateTable: 'allocations',
        aggregateId: existing.id,
      })
    }

    if (!fits) {
      await emit(ctx, tx, {
        eventName: PLANNING_EVENTS.overloadAccepted,
        payload: {
          allocationId: existing.id,
          lineId: payload.lineId,
          acceptedBy: ctx.userId,
          violations,
        },
        aggregateTable: 'allocations',
        aggregateId: existing.id,
      })
    }

    return { allocationId: existing.id, fits, lineDays: results, violations }
  })
}

export async function setAllocationStatus(
  ctx: RequestCtx,
  input: { allocationId: string; status: AllocationStatus },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(allocations)
      .where(scoped(allocations, ctx, eq(allocations.id, input.allocationId)))
      .for('update')

    if (!row) {
      throw notFound('planning.errors.allocation_not_found', { allocationId: input.allocationId })
    }

    allocationMachine.assert(row.status as AllocationStatus, input.status)

    await tx
      .update(allocations)
      .set({ status: input.status, updatedAt: new Date() })
      .where(scoped(allocations, ctx, eq(allocations.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'allocations',
      targetId: row.id,
      before: { status: row.status },
      after: { status: input.status },
    })
  })
}

/**
 * "Can we take this order in this window?" (brief: `capacityQuery`, the owner card).
 *
 * The arithmetic is pure and cacheable; this wrapper supplies the factory's actual state.
 */
export async function capacityQuery(
  ctx: AnyCtx,
  input: {
    styleCode: string
    qty: number
    lineIds: readonly string[]
    dates: readonly string[]
    productType?: string
    policy?: PlanningPolicy
  },
): Promise<CapacityAnswer> {
  const policy = input.policy ?? {}

  return withTenantRead(ctx, async (tx) => {
    const smv = await requireSmv(ctx, tx, input.styleCode)
    const curve = input.productType ? await loadCurve(ctx, tx, input.productType) : []
    const sorted = [...input.dates].sort()
    const dayIndex = new Map(sorted.map((date, i) => [date, i + 1]))

    const lineDays = await loadLineDays(ctx, tx, {
      lineIds: input.lineIds,
      dates: sorted,
      efficiencyFor: (_lineId, date) =>
        wrapPlanningError(() =>
          efficiencyForDay(curve, dayIndex.get(date)!, policy.defaultEfficiencyPct),
        ),
      policy,
    })

    const committed = await loadCommitted(ctx, tx, {
      lineIds: input.lineIds,
      from: sorted[0] ?? '1970-01-01',
      to: sorted[sorted.length - 1] ?? '1970-01-01',
    })

    return wrapPlanningError(() =>
      answerCapacityQuery({
        smv,
        qty: input.qty,
        lineDays,
        existingLoad: lineDays.map((day) => ({
          lineId: day.lineId,
          date: day.date,
          loads: committed.loads.get(`${day.lineId}:${day.date}`) ?? [],
        })),
      }),
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Scenarios — fork, compare, apply
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fork the current plan into a named what-if.
 *
 * The snapshot is taken as a timestamp plus a copy of the live allocations, so a compare
 * six hours later still knows what the board looked like when the fork was made.
 */
export async function forkScenario(
  ctx: RequestCtx,
  input: { name: string; lineIds?: readonly string[]; from?: string; to?: string },
): Promise<{ scenarioId: string; allocationCount: number }> {
  return withTenantTx(ctx, async (tx) => {
    const live = await tx
      .select({
        orderId: allocations.orderId,
        orderStyleId: allocations.orderStyleId,
        lineId: allocations.lineId,
        startDate: allocations.startDate,
        endDate: allocations.endDate,
        plannedDaily: allocations.plannedDaily,
      })
      .from(allocations)
      .where(scoped(allocations, ctx, 
        and(
          inArray(allocations.status, ['planned', 'active']),
          input.lineIds?.length ? inArray(allocations.lineId, [...input.lineIds]) : undefined,
          input.from ? gte(allocations.endDate, input.from) : undefined,
          input.to ? lte(allocations.startDate, input.to) : undefined,
        ),
      ))

    const [row] = await tx
      .insert(scenarios)
      .values({
        companyId: ctx.companyId,
        name: input.name,
        draftAllocations: live,
        createdBy: ctx.userId,
      })
      .returning({ id: scenarios.id })

    if (!row) throw new Error('scenarios insert returned nothing')
    return { scenarioId: row.id, allocationCount: live.length }
  })
}

export interface ScenarioComparison {
  scenarioId: string
  /** Total earned minutes each side commits, per line. */
  perLine: { lineId: string; baseMinutes: string; draftMinutes: string }[]
  draftViolations: PlanningViolation[]
}

/**
 * Scenario vs the live board (brief: fork/compare/apply).
 *
 * Compares committed minutes per line and re-checks the draft for overloads. The draft's
 * check counts ONLY the draft, not the live allocations on top of it: a scenario is a
 * proposed replacement for that stretch of board, and adding it to what it replaces would
 * report every line as double-booked.
 */
export async function compareScenario(
  ctx: AnyCtx,
  input: { scenarioId: string; policy: Required<PlanningPolicy> },
): Promise<ScenarioComparison> {
  return withTenantRead(ctx, async (tx) => {
    const [scenario] = await tx.select().from(scenarios).where(scoped(scenarios, ctx, eq(scenarios.id, input.scenarioId)))
    if (!scenario) {
      throw notFound('planning.errors.scenario_not_found', { scenarioId: input.scenarioId })
    }

    const drafts = scenario.draftAllocations as AllocationPayload[]
    const lineIds = [...new Set(drafts.map((d) => d.lineId))]
    const dates = [...new Set(drafts.flatMap((d) => Object.keys(d.plannedDaily)))].sort()

    if (lineIds.length === 0 || dates.length === 0) {
      return { scenarioId: scenario.id, perLine: [], draftViolations: [] }
    }

    const lineDays = await loadLineDays(ctx, tx, {
      lineIds,
      dates,
      efficiencyFor: () => input.policy.defaultEfficiencyPct,
      policy: input.policy,
    })

    const live = await loadCommitted(ctx, tx, {
      lineIds,
      from: dates[0]!,
      to: dates[dates.length - 1]!,
    })

    const { styles, unmeasured } = await resolveOrderStyles(ctx, tx, drafts)
    const draftViolations: PlanningViolation[] = unmeasuredViolations(unmeasured)
    const baseMinutes = new Map<string, string>()
    const draftMinutes = new Map<string, string>()

    for (const day of lineDays) {
      const key = `${day.lineId}:${day.date}`

      const liveLoads = live.loads.get(key) ?? []
      const liveResult = wrapPlanningError(() => checkLineDayLoad(day, liveLoads))
      baseMinutes.set(day.lineId, addMinutes(baseMinutes.get(day.lineId), liveResult.requiredMinutes))

      const draftLoads: PlannedLoad[] = []
      for (const draft of drafts) {
        if (draft.lineId !== day.lineId) continue
        const qty = draft.plannedDaily[day.date] ?? 0
        const style = styles.get(draft.orderId)
        if (qty <= 0 || !style) continue
        draftLoads.push({ orderId: draft.orderId, styleCode: style.styleCode, smv: style.smv, qty })
      }

      const draftResult = wrapPlanningError(() => checkLineDayLoad(day, draftLoads))
      draftMinutes.set(day.lineId, addMinutes(draftMinutes.get(day.lineId), draftResult.requiredMinutes))
      draftViolations.push(...draftResult.violations)
    }

    return {
      scenarioId: scenario.id,
      perLine: lineIds.map((lineId) => ({
        lineId,
        baseMinutes: baseMinutes.get(lineId) ?? '0.00',
        draftMinutes: draftMinutes.get(lineId) ?? '0.00',
      })),
      draftViolations,
    }
  })
}

/** Minutes are numeric(12,2) — summed as scaled integers, never as floats. */
function addMinutes(a: string | undefined, b: string): string {
  const toMinor = (v: string) => {
    const [whole = '0', fraction = ''] = v.split('.')
    return BigInt(whole + fraction.padEnd(2, '0').slice(0, 2))
  }
  const total = toMinor(a ?? '0').valueOf() + toMinor(b)
  const digits = total.toString().padStart(3, '0')
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * Apply a scenario (brief: "apply writes real allocations via pending_changes").
 *
 * This does NOT write allocations. It raises one draft carrying the whole set, so a
 * manager approves the plan as a single decision rather than eleven separate rows — and
 * the overload check runs again at approve time, against the board as it is then.
 */
export async function proposeScenarioApply(
  ctx: RequestCtx,
  input: { scenarioId: string; policy: Required<PlanningPolicy> },
): Promise<{ pendingChangeId: string }> {
  const { propose } = await import('../core/pending-changes')

  const scenario = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx.select().from(scenarios).where(scoped(scenarios, ctx, eq(scenarios.id, input.scenarioId)))
    return row
  })

  if (!scenario) {
    throw notFound('planning.errors.scenario_not_found', { scenarioId: input.scenarioId })
  }
  scenarioMachine.assert(scenario.status as ScenarioStatus, 'applied')

  const drafts = scenario.draftAllocations as AllocationPayload[]
  if (drafts.length === 0) {
    throw new AppError('validation_failed', 'planning.errors.scenario_empty', {
      scenarioId: scenario.id,
    })
  }

  const { id } = await propose(ctx, {
    moduleId: 'planning',
    targetTable: 'allocations',
    operation: 'insert',
    payload: {
      scenarioId: scenario.id,
      allocations: drafts,
      // Snapshotted, not looked up at approve time — see applyScenarioPayload.
      assumptions: {
        expectedEfficiencyPct: input.policy.defaultEfficiencyPct,
        defaultShiftMinutes: input.policy.defaultShiftMinutes,
      },
    },
    zodSchemaKey: 'scenario_apply',
    source: 'user_draft',
  })

  return { pendingChangeId: id }
}

/**
 * Commit handler for an approved scenario (registered in `register.ts`).
 *
 * Core's generic single-row write cannot express this: applying a scenario replaces a set
 * of allocations and flips the scenario's own status, and both have to land in the same
 * transaction as the audit row.
 *
 * The overload check runs AGAIN here. Between fork and approval the board has moved, and
 * approving a plan that fitted yesterday onto a line that filled up overnight is exactly
 * the failure re-validation exists to stop.
 */
export async function commitScenarioApply(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const { applyScenarioPayload } = await import('./zod')
  const payload = applyScenarioPayload.parse(input.payload)

  const [scenario] = await tx
    .select()
    .from(scenarios)
    .where(scoped(scenarios, ctx, eq(scenarios.id, payload.scenarioId)))
    .for('update')

  if (!scenario) {
    throw notFound('planning.errors.scenario_not_found', { scenarioId: payload.scenarioId })
  }
  scenarioMachine.assert(scenario.status as ScenarioStatus, 'applied')

  const policy: PlanningPolicy = {
    defaultEfficiencyPct: payload.assumptions.expectedEfficiencyPct,
    defaultShiftMinutes: payload.assumptions.defaultShiftMinutes,
  }

  // Re-check against the board AS IT IS NOW. Between fork and approval other allocations
  // may have landed on these lines, and a plan that fitted yesterday is not a plan that
  // fits today. Approving it anyway would over-commit a line with nobody having decided to.
  const perLine = new Map<string, AllocationPayload[]>()
  for (const draft of payload.allocations) {
    perLine.set(draft.lineId, [...(perLine.get(draft.lineId) ?? []), draft])
  }

  for (const [lineId, drafts] of perLine) {
    const dates = [...new Set(drafts.flatMap((d) => Object.keys(d.plannedDaily)))].sort()

    const lineDays = await loadLineDays(ctx, tx, {
      lineIds: [lineId],
      dates,
      efficiencyFor: () => payload.assumptions.expectedEfficiencyPct,
      policy,
    })

    const committed = await loadCommitted(ctx, tx, {
      lineIds: [lineId],
      from: dates[0]!,
      to: dates[dates.length - 1]!,
    })

    // strict: approving a plan we cannot price in minutes is approving nothing.
    const { styles } = await resolveOrderStyles(ctx, tx, drafts, { strict: true })

    for (const day of lineDays) {
      const proposed: PlannedLoad[] = [...(committed.loads.get(`${lineId}:${day.date}`) ?? [])]
      for (const draft of drafts) {
        const qty = draft.plannedDaily[day.date] ?? 0
        const style = styles.get(draft.orderId)
        if (qty <= 0 || !style) continue
        proposed.push({
          orderId: draft.orderId,
          styleCode: style.styleCode,
          smv: style.smv,
          qty,
        })
      }

      const result = wrapPlanningError(() => checkLineDayLoad(day, proposed))
      if (!result.fits) {
        throw conflict('planning.errors.scenario_no_longer_fits', {
          scenarioId: scenario.id,
          lineId,
          date: day.date,
          overloadMinutes: result.overloadMinutes,
        })
      }
    }
  }

  const inserted: string[] = []
  for (const draft of payload.allocations) {
    const [row] = await tx
      .insert(allocations)
      .values({
        companyId: ctx.companyId,
        orderId: draft.orderId,
        orderStyleId: draft.orderStyleId ?? null,
        lineId: draft.lineId,
        startDate: draft.startDate,
        endDate: draft.endDate,
        plannedDaily: draft.plannedDaily,
        createdBy: ctx.userId,
      })
      .returning({ id: allocations.id })

    if (!row) throw new Error('allocations insert returned nothing')
    inserted.push(row.id)
  }

  await tx
    .update(scenarios)
    .set({ status: 'applied', updatedAt: new Date() })
    .where(scoped(scenarios, ctx, eq(scenarios.id, scenario.id)))

  return {
    rowId: scenario.id,
    after: { status: 'applied', allocationIds: inserted, count: inserted.length },
  }
}

export { conflict }
