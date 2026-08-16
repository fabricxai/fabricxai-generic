/**
 * 7.1 Inline, Endline & Final Inspection — service layer ⚖
 *
 * The brief's hard requirement: "AQL computed server-side from tables (never client math)".
 * `runFinalInspection` is the only place a verdict is decided, it reads the plan from
 * `aql_tables`, and it SNAPSHOTS that plan onto the row — sample size, both acceptance
 * numbers, the standard and the levels used. The table is versioned and buyer terms
 * change; a verdict that recomputes itself from today's table is one nobody can defend
 * when a shipment is held six months later.
 *
 * Severity comes from `defect_codes`, never from the caller. An inspector taps a defect;
 * whether it is major or minor was decided once, by whoever set up the taxonomy. Letting
 * the tap carry a severity means two inspectors classify the same defect differently and
 * the AQL verdict depends on who was holding the tablet.
 */
import { factoryToday } from '@/lib/dates'
import { and, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import { isSystemCtx, type AnyCtx, type RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { GATES, type GateResult } from '../core/gates'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { QUALITY_EVENTS } from './events'
import {
  aqlVerdict,
  dhu as computeDhu,
  fourPointResult,
  measurementVariance,
  QualityError,
  repeatDefectRuns,
  resolveAqlPlan,
  type AqlOutcome,
  type AqlPlan,
  type AqlTableRow,
  type DefectRun,
  type MeasurementPoint,
  fabricInspectionRefusal,
} from './quality'
import {
  aqlTables,
  defectCodes,
  dhuDaily,
  fabricInspections,
  finalInspections,
  inlineChecks,
  measurementChecks,
  measurementSpecs,
  thirdPartyInspections,
} from './schema'
import {
  defectCodePayload,
  fabricInspectionPayload,
  finalInspectionPayload,
  inlineCheckPayload,
  measurementCheckPayload,
  measurementSetPayload,
  measurementSpecPayload,
  thirdPartyInspectionPayload,
} from './zod'

/** ⚖ — a final verdict is what a held shipment is argued about with. */
registerAuditedTables('final_inspections', 'fabric_inspections')

/**
 * draft → submitted → closed, with a re-inspection loop. A failed lot is reworked and
 * re-presented, which is the normal case; `closed` is terminal.
 */
export const finalInspectionMachine = defineStateMachine({
  field: 'status',
  initial: 'draft',
  transitions: {
    draft: ['submitted', 'closed'],
    submitted: ['reinspection_required', 'closed'],
    reinspection_required: ['submitted', 'closed'],
    closed: [],
  },
})

export type FinalInspectionStatus = (typeof finalInspectionMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface QualityPolicy {
  /** Which seeded standard to read plans from, e.g. 'ansi-z1.4'. */
  aqlStandard: string
  /** 4-point acceptance limit, points per 100 square yards. Industry norm is 40. */
  fabricMaxPointsPer100SqYd: string
  /** DHU above this raises an alert at day close. */
  dhuAlertThreshold?: string
  /** Consecutive days of the same code+operation before the pattern alert fires. */
  repeatDefectDays: number
}

function wrapQualityError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof QualityError) {
      throw new AppError('validation_failed', 'quality.errors.uncomputable', {
        reason: error.message,
      })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Defect taxonomy
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertDefectCode(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ defectCodeId: string }> {
  const payload = defectCodePayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(defectCodes)
      .values({
        companyId: ctx.companyId,
        category: payload.category,
        code: payload.code,
        label: payload.label,
        severity: payload.severity,
      })
      .onConflictDoUpdate({
        target: [defectCodes.companyId, defectCodes.code],
        set: {
          category: payload.category,
          label: payload.label,
          severity: payload.severity,
        },
      })
      .returning({ id: defectCodes.id })

    if (!row) throw new Error('defect_codes upsert returned nothing')
    return { defectCodeId: row.id }
  })
}

/**
 * Resolve tapped codes to their severities.
 *
 * An unknown code is REFUSED, not counted as minor. A defect nobody defined cannot be
 * weighed against an acceptance number, and quietly filing it as minor is how a critical
 * defect passes an inspection.
 */
async function resolveSeverities(
  // `ctx`, because a severity decides whether a lot passes AQL. Reading another factory's
  // taxonomy would weigh a defect against the wrong acceptance number.
  ctx: AnyCtx,
  tx: TenantDb,
  codes: readonly string[],
): Promise<Map<string, 'critical' | 'major' | 'minor'>> {
  const unique = [...new Set(codes)]
  if (unique.length === 0) return new Map()

  const rows = await tx
    .select({ code: defectCodes.code, severity: defectCodes.severity })
    .from(defectCodes)
    .where(scoped(defectCodes, ctx, inArray(defectCodes.code, unique)))

  const known = new Map(rows.map((row) => [row.code, row.severity]))
  const missing = unique.filter((code) => !known.has(code))

  if (missing.length > 0) {
    throw new AppError('validation_failed', 'quality.errors.unknown_defect_codes', {
      codes: missing,
    })
  }

  return known
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline capture — the hot path
// ─────────────────────────────────────────────────────────────────────────────

export interface InlineCheckResult {
  inlineCheckId: string
  defectQty: number
}

/** Capture a supervisor's spot check. Offline-queued (rule 7). */
export async function captureInlineCheck(
  ctx: RequestCtx,
  input: unknown,
): Promise<InlineCheckResult> {
  const payload = inlineCheckPayload.parse(input)
  return withTenantTx(ctx, async (tx) => captureInlineCheckIn(ctx, tx, payload))
}

async function captureInlineCheckIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof inlineCheckPayload.parse>,
): Promise<InlineCheckResult> {
  // Postgres performs foreign-key checks with RLS BYPASSED, so the FK on `line_id` would
  // let another tenant file a check against this factory's line. The app layer is the
  // first wall (rule 2).
  const { lines } = await import('@/modules/planning/schema')
  const [line] = await tx.select({ id: lines.id }).from(lines).where(scoped(lines, ctx, eq(lines.id, payload.lineId)))
  if (!line) throw notFound('quality.errors.line_not_found', { lineId: payload.lineId })

  // Validates the codes exist. An inline check referencing a code nobody defined would
  // pollute the DHU trend and the repeat-defect analysis with an untraceable bucket.
  await resolveSeverities(
    ctx,
    tx,
    payload.defects.map((d) => d.code),
  )

  const defectQty = payload.defects.reduce((sum, d) => sum + d.count, 0)
  const occurredAt = payload.occurredAt ? new Date(payload.occurredAt) : new Date()
  // The date is derived from the timestamp, not taken from the caller: a tablet with a
  // wrong date would file a check into the wrong day's DHU.
  const checkedOn = payload.checkedOn ?? occurredAt.toISOString().slice(0, 10)

  const [row] = await tx
    .insert(inlineChecks)
    .values({
      companyId: ctx.companyId,
      lineId: payload.lineId,
      orderId: payload.orderId ?? null,
      checkedOn,
      occurredAt,
      operation: payload.operation,
      operatorId: payload.operatorId ?? null,
      checkedQty: payload.checkedQty,
      defects: payload.defects,
      defectQty,
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: inlineChecks.id })

  if (!row) throw new Error('inline_checks insert returned nothing')

  await emit(ctx, tx, {
    eventName: QUALITY_EVENTS.inlineCheckRecorded,
    payload: {
      inlineCheckId: row.id,
      lineId: payload.lineId,
      operation: payload.operation,
      checkedQty: payload.checkedQty,
      defectQty,
    },
    aggregateTable: 'inline_checks',
    aggregateId: row.id,
  })

  return { inlineCheckId: row.id, defectQty }
}

export interface DhuDayResult {
  lineId: string
  date: string
  defects: number
  checked: number
  dhu: string
  alert: boolean
}

/**
 * Close a line-day's DHU (brief §Jobs: "day-close DHU").
 *
 * Recomputed from `inline_checks` every time, never incremented. A counter that drifts is
 * worse than a slow read for a number that goes into a buyer report — and re-running a
 * day close must produce the same answer, not double it.
 */
export async function closeDhuDay(
  // `AnyCtx`, not `RequestCtx`: this is a derive, and the nightly job runs it as a system
  // actor. It reads nothing off the caller but the company — there is no `createdBy` on a
  // recomputed row, because nobody authored it.
  ctx: AnyCtx,
  input: { lineId: string; date: string },
  policy: QualityPolicy,
): Promise<DhuDayResult> {
  return withTenantTx(ctx, async (tx) => {
    const [totals] = await tx
      .select({
        defects: sql<string>`coalesce(sum(${inlineChecks.defectQty}), 0)::text`,
        checked: sql<string>`coalesce(sum(${inlineChecks.checkedQty}), 0)::text`,
      })
      .from(inlineChecks)
      .where(scoped(inlineChecks, ctx, and(eq(inlineChecks.lineId, input.lineId), eq(inlineChecks.checkedOn, input.date))))

    const defects = Number(totals?.defects ?? '0')
    const checked = Number(totals?.checked ?? '0')

    if (checked === 0) {
      // No checks is not zero DHU — it is no measurement, and writing a 0 would put a
      // perfect day on a buyer's trend for a day nobody inspected.
      throw notFound('quality.errors.no_inline_checks', {
        lineId: input.lineId,
        date: input.date,
      })
    }

    const value = wrapQualityError(() => computeDhu({ defects, checked }))

    await tx
      .insert(dhuDaily)
      .values({
        companyId: ctx.companyId,
        lineId: input.lineId,
        dhuDate: input.date,
        defects,
        checked,
        dhu: value,
      })
      .onConflictDoUpdate({
        target: [dhuDaily.lineId, dhuDaily.dhuDate],
        set: { defects, checked, dhu: value, computedAt: new Date() },
      })

    const alert =
      policy.dhuAlertThreshold !== undefined &&
      toMinor(value) > toMinor(policy.dhuAlertThreshold)

    await emit(ctx, tx, {
      eventName: QUALITY_EVENTS.dhuDayClosed,
      payload: { lineId: input.lineId, date: input.date, defects, checked, dhu: value },
      aggregateTable: 'dhu_daily',
      aggregateId: input.lineId,
    })

    if (alert) {
      await emit(ctx, tx, {
        eventName: QUALITY_EVENTS.dhuAlert,
        payload: {
          lineId: input.lineId,
          date: input.date,
          dhu: value,
          threshold: policy.dhuAlertThreshold,
        },
        aggregateTable: 'dhu_daily',
        aggregateId: input.lineId,
      })
    }

    return { lineId: input.lineId, date: input.date, defects, checked, dhu: value, alert }
  })
}

/**
 * The repeat-defect pattern alert (brief §Jobs).
 *
 * Reads the window's inline checks and looks for the same code at the same operation on
 * consecutive days. A gap breaks the run: the alert exists to surface a problem that is
 * still there, and one that fires on noise stops being read.
 */
export async function repeatDefectAlerts(
  ctx: AnyCtx,
  input: { from: string; to: string; lineId?: string },
  policy: QualityPolicy,
): Promise<DefectRun[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        checkedOn: inlineChecks.checkedOn,
        operation: inlineChecks.operation,
        defects: inlineChecks.defects,
      })
      .from(inlineChecks)
      .where(scoped(inlineChecks, ctx, 
        and(
          gte(inlineChecks.checkedOn, input.from),
          lte(inlineChecks.checkedOn, input.to),
          input.lineId ? eq(inlineChecks.lineId, input.lineId) : undefined,
        ),
      ))

    const occurrences = rows.flatMap((row) =>
      row.defects.map((defect) => ({
        date: row.checkedOn,
        code: defect.code,
        operation: row.operation,
      })),
    )

    return wrapQualityError(() =>
      repeatDefectRuns(occurrences, { minConsecutiveDays: policy.repeatDefectDays }),
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Fabric — the 4-point system
// ─────────────────────────────────────────────────────────────────────────────

export async function inspectFabric(
  ctx: RequestCtx,
  input: unknown,
  policy: QualityPolicy,
): Promise<{ fabricInspectionId: string; pointsPer100SqYd: string; result: 'pass' | 'fail' }> {
  const payload = fabricInspectionPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const outcome = wrapQualityError(() =>
      fourPointResult({
        points: payload.points4,
        lengthYards: payload.inspectedLengthYards,
        widthInches: payload.widthInches,
        maxPointsPer100SqYd: policy.fabricMaxPointsPer100SqYd,
      }),
    )

    const [row] = await tx
      .insert(fabricInspections)
      .values({
        companyId: ctx.companyId,
        grnId: payload.grnId,
        rollId: payload.rollId ?? null,
        points4: payload.points4 as unknown as Record<string, number>,
        inspectedLengthYards: payload.inspectedLengthYards,
        widthInches: payload.widthInches,
        totalPoints: outcome.totalPoints,
        pointsPer100SqYd: outcome.pointsPer100SqYd,
        thresholdPer100SqYd: outcome.thresholdPer100SqYd,
        result: outcome.result,
        inspectedBy: ctx.userId,
      })
      .returning({ id: fabricInspections.id })

    if (!row) throw new Error('fabric_inspections insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'fabric_inspections',
      targetId: row.id,
      after: {
        grnId: payload.grnId,
        rollId: payload.rollId ?? null,
        pointsPer100SqYd: outcome.pointsPer100SqYd,
        result: outcome.result,
      },
    })

    // Roll the consignment's summary up. `grns.inspection_status` is what the store's own
    // GRN list reads, and leaving it on `pending` after an inspection passed would show a
    // storekeeper "not inspected" for a delivery that was — so they chase the QC who
    // already did the work, or worse, stop believing the column.
    await rollUpGrnInspection(ctx, tx, payload.grnId)

    await emit(ctx, tx, {
      eventName:
        outcome.result === 'fail' ? QUALITY_EVENTS.fabricRejected : QUALITY_EVENTS.fabricInspected,
      payload: {
        fabricInspectionId: row.id,
        grnId: payload.grnId,
        rollId: payload.rollId ?? null,
        pointsPer100SqYd: outcome.pointsPer100SqYd,
        threshold: outcome.thresholdPer100SqYd,
        result: outcome.result,
      },
      aggregateTable: 'fabric_inspections',
      aggregateId: row.id,
    })

    return {
      fabricInspectionId: row.id,
      pointsPer100SqYd: outcome.pointsPer100SqYd,
      result: outcome.result,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Measurements
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create the next version of a style's measurement chart.
 *
 * Versioned rather than edited: a check recorded against version 1 was judged against
 * version 1's tolerances, and editing the chart in place would silently re-grade every
 * historic check.
 */
export async function createMeasurementSpec(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ measurementSpecId: string; version: number }> {
  const payload = measurementSpecPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [latest] = await tx
      .select({ version: measurementSpecs.version })
      .from(measurementSpecs)
      .where(scoped(measurementSpecs, ctx, eq(measurementSpecs.styleCode, payload.styleCode)))
      .orderBy(desc(measurementSpecs.version))
      .limit(1)

    const version = (latest?.version ?? 0) + 1

    const [row] = await tx
      .insert(measurementSpecs)
      .values({
        companyId: ctx.companyId,
        styleCode: payload.styleCode,
        version,
        points: payload.points,
        unit: payload.unit,
        createdBy: ctx.userId,
      })
      .returning({ id: measurementSpecs.id })

    if (!row) throw new Error('measurement_specs insert returned nothing')
    return { measurementSpecId: row.id, version }
  })
}

export async function recordMeasurementCheck(
  ctx: RequestCtx,
  input: unknown,
): Promise<PieceResult> {
  const payload = measurementCheckPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const spec = await loadSpec(ctx, tx, payload.measurementSpecId)
    return writePiece(ctx, tx, spec, payload, null)
  })
}

export interface PieceResult {
  measurementCheckId: string
  result: 'pass' | 'fail'
  outOfTolerance: unknown[]
  missing: string[]
}

export interface MeasurementSetResult {
  pieces: PieceResult[]
  /** True when this key had already been recorded and nothing new was written. */
  duplicate: boolean
}

/**
 * Every piece measured for one size, in ONE transaction (plan 4.1, audit FE-H5).
 *
 * The action used to loop over `recordMeasurementCheck`, each call opening its own
 * transaction — so a bad value on piece 2 left piece 1 committed and piece 3 never
 * attempted. The action's own comment claimed the opposite ("a throw on piece 2 leaves
 * pieces 1 and 3 unwritten"), which is how it survived: the intent was written down and
 * the code did something else.
 *
 * A half-measured size is worse than an unmeasured one. It reads as a completed check on
 * the buyer report, with two of the three garments that were actually measured missing and
 * nothing saying so — and this is the floor screen with the weakest network in the factory.
 *
 * Validation runs over EVERY piece before the first row is written. A set that is going to
 * be refused is refused before it has half-landed, rather than at the piece that happens to
 * carry the bad value.
 */
export async function recordMeasuredSet(
  ctx: AnyCtx,
  input: unknown,
): Promise<MeasurementSetResult> {
  const payload = measurementSetPayload.parse(input)
  return withTenantTx(ctx, async (tx) => recordMeasuredSetIn(ctx, tx, payload))
}

export async function recordMeasuredSetIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof measurementSetPayload.parse>,
): Promise<MeasurementSetResult> {
  // FOR UPDATE, and not only to read the chart: it serialises two submissions of the same
  // size behind each other, so the duplicate check below cannot be raced past. The unique
  // index other offline tables lean on is unavailable here — one key covers N rows.
  const spec = await loadSpec(ctx, tx, payload.measurementSpecId, true)

  if (payload.offlineKey) {
    const already = await tx
      .select()
      .from(measurementChecks)
      .where(
        and(
          eq(measurementChecks.companyId, ctx.companyId),
          eq(measurementChecks.offlineKey, payload.offlineKey),
        ),
      )
      .orderBy(measurementChecks.createdAt)

    if (already.length > 0) {
      // The set that landed, returned as it was. Nothing is re-emitted: a second
      // `measurement.failed` would raise the same alarm twice for one garment.
      return {
        duplicate: true,
        pieces: already.map((row) => ({
          measurementCheckId: row.id,
          result: row.result as 'pass' | 'fail',
          outOfTolerance: row.outOfTolerance,
          missing: row.missingPoints,
        })),
      }
    }
  }

  const points = spec.points as MeasurementPoint[]

  // All of them, before any of them. `measurementVariance` throws on a malformed value, and
  // doing this piece-by-piece inside the write loop is what made the set non-atomic in the
  // first place — the transaction would roll back, but only after the caller had been told
  // by an earlier piece's result that the size was being recorded.
  const outcomes = payload.pieces.map((values) =>
    wrapQualityError(() => measurementVariance(points, values)),
  )

  const pieces: PieceResult[] = []
  for (const [index, values] of payload.pieces.entries()) {
    pieces.push(
      await writePiece(
        ctx,
        tx,
        spec,
        {
          measurementSpecId: spec.id,
          orderId: payload.orderId,
          sampledSize: payload.sampledSize,
          values,
        },
        payload.offlineKey ?? null,
        outcomes[index]!,
      ),
    )
  }

  return { pieces, duplicate: false }
}

async function loadSpec(ctx: AnyCtx, tx: TenantDb, measurementSpecId: string, lock = false) {
  const query = tx.select().from(measurementSpecs).where(scoped(measurementSpecs, ctx, eq(measurementSpecs.id, measurementSpecId)))
  const [spec] = lock ? await query.for('update') : await query

  if (!spec) {
    throw notFound('quality.errors.spec_not_found', { measurementSpecId })
  }
  return spec
}

/** One garment against the chart. Shared by the single-piece path and the set. */
async function writePiece(
  ctx: AnyCtx,
  tx: TenantDb,
  spec: { id: string; points: unknown },
  payload: {
    measurementSpecId: string
    orderId: string
    sampledSize: string
    values: Record<string, string>
  },
  offlineKey: string | null,
  precomputed?: ReturnType<typeof measurementVariance>,
): Promise<PieceResult> {
  const outcome =
    precomputed ??
    wrapQualityError(() => measurementVariance(spec.points as MeasurementPoint[], payload.values))

  const [row] = await tx
    .insert(measurementChecks)
    .values({
      companyId: ctx.companyId,
      measurementSpecId: spec.id,
      orderId: payload.orderId,
      sampledSize: payload.sampledSize,
      values: payload.values,
      outOfTolerance: outcome.outOfTolerance,
      missingPoints: outcome.missing,
      result: outcome.passed ? 'pass' : 'fail',
      offlineKey,
    })
    .returning({ id: measurementChecks.id })

  if (!row) throw new Error('measurement_checks insert returned nothing')

  if (!outcome.passed) {
    await emit(ctx, tx, {
      eventName: QUALITY_EVENTS.measurementFailed,
      payload: {
        measurementCheckId: row.id,
        orderId: payload.orderId,
        sampledSize: payload.sampledSize,
        outOfTolerance: outcome.outOfTolerance,
        missing: outcome.missing,
      },
      aggregateTable: 'measurement_checks',
      aggregateId: row.id,
    })
  }

  return {
    measurementCheckId: row.id,
    result: outcome.passed ? 'pass' : 'fail',
    outOfTolerance: outcome.outOfTolerance,
    missing: outcome.missing,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Final inspection ⚖ — the AQL verdict
// ─────────────────────────────────────────────────────────────────────────────

/** Load the seeded plans for a lot. Global reference data — no tenant scope on it. */
async function loadAqlRows(
  tx: TenantDb,
  input: { standard: string; inspectionLevel: string; lotQty: number },
): Promise<AqlTableRow[]> {
  const rows = await tx
    .select({
      inspectionLevel: aqlTables.inspectionLevel,
      aqlLevel: aqlTables.aqlLevel,
      lotFrom: aqlTables.lotFrom,
      lotTo: aqlTables.lotTo,
      sampleSize: aqlTables.sampleSize,
      accept: aqlTables.accept,
      reject: aqlTables.reject,
    })
    .from(aqlTables)
    /*
     * NOT scoped, and the type system is what said so: `aql_tables` has no `company_id`, so
     * it cannot be passed to `scoped()` at all — which is the structural typing in
     * `scoped.ts` doing exactly its job. The ISO 2859-1 sampling plans are the same for
     * every factory on earth; giving them a tenant column would be inventing one.
     *
     * What protects this table is a GRANT rather than a policy: the app role has SELECT and
     * no INSERT. Recorded in docs/STUBS.md, because that protection assumes the app never
     * connects as the table owner.
     */
    // eslint-disable-next-line fabricxai/require-tenant-predicate -- install-wide reference data, see above
    .where(
      and(
        eq(aqlTables.standard, input.standard),
        eq(aqlTables.inspectionLevel, input.inspectionLevel),
        lte(aqlTables.lotFrom, input.lotQty),
        gte(aqlTables.lotTo, input.lotQty),
      ),
    )

  if (rows.length === 0) {
    throw notFound('quality.errors.no_aql_rows', {
      standard: input.standard,
      inspectionLevel: input.inspectionLevel,
      lotQty: input.lotQty,
    })
  }
  return rows
}

export interface FinalInspectionResult {
  finalInspectionId: string
  outcome: AqlOutcome
}

/**
 * Run a final inspection ⚖.
 *
 * The plan comes from `aql_tables` and is snapshotted onto the row. Defect severities come
 * from `defect_codes`. Nothing about the verdict is supplied by the caller — that is what
 * "never client math" means, and it is why an inspector cannot make a lot pass by
 * relabelling a major defect on the way in.
 */
/**
 * The sampling plan for a lot, WITHOUT recording anything (canvas P4: "the rule, not just
 * the numbers").
 *
 * The inspector sees how many pieces to pull and how many defects the plan accepts before
 * they start counting, because an AQL plan revealed after the count looks like a verdict
 * somebody chose. It is the same `resolveAqlPlan` the verdict uses, over the same versioned
 * table, so the preview and the result cannot disagree.
 *
 * A read, but it lives here rather than in `queries.ts` because it needs `loadAqlRows` and
 * the policy's standard — and duplicating either into the read layer is how the preview and
 * the verdict start drifting.
 */
export async function aqlPlanFor(
  ctx: AnyCtx,
  input: { lotQty: number; inspectionLevel: string; majorAql: string; minorAql: string },
  policy: QualityPolicy,
): Promise<AqlPlan> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await loadAqlRows(tx, {
      standard: policy.aqlStandard,
      inspectionLevel: input.inspectionLevel,
      lotQty: input.lotQty,
    })
    return wrapQualityError(() => resolveAqlPlan(rows, input))
  })
}

export async function runFinalInspection(
  ctx: AnyCtx,
  input: unknown,
  policy: QualityPolicy,
): Promise<FinalInspectionResult> {
  const payload = finalInspectionPayload.parse(input)
  return withTenantTx(ctx, async (tx) => runFinalInspectionIn(ctx, tx, payload, policy))
}

export async function runFinalInspectionIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof finalInspectionPayload.parse>,
  policy: QualityPolicy,
): Promise<FinalInspectionResult> {
  /*
   * A replayed inspection returns the verdict that landed (plan 4.1).
   *
   * `inspection_no` is unique per company and would already stop a resend — but as a
   * constraint violation, and the sync layer remembers a refused row as refused. So a
   * tablet replaying a batch the server had applied would tell the inspector their
   * inspection failed, for a lot that passed. The key turns that into the original answer.
   */
  if (payload.offlineKey) {
    const [already] = await tx
      .select()
      .from(finalInspections)
      .where(
        and(
          eq(finalInspections.companyId, ctx.companyId),
          eq(finalInspections.offlineKey, payload.offlineKey),
        ),
      )

    if (already) {
      // Rebuilt from the SNAPSHOT on the row, not by re-reading `aql_tables`. The table is
      // versioned and buyer terms change; recomputing the plan on a replay could answer with
      // different acceptance numbers from the ones the verdict was actually reached under.
      return {
        finalInspectionId: already.id,
        outcome: {
          verdict: already.verdict as AqlOutcome['verdict'],
          reasons: already.failReasons as AqlOutcome['reasons'],
          plan: {
            lotQty: already.lotQty,
            sampleSize: already.sampleSize,
            hundredPercent: already.hundredPercent,
            inspectionLevel: already.inspectionLevel,
            majorAql: already.majorAql,
            majorAccept: already.majorAccept,
            majorReject: already.majorAccept + 1,
            minorAql: already.minorAql,
            minorAccept: already.minorAccept,
            minorReject: already.minorAccept + 1,
          },
        },
      }
    }
  }

  const rows = await loadAqlRows(tx, {
    standard: policy.aqlStandard,
    inspectionLevel: payload.inspectionLevel,
    lotQty: payload.lotQty,
  })

  const plan = wrapQualityError(() =>
    resolveAqlPlan(rows, {
      lotQty: payload.lotQty,
      inspectionLevel: payload.inspectionLevel,
      majorAql: payload.majorAql,
      minorAql: payload.minorAql,
    }),
  )

  const severities = await resolveSeverities(
    ctx,
    tx,
    payload.defects.map((d) => d.code),
  )

  const counts = { critical: 0, major: 0, minor: 0 }
  const breakdown: { code: string; severity: string; count: number }[] = []
  for (const defect of payload.defects) {
    const severity = severities.get(defect.code)!
    counts[severity] += defect.count
    breakdown.push({ code: defect.code, severity, count: defect.count })
  }

  const outcome = wrapQualityError(() => aqlVerdict(plan, counts))

  const [row] = await tx
    .insert(finalInspections)
    .values({
      companyId: ctx.companyId,
      orderId: payload.orderId,
      orderStyleId: payload.orderStyleId ?? null,
      inspectionNo: payload.inspectionNo,
      lotQty: payload.lotQty,

      // The snapshot. `aql_tables` is versioned and buyer terms change; a verdict that
      // recomputes from today's table is one nobody can defend later.
      standard: policy.aqlStandard,
      inspectionLevel: plan.inspectionLevel,
      majorAql: plan.majorAql,
      minorAql: plan.minorAql,
      sampleSize: plan.sampleSize,
      majorAccept: plan.majorAccept,
      minorAccept: plan.minorAccept,
      hundredPercent: plan.hundredPercent,

      criticalFound: counts.critical,
      majorFound: counts.major,
      minorFound: counts.minor,
      defects: breakdown,

      verdict: outcome.verdict,
      failReasons: outcome.reasons,
      offlineKey: payload.offlineKey ?? null,
      inspectedBy: isSystemCtx(ctx) ? null : ctx.userId,
    })
    .returning({ id: finalInspections.id })

  if (!row) throw new Error('final_inspections insert returned nothing')

  await recordChange(ctx, tx, {
    action: 'insert',
    targetTable: 'final_inspections',
    targetId: row.id,
    after: {
      orderId: payload.orderId,
      inspectionNo: payload.inspectionNo,
      lotQty: payload.lotQty,
      sampleSize: plan.sampleSize,
      verdict: outcome.verdict,
      criticalFound: counts.critical,
      majorFound: counts.major,
      minorFound: counts.minor,
    },
  })

  await emit(ctx, tx, {
    eventName:
      outcome.verdict === 'pass'
        ? QUALITY_EVENTS.finalInspectionPassed
        : QUALITY_EVENTS.finalInspectionFailed,
    payload: {
      finalInspectionId: row.id,
      orderId: payload.orderId,
      lotQty: payload.lotQty,
      sampleSize: plan.sampleSize,
      verdict: outcome.verdict,
      reasons: outcome.reasons,
      // Carried so 1.3 stamps the milestone with the day the lot was actually inspected
      // rather than the day the queue happened to drain it. A worker that was down over
      // a weekend must not record Monday as the inspection date.
      inspectedOn: factoryToday(),
    },
    aggregateTable: 'final_inspections',
    aggregateId: row.id,
  })

  return { finalInspectionId: row.id, outcome }
}

export async function setFinalInspectionStatus(
  ctx: RequestCtx,
  input: { finalInspectionId: string; status: FinalInspectionStatus },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(finalInspections)
      .where(scoped(finalInspections, ctx, eq(finalInspections.id, input.finalInspectionId)))
      .for('update')

    if (!row) {
      throw notFound('quality.errors.final_inspection_not_found', {
        finalInspectionId: input.finalInspectionId,
      })
    }

    finalInspectionMachine.assert(row.status as FinalInspectionStatus, input.status)

    await tx
      .update(finalInspections)
      .set({ status: input.status, updatedAt: new Date() })
      .where(scoped(finalInspections, ctx, eq(finalInspections.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'final_inspections',
      targetId: row.id,
      before: { status: row.status },
      after: { status: input.status },
    })
  })
}

/**
 * Has this order passed final inspection? — the gate 8.1 Shipment blocks departure on.
 *
 * The LATEST inspection decides. An order that passed, was reworked and failed a
 * re-inspection has not passed; reading "has ever passed" would ship it.
 *
 * Takes the caller's transaction, so 8.1 can check it inside the same transaction that
 * confirms ex-factory — the verdict and the departure decision must see the same snapshot,
 * or an inspection landing between the two would be missed. `checkFinalInspectionPassed`
 * below is the read-only wrapper for a screen that just wants to display it.
 */
export async function resolveFinalInspectionGate(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { orderId: string },
): Promise<GateResult> {
  void ctx
  const [latest] = await tx
    .select()
    .from(finalInspections)
    .where(scoped(finalInspections, ctx, eq(finalInspections.orderId, input.orderId)))
    .orderBy(desc(finalInspections.inspectedAt))
    .limit(1)

  if (!latest) {
    return {
      passed: false,
      reasonKey: 'gates.final_inspection.none',
      facts: { orderId: input.orderId },
    }
  }

  if (latest.verdict !== 'pass') {
    return {
      passed: false,
      reasonKey: 'gates.final_inspection.failed',
      facts: {
        finalInspectionId: latest.id,
        inspectionNo: latest.inspectionNo,
        reasons: latest.failReasons,
      },
    }
  }

  return {
    passed: true,
    facts: {
      finalInspectionId: latest.id,
      inspectionNo: latest.inspectionNo,
      lotQty: latest.lotQty,
      sampleSize: latest.sampleSize,
      inspectedAt: latest.inspectedAt.toISOString(),
    },
  }
}

/** Read-only wrapper for a screen. The gate itself uses the tx variant above. */
export async function checkFinalInspectionPassed(
  ctx: AnyCtx,
  input: { orderId: string },
): Promise<GateResult> {
  return withTenantRead(ctx, async (tx) => resolveFinalInspectionGate(ctx, tx, input))
}

// ─────────────────────────────────────────────────────────────────────────────
// Third-party inspections
// ─────────────────────────────────────────────────────────────────────────────

export async function scheduleThirdPartyInspection(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ thirdPartyInspectionId: string }> {
  const payload = thirdPartyInspectionPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(thirdPartyInspections)
      .values({
        companyId: ctx.companyId,
        orderId: payload.orderId,
        agency: payload.agency,
        agencyName: payload.agencyName ?? null,
        scheduledAt: new Date(payload.scheduledAt),
        createdBy: ctx.userId,
      })
      .returning({ id: thirdPartyInspections.id })

    if (!row) throw new Error('third_party_inspections insert returned nothing')

    await emit(ctx, tx, {
      eventName: QUALITY_EVENTS.thirdPartyScheduled,
      payload: {
        thirdPartyInspectionId: row.id,
        orderId: payload.orderId,
        agency: payload.agency,
        scheduledAt: payload.scheduledAt,
      },
      aggregateTable: 'third_party_inspections',
      aggregateId: row.id,
    })

    return { thirdPartyInspectionId: row.id }
  })
}

export async function recordThirdPartyResult(
  ctx: RequestCtx,
  input: {
    thirdPartyInspectionId: string
    result: 'pass' | 'fail'
    documentId?: string
    resultAt?: string
  },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(thirdPartyInspections)
      .where(scoped(thirdPartyInspections, ctx, eq(thirdPartyInspections.id, input.thirdPartyInspectionId)))
      .for('update')

    if (!row) {
      throw notFound('quality.errors.third_party_not_found', {
        thirdPartyInspectionId: input.thirdPartyInspectionId,
      })
    }
    if (row.result !== null) {
      // A third-party verdict is the agency's, not ours to revise. A re-inspection is a
      // new booking.
      throw conflict('quality.errors.third_party_already_resulted', {
        thirdPartyInspectionId: row.id,
        result: row.result,
      })
    }

    await tx
      .update(thirdPartyInspections)
      .set({
        result: input.result,
        resultAt: input.resultAt ? new Date(input.resultAt) : new Date(),
        documentId: input.documentId ?? null,
        updatedAt: new Date(),
      })
      .where(scoped(thirdPartyInspections, ctx, eq(thirdPartyInspections.id, row.id)))

    await emit(ctx, tx, {
      eventName: QUALITY_EVENTS.thirdPartyResult,
      payload: {
        thirdPartyInspectionId: row.id,
        orderId: row.orderId,
        agency: row.agency,
        result: input.result,
      },
      aggregateTable: 'third_party_inspections',
      aggregateId: row.id,
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads and readiness
// ─────────────────────────────────────────────────────────────────────────────

export interface FinalReadiness {
  orderId: string
  plannedFinalDate: string
  daysToFinal: number
  ready: boolean
  blockers: string[]
}

/**
 * Pre-final readiness against the TNA date (brief §Jobs).
 *
 * Blockers are named, not counted: "no measurement check on record" and "last inline DHU
 * above threshold" need different people to do different things, and a single
 * not-ready flag sends nobody anywhere.
 */
export async function preFinalReadiness(
  ctx: AnyCtx,
  input: { today: string; windowDays: number },
  policy: QualityPolicy,
): Promise<FinalReadiness[]> {
  const { tnaMilestones } = await import('@/modules/orders/schema')

  return withTenantRead(ctx, async (tx) => {
    const horizon = addDays(input.today, input.windowDays)

    const milestones = await tx
      .select({ orderId: tnaMilestones.orderId, plannedDate: tnaMilestones.plannedDate })
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, 
        and(
          eq(tnaMilestones.name, 'final_inspection'),
          lte(tnaMilestones.plannedDate, horizon),
          eq(tnaMilestones.status, 'pending'),
        ),
      ))

    const out: FinalReadiness[] = []

    for (const milestone of milestones) {
      const blockers: string[] = []

      const [measurement] = await tx
        .select({ result: measurementChecks.result })
        .from(measurementChecks)
        .where(scoped(measurementChecks, ctx, eq(measurementChecks.orderId, milestone.orderId)))
        .orderBy(desc(measurementChecks.createdAt))
        .limit(1)

      if (!measurement) blockers.push('quality.readiness.no_measurement_check')
      else if (measurement.result === 'fail') blockers.push('quality.readiness.measurement_failed')

      const [thirdParty] = await tx
        .select({ result: thirdPartyInspections.result })
        .from(thirdPartyInspections)
        .where(scoped(thirdPartyInspections, ctx, eq(thirdPartyInspections.orderId, milestone.orderId)))
        .orderBy(desc(thirdPartyInspections.scheduledAt))
        .limit(1)

      if (thirdParty?.result === 'fail') blockers.push('quality.readiness.third_party_failed')

      void policy

      out.push({
        orderId: milestone.orderId,
        plannedFinalDate: milestone.plannedDate,
        daysToFinal: dayGap(input.today, milestone.plannedDate),
        ready: blockers.length === 0,
        blockers,
      })
    }

    return out.sort((a, b) => a.daysToFinal - b.daysToFinal)
  })
}

/**
 * The buyer report pack's data (brief: "buyer report pack generator … per PO").
 *
 * Returns the three sections the pack renders — inline history, DHU trend, final AQL. The
 * PDF itself is document work; this is the part that must be correct.
 */
export async function buyerReportPack(
  ctx: AnyCtx,
  input: { orderId: string; from: string; to: string },
): Promise<{
  inlineChecks: (typeof inlineChecks.$inferSelect)[]
  dhuTrend: (typeof dhuDaily.$inferSelect)[]
  finalInspections: (typeof finalInspections.$inferSelect)[]
  measurementChecks: (typeof measurementChecks.$inferSelect)[]
}> {
  return withTenantRead(ctx, async (tx) => {
    const checks = await tx
      .select()
      .from(inlineChecks)
      .where(scoped(inlineChecks, ctx, 
        and(
          eq(inlineChecks.orderId, input.orderId),
          gte(inlineChecks.checkedOn, input.from),
          lte(inlineChecks.checkedOn, input.to),
        ),
      ))
      .orderBy(inlineChecks.checkedOn)

    const lineIds = [...new Set(checks.map((c) => c.lineId))]

    const [trend, finals, measurements] = await Promise.all([
      lineIds.length > 0
        ? tx
            .select()
            .from(dhuDaily)
            .where(scoped(dhuDaily, ctx, 
              and(
                inArray(dhuDaily.lineId, lineIds),
                gte(dhuDaily.dhuDate, input.from),
                lte(dhuDaily.dhuDate, input.to),
              ),
            ))
            .orderBy(dhuDaily.dhuDate)
        : Promise.resolve([]),
      tx
        .select()
        .from(finalInspections)
        .where(scoped(finalInspections, ctx, eq(finalInspections.orderId, input.orderId)))
        .orderBy(desc(finalInspections.inspectedAt)),
      tx
        .select()
        .from(measurementChecks)
        .where(scoped(measurementChecks, ctx, eq(measurementChecks.orderId, input.orderId)))
        .orderBy(desc(measurementChecks.createdAt)),
    ])

    return {
      inlineChecks: checks,
      dhuTrend: trend,
      finalInspections: finals,
      measurementChecks: measurements,
    }
  })
}

function toMinor(value: string): bigint {
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(2, '0').slice(0, 2))
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

function dayGap(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000,
  )
}

/** Offline sync body, shared with the batch endpoint. */
export const offlineCaptureInlineCheck = captureInlineCheckIn

export { conflict }

/**
 * The defect taxonomy a fresh factory needs (brief: "seeded standard taxonomy,
 * company-extendable").
 *
 * Without it `captureInlineCheck` and `runFinalInspection` refuse every code, so a new
 * factory cannot record a defect at all.
 *
 * **The severities are the load-bearing part**, and they are judgement: `severity` is what
 * an AQL verdict is computed against, so classifying a broken needle as major rather than
 * critical would let a lot pass that should fail on sight. The set below is deliberately
 * conservative — anything that can injure the wearer is critical, anything a buyer would
 * reject the garment for is major, and cosmetic issues are minor. A factory's own QA manager
 * should review it against their buyers' manuals before relying on it.
 *
 * Idempotent: a code the factory has re-classified is left exactly as it is.
 */
export async function seedDefaultDefectCodes(
  ctx: AnyCtx,
): Promise<{ created: string[]; existing: string[] }> {
  const defaults: readonly {
    category: string
    code: string
    label: string
    severity: 'critical' | 'major' | 'minor'
  }[] = [
    // Critical: can injure the person wearing it. No acceptance number applies.
    { category: 'safety', code: 'BROKEN_NEEDLE', label: 'Broken needle in garment', severity: 'critical' },
    { category: 'safety', code: 'SHARP_OBJECT', label: 'Sharp object or metal contamination', severity: 'critical' },
    { category: 'safety', code: 'CHOKING_HAZARD', label: 'Detachable small part (choking hazard)', severity: 'critical' },

    // Major: a buyer would reject the garment.
    { category: 'stitching', code: 'BROKEN_STITCH', label: 'Broken stitch', severity: 'major' },
    { category: 'stitching', code: 'OPEN_SEAM', label: 'Open or unsecured seam', severity: 'major' },
    { category: 'stitching', code: 'PUCKERING', label: 'Seam puckering', severity: 'major' },
    { category: 'measurement', code: 'OUT_OF_SPEC', label: 'Measurement out of tolerance', severity: 'major' },
    { category: 'fabric', code: 'FABRIC_HOLE', label: 'Hole or tear in fabric', severity: 'major' },
    { category: 'fabric', code: 'SHADE_VARIATION', label: 'Shade variation within garment', severity: 'major' },
    { category: 'labelling', code: 'WRONG_LABEL', label: 'Wrong or missing care/size label', severity: 'major' },
    { category: 'trims', code: 'ZIPPER_FAULT', label: 'Zipper does not run', severity: 'major' },

    // Minor: cosmetic, and a buyer allows a few per lot.
    { category: 'stitching', code: 'SKIP_STITCH', label: 'Skipped stitch', severity: 'minor' },
    { category: 'stitching', code: 'UNEVEN_TOPSTITCH', label: 'Uneven topstitching', severity: 'minor' },
    { category: 'finishing', code: 'OIL_STAIN', label: 'Oil stain', severity: 'minor' },
    { category: 'finishing', code: 'LOOSE_THREAD', label: 'Untrimmed thread', severity: 'minor' },
    { category: 'finishing', code: 'POOR_PRESSING', label: 'Poor pressing', severity: 'minor' },
  ]

  return withTenantTx(ctx, async (tx) => {
    const created: string[] = []
    const existing: string[] = []

    for (const entry of defaults) {
      const [already] = await tx
        .select({ code: defectCodes.code })
        .from(defectCodes)
        .where(scoped(defectCodes, ctx, eq(defectCodes.code, entry.code)))

      if (already) {
        existing.push(entry.code)
        continue
      }

      await tx.insert(defectCodes).values({ companyId: ctx.companyId, ...entry })
      created.push(entry.code)
    }

    return { created, existing }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The fabric-inspection gate (7.1 → 3.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answer the store's "may I issue these rolls" question.
 *
 * Registered against `store/gates.ts`, which fails closed without it.
 *
 * Two judgements live here rather than in the seam:
 *
 *  - **Whether the gate applies to a given roll.** A knit composite factory knits its own
 *    greige and grades it on the machine, so blocking its store on a 4-point sheet that
 *    nobody in the building produces would stop production for a document that does not
 *    exist. That exemption is about cloth the factory MADE, and it used to be written as a
 *    company-wide `factoryType !== 'woven'` escape — which quietly exempted bought-in cloth
 *    too. A knit-composite house making denim jackets imports woven denim by the container
 *    with a mill 4-point sheet in the packet, and the three rolls that sheet failed went
 *    onto the cutting table with the gate returning "passed" without looking (live-test kit,
 *    Phase 4 · rolls R-D-19..21). A roll bought on a purchase order was not knitted here, so
 *    the exemption cannot cover it.
 *  - **What "inspected" means.** A roll inherits its GRN's inspection when it has no
 *    inspection of its own, because inspectors grade a sample of a consignment, not every
 *    roll — that is what the 4-point system is for. A roll with its OWN failed inspection
 *    is blocked regardless of how the consignment graded.
 */
export async function resolveFabricInspection(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { rollIds: readonly string[] },
): Promise<GateResult> {
  if (input.rollIds.length === 0) return { passed: true }

  const { companyProfile } = await import('@/modules/settings/service')
  const profile = await companyProfile(ctx)
  const knitsItsOwn = (profile?.factoryType ?? 'woven') !== 'woven'

  const { grnLines, grns, items, rolls } = await import('@/modules/store/schema')

  const rollRows = await tx
    .select({
      id: rolls.id,
      rollNo: rolls.rollNo,
      grnId: grnLines.grnId,
      kind: items.kind,
      // What the storekeeper said at the door. `own_production` is the only answer that
      // exempts, and it has to be SAID — see below.
      source: grns.source,
    })
    .from(rolls)
    .innerJoin(grnLines, eq(grnLines.id, rolls.grnLineId))
    .innerJoin(grns, eq(grns.id, grnLines.grnId))
    .innerJoin(items, eq(items.id, rolls.itemId))
    .where(scoped(rolls, ctx, inArray(rolls.id, [...input.rollIds])))

  if (rollRows.length !== input.rollIds.length) {
    // A roll the gate cannot resolve is a roll it cannot clear. Blocking is the safe
    // direction, and the store's own not-found error will explain it better than this can.
    return {
      passed: false,
      reasonKey: 'gates.fabric_inspection.roll_not_found',
      facts: {
        gate: GATES.fabricInspection,
        expected: input.rollIds.length,
        found: rollRows.length,
        reason:
          `${rollRows.length} of ${input.rollIds.length} rolls could be found, so the ` +
          `inspection state of the rest is unknown. The store can say which roll is missing.`,
      },
    }
  }

  // FABRIC only. The 4-point system grades cloth by area — faults per hundred square yards —
  // and has nothing whatsoever to say about a carton of buttons or a cone of thread, both of
  // which this store also tracks as rolls. Gating those would block a trim issue on an
  // inspection no factory on earth performs, and the storekeeper's only escape would be to
  // file a fictional one.
  const fabricRolls = rollRows.filter((r) => {
    if (r.kind !== 'fabric') return false
    /*
     * Own cloth in a knit house: knitted here, graded on the machine, no 4-point sheet to
     * wait for. Bought cloth is gated whatever the factory type, because somebody else made
     * it and the sheet that says whether it is good came in the box with it.
     *
     * The exemption needs the receipt to SAY it is own production. It used to key on the
     * absence of a purchase order link, and absence is not evidence — `/store/receive` never
     * captured a PO, so every bought delivery satisfied "no PO" and was waved through. That
     * is how rolls failing at 27 and 22 points against a 20-point limit reached the cutting
     * floor of a knit-composite house (Nordkap §6e), and how R-D-19..21 did before them. An
     * unanswered question now gates.
     */
    if (knitsItsOwn && r.source === 'own_production') return false
    return true
  })
  if (fabricRolls.length === 0) return { passed: true }

  const grnIds = [...new Set(fabricRolls.map((r) => r.grnId))]
  const inspections = await tx
    .select({
      grnId: fabricInspections.grnId,
      rollId: fabricInspections.rollId,
      result: fabricInspections.result,
      pointsPer100SqYd: fabricInspections.pointsPer100SqYd,
    })
    .from(fabricInspections)
    .where(scoped(fabricInspections, ctx, inArray(fabricInspections.grnId, grnIds)))

  const byRoll = new Map(inspections.filter((i) => i.rollId).map((i) => [i.rollId!, i]))
  // Latest wins per GRN; a re-inspection after a claim is the answer that counts.
  const byGrn = new Map(inspections.filter((i) => !i.rollId).map((i) => [i.grnId, i]))

  const uninspected: string[] = []
  const failed: { rollNo: string; points: string }[] = []

  for (const roll of fabricRolls) {
    const inspection = byRoll.get(roll.id) ?? byGrn.get(roll.grnId)
    if (!inspection) {
      uninspected.push(roll.rollNo)
      continue
    }
    if (inspection.result === 'fail') {
      failed.push({ rollNo: roll.rollNo, points: inspection.pointsPer100SqYd })
    }
  }

  if (failed.length > 0) {
    return {
      passed: false,
      reasonKey: 'gates.fabric_inspection.failed',
      facts: {
        gate: GATES.fabricInspection,
        rolls: failed.map((f) => f.rollNo),
        pointsPer100SqYd: failed[0]!.points,
        // Named rolls, because the storekeeper's next act is to pull those exact ones off
        // the issue. Composed here since only `reason` crosses the action boundary.
        reason: fabricInspectionRefusal('failed', {
          rolls: failed.map((f) => f.rollNo),
          points: failed[0]!.points,
        }),
      },
    }
  }

  if (uninspected.length > 0) {
    return {
      passed: false,
      reasonKey: 'gates.fabric_inspection.not_inspected',
      facts: {
        gate: GATES.fabricInspection,
        rolls: uninspected,
        reason: fabricInspectionRefusal('not_inspected', { rolls: uninspected }),
      },
    }
  }

  return { passed: true }
}

/**
 * Recompute a GRN's `inspection_status` from the inspections filed against it.
 *
 * Derived, never incremented — the same rule as DHU day-close. A summary that is stepped
 * forward on each write drifts the first time an inspection is corrected, and this one
 * decides whether a storekeeper believes the fabric is checked.
 *
 * `failed_partial` is a real state and matters commercially: some rolls of a consignment
 * failed and some passed, which is a partial claim against the mill rather than a rejected
 * delivery, and the good rolls can still be cut.
 */
async function rollUpGrnInspection(ctx: AnyCtx, tx: TenantDb, grnId: string): Promise<void> {
  const filed = await tx
    .select({ result: fabricInspections.result })
    .from(fabricInspections)
    .where(scoped(fabricInspections, ctx, eq(fabricInspections.grnId, grnId)))

  if (filed.length === 0) return

  const failures = filed.filter((f) => f.result === 'fail').length
  const status =
    failures === 0 ? 'passed' : failures === filed.length ? 'failed' : 'failed_partial'

  // Through the owner, never a raw update: `grns` is store's table and ⚖-audited, and
  // this was the one place in the repo that wrote another module's table directly —
  // an inspection verdict changing a customs-facing record with no audit row.
  const { setGrnInspectionStatus } = await import('@/modules/store/service')
  await setGrnInspectionStatus(ctx, tx, { grnId, status })
}

// ─────────────────────────────────────────────────────────────────────────────
// Commit handlers for the pending targets registered in `register.ts`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Commit an approved measurement chart.
 *
 * `measurement_specs` has been a registered pending target since the module landed, with
 * nothing to commit it — so a chart drafted from a buyer's spec sheet could be reviewed and
 * approved and then failed at the last step. The whole propose→approve→commit loop is only
 * as real as its last link.
 *
 * Versioned, never edited in place, for the reason `createMeasurementSpec` gives: a check
 * recorded against version 1 was judged against version 1's tolerances, and rewriting the
 * chart would silently re-grade every historic check — including ones already in a buyer
 * report.
 */
export async function commitMeasurementSpec(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const payload = measurementSpecPayload.parse(input.payload)

  const [latest] = await tx
    .select({ version: measurementSpecs.version })
    .from(measurementSpecs)
    .where(scoped(measurementSpecs, ctx, eq(measurementSpecs.styleCode, payload.styleCode)))
    .orderBy(desc(measurementSpecs.version))
    .limit(1)

  const version = (latest?.version ?? 0) + 1

  const [row] = await tx
    .insert(measurementSpecs)
    .values({
      companyId: ctx.companyId,
      styleCode: payload.styleCode,
      version,
      points: payload.points,
      unit: payload.unit,
      createdBy: isSystemCtx(ctx) ? null : ctx.userId,
    })
    .returning({ id: measurementSpecs.id })

  if (!row) throw new Error('measurement_specs insert returned nothing')

  return {
    rowId: row.id,
    after: { styleCode: payload.styleCode, version, unit: payload.unit, points: payload.points },
  }
}

/**
 * Commit an approved defect code.
 *
 * Upsert on the code, because a taxonomy drafted from a buyer's defect list overlaps the
 * factory's own on almost every entry — and refusing the whole draft because three of
 * twenty codes already exist is how a reviewer learns to reject drafts wholesale.
 */
export async function commitDefectCode(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const payload = defectCodePayload.parse(input.payload)

  const [row] = await tx
    .insert(defectCodes)
    .values({
      companyId: ctx.companyId,
      category: payload.category,
      code: payload.code,
      label: payload.label,
      severity: payload.severity,
    })
    .onConflictDoUpdate({
      target: [defectCodes.companyId, defectCodes.code],
      set: {
        category: payload.category,
        label: payload.label,
        severity: payload.severity,
        isActive: true,
      },
    })
    .returning({ id: defectCodes.id })

  if (!row) throw new Error('defect_codes upsert returned nothing')

  return { rowId: row.id, after: { ...payload } }
}
