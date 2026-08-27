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
import { orderBookSummary, weekMilestones } from '@/modules/orders/queries'

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

  await db.insert(orderStyles).values([
    {
      companyId: COMPANY_A,
      orderId: lateOrderId,
      styleCode: 'SH-4471',
      contractedQty: 50_000,
      unitPrice: '4.85',
      currency: 'USD',
    },
    {
      companyId: COMPANY_A,
      orderId: cleanOrderId,
      styleCode: 'LX-2209',
      contractedQty: 26_500,
      unitPrice: '7.07',
      currency: 'USD',
    },
  ])

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
