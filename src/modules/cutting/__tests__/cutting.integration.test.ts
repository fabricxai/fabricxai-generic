/**
 * 5.1 integration.
 *
 * The arithmetic is covered by `cutting.test.ts`. What is asserted here is what only a
 * database and a gate can be wrong about:
 *
 *  - BOTH preconditions on lay create actually block, and block for the right reason;
 *  - the gate fails CLOSED when 1.4 has not registered a PP provider;
 *  - a report records which breakdown revision it was judged against, and a later
 *    revision does not rewrite history;
 *  - a replayed offline batch changes no row count;
 *  - bundles are generated once, and cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { syncBatch } from '@/modules/core/offline-sync'
import {
  registerFabricInspectionProvider,
  resetFabricInspectionProvider,
} from '@/modules/store/gates'
import { withTenantRead } from '@/modules/core/tenancy'
import '@/modules/cutting/register'
import {
  registerPpApprovalProvider,
  resetPpApprovalProvider,
} from '@/modules/cutting/gates'
import { bundles, cutReports, lays, markers } from '@/modules/cutting/schema'
import {
  createLay,
  createMarker,
  cutPosition,
  generateBundles,
  recomputeWastage,
  recordCutReport,
  scanBundle,
} from '@/modules/cutting/service'
import { orderBreakdowns, orders, orderStyles } from '@/modules/orders/schema'
import { grnLines, grns, issueLines, issues, items, locations, rolls } from '@/modules/store/schema'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `cut-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['production'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['production'] }

const POLICY = { tolerancePct: '2', wastageAlertPct: '5' }

let orderId: string
let orderStyleId: string
let markerId: string
let rollIds: string[] = []
/** Issued to a DIFFERENT order — the negative case for the fabric gate. */
let strayRollId: string

const allowPp = () => registerPpApprovalProvider(async () => ({ passed: true }))

/*
 * The gate seam fails CLOSED with no provider, so a suite that never registers one would
 * refuse every lay it spreads. The store's suite does the same thing for the same reason.
 */
const allowFabric = () => registerFabricInspectionProvider(async () => ({ passed: true }))

beforeAll(async () => {
  allowFabric()
  await db.insert(companies).values([
    { id: COMPANY, name: 'Cut Co', slug: `cut-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Cutter' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })

  const insertedOrders = await db
    .insert(orders)
    .values([
      { companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-1'], createdBy: USER },
      { companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-2'], createdBy: USER },
    ])
    .returning({ id: orders.id })
  orderId = insertedOrders[0]!.id
  const otherOrderId = insertedOrders[1]!.id

  const [style] = await db
    .insert(orderStyles)
    .values({ companyId: COMPANY, orderId, styleCode: 'ST-100', contractedQty: 400 })
    .returning({ id: orderStyles.id })
  orderStyleId = style!.id

  await db.insert(orderBreakdowns).values([
    { companyId: COMPANY, orderStyleId, revision: 1, color: 'Black', size: 'S', qty: 100 },
    { companyId: COMPANY, orderStyleId, revision: 1, color: 'Black', size: 'M', qty: 200 },
    { companyId: COMPANY, orderStyleId, revision: 1, color: 'Black', size: 'L', qty: 100 },
  ])

  // Store fixtures: a GRN with rolls, issued to the order.
  const [item] = await db
    .insert(items)
    .values({ companyId: COMPANY, code: 'FAB-1', name: 'Single Jersey', kind: 'fabric', uom: 'm' })
    .returning({ id: items.id })
  const [location] = await db
    .insert(locations)
    .values({ companyId: COMPANY, code: 'GEN-1', name: 'General store', kind: 'general' })
    .returning({ id: locations.id })
  const [grn] = await db
    .insert(grns)
    .values({
      companyId: COMPANY,
      challanNo: `CH-${randomUUID().slice(0, 6)}`,
      receivedAt: '2026-07-01',
      createdBy: USER,
    })
    .returning({ id: grns.id })
  const [grnLine] = await db
    .insert(grnLines)
    .values({
      companyId: COMPANY,
      grnId: grn!.id,
      itemId: item!.id,
      qty: '1000.00',
      unit: 'm',
    })
    .returning({ id: grnLines.id })

  const insertedRolls = await db
    .insert(rolls)
    .values(
      ['R-1', 'R-2', 'R-STRAY'].map((rollNo) => ({
        companyId: COMPANY,
        grnLineId: grnLine!.id,
        itemId: item!.id,
        rollNo: `${rollNo}-${randomUUID().slice(0, 6)}`,
        qty: '250.00',
        unit: 'm',
        locationId: location!.id,
        status: 'issued' as const,
      })),
    )
    .returning({ id: rolls.id })
  rollIds = [insertedRolls[0]!.id, insertedRolls[1]!.id]
  strayRollId = insertedRolls[2]!.id

  const [issue] = await db
    .insert(issues)
    .values({ companyId: COMPANY, orderId, createdBy: USER })
    .returning({ id: issues.id })
  await db.insert(issueLines).values(
    rollIds.map((rollId) => ({
      companyId: COMPANY,
      issueId: issue!.id,
      itemId: item!.id,
      rollId,
      qty: '250.00',
      unit: 'm',
    })),
  )

  // The stray roll goes to the OTHER order.
  const [otherIssue] = await db
    .insert(issues)
    .values({ companyId: COMPANY, orderId: otherOrderId, createdBy: USER })
    .returning({ id: issues.id })
  await db.insert(issueLines).values({
    companyId: COMPANY,
    issueId: otherIssue!.id,
    itemId: item!.id,
    rollId: strayRollId,
    qty: '250.00',
    unit: 'm',
  })

  allowPp()
  const marker = await createMarker(ctx, {
    code: `MK-${randomUUID().slice(0, 6)}`,
    styleCode: 'ST-100',
    sizeRatio: { S: 1, M: 2, L: 1 },
    layLengthMeters: '6.40',
  })
  markerId = marker.markerId
})

afterEach(() => {
  allowPp()
})

afterAll(async () => {
  resetPpApprovalProvider()
  resetFabricInspectionProvider()
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const clearLays = async () => {
  await db.delete(lays).where(eq(lays.companyId, COMPANY))
}

const layInput = (over: Record<string, unknown> = {}) => ({
  orderId,
  orderStyleId,
  markerId,
  layNo: `LAY-${randomUUID().slice(0, 8)}`,
  color: 'Black',
  plies: 100,
  layLengthMeters: '6.40',
  rollsDrawn: rollIds,
  ...over,
})

describe('5.1 · the two preconditions on lay create', () => {
  it('fails CLOSED when sampling has registered no PP provider', async () => {
    await clearLays()
    resetPpApprovalProvider()

    // Module 1.4 does not exist yet. Defaulting to `passed` would ship a system whose
    // most expensive quality gate is silently off.
    await expect(createLay(ctx, layInput())).rejects.toThrow(/pp_approval/)
  })

  it('blocks when the PP sample is not approved', async () => {
    await clearLays()
    registerPpApprovalProvider(async () => ({
      passed: false,
      reasonKey: 'gates.pp_approval.not_approved',
    }))

    await expect(createLay(ctx, layInput())).rejects.toThrow(/not_approved/)

    const rows = await db.select().from(lays).where(eq(lays.companyId, COMPANY))
    expect(rows).toHaveLength(0)
  })

  it('blocks a lay drawing rolls issued to a different order', async () => {
    await clearLays()
    // The store issued this roll against another order. Cutting it here means the ledger
    // and the floor disagree.
    await expect(
      createLay(ctx, layInput({ rollsDrawn: [...rollIds, strayRollId] })),
    ).rejects.toThrow(/not_issued_to_order/)
  })

  it('blocks a lay that draws no fabric at all', async () => {
    await clearLays()
    await expect(createLay(ctx, layInput({ rollsDrawn: [] }))).rejects.toThrow(/no_rolls/)
  })

  it('refuses to spread cloth quality rejected, and says which rolls', async () => {
    /*
     * Nordkap §8, F39. The store's 4-point gate guards the moment cloth LEAVES the rack. A
     * lay draws on rolls already issued to the order, so anything that failed inspection
     * after issue — or came back to the rack and was picked up again — reached the table by
     * a path that gate never saw. `R-F-17`, failed at 24 points against a 20-point limit,
     * was spread into a lay and cut into garments.
     *
     * Cutting is the last moment it is recoverable: after the knife it is a claim.
     */
    await clearLays()
    registerFabricInspectionProvider(async (_ctx, _tx, input) => ({
      passed: false,
      reasonKey: 'gates.fabric_inspection.failed',
      facts: {
        gate: 'fabric_inspection',
        rolls: input.rollIds.length,
        reason: '1 roll failed 4-point inspection at 24.00 points per 100 yd²: R-F-17.',
      },
    }))

    const thrown = await createLay(ctx, layInput()).catch((error: unknown) => error)
    expect(thrown).toMatchObject({ messageKey: 'gates.fabric_inspection.failed' })
    // The sentence travels with it — a floor refusal that names no roll names nothing.
    expect(String((thrown as { details?: { reason?: string } }).details?.reason)).toContain('R-F-17')

    const spread = await db.select().from(lays).where(eq(lays.companyId, COMPANY))
    expect(spread).toHaveLength(0)

    allowFabric()
  })

  it('spreads the lay once quality has cleared the cloth', async () => {
    // The release direction: the same gate that refused above lets it through.
    await clearLays()
    allowFabric()
    const result = await createLay(ctx, layInput())
    expect(result.layId).toBeTruthy()
  })

  it('spreads the lay and reports what it should yield', async () => {
    await clearLays()
    const result = await createLay(ctx, layInput())

    // A 1:2:1 marker at 100 plies.
    expect(result.expectedPerSize).toEqual({ S: 100, M: 200, L: 100 })
    expect(result.plannedFabric).toBe('640.00')
  })
})

describe('5.1 · the cut report', () => {
  it('records which breakdown revision it was judged against', async () => {
    await clearLays()
    const lay = await createLay(ctx, layInput())
    const result = await recordCutReport(
      ctx,
      { layId: lay.layId, cells: { 'Black|S': 100, 'Black|M': 200, 'Black|L': 100 } },
      POLICY,
    )

    expect(result.breakdownRevision).toBe(1)
    expect(result.validation.withinTolerance).toBe(true)
    expect(result.completion.complete).toBe(true)

    // A revision that lands later must not rewrite what this report was judged against.
    const [stored] = await db
      .select()
      .from(cutReports)
      .where(eq(cutReports.id, result.cutReportId))
    expect(stored!.breakdownRevision).toBe(1)
  })

  it('flags the out-of-tolerance cell and emits a variance event', async () => {
    await clearLays()
    await db.execute(sql`delete from outbox where company_id = ${COMPANY}`)

    const lay = await createLay(ctx, layInput())
    const result = await recordCutReport(
      ctx,
      { layId: lay.layId, cells: { 'Black|S': 100, 'Black|M': 220, 'Black|L': 100 } },
      POLICY,
    )

    expect(result.validation.withinTolerance).toBe(false)
    expect(result.validation.totalOver).toBe(20)
    expect(result.validation.totalShort).toBe(0)

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from outbox
          where company_id = ${COMPANY} and event_name = 'cutting.report.variance'`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    expect(Number((list[0] as { n: string }).n)).toBe(1)
  })

  it('is not complete when the total matches but the grid does not', async () => {
    await clearLays()
    const lay = await createLay(ctx, layInput())
    // 400 cut against 400 ordered — and L is 100 short while M is 100 over.
    const result = await recordCutReport(
      ctx,
      { layId: lay.layId, cells: { 'Black|S': 100, 'Black|M': 300, 'Black|L': 0 } },
      POLICY,
    )

    expect(result.completion.complete).toBe(false)

    const position = await cutPosition(ctx, { orderStyleId })
    expect(position.complete).toBe(false)
    expect(position.shortCells).toEqual([{ color: 'Black', size: 'L', short: 100 }])
  })

  it('sums completion across lays, not per report', async () => {
    await clearLays()
    const first = await createLay(ctx, layInput({ plies: 50 }))
    await recordCutReport(
      ctx,
      { layId: first.layId, cells: { 'Black|S': 50, 'Black|M': 100, 'Black|L': 50 } },
      POLICY,
    )

    const halfway = await cutPosition(ctx, { orderStyleId })
    expect(halfway.pct).toBe('50.00')

    const second = await createLay(ctx, layInput({ plies: 50 }))
    await recordCutReport(
      ctx,
      { layId: second.layId, cells: { 'Black|S': 50, 'Black|M': 100, 'Black|L': 50 } },
      POLICY,
    )

    const done = await cutPosition(ctx, { orderStyleId })
    expect(done.complete).toBe(true)
    expect(done.pct).toBe('100.00')
  })

  it('refuses a second report on the same lay', async () => {
    await clearLays()
    const lay = await createLay(ctx, layInput())
    await recordCutReport(ctx, { layId: lay.layId, cells: { 'Black|S': 100 } }, POLICY)

    // The lay is `cut`. A restatement is a correction, and corrections go through
    // pending_changes rather than by writing a second row nobody can order.
    await expect(
      recordCutReport(ctx, { layId: lay.layId, cells: { 'Black|S': 100 } }, POLICY),
    ).rejects.toThrow()
  })
})

describe('5.1 · offline batch', () => {
  it('is idempotent on replay', async () => {
    await clearLays()
    const key = `off-${randomUUID()}`
    const batch = [
      {
        offlineKey: key,
        moduleId: 'cutting',
        operation: 'create_lay',
        payload: layInput() as Record<string, unknown>,
      },
    ]

    const first = await syncBatch(ctx, batch)
    expect(first[0]!.status).toBe('applied')

    const replay = await syncBatch(ctx, batch)
    expect(replay[0]!.status).toBe('duplicate')

    const rows = await db.select().from(lays).where(eq(lays.companyId, COMPANY))
    expect(rows).toHaveLength(1)
    // The key is visible on the business row, not only in the internal ledger.
    expect(rows[0]!.offlineKey).toBe(key)
  })

  it('remembers a blocked row as rejected rather than retrying it forever', async () => {
    await clearLays()
    resetPpApprovalProvider()

    const batch = [
      {
        offlineKey: `off-${randomUUID()}`,
        moduleId: 'cutting',
        operation: 'create_lay',
        payload: layInput() as Record<string, unknown>,
      },
    ]

    const first = await syncBatch(ctx, batch)
    expect(first[0]!.status).toBe('rejected')

    allowPp()
    const replay = await syncBatch(ctx, batch)
    // Still rejected: the device shows the operator exactly what was refused rather than
    // the row quietly appearing later for a reason nobody can trace.
    expect(replay[0]!.status).toBe('rejected')
  })
})

describe('5.1 · bundles', () => {
  it('generates once and refuses a second run', async () => {
    await clearLays()
    const lay = await createLay(ctx, layInput())
    const report = await recordCutReport(
      ctx,
      { layId: lay.layId, cells: { 'Black|S': 100, 'Black|M': 200, 'Black|L': 100 } },
      POLICY,
    )

    const result = await generateBundles(ctx, {
      cutReportId: report.cutReportId,
      bundleSize: 60,
    })
    // 100→2, 200→4, 100→2.
    expect(result.bundleCount).toBe(8)

    // Tickets are already stapled to physical stacks.
    await expect(
      generateBundles(ctx, { cutReportId: report.cutReportId, bundleSize: 60 }),
    ).rejects.toThrow(/already_generated/)
  })

  it('moves a bundle only along its state machine', async () => {
    await clearLays()
    const lay = await createLay(ctx, layInput())
    const report = await recordCutReport(
      ctx,
      { layId: lay.layId, cells: { 'Black|S': 100 } },
      POLICY,
    )
    await generateBundles(ctx, { cutReportId: report.cutReportId, bundleSize: 100 })

    const [bundle] = await db
      .select()
      .from(bundles)
      .where(eq(bundles.cutReportId, report.cutReportId))

    await expect(
      scanBundle(ctx, { qrToken: bundle!.qrToken, status: 'done' }),
    ).rejects.toThrow()

    await scanBundle(ctx, { qrToken: bundle!.qrToken, status: 'in_sewing' })
    const result = await scanBundle(ctx, { qrToken: bundle!.qrToken, status: 'done' })
    expect(result.status).toBe('done')
  })
})

describe('5.1 · wastage', () => {
  it('measures drawn fabric against the marker plan and alerts past the threshold', async () => {
    await clearLays()
    await db.execute(sql`delete from outbox where company_id = ${COMPANY}`)

    // `fabric_drawn_meters` is the TOTAL off the rolls, not a per-ply figure: `createLay`
    // defaults it to `layYield().plannedFabric`, which is "lay length × plies". This test
    // used to pass 6.80 and describe it as per-ply, which only produced 6.25% because
    // `recomputeWastage` multiplied it by the ply count a second time — and 6.80 m cannot
    // spread a hundred plies of a 6.40 m marker, so the input could not happen on a floor.
    // 680 m drawn against a 640 m plan is the same 6.25%, in the unit the column holds.
    const lay = await createLay(ctx, layInput({ fabricDrawnMeters: '680.00' }))
    await recordCutReport(ctx, { layId: lay.layId, cells: { 'Black|S': 100 } }, POLICY)

    const result = await recomputeWastage(ctx, { orderId }, POLICY)
    expect(result.wastagePct).toBe('6.25')

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from outbox
          where company_id = ${COMPANY} and event_name = 'cutting.wastage.anomaly'`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    expect(Number((list[0] as { n: string }).n)).toBe(1)
  })

  it('is recomputed, not accumulated — running it twice gives the same answer', async () => {
    await clearLays()
    const lay = await createLay(ctx, layInput({ fabricDrawnMeters: '680.00' }))
    await recordCutReport(ctx, { layId: lay.layId, cells: { 'Black|S': 100 } }, POLICY)

    const first = await recomputeWastage(ctx, { orderId }, POLICY)
    const second = await recomputeWastage(ctx, { orderId }, POLICY)
    expect(second).toEqual(first)
  })
})

describe('5.1 · tenancy', () => {
  it('another company sees no lays or markers', async () => {
    await clearLays()
    await createLay(ctx, layInput())

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      lays: await tx.select().from(lays),
      markers: await tx.select().from(markers),
    }))

    expect(seen.lays).toHaveLength(0)
    expect(seen.markers).toHaveLength(0)
  })

  it('another company cannot spread a lay on this factory’s marker', async () => {
    await expect(createLay(otherCtx, layInput())).rejects.toThrow()
  })
})

/**
 * The units of `fabric_drawn_meters`, pinned.
 *
 * It is a TOTAL for the lay. `createLay` defaults it to `layYield().plannedFabric`, which
 * is "lay length × plies", so a supplied value must mean the same thing or the default and
 * the explicit case disagree. `recomputeWastage` used to multiply it by the ply count
 * again, inflating drawn fabric by that factor: a 60-ply lay drawing 397 m was counted as
 * 23,823 m and the wastage percentage came out in the thousands.
 *
 * Nothing caught it because the only test described the column as per-ply and passed a
 * figure — 6.80 m for a hundred plies — that could not spread the lay it belonged to.
 */
describe('5.1 · wastage units', () => {
  it('treats fabric drawn as a lay TOTAL, not a per-ply figure', async () => {
    await clearLays()

    // Exactly the plan: 6.40 m × 100 plies = 640 m drawn, so nothing is wasted.
    const lay = await createLay(ctx, layInput({ fabricDrawnMeters: '640.00' }))
    await recordCutReport(ctx, { layId: lay.layId, cells: { 'Black|S': 100 } }, POLICY)

    const result = await recomputeWastage(ctx, { orderId }, POLICY)
    expect(result.fabricDrawn).toBe('640.00')
    expect(result.markerConsumption).toBe('640.00')
    expect(result.wastagePct).toBe('0.00')
  })

  it('falls back to the marker plan when no drawn figure was recorded', async () => {
    await clearLays()

    // No `fabricDrawnMeters`: `createLay` stores the plan itself, so drawn equals planned
    // and the fallback must NOT be multiplied twice either.
    const lay = await createLay(ctx, layInput())
    await recordCutReport(ctx, { layId: lay.layId, cells: { 'Black|S': 100 } }, POLICY)

    const result = await recomputeWastage(ctx, { orderId }, POLICY)
    expect(result.wastagePct).toBe('0.00')
  })
})
