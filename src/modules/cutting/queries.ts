/**
 * Read models for the cutting floor.
 *
 * Cutting is gated twice on purpose (rule 8): the buyer's PP sample must be
 * approved, and the fabric must actually have been issued to this order. Both
 * gates are server-side and fail CLOSED, so this file reports gate state
 * honestly rather than pre-emptively hiding the action — a disabled button
 * teaches nobody why they cannot cut.
 */
import { and, asc, desc, eq, inArray } from 'drizzle-orm'

import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderStyles, orders } from '@/modules/orders/schema'

import { bundles, cutReports, lays, markers } from './schema'

export interface LayRow {
  id: string
  /** A human-assigned identifier like "L-0142", not a counter. */
  layNo: string
  color: string
  plies: number
  layLengthMeters: string | null
  fabricDrawnMeters: string | null
  status: string
  offlineKey: string | null
  createdAt: Date
  orderId: string
  poNumber: string | null
  styleCode: string | null
  /** Pieces reported cut off this lay, and how many bundles were generated. */
  reportedPieces: number | null
  bundleCount: number
}

/**
 * Total pieces on a cut report.
 *
 * `cut_reports.cells` is a MAP of `"Colour|Size" → qty` — that is what the schema declares,
 * what `zod` validates and what the service writes. This read treated it as an ARRAY of
 * `{ qty }` objects, so `Array.isArray` was false on every row, the sum ran over an empty
 * list, and the cutting queue showed `0 cut` against every lay that had in fact been cut.
 * A supervisor reading that screen would see a lay that produced six hundred pieces
 * reported as having produced none.
 *
 * Non-numeric values are skipped rather than coerced: a cell that is not a number is bad
 * data, and `Number(undefined)` quietly contributing NaN to a piece count is worse than
 * leaving it out.
 */
function sumCells(cells: unknown): number {
  if (typeof cells !== 'object' || cells === null || Array.isArray(cells)) return 0
  // Garments are an INTEGER count, not money — the lint rule matches on the name. Summing
  // pieces is exact; there is no decimal to lose.
  return Object.values(cells as Record<string, unknown>).reduce<number>(
    // eslint-disable-next-line fabricxai/no-float-money
    (total, qty) => total + (typeof qty === 'number' && Number.isFinite(qty) ? qty : 0),
    0,
  )
}

export async function recentLays(ctx: AnyCtx, limit = 40): Promise<LayRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: lays.id,
        layNo: lays.layNo,
        color: lays.color,
        plies: lays.plies,
        layLengthMeters: lays.layLengthMeters,
        fabricDrawnMeters: lays.fabricDrawnMeters,
        status: lays.status,
        offlineKey: lays.offlineKey,
        createdAt: lays.createdAt,
        orderId: lays.orderId,
        orderStyleId: lays.orderStyleId,
      })
      .from(lays)
      .orderBy(desc(lays.createdAt))
      .limit(limit)

    if (rows.length === 0) return []

    const layIds = rows.map((r) => r.id)
    const orderIds = [...new Set(rows.map((r) => r.orderId))]

    const [reports, bundleRows, orderRows, styleRows] = await Promise.all([
      tx
        .select({ layId: cutReports.layId, id: cutReports.id, cells: cutReports.cells })
        .from(cutReports)
        .where(scoped(cutReports, ctx, inArray(cutReports.layId, layIds))),
      tx.select({ cutReportId: bundles.cutReportId }).from(bundles),
      tx
        .select({ id: orders.id, poNumbers: orders.poNumbers })
        .from(orders)
        .where(scoped(orders, ctx, inArray(orders.id, orderIds))),
      tx
        .select({ id: orderStyles.id, styleCode: orderStyles.styleCode })
        .from(orderStyles)
        .where(scoped(orderStyles, ctx, 
          inArray(orderStyles.id, [...new Set(rows.map((r) => r.orderStyleId).filter(Boolean))]),
        )),
    ])

    return rows.map((r): LayRow => {
      const report = reports.find((x) => x.layId === r.id) ?? null

      return {
        id: r.id,
        layNo: r.layNo,
        color: r.color,
        plies: r.plies,
        layLengthMeters: r.layLengthMeters,
        fabricDrawnMeters: r.fabricDrawnMeters,
        status: r.status,
        offlineKey: r.offlineKey,
        createdAt: r.createdAt,
        orderId: r.orderId,
        poNumber: orderRows.find((o) => o.id === r.orderId)?.poNumbers?.[0] ?? null,
        styleCode: styleRows.find((s) => s.id === r.orderStyleId)?.styleCode ?? null,
        // Null when no report exists yet — a lay spread but not yet reported has
        // produced an unknown number of pieces, not zero.
        reportedPieces: report ? sumCells(report.cells) : null,
        bundleCount: report ? bundleRows.filter((b) => b.cutReportId === report.id).length : 0,
      }
    })
  })
}

/** Orders with a style, for the "what can I cut" list. */
export async function cuttableOrders(
  ctx: AnyCtx,
): Promise<{ orderId: string; orderStyleId: string; poNumber: string | null; styleCode: string }[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        orderId: orders.id,
        poNumbers: orders.poNumbers,
        orderStyleId: orderStyles.id,
        styleCode: orderStyles.styleCode,
      })
      .from(orders)
      .innerJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(scoped(orders, ctx, inArray(orders.status, ['confirmed', 'in_production'])))
      .orderBy(asc(orders.plannedExFactoryDate))

    return rows.map((r) => ({
      orderId: r.orderId,
      orderStyleId: r.orderStyleId,
      poNumber: r.poNumbers?.[0] ?? null,
      styleCode: r.styleCode,
    }))
  })
}

/**
 * Rolls the store has actually issued against this order — the only rolls a lay may draw.
 *
 * The issued-fabric gate refuses a lay whose rolls were never issued to the order, which is
 * correct and also invisible: a cutter picking from a list of every roll in the building
 * would hit that refusal after choosing. So the picker is built from the gate's own source,
 * and the rolls it offers are exactly the ones the gate will accept.
 */
export interface IssuedRoll {
  rollId: string
  rollNo: string
  shadeGroup: string | null
  dyeLot: string | null
  qty: string
  unit: string
  itemCode: string
  /** Already consumed by an earlier lay on this order. */
  usedByLay: string | null
  /**
   * The roll's own latest 4-point verdict, when quality has graded it.
   *
   * Carried so the picker can SAY so. The gate refuses a failed roll at create (F39), and a
   * refusal a cutting master could have seen coming is a worse refusal than one that
   * explains itself on the card they are about to tap.
   */
  inspection: 'pass' | 'fail' | null
  inspectionPoints: string | null
}

export async function issuedRollsForOrder(ctx: AnyCtx, orderId: string): Promise<IssuedRoll[]> {
  const { issueLines, issues, items, rolls } = await import('@/modules/store/schema')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        rollId: issueLines.rollId,
        rollNo: rolls.rollNo,
        shadeGroup: rolls.shadeGroup,
        dyeLot: rolls.dyeLot,
        qty: issueLines.qty,
        unit: issueLines.unit,
        itemCode: items.code,
      })
      .from(issueLines)
      .innerJoin(issues, eq(issues.id, issueLines.issueId))
      .innerJoin(rolls, eq(rolls.id, issueLines.rollId))
      .innerJoin(items, eq(items.id, issueLines.itemId))
      .where(scoped(issueLines, ctx, eq(issues.orderId, orderId)))

    /*
     * What quality said about each roll, latest verdict wins — a re-inspection after a mill
     * claim is the answer that counts, the same rule the store's gate applies.
     */
    const { fabricInspections } = await import('@/modules/quality/schema')
    const rollIds = rows.map((row) => row.rollId).filter((id): id is string => id !== null)
    const verdicts = rollIds.length
      ? await tx
          .select({
            rollId: fabricInspections.rollId,
            result: fabricInspections.result,
            points: fabricInspections.pointsPer100SqYd,
            createdAt: fabricInspections.createdAt,
          })
          .from(fabricInspections)
          .where(scoped(fabricInspections, ctx, inArray(fabricInspections.rollId, rollIds)))
          .orderBy(asc(fabricInspections.createdAt))
      : []

    // Ascending, so the last write for a roll is the one left in the map.
    const graded = new Map<string, { result: string; points: string | null }>()
    for (const v of verdicts) {
      if (v.rollId) graded.set(v.rollId, { result: v.result, points: v.points })
    }

    // A roll drawn by one lay cannot be drawn by another — the fabric is on the table.
    const spread = await tx
      .select({ layNo: lays.layNo, rollsDrawn: lays.rollsDrawn })
      .from(lays)
      .where(scoped(lays, ctx, eq(lays.orderId, orderId)))

    const usedBy = new Map<string, string>()
    for (const lay of spread) {
      for (const rollId of lay.rollsDrawn ?? []) usedBy.set(rollId, lay.layNo)
    }

    return rows
      .filter((row): row is typeof row & { rollId: string } => row.rollId !== null)
      .map((row) => ({
        ...row,
        usedByLay: usedBy.get(row.rollId) ?? null,
        inspection: (graded.get(row.rollId)?.result ?? null) as 'pass' | 'fail' | null,
        inspectionPoints: graded.get(row.rollId)?.points ?? null,
      }))
  })
}

/**
 * Everything the cut-report screen needs for one lay (canvas P3).
 *
 * The screen's whole job is "cut against plan", and that comparison needs three numbers per
 * cell that come from three different places: the marker says what the lay SHOULD yield
 * (plies × ratio), the buyer's breakdown says what the order needs, and earlier reports say
 * what has already been cut. Fetching them separately in the page would make the grid's
 * arithmetic the page's problem; here they arrive aligned.
 */
export interface ReportCell {
  size: string
  /** plies × the marker's ratio for this size — what this lay should produce. */
  expected: number
  /** The buyer's breakdown for this colour and size, at the active revision. */
  ordered: number
  /** Already reported on earlier lays of this style and colour. */
  alreadyCut: number
}

export interface LayForReport {
  layId: string
  layNo: string
  color: string
  plies: number
  status: string
  markerCode: string
  orderStyleId: string
  poNumber: string | null
  styleCode: string
  cells: ReportCell[]
}

export async function layForReport(ctx: AnyCtx, layId: string): Promise<LayForReport | null> {
  const { orderBreakdowns, orderStyles } = await import('@/modules/orders/schema')

  return withTenantRead(ctx, async (tx) => {
    const [lay] = await tx
      .select({
        id: lays.id,
        layNo: lays.layNo,
        color: lays.color,
        plies: lays.plies,
        status: lays.status,
        orderId: lays.orderId,
        orderStyleId: lays.orderStyleId,
        markerCode: markers.code,
        sizeRatio: markers.sizeRatio,
      })
      .from(lays)
      .innerJoin(markers, eq(markers.id, lays.markerId))
      .where(scoped(lays, ctx, eq(lays.id, layId)))

    if (!lay) return null

    const [style] = await tx
      .select({ styleCode: orderStyles.styleCode, activeRevision: orderStyles.activeRevision })
      .from(orderStyles)
      .where(scoped(orderStyles, ctx, eq(orderStyles.id, lay.orderStyleId)))

    const [order] = await tx
      .select({ poNumbers: orders.poNumbers })
      .from(orders)
      .where(scoped(orders, ctx, eq(orders.id, lay.orderId)))

    const breakdown = style
      ? await tx
          .select({ size: orderBreakdowns.size, qty: orderBreakdowns.qty })
          .from(orderBreakdowns)
          .where(scoped(orderBreakdowns, ctx, 
            and(
              eq(orderBreakdowns.orderStyleId, lay.orderStyleId),
              eq(orderBreakdowns.revision, style.activeRevision),
              eq(orderBreakdowns.color, lay.color),
            ),
          ))
      : []

    // What earlier lays of this style and colour already reported, per size.
    const priorReports = await tx
      .select({ cells: cutReports.cells, layColor: lays.color })
      .from(cutReports)
      .innerJoin(lays, eq(lays.id, cutReports.layId))
      .where(scoped(cutReports, ctx, and(eq(lays.orderStyleId, lay.orderStyleId), eq(lays.color, lay.color))))

    const alreadyCut = new Map<string, number>()
    for (const report of priorReports) {
      for (const [cell, qty] of Object.entries(report.cells ?? {})) {
        // Keyed "Colour|Size" — the one separator `cutting/zod.ts` accepts.
        const size = cell.split('|')[1] ?? cell
        if (typeof qty === 'number') {
          alreadyCut.set(size, (alreadyCut.get(size) ?? 0) + qty)
        }
      }
    }

    const orderedBySize = new Map(breakdown.map((b) => [b.size, b.qty]))
    const sizes = [...new Set([...Object.keys(lay.sizeRatio), ...orderedBySize.keys()])]

    return {
      layId: lay.id,
      layNo: lay.layNo,
      color: lay.color,
      plies: lay.plies,
      status: lay.status,
      markerCode: lay.markerCode,
      orderStyleId: lay.orderStyleId,
      poNumber: order?.poNumbers?.[0] ?? null,
      styleCode: style?.styleCode ?? '',
      cells: sizes.map((size) => ({
        size,
        expected: (lay.sizeRatio[size] ?? 0) * lay.plies,
        ordered: orderedBySize.get(size) ?? 0,
        alreadyCut: alreadyCut.get(size) ?? 0,
      })),
    }
  })
}
