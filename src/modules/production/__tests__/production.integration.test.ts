/**
 * 6.1 integration ⚡
 *
 * The properties k6 measures at load, asserted here for correctness first — a burst path
 * that is fast and wrong is worse than one that is slow and right.
 *
 *  - a replayed batch changes no row count (the k6 assertion, at unit scale);
 *  - writes land in the right monthly partition and the board read prunes to it;
 *  - one open downtime per line;
 *  - day-close is idempotent and rebuildable.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, notifications, outbox, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import type { SystemCtx } from '@/modules/core/ctx'
import { syncBatch } from '@/modules/core/offline-sync'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderStyles, orders, tnaMilestones } from '@/modules/orders/schema'
import '@/modules/production/register'
import {
  closeDay,
  closeLineDowntime,
  getBoard,
  openLineDowntime,
  recordEndlineCount,
  recordHourlyOutputs,
  runRate,
} from '@/modules/production/service'
import { ensureOutputPartitions, runRunRateAlerts } from '@/modules/production/jobs'
import {
  dailyLinePlans,
  downtimes,
  efficiencyDaily,
  hourlyOutputs,
} from '@/modules/production/schema'
import { board } from '@/modules/production/queries'
import { lines } from '@/modules/planning/schema'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `prod-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['production'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['production'] }

/*
 * A fixed date, and the partition for it created explicitly below.
 *
 * It used to rely on migration 0019 having seeded this month, which seeds `-1..12` months
 * around `now()` AT MIGRATION TIME. That was true while CI migrated a fresh database within
 * a month of June 2026 and false from 1 July onward: the rows fell into the DEFAULT
 * partition and two tests began failing for a reason that had nothing to do with the code.
 *
 * Wall-clock does not belong in an assertion about physical routing. So the date stays
 * fixed and the partition is made to exist — through `ensure_hourly_output_partition`,
 * which is the same function the nightly job calls, so the setup exercises the real
 * mechanism rather than hand-rolling a CREATE TABLE.
 *
 * The separate question — does a running deployment keep a partition open for TODAY —
 * is what this test was checking by accident. It is now checked on purpose, against the
 * job that is responsible for it, in the '6.1 · partition roll-forward' block below.
 */
const DAY = '2026-06-15'
/** The fixture line's planned manpower — the efficiency denominator's other half. */
const MANPOWER = 40
const DAY_PARTITION = 'hourly_outputs_2026_06'
let lineId: string
let orderId: string
let buyerId: string

beforeAll(async () => {
  await db.execute(sql`select app.ensure_hourly_output_partition(${DAY}::date)`)

  await db.insert(companies).values([
    { id: COMPANY, name: 'Prod Co', slug: `prod-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Supervisor' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  buyerId = buyer!.id
  const [order] = await db
    .insert(orders)
    .values({ companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-9'], createdBy: USER })
    .returning({ id: orders.id })
  orderId = order!.id

  const [line] = await db
    .insert(lines)
    .values({ companyId: COMPANY, code: 'L-07', name: 'Line 7', capacityManpower: 40 })
    .returning({ id: lines.id })
  lineId = line!.id

  await db.insert(dailyLinePlans).values({
    companyId: COMPANY,
    lineId,
    orderId,
    planDate: DAY,
    targetPerHour: 120,
    manpowerPlanned: MANPOWER,
    smv: '12.50',
    createdBy: USER,
  })
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const countRows = async () => {
  const rows = await db.execute<{ n: string }>(
    sql`select count(*)::text as n from hourly_outputs where company_id = ${COMPANY} and produced_on = ${DAY}`,
  )
  const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
  return Number((list[0] as { n: string }).n)
}

describe('6.1 ⚡ · burst writes', () => {
  it('writes a whole batch and is idempotent on replay', async () => {
    const entries = Array.from({ length: 10 }, (_, hour) => ({
      lineId,
      orderId,
      producedOn: DAY,
      hourSlot: hour,
      target: 120,
      actual: 100 + hour,
    }))

    const first = await recordHourlyOutputs(ctx, { entries })
    expect(first.written).toBe(10)
    expect(await countRows()).toBe(10)

    // The same batch again — a tablet resending, or k6 running twice. The natural key
    // makes this an upsert, so the row COUNT is what proves it rather than the response.
    await recordHourlyOutputs(ctx, { entries })
    expect(await countRows()).toBe(10)
  })

  it('a corrected count replaces the cell rather than adding one', async () => {
    // A supervisor fixes the 14:00 figure. Same path, same key.
    await recordHourlyOutputs(ctx, {
      entries: [{ lineId, orderId, producedOn: DAY, hourSlot: 3, target: 120, actual: 77 }],
    })

    expect(await countRows()).toBe(10)

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${DAY} and ${hourlyOutputs.hourSlot} = 3`)

    expect(cell?.actual).toBe(77)
  })

  it('lands in the right monthly partition', async () => {
    // The whole point of partitioning from day one: verify rows physically route.
    const rows = await db.execute<{ partition: string; n: string }>(sql`
      select tableoid::regclass::text as partition, count(*)::text as n
      from hourly_outputs where company_id = ${COMPANY} and produced_on = ${DAY}
      group by 1`)
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])

    expect((list[0] as { partition: string }).partition).toBe(DAY_PARTITION)
    // Not the default. DEFAULT is a safety net for a month nobody created — data is safe
    // there but stops being pruned, so a row in it means the machinery failed quietly.
    expect((list[0] as { partition: string }).partition).not.toContain('default')
  })

  it('the board read prunes to a single partition', async () => {
    const plan = await db.execute<{ 'QUERY PLAN': string }>(
      sql`explain (costs off) select * from hourly_outputs where company_id = ${COMPANY} and produced_on = ${DAY}`,
    )
    const list = Array.isArray(plan) ? plan : ((plan as { rows?: unknown[] }).rows ?? [])
    const text = (list as { 'QUERY PLAN': string }[]).map((r) => r['QUERY PLAN']).join('\n')

    // Assert the OUTCOME, not the mechanism. With a literal date Postgres prunes at plan
    // time and the other partitions never appear; with a parameter or CURRENT_DATE it
    // prunes at run time and they appear as "Subplans Removed". Both are pruning, and a
    // test that demanded one would fail the day the query became parameterised.
    const partitionsTouched = [...text.matchAll(/hourly_outputs_(\d{4}_\d{2}|default)/g)].map(
      (match) => match[1],
    )

    expect(new Set(partitionsTouched)).toEqual(new Set([DAY_PARTITION.replace('hourly_outputs_', '')]))
    // Scanning DEFAULT too would mean the read had stopped being pruned.
    expect(text).not.toContain('hourly_outputs_default')
  })

  it('today has a partition of its own — the floor writes now, not in June', async () => {
    /*
     * The invariant the two tests above used to check by accident, and the one that
     * actually protects a factory: a supervisor posts an hourly count for TODAY, and it
     * must land in a real monthly partition rather than DEFAULT.
     *
     * Migration 0019 seeds a window around whenever it happened to run. Keeping that window
     * open is `ensureOutputPartitions`, scheduled nightly — the job its own docblock calls
     * "the one that matters most and is easiest to forget", and which had no test at all.
     * Forgetting it does not break loudly: rows still land, because DEFAULT catches them,
     * and the board read quietly stops being pruned.
     */
    const systemCtx: SystemCtx = { companyId: COMPANY, userId: null, roles: ['owner'], system: true }
    const result = await ensureOutputPartitions(systemCtx, { monthsAhead: 2 })

    expect(result.ensured).toBe(3)

    const rows = await db.execute<{ name: string }>(sql`
      select to_char(date_trunc('month', now()) + (i || ' month')::interval, '"hourly_outputs_"YYYY_MM') as name
      from generate_series(0, 2) as i`)
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])

    for (const row of list as { name: string }[]) {
      const exists = await db.execute<{ ok: boolean }>(
        sql`select to_regclass(${'public.' + row.name}) is not null as ok`,
      )
      const found = Array.isArray(exists) ? exists : ((exists as { rows?: unknown[] }).rows ?? [])
      expect((found[0] as { ok: boolean }).ok, `${row.name} should exist`).toBe(true)
    }
  })

  it('is invisible to another company', async () => {
    expect(await getBoard(otherCtx, { producedOn: DAY })).toHaveLength(0)
    expect((await getBoard(ctx, { producedOn: DAY })).length).toBeGreaterThan(0)

    const visible = await withTenantRead(otherCtx, (tx) =>
      tx.select().from(hourlyOutputs).where(eq(hourlyOutputs.lineId, lineId)),
    )
    expect(visible).toHaveLength(0)
  })

  it('a replayed offline batch is a no-op through the sync endpoint too', async () => {
    const before = await countRows()
    const batch = [
      {
        offlineKey: `burst-${randomUUID()}`,
        moduleId: 'production',
        operation: 'record_hourly_outputs',
        payload: {
          entries: [{ lineId, orderId, producedOn: DAY, hourSlot: 11, target: 120, actual: 95 }],
        },
      },
    ]

    expect((await syncBatch(ctx, batch))[0]?.status).toBe('applied')
    const after = await countRows()

    expect((await syncBatch(ctx, batch))[0]?.status).toBe('duplicate')
    expect(await countRows()).toBe(after)
    expect(after).toBe(before + 1)
  })
})

describe('6.1 · a supervisor writes only to their own lines (§9, F45)', () => {
  /*
   * The scope was a UI-only wall: four `.filter()` calls in page components and nothing on
   * the server. Posting another line's uuid through the queue endpoint came back `applied`.
   *
   * Not a tenancy test — `scoped()` covers that and is the wall that matters. This is the
   * narrower promise the product makes to a factory that splits its floor between chiefs.
   */
  const SCOPE_DAY = '2026-06-10'
  let otherLineId: string
  /** A chief who supervises L-07 (the fixture line) and nothing else. */
  let chief: RequestCtx

  beforeAll(async () => {
    await db.execute(sql`select app.ensure_hourly_output_partition(${SCOPE_DAY}::date)`)

    const [other] = await db
      .insert(lines)
      .values({ companyId: COMPANY, code: 'L-08', name: 'Line 8', capacityManpower: 40 })
      .returning({ id: lines.id })
    otherLineId = other!.id

    chief = { companyId: COMPANY, userId: USER, roles: ['production'], lineScope: ['L-07'] }
  })

  it('takes the hour on a line they supervise', async () => {
    const result = await recordHourlyOutputs(chief, {
      entries: [{ lineId, producedOn: SCOPE_DAY, hourSlot: 8, target: 120, actual: 111 }],
    })
    expect(result.written).toBe(1)
  })

  it('refuses the hour on a line they do not, naming it by code', async () => {
    await expect(
      recordHourlyOutputs(chief, {
        entries: [{ lineId: otherLineId, producedOn: SCOPE_DAY, hourSlot: 8, target: 120, actual: 999 }],
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.line_out_of_scope' })

    const rows = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${otherLineId} and ${hourlyOutputs.producedOn} = ${SCOPE_DAY}`,
      )
    expect(rows).toHaveLength(0)
  })

  it('refuses a batch that smuggles one line in among allowed ones', async () => {
    // The whole batch fails. A partial write would leave the supervisor believing every row
    // landed, which is worse than a refusal.
    await expect(
      recordHourlyOutputs(chief, {
        entries: [
          { lineId, producedOn: SCOPE_DAY, hourSlot: 9, target: 120, actual: 118 },
          { lineId: otherLineId, producedOn: SCOPE_DAY, hourSlot: 9, target: 120, actual: 999 },
        ],
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.line_out_of_scope' })

    const rows = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.producedOn} = ${SCOPE_DAY} and ${hourlyOutputs.hourSlot} = 9`,
      )
    expect(rows).toHaveLength(0)
  })

  it('refuses a stoppage and an endline count outside the scope too', async () => {
    // The same handlers the finding named — they share the gate, so they share the test.
    await expect(
      openLineDowntime(chief, {
        lineId: otherLineId,
        startedAt: new Date('2026-06-10T04:00:00Z').toISOString(),
        reason: 'machine',
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.line_out_of_scope' })

    await expect(
      recordEndlineCount(chief, {
        lineId: otherLineId,
        countedOn: SCOPE_DAY,
        checked: 100,
        passed: 98,
        defective: 2,
        defects: 2,
        rework: 0,
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.line_out_of_scope' })
  })

  it('narrows nobody who is not scoped, and no job', async () => {
    // The common case, and the one that must cost nothing: ctx with no lineScope at all.
    const result = await recordHourlyOutputs(ctx, {
      entries: [{ lineId: otherLineId, producedOn: SCOPE_DAY, hourSlot: 10, target: 120, actual: 105 }],
    })
    expect(result.written).toBe(1)
  })
})

describe('6.1 · why the hour went that way (§9, F43)', () => {
  /*
   * The sheet's remark reached the confirm list and died at the save button. Now it is a
   * column — and the rule that matters is what a write with NO opinion does, because the
   * hourly keypad enters one number per line and has no remark field at all.
   */
  const REMARK_DAY = '2026-06-13'

  beforeAll(async () => {
    await db.execute(sql`select app.ensure_hourly_output_partition(${REMARK_DAY}::date)`)
  })

  it('keeps what the sheet said about the hour', async () => {
    await recordHourlyOutputs(ctx, {
      entries: [
        {
          lineId,
          producedOn: REMARK_DAY,
          hourSlot: 8,
          target: 145,
          actual: 118,
          remark: 'first hour — feeding, 6 operators short',
        },
        { lineId, producedOn: REMARK_DAY, hourSlot: 9, target: 145, actual: 141 },
      ],
    })

    const cells = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${REMARK_DAY}`,
      )

    expect(cells.find((c) => c.hourSlot === 8)?.remark).toBe(
      'first hour — feeding, 6 operators short',
    )
    // An ordinary hour has nothing to say, and says it as a blank rather than an empty string.
    expect(cells.find((c) => c.hourSlot === 9)?.remark).toBeNull()
  })

  it('a correction that says nothing leaves the explanation alone', async () => {
    // The hourly keypad, re-entering the same hour. This is the whole reason the upsert does
    // not simply take `excluded.remark`: it would blank the sheet's own words on every
    // correction, which is the discard this column exists to end.
    await recordHourlyOutputs(ctx, {
      entries: [{ lineId, producedOn: REMARK_DAY, hourSlot: 8, target: 145, actual: 120 }],
    })

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${REMARK_DAY} and ${hourlyOutputs.hourSlot} = 8`,
      )

    expect(cell?.actual).toBe(120)
    expect(cell?.remark).toBe('first hour — feeding, 6 operators short')
  })

  it('an empty remark from the box that asks is a deliberate clear', async () => {
    await recordHourlyOutputs(ctx, {
      entries: [
        { lineId, producedOn: REMARK_DAY, hourSlot: 8, target: 145, actual: 120, remark: '' },
      ],
    })

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${REMARK_DAY} and ${hourlyOutputs.hourSlot} = 8`,
      )

    expect(cell?.remark).toBeNull()
  })

  it('reaches the board the supervisor reads', async () => {
    await recordHourlyOutputs(ctx, {
      entries: [
        {
          lineId,
          producedOn: REMARK_DAY,
          hourSlot: 14,
          target: 145,
          actual: 138,
          remark: 'needle change SN-3-014',
        },
      ],
    })

    // The screen's read model, not the raw rows — the point is that it survives the trip
    // to the board a supervisor actually looks at.
    const rows = await board(ctx, { producedOn: REMARK_DAY, shiftHours: 10 })
    const cell = rows
      .find((r) => r.lineId === lineId)
      ?.hours.find((h) => h.hourSlot === 14)

    expect(cell?.remark).toBe('needle change SN-3-014')
  })
})

describe('6.1 · which order a day belongs to (§9, F44)', () => {
  /*
   * A back-dated day is attached by the plan for THAT day, not by what the line is running
   * now. The catch-up dialog used to send today's order for a sheet from last week, which
   * booked a whole day against the wrong order — or, with nothing planned today, against no
   * order at all, invisible to the order it was sewn for and to WIP.
   */
  const BACK_DAY = '2026-06-11'
  let backOrderId: string

  beforeAll(async () => {
    await db.execute(sql`select app.ensure_hourly_output_partition(${BACK_DAY}::date)`)

    const [order] = await db
      .insert(orders)
      .values({ companyId: COMPANY, buyerId, poNumbers: ['PO-BACK'], createdBy: USER })
      .returning({ id: orders.id })
    backOrderId = order!.id

    // What the line ran that day — a DIFFERENT order from the one planned for DAY.
    await db.insert(dailyLinePlans).values({
      companyId: COMPANY,
      lineId,
      orderId: backOrderId,
      planDate: BACK_DAY,
      targetPerHour: 100,
      manpowerPlanned: MANPOWER,
      smv: '12.50',
      createdBy: USER,
    })
  })

  it('takes the order from the day being written, not from the caller', async () => {
    // Exactly the old bug's payload: the day is BACK_DAY, the order named is the one running
    // on DAY. The plan for BACK_DAY must win.
    await recordHourlyOutputs(ctx, {
      entries: [
        { lineId, orderId, producedOn: BACK_DAY, hourSlot: 8, target: 100, actual: 91 },
      ],
    })

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${BACK_DAY} and ${hourlyOutputs.hourSlot} = 8`,
      )

    expect(cell?.orderId).toBe(backOrderId)
    expect(cell?.orderId).not.toBe(orderId)
  })

  it('attaches a day the caller named no order for at all', async () => {
    // The board's hour edit sends no order and orphaned every cell corrected through it.
    await recordHourlyOutputs(ctx, {
      entries: [{ lineId, producedOn: BACK_DAY, hourSlot: 9, target: 100, actual: 88 }],
    })

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${BACK_DAY} and ${hourlyOutputs.hourSlot} = 9`,
      )

    expect(cell?.orderId).toBe(backOrderId)
  })

  it('re-saving repairs a day that was already booked against the wrong order', async () => {
    // Rows written before the fix carry the wrong order. The upsert sets order_id from
    // `excluded`, so entering the day again through the same screen corrects it — which is
    // what makes the live tenant repairable without a migration.
    await db
      .update(hourlyOutputs)
      .set({ orderId })
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${BACK_DAY} and ${hourlyOutputs.hourSlot} = 8`,
      )

    await recordHourlyOutputs(ctx, {
      entries: [{ lineId, producedOn: BACK_DAY, hourSlot: 8, target: 100, actual: 91 }],
    })

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${BACK_DAY} and ${hourlyOutputs.hourSlot} = 8`,
      )

    expect(cell?.orderId).toBe(backOrderId)
  })

  it('leaves the day unattached when nothing was planned, rather than guessing', async () => {
    const UNPLANNED = '2026-06-12'
    await db.execute(sql`select app.ensure_hourly_output_partition(${UNPLANNED}::date)`)

    await recordHourlyOutputs(ctx, {
      entries: [{ lineId, producedOn: UNPLANNED, hourSlot: 8, target: 100, actual: 70 }],
    })

    const [cell] = await db
      .select()
      .from(hourlyOutputs)
      .where(
        sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${UNPLANNED}`,
      )

    // No plan, no order. The screen warns before saving; what must never happen is a day
    // silently acquiring whichever order happened to be running on some other date.
    expect(cell?.orderId).toBeNull()
  })
})

describe('6.1 · downtime', () => {
  it('opens, refuses a second, then closes with the minutes lost', async () => {
    const opened = await openLineDowntime(ctx, {
      lineId,
      startedAt: '2026-06-15T09:00:00.000Z',
      reason: 'machine',
      note: 'needle bar',
    })

    // Two open downtimes on one line would double-count lost minutes.
    await expect(
      openLineDowntime(ctx, {
        lineId,
        startedAt: '2026-06-15T09:10:00.000Z',
        reason: 'power',
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.downtime_already_open' })

    const closed = await closeLineDowntime(ctx, {
      downtimeId: opened.downtimeId,
      endedAt: '2026-06-15T09:40:00.000Z',
    })
    expect(closed.minutes).toBe(40)

    const [row] = await db.select().from(downtimes).where(eq(downtimes.id, opened.downtimeId))
    expect(row?.endedAt).not.toBeNull()
  })

  it('refuses a close that predates the start', async () => {
    const opened = await openLineDowntime(ctx, {
      lineId,
      startedAt: '2026-06-15T14:00:00.000Z',
      reason: 'feeding',
    })

    await expect(
      closeLineDowntime(ctx, {
        downtimeId: opened.downtimeId,
        endedAt: '2026-06-15T13:00:00.000Z',
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.downtime_ends_before_start' })

    await closeLineDowntime(ctx, {
      downtimeId: opened.downtimeId,
      endedAt: '2026-06-15T14:15:00.000Z',
    })
  })
})

describe('6.1 · endline and derived', () => {
  it('records the endline count and returns DHU', async () => {
    const result = await recordEndlineCount(ctx, {
      lineId,
      countedOn: DAY,
      checked: 1200,
      passed: 1164,
      defective: 36,
      defects: 36,
      rework: 30,
    })

    expect(result.dhu).toBe('3.00')
    expect(result.passRatePct).toBe('97.00')
  })

  it('refuses a count that adds up to more than was checked', async () => {
    await expect(
      recordEndlineCount(ctx, {
        lineId,
        countedOn: DAY,
        checked: 100,
        passed: 90,
        defective: 20,
        defects: 20,
        rework: 0,
      }),
    ).rejects.toMatchObject({ messageKey: 'production.errors.count_exceeds_checked' })
  })

  it('day-close computes efficiency and is idempotent', async () => {
    const first = await closeDay(ctx, { forDate: DAY })
    expect(first.lines).toBe(1)

    const [row] = await db.select().from(efficiencyDaily).where(eq(efficiencyDaily.lineId, lineId))
    expect(row?.efficiencyPct).toBeTruthy()
    expect(Number(row!.outputTotal)).toBeGreaterThan(0)

    /*
     * The day is as long as the hours the line recorded — not a nominal 480 minutes (§9,
     * F42). Derived from the row count rather than written as a literal because this
     * fixture's hours are shared with the tests above; what must hold is the RELATIONSHIP,
     * whatever the count happens to be.
     */
    const cells = await db
      .select()
      .from(hourlyOutputs)
      .where(sql`${hourlyOutputs.lineId} = ${lineId} and ${hourlyOutputs.producedOn} = ${DAY}`)

    expect(Number(row!.availableMinutes)).toBe(cells.length * 60 * MANPOWER)
    expect(Number(row!.outputTotal)).toBe(cells.reduce((n, c) => n + c.actual, 0))

    // Re-running the day-close must not create a second row — derived tables are
    // rebuildable from source at any time (architecture §4).
    await closeDay(ctx, { forDate: DAY })
    const all = await db.select().from(efficiencyDaily).where(eq(efficiencyDaily.lineId, lineId))
    expect(all).toHaveLength(1)
  })

  it('forecasts completion from the trailing rate', async () => {
    const forecast = await runRate(ctx, {
      orderId,
      remainingQty: 2000,
      asOf: DAY,
      milestoneDate: '2026-06-16',
    })

    expect(forecast.ratePerDay).not.toBe('0.00')
    expect(forecast.forecastDate).toBeTruthy()
    // One day of data only.
    expect(forecast.confidence).toBe('low')
  })

  it('says it cannot forecast an order that has not been sewn', async () => {
    const forecast = await runRate(ctx, {
      orderId: randomUUID(),
      remainingQty: 500,
      asOf: DAY,
    })

    expect(forecast.forecastDate).toBeNull()
    expect(forecast.confidence).toBe('none')
  })
})

/**
 * The nightly run-rate risk alert (brief §Jobs).
 *
 * The forecast maths is covered by unit tests; what matters here is that the job reaches it
 * at all — the event name existed for a while with nothing emitting it, and an alert nobody
 * raises is indistinguishable from an order that is fine.
 */
describe('6.1 · run-rate risk alerts', () => {
  const RISK_DAY = '2026-06-16'
  const systemCtx: SystemCtx = { companyId: COMPANY, userId: null, roles: ['owner'], system: true }

  const alerts = () =>
    db
      .select({ params: notifications.params, severity: notifications.severity })
      .from(notifications)
      .where(eq(notifications.kind, 'production.run_rate.at_risk'))

  beforeAll(async () => {
    await db.insert(orderStyles).values({
      companyId: COMPANY,
      orderId,
      styleCode: 'SH-1',
      contractedQty: 20_000,
    })
    // Two days sewn at ~1,200/day against 20,000 — nowhere near done by the 20th.
    await recordHourlyOutputs(ctx, {
      entries: [8, 9, 10].flatMap((hourSlot) => [
        { lineId, orderId, producedOn: '2026-06-15', hourSlot, target: 400, actual: 400 },
        { lineId, orderId, producedOn: RISK_DAY, hourSlot, target: 400, actual: 400 },
      ]),
    })
  })

  it('stays silent when there is no sewing milestone to be late against', async () => {
    const result = await runRunRateAlerts(systemCtx, { today: RISK_DAY })

    expect(result.checked).toBe(1)
    expect(result.atRisk).toBe(0)
    expect(await alerts()).toHaveLength(0)
  })

  it('alerts, and writes the outbox event, when the forecast lands after sewing end', async () => {
    await db.insert(tnaMilestones).values({
      companyId: COMPANY,
      orderId,
      name: 'sewing_end',
      plannedDate: '2026-06-20',
    })

    const result = await runRunRateAlerts(systemCtx, { today: RISK_DAY })
    expect(result.atRisk).toBe(1)

    const [alert] = await alerts()
    expect(alert?.params).toMatchObject({ poNumber: 'PO-9' })
    expect(Number((alert!.params as { slipDays: number }).slipDays)).toBeGreaterThan(0)

    const events = await db
      .select({ id: outbox.id })
      .from(outbox)
      .where(eq(outbox.eventName, 'production.run_rate.at_risk'))
    expect(events.length).toBeGreaterThan(0)
  })

  it('does not alert twice for a slip that has not changed', async () => {
    const before = (await alerts()).length
    await runRunRateAlerts(systemCtx, { today: RISK_DAY })

    // Same order, same slip — the dedupe key is identical, so the merchandiser is not told
    // the same thing every night until they stop reading the digest.
    expect(await alerts()).toHaveLength(before)
  })
})
