/**
 * Read models for the Quality floor.
 *
 * DHU — defects per hundred units — is the number this screen exists to make
 * unavoidable. It is a RATIO, so it is always shown with its denominator: 4.2
 * DHU off 120 garments checked is a different fact from 4.2 off 6,000, and a
 * board that prints only the ratio invites a line to be judged on twelve pieces.
 *
 * A day with no inline checks has no DHU. Not zero — zero would read as a
 * perfect line when what actually happened is that nobody checked.
 */
import { and, asc, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'

import { compareDecimalStrings } from '@/lib/quantity'

import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { lines } from '@/modules/planning/schema'

import { dhuDaily, finalInspections, inlineChecks } from './schema'
import { factoryToday } from '@/lib/dates'

export interface LineDhu {
  lineId: string
  code: string
  name: string
  /** Null when nothing was checked — never 0. */
  dhu: string | null
  checked: number
  defects: number
  /** Above the factory's threshold, when there is a figure to compare. */
  overThreshold: boolean
}

export async function dhuByLine(
  ctx: AnyCtx,
  input: { on: string; threshold: string | null },
): Promise<LineDhu[]> {
  return withTenantRead(ctx, async (tx) => {
    const [lineRows, daily, checks] = await Promise.all([
      tx
        .select({ id: lines.id, code: lines.code, name: lines.name })
        .from(lines)
        .where(scoped(lines, ctx, eq(lines.isActive, true)))
        .orderBy(asc(lines.code)),
      tx
        .select({
          lineId: dhuDaily.lineId,
          dhu: dhuDaily.dhu,
          checked: dhuDaily.checked,
          defects: dhuDaily.defects,
        })
        .from(dhuDaily)
        .where(scoped(dhuDaily, ctx, eq(dhuDaily.dhuDate, input.on))),
      // The day may not be closed yet, so fall back to the raw checks rather
      // than showing nothing until somebody runs the close.
      tx
        .select({
          lineId: inlineChecks.lineId,
          checkedQty: inlineChecks.checkedQty,
          defectQty: inlineChecks.defectQty,
        })
        .from(inlineChecks)
        .where(scoped(inlineChecks, ctx, eq(inlineChecks.checkedOn, input.on))),
    ])

    return lineRows.map((line): LineDhu => {
      const closed = daily.find((d) => d.lineId === line.id)
      const live = checks.filter((c) => c.lineId === line.id)

      const checked = closed?.checked ?? live.reduce((n, c) => n + c.checkedQty, 0)
      const defects = closed?.defects ?? live.reduce((n, c) => n + c.defectQty, 0)

      // No denominator, no ratio. This is the whole point of the screen.
      const dhu =
        closed?.dhu ?? (checked > 0 ? ((defects / checked) * 100).toFixed(2) : null)

      return {
        lineId: line.id,
        code: line.code,
        name: line.name,
        dhu,
        checked,
        defects,
        overThreshold:
          dhu !== null && input.threshold !== null && compareDecimalStrings(dhu, input.threshold) > 0,
      }
    })
  })
}

export interface FinalInspectionRow {
  id: string
  inspectionNo: string
  lotQty: number
  standard: string
  sampleSize: number
  majorFound: number
  minorFound: number
  criticalFound: number
  majorAccept: number
  minorAccept: number
  verdict: string
  status: string
  inspectedAt: Date | null
}

/**
 * Final inspections, newest first.
 *
 * The verdict is computed server-side from the AQL plan and never supplied by
 * the caller, so this read shows the accept numbers alongside what was found —
 * an inspector cannot make a lot pass by relabelling a major defect, and the
 * screen should make the arithmetic checkable rather than asking for trust.
 */
export async function recentFinalInspections(
  ctx: AnyCtx,
  limit = 25,
): Promise<FinalInspectionRow[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: finalInspections.id,
        inspectionNo: finalInspections.inspectionNo,
        lotQty: finalInspections.lotQty,
        standard: finalInspections.standard,
        sampleSize: finalInspections.sampleSize,
        majorFound: finalInspections.majorFound,
        minorFound: finalInspections.minorFound,
        criticalFound: finalInspections.criticalFound,
        majorAccept: finalInspections.majorAccept,
        minorAccept: finalInspections.minorAccept,
        verdict: finalInspections.verdict,
        status: finalInspections.status,
        inspectedAt: finalInspections.inspectedAt,
      })
      .from(finalInspections)
      .orderBy(desc(finalInspections.createdAt))
      .limit(limit),
  )
}

/** Inline checks captured today, for the "is anybody checking" question. */
export async function inlineActivity(
  ctx: AnyCtx,
  input: { from: string; to: string },
): Promise<{ checks: number; checkedQty: number; fromDevice: number }> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        checkedQty: inlineChecks.checkedQty,
        offlineKey: inlineChecks.offlineKey,
      })
      .from(inlineChecks)
      .where(scoped(inlineChecks, ctx, and(gte(inlineChecks.checkedOn, input.from), lte(inlineChecks.checkedOn, input.to))))

    return {
      checks: rows.length,
      checkedQty: rows.reduce((n, r) => n + r.checkedQty, 0),
      fromDevice: rows.filter((r) => r.offlineKey).length,
    }
  })
}

/** Defect codes in use, for labelling counts on the board. */
export async function defectLabels(
  ctx: AnyCtx,
  codes: readonly string[],
): Promise<Map<string, { label: string; severity: string }>> {
  if (codes.length === 0) return new Map()

  const { defectCodes } = await import('./schema')
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ code: defectCodes.code, label: defectCodes.label, severity: defectCodes.severity })
      .from(defectCodes)
      .where(scoped(defectCodes, ctx, inArray(defectCodes.code, [...codes])))

    return new Map(rows.map((r) => [r.code, { label: r.label, severity: r.severity }]))
  })
}

export interface TapDefect {
  category: string
  code: string
  label: string
  severity: string
}

export interface TapOperator {
  id: string
  name: string
  designation: string | null
}

export interface RecentCheck {
  id: string
  operation: string
  checkedQty: number
  defectQty: number
  occurredAt: Date
}

export interface InlineCaptureContext {
  defects: TapDefect[]
  /** Operations already used on this line, most-used first — see the note below. */
  operations: string[]
  operators: TapOperator[]
  recent: RecentCheck[]
}

/**
 * Everything the 3-tap inline screen needs for one line.
 *
 * **Operations are learned, not configured.** There is no operations table — `operation` is
 * free text on the check — so the tap list is built from what this line has actually been
 * checked against, most-used first. That is deliberate: an operation bulletin maintained by
 * hand goes stale the first time a style changes, and a QC on the floor would then be picking
 * from a list that does not describe the machines in front of them. A line with no history
 * falls back to the standard sewing sequence, and the screen always allows typing one in.
 */
export async function inlineCaptureContext(
  ctx: AnyCtx,
  input: { lineId: string; recentLimit?: number },
): Promise<InlineCaptureContext> {
  const { defectCodes } = await import('./schema')
  const { workers } = await import('@/modules/workforce/schema')

  return withTenantRead(ctx, async (tx) => {
    const [codes, history, operators, recent] = await Promise.all([
      tx
        .select({
          category: defectCodes.category,
          code: defectCodes.code,
          label: defectCodes.label,
          severity: defectCodes.severity,
        })
        .from(defectCodes)
        .where(scoped(defectCodes, ctx, eq(defectCodes.isActive, true)))
        .orderBy(asc(defectCodes.category), asc(defectCodes.label)),
      tx
        .select({ operation: inlineChecks.operation, defects: inlineChecks.defects })
        .from(inlineChecks)
        .where(scoped(inlineChecks, ctx, eq(inlineChecks.lineId, input.lineId)))
        .orderBy(desc(inlineChecks.occurredAt))
        .limit(400),
      tx
        .select({
          id: workers.id,
          name: workers.name,
          designation: workers.designation,
        })
        .from(workers)
        .where(scoped(workers, ctx, and(eq(workers.lineId, input.lineId), eq(workers.status, 'active'))))
        .orderBy(asc(workers.name)),
      tx
        .select({
          id: inlineChecks.id,
          operation: inlineChecks.operation,
          checkedQty: inlineChecks.checkedQty,
          defectQty: inlineChecks.defectQty,
          occurredAt: inlineChecks.occurredAt,
        })
        .from(inlineChecks)
        .where(scoped(inlineChecks, ctx, eq(inlineChecks.lineId, input.lineId)))
        .orderBy(desc(inlineChecks.occurredAt))
        .limit(input.recentLimit ?? 5),
    ])

    const byOperation = new Map<string, number>()
    const byCode = new Map<string, number>()
    for (const row of history) {
      byOperation.set(row.operation, (byOperation.get(row.operation) ?? 0) + 1)
      for (const d of row.defects ?? []) {
        byCode.set(d.code, (byCode.get(d.code) ?? 0) + d.count)
      }
    }

    const operations = [...byOperation.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([operation]) => operation)

    // Categories are ordered by what this line actually reports, commonest first. The
    // alphabetical order the codes come back in puts `stitching` — which is most of every
    // shirt line's defects — below `fabric`, `finishing` and `labelling`, so the tap a QC
    // makes fifty times a shift is the one furthest down the screen.
    const categoryWeight = new Map<string, number>()
    for (const code of codes) {
      const used = byCode.get(code.code) ?? 0
      categoryWeight.set(code.category, (categoryWeight.get(code.category) ?? 0) + used)
    }

    const defects = [...codes].sort((a, b) => {
      const byCategory =
        (categoryWeight.get(b.category) ?? 0) - (categoryWeight.get(a.category) ?? 0)
      if (byCategory !== 0) return byCategory
      if (a.category !== b.category) return a.category.localeCompare(b.category)
      // Within a category, commonest first, then alphabetically so an unused taxonomy is
      // still ordered predictably rather than by insertion.
      const byUse = (byCode.get(b.code) ?? 0) - (byCode.get(a.code) ?? 0)
      return byUse !== 0 ? byUse : a.label.localeCompare(b.label)
    })

    return { defects, operations, operators, recent }
  })
}

export interface InspectableRoll {
  rollId: string
  rollNo: string
  lot: string | null
  shadeGroup: string | null
  qty: string
  unit: string
  itemName: string
  /** Null until somebody inspects it — the roll, or the consignment it came in on. */
  result: 'pass' | 'fail' | null
  pointsPer100SqYd: string | null
  /** True when the verdict was inherited from the GRN rather than this roll's own sheet. */
  inheritedFromGrn: boolean
}

export interface InspectableGrn {
  grnId: string
  challanNo: string
  receivedAt: string
  /** The GRN's own rolled-up status, maintained by `inspectFabric`. */
  inspectionStatus: string
  rolls: InspectableRoll[]
  uninspected: number
  failed: number
}

/**
 * Consignments the inspection frame can work through (canvas P2).
 *
 * Roll-level and GRN-level inspections are both real. An inspector grades a *sample* of a
 * consignment — that is the whole premise of the 4-point system — so a GRN-level sheet
 * covers every roll that came in on it. A roll with its own sheet overrides that, because
 * somebody looked at that specific roll and their answer is better evidence than the
 * average of the delivery.
 *
 * The screen has to show which of the two it is. "Passed" meaning *this roll passed* and
 * "passed" meaning *the delivery it arrived with passed* are different degrees of assurance,
 * and a storekeeper deciding whether to issue against a buyer complaint needs to know which
 * one they are looking at.
 */
export async function inspectableGrns(
  ctx: AnyCtx,
  input: { limit?: number } = {},
): Promise<InspectableGrn[]> {
  const { fabricInspections } = await import('./schema')
  const { grnLines, grns, items, rolls } = await import('@/modules/store/schema')

  return withTenantRead(ctx, async (tx) => {
    const rollRows = await tx
      .select({
        rollId: rolls.id,
        rollNo: rolls.rollNo,
        lot: rolls.lot,
        shadeGroup: rolls.shadeGroup,
        qty: rolls.qty,
        unit: rolls.unit,
        itemName: items.name,
        grnId: grnLines.grnId,
        challanNo: grns.challanNo,
        receivedAt: grns.receivedAt,
        inspectionStatus: grns.inspectionStatus,
      })
      .from(rolls)
      .innerJoin(grnLines, eq(grnLines.id, rolls.grnLineId))
      .innerJoin(grns, eq(grns.id, grnLines.grnId))
      .innerJoin(items, eq(items.id, rolls.itemId))
      // Fabric only — the 4-point system grades cloth by area. Trims and accessories are
      // roll-tracked in this store too, and listing a carton of buttons on an inspection
      // frame screen is how an inspector learns to ignore the list.
      .where(scoped(rolls, ctx, eq(items.kind, 'fabric')))
      .orderBy(desc(grns.receivedAt), asc(rolls.rollNo))

    if (rollRows.length === 0) return []

    const inspections = await tx
      .select({
        grnId: fabricInspections.grnId,
        rollId: fabricInspections.rollId,
        result: fabricInspections.result,
        pointsPer100SqYd: fabricInspections.pointsPer100SqYd,
      })
      .from(fabricInspections)
      .where(scoped(fabricInspections, ctx, inArray(fabricInspections.grnId, [...new Set(rollRows.map((r) => r.grnId))])))

    const byRoll = new Map(inspections.filter((i) => i.rollId).map((i) => [i.rollId!, i]))
    const byGrn = new Map(inspections.filter((i) => !i.rollId).map((i) => [i.grnId, i]))

    const grouped = new Map<string, InspectableGrn>()

    for (const row of rollRows) {
      let group = grouped.get(row.grnId)
      if (!group) {
        group = {
          grnId: row.grnId,
          challanNo: row.challanNo,
          receivedAt: row.receivedAt,
          inspectionStatus: row.inspectionStatus,
          rolls: [],
          uninspected: 0,
          failed: 0,
        }
        grouped.set(row.grnId, group)
      }

      const own = byRoll.get(row.rollId)
      const inherited = own ? null : (byGrn.get(row.grnId) ?? null)
      const inspection = own ?? inherited

      group.rolls.push({
        rollId: row.rollId,
        rollNo: row.rollNo,
        lot: row.lot,
        shadeGroup: row.shadeGroup,
        qty: row.qty,
        unit: row.unit,
        itemName: row.itemName,
        result: (inspection?.result as 'pass' | 'fail' | undefined) ?? null,
        pointsPer100SqYd: inspection?.pointsPer100SqYd ?? null,
        inheritedFromGrn: own === undefined && inherited !== null,
      })

      if (!inspection) group.uninspected += 1
      else if (inspection.result === 'fail') group.failed += 1
    }

    return [...grouped.values()].slice(0, input.limit ?? 12)
  })
}

export interface FinalInspectionLot {
  orderId: string
  orderStyleId: string | null
  poNumber: string | null
  buyerId: string | null
  buyerName: string | null
  styleCode: string | null
  contractedQty: number | null
  /**
   * Pieces actually finished and available to inspect.
   *
   * A final inspection is a sample drawn from a physical lot. The queue used to list every
   * confirmed order — so an order booked ten minutes ago, with nothing cut and nothing sewn,
   * sat there offering "Inspect" beside its 18,000 contracted pieces (order-journey walk,
   * stage 9). An inspector who takes that up is looking for a carton that does not exist.
   *
   * Zero is a real answer and the row stays: the order IS in the queue, it just has nothing
   * in it yet, and saying so is more use than hiding it.
   */
  finishedQty: number
  /** From the buyer's terms. Null means there is no contract to inspect against. */
  majorAql: string | null
  minorAql: string | null
  /** Inspections already filed against this order, newest first. */
  history: {
    id: string
    inspectionNo: string
    lotQty: number
    sampleSize: number
    verdict: string
    criticalFound: number
    majorFound: number
    minorFound: number
    inspectedAt: Date
  }[]
}

/**
 * Orders a final inspection can be run against (canvas P4).
 *
 * The AQL levels come from the BUYER'S TERMS, never from a default. `finalInspectionPayload`
 * refuses to default them for the same reason: an acceptance number the system picked is one
 * nobody agreed to, and it is the number a shipment is accepted or charged back on. An order
 * whose buyer has no terms on file therefore shows as un-inspectable rather than quietly
 * inspected against something plausible.
 */
export async function finalInspectionLots(ctx: AnyCtx): Promise<FinalInspectionLot[]> {
  const { buyers } = await import('@/modules/buyers/schema')
  const { termsFor } = await import('@/modules/buyers/service')
  const { orderStyles, orders } = await import('@/modules/orders/schema')

  const today = factoryToday()

  const rows = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        orderId: orders.id,
        poNumbers: orders.poNumbers,
        buyerId: orders.buyerId,
        buyerName: buyers.name,
        orderStyleId: orderStyles.id,
        styleCode: orderStyles.styleCode,
        contractedQty: orderStyles.contractedQty,
      })
      .from(orders)
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .leftJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(scoped(orders, ctx, inArray(orders.status, ['confirmed', 'in_production', 'shipped_partial']))),
  )

  if (rows.length === 0) return []

  const inspections = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: finalInspections.id,
        orderId: finalInspections.orderId,
        inspectionNo: finalInspections.inspectionNo,
        lotQty: finalInspections.lotQty,
        sampleSize: finalInspections.sampleSize,
        verdict: finalInspections.verdict,
        criticalFound: finalInspections.criticalFound,
        majorFound: finalInspections.majorFound,
        minorFound: finalInspections.minorFound,
        inspectedAt: finalInspections.inspectedAt,
      })
      .from(finalInspections)
      .where(scoped(finalInspections, ctx, 
        inArray(
          finalInspections.orderId,
          rows.map((r) => r.orderId),
        ),
      ))
      .orderBy(desc(finalInspections.inspectedAt)),
  )

  // What is physically finished per order — the lot an inspection would actually be drawn
  // from. One grouped read rather than one per order.
  const { finishingOutputs } = await import('@/modules/shipment/schema')
  const finished = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        orderId: finishingOutputs.orderId,
        qty: sql<string>`coalesce(sum(${finishingOutputs.totalQty}), 0)`,
      })
      .from(finishingOutputs)
      .where(scoped(finishingOutputs, ctx, inArray(finishingOutputs.orderId, rows.map((r) => r.orderId))))
      .groupBy(finishingOutputs.orderId),
  )
  const finishedByOrder = new Map(finished.map((f) => [f.orderId, Number(f.qty)]))

  const lots: FinalInspectionLot[] = []
  for (const row of rows) {
    const terms = row.buyerId
      ? await termsFor(ctx, { buyerId: row.buyerId, onDate: today })
      : null

    lots.push({
      orderId: row.orderId,
      orderStyleId: row.orderStyleId,
      poNumber: (row.poNumbers ?? [])[0] ?? null,
      buyerId: row.buyerId,
      buyerName: row.buyerName,
      styleCode: row.styleCode,
      contractedQty: row.contractedQty,
      finishedQty: finishedByOrder.get(row.orderId) ?? 0,
      majorAql: terms?.aqlLevel ?? null,
      // A buyer who sets only one level is setting the MAJOR one; minor falls back to the
      // common 4.0 pairing rather than to the major level, which would be far stricter than
      // anybody signed for.
      minorAql: terms?.minorAqlLevel ?? (terms?.aqlLevel ? '4.0' : null),
      history: inspections.filter((i) => i.orderId === row.orderId),
    })
  }

  return lots
}

export interface DhuTrendDay {
  date: string
  defects: number
  checked: number
  /** Null on a day nobody checked — never 0, which would read as a perfect day. */
  dhu: string | null
}

/**
 * The factory-wide DHU trend (canvas P5).
 *
 * Aggregated from `dhu_daily` as total defects over total checked, NOT as the mean of the
 * per-line DHUs. Averaging ratios weights a line that checked twelve garments the same as
 * one that checked six hundred, and the twelve-garment line is exactly where a freak number
 * comes from.
 */
export async function dhuTrend(
  ctx: AnyCtx,
  input: { from: string; to: string },
): Promise<DhuTrendDay[]> {
  const rows = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        date: dhuDaily.dhuDate,
        defects: sql<string>`sum(${dhuDaily.defects})::text`,
        checked: sql<string>`sum(${dhuDaily.checked})::text`,
      })
      .from(dhuDaily)
      .where(scoped(dhuDaily, ctx, and(gte(dhuDaily.dhuDate, input.from), lte(dhuDaily.dhuDate, input.to))))
      .groupBy(dhuDaily.dhuDate)
      .orderBy(asc(dhuDaily.dhuDate)),
  )

  const byDate = new Map(rows.map((r) => [r.date, r]))
  const out: DhuTrendDay[] = []

  for (
    let t = Date.parse(`${input.from}T00:00:00Z`);
    t <= Date.parse(`${input.to}T00:00:00Z`);
    t += 86_400_000
  ) {
    const date = new Date(t).toISOString().slice(0, 10)
    const row = byDate.get(date)
    const checked = Number(row?.checked ?? 0)
    const defects = Number(row?.defects ?? 0)
    out.push({
      date,
      defects,
      checked,
      dhu: checked > 0 ? ((defects * 100) / checked).toFixed(2) : null,
    })
  }

  return out
}

export interface ParetoSlice {
  code: string
  label: string
  severity: string
  count: number
  /** Running share of all defects, so the 80% line can be drawn. */
  cumulativePct: string
}

/**
 * Defect Pareto (canvas P5: "80% sits in 4 causes").
 *
 * Ordered by frequency with a running total, because the useful output of a Pareto is not
 * the ranking — it is the short list of causes worth fixing this month. Reading it off a bar
 * chart by eye is how the fifth and sixth causes end up in a corrective action plan that
 * then has six owners and no progress.
 */
export async function defectPareto(
  ctx: AnyCtx,
  input: { from: string; to: string },
): Promise<ParetoSlice[]> {
  const { defectCodes } = await import('./schema')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ defects: inlineChecks.defects })
      .from(inlineChecks)
      .where(scoped(inlineChecks, ctx, and(gte(inlineChecks.checkedOn, input.from), lte(inlineChecks.checkedOn, input.to))))

    const tally = new Map<string, number>()
    for (const row of rows) {
      for (const d of row.defects ?? []) tally.set(d.code, (tally.get(d.code) ?? 0) + d.count)
    }
    if (tally.size === 0) return []

    const codes = await tx
      .select({
        code: defectCodes.code,
        label: defectCodes.label,
        severity: defectCodes.severity,
      })
      .from(defectCodes)
      .where(scoped(defectCodes, ctx, inArray(defectCodes.code, [...tally.keys()])))
    const meta = new Map(codes.map((c) => [c.code, c]))

    // Not `total` — the money-name heuristic reads that stem, and it is right to. These
    // are defect counts.
    const allDefects = [...tally.values()].reduce((sum, n) => sum + n, 0)
    let running = 0

    return [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([code, count]) => {
        running += count
        return {
          code,
          label: meta.get(code)?.label ?? code,
          severity: meta.get(code)?.severity ?? 'minor',
          count,
          cumulativePct: ((running * 100) / allDefects).toFixed(1),
        }
      })
  })
}

export interface SpecPoint {
  name: string
  spec: string
  tolPlus: string
  tolMinus: string
}

export interface MeasurementSubject {
  orderId: string
  poNumber: string | null
  buyerName: string | null
  styleCode: string | null
  specId: string | null
  specVersion: number | null
  unit: string
  points: SpecPoint[]
  /** Sizes already measured against this order, with how many pieces and how many failed. */
  measured: { size: string; pieces: number; failed: number }[]
}

/**
 * Orders a measurement check can be recorded against (canvas P3).
 *
 * The chart is matched by STYLE CODE and the LATEST version wins. Two consequences worth
 * being explicit about: an order whose style has no chart cannot be measured at all — there
 * is nothing to measure against, and inventing tolerances is how a shipment gets rejected on
 * a spec nobody agreed — and a chart approved today governs checks recorded from today, not
 * retrospectively, because each check stores the deviations it was judged on.
 */
export async function measurementSubjects(ctx: AnyCtx): Promise<MeasurementSubject[]> {
  const { buyers } = await import('@/modules/buyers/schema')
  const { orderStyles, orders } = await import('@/modules/orders/schema')
  const { measurementChecks, measurementSpecs } = await import('./schema')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        orderId: orders.id,
        poNumbers: orders.poNumbers,
        buyerName: buyers.name,
        styleCode: orderStyles.styleCode,
      })
      .from(orders)
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .leftJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(scoped(orders, ctx, inArray(orders.status, ['confirmed', 'in_production', 'shipped_partial'])))

    if (rows.length === 0) return []

    const specs = await tx
      .select()
      .from(measurementSpecs)
      .orderBy(desc(measurementSpecs.version))

    const checks = await tx
      .select({
        orderId: measurementChecks.orderId,
        sampledSize: measurementChecks.sampledSize,
        result: measurementChecks.result,
      })
      .from(measurementChecks)
      .where(scoped(measurementChecks, ctx, 
        inArray(
          measurementChecks.orderId,
          rows.map((r) => r.orderId),
        ),
      ))

    return rows.map((row) => {
      // Ordered by version desc above, so the first match is the current chart.
      const spec = row.styleCode ? specs.find((s) => s.styleCode === row.styleCode) : undefined

      const bySize = new Map<string, { size: string; pieces: number; failed: number }>()
      for (const check of checks.filter((c) => c.orderId === row.orderId)) {
        const entry = bySize.get(check.sampledSize) ?? {
          size: check.sampledSize,
          pieces: 0,
          failed: 0,
        }
        entry.pieces += 1
        if (check.result === 'fail') entry.failed += 1
        bySize.set(check.sampledSize, entry)
      }

      return {
        orderId: row.orderId,
        poNumber: (row.poNumbers ?? [])[0] ?? null,
        buyerName: row.buyerName,
        styleCode: row.styleCode,
        specId: spec?.id ?? null,
        specVersion: spec?.version ?? null,
        unit: spec?.unit ?? 'cm',
        points: (spec?.points as SpecPoint[] | undefined) ?? [],
        measured: [...bySize.values()].sort((a, b) => a.size.localeCompare(b.size)),
      }
    })
  })
}

/* ── The measurement chart, as an order's papers show it ──── */

/**
 * The spec a style is measured against, with the last check taken on this order
 * (design canvas, "Style & documents").
 *
 * The chart has been in the database since quality shipped and reached only the QC
 * capture screen — so a merchandiser arguing with a buyer about a rejected fit sample
 * had the buyer's email and no access to the numbers the factory itself measured. Both
 * halves are here because neither is useful alone: a spec without the measurement is a
 * document, and a measurement without the spec is a number.
 *
 * `outOfTolerance` is read from the CHECK, not recomputed. The QC screen derived it at
 * capture against the spec version live at that moment, and re-deriving it here against
 * today's version would silently re-judge a piece under a chart that did not exist when
 * it was measured.
 */
export interface SpecPoint {
  name: string
  spec: string
  tolPlus: string
  tolMinus: string
  /** What the last check on this order measured for this point, if it measured it. */
  measured: string | null
  outOfTolerance: boolean
}

export interface StyleMeasurementChart {
  specId: string
  version: number
  unit: string
  points: SpecPoint[]
  /** The check the `measured` column came from — null when nobody has measured yet. */
  lastCheck: { sampledSize: string; result: string; at: Date; missingPoints: string[] } | null
}

export async function styleMeasurementChart(
  ctx: AnyCtx,
  input: { styleCode: string; orderId: string },
): Promise<StyleMeasurementChart | null> {
  const { measurementChecks, measurementSpecs } = await import('./schema')

  return withTenantRead(ctx, async (tx) => {
    const [spec] = await tx
      .select()
      .from(measurementSpecs)
      .where(scoped(measurementSpecs, ctx, eq(measurementSpecs.styleCode, input.styleCode)))
      .orderBy(desc(measurementSpecs.version))
      .limit(1)

    if (!spec) return null

    const [check] = await tx
      .select()
      .from(measurementChecks)
      .where(
        scoped(
          measurementChecks,
          ctx,
          and(
            eq(measurementChecks.orderId, input.orderId),
            eq(measurementChecks.measurementSpecId, spec.id),
          ),
        ),
      )
      .orderBy(desc(measurementChecks.createdAt))
      .limit(1)

    const values = (check?.values ?? {}) as Record<string, string>
    const failed = new Set(
      ((check?.outOfTolerance ?? []) as { name?: unknown }[])
        .map((entry) => (typeof entry?.name === 'string' ? entry.name : null))
        .filter((name): name is string => name !== null),
    )

    const points = ((spec.points ?? []) as Record<string, unknown>[])
      .map((raw): SpecPoint | null => {
        const name = typeof raw.name === 'string' ? raw.name : null
        if (!name) return null
        return {
          name,
          spec: String(raw.spec ?? ''),
          tolPlus: String(raw.tolPlus ?? ''),
          tolMinus: String(raw.tolMinus ?? ''),
          measured: values[name] ?? null,
          outOfTolerance: failed.has(name),
        }
      })
      .filter((point): point is SpecPoint => point !== null)

    return {
      specId: spec.id,
      version: spec.version,
      unit: spec.unit,
      points,
      lastCheck: check
        ? {
            sampledSize: check.sampledSize,
            result: check.result,
            at: check.createdAt,
            missingPoints: check.missingPoints ?? [],
          }
        : null,
    }
  })
}
