/**
 * 1.5 Costing Studio — service layer ⚖
 *
 * The gate that matters here is the margin floor. A sheet at or above the company's floor
 * is a manager's decision; below it, only the owner can sign. That is not a UI nicety —
 * quoting below the floor is how a factory books a year of work it loses money on, one
 * defensible-looking sheet at a time.
 *
 * Sheets are versioned and immutable once approved. Repricing creates version n+1 and
 * supersedes its predecessor; it never edits it, because the superseded sheet is what
 * some buyer was actually quoted.
 */
import { and, desc, eq } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import {
  computeCostSheet,
  computeScenario,
  CostingError,
  type CostSheetInput,
  type CostSheetResult,
  type ScenarioOverrides,
} from './cost-sheet'
import { COSTING_EVENTS } from './events'
import { bomLines, boms, consumptionTemplates, costSheets } from './schema'
import {
  bomFromTechPackDraft,
  bomSeededFromOrderDraft,
  costSheetSections,
  createCostSheetPayload,
  manualBomPayload,
  scenarioOverrides,
} from './zod'

/** ⚖ — a cost sheet is the number a year of work is priced against. */
registerAuditedTables('cost_sheets')

/**
 * draft → approved → superseded. An approved sheet is never edited: it is what a buyer
 * was quoted, and repricing means a new version.
 */
export const costSheetMachine = defineStateMachine({
  field: 'status',
  initial: 'draft',
  transitions: {
    draft: ['approved', 'superseded'],
    approved: ['superseded'],
    superseded: [],
  },
})

export type CostSheetStatus = (typeof costSheetMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface CostingPolicy {
  marginFloorPct?: string
}

function toComputeInput(sections: unknown): CostSheetInput {
  const parsed = costSheetSections.parse(sections)
  return parsed as CostSheetInput
}

function wrapCostingError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof CostingError) {
      // A malformed sheet is a 422 the merchandiser can act on, not a 500.
      throw new AppError('validation_failed', 'costing.errors.sheet_uncomputable', {
        reason: error.message,
      })
    }
    throw error
  }
}

/**
 * Assemble a draft sheet from a BOM (brief: `buildFromBom`).
 *
 * The BOM supplies consumption and wastage; prices do not come from it, because a bill of
 * materials is what the garment is made of and a cost sheet is what it costs today. The
 * caller supplies rates.
 */
export async function buildFromBom(
  ctx: RequestCtx,
  input: { bomId: string; rates: Record<string, string>; sections: unknown },
): Promise<{ styleCode: string; sections: CostSheetInput }> {
  return withTenantRead(ctx, async (tx) => {
    const [bom] = await tx.select().from(boms).where(scoped(boms, ctx, eq(boms.id, input.bomId)))
    if (!bom) throw notFound('costing.errors.bom_not_found', { bomId: input.bomId })

    const lines = await tx.select().from(bomLines).where(scoped(bomLines, ctx, eq(bomLines.bomId, input.bomId)))
    const base = costSheetSections.parse(input.sections)

    /*
     * Fabric keeps its section; EVERYTHING else prices as a trim.
     *
     * The sheet's sections are fabric / trims / embellishment, but its embellishment rows
     * carry a flat cost-per-piece with no consumption — a BOM line cannot become one
     * without inventing the number this screen exists to make somebody type. A poly bag or
     * a print placement is a per-piece material like any trim, so it lands there, priced
     * at zero until a human rates it. The alternative was what actually happened: the
     * first seeded sheet silently dropped the packing line, and a cost sheet that loses a
     * BOM line quietly is underquoting by exactly that line.
     */
    const material = (group: 'fabric' | 'trims') =>
      lines
        .filter((line) =>
          group === 'fabric' ? line.lineGroup === 'fabric' : line.lineGroup !== 'fabric',
        )
        .map((line) => ({
          ref: line.itemRef ?? line.spec ?? line.id,
          consumption: line.consumption,
          uom: line.uom,
          // A line with no rate supplied is priced at zero and shows as zero — visible,
          // rather than quietly dropped out of the sheet.
          ratePerUom: input.rates[line.itemRef ?? line.id] ?? '0',
          wastagePct: line.wastagePct,
        }))

    return {
      styleCode: bom.styleCode,
      sections: {
        ...base,
        fabric: material('fabric'),
        trims: material('trims'),
      } as CostSheetInput,
    }
  })
}

/** Compute without persisting — the live preview behind every slider. */
export async function previewCostSheet(
  ctx: AnyCtx,
  input: { sections: unknown; overrides?: unknown },
  policy: CostingPolicy = {},
): Promise<CostSheetResult> {
  const sections = toComputeInput(input.sections)
  const overrides = input.overrides
    ? (scenarioOverrides.parse(input.overrides) as ScenarioOverrides)
    : undefined

  void ctx
  return wrapCostingError(() =>
    overrides
      ? computeScenario(sections, overrides, policy)
      : computeCostSheet(sections, policy),
  )
}

/**
 * Create the next version of a sheet for a style.
 *
 * Versioning is per style and monotonic. The previous approved sheet is NOT superseded
 * here — that happens on approval, because a draft that never gets approved must not
 * invalidate the quote currently in force.
 */
export async function createCostSheet(
  ctx: RequestCtx,
  input: unknown,
  policy: CostingPolicy = {},
): Promise<{ sheetId: string; version: number; computed: CostSheetResult }> {
  const payload = createCostSheetPayload.parse(input)
  const sections = payload.sections as CostSheetInput
  const computed = wrapCostingError(() => computeCostSheet(sections, policy))

  return withTenantTx(ctx, async (tx) => {
    const [latest] = await tx
      .select({ version: costSheets.version })
      .from(costSheets)
      .where(scoped(costSheets, ctx, eq(costSheets.styleCode, payload.styleCode)))
      .orderBy(desc(costSheets.version))
      .limit(1)

    const version = (latest?.version ?? 0) + 1

    const [row] = await tx
      .insert(costSheets)
      .values({
        companyId: ctx.companyId,
        bomId: payload.bomId ?? null,
        styleCode: payload.styleCode,
        version,
        sections: sections as unknown as Record<string, unknown>,
        currency: sections.currency,
        localCurrency: sections.localCurrency,
        fxRateLocalToBase: sections.fxRateLocalToBase,
        totalCost: computed.totalCost,
        fobPrice: computed.fobPrice,
        cmLocalPerPiece: computed.sections.cm.localAmount ?? '0',
        marginPct: sections.marginPct,
        achievedMarginPct: computed.achievedMarginPct,
        createdBy: ctx.userId,
      })
      .returning({ id: costSheets.id })

    if (!row) throw new Error('cost_sheets insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'cost_sheets',
      targetId: row.id,
      after: {
        styleCode: payload.styleCode,
        version,
        fobPrice: computed.fobPrice,
        achievedMarginPct: computed.achievedMarginPct,
      },
    })

    return { sheetId: row.id, version, computed }
  })
}

/**
 * Approve a sheet ⚖.
 *
 * **The gate**: at or above the company margin floor, a manager signs. Below it, only the
 * owner can. Enforced here rather than in the approval-routing config, because a floor
 * that lives only in `approval_rules` is a floor somebody can edit their way past.
 *
 * The figures are RECOMPUTED from the stored inputs before approving. A sheet whose
 * stored outputs no longer match its inputs has been tampered with or was written by an
 * older version of this code, and approving it would bless a number nobody can reproduce.
 */
export async function approveCostSheet(
  ctx: RequestCtx,
  input: { sheetId: string },
  policy: CostingPolicy = {},
): Promise<{ sheetId: string; version: number; belowFloor: boolean }> {
  return withTenantTx(ctx, async (tx) => {
    const [sheet] = await tx
      .select()
      .from(costSheets)
      .where(scoped(costSheets, ctx, eq(costSheets.id, input.sheetId)))
      .for('update')

    if (!sheet) throw notFound('costing.errors.sheet_not_found', { sheetId: input.sheetId })

    costSheetMachine.assert(sheet.status as CostSheetStatus, 'approved')

    const computed = wrapCostingError(() =>
      computeCostSheet(toComputeInput(sheet.sections), policy),
    )

    if (computed.fobPrice !== sheet.fobPrice || computed.totalCost !== sheet.totalCost) {
      // Stored outputs disagree with the stored inputs. Refuse rather than approve a
      // figure that cannot be reproduced.
      throw new AppError('conflict', 'costing.errors.sheet_stale', {
        storedFob: sheet.fobPrice,
        recomputedFob: computed.fobPrice,
      })
    }

    if (computed.belowMarginFloor && !ctx.roles.includes('owner')) {
      throw new AppError('forbidden', 'costing.errors.below_floor_needs_owner', {
        achievedMarginPct: computed.achievedMarginPct,
        floorPct: policy.marginFloorPct ?? null,
      })
    }

    // Supersede the sheet currently in force for this style — on APPROVAL, not on draft
    // creation, so an abandoned draft never invalidates a live quote.
    const superseded = await tx
      .update(costSheets)
      .set({ status: 'superseded', updatedAt: new Date() })
      .where(scoped(costSheets, ctx, 
        and(eq(costSheets.styleCode, sheet.styleCode), eq(costSheets.status, 'approved')),
      ))
      .returning({ id: costSheets.id })

    await tx
      .update(costSheets)
      .set({
        status: 'approved',
        approvedBy: ctx.userId,
        approvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(scoped(costSheets, ctx, eq(costSheets.id, sheet.id)))

    await recordChange(ctx, tx, {
      action: 'approve',
      targetTable: 'cost_sheets',
      targetId: sheet.id,
      before: { status: sheet.status },
      after: {
        status: 'approved',
        approvedBy: ctx.userId,
        belowFloor: computed.belowMarginFloor,
        supersededCount: superseded.length,
      },
    })

    await emit(ctx, tx, {
      eventName: COSTING_EVENTS.sheetApproved,
      payload: {
        sheetId: sheet.id,
        styleCode: sheet.styleCode,
        version: sheet.version,
        fobPrice: sheet.fobPrice,
        currency: sheet.currency,
      },
      aggregateTable: 'cost_sheets',
      aggregateId: sheet.id,
    })

    if (computed.belowMarginFloor) {
      // The owner knowingly signed below the floor. Worth its own event so the owner
      // digest and any later margin review both see it without digging.
      await emit(ctx, tx, {
        eventName: COSTING_EVENTS.belowFloorApproved,
        payload: {
          sheetId: sheet.id,
          styleCode: sheet.styleCode,
          achievedMarginPct: computed.achievedMarginPct,
          floorPct: policy.marginFloorPct ?? null,
          approvedBy: ctx.userId,
        },
        aggregateTable: 'cost_sheets',
        aggregateId: sheet.id,
      })
    }

    return { sheetId: sheet.id, version: sheet.version, belowFloor: computed.belowMarginFloor }
  })
}

/** The sheet currently in force for a style — what 1.2 quotes and 3.1 requisitions from. */
export async function getApprovedSheet(
  ctx: AnyCtx,
  styleCode: string,
): Promise<typeof costSheets.$inferSelect> {
  const sheet = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(costSheets)
      .where(scoped(costSheets, ctx, and(eq(costSheets.styleCode, styleCode), eq(costSheets.status, 'approved'))))
      .orderBy(desc(costSheets.version))
      .limit(1)
    return row
  })

  if (!sheet) throw notFound('costing.errors.no_approved_sheet', { styleCode })
  return sheet
}

/** Bump usage so the staleness report can tell a live template from a forgotten one. */
export async function touchTemplate(ctx: RequestCtx, productType: string): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(consumptionTemplates)
      .where(scoped(consumptionTemplates, ctx, eq(consumptionTemplates.productType, productType)))

    if (!row) throw notFound('costing.errors.template_not_found', { productType })

    await tx
      .update(consumptionTemplates)
      .set({ usageCount: row.usageCount + 1, updatedAt: new Date() })
      .where(scoped(consumptionTemplates, ctx, eq(consumptionTemplates.id, row.id)))
  })
}

export { conflict }

/**
 * Commit an approved BOM draft — the module's own write for its one pending target.
 *
 * `boms` was registered as a pending target with no handler, which meant an approved draft
 * took core's generic single-row write: an insert of camelCase payload keys into a table
 * whose columns are snake_case, and no `bom_lines` at all. A BOM is a parent and its lines;
 * there is no version of "generic single-row write" that can express one.
 *
 * Two payload shapes land here. They are told apart by `fromOrderId`, which only a seeded
 * draft carries and which is the one thing a reviewer will want to know about those numbers.
 */
export async function commitBom(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const seeded = 'fromOrderId' in input.payload

  // Re-validated at approve time against the schema as it stands today (PLAYBOOK §3), not
  // trusted from whenever the draft was written.
  const payload = seeded
    ? bomSeededFromOrderDraft.parse(input.payload)
    : bomFromTechPackDraft.parse(input.payload)

  /*
   * A material line has to consume something.
   *
   * `bom_lines_consumption_positive` has said so since 0021, and the extractor is allowed to
   * return zero on purpose: a tech pack routinely states no consumption for sew thread,
   * which is derived from stitch length rather than printed. The draft carrying that zero is
   * honest. COMMITTING it is not — and the constraint refused it as a raw Postgres error, at
   * the moment a manager pressed Approve, quoting an INSERT statement at them (live test).
   *
   * So the refusal happens here, in words, naming the lines that need a number. What the
   * reviewer does about it is supply one: the draft can be edited before it is approved,
   * which is the door that made this refusal actionable rather than a dead end.
   */
  const unquantified = payload.lines.filter((line) => Number(line.consumption) <= 0)
  if (unquantified.length > 0) {
    throw new AppError('validation_failed', 'costing.errors.bom_line_no_consumption', {
      lines: unquantified.map((line) => line.itemRef ?? line.spec ?? line.lineGroup),
    })
  }

  const bomId = await insertBomIn(ctx, tx, {
    styleCode: payload.styleCode,
    source: seeded ? 'seeded' : 'tech_pack_extract',
    sourceDocumentId: 'sourceDocumentId' in payload ? (payload.sourceDocumentId ?? null) : null,
    lines: payload.lines.map((line) => ({
      ...line,
      // A tech-pack line is an estimate by definition; a seeded line says for itself.
      consumptionBasis: 'consumptionBasis' in line ? line.consumptionBasis : 'planned',
      sourcePage: 'sourcePage' in line ? (line.sourcePage ?? null) : null,
    })),
  })

  return {
    rowId: bomId,
    after: { bomId, styleCode: payload.styleCode, lineCount: payload.lines.length },
  }
}

/**
 * Build a bill of materials by hand.
 *
 * The third way a BOM arrives, alongside a tech-pack extraction and a seed from a past
 * order — and the one every factory falls back on, because the tech pack is a PDF of a
 * scan and the style has never been made before.
 *
 * Every line is written as `planned`. A consumption somebody typed is an estimate however
 * confident they are, and `actual` means "measured against what was issued on a real
 * order" — which 1.6 reads as evidence when it seeds the next quote.
 */
export async function createBom(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ bomId: string; lineCount: number }> {
  const payload = manualBomPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const bomId = await insertBomIn(ctx, tx, {
      styleCode: payload.styleCode,
      source: 'manual',
      sourceDocumentId: null,
      lines: payload.lines.map((line) => ({
        ...line,
        consumptionBasis: 'planned' as const,
        sourcePage: null,
      })),
    })

    return { bomId, lineCount: payload.lines.length }
  })
}

/**
 * The one place a BOM and its lines are written.
 *
 * Shared by the manual builder and the approve-inbox commit rather than duplicated. A BOM
 * is a parent AND its lines; two copies of that insert is two places for the line write to
 * be forgotten, and a BOM with no lines reads as a style that needs no materials.
 */
async function insertBomIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: {
    styleCode: string
    source: 'manual' | 'seeded' | 'tech_pack_extract'
    sourceDocumentId: string | null
    lines: readonly {
      lineGroup: 'fabric' | 'trims' | 'packing' | 'embellishment'
      itemRef?: string | undefined
      spec?: string | undefined
      consumption: string
      uom: string
      wastagePct: string
      consumptionBasis: 'planned' | 'actual'
      sourcePage: number | null
    }[]
  },
): Promise<string> {
  const [bom] = await tx
    .insert(boms)
    .values({
      companyId: ctx.companyId,
      styleCode: input.styleCode,
      source: input.source,
      sourceDocumentId: input.sourceDocumentId,
      createdBy: ctx.userId,
    })
    .returning({ id: boms.id })

  if (!bom) throw new Error('boms insert returned nothing')

  for (const line of input.lines) {
    await tx.insert(bomLines).values({
      companyId: ctx.companyId,
      bomId: bom.id,
      lineGroup: line.lineGroup,
      itemRef: line.itemRef ?? null,
      spec: line.spec ?? null,
      consumption: line.consumption,
      consumptionBasis: line.consumptionBasis,
      uom: line.uom,
      wastagePct: line.wastagePct,
      sourcePage: line.sourcePage,
    })
  }

  return bom.id
}

