/**
 * 2.1 integration — LC register and bank docs.
 *
 * The arithmetic is covered by `bank-docs.test.ts`. What is asserted here:
 *
 *  - an amendment re-runs the conflict detector against the AMENDED terms and stores what it
 *    found, so a tightening that breaks orders is visible the day it happens;
 *  - the BTB headroom gate counts the PROPOSED BTB, not just the existing ones;
 *  - a discrepant submission cannot exist without notes, and a large realization shortfall
 *    cannot be posted without a reason;
 *  - `finance.realized` carries both amounts, because the difference is what the bank kept;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { auditLog, companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import '@/modules/commercial/register'
import { btbLcs, docSubmissions, lcAmendments, lcs } from '@/modules/commercial/schema'
import {
  agingDiscrepancies,
  amendLc,
  buyerRealizationLag,
  createLc,
  linkOrder,
  openBtb,
  openSubmission,
  postRealization,
  recordBankCharge,
  setSubmissionStatus,
} from '@/modules/commercial/service'
import type { RequestCtx } from '@/modules/core/ctx'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderLcs, orders } from '@/modules/orders/schema'
import { shipments } from '@/modules/shipment/schema'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `lc-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['commercial'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['commercial'] }

const POLICY = {
  discrepancyEscalateAfterDays: 5,
  explainShortfallAbovePct: '5',
  btbLimitPct: 75,
}

let buyerId: string
let orderId: string

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'LC Co', slug: `lc-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Commercial' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  buyerId = buyer!.id

  const [order] = await db
    .insert(orders)
    .values({
      companyId: COMPANY,
      buyerId,
      poNumbers: ['PO-1'],
      // Ships 20 September — fine under the original terms, late under a tightening.
      plannedExFactoryDate: '2026-09-20',
      createdBy: USER,
    })
    .returning({ id: orders.id })
  orderId = order!.id
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

/**
 * A real shipment to present against.
 *
 * The suite used to pass `randomUUID()` here — a shipment id that referenced nothing, which
 * nothing noticed because `doc_submissions.shipment_id` has no FK. Since the EXP gate landed
 * on this path (audit BE-H2 sibling, plan 2.2), a presentation is opened against a shipment
 * that exists and carries its EXP number, which is what the bank actually requires.
 */
let shipmentSeq = 0
const newShipment = async (expNumber: string | null = 'EXP-2026-000123') => {
  shipmentSeq += 1
  const [row] = await db
    .insert(shipments)
    .values({
      companyId: COMPANY,
      orderId,
      partialNo: shipmentSeq,
      plannedExFactory: '2026-07-01',
      expNumber,
    })
    .returning({ id: shipments.id })
  return row!.id
}

const newLc = async (over: Record<string, unknown> = {}) => {
  const [lc] = await db
    .insert(lcs)
    .values({
      companyId: COMPANY,
      buyerId,
      number: `LC-${randomUUID().slice(0, 8)}`,
      value: '100000.00',
      currency: 'USD',
      tolerancePct: '5',
      latestShipmentDate: '2026-09-30',
      expiryDate: '2026-10-15',
      status: 'active',
      createdBy: USER,
      ...over,
    })
    .returning({ id: lcs.id })
  return lc!.id
}

/** Link an order to the LC so the detector has something to check. */
const link = async (lcId: string) => {
  await db.insert(orderLcs).values({ companyId: COMPANY, orderId, lcId })
}

const clearSubmissions = async () => {
  await db.delete(docSubmissions).where(eq(docSubmissions.companyId, COMPANY))
}

describe('2.1 · amending an LC', () => {
  it('applies the diff, versions it, and records what moved', async () => {
    const lcId = await newLc()
    const result = await amendLc(ctx, {
      lcId,
      diff: { latestShipmentDate: '2026-10-10' },
      receivedAt: '2026-07-30',
    })

    expect(result.number).toBe(1)
    expect(result.tightened).toBe(false)

    const [lc] = await db.select().from(lcs).where(eq(lcs.id, lcId))
    expect(lc!.latestShipmentDate).toBe('2026-10-10')
    // Untouched — an amendment is a diff, not a replacement.
    expect(lc!.value).toBe('100000.00')

    const [amendment] = await db
      .select()
      .from(lcAmendments)
      .where(eq(lcAmendments.id, result.amendmentId))
    expect(amendment!.diff).toEqual([
      { field: 'latestShipmentDate', from: '2026-09-30', to: '2026-10-10' },
    ])
  })

  it('numbers amendments consecutively per LC', async () => {
    const lcId = await newLc()
    const first = await amendLc(ctx, {
      lcId,
      diff: { tolerancePct: '10' },
      receivedAt: '2026-07-01',
    })
    const second = await amendLc(ctx, {
      lcId,
      diff: { value: '120000.00' },
      receivedAt: '2026-07-15',
    })

    expect(first.number).toBe(1)
    expect(second.number).toBe(2)
  })

  it('re-runs the conflict detector against the AMENDED terms', async () => {
    const lcId = await newLc()
    await link(lcId)

    // The order ships 20 September. Pulling the shipping deadline back to 1 August makes it
    // late — a conflict that did not exist an hour ago.
    const result = await amendLc(ctx, {
      lcId,
      diff: { latestShipmentDate: '2026-08-01', expiryDate: '2026-08-20' },
      receivedAt: '2026-07-30',
    })

    expect(result.tightened).toBe(true)
    expect(result.conflicts.length).toBeGreaterThan(0)

    // Stored on the amendment, so somebody can see WHICH amendment caused them.
    const [amendment] = await db
      .select()
      .from(lcAmendments)
      .where(eq(lcAmendments.id, result.amendmentId))
    expect((amendment!.conflictsAfter as unknown[]).length).toBeGreaterThan(0)

    await db.delete(orderLcs).where(eq(orderLcs.lcId, lcId))
  })

  it('refuses a no-op amendment and a currency change', async () => {
    const lcId = await newLc()

    await expect(
      amendLc(ctx, { lcId, diff: { value: '100000.00' }, receivedAt: '2026-07-30' }),
    ).rejects.toThrow()
    await expect(
      amendLc(ctx, { lcId, diff: { currency: 'EUR' }, receivedAt: '2026-07-30' }),
    ).rejects.toThrow()
  })

  it('refuses to amend a closed credit', async () => {
    const lcId = await newLc({ status: 'closed' })
    await expect(
      amendLc(ctx, { lcId, diff: { tolerancePct: '10' }, receivedAt: '2026-07-30' }),
    ).rejects.toThrow(/not_amendable/)
  })
})

describe('2.1 · opening a BTB', () => {
  it('opens one inside the master’s headroom', async () => {
    const masterLcId = await newLc()
    const result = await openBtb(
      ctx,
      {
        masterLcId,
        number: `BTB-${randomUUID().slice(0, 6)}`,
        value: '40000.00',
        currency: 'USD',
      },
      POLICY,
    )

    // 75% of 100,000 = 75,000 ceiling; 40,000 used leaves 35,000.
    expect(result.headroom.free).toBe('35000.00')
  })

  it('counts the PROPOSED BTB against the ceiling, not just the existing ones', async () => {
    const masterLcId = await newLc()
    await openBtb(
      ctx,
      { masterLcId, number: `BTB-A-${randomUUID().slice(0, 6)}`, value: '40000.00', currency: 'USD' },
      POLICY,
    )

    // 40,000 already open. A 40,000 second one totals 80,000 against a 75,000 ceiling —
    // checking only what EXISTS would approve every BTB up to the limit and then one more.
    await expect(
      openBtb(
        ctx,
        {
          masterLcId,
          number: `BTB-B-${randomUUID().slice(0, 6)}`,
          value: '40000.00',
          currency: 'USD',
        },
        POLICY,
      ),
    ).rejects.toThrow(/exceeded/)

    const rows = await db.select().from(btbLcs).where(eq(btbLcs.masterLcId, masterLcId))
    expect(rows).toHaveLength(1)
  })

  it('refuses a BTB in a different currency from its master', async () => {
    const masterLcId = await newLc()
    await expect(
      openBtb(
        ctx,
        { masterLcId, number: `BTB-${randomUUID().slice(0, 6)}`, value: '100.00', currency: 'EUR' },
        POLICY,
      ),
    ).rejects.toThrow(/currency_mismatch/)
  })

  it('refuses to check headroom against an unstated ceiling', async () => {
    const masterLcId = await newLc()
    await expect(
      openBtb(
        ctx,
        { masterLcId, number: `BTB-${randomUUID().slice(0, 6)}`, value: '100.00', currency: 'USD' },
        { discrepancyEscalateAfterDays: 5, explainShortfallAbovePct: '5' },
      ),
    ).rejects.toThrow(/no_btb_limit/)
  })
})

describe('2.1 · a credit and a presentation leave a trail', () => {
  it('audits the LC at the moment it comes into existence', async () => {
    // rule 10 names `lcs` by hand, and this was the write that skipped it: an LC could
    // appear with an outbox event and no before/after row, so "who entered this value"
    // had no answer (audit BE-B5).
    // Through the service, not the fixture: `newLc()` inserts the row directly, which is
    // fine for setting up other tests and proves nothing about the write path.
    const { lcId } = await createLc(ctx, {
      buyerId,
      number: `LC-AUDIT-${Date.now()}`,
      value: '250000.00',
      currency: 'USD',
      latestShipmentDate: '2026-09-01',
      expiryDate: '2026-09-20',
      docsRequired: {},
    })

    const rows = await db
      .select({ action: auditLog.action, after: auditLog.after })
      .from(auditLog)
      .where(and(eq(auditLog.targetTable, 'lcs'), eq(auditLog.targetId, lcId)))

    expect(rows.some((r) => r.action === 'insert')).toBe(true)
    expect((rows[0]!.after as Record<string, unknown>).value).toBe('250000.00')
  })

  it('refuses a credit that expires before its goods may ship, in words', async () => {
    // The CHECK constraint has forbidden this since 0008 — but a driver error is not an
    // AppError, so it reached the person as React #441 with no field named (live test,
    // Phase 3: 5 December typed into a browser reading mm/dd, stored as 12 May).
    await expect(
      createLc(ctx, {
        buyerId,
        number: `LC-BACKWARDS-${Date.now()}`,
        value: '244800.00',
        currency: 'USD',
        latestShipmentDate: '2026-11-18',
        expiryDate: '2026-05-12',
        docsRequired: {},
      }),
    ).rejects.toThrow(/lc_expiry_before_shipment/)
  })

  it('allows the two dates to fall on the same day', async () => {
    // Tight, but legal: documents presented the day the goods go on board. A `>` check
    // instead of `>=` would refuse a real credit, which is the worse failure.
    const { lcId } = await createLc(ctx, {
      buyerId,
      number: `LC-SAMEDAY-${Date.now()}`,
      value: '1000.00',
      currency: 'USD',
      latestShipmentDate: '2026-11-18',
      expiryDate: '2026-11-18',
      docsRequired: {},
    })

    expect(lcId).toBeTruthy()
  })

  it('audits a bank presentation when it is opened', async () => {
    const { submissionId } = await openSubmission(ctx, {
      lcId: await newLc(),
      shipmentId: await newShipment(),
      docs: [{ kind: 'commercial_invoice', status: 'ready' }],
      currency: 'USD',
    })

    const rows = await db
      .select({ action: auditLog.action })
      .from(auditLog)
      .where(and(eq(auditLog.targetTable, 'doc_submissions'), eq(auditLog.targetId, submissionId)))

    expect(rows.some((r) => r.action === 'insert')).toBe(true)
  })
})

describe('2.1 · the EXP gate on the human door', () => {
  it('refuses a presentation against a shipment with no EXP number', async () => {
    // 8.1's `handoffDocsToBank` enforces this properly, and its worker consumer documents
    // that "the gate has already passed by the time this event exists" — true for the event
    // path and false for this one. `createSubmission` calls straight into `openSubmission`,
    // so before plan 2.2 a bank presentation could be opened against a shipment carrying no
    // EXP number at all (audit BE-H2 sibling).
    const lcId = await newLc()
    const shipmentId = await newShipment(null)

    await expect(
      openSubmission(ctx, {
        lcId,
        shipmentId,
        docs: [{ kind: 'commercial_invoice', status: 'ready' }],
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'gate_blocked', messageKey: 'gates.exp_number.missing' })
  })

  it('opens once the shipment carries its EXP number', async () => {
    const lcId = await newLc()
    const shipmentId = await newShipment('EXP-2026-777001')

    const { submissionId } = await openSubmission(ctx, {
      lcId,
      shipmentId,
      docs: [{ kind: 'commercial_invoice', status: 'ready' }],
      currency: 'USD',
    })
    expect(submissionId).toBeTruthy()
  })

  it('refuses a shipment that does not exist', async () => {
    // The old fixture passed randomUUID() here and nothing objected: doc_submissions
    // .shipment_id has no FK, so a presentation could reference nothing at all.
    await expect(
      openSubmission(ctx, {
        lcId: await newLc(),
        shipmentId: randomUUID(),
        docs: [],
        currency: 'USD',
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('2.1 · the submission lifecycle', () => {
  const submit = async (invoiced = '50000.00') => {
    const lcId = await newLc()
    const { submissionId } = await openSubmission(ctx, {
      lcId,
      shipmentId: await newShipment(),
      docs: [{ kind: 'commercial_invoice', status: 'ready' }],
      invoicedAmount: invoiced,
      currency: 'USD',
    })
    await setSubmissionStatus(ctx, {
      submissionId,
      bankStatus: 'submitted',
      submittedAt: '2026-07-20',
    })
    return submissionId
  }

  it('moves preparing → submitted → accepted → realized', async () => {
    await clearSubmissions()
    const submissionId = await submit()

    await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })
    const result = await postRealization(
      ctx,
      { submissionId, realizedAmount: '49250.00', realizedAt: '2026-08-05' },
      POLICY,
    )

    // $750 of bank charges. Normal, and recorded rather than treated as an error.
    expect(result.shortfall).toBe('750.00')
    expect(result.shortfallPct).toBe('1.50')
  })

  it('rejects an illegal transition', async () => {
    await clearSubmissions()
    const lcId = await newLc()
    const { submissionId } = await openSubmission(ctx, {
      lcId,
      docs: [],
      invoicedAmount: '1000.00',
      currency: 'USD',
    })

    // preparing → accepted skips the bank.
    await expect(
      setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' }),
    ).rejects.toThrow()
  })

  it('refuses a discrepant status with no notes', async () => {
    await clearSubmissions()
    const submissionId = await submit()

    // "Discrepant" with no note is a refused presentation nobody can correct.
    await expect(
      setSubmissionStatus(ctx, { submissionId, bankStatus: 'discrepant' }),
    ).rejects.toThrow(/discrepancy_needs_notes/)
  })

  it('allows a discrepant presentation to be corrected and re-presented', async () => {
    await clearSubmissions()
    const submissionId = await submit()

    await setSubmissionStatus(ctx, {
      submissionId,
      bankStatus: 'discrepant',
      discrepancyNotes: 'B/L consignee does not match the LC',
      discrepantSince: '2026-07-22',
    })
    // The routine loop: corrected, re-presented.
    await setSubmissionStatus(ctx, {
      submissionId,
      bankStatus: 'submitted',
      submittedAt: '2026-07-25',
    })

    const [row] = await db.select().from(docSubmissions).where(eq(docSubmissions.id, submissionId))
    expect(row!.bankStatus).toBe('submitted')
  })

  it('refuses a large realization shortfall with no reason', async () => {
    await clearSubmissions()
    const submissionId = await submit()
    await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })

    // A 12% deduction is not bank charges; something was disputed or discounted.
    await expect(
      postRealization(
        ctx,
        { submissionId, realizedAmount: '44000.00', realizedAt: '2026-08-05' },
        POLICY,
      ),
    ).rejects.toThrow(/shortfall_needs_reason/)

    const withReason = await postRealization(
      ctx,
      {
        submissionId,
        realizedAmount: '44000.00',
        realizedAt: '2026-08-05',
        shortfallReason: 'Buyer claimed a 12% discount for the late shipment; accepted by owner.',
      },
      POLICY,
    )
    expect(withReason.needsExplanation).toBe(true)
  })

  it('emits finance.realized carrying BOTH amounts', async () => {
    await clearSubmissions()
    await db.execute(sql`delete from outbox where company_id = ${COMPANY}`)

    const submissionId = await submit()
    await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })
    await postRealization(
      ctx,
      { submissionId, realizedAmount: '49250.00', realizedAt: '2026-08-05' },
      POLICY,
    )

    const rows = await db.execute<{ payload: Record<string, unknown> }>(
      sql`select payload from outbox
          where company_id = ${COMPANY} and event_name = 'finance.realized'`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    const payload = (list[0] as { payload: Record<string, unknown> }).payload

    // The difference between the two IS the bank's deduction. 11.1 needs both.
    expect(payload.invoicedAmount).toBe('50000.00')
    expect(payload.realizedAmount).toBe('49250.00')
    expect(payload.shortfall).toBe('750.00')
  })

  it('cannot post a realization twice', async () => {
    await clearSubmissions()
    const submissionId = await submit()
    await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })
    await postRealization(
      ctx,
      { submissionId, realizedAmount: '50000.00', realizedAt: '2026-08-05' },
      POLICY,
    )

    // `realized` is terminal — a status that could move afterwards would reopen a settled
    // receivable.
    await expect(
      postRealization(
        ctx,
        { submissionId, realizedAmount: '50000.00', realizedAt: '2026-08-06' },
        POLICY,
      ),
    ).rejects.toThrow()
  })
})

describe('2.1 · aging and lag', () => {
  it('escalates a discrepancy past the window, oldest first', async () => {
    await clearSubmissions()

    for (const [since, invoiced] of [
      ['2026-07-20', '1000.00'],
      ['2026-07-28', '2000.00'],
    ] as const) {
      const lcId = await newLc()
      const { submissionId } = await openSubmission(ctx, {
        lcId,
        docs: [],
        invoicedAmount: invoiced,
        currency: 'USD',
      })
      await setSubmissionStatus(ctx, {
        submissionId,
        bankStatus: 'submitted',
        submittedAt: '2026-07-15',
      })
      await setSubmissionStatus(ctx, {
        submissionId,
        bankStatus: 'discrepant',
        discrepancyNotes: 'mismatch',
        discrepantSince: since,
      })
    }

    const aging = await agingDiscrepancies(ctx, { today: '2026-07-30' }, POLICY)

    // Only the 10-day-old one is past a 5-day window.
    expect(aging).toHaveLength(1)
    expect(aging[0]!.days).toBe(10)
  })

  it('computes the buyer’s realization lag as a median', async () => {
    await clearSubmissions()

    for (const [submitted, realized] of [
      ['2026-01-01', '2026-01-11'],
      ['2026-02-01', '2026-02-13'],
      ['2026-03-01', '2026-05-30'],
    ] as const) {
      const lcId = await newLc()
      const { submissionId } = await openSubmission(ctx, {
        lcId,
        docs: [],
        invoicedAmount: '1000.00',
        currency: 'USD',
      })
      await setSubmissionStatus(ctx, { submissionId, bankStatus: 'submitted', submittedAt: submitted })
      await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })
      await postRealization(
        ctx,
        { submissionId, realizedAmount: '1000.00', realizedAt: realized },
        POLICY,
      )
    }

    // 10, 12, 90 → median 12. The mean would be 37, which would forecast every future
    // shipment a month late on the strength of one dispute.
    const lag = await buyerRealizationLag(ctx, { buyerId })
    expect(lag.medianDays).toBe(12)
    expect(lag.observations).toBe(3)
  })
})

describe('2.1 · bank charges', () => {
  it('refuses a charge attached to nothing', async () => {
    await expect(
      recordBankCharge(ctx, {
        kind: 'negotiation',
        amount: '250.00',
        currency: 'USD',
        chargedOn: '2026-08-01',
      }),
    ).rejects.toThrow(/charge_needs_parent/)
  })

  it('records one against an LC', async () => {
    const lcId = await newLc()
    const result = await recordBankCharge(ctx, {
      lcId,
      kind: 'lc_opening',
      amount: '450.00',
      currency: 'USD',
      chargedOn: '2026-07-01',
    })
    expect(result.chargeId).toBeTruthy()
  })
})

describe('2.1 · tenancy', () => {
  it('another company sees no amendments or submissions', async () => {
    await clearSubmissions()
    const lcId = await newLc()
    await amendLc(ctx, { lcId, diff: { tolerancePct: '8' }, receivedAt: '2026-07-30' })
    await openSubmission(ctx, { lcId, docs: [], invoicedAmount: '1.00', currency: 'USD' })

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      amendments: await tx.select().from(lcAmendments),
      submissions: await tx.select().from(docSubmissions),
    }))

    expect(seen.amendments).toHaveLength(0)
    expect(seen.submissions).toHaveLength(0)
  })

  it('another company cannot amend this factory’s LC', async () => {
    const lcId = await newLc()
    await expect(
      amendLc(otherCtx, { lcId, diff: { tolerancePct: '9' }, receivedAt: '2026-07-30' }),
    ).rejects.toThrow(/lc_not_found/)
  })
})

describe('2.1 · covering an order (the join everything else runs through)', () => {
  /*
   * `order_lcs` was read by the amendment conflict re-check and the countdown job and
   * written by NOTHING — every conflict the module can detect was unreachable until the
   * live test hit Phase 3. These vectors pin the writer.
   */
  it('links, computes the float, and is idempotent on the pair', async () => {
    // Order ships 2026-09-20 (beforeAll); credit's latest shipment 2026-09-30 → 10 days.
    const lcId = await newLc()

    const first = await linkOrder(ctx, { lcId, orderId })
    expect(first).toEqual({ linked: true, floatDays: 10 })

    // Re-linking is a no-op, never a duplicate row.
    const again = await linkOrder(ctx, { lcId, orderId })
    expect(again.linked).toBe(false)

    const rows = await withTenantRead(ctx, async (tx) =>
      tx.select().from(orderLcs).where(eq(orderLcs.lcId, lcId)),
    )
    expect(rows).toHaveLength(1)
  })

  it('refuses a credit from a different buyer', async () => {
    const [stranger] = await db
      .insert(buyers)
      .values({ companyId: COMPANY, code: 'ZR', name: 'Zara' })
      .returning({ id: buyers.id })
    const [strangerLc] = await db
      .insert(lcs)
      .values({
        companyId: COMPANY,
        buyerId: stranger!.id,
        number: `LC-${randomUUID().slice(0, 8)}`,
        value: '50000.00',
        currency: 'USD',
        tolerancePct: '5',
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: lcs.id })

    // A credit from one buyer covering another buyer's order is goods shipping against
    // a promise that cannot pay for them.
    await expect(linkOrder(ctx, { lcId: strangerLc!.id, orderId })).rejects.toMatchObject({
      messageKey: 'commercial.errors.lc_order_buyer_mismatch',
    })
  })

  it('another company cannot link through this factory’s LC', async () => {
    const lcId = await newLc()
    await expect(linkOrder(otherCtx, { lcId, orderId })).rejects.toThrow(/lc_not_found/)
  })
})
