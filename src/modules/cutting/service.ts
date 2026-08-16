/**
 * 5.1 Cutting Floor — service layer ⚖
 *
 * Two gates guard `createLay`, both server-side and both structured (rule 8):
 *
 *  1. **PP approval** — the buyer has signed off a pre-production sample. Cutting before
 *     it is how a factory makes eighty thousand garments to a spec the buyer rejects.
 *  2. **Issued fabric present** — the rolls this lay claims to consume were actually
 *     issued to this order. Cutting fabric the store has no record of issuing means the
 *     stock ledger and the floor disagree, and on bonded fabric that disagreement is a
 *     customs problem, not a bookkeeping one.
 *
 * A cut report records WHICH breakdown revision it was validated against. The buyer can
 * revise the size grid the week after cutting starts; a report checked against "the
 * active revision" with no record of which one that was cannot be defended later.
 */
import { fromMinor, toMinor } from '@/lib/quantity'
import { and, eq, inArray } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { assertGate, GATES, type GateResult } from '../core/gates'
import { checkFabricInspection } from '../store/gates'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import {
  bundlesForCell,
  cutCompletion,
  CuttingError,
  layYield,
  validateCutReport,
  wastageForOrder,
  type BreakdownCell,
  type CutCell,
  type CutReportValidation,
} from './cutting'
import { CUTTING_EVENTS } from './events'
import { checkPpApproval } from './gates'
import { bundles, cutReports, cutWastage, lays, markers } from './schema'
import {
  CELL_SEPARATOR,
  createLayPayload,
  cutReportPayload,
  markerPayload,
  type CutReportCorrectionPayload,
} from './zod'

/** ⚖ — a cut report is what the order's remaining fabric is measured against. */
registerAuditedTables('cut_reports', 'cut_wastage')

/**
 * open → cut → (terminal). `cancelled` is reachable only from `open`: once a report is
 * filed the fabric is cut, and cancelling the lay would not put it back on the roll.
 */
export const layMachine = defineStateMachine({
  field: 'status',
  initial: 'open',
  transitions: {
    open: ['cut', 'cancelled'],
    cut: [],
    cancelled: [],
  },
})

export const bundleMachine = defineStateMachine({
  field: 'status',
  initial: 'created',
  transitions: {
    created: ['in_sewing'],
    in_sewing: ['done'],
    done: [],
  },
})

export type LayStatus = (typeof layMachine.states)[number]
export type BundleStatus = (typeof bundleMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface CuttingPolicy {
  /** Cut-vs-breakdown tolerance. Required — a default here would be a silent allowance. */
  tolerancePct: string
  defaultBundleSize?: number
  /** Wastage past marker plan + this many percent raises the anomaly alert. */
  wastageAlertPct?: string
}

function wrapCuttingError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof CuttingError) {
      throw new AppError('validation_failed', 'cutting.errors.uncomputable', {
        reason: error.message,
      })
    }
    throw error
  }
}

function parseCells(cells: Record<string, number>): CutCell[] {
  return Object.entries(cells).map(([key, qty]) => {
    const [color = '', size = ''] = key.split(CELL_SEPARATOR)
    return { color, size, qty }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reference data
// ─────────────────────────────────────────────────────────────────────────────

export async function createMarker(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ markerId: string }> {
  return withTenantTx(ctx, (tx) => createMarkerIn(ctx, tx, input))
}

/**
 * Commit a marker drafted through the approve inbox — the far end of `pendingTargets`.
 *
 * `markers` has been a pending target since 5.1 with nothing to commit it, so core fell
 * back to its generic row write. That write treats payload keys as literal column names
 * and refuses anything that is not a bare lowercase identifier, so `styleCode`,
 * `sizeRatio` and `layLengthMeters` were all rejected as invalid identifiers — every
 * marker draft ever approved failed, at the click, after the review.
 *
 * Going through `createMarkerIn` also gets the duplicate-code check. A generic insert
 * would have hit the `markers_company_code_key` unique index and surfaced a raw Postgres
 * violation to somebody who only ever typed a marker code twice.
 */
export async function commitMarkerDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    /*
     * Markers are added, never edited through a draft.
     *
     * A lay records `markerId`, and its piece yield is computed from that marker's ratio
     * and lay length. Editing a marker in place would silently restate what every lay
     * already spread against it — including ones the floor finished cutting last week —
     * and nothing in the cut reports would show that the arithmetic underneath them moved.
     * A changed marker is a new marker with a new code.
     */
    throw new AppError('validation_failed', 'cutting.errors.marker_draft_insert_only', {
      operation: input.operation,
    })
  }

  const result = await createMarkerIn(ctx, tx, input.payload)
  return { rowId: result.markerId, before: null, after: { markerId: result.markerId } }
}

/** The insert itself, inside a transaction the caller owns. */
async function createMarkerIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ markerId: string }> {
  const payload = markerPayload.parse(input)

  const [existing] = await tx
    .select({ id: markers.id })
    .from(markers)
    .where(scoped(markers, ctx, eq(markers.code, payload.code)))

  if (existing) {
    // A typed conflict rather than a unique-index violation. The code is how the floor
    // names a marker on paper, so colliding on one is an ordinary mistake, and the
    // person who made it should be told which code — not shown a constraint name.
    throw conflict('cutting.errors.marker_code_exists', { code: payload.code })
  }

  const [row] = await tx
    .insert(markers)
    .values({
      companyId: ctx.companyId,
      code: payload.code,
      styleCode: payload.styleCode,
      sizeRatio: payload.sizeRatio,
      layLengthMeters: payload.layLengthMeters,
      efficiencyPct: payload.efficiencyPct ?? null,
      fabricWidthInches: payload.fabricWidthInches ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: markers.id })

  if (!row) throw new Error('markers insert returned nothing')
  return { markerId: row.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// The lay, and its two gates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Are these rolls actually issued to this order?
 *
 * Reads store's tables through their owning module's schema (rule 11). A roll that was
 * never issued, or was issued to a different order, means the ledger and the floor
 * disagree — and on bonded fabric that is a customs exposure, not a clerical one.
 */
async function checkIssuedFabric(
  // `ctx` so the gate's own reads name the company. A gate that decided from another
  // factory's rolls would refuse or allow for reasons nobody could reconstruct.
  ctx: AnyCtx,
  tx: TenantDb,
  input: { orderId: string; rollIds: readonly string[] },
): Promise<{ passed: boolean; reasonKey?: string; facts?: Record<string, unknown> }> {
  if (input.rollIds.length === 0) {
    return { passed: false, reasonKey: 'gates.issued_fabric.no_rolls' }
  }

  const { issueLines, issues, rolls } = await import('@/modules/store/schema')

  const found = await tx
    .select({ rollId: issueLines.rollId, orderId: issues.orderId, status: rolls.status })
    .from(issueLines)
    .innerJoin(issues, eq(issueLines.issueId, issues.id))
    .innerJoin(rolls, eq(issueLines.rollId, rolls.id))
    .where(scoped(issueLines, ctx, inArray(issueLines.rollId, [...input.rollIds])))

  const issuedToThisOrder = new Set(
    found.filter((row) => row.orderId === input.orderId).map((row) => row.rollId),
  )
  const missing = input.rollIds.filter((id) => !issuedToThisOrder.has(id))

  if (missing.length > 0) {
    return {
      passed: false,
      reasonKey: 'gates.issued_fabric.not_issued_to_order',
      facts: { orderId: input.orderId, rollIds: missing },
    }
  }

  return { passed: true }
}

export interface CreateLayResult {
  layId: string
  expectedPerSize: Record<string, number>
  plannedFabric: string
}

/**
 * Spread a lay (brief: "Preconditions on lay create: pp_approved gate AND issued fabric
 * present — enforced server-side, returned as structured precondition errors").
 *
 * Both gates throw the typed `gate_blocked` error rather than a generic 400, so the floor
 * tablet can show WHICH precondition failed and what to do about it. A disabled button is
 * not a gate.
 */
/**
 * Whether the PP gate would let this style be spread, and why not.
 *
 * A read of the same gate `createLay` enforces, so the answer a person is given is the
 * answer they will get when they try. Exposed because the question "why can I not cut
 * this" had no way to be answered without attempting the write and reading the refusal.
 */
export async function ppApprovalStatus(
  ctx: AnyCtx,
  input: { orderId: string; orderStyleId: string },
): Promise<GateResult> {
  return withTenantRead(ctx, (tx) => checkPpApproval(ctx, tx, input))
}

export async function createLay(ctx: RequestCtx, input: unknown): Promise<CreateLayResult> {
  const payload = createLayPayload.parse(input)

  return withTenantTx(ctx, async (tx) => createLayIn(ctx, tx, payload))
}

/** The body of `createLay`, reusable from the offline sync handler's transaction. */
async function createLayIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof createLayPayload.parse>,
): Promise<CreateLayResult> {
  const [marker] = await tx.select().from(markers).where(scoped(markers, ctx, eq(markers.id, payload.markerId)))
  if (!marker) throw notFound('cutting.errors.marker_not_found', { markerId: payload.markerId })

  assertGate(
    GATES.ppApproval,
    await checkPpApproval(ctx, tx, {
      orderId: payload.orderId,
      orderStyleId: payload.orderStyleId,
    }),
  )

  const fabric = await checkIssuedFabric(ctx, tx, {
    orderId: payload.orderId,
    rollIds: payload.rollsDrawn,
  })
  if (!fabric.passed) {
    throw new AppError('gate_blocked', fabric.reasonKey ?? 'gates.issued_fabric.blocked', {
      gate: 'issued_fabric',
      ...fabric.facts,
    })
  }

  /*
   * 4-point, again — over the rolls about to be SPREAD (rule 8, Nordkap §8 F39).
   *
   * The store checks this when cloth leaves the rack, which is the right moment and not the
   * only one. A lay draws on rolls already issued to the order, so anything that failed
   * inspection *after* it was issued — or was returned to the rack and picked up again —
   * reaches the cutting table by a path that gate never sees. It is how `R-F-17`, failed at
   * 24 points against a 20-point limit, was spread into LAY-41 and cut into garments.
   *
   * The same seam the store calls, so the exemptions stay identical: a knit house's own
   * greige is not gated, bought cloth is, and a roll with its own failed inspection is
   * blocked whatever its consignment graded. Cutting is the last moment this is recoverable
   * — after the knife it is a claim, not a decision.
   */
  assertGate(
    GATES.fabricInspection,
    await checkFabricInspection(ctx, tx, { rollIds: payload.rollsDrawn }),
  )

  const expected = wrapCuttingError(() =>
    layYield(
      {
        sizeRatio: marker.sizeRatio,
        layLengthMeters: payload.layLengthMeters,
        fabricWidthInches: marker.fabricWidthInches ?? undefined,
      },
      payload.plies,
    ),
  )

  const [row] = await tx
    .insert(lays)
    .values({
      companyId: ctx.companyId,
      orderId: payload.orderId,
      orderStyleId: payload.orderStyleId,
      markerId: payload.markerId,
      layNo: payload.layNo,
      color: payload.color,
      plies: payload.plies,
      layLengthMeters: payload.layLengthMeters,
      rollsDrawn: payload.rollsDrawn,
      fabricDrawnMeters: payload.fabricDrawnMeters ?? expected.plannedFabric,
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: lays.id })

  if (!row) throw new Error('lays insert returned nothing')

  await emit(ctx, tx, {
    eventName: CUTTING_EVENTS.layCreated,
    payload: {
      layId: row.id,
      orderId: payload.orderId,
      markerId: payload.markerId,
      plies: payload.plies,
    },
    aggregateTable: 'lays',
    aggregateId: row.id,
  })

  return {
    layId: row.id,
    expectedPerSize: expected.perSize,
    plannedFabric: expected.plannedFabric,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The cut report
// ─────────────────────────────────────────────────────────────────────────────

/** The buyer's grid as the floor is cutting to it right now. */
async function activeBreakdown(
  ctx: AnyCtx,
  tx: TenantDb,
  orderStyleId: string,
): Promise<{ revision: number; cells: BreakdownCell[] }> {
  const { orderBreakdowns, orderStyles } = await import('@/modules/orders/schema')

  const [style] = await tx
    .select({ activeRevision: orderStyles.activeRevision })
    .from(orderStyles)
    .where(scoped(orderStyles, ctx, eq(orderStyles.id, orderStyleId)))

  if (!style) throw notFound('cutting.errors.style_not_found', { orderStyleId })

  const cells = await tx
    .select({
      color: orderBreakdowns.color,
      size: orderBreakdowns.size,
      qty: orderBreakdowns.qty,
    })
    .from(orderBreakdowns)
    .where(scoped(orderBreakdowns, ctx, 
      and(
        eq(orderBreakdowns.orderStyleId, orderStyleId),
        eq(orderBreakdowns.revision, style.activeRevision),
      ),
    ))

  if (cells.length === 0) {
    // Cutting against an empty grid would validate anything at all.
    throw notFound('cutting.errors.no_breakdown', {
      orderStyleId,
      revision: style.activeRevision,
    })
  }

  return { revision: style.activeRevision, cells }
}

/** Everything cut so far for a style, across every lay. */
async function cutSoFar(ctx: AnyCtx, tx: TenantDb, orderStyleId: string): Promise<CutCell[]> {
  const rows = await tx
    .select({ cells: cutReports.cells })
    .from(cutReports)
    .innerJoin(lays, eq(cutReports.layId, lays.id))
    .where(scoped(cutReports, ctx, eq(lays.orderStyleId, orderStyleId)))

  const totals = new Map<string, number>()
  for (const row of rows) {
    for (const [key, qty] of Object.entries(row.cells)) {
      totals.set(key, (totals.get(key) ?? 0) + qty)
    }
  }

  return parseCells(Object.fromEntries(totals))
}

export interface CutReportResult {
  cutReportId: string
  validation: CutReportValidation
  completion: { complete: boolean; pct: string }
  breakdownRevision: number
  /** Tickets generated from this report. Zero when no bundle size is configured. */
  bundleCount: number
}

/**
 * File what came off the table.
 *
 * Validated against the ACTIVE breakdown revision, and that revision number is stored on
 * the report. Completion is judged cell by cell across every lay for the style — a
 * total-based figure lets an over-cut of one colour cover a short of another, which is how
 * an order reaches "100% cut" and still cannot be shipped.
 */
export async function recordCutReport(
  ctx: RequestCtx,
  input: unknown,
  policy: CuttingPolicy,
): Promise<CutReportResult> {
  const payload = cutReportPayload.parse(input)
  return withTenantTx(ctx, async (tx) => recordCutReportIn(ctx, tx, payload, policy))
}

async function recordCutReportIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof cutReportPayload.parse>,
  policy: CuttingPolicy,
): Promise<CutReportResult> {
  const [lay] = await tx.select().from(lays).where(scoped(lays, ctx, eq(lays.id, payload.layId))).for('update')
  if (!lay) throw notFound('cutting.errors.lay_not_found', { layId: payload.layId })

  layMachine.assert(lay.status as LayStatus, 'cut')

  const breakdown = await activeBreakdown(ctx, tx, lay.orderStyleId)
  const reported = parseCells(payload.cells)

  const validation = wrapCuttingError(() =>
    validateCutReport(breakdown.cells, reported, { tolerancePct: policy.tolerancePct }),
  )

  const [row] = await tx
    .insert(cutReports)
    .values({
      companyId: ctx.companyId,
      layId: lay.id,
      cells: payload.cells,
      breakdownRevision: breakdown.revision,
      tolerancePct: policy.tolerancePct,
      variances: validation.cells.filter((cell) => cell.status !== 'ok'),
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: cutReports.id })

  if (!row) throw new Error('cut_reports insert returned nothing')

  await tx
    .update(lays)
    .set({ status: 'cut', updatedAt: new Date() })
    .where(scoped(lays, ctx, eq(lays.id, lay.id)))

  await recordChange(ctx, tx, {
    action: 'insert',
    targetTable: 'cut_reports',
    targetId: row.id,
    after: {
      layId: lay.id,
      breakdownRevision: breakdown.revision,
      totalCut: validation.totalCut,
      totalOver: validation.totalOver,
      totalShort: validation.totalShort,
    },
  })

  await emit(ctx, tx, {
    eventName: CUTTING_EVENTS.cutReported,
    payload: {
      cutReportId: row.id,
      layId: lay.id,
      orderId: lay.orderId,
      totalCut: validation.totalCut,
    },
    aggregateTable: 'cut_reports',
    aggregateId: row.id,
  })

  if (!validation.withinTolerance) {
    // Merchandising needs to know before the buyer does.
    await emit(ctx, tx, {
      eventName: CUTTING_EVENTS.cutVariance,
      payload: {
        cutReportId: row.id,
        orderId: lay.orderId,
        breakdownRevision: breakdown.revision,
        totalOver: validation.totalOver,
        totalShort: validation.totalShort,
        cells: validation.cells.filter((cell) => cell.status !== 'ok' && cell.status !== 'pending'),
      },
      aggregateTable: 'cut_reports',
      aggregateId: row.id,
    })
  }

  // Wastage moves the moment a lay becomes `cut`, and this is that moment. Recomputed
  // from every cut lay rather than adjusted, so it cannot drift — the module's own rule
  // for a number a factory argues about with its owner.
  await recomputeWastageIn(ctx, tx, { orderId: lay.orderId }, policy)

  // Bundles, in the same transaction as the report they come from.
  //
  // A cut report with no bundles is cut cloth with no tickets, and a sewing line scans a
  // ticket to say a bundle arrived — so the pieces would simply never reach sewing. The
  // tie size is policy: a bundle is what a bundle boy can carry, and it differs by factory.
  // With none configured the bundles are NOT invented at some default size; the report
  // still files, and the count says zero rather than pretending.
  const bundleSize = policy.defaultBundleSize
  const bundling = bundleSize
    ? await generateBundlesIn(ctx, tx, { cutReportId: row.id, bundleSize })
    : { bundleCount: 0 }

  // Completion is judged across EVERY lay for the style, not this report alone — an
  // order is cut when the whole grid is met, not when one lay came off the table.
  const cutAcrossLays = await cutSoFar(ctx, tx, lay.orderStyleId)
  const completion = wrapCuttingError(() => cutCompletion(breakdown.cells, cutAcrossLays))

  if (completion.complete) {
    // 1.3 auto-actualises the cutting milestone off this.
    await emit(ctx, tx, {
      eventName: CUTTING_EVENTS.cuttingComplete,
      payload: {
        orderId: lay.orderId,
        orderStyleId: lay.orderStyleId,
        breakdownRevision: breakdown.revision,
      },
      aggregateTable: 'order_styles',
      aggregateId: lay.orderStyleId,
    })
  }

  return {
    cutReportId: row.id,
    validation,
    completion: { complete: completion.complete, pct: completion.pct },
    breakdownRevision: breakdown.revision,
    bundleCount: bundling.bundleCount,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Bundles
// ─────────────────────────────────────────────────────────────────────────────

export async function generateBundles(
  ctx: RequestCtx,
  input: { cutReportId: string; bundleSize: number },
): Promise<{ bundleCount: number }> {
  return withTenantTx(ctx, (tx) => generateBundlesIn(ctx, tx, input))
}

/**
 * The body of `generateBundles`, callable inside an existing transaction.
 *
 * Extracted so filing a cut report can produce its tickets in the SAME transaction. Until
 * this existed `generateBundles` was exported and called by nothing at all: every report
 * closed its lay and produced no bundles, so the cut pieces had no tickets and the sewing
 * line had nothing to scan. The chain stopped dead between cutting and sewing.
 */
async function generateBundlesIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { cutReportId: string; bundleSize: number },
): Promise<{ bundleCount: number }> {
  {
    const [report] = await tx
      .select()
      .from(cutReports)
      .where(scoped(cutReports, ctx, eq(cutReports.id, input.cutReportId)))
      .for('update')

    if (!report) {
      throw notFound('cutting.errors.report_not_found', { cutReportId: input.cutReportId })
    }

    const existing = await tx
      .select({ id: bundles.id })
      .from(bundles)
      .where(scoped(bundles, ctx, eq(bundles.cutReportId, report.id)))
      .limit(1)

    if (existing.length > 0) {
      // Tickets are already stapled to bundles on the floor. Re-generating would produce
      // a second set of numbers for the same physical stacks.
      throw conflict('cutting.errors.bundles_already_generated', { cutReportId: report.id })
    }

    const rows = parseCells(report.cells)
      .filter((cell) => cell.qty > 0)
      .flatMap((cell) => wrapCuttingError(() => bundlesForCell(cell, input.bundleSize)))

    if (rows.length === 0) return { bundleCount: 0 }

    await tx.insert(bundles).values(
      rows.map((bundle) => ({
        companyId: ctx.companyId,
        cutReportId: report.id,
        bundleNo: bundle.bundleNo,
        color: bundle.color,
        size: bundle.size,
        qty: bundle.qty,
        qrToken: crypto.randomUUID(),
      })),
    )

    await emit(ctx, tx, {
      eventName: CUTTING_EVENTS.bundlesGenerated,
      payload: { cutReportId: report.id, bundleCount: rows.length },
      aggregateTable: 'cut_reports',
      aggregateId: report.id,
    })

    return { bundleCount: rows.length }
  }
}

/** A scanner sends the token from the ticket, never a row id. */
export async function scanBundle(
  ctx: RequestCtx,
  input: { qrToken: string; status: BundleStatus },
): Promise<{ bundleId: string; status: BundleStatus }> {
  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(bundles)
      .where(scoped(bundles, ctx, eq(bundles.qrToken, input.qrToken)))
      .for('update')

    if (!row) throw notFound('cutting.errors.bundle_not_found', {})

    bundleMachine.assert(row.status as BundleStatus, input.status)

    await tx
      .update(bundles)
      .set({ status: input.status, updatedAt: new Date() })
      .where(scoped(bundles, ctx, eq(bundles.id, row.id)))

    return { bundleId: row.id, status: input.status }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Wastage
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute an order's wastage from its lays ⚖.
 *
 * Recomputed from scratch every time rather than accumulated. An incremental counter that
 * drifts is worse than a slow read, because this is the number a factory argues about
 * with its own owner.
 */
export async function recomputeWastage(
  ctx: RequestCtx,
  input: { orderId: string },
  policy: CuttingPolicy,
): Promise<{ fabricDrawn: string; markerConsumption: string; wastagePct: string }> {
  return withTenantTx(ctx, (tx) => recomputeWastageIn(ctx, tx, input, policy))
}

/**
 * The body of `recomputeWastage`, callable inside an existing transaction.
 *
 * Extracted so filing a cut report updates the figure in the SAME transaction. Like
 * `generateBundles`, this was exported and called by nothing: `cut_wastage` was written
 * once by whatever seeded it and never again, so the wastage screen showed a number that
 * stopped tracking the floor the moment the second lay was cut.
 */
async function recomputeWastageIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { orderId: string },
  policy: CuttingPolicy,
): Promise<{ fabricDrawn: string; markerConsumption: string; wastagePct: string }> {
  {
    const rows = await tx
      .select({
        plies: lays.plies,
        layLengthMeters: lays.layLengthMeters,
        fabricDrawnMeters: lays.fabricDrawnMeters,
      })
      .from(lays)
      .where(scoped(lays, ctx, and(eq(lays.orderId, input.orderId), eq(lays.status, 'cut'))))

    if (rows.length === 0) {
      throw notFound('cutting.errors.no_cut_lays', { orderId: input.orderId })
    }

    let drawn = 0n
    let planned = 0n
    for (const row of rows) {
      // `lay_length_meters` is PER PLY — the marker's length — so the lay's planned
      // consumption is that times the ply count.
      planned += toMinor(row.layLengthMeters) * BigInt(row.plies)

      // `fabric_drawn_meters` is already a TOTAL for the lay: `createLay` stores either
      // what the cutter drew off the rolls, or `layYield().plannedFabric`, which is itself
      // "lay length × plies". Multiplying it by plies a second time inflated drawn fabric
      // by the ply count — a 60-ply lay drawing 397 m was counted as 23,823 m, and the
      // wastage percentage this whole table exists for read in the thousands.
      //
      // The two branches are not interchangeable, which is what hid the bug: the fallback
      // IS per-ply and does need multiplying.
      drawn += row.fabricDrawnMeters
        ? toMinor(row.fabricDrawnMeters)
        : toMinor(row.layLengthMeters) * BigInt(row.plies)
    }

    const fabricDrawn = fromMinor(drawn)
    const markerConsumption = fromMinor(planned)
    const result = wrapCuttingError(() => wastageForOrder({ fabricDrawn, markerConsumption }))

    const [existing] = await tx
      .select({ id: cutWastage.id, wastagePct: cutWastage.wastagePct })
      .from(cutWastage)
      .where(scoped(cutWastage, ctx, eq(cutWastage.orderId, input.orderId)))

    if (existing) {
      await tx
        .update(cutWastage)
        .set({
          fabricDrawn,
          markerConsumption,
          wastagePct: result.wastagePct,
          computedAt: new Date(),
        })
        .where(scoped(cutWastage, ctx, eq(cutWastage.id, existing.id)))
    } else {
      await tx.insert(cutWastage).values({
        companyId: ctx.companyId,
        orderId: input.orderId,
        fabricDrawn,
        markerConsumption,
        wastagePct: result.wastagePct,
      })
    }

    await recordChange(ctx, tx, {
      action: existing ? 'update' : 'insert',
      targetTable: 'cut_wastage',
      targetId: existing?.id ?? input.orderId,
      before: existing ? { wastagePct: existing.wastagePct } : null,
      after: { fabricDrawn, markerConsumption, wastagePct: result.wastagePct },
    })

    // Only on the CROSSING, not on every recompute.
    //
    // Wastage is now recomputed whenever a lay is reported cut, so an order that is over
    // the threshold would raise the same alert on every subsequent lay — and an alert that
    // repeats on work that has not changed is one people filter into a folder. Firing when
    // the stored figure was under (or absent) and the new one is over makes the event mean
    // "this order just went over", which is the thing somebody acts on.
    const wasOver =
      existing !== undefined &&
      policy.wastageAlertPct !== undefined &&
      toMinor(existing.wastagePct) > toMinor(policy.wastageAlertPct)

    if (
      !wasOver &&
      policy.wastageAlertPct &&
      toMinor(result.wastagePct) > toMinor(policy.wastageAlertPct)
    ) {
      await emit(ctx, tx, {
        eventName: CUTTING_EVENTS.wastageAnomaly,
        payload: {
          orderId: input.orderId,
          wastagePct: result.wastagePct,
          thresholdPct: policy.wastageAlertPct,
          fabricDrawn,
          markerConsumption,
        },
        aggregateTable: 'cut_wastage',
        aggregateId: existing?.id ?? input.orderId,
      })
    }

    return { fabricDrawn, markerConsumption, wastagePct: result.wastagePct }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** Where an order's cutting stands — the figure 1.3 auto-actualises its milestone from. */
export async function cutPosition(
  ctx: AnyCtx,
  input: { orderStyleId: string },
): Promise<{ complete: boolean; pct: string; shortCells: unknown[] }> {
  return withTenantRead(ctx, async (tx) => {
    const breakdown = await activeBreakdown(ctx, tx, input.orderStyleId)
    const cut = await cutSoFar(ctx, tx, input.orderStyleId)
    const result = wrapCuttingError(() => cutCompletion(breakdown.cells, cut))
    return { complete: result.complete, pct: result.pct, shortCells: result.shortCells }
  })
}

/**
 * Commit handler for an approved cut-report correction (registered in `register.ts`).
 *
 * Restating what came off the table changes the order's cut position, and the original
 * number was written by somebody who was standing there — so a correction is a decision a
 * human approves, not an edit.
 */
export async function commitCutReportCorrection(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; before: Record<string, unknown>; after: Record<string, unknown> }> {
  const { cutReportCorrectionPayload } = await import('./zod')
  const payload: CutReportCorrectionPayload = cutReportCorrectionPayload.parse(input.payload)

  const [report] = await tx
    .select()
    .from(cutReports)
    .where(scoped(cutReports, ctx, eq(cutReports.id, payload.cutReportId)))
    .for('update')

  if (!report) {
    throw notFound('cutting.errors.report_not_found', { cutReportId: payload.cutReportId })
  }

  const [lay] = await tx.select().from(lays).where(scoped(lays, ctx, eq(lays.id, report.layId)))
  if (!lay) throw notFound('cutting.errors.lay_not_found', { layId: report.layId })

  // Re-validated against the revision the ORIGINAL report was checked against, not
  // today's. A correction restates what came off the table on that day; validating it
  // against a newer grid would judge the cutter by a spec that did not exist yet.
  const { orderBreakdowns } = await import('@/modules/orders/schema')
  const cells = await tx
    .select({ color: orderBreakdowns.color, size: orderBreakdowns.size, qty: orderBreakdowns.qty })
    .from(orderBreakdowns)
    .where(scoped(orderBreakdowns, ctx, 
      and(
        eq(orderBreakdowns.orderStyleId, lay.orderStyleId),
        eq(orderBreakdowns.revision, report.breakdownRevision),
      ),
    ))

  const validation = wrapCuttingError(() =>
    validateCutReport(cells, parseCells(payload.cells), { tolerancePct: report.tolerancePct }),
  )

  await tx
    .update(cutReports)
    .set({
      cells: payload.cells,
      variances: validation.cells.filter((cell) => cell.status !== 'ok'),
    })
    .where(scoped(cutReports, ctx, eq(cutReports.id, report.id)))

  return {
    rowId: report.id,
    before: { cells: report.cells },
    after: { cells: payload.cells, reason: payload.reason },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Offline sync bodies, shared with the batch endpoint
// ─────────────────────────────────────────────────────────────────────────────

export const offlineCreateLay = createLayIn
export const offlineRecordCutReport = recordCutReportIn

// Exact decimal helpers — fabric is numeric(12,2) and never a float.

export { conflict }
