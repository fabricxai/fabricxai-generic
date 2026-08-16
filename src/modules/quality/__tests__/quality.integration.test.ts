/**
 * 7.1 integration.
 *
 * The arithmetic is covered by `quality.test.ts`. What is asserted here is what only a
 * database can be wrong about:
 *
 *  - the AQL plan comes from the SEEDED table and is snapshotted onto the verdict, so a
 *    later revision of the standard cannot re-grade a historic inspection;
 *  - severity comes from `defect_codes`, so an inspector cannot pass a lot by relabelling
 *    a defect on the way in;
 *  - `aql_tables` is readable but NOT writable by the app role;
 *  - day-close DHU is recomputed, so running it twice gives the same answer;
 *  - a replayed offline batch changes no row count;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { syncBatch } from '@/modules/core/offline-sync'
import { withTenantRead, withTenantTx } from '@/modules/core/tenancy'
import { orders, orderStyles } from '@/modules/orders/schema'
import { lines } from '@/modules/planning/schema'
import '@/modules/quality/register'
import {
  aqlTables,
  defectCodes,
  dhuDaily,
  finalInspections,
  inlineChecks,
  measurementChecks,
} from '@/modules/quality/schema'
import {
  captureInlineCheck,
  checkFinalInspectionPassed,
  closeDhuDay,
  createMeasurementSpec,
  inspectFabric,
  resolveFabricInspection,
  recordMeasuredSet,
  recordMeasurementCheck,
  recordThirdPartyResult,
  repeatDefectAlerts,
  runFinalInspection,
  scheduleThirdPartyInspection,
  setFinalInspectionStatus,
  upsertDefectCode,
} from '@/modules/quality/service'
import { supplierPos, suppliers } from '@/modules/procurement/schema'
import { grnLines, grns, items, locations, rolls } from '@/modules/store/schema'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `qc-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['quality'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['quality'] }

const POLICY = {
  aqlStandard: 'ansi-z1.4',
  fabricMaxPointsPer100SqYd: '40',
  dhuAlertThreshold: '5',
  repeatDefectDays: 3,
}

const DAY = '2026-07-28'

let orderId: string
let orderStyleId: string
let lineId: string
let grnId: string

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'QC Co', slug: `qc-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Inspector' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  const [order] = await db
    .insert(orders)
    .values({ companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-1'], createdBy: USER })
    .returning({ id: orders.id })
  orderId = order!.id

  const [style] = await db
    .insert(orderStyles)
    .values({ companyId: COMPANY, orderId, styleCode: 'ST-100', contractedQty: 2000 })
    .returning({ id: orderStyles.id })
  orderStyleId = style!.id

  const [line] = await db
    .insert(lines)
    .values({ companyId: COMPANY, code: 'L-07', name: 'Line 7', capacityManpower: 40 })
    .returning({ id: lines.id })
  lineId = line!.id

  const [item] = await db
    .insert(items)
    .values({ companyId: COMPANY, code: 'FAB-1', name: 'Single Jersey', kind: 'fabric', uom: 'm' })
    .returning({ id: items.id })
  const [grn] = await db
    .insert(grns)
    .values({
      companyId: COMPANY,
      challanNo: `CH-${randomUUID().slice(0, 6)}`,
      receivedAt: '2026-07-01',
      createdBy: USER,
    })
    .returning({ id: grns.id })
  grnId = grn!.id
  await db
    .insert(grnLines)
    .values({ companyId: COMPANY, grnId, itemId: item!.id, qty: '1000.00', unit: 'm' })

  // The taxonomy. Severity lives here, not on the tap.
  for (const code of [
    { category: 'stitching', code: 'BROKEN_STITCH', label: 'Broken stitch', severity: 'major' },
    { category: 'stitching', code: 'SKIP_STITCH', label: 'Skipped stitch', severity: 'minor' },
    { category: 'safety', code: 'NEEDLE', label: 'Broken needle in garment', severity: 'critical' },
    { category: 'finishing', code: 'OIL_STAIN', label: 'Oil stain', severity: 'minor' },
  ] as const) {
    await upsertDefectCode(ctx, code)
  }
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const clearChecks = async () => {
  await db.delete(inlineChecks).where(eq(inlineChecks.companyId, COMPANY))
  await db.delete(dhuDaily).where(eq(dhuDaily.companyId, COMPANY))
}
const clearFinals = async () => {
  await db.delete(finalInspections).where(eq(finalInspections.companyId, COMPANY))
}

const finalInput = (over: Record<string, unknown> = {}) => ({
  orderId,
  orderStyleId,
  inspectionNo: `FI-${randomUUID().slice(0, 8)}`,
  lotQty: 2000,
  inspectionLevel: 'II' as const,
  majorAql: '2.5',
  minorAql: '4.0',
  defects: [],
  ...over,
})

describe('7.1 · aql_tables is reference data, not tenant data', () => {
  it('is readable by the app role under a tenant scope', async () => {
    const rows = await withTenantRead(ctx, async (tx) => tx.select().from(aqlTables))
    // Seeded 2.5/4.0 across fifteen lot bands.
    expect(rows.length).toBe(30)
  })

  it('is NOT writable by the app role', async () => {
    // A published standard editable per tenant is a per-tenant chance to change an
    // acceptance number that decides whether shipments ship.
    await expect(
      withTenantTx(ctx, async (tx) =>
        tx.insert(aqlTables).values({
          standard: 'ansi-z1.4',
          inspectionLevel: 'II',
          aqlLevel: '9.9',
          lotFrom: 1,
          lotTo: 10,
          sampleSize: 1,
          accept: 99,
          reject: 100,
        }),
      ),
      // Drizzle wraps the driver error, so the privilege refusal is on the cause rather
      // than the top-level message.
    ).rejects.toMatchObject({
      cause: expect.objectContaining({ message: expect.stringMatching(/permission denied/i) }),
    })
  })

  it('grants the app login role SELECT and nothing else', async () => {
    const result = await db.execute<{ can_insert: boolean; can_select: boolean }>(sql`
      select has_table_privilege('fabricxai_app_rw', 'aql_tables', 'INSERT') as can_insert,
             has_table_privilege('fabricxai_app_rw', 'aql_tables', 'SELECT') as can_select`)
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    const row = rows[0] as { can_insert: boolean; can_select: boolean }

    expect(row.can_select).toBe(true)
    expect(row.can_insert).toBe(false)
  })
})

describe('7.1 · final inspection ⚖', () => {
  it('reads the plan from the seeded table and snapshots it onto the verdict', async () => {
    await clearFinals()
    const result = await runFinalInspection(ctx, finalInput(), POLICY)

    // Lot 2,000 → level II code letter K → sample 125; 2.5 accepts 7, 4.0 accepts 10.
    const [row] = await db
      .select()
      .from(finalInspections)
      .where(eq(finalInspections.id, result.finalInspectionId))

    expect(row!.sampleSize).toBe(125)
    expect(row!.majorAccept).toBe(7)
    expect(row!.minorAccept).toBe(10)
    expect(row!.standard).toBe('ansi-z1.4')
    expect(row!.verdict).toBe('pass')
  })

  it('takes severity from defect_codes, not from the caller', async () => {
    await clearFinals()
    // Eight BROKEN_STITCH. That code is `major`, and 8 > 7, so the lot fails — the caller
    // never said "major" anywhere.
    const result = await runFinalInspection(
      ctx,
      finalInput({ defects: [{ code: 'BROKEN_STITCH', count: 8 }] }),
      POLICY,
    )

    expect(result.outcome.verdict).toBe('fail')
    expect(result.outcome.reasons[0]).toMatchObject({ code: 'major_over_aql', found: 8, accept: 7 })
  })

  it('does not net majors against minors', async () => {
    await clearFinals()
    // 8 major + 0 minor. A combined "8 against 17" reading would pass this and the
    // container would ship.
    const netted = await runFinalInspection(
      ctx,
      finalInput({ defects: [{ code: 'BROKEN_STITCH', count: 8 }] }),
      POLICY,
    )
    expect(netted.outcome.verdict).toBe('fail')

    // And the mirror: 10 minors alone is a pass at 4.0, which a combined reading would
    // also get wrong in the other direction.
    await clearFinals()
    const minorsOnly = await runFinalInspection(
      ctx,
      finalInput({ defects: [{ code: 'SKIP_STITCH', count: 10 }] }),
      POLICY,
    )
    expect(minorsOnly.outcome.verdict).toBe('pass')
  })

  it('fails on a single critical defect whatever else is found', async () => {
    await clearFinals()
    const result = await runFinalInspection(
      ctx,
      finalInput({ defects: [{ code: 'NEEDLE', count: 1 }] }),
      POLICY,
    )

    expect(result.outcome.verdict).toBe('fail')
    expect(result.outcome.reasons[0]!.code).toBe('critical_defect')
  })

  it('refuses a defect code nobody defined rather than filing it as minor', async () => {
    await clearFinals()
    await expect(
      runFinalInspection(ctx, finalInput({ defects: [{ code: 'MYSTERY', count: 1 }] }), POLICY),
    ).rejects.toThrow(/unknown_defect_codes/)
  })

  it('refuses an AQL level the seeded table does not carry', async () => {
    await clearFinals()
    // 1.0 is not seeded on purpose — substituting 2.5 would apply a standard the buyer did
    // not agree to.
    await expect(
      runFinalInspection(ctx, finalInput({ majorAql: '1.0' }), POLICY),
    ).rejects.toThrow()
  })

  it('inspects the whole lot when the plan’s sample exceeds it', async () => {
    await clearFinals()
    const result = await runFinalInspection(ctx, finalInput({ lotQty: 4 }), POLICY)

    const [row] = await db
      .select()
      .from(finalInspections)
      .where(eq(finalInspections.id, result.finalInspectionId))

    // The table says 5 for a lot of 2–8; there are only 4 garments.
    expect(row!.sampleSize).toBe(4)
    expect(row!.hundredPercent).toBe(true)
  })

  it('the latest inspection decides whether an order has passed', async () => {
    await clearFinals()
    await runFinalInspection(ctx, finalInput(), POLICY)

    const passed = await checkFinalInspectionPassed(ctx, { orderId })
    expect(passed.passed).toBe(true)

    // Reworked, re-presented, failed. "Has ever passed" would ship this.
    await runFinalInspection(
      ctx,
      finalInput({ defects: [{ code: 'BROKEN_STITCH', count: 9 }] }),
      POLICY,
    )

    const now = await checkFinalInspectionPassed(ctx, { orderId })
    expect(now.passed).toBe(false)
    expect(now.reasonKey).toBe('gates.final_inspection.failed')
  })

  it('reports no inspection as not passed, not as absent of opinion', async () => {
    await clearFinals()
    const result = await checkFinalInspectionPassed(ctx, { orderId })

    expect(result.passed).toBe(false)
    expect(result.reasonKey).toBe('gates.final_inspection.none')
  })

  it('rejects an illegal status transition', async () => {
    await clearFinals()
    const result = await runFinalInspection(ctx, finalInput(), POLICY)

    await expect(
      setFinalInspectionStatus(ctx, {
        finalInspectionId: result.finalInspectionId,
        status: 'reinspection_required',
      }),
    ).rejects.toThrow()

    await setFinalInspectionStatus(ctx, {
      finalInspectionId: result.finalInspectionId,
      status: 'submitted',
    })
    await setFinalInspectionStatus(ctx, {
      finalInspectionId: result.finalInspectionId,
      status: 'reinspection_required',
    })
  })
})

describe('7.1 · inline capture and DHU', () => {
  it('derives the defect total and refuses an unknown code', async () => {
    await clearChecks()
    const result = await captureInlineCheck(ctx, {
      lineId,
      orderId,
      operation: 'side-seam',
      checkedQty: 100,
      checkedOn: DAY,
      defects: [
        { code: 'BROKEN_STITCH', count: 2 },
        { code: 'SKIP_STITCH', count: 1 },
      ],
    })

    expect(result.defectQty).toBe(3)

    await expect(
      captureInlineCheck(ctx, {
        lineId,
        operation: 'hem',
        checkedQty: 10,
        checkedOn: DAY,
        defects: [{ code: 'NOPE', count: 1 }],
      }),
    ).rejects.toThrow(/unknown_defect_codes/)
  })

  it('day-close DHU is recomputed, so running it twice gives the same answer', async () => {
    await clearChecks()
    await captureInlineCheck(ctx, {
      lineId,
      orderId,
      operation: 'side-seam',
      checkedQty: 200,
      checkedOn: DAY,
      defects: [{ code: 'BROKEN_STITCH', count: 4 }],
    })
    await captureInlineCheck(ctx, {
      lineId,
      orderId,
      operation: 'hem',
      checkedQty: 200,
      checkedOn: DAY,
      defects: [{ code: 'SKIP_STITCH', count: 8 }],
    })

    // 12 defects in 400 checked = 3.00 DHU.
    const first = await closeDhuDay(ctx, { lineId, date: DAY }, POLICY)
    expect(first.dhu).toBe('3.00')
    expect(first.alert).toBe(false)

    const second = await closeDhuDay(ctx, { lineId, date: DAY }, POLICY)
    expect(second).toEqual(first)

    const rows = await db.select().from(dhuDaily).where(eq(dhuDaily.lineId, lineId))
    expect(rows).toHaveLength(1)
  })

  it('alerts past the threshold', async () => {
    await clearChecks()
    await captureInlineCheck(ctx, {
      lineId,
      orderId,
      operation: 'side-seam',
      checkedQty: 100,
      checkedOn: DAY,
      defects: [{ code: 'BROKEN_STITCH', count: 10 }],
    })

    const result = await closeDhuDay(ctx, { lineId, date: DAY }, POLICY)
    expect(result.dhu).toBe('10.00')
    expect(result.alert).toBe(true)
  })

  it('refuses to write a zero DHU for a day nobody inspected', async () => {
    await clearChecks()
    // A 0 on a buyer's trend for an uninspected day reads as a perfect day.
    await expect(closeDhuDay(ctx, { lineId, date: '2026-07-01' }, POLICY)).rejects.toThrow(
      /no_inline_checks/,
    )
  })

  it('finds a repeat-defect pattern across consecutive days', async () => {
    await clearChecks()
    for (const date of ['2026-07-26', '2026-07-27', '2026-07-28']) {
      await captureInlineCheck(ctx, {
        lineId,
        orderId,
        operation: 'side-seam',
        checkedQty: 100,
        checkedOn: date,
        defects: [{ code: 'BROKEN_STITCH', count: 1 }],
      })
    }

    const runs = await repeatDefectAlerts(
      ctx,
      { from: '2026-07-20', to: '2026-07-31', lineId },
      POLICY,
    )

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ code: 'BROKEN_STITCH', operation: 'side-seam', days: 3 })
  })

  it('is idempotent on an offline replay', async () => {
    await clearChecks()
    const batch = [
      {
        offlineKey: `qc-${randomUUID()}`,
        moduleId: 'quality',
        operation: 'inline_check',
        payload: {
          lineId,
          orderId,
          operation: 'side-seam',
          checkedQty: 100,
          checkedOn: DAY,
          defects: [{ code: 'BROKEN_STITCH', count: 1 }],
        } as Record<string, unknown>,
      },
    ]

    expect((await syncBatch(ctx, batch))[0]!.status).toBe('applied')
    expect((await syncBatch(ctx, batch))[0]!.status).toBe('duplicate')

    const rows = await db.select().from(inlineChecks).where(eq(inlineChecks.companyId, COMPANY))
    expect(rows).toHaveLength(1)
  })
})

describe('7.1 · fabric 4-point', () => {
  it('grades a roll on its rate, not its point count', async () => {
    // 16 band-4 defects = 64 points. On 100 yd × 60" that is 38.40/100 sq yd — a pass.
    const wide = await inspectFabric(
      ctx,
      {
        grnId,
        points4: { 1: 0, 2: 0, 3: 0, 4: 16 },
        inspectedLengthYards: '100',
        widthInches: '60',
      },
      POLICY,
    )
    expect(wide.pointsPer100SqYd).toBe('38.40')
    expect(wide.result).toBe('pass')

    // Same defects, 36" wide: 64.00 — a fail.
    const narrow = await inspectFabric(
      ctx,
      {
        grnId,
        points4: { 1: 0, 2: 0, 3: 0, 4: 16 },
        inspectedLengthYards: '100',
        widthInches: '36',
      },
      POLICY,
    )
    expect(narrow.result).toBe('fail')
  })
})

describe('7.1 · measurements', () => {
  it('honours asymmetric tolerances in both directions', async () => {
    const spec = await createMeasurementSpec(ctx, {
      styleCode: 'ST-100',
      unit: 'cm',
      points: [
        { name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.25' },
        { name: 'Length', spec: '72.00', tolPlus: '1.00', tolMinus: '1.00' },
      ],
    })

    const ok = await recordMeasurementCheck(ctx, {
      measurementSpecId: spec.measurementSpecId,
      orderId,
      sampledSize: 'M',
      values: { Chest: '52.40', Length: '72.00' },
    })
    expect(ok.result).toBe('pass')

    // Same magnitude of deviation, the other way: out of spec.
    const bad = await recordMeasurementCheck(ctx, {
      measurementSpecId: spec.measurementSpecId,
      orderId,
      sampledSize: 'M',
      values: { Chest: '51.60', Length: '72.00' },
    })
    expect(bad.result).toBe('fail')
  })

  it('an unmeasured point fails the check rather than passing quietly', async () => {
    const spec = await createMeasurementSpec(ctx, {
      styleCode: 'ST-200',
      points: [
        { name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.50' },
        { name: 'Sleeve', spec: '24.00', tolPlus: '0.50', tolMinus: '0.50' },
      ],
    })

    const result = await recordMeasurementCheck(ctx, {
      measurementSpecId: spec.measurementSpecId,
      orderId,
      sampledSize: 'M',
      values: { Chest: '52.00' },
    })

    expect(result.result).toBe('fail')
    expect(result.missing).toEqual(['Sleeve'])
  })

  it('versions a spec instead of editing it', async () => {
    const first = await createMeasurementSpec(ctx, {
      styleCode: 'ST-300',
      points: [{ name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.50' }],
    })
    const second = await createMeasurementSpec(ctx, {
      styleCode: 'ST-300',
      points: [{ name: 'Chest', spec: '53.00', tolPlus: '0.50', tolMinus: '0.50' }],
    })

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)
  })
})

describe('7.1 · third-party inspections', () => {
  it('records a result once and refuses to revise it', async () => {
    const booking = await scheduleThirdPartyInspection(ctx, {
      orderId,
      agency: 'sgs',
      scheduledAt: '2026-08-10T09:00:00Z',
    })

    await recordThirdPartyResult(ctx, {
      thirdPartyInspectionId: booking.thirdPartyInspectionId,
      result: 'pass',
    })

    // The agency's verdict is not ours to revise; a re-inspection is a new booking.
    await expect(
      recordThirdPartyResult(ctx, {
        thirdPartyInspectionId: booking.thirdPartyInspectionId,
        result: 'fail',
      }),
    ).rejects.toThrow(/already_resulted/)
  })

  it('requires a name when the agency is not one of the majors', async () => {
    await expect(
      scheduleThirdPartyInspection(ctx, {
        orderId,
        agency: 'other',
        scheduledAt: '2026-08-10T09:00:00Z',
      }),
    ).rejects.toThrow()
  })
})

describe('7.1 · tenancy', () => {
  it('another company sees no checks, codes or verdicts', async () => {
    await clearChecks()
    await clearFinals()
    await captureInlineCheck(ctx, {
      lineId,
      orderId,
      operation: 'side-seam',
      checkedQty: 100,
      checkedOn: DAY,
      defects: [{ code: 'BROKEN_STITCH', count: 1 }],
    })
    await runFinalInspection(ctx, finalInput(), POLICY)

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      checks: await tx.select().from(inlineChecks),
      codes: await tx.select().from(defectCodes),
      finals: await tx.select().from(finalInspections),
    }))

    expect(seen.checks).toHaveLength(0)
    expect(seen.codes).toHaveLength(0)
    expect(seen.finals).toHaveLength(0)
  })

  it('another company cannot inspect against this factory’s line', async () => {
    await expect(
      captureInlineCheck(otherCtx, {
        lineId,
        operation: 'side-seam',
        checkedQty: 10,
        checkedOn: DAY,
        defects: [],
      }),
    ).rejects.toThrow(/line_not_found/)
  })
})

describe('7.1 · a size is measured as one thing (plan 4.1, audit FE-H5)', () => {
  /*
   * The action looped over `recordMeasurementCheck`, and each call opened its own
   * transaction — so a bad value on piece 2 left piece 1 committed and piece 3 never
   * attempted. The action's own comment claimed the opposite, which is how it survived: the
   * intent was written down and the code did something else.
   *
   * A half-measured size is worse than an unmeasured one. It reads as a completed check on
   * a buyer report with two of the three garments silently absent.
   */
  it('writes every piece or none of them', async () => {
    const spec = await createMeasurementSpec(ctx, {
      styleCode: 'ST-ATOMIC',
      points: [{ name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.50' }],
    })

    await expect(
      recordMeasuredSet(ctx, {
        measurementSpecId: spec.measurementSpecId,
        orderId,
        sampledSize: 'M',
        pieces: [
          { Chest: '52.00' },
          // Not a number the chart can be read against. Under the old loop, piece 1 was
          // already filed by the time this threw.
          { Chest: 'not-a-number' },
          { Chest: '52.10' },
        ],
      }),
    ).rejects.toThrow()

    const rows = await withTenantRead(ctx, (tx) =>
      tx
        .select()
        .from(measurementChecks)
        .where(eq(measurementChecks.measurementSpecId, spec.measurementSpecId)),
    )
    expect(rows).toHaveLength(0)
  })

  it('files a failing piece beside its passing ones rather than refusing the set', async () => {
    // Out of tolerance is a RESULT, not an error. Two of three passing is exactly the
    // sentence a buyer report needs, and refusing the set would lose the measurement.
    const spec = await createMeasurementSpec(ctx, {
      styleCode: 'ST-MIXED',
      points: [{ name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.50' }],
    })

    const set = await recordMeasuredSet(ctx, {
      measurementSpecId: spec.measurementSpecId,
      orderId,
      sampledSize: 'L',
      pieces: [{ Chest: '52.00' }, { Chest: '51.00' }, { Chest: '52.20' }],
    })

    expect(set.pieces.map((p) => p.result)).toEqual(['pass', 'fail', 'pass'])
    expect(set.duplicate).toBe(false)
  })

  it('a resent size does not double the pieces', async () => {
    const spec = await createMeasurementSpec(ctx, {
      styleCode: 'ST-REPLAY',
      points: [{ name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.50' }],
    })
    const offlineKey = `meas-${randomUUID()}`

    const batch = [
      {
        offlineKey,
        moduleId: 'quality',
        operation: 'measurement_set',
        payload: {
          measurementSpecId: spec.measurementSpecId,
          orderId,
          sampledSize: 'S',
          pieces: [{ Chest: '52.00' }, { Chest: '52.10' }],
        },
      },
    ]

    expect((await syncBatch(ctx, batch))[0]?.status).toBe('applied')
    expect((await syncBatch(ctx, batch))[0]?.status).toBe('duplicate')

    const rows = await withTenantRead(ctx, (tx) =>
      tx
        .select()
        .from(measurementChecks)
        .where(eq(measurementChecks.measurementSpecId, spec.measurementSpecId)),
    )
    expect(rows).toHaveLength(2)
    // One key across the whole size — the unit a QC actually captures.
    expect(rows.every((r) => r.offlineKey === offlineKey)).toBe(true)
  })

  it('returns the original set when the same key comes back through the service', async () => {
    // The desk-retry path, which the sync ledger does not cover. Same shape as sampling's
    // verdict guard: return what landed rather than filing it again.
    const spec = await createMeasurementSpec(ctx, {
      styleCode: 'ST-RETRY',
      points: [{ name: 'Chest', spec: '52.00', tolPlus: '0.50', tolMinus: '0.50' }],
    })
    const offlineKey = `desk-${randomUUID()}`
    const input = {
      measurementSpecId: spec.measurementSpecId,
      orderId,
      sampledSize: 'XL',
      pieces: [{ Chest: '52.00' }, { Chest: '51.00' }],
      offlineKey,
    }

    const first = await recordMeasuredSet(ctx, input)
    const again = await recordMeasuredSet(ctx, input)

    expect(again.duplicate).toBe(true)
    expect(again.pieces.map((p) => p.measurementCheckId)).toEqual(
      first.pieces.map((p) => p.measurementCheckId),
    )
    // And the failing piece did not raise its alarm a second time.
    const emitted = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from outbox
          where company_id = ${COMPANY}
            and event_name = 'quality.measurement.failed'
            and aggregate_id = ${first.pieces[1]!.measurementCheckId}`,
    )
    expect(Number(emitted[0]!.n)).toBe(1)
  })
})

describe('7.1 · a final inspection survives the network (plan 4.1)', () => {
  const lot = (inspectionNo: string) => ({
    orderId,
    inspectionNo,
    lotQty: 1200,
    inspectionLevel: 'II',
    majorAql: '2.5',
    minorAql: '4.0',
    defects: [{ code: 'SKIP_STITCH', count: 1 }],
  })

  it('queues from the finishing floor and returns the server s verdict', async () => {
    const inspectionNo = `FI-Q-${randomUUID().slice(0, 6)}`
    const batch = [
      {
        offlineKey: `fi-${randomUUID()}`,
        moduleId: 'quality',
        operation: 'final_inspection',
        payload: lot(inspectionNo),
      },
    ]

    const [applied] = await syncBatch(ctx, batch)
    expect(applied?.status).toBe('applied')

    const [row] = await withTenantRead(ctx, (tx) =>
      tx.select().from(finalInspections).where(eq(finalInspections.inspectionNo, inspectionNo)),
    )
    // Still computed on the server from the seeded table — queuing changed WHEN the
    // inspector learns the verdict, not who decides it.
    expect(row?.verdict).toBe('pass')
    expect(row?.sampleSize).toBeGreaterThan(0)
    expect(row?.standard).toBe('ansi-z1.4')
  })

  it('a replayed inspection returns the verdict rather than a refusal', async () => {
    /*
     * `inspection_no` is unique per company, so a resend would already have been stopped —
     * but as a constraint violation, and a refused row is REMEMBERED as refused. The tablet
     * would have shown the inspector that their inspection failed, for a lot that passed.
     */
    const offlineKey = `fi-replay-${randomUUID()}`
    const inspectionNo = `FI-R-${randomUUID().slice(0, 6)}`
    const batch = [
      {
        offlineKey,
        moduleId: 'quality',
        operation: 'final_inspection',
        payload: lot(inspectionNo),
      },
    ]

    const first = await syncBatch(ctx, batch)
    expect(first[0]?.status).toBe('applied')

    const replay = await syncBatch(ctx, batch)
    expect(replay[0]?.status).toBe('duplicate')
    expect((replay[0] as { rowId: string }).rowId).toBe((first[0] as { rowId: string }).rowId)

    const rows = await withTenantRead(ctx, (tx) =>
      tx.select().from(finalInspections).where(eq(finalInspections.inspectionNo, inspectionNo)),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.offlineKey).toBe(offlineKey)
  })
})

/**
 * The 4-point gate, and which rolls it is entitled to skip.
 *
 * The exemption is for cloth the factory MADE: a knit composite house knits its own greige
 * and grades it on the machine, so waiting for a 4-point sheet nobody produces would stop
 * its store. It used to be written as a company-wide `factoryType !== 'woven'` escape, and
 * that quietly exempted cloth the factory BOUGHT as well — a knit house making denim
 * jackets imports woven denim by the container, with the mill's own inspection sheet in the
 * packet, and the rolls that sheet failed went to the cutting table with the gate returning
 * "passed" without looking (live-test kit, Phase 4 · rolls R-D-19..21).
 *
 * A purchase order behind the receipt is what separates the two: somebody sold this cloth
 * to the factory, so somebody else made it, so the exemption cannot reach it.
 */
describe('7.1 · the 4-point gate in a knit composite house', () => {
  let boughtRollId: string
  let ownRollId: string

  beforeAll(async () => {
    const { upsertCompanyProfile } = await import('@/modules/settings/service')
    await upsertCompanyProfile({ ...ctx, roles: ['owner'] }, {
      legalName: 'Knit Composite Ltd',
      factoryType: 'knit-composite',
    })

    const [supplier] = await db
      .insert(suppliers)
      .values({ companyId: COMPANY, code: 'MILL', name: 'Foshan Denim Mills', type: 'fabric_mill', origin: 'import' })
      .returning({ id: suppliers.id })
    const [po] = await db
      .insert(supplierPos)
      .values({
        companyId: COMPANY,
        supplierId: supplier!.id,
        poNumber: `SPO-${randomUUID().slice(0, 6)}`,
        currency: 'USD',
        totalValue: '1000.00',
        createdBy: USER,
      })
      .returning({ id: supplierPos.id })

    const [denim] = await db
      .insert(items)
      .values({ companyId: COMPANY, code: 'FAB-DEN', name: '12oz denim', kind: 'fabric', uom: 'yds' })
      .returning({ id: items.id })
    const [location] = await db
      .insert(locations)
      .values({ companyId: COMPANY, code: 'BOND', name: 'Bonded', kind: 'bonded' })
      .returning({ id: locations.id })

    // Bought: a GRN with a purchase order behind it.
    const [boughtGrn] = await db
      .insert(grns)
      .values({
        companyId: COMPANY,
        challanNo: `IMP-${randomUUID().slice(0, 6)}`,
        receivedAt: '2026-07-05',
        supplierPoId: po!.id,
        createdBy: USER,
      })
      .returning({ id: grns.id })
    const [boughtLine] = await db
      .insert(grnLines)
      .values({ companyId: COMPANY, grnId: boughtGrn!.id, itemId: denim!.id, qty: '1300.00', unit: 'yds' })
      .returning({ id: grnLines.id })
    const [boughtRoll] = await db
      .insert(rolls)
      .values({
        companyId: COMPANY,
        grnLineId: boughtLine!.id,
        itemId: denim!.id,
        rollNo: 'R-D-19',
        qty: '1300.00',
        unit: 'yds',
        locationId: location!.id,
      })
      .returning({ id: rolls.id })
    boughtRollId = boughtRoll!.id

    // Own: dyed here, no purchase order, nobody to send a claim to.
    const [ownGrn] = await db
      .insert(grns)
      .values({
        companyId: COMPANY,
        challanNo: `DYE-${randomUUID().slice(0, 6)}`,
        receivedAt: '2026-07-06',
        // Said, not inferred. This used to be an empty `supplierPoId` and nothing else,
        // which is exactly how every bought delivery earned the exemption.
        source: 'own_production',
        createdBy: USER,
      })
      .returning({ id: grns.id })
    const [ownLine] = await db
      .insert(grnLines)
      .values({ companyId: COMPANY, grnId: ownGrn!.id, itemId: denim!.id, qty: '200.00', unit: 'yds' })
      .returning({ id: grnLines.id })
    const [ownRoll] = await db
      .insert(rolls)
      .values({
        companyId: COMPANY,
        grnLineId: ownLine!.id,
        itemId: denim!.id,
        rollNo: 'R-P-01',
        qty: '200.00',
        unit: 'yds',
        locationId: location!.id,
      })
      .returning({ id: rolls.id })
    ownRollId = ownRoll!.id

    // The mill's sheet: this roll failed.
    await inspectFabric(
      ctx,
      {
        grnId: boughtGrn!.id,
        rollId: boughtRollId,
        // 1,000 points over 1,300 yd of 58" cloth is 47.7 per 100 sq yd, against a 40
        // threshold — a consignment a mill would expect a claim for, not a borderline call.
        points4: { 1: 100, 2: 100, 3: 100, 4: 100 },
        inspectedLengthYards: '1300.00',
        widthInches: '58.00',
      },
      POLICY as never,
    )
  })

  it('blocks a bought roll the mill’s own sheet failed', async () => {
    const verdict = await withTenantRead(ctx, (tx) =>
      resolveFabricInspection(ctx, tx, { rollIds: [boughtRollId] }),
    )
    expect(verdict.passed).toBe(false)
    expect(verdict.reasonKey).toBe('gates.fabric_inspection.failed')
  })

  it('still lets the factory issue the cloth it made itself', async () => {
    const verdict = await withTenantRead(ctx, (tx) =>
      resolveFabricInspection(ctx, tx, { rollIds: [ownRollId] }),
    )
    expect(verdict.passed).toBe(true)
  })

  it('blocks a delivery that never said where it came from', async () => {
    /*
     * The Nordkap §6e failure, in one case. `/store/receive` did not capture a purchase
     * order, so every delivery it recorded had an empty `supplierPoId` — and the exemption
     * read that emptiness as proof the factory had knitted the cloth itself. An imported,
     * bonded, back-to-back funded delivery from a Chinese mill was waved through, and rolls
     * failing at 27 and 22 points against a 20-point limit reached the cutting floor.
     *
     * Absence is not evidence. A receipt that says nothing is gated.
     */
    const [denim] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: items.id }).from(items).where(eq(items.code, 'FAB-DEN')),
    )
    const [location] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: locations.id }).from(locations).where(eq(locations.code, 'BOND')),
    )
    const [silentGrn] = await db
      .insert(grns)
      .values({
        companyId: COMPANY,
        challanNo: `SILENT-${randomUUID().slice(0, 6)}`,
        receivedAt: '2026-07-07',
        // No purchase order, and no claim of own production — the shape every receipt made
        // through the screen had before the door asked.
        createdBy: USER,
      })
      .returning({ id: grns.id })
    const [silentLine] = await db
      .insert(grnLines)
      .values({ companyId: COMPANY, grnId: silentGrn!.id, itemId: denim!.id, qty: '150.00', unit: 'yds' })
      .returning({ id: grnLines.id })
    const [silentRoll] = await db
      .insert(rolls)
      .values({
        companyId: COMPANY,
        grnLineId: silentLine!.id,
        itemId: denim!.id,
        rollNo: `R-S-${randomUUID().slice(0, 4)}`,
        qty: '150.00',
        unit: 'yds',
        locationId: location!.id,
      })
      .returning({ id: rolls.id })

    const verdict = await withTenantRead(ctx, (tx) =>
      resolveFabricInspection(ctx, tx, { rollIds: [silentRoll!.id] }),
    )

    expect(verdict.passed).toBe(false)
    expect(verdict.reasonKey).toBe('gates.fabric_inspection.not_inspected')
  })

  it('blocks a bought roll nobody inspected at all', async () => {
    const [denim] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: items.id }).from(items).where(eq(items.code, 'FAB-DEN')),
    )
    const [line] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: grnLines.id }).from(grnLines).where(eq(grnLines.itemId, denim!.id)),
    )
    const [location] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: locations.id }).from(locations).where(eq(locations.code, 'BOND')),
    )
    const [uninspected] = await db
      .insert(rolls)
      .values({
        companyId: COMPANY,
        grnLineId: line!.id,
        itemId: denim!.id,
        rollNo: 'R-D-99',
        qty: '900.00',
        unit: 'yds',
        locationId: location!.id,
      })
      .returning({ id: rolls.id })

    const verdict = await withTenantRead(ctx, (tx) =>
      resolveFabricInspection(ctx, tx, { rollIds: [uninspected!.id] }),
    )
    expect(verdict.passed).toBe(false)
    expect(verdict.reasonKey).toBe('gates.fabric_inspection.not_inspected')
  })
})
