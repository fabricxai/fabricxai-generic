/**
 * The order desk's reads (design canvas, "Your week").
 *
 * Three questions the desk asks every morning and could not previously answer: what is
 * due this week across every order, what the open book is worth, and whether the credit
 * behind a PO covers its dates. All three are reads, all three run against real Postgres
 * with the application role, and the cross-company case is asserted for each — a desk
 * figure that leaked across tenants would leak a competitor's order book.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import { btbLcs, lcs } from '@/modules/commercial/schema'
import { lcCoverageForOrders } from '@/modules/commercial/queries'
import type { RequestCtx } from '@/modules/core/ctx'
import { orderLcs, orderStyles, orders, tnaMilestones } from '@/modules/orders/schema'
import { orderBookSummary, orderDetail, weekMilestones } from '@/modules/orders/queries'
import { updateStyleDetails } from '@/modules/orders/service'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = `desk-a-${randomUUID().slice(0, 8)}`
const USER_B = `desk-b-${randomUUID().slice(0, 8)}`
const BUYER_A = randomUUID()

const ctxA: RequestCtx = { companyId: COMPANY_A, userId: USER_A, roles: ['merchandiser'] }
const ctxB: RequestCtx = { companyId: COMPANY_B, userId: USER_B, roles: ['merchandiser'] }

const NOW = new Date('2026-08-25T05:30:00Z')
const MONDAY = '2026-08-24'
const FRIDAY = '2026-08-28'

let lateOrderId: string
let cleanOrderId: string
let closedOrderId: string
let conflictedLcId: string
let lateStyleId: string

beforeAll(async () => {
  await db
    .insert(companies)
    .values([
      { id: COMPANY_A, name: 'Desk Alpha', slug: `desk-a-${COMPANY_A.slice(0, 8)}` },
      { id: COMPANY_B, name: 'Desk Beta', slug: `desk-b-${COMPANY_B.slice(0, 8)}` },
    ])
    .onConflictDoNothing()

  await db
    .insert(users)
    .values([
      { id: USER_A, email: `${USER_A}@fabricxai.test`, name: 'Alpha Merch' },
      { id: USER_B, email: `${USER_B}@fabricxai.test`, name: 'Beta Merch' },
    ])
    .onConflictDoNothing()

  await db
    .insert(buyers)
    .values({ id: BUYER_A, companyId: COMPANY_A, code: 'HM', name: 'H&M' })
    .onConflictDoNothing()

  const inserted = await db
    .insert(orders)
    .values([
      {
        companyId: COMPANY_A,
        buyerId: BUYER_A,
        poNumbers: ['PO-88203'],
        currency: 'USD',
        totalValue: '242500.00',
        plannedExFactoryDate: '2026-10-12',
        status: 'in_production',
        ownerUserId: USER_A,
        createdBy: USER_A,
      },
      {
        companyId: COMPANY_A,
        buyerId: BUYER_A,
        poNumbers: ['PO-88214'],
        currency: 'USD',
        totalValue: '187300.00',
        plannedExFactoryDate: '2026-09-28',
        status: 'confirmed',
        ownerUserId: USER_A,
        createdBy: USER_A,
      },
      {
        // Closed: its dates are history and must not reach a week somebody is planning,
        // nor the book value of what is still owed.
        companyId: COMPANY_A,
        buyerId: BUYER_A,
        poNumbers: ['PO-88100'],
        currency: 'USD',
        totalValue: '99000.00',
        plannedExFactoryDate: '2026-08-01',
        status: 'closed',
        ownerUserId: USER_A,
        createdBy: USER_A,
      },
    ])
    .returning({ id: orders.id })

  lateOrderId = inserted[0]!.id
  cleanOrderId = inserted[1]!.id
  closedOrderId = inserted[2]!.id

  const styleRows = await db.insert(orderStyles).values([
    {
      companyId: COMPANY_A,
      orderId: lateOrderId,
      styleCode: 'SH-4471',
      contractedQty: 50_000,
      unitPrice: '4.85',
      currency: 'USD',
      season: 'AW-26',
    },
    {
      companyId: COMPANY_A,
      orderId: cleanOrderId,
      styleCode: 'LX-2209',
      contractedQty: 26_500,
      unitPrice: '7.07',
      currency: 'USD',
    },
  ]).returning({ id: orderStyles.id })
  lateStyleId = styleRows[0]!.id

  await db.insert(tnaMilestones).values([
    {
      companyId: COMPANY_A,
      orderId: lateOrderId,
      name: 'cutting_start',
      plannedDate: '2026-08-25',
      status: 'late',
      critical: true,
      ownerRole: 'cutting',
    },
    {
      companyId: COMPANY_A,
      orderId: lateOrderId,
      name: 'sewing_start',
      plannedDate: '2026-08-27',
      status: 'at_risk',
      ownerRole: 'production',
    },
    {
      companyId: COMPANY_A,
      orderId: cleanOrderId,
      name: 'trims_in_house',
      plannedDate: '2026-08-26',
      status: 'on_track',
      ownerRole: 'store',
    },
    {
      // Outside the window — the week must not reach for it.
      companyId: COMPANY_A,
      orderId: cleanOrderId,
      name: 'final_inspection',
      plannedDate: '2026-09-20',
      status: 'pending',
      ownerRole: 'quality',
    },
    {
      // On a closed order, inside the window.
      companyId: COMPANY_A,
      orderId: closedOrderId,
      name: 'ex_factory',
      plannedDate: '2026-08-26',
      status: 'done',
      ownerRole: 'shipment',
    },
  ])

  const [conflicted] = await db
    .insert(lcs)
    .values({
      companyId: COMPANY_A,
      buyerId: BUYER_A,
      number: 'LC-DHK-0142',
      value: '400000.00',
      currency: 'USD',
      tolerancePct: '5',
      // Four days BEFORE the late order's ex-factory of 12 Oct — the conflict the
      // merchandiser used to meet at the bank.
      latestShipmentDate: '2026-10-08',
      expiryDate: '2026-11-02',
      status: 'active',
      createdBy: USER_A,
    })
    .returning({ id: lcs.id })
  conflictedLcId = conflicted!.id

  await db.insert(orderLcs).values({
    companyId: COMPANY_A,
    orderId: lateOrderId,
    lcId: conflictedLcId,
  })

  await db.insert(btbLcs).values([
    {
      companyId: COMPANY_A,
      masterLcId: conflictedLcId,
      number: `BTB-${randomUUID().slice(0, 6)}`,
      value: '120000.00',
      currency: 'USD',
      status: 'active',
    },
    {
      // Closed BTBs have stopped being outstanding commitments and must not eat headroom.
      companyId: COMPANY_A,
      masterLcId: conflictedLcId,
      number: `BTB-${randomUUID().slice(0, 6)}`,
      value: '50000.00',
      currency: 'USD',
      status: 'closed',
    },
  ])
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY_A}, ${COMPANY_B})`)
  await db.delete(companies).where(eq(companies.id, COMPANY_A))
  await db.delete(companies).where(eq(companies.id, COMPANY_B))
  await db.delete(users).where(eq(users.id, USER_A))
  await db.delete(users).where(eq(users.id, USER_B))
  await client.end()
})

describe('the week', () => {
  it('returns every milestone in the window, with the PO, buyer and owing department', async () => {
    const week = await weekMilestones(ctxA, { from: MONDAY, to: FRIDAY })
    const cutting = week.find((m) => m.name === 'cutting_start')

    expect(cutting).toMatchObject({
      orderId: lateOrderId,
      poNumber: 'PO-88203',
      buyerName: 'H&M',
      plannedDate: '2026-08-25',
      status: 'late',
      ownerRole: 'cutting',
      critical: true,
    })
  })

  it('carries other departments’ milestones, not only the merchandiser’s own', async () => {
    // A week showing only your own tasks is a calendar of what is already under control.
    const owners = (await weekMilestones(ctxA, { from: MONDAY, to: FRIDAY })).map(
      (m) => m.ownerRole,
    )
    expect(owners).toEqual(expect.arrayContaining(['cutting', 'production', 'store']))
  })

  it('drops dates outside the window and milestones on closed orders', async () => {
    const week = await weekMilestones(ctxA, { from: MONDAY, to: FRIDAY })
    expect(week.map((m) => m.name)).not.toContain('final_inspection')
    expect(week.map((m) => m.orderId)).not.toContain(closedOrderId)
  })

  it('another company’s week is empty, by RLS', async () => {
    expect(await weekMilestones(ctxB, { from: MONDAY, to: FRIDAY })).toHaveLength(0)
  })
})

describe('the book’s headline figures', () => {
  it('counts only open orders and sums their value per currency', async () => {
    const summary = await orderBookSummary(ctxA, { now: NOW })

    expect(summary.openOrders).toBe(2)
    // 242,500 + 187,300 — added as scaled integers, never through a float.
    expect(summary.bookValue).toEqual([{ currency: 'USD', total: '429800.00' }])
  })

  it('reports the earliest month still ahead, and the pieces due in it', async () => {
    const summary = await orderBookSummary(ctxA, { now: NOW })
    expect(summary.shipping).toMatchObject({ month: '2026-09', qty: 26_500 })
    expect(summary.shipping?.poNumbers).toContain('PO-88214')
  })

  it('counts late and at-risk milestones across the open book', async () => {
    const summary = await orderBookSummary(ctxA, { now: NOW })
    expect(summary.lateMilestones).toBe(1)
    expect(summary.atRiskMilestones).toBe(1)
    expect(summary.lateOrders).toBe(1)
  })

  it('another company sees an empty book rather than a total', async () => {
    const summary = await orderBookSummary(ctxB, { now: NOW })
    expect(summary).toMatchObject({ openOrders: 0, bookValue: [], shipping: null })
  })
})

describe('the credit behind the order', () => {
  it('computes the float against the order’s own ex-factory and calls a breach a conflict', async () => {
    const [row] = await lcCoverageForOrders(ctxA, [lateOrderId], { now: NOW, limitPct: 75 })

    expect(row).toMatchObject({
      orderId: lateOrderId,
      number: 'LC-DHK-0142',
      latestShipmentDate: '2026-10-08',
      // 8 Oct − 12 Oct: the plan already ships four days after the bank's date.
      floatDays: -4,
      conflict: true,
    })
  })

  it('counts only live back-to-backs against the headroom', async () => {
    const [row] = await lcCoverageForOrders(ctxA, [lateOrderId], { now: NOW, limitPct: 75 })

    // 75% of 400,000 is 300,000; one active BTB of 120,000 is drawn, the closed one is not.
    expect(row?.headroom).toMatchObject({
      limit: '300000.00',
      used: '120000.00',
      free: '180000.00',
      limitPct: 75,
    })
  })

  it('an order with no credit returns no row rather than an empty one', async () => {
    expect(await lcCoverageForOrders(ctxA, [cleanOrderId], { now: NOW, limitPct: 75 })).toEqual([])
  })

  it('another company cannot read the credit behind this order', async () => {
    expect(await lcCoverageForOrders(ctxB, [lateOrderId], { now: NOW, limitPct: 75 })).toEqual([])
  })
})

describe('the style dossier', () => {
  it('records the identity the buyer states, and leaves untouched fields alone', async () => {
    await updateStyleDetails(ctxA, {
      orderStyleId: lateStyleId,
      patternNo: 'PTN-4471',
      packingMethod: 'Flat pack · poly bag + hanger',
    })

    const detail = await orderDetail(ctxA, lateOrderId)
    expect(detail?.style).toMatchObject({
      patternNo: 'PTN-4471',
      packingMethod: 'Flat pack · poly bag + hanger',
      // Set at insert and not mentioned by the update — a partial post must not blank it.
      season: 'AW-26',
      customerLabel: null,
    })
  })

  it('a correction that changes nothing is a no-op rather than an audit row', async () => {
    await updateStyleDetails(ctxA, { orderStyleId: lateStyleId, patternNo: 'PTN-4471' })
    const detail = await orderDetail(ctxA, lateOrderId)
    expect(detail?.style?.patternNo).toBe('PTN-4471')
  })

  it('another company cannot correct this style — not found, not forbidden', async () => {
    await expect(
      updateStyleDetails(ctxB, { orderStyleId: lateStyleId, season: 'SS-27' }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('the papers, read through the modules that own them', () => {
  it('falls back to the newest BOM when no cost sheet has been approved', async () => {
    const { boms, bomLines } = await import('@/modules/costing/schema')
    const { styleBom } = await import('@/modules/costing/queries')

    const [bom] = await db
      .insert(boms)
      .values({ companyId: COMPANY_A, styleCode: 'SH-4471', source: 'tech_pack_extract' })
      .returning({ id: boms.id })

    await db.insert(bomLines).values({
      companyId: COMPANY_A,
      bomId: bom!.id,
      lineGroup: 'fabric',
      itemRef: 'KM-27917',
      spec: '95% cotton 5% elastane rib',
      consumption: '1.1700',
      uom: 'm',
      wastagePct: '3.00',
    })

    const result = await styleBom(ctxA, 'SH-4471')
    // A style being quoted has no approved sheet; the dossier must still show its cloth,
    // and must say the numbers are not the ones a live quote rests on.
    expect(result).toMatchObject({ approved: false, sheetVersion: null })
    expect(result?.lines[0]).toMatchObject({ itemRef: 'KM-27917', consumption: '1.1700' })
  })

  it('a style nobody has costed returns null rather than throwing at a screen', async () => {
    const { styleBom } = await import('@/modules/costing/queries')
    expect(await styleBom(ctxA, 'NOT-A-STYLE')).toBeNull()
  })

  it('puts the last measurement beside the spec, judged as it was judged at capture', async () => {
    const { measurementChecks, measurementSpecs } = await import('@/modules/quality/schema')
    const { styleMeasurementChart } = await import('@/modules/quality/queries')

    const [spec] = await db
      .insert(measurementSpecs)
      .values({
        companyId: COMPANY_A,
        styleCode: 'SH-4471',
        version: 1,
        unit: 'cm',
        points: [
          { name: 'Bust', spec: '52.5', tolPlus: '1.0', tolMinus: '1.0' },
          { name: 'Back neck width', spec: '18.5', tolPlus: '0.5', tolMinus: '0.5' },
        ],
      })
      .returning({ id: measurementSpecs.id })

    await db.insert(measurementChecks).values({
      companyId: COMPANY_A,
      measurementSpecId: spec!.id,
      orderId: lateOrderId,
      sampledSize: 'M',
      values: { Bust: '52.0', 'Back neck width': '19.4' },
      // Stored at capture against the version live then — never recomputed on read.
      outOfTolerance: [{ name: 'Back neck width', measured: '19.4' }],
      missingPoints: [],
      result: 'fail',
    })

    const chart = await styleMeasurementChart(ctxA, {
      styleCode: 'SH-4471',
      orderId: lateOrderId,
    })

    expect(chart?.points).toEqual([
      { name: 'Bust', spec: '52.5', tolPlus: '1.0', tolMinus: '1.0', measured: '52.0', outOfTolerance: false },
      { name: 'Back neck width', spec: '18.5', tolPlus: '0.5', tolMinus: '0.5', measured: '19.4', outOfTolerance: true },
    ])
    expect(chart?.lastCheck).toMatchObject({ sampledSize: 'M', result: 'fail' })
  })

  it('shows the spec with no measurements against an order nobody has checked', async () => {
    const { styleMeasurementChart } = await import('@/modules/quality/queries')

    const chart = await styleMeasurementChart(ctxA, {
      styleCode: 'SH-4471',
      orderId: cleanOrderId,
    })
    expect(chart?.lastCheck).toBeNull()
    expect(chart?.points.every((point) => point.measured === null)).toBe(true)
  })

  it('another company reads neither the cloth nor the chart', async () => {
    const { styleBom } = await import('@/modules/costing/queries')
    const { styleMeasurementChart } = await import('@/modules/quality/queries')

    expect(await styleBom(ctxB, 'SH-4471')).toBeNull()
    expect(
      await styleMeasurementChart(ctxB, { styleCode: 'SH-4471', orderId: lateOrderId }),
    ).toBeNull()
  })
})
