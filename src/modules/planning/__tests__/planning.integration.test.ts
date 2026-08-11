/**
 * 4.1 integration.
 *
 * The pure arithmetic is covered by `capacity.test.ts`. What is asserted here is what only
 * a database can be wrong about:
 *
 *  - an overloaded plan writes NOTHING unless the planner accepts it, and an accepted
 *    overload is recorded on the row rather than lost;
 *  - the check counts what is already on the line, and a move does not compare the
 *    allocation with itself;
 *  - a scenario approved after the board has filled up is refused at commit, not blessed
 *    because it fitted when it was drafted;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { approve } from '@/modules/core/pending-changes'
import { withTenantRead } from '@/modules/core/tenancy'
import { orders, orderStyles } from '@/modules/orders/schema'
import '@/modules/planning/register'
import {
  allocations,
  learningCurves,
  lineCalendars,
  lines,
  smvRecords,
} from '@/modules/planning/schema'
import {
  allocate,
  capacityQuery,
  compareScenario,
  forkScenario,
  moveAllocation,
  proposeScenarioApply,
  setAllocationStatus,
} from '@/modules/planning/service'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `plan-${randomUUID().slice(0, 8)}`
/** A second person for the ⚖ approvals — the author's own signature now refuses (3.1). */
const SIGNER = `plan-sign-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['planner'] }
const approverCtx: RequestCtx = { companyId: COMPANY, userId: SIGNER, roles: ['owner'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['planner'] }

/** (480 − 30) × 40 = 18,000 available; at 60% → 10,800 earnable minutes a day. */
const POLICY = { defaultEfficiencyPct: '60', defaultShiftMinutes: 480 }
const DAYS = ['2026-08-03', '2026-08-04', '2026-08-05'] as const

let lineId: string
let secondLineId: string
let orderId: string
let orderStyleId: string
let secondOrderId: string

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'Plan Co', slug: `plan-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values([
    { id: USER, email: `${USER}@fabricxai.test`, name: 'Planner' },
    { id: SIGNER, email: `${SIGNER}@fabricxai.test`, name: 'Second Signer' },
  ])

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })

  const inserted = await db
    .insert(orders)
    .values([
      { companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-1'], createdBy: USER },
      { companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-2'], createdBy: USER },
    ])
    .returning({ id: orders.id })
  orderId = inserted[0]!.id
  secondOrderId = inserted[1]!.id

  const [style] = await db
    .insert(orderStyles)
    .values({ companyId: COMPANY, orderId, styleCode: 'ST-100', contractedQty: 20000 })
    .returning({ id: orderStyles.id })
  orderStyleId = style!.id

  await db
    .insert(orderStyles)
    .values({ companyId: COMPANY, orderId: secondOrderId, styleCode: 'ST-200' })

  const insertedLines = await db
    .insert(lines)
    .values([
      { companyId: COMPANY, code: 'L-07', name: 'Line 7', capacityManpower: 40 },
      { companyId: COMPANY, code: 'L-08', name: 'Line 8', capacityManpower: 40 },
    ])
    .returning({ id: lines.id })
  lineId = insertedLines[0]!.id
  secondLineId = insertedLines[1]!.id

  await db.insert(lineCalendars).values(
    [lineId, secondLineId].flatMap((id) =>
      DAYS.map((calendarDate) => ({
        companyId: COMPANY,
        lineId: id,
        calendarDate,
        shiftMinutes: 480,
        plannedDowntimeMinutes: 30,
        manpower: 40,
      })),
    ),
  )

  await db.insert(smvRecords).values([
    { companyId: COMPANY, styleCode: 'ST-100', smv: '12.50', source: 'ie_study' },
    { companyId: COMPANY, styleCode: 'ST-200', smv: '10.00', source: 'estimate' },
  ])
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const clearAllocations = async () => {
  await db.delete(allocations).where(eq(allocations.companyId, COMPANY))
}

const dailyPlan = (qty: number) => Object.fromEntries(DAYS.map((d) => [d, qty]))

describe('4.1 · allocate refuses rather than clamps', () => {
  it('places a plan that fits', async () => {
    await clearAllocations()
    // 12.5 × 800 = 10,000 earned minutes against 10,800 earnable.
    const result = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    expect(result.fits).toBe(true)
    expect(result.allocationId).not.toBeNull()
    expect(result.violations).toEqual([])
  })

  it('writes nothing when the plan overloads a line-day', async () => {
    await clearAllocations()
    const result = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(1000),
      },
      { policy: POLICY },
    )

    // 12.5 × 1000 = 12,500 against 10,800 — 1,700 over, every day.
    expect(result.fits).toBe(false)
    expect(result.allocationId).toBeNull()
    expect(result.lineDays[0]!.overloadMinutes).toBe('1700.00')
    // The quantity is echoed back untouched — nothing was trimmed to fit.
    expect(result.lineDays[0]!.requiredMinutes).toBe('12500.00')

    const rows = await db.select().from(allocations).where(eq(allocations.companyId, COMPANY))
    expect(rows).toHaveLength(0)
  })

  it('commits an accepted overload and records that it was accepted', async () => {
    await clearAllocations()
    const result = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(1000),
      },
      { policy: POLICY, acceptViolations: true },
    )

    expect(result.allocationId).not.toBeNull()

    const [row] = await db
      .select()
      .from(allocations)
      .where(eq(allocations.id, result.allocationId!))

    // A line over-committed on purpose must never look like one that simply fitted.
    expect(row!.acceptedViolations).not.toHaveLength(0)

    const events = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from outbox
          where company_id = ${COMPANY} and event_name = 'planning.overload.accepted'`,
    )
    const list = Array.isArray(events) ? events : ((events as { rows?: unknown[] }).rows ?? [])
    expect(Number((list[0] as { n: string }).n)).toBeGreaterThan(0)
  })

  it('counts what is already on the line', async () => {
    await clearAllocations()
    // 700 pieces of ST-200 at 10 SMV = 7,000 minutes/day already committed.
    await allocate(
      ctx,
      {
        orderId: secondOrderId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(700),
      },
      { policy: POLICY },
    )

    // 3,800 minutes are left; 400 × 12.5 = 5,000 does not fit even though it would
    // comfortably fit an empty line.
    const result = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(400),
      },
      { policy: POLICY },
    )

    expect(result.fits).toBe(false)
    expect(result.lineDays[0]!.requiredMinutes).toBe('12000.00')
  })

  it('refuses a multi-style order that does not say which style is on the line', async () => {
    await clearAllocations()
    await db
      .insert(orderStyles)
      .values({ companyId: COMPANY, orderId, styleCode: 'ST-101' })

    // SMV is a property of a style. An order carrying two of them has no single SMV, and
    // picking one silently would price the whole run wrong.
    await expect(
      allocate(
        ctx,
        {
          orderId,
          lineId,
          startDate: DAYS[0],
          endDate: DAYS[2],
          plannedDaily: dailyPlan(100),
        },
        { policy: POLICY },
      ),
    ).rejects.toThrow(/ambiguous/)

    await db.delete(orderStyles).where(eq(orderStyles.styleCode, 'ST-101'))
  })

  it('refuses a style with no SMV rather than inventing one', async () => {
    await clearAllocations()
    await db.delete(smvRecords).where(eq(smvRecords.styleCode, 'ST-200'))

    await expect(
      allocate(
        ctx,
        {
          orderId: secondOrderId,
          lineId,
          startDate: DAYS[0],
          endDate: DAYS[2],
          plannedDaily: dailyPlan(100),
        },
        { policy: POLICY },
      ),
    ).rejects.toThrow()

    await db
      .insert(smvRecords)
      .values({ companyId: COMPANY, styleCode: 'ST-200', smv: '10.00', source: 'estimate' })
  })
})

describe('4.1 · the learning curve is used, not the steady state', () => {
  it('plans day one at the curve rate', async () => {
    await clearAllocations()
    await db.insert(learningCurves).values([
      { companyId: COMPANY, productType: 'polo', dayIndex: 1, efficiencyPct: '35' },
      { companyId: COMPANY, productType: 'polo', dayIndex: 3, efficiencyPct: '60' },
    ])

    const result = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(500),
      },
      { policy: POLICY, productType: 'polo' },
    )

    // Day 1 at 35% earns 6,300 minutes, not 10,800 — so 6,250 fits but only just, and
    // planning it at the steady state would have hidden how tight it is.
    expect(result.lineDays[0]!.earnableMinutes).toBe('6300.00')
    expect(result.lineDays[2]!.earnableMinutes).toBe('10800.00')

    await db.delete(learningCurves).where(eq(learningCurves.companyId, COMPANY))
  })
})

describe('4.1 · move', () => {
  it('does not compare the allocation with itself', async () => {
    await clearAllocations()
    const placed = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    // Same line, same days, same quantity. If the check counted the row being moved it
    // would report 20,000 minutes against 10,800 and refuse a no-op.
    const moved = await moveAllocation(ctx, {
      allocationId: placed.allocationId!,
      startDate: DAYS[0],
      endDate: DAYS[2],
      plannedDaily: dailyPlan(800),
      preview: true,
      policy: POLICY,
    })

    expect(moved.fits).toBe(true)
    expect(moved.lineDays[0]!.requiredMinutes).toBe('10000.00')
  })

  it('preview writes nothing', async () => {
    await clearAllocations()
    const placed = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    await moveAllocation(ctx, {
      allocationId: placed.allocationId!,
      lineId: secondLineId,
      startDate: DAYS[0],
      endDate: DAYS[2],
      plannedDaily: dailyPlan(800),
      preview: true,
      policy: POLICY,
    })

    const [row] = await db
      .select()
      .from(allocations)
      .where(eq(allocations.id, placed.allocationId!))
    expect(row!.lineId).toBe(lineId)
  })

  it('emits a sewing-window change when the dates move, for TNA to ripple', async () => {
    await clearAllocations()
    await db.execute(sql`delete from outbox where company_id = ${COMPANY}`)

    const placed = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    await moveAllocation(ctx, {
      allocationId: placed.allocationId!,
      startDate: DAYS[1],
      endDate: DAYS[2],
      plannedDaily: { [DAYS[1]]: 800, [DAYS[2]]: 800 },
      policy: POLICY,
    })

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from outbox
          where company_id = ${COMPANY} and event_name = 'planning.sewing_window.changed'`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    // One from the placement, one from the move.
    expect(Number((list[0] as { n: string }).n)).toBe(2)
  })

  it('refuses to re-plan a finished run', async () => {
    await clearAllocations()
    const placed = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    await setAllocationStatus(ctx, { allocationId: placed.allocationId!, status: 'active' })
    await setAllocationStatus(ctx, { allocationId: placed.allocationId!, status: 'done' })

    // A finished run is history; re-planning it would rewrite what actually happened.
    await expect(
      moveAllocation(ctx, {
        allocationId: placed.allocationId!,
        startDate: DAYS[1],
        endDate: DAYS[2],
        plannedDaily: { [DAYS[1]]: 800, [DAYS[2]]: 800 },
        policy: POLICY,
      }),
    ).rejects.toThrow()
  })

  it('rejects an illegal status transition', async () => {
    await clearAllocations()
    const placed = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    await expect(
      setAllocationStatus(ctx, { allocationId: placed.allocationId!, status: 'done' }),
    ).rejects.toThrow()
  })
})

describe('4.1 · the owner card', () => {
  it('answers with its assumptions attached', async () => {
    await clearAllocations()
    const answer = await capacityQuery(ctx, {
      styleCode: 'ST-100',
      qty: 2000,
      lineIds: [lineId],
      dates: DAYS,
      policy: POLICY,
    })

    // 2,000 × 12.5 = 25,000 against 3 × 10,800 = 32,400.
    expect(answer.feasible).toBe(true)
    expect(answer.availableMinutes).toBe('32400.00')
    expect(answer.assumptions.efficiencyPct).toBe('60')
  })

  it('subtracts what is already committed', async () => {
    await clearAllocations()
    await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    const answer = await capacityQuery(ctx, {
      styleCode: 'ST-100',
      qty: 2000,
      lineIds: [lineId],
      dates: DAYS,
      policy: POLICY,
    })

    // 800 a day leaves 800 earnable minutes a day — 2,400 across the window.
    expect(answer.availableMinutes).toBe('2400.00')
    expect(answer.feasible).toBe(false)
    expect(answer.assumptions.countsExistingLoad).toBe(true)
  })
})

describe('4.1 · scenarios', () => {
  it('re-checks at approve time against the board as it is then', async () => {
    await clearAllocations()

    // Fork a plan that fits an empty line.
    const draft = {
      orderId,
      orderStyleId,
      lineId,
      startDate: DAYS[0],
      endDate: DAYS[2],
      plannedDaily: dailyPlan(800),
    }
    const placed = await allocate(ctx, draft, { policy: POLICY })
    const fork = await forkScenario(ctx, { name: `s-${randomUUID().slice(0, 6)}` })
    expect(fork.allocationCount).toBe(1)

    // The board moves on: the live allocation is removed and the line fills with other
    // work before anyone approves the scenario.
    await db.delete(allocations).where(eq(allocations.id, placed.allocationId!))
    await allocate(
      ctx,
      {
        orderId: secondOrderId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(900),
      },
      { policy: POLICY },
    )

    const proposed = await proposeScenarioApply(ctx, {
      scenarioId: fork.scenarioId,
      policy: POLICY,
    })

    // 9,000 already committed + 10,000 from the scenario against 10,800 earnable.
    await expect(
      approve(approverCtx, { pendingChangeId: proposed.pendingChangeId }),
    ).rejects.toThrow()
  })

  it('applies when it still fits, writing the allocations as one decision', async () => {
    await clearAllocations()
    const placed = await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    const fork = await forkScenario(ctx, { name: `s-${randomUUID().slice(0, 6)}` })
    await db.delete(allocations).where(eq(allocations.id, placed.allocationId!))

    const proposed = await proposeScenarioApply(ctx, {
      scenarioId: fork.scenarioId,
      policy: POLICY,
    })
    await approve(approverCtx, { pendingChangeId: proposed.pendingChangeId })

    const rows = await db.select().from(allocations).where(eq(allocations.companyId, COMPANY))
    expect(rows).toHaveLength(1)
    expect(rows[0]!.plannedDaily[DAYS[0]]).toBe(800)
  })

  it('compares the draft against the live board', async () => {
    await clearAllocations()
    await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    const fork = await forkScenario(ctx, { name: `s-${randomUUID().slice(0, 6)}` })
    const comparison = await compareScenario(ctx, {
      scenarioId: fork.scenarioId,
      policy: POLICY,
    })

    // 3 days × 10,000 minutes on both sides — the fork is the board.
    expect(comparison.perLine[0]!.baseMinutes).toBe('30000.00')
    expect(comparison.perLine[0]!.draftMinutes).toBe('30000.00')
  })
})

describe('4.1 · tenancy', () => {
  it('another company sees no allocations', async () => {
    await clearAllocations()
    await allocate(
      ctx,
      {
        orderId,
        orderStyleId,
        lineId,
        startDate: DAYS[0],
        endDate: DAYS[2],
        plannedDaily: dailyPlan(800),
      },
      { policy: POLICY },
    )

    const rows = await withTenantRead(otherCtx, async (tx) => tx.select().from(allocations))
    expect(rows).toHaveLength(0)
  })

  it('another company cannot plan onto this factory’s line', async () => {
    await expect(
      allocate(
        otherCtx,
        {
          orderId,
          orderStyleId,
          lineId,
          startDate: DAYS[0],
          endDate: DAYS[2],
          plannedDaily: dailyPlan(100),
        },
        { policy: POLICY },
      ),
    ).rejects.toThrow()
  })
})
