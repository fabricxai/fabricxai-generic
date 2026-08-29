/**
 * 1.5 read models.
 *
 * Cross-module reads go through here rather than through another module's tables
 * (CLAUDE.md rule 11). Costing owns `boms` and `bom_lines`; module 3.1 reads consumption
 * from this file and never touches those tables.
 *
 * Screen-shaped reads get added when HANDOFF-1.5 lands; what is here is the contract other
 * modules already depend on.
 */
import { desc, eq, and, sql } from 'drizzle-orm'

import type { AnyCtx } from '../core/ctx'
import { notFound } from '../core/errors'
import { scoped } from '../core/scoped'
import { withTenantRead } from '../core/tenancy'

import { bomLines, boms, costSheets } from './schema'

export interface RequisitionConsumptionLine {
  itemRef: string
  /** At the BOM's own precision — four places. The caller rounds the RESULT, not this. */
  consumptionPerPiece: string
  unit: string
  wastagePct: string
}

/**
 * What one garment consumes, for sizing an order's requisition (brief §Feeds → 1.3/3.1).
 *
 * Returns consumption at full BOM precision deliberately. Rounding here would lose
 * 2.3 metres per thousand garments on a 1.4523 m consumption — the caller multiplies by
 * the order quantity first and rounds once at the end.
 */
export async function getRequisitionConsumption(
  ctx: AnyCtx,
  bomId: string,
): Promise<RequisitionConsumptionLine[]> {
  return withTenantRead(ctx, async (tx) => {
    const lines = await tx.select().from(bomLines).where(scoped(bomLines, ctx, eq(bomLines.bomId, bomId)))
    if (lines.length === 0) throw notFound('costing.errors.bom_not_found', { bomId })

    return lines.map((line) => ({
      itemRef: line.itemRef ?? line.id,
      consumptionPerPiece: line.consumption,
      unit: line.uom,
      wastagePct: line.wastagePct,
    }))
  })
}

/** The BOM behind a style's live cost sheet — how 3.1 gets from an order to consumption. */
export async function getBomForStyle(
  ctx: AnyCtx,
  styleCode: string,
): Promise<{ bomId: string; sheetVersion: number }> {
  return withTenantRead(ctx, async (tx) => {
    const [sheet] = await tx
      .select()
      .from(costSheets)
      .where(scoped(costSheets, ctx, and(eq(costSheets.styleCode, styleCode), eq(costSheets.status, 'approved'))))
      .orderBy(desc(costSheets.version))
      .limit(1)

    if (!sheet?.bomId) {
      // An approved sheet with no BOM cannot size a requisition. Say which, rather than
      // returning an empty list that reads as "this style needs nothing".
      throw notFound('costing.errors.no_bom_for_style', { styleCode })
    }

    const [bom] = await tx.select().from(boms).where(scoped(boms, ctx, eq(boms.id, sheet.bomId)))
    if (!bom) throw notFound('costing.errors.bom_not_found', { bomId: sheet.bomId })

    return { bomId: bom.id, sheetVersion: sheet.version }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The BOM library
// ─────────────────────────────────────────────────────────────────────────────

export interface BomSummary {
  id: string
  styleCode: string
  source: string
  lineCount: number
  /** True when any line's consumption was measured on a real order, not estimated. */
  hasMeasured: boolean
  createdAt: Date
  /** Set when an approved cost sheet is costed against this BOM. */
  usedByApprovedSheet: boolean
}

/**
 * Every BOM in the factory, newest first.
 *
 * `hasMeasured` and `usedByApprovedSheet` are carried because they are the two questions a
 * merchandiser opening this list is actually asking: is this a guess or a record, and is it
 * the one a live quote rests on. Neither is derivable from the style code, and both change
 * what somebody does next.
 */
export async function bomLibrary(ctx: AnyCtx, limit = 100): Promise<BomSummary[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: boms.id,
        styleCode: boms.styleCode,
        source: boms.source,
        createdAt: boms.createdAt,
        lineCount: sql<number>`count(distinct ${bomLines.id})`.mapWith(Number),
        measured: sql<number>`count(distinct ${bomLines.id}) filter (
          where ${bomLines.consumptionBasis} = 'actual'
        )`.mapWith(Number),
        approvedSheets: sql<number>`count(distinct ${costSheets.id}) filter (
          where ${costSheets.status} = 'approved'
        )`.mapWith(Number),
      })
      .from(boms)
      .leftJoin(bomLines, eq(bomLines.bomId, boms.id))
      .leftJoin(costSheets, eq(costSheets.bomId, boms.id))
      .groupBy(boms.id)
      .orderBy(desc(boms.createdAt))
      .limit(limit)

    return rows.map((row) => ({
      id: row.id,
      styleCode: row.styleCode,
      source: row.source,
      lineCount: row.lineCount,
      hasMeasured: row.measured > 0,
      createdAt: row.createdAt,
      usedByApprovedSheet: row.approvedSheets > 0,
    }))
  })
}

export interface BomDetailLine {
  id: string
  lineGroup: string
  itemRef: string | null
  spec: string | null
  consumption: string
  consumptionBasis: string
  uom: string
  wastagePct: string
  sourcePage: number | null
}

/** One BOM and its lines, in the order a person reads them: fabric, then everything else. */
export async function bomDetail(
  ctx: AnyCtx,
  bomId: string,
): Promise<{ bom: BomSummary; lines: BomDetailLine[] } | null> {
  return withTenantRead(ctx, async (tx) => {
    const [bom] = await tx.select().from(boms).where(scoped(boms, ctx, eq(boms.id, bomId)))
    if (!bom) return null

    const lines = await tx
      .select()
      .from(bomLines)
      .where(scoped(bomLines, ctx, eq(bomLines.bomId, bomId)))
      // Fabric first: it is most of the cost and the first thing anybody checks.
      .orderBy(
        sql`case ${bomLines.lineGroup}
              when 'fabric' then 0 when 'trims' then 1
              when 'embellishment' then 2 else 3 end`,
        bomLines.itemRef,
      )

    const [usage] = await tx
      .select({ id: costSheets.id })
      .from(costSheets)
      .where(scoped(costSheets, ctx, and(eq(costSheets.bomId, bomId), eq(costSheets.status, 'approved'))))
      .limit(1)

    return {
      bom: {
        id: bom.id,
        styleCode: bom.styleCode,
        source: bom.source,
        lineCount: lines.length,
        hasMeasured: lines.some((l) => l.consumptionBasis === 'actual'),
        createdAt: bom.createdAt,
        usedByApprovedSheet: usage !== undefined,
      },
      lines: lines.map((l) => ({
        id: l.id,
        lineGroup: l.lineGroup,
        itemRef: l.itemRef,
        spec: l.spec,
        consumption: l.consumption,
        consumptionBasis: l.consumptionBasis,
        uom: l.uom,
        wastagePct: l.wastagePct,
        sourcePage: l.sourcePage,
      })),
    }
  })
}

/**
 * The BOM behind a style, for a screen rather than for a requisition (design canvas,
 * "Style & documents").
 *
 * `getBomForStyle` throws when a style has no approved sheet, which is right for the
 * requisition path — sizing an order against a guess is how a factory buys the wrong
 * quantity of fabric. It is wrong for a dossier: a style being quoted has no approved
 * sheet yet, and a merchandiser opening its papers should be told that in a sentence, not
 * met with a not-found.
 *
 * So this returns null instead, and prefers the approved sheet's BOM when one exists,
 * falling back to the newest BOM for the style. `approved` travels with the answer,
 * because "these are the numbers a live quote rests on" and "somebody extracted this from
 * a tech pack last week" are different claims and the screen must not make them look the
 * same.
 */
export async function styleBom(
  ctx: AnyCtx,
  styleCode: string,
): Promise<{ bomId: string; approved: boolean; sheetVersion: number | null; lines: BomDetailLine[] } | null> {
  return withTenantRead(ctx, async (tx) => {
    const [sheet] = await tx
      .select({ bomId: costSheets.bomId, version: costSheets.version })
      .from(costSheets)
      .where(
        scoped(
          costSheets,
          ctx,
          and(eq(costSheets.styleCode, styleCode), eq(costSheets.status, 'approved')),
        ),
      )
      .orderBy(desc(costSheets.version))
      .limit(1)

    let bomId = sheet?.bomId ?? null
    if (!bomId) {
      const [bom] = await tx
        .select({ id: boms.id })
        .from(boms)
        .where(scoped(boms, ctx, eq(boms.styleCode, styleCode)))
        .orderBy(desc(boms.createdAt))
        .limit(1)
      bomId = bom?.id ?? null
    }

    if (!bomId) return null

    const lines = await tx
      .select()
      .from(bomLines)
      .where(scoped(bomLines, ctx, eq(bomLines.bomId, bomId)))
      // Fabric first: it is most of the cost and the first thing anybody checks.
      .orderBy(
        sql`case ${bomLines.lineGroup}
              when 'fabric' then 0 when 'trims' then 1
              when 'embellishment' then 2 else 3 end`,
        bomLines.itemRef,
      )

    return {
      bomId,
      approved: Boolean(sheet?.bomId),
      sheetVersion: sheet?.version ?? null,
      lines: lines.map((l) => ({
        id: l.id,
        lineGroup: l.lineGroup,
        itemRef: l.itemRef,
        spec: l.spec,
        consumption: l.consumption,
        consumptionBasis: l.consumptionBasis,
        uom: l.uom,
        wastagePct: l.wastagePct,
        sourcePage: l.sourcePage,
      })),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The costing that stands behind an order
// ─────────────────────────────────────────────────────────────────────────────

export interface StyleCostSheet {
  id: string
  version: number
  status: 'draft' | 'approved' | 'superseded'
  fobPrice: string
  currency: string
  cmLocalPerPiece: string
  localCurrency: string
  achievedMarginPct: string
  approvedAt: Date | null
}

/**
 * The latest cost sheet for a style, approved or not.
 *
 * `styleBom` above answers "what is it made of" and deliberately prefers an APPROVED
 * sheet. This answers a different question — "has anybody costed this, and did it get
 * signed off" — so it must return the draft too. A style being quoted with an unapproved
 * sheet is exactly the state the order's sign-off panel exists to make visible; hiding it
 * would show an empty row that reads as "no costing", which is a different and much less
 * alarming fact.
 */
export async function costSheetForStyle(
  ctx: AnyCtx,
  styleCode: string,
): Promise<StyleCostSheet | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        id: costSheets.id,
        version: costSheets.version,
        status: costSheets.status,
        fobPrice: costSheets.fobPrice,
        currency: costSheets.currency,
        cmLocalPerPiece: costSheets.cmLocalPerPiece,
        localCurrency: costSheets.localCurrency,
        achievedMarginPct: costSheets.achievedMarginPct,
        approvedAt: costSheets.approvedAt,
      })
      .from(costSheets)
      .where(scoped(costSheets, ctx, eq(costSheets.styleCode, styleCode)))
      .orderBy(desc(costSheets.version))
      .limit(1)

    return row ?? null
  })
}
