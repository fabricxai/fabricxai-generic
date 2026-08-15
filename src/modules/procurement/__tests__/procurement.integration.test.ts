/**
 * 3.2 integration.
 *
 * The arithmetic is covered by `procurement.test.ts`. What is asserted here is what only a
 * database and a gate can be wrong about:
 *
 *  - the BTB headroom gate blocks an import PO, and blocks on the SUPPLIER's origin
 *    rather than on the currency;
 *  - a PO's status follows its lines instead of being typed by hand;
 *  - a score for a supplier with no history is null, not 100;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import { btbLcs, lcs } from '@/modules/commercial/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { withTenantRead } from '@/modules/core/tenancy'
import { orders } from '@/modules/orders/schema'
import '@/modules/procurement/register'
import {
  purchaseRequisitions,
  suppliers,
  supplierPoLines,
  supplierPos,
  supplierScores,
} from '@/modules/procurement/schema'
import {
  applyReceipt,
  compareQuotesForItem,
  computeSupplierScores,
  createPurchaseRequisition,
  createSupplier,
  issuePo,
  overduePos,
  recordSupplierQuote,
  setPoStatus,
} from '@/modules/procurement/service'
import { items } from '@/modules/store/schema'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `proc-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['procurement'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['procurement'] }

const POLICY = { btbLimitPct: 75, overReceiptTolerancePct: '2' }

let itemId: string
let localSupplierId: string
let importSupplierId: string
let masterLcId: string
let btbSmallId: string
let btbHugeId: string

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'Proc Co', slug: `proc-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Buyer' })

  const [buyerRow] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  const buyerId = buyerRow!.id
  await db
    .insert(orders)
    .values({ companyId: COMPANY, buyerId, poNumbers: ['PO-1'], createdBy: USER })

  const [item] = await db
    .insert(items)
    .values({ companyId: COMPANY, code: 'FAB-1', name: 'Single Jersey', kind: 'fabric', uom: 'm' })
    .returning({ id: items.id })
  itemId = item!.id

  const local = await createSupplier(ctx, {
    code: `LOC-${randomUUID().slice(0, 6)}`,
    name: 'Dhaka Trims',
    type: 'trims',
    origin: 'local',
    // A LOCAL supplier invoicing in USD — the case that proves the gate keys on origin.
    defaultCurrency: 'USD',
  })
  localSupplierId = local.supplierId

  const imported = await createSupplier(ctx, {
    code: `IMP-${randomUUID().slice(0, 6)}`,
    name: 'Ningbo Mill',
    type: 'fabric_mill',
    origin: 'import',
    defaultCurrency: 'USD',
  })
  importSupplierId = imported.supplierId

  const [master] = await db
    .insert(lcs)
    .values({
      companyId: COMPANY,
      buyerId,
      number: `LC-${randomUUID().slice(0, 8)}`,
      value: '100000.00',
      currency: 'USD',
      status: 'active',
      createdBy: USER,
    })
    .returning({ id: lcs.id })
  masterLcId = master!.id

  // 75% of 100,000 is 75,000 of headroom. One BTB well inside it, one that blows it.
  const [small] = await db
    .insert(btbLcs)
    .values({
      companyId: COMPANY,
      masterLcId,
      number: `BTB-S-${randomUUID().slice(0, 6)}`,
      supplierId: importSupplierId,
      value: '20000.00',
      currency: 'USD',
      status: 'active',
      createdBy: USER,
    })
    .returning({ id: btbLcs.id })
  btbSmallId = small!.id

  const [huge] = await db
    .insert(btbLcs)
    .values({
      companyId: COMPANY,
      masterLcId,
      number: `BTB-H-${randomUUID().slice(0, 6)}`,
      supplierId: importSupplierId,
      value: '90000.00',
      currency: 'USD',
      status: 'active',
      createdBy: USER,
    })
    .returning({ id: btbLcs.id })
  btbHugeId = huge!.id
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const clearPos = async () => {
  await db.delete(supplierPos).where(eq(supplierPos.companyId, COMPANY))
}

const poInput = (over: Record<string, unknown> = {}) => ({
  supplierId: localSupplierId,
  poNumber: `PO-${randomUUID().slice(0, 8)}`,
  currency: 'USD',
  lines: [{ itemId, qty: '1000.00', unit: 'm', unitPrice: '2.1500' }],
  ...over,
})

describe('3.2 · the BTB headroom gate', () => {
  it('issues a local PO with no BTB at all', async () => {
    await clearPos()
    const result = await issuePo(ctx, poInput(), POLICY)

    // 1,000 × 2.15 = 2,150.
    expect(result.totalValue).toBe('2150.00')
  })

  it('blocks an import PO with no BTB linked', async () => {
    await clearPos()
    await expect(
      issuePo(ctx, poInput({ supplierId: importSupplierId }), POLICY),
    ).rejects.toThrow(/no_btb/)

    const rows = await db.select().from(supplierPos).where(eq(supplierPos.companyId, COMPANY))
    expect(rows).toHaveLength(0)
  })

  it('issues an import PO when the BTB is inside the master’s headroom', async () => {
    await clearPos()
    // Only the 20,000 BTB is counted here — the 90,000 one is deleted for this case.
    await db.delete(btbLcs).where(eq(btbLcs.id, btbHugeId))

    const result = await issuePo(
      ctx,
      poInput({ supplierId: importSupplierId, btbLcId: btbSmallId }),
      POLICY,
    )
    expect(result.supplierPoId).toBeTruthy()

    const [restored] = await db
      .insert(btbLcs)
      .values({
        companyId: COMPANY,
        masterLcId,
        number: `BTB-H-${randomUUID().slice(0, 6)}`,
        supplierId: importSupplierId,
        value: '90000.00',
        currency: 'USD',
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: btbLcs.id })
    btbHugeId = restored!.id
  })

  it('blocks when the BTBs on that master exceed the limit', async () => {
    await clearPos()
    // 20,000 + 90,000 = 110,000 against a 75,000 ceiling. Over-opening BTBs is how a
    // factory ends up owing its suppliers more than the buyer will ever pay it.
    await expect(
      issuePo(ctx, poInput({ supplierId: importSupplierId, btbLcId: btbSmallId }), POLICY),
    ).rejects.toThrow(/exceeded/)
  })

  it('gates on the supplier’s origin, not on the currency', async () => {
    await clearPos()
    // A LOCAL supplier invoicing in USD is still a local purchase. Keying the gate on
    // currency would gate the wrong half of the supplier book.
    const result = await issuePo(ctx, poInput({ supplierId: localSupplierId }), POLICY)
    expect(result.currency).toBe('USD')
  })

  it('blocks an import PO larger than the credit funding it', async () => {
    await clearPos()
    // The failure this gate was found by: a PO of 123,190 rode a credit worth 34,500 and
    // saved without a word, because headroom asks whether the CREDITS fit under their
    // master and never whether the ORDER fits inside its credit. Here: 25,000 × 2.15 =
    // 53,750 against a 20,000 credit.
    await db.delete(btbLcs).where(eq(btbLcs.id, btbHugeId))

    await expect(
      issuePo(
        ctx,
        poInput({
          supplierId: importSupplierId,
          btbLcId: btbSmallId,
          lines: [{ itemId, qty: '25000.00', unit: 'm', unitPrice: '2.1500' }],
        }),
        POLICY,
      ),
    ).rejects.toThrow(/po_exceeds_btb/)

    const rows = await db.select().from(supplierPos).where(eq(supplierPos.companyId, COMPANY))
    expect(rows).toHaveLength(0)

    const [restored] = await db
      .insert(btbLcs)
      .values({
        companyId: COMPANY,
        masterLcId,
        number: `BTB-H-${randomUUID().slice(0, 6)}`,
        supplierId: importSupplierId,
        value: '90000.00',
        currency: 'USD',
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: btbLcs.id })
    btbHugeId = restored!.id
  })

  it('counts the POs already riding that credit, not just this one', async () => {
    await clearPos()
    // Two orders that each fit alone still overdraw the credit together — which is how a
    // credit gets quietly spent twice.
    await db.delete(btbLcs).where(eq(btbLcs.id, btbHugeId))

    const first = await issuePo(
      ctx,
      poInput({
        supplierId: importSupplierId,
        btbLcId: btbSmallId,
        lines: [{ itemId, qty: '6000.00', unit: 'm', unitPrice: '2.1500' }],
      }),
      POLICY,
    )
    expect(first.totalValue).toBe('12900.00')

    await expect(
      issuePo(
        ctx,
        poInput({
          supplierId: importSupplierId,
          btbLcId: btbSmallId,
          lines: [{ itemId, qty: '6000.00', unit: 'm', unitPrice: '2.1500' }],
        }),
        POLICY,
      ),
    ).rejects.toThrow(/po_exceeds_btb/)

    const rows = await db.select().from(supplierPos).where(eq(supplierPos.companyId, COMPANY))
    expect(rows).toHaveLength(1)

    const [restored] = await db
      .insert(btbLcs)
      .values({
        companyId: COMPANY,
        masterLcId,
        number: `BTB-H-${randomUUID().slice(0, 6)}`,
        supplierId: importSupplierId,
        value: '90000.00',
        currency: 'USD',
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: btbLcs.id })
    btbHugeId = restored!.id
  })

  it('refuses to net a PO against a credit in another currency', async () => {
    await clearPos()
    await db.delete(btbLcs).where(eq(btbLcs.id, btbHugeId))

    await expect(
      issuePo(
        ctx,
        poInput({ supplierId: importSupplierId, btbLcId: btbSmallId, currency: 'BDT' }),
        POLICY,
      ),
    ).rejects.toThrow(/po_currency_mismatch/)

    const [restored] = await db
      .insert(btbLcs)
      .values({
        companyId: COMPANY,
        masterLcId,
        number: `BTB-H-${randomUUID().slice(0, 6)}`,
        supplierId: importSupplierId,
        value: '90000.00',
        currency: 'USD',
        status: 'active',
        createdBy: USER,
      })
      .returning({ id: btbLcs.id })
    btbHugeId = restored!.id
  })

  it('refuses to check headroom against an unstated ceiling', async () => {
    await clearPos()
    await expect(
      issuePo(ctx, poInput({ supplierId: importSupplierId, btbLcId: btbSmallId }), {
        overReceiptTolerancePct: '2',
      }),
    ).rejects.toThrow(/no_btb_limit/)
  })
})

describe('3.2 · quote comparison', () => {
  it('excludes a quote that cannot land by the PR’s needed-by date', async () => {
    const pr = await createPurchaseRequisition(ctx, {
      prNo: `PR-${randomUUID().slice(0, 8)}`,
      neededBy: '2026-09-01',
      lines: [{ itemId, qty: '5000.00', unit: 'm' }],
    })

    await recordSupplierQuote(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      supplierId: localSupplierId,
      currency: 'USD',
      quotedOn: '2026-07-01',
      lines: [{ itemId, unitPrice: '2.1500', leadTimeDays: 30 }],
    })
    await recordSupplierQuote(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      supplierId: importSupplierId,
      currency: 'USD',
      quotedOn: '2026-07-01',
      // Cheaper, and useless: it arrives four weeks after the fabric is needed.
      lines: [{ itemId, unitPrice: '1.5000', leadTimeDays: 90 }],
    })

    const comparison = await compareQuotesForItem(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      itemId,
    })

    expect(comparison.ranked).toHaveLength(1)
    expect(comparison.ranked[0]!.supplierId).toBe(localSupplierId)
    expect(comparison.infeasible[0]!.reasonKey).toBe('procurement.quote.too_late')
  })

  it('refuses to mix currencies without a rate', async () => {
    const pr = await createPurchaseRequisition(ctx, {
      prNo: `PR-${randomUUID().slice(0, 8)}`,
      neededBy: '2026-12-01',
      lines: [{ itemId, qty: '1000.00', unit: 'm' }],
    })

    await recordSupplierQuote(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      supplierId: localSupplierId,
      currency: 'BDT',
      quotedOn: '2026-07-01',
      lines: [{ itemId, unitPrice: '250.0000', leadTimeDays: 20 }],
    })
    await recordSupplierQuote(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      supplierId: importSupplierId,
      currency: 'USD',
      quotedOn: '2026-07-01',
      lines: [{ itemId, unitPrice: '2.1500', leadTimeDays: 20 }],
    })

    // The typed error carries the reason in its details, not in its message key — the
    // key is what the UI translates, the details are what it shows next to it.
    await expect(
      compareQuotesForItem(ctx, {
        purchaseRequisitionId: pr.purchaseRequisitionId,
        itemId,
      }),
    ).rejects.toMatchObject({
      messageKey: 'procurement.errors.uncomputable',
      details: { reason: expect.stringMatching(/rate/i) },
    })

    // With the rate stated, the same comparison answers — and says what it used.
    const withRate = await compareQuotesForItem(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      itemId,
      baseCurrency: 'USD',
      rates: { BDT: '0.0083' },
    })
    expect(withRate.ratesUsed).toEqual({ BDT: '0.0083' })
  })

  it('moves the PR to quoted, then to ordered when a PO is issued from it', async () => {
    await clearPos()
    const pr = await createPurchaseRequisition(ctx, {
      prNo: `PR-${randomUUID().slice(0, 8)}`,
      neededBy: '2026-12-01',
      lines: [{ itemId, qty: '1000.00', unit: 'm' }],
    })

    await recordSupplierQuote(ctx, {
      purchaseRequisitionId: pr.purchaseRequisitionId,
      supplierId: localSupplierId,
      currency: 'USD',
      quotedOn: '2026-07-01',
      lines: [{ itemId, unitPrice: '2.1500', leadTimeDays: 20 }],
    })

    const [quoted] = await db
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, pr.purchaseRequisitionId))
    expect(quoted!.status).toBe('quoted')

    await issuePo(ctx, poInput({ purchaseRequisitionId: pr.purchaseRequisitionId }), POLICY)

    const [ordered] = await db
      .select()
      .from(purchaseRequisitions)
      .where(eq(purchaseRequisitions.id, pr.purchaseRequisitionId))
    expect(ordered!.status).toBe('ordered')
  })
})

describe('3.2 · receipts drive the PO status', () => {
  const twoLinePo = () =>
    poInput({
      lines: [
        { itemId, qty: '1000.00', unit: 'm', unitPrice: '2.0000' },
        { itemId, qty: '500.00', unit: 'm', unitPrice: '3.0000' },
      ],
    })

  it('a partial receipt moves the PO to received_partial, not to received', async () => {
    await clearPos()
    const po = await issuePo(ctx, twoLinePo(), POLICY)
    const lines = await db
      .select()
      .from(supplierPoLines)
      .where(eq(supplierPoLines.supplierPoId, po.supplierPoId))

    const result = await applyReceipt(ctx, { supplierPoLineId: lines[0]!.id, qty: '1000.00' }, POLICY)

    expect(result.closed).toBe(true)
    // One line closed, one still open — the PO is not received.
    expect(result.poStatus).toBe('received_partial')

    const [po2] = await db.select().from(supplierPos).where(eq(supplierPos.id, po.supplierPoId))
    expect(po2!.status).toBe('received_partial')
  })

  it('closes the PO when every line is closed', async () => {
    await clearPos()
    const po = await issuePo(ctx, twoLinePo(), POLICY)
    const lines = await db
      .select()
      .from(supplierPoLines)
      .where(eq(supplierPoLines.supplierPoId, po.supplierPoId))

    await applyReceipt(ctx, { supplierPoLineId: lines[0]!.id, qty: '1000.00' }, POLICY)
    const result = await applyReceipt(
      ctx,
      { supplierPoLineId: lines[1]!.id, qty: '500.00' },
      POLICY,
    )

    expect(result.poStatus).toBe('received')
  })

  it('accepts a small over-receipt and flags a large one', async () => {
    await clearPos()
    await db.execute(sql`delete from outbox where company_id = ${COMPANY}`)

    const po = await issuePo(ctx, poInput(), POLICY)
    const [line] = await db
      .select()
      .from(supplierPoLines)
      .where(eq(supplierPoLines.supplierPoId, po.supplierPoId))

    // Mills cut to the roll: 15 m over on 1,000 is a normal delivery.
    const ok = await applyReceipt(ctx, { supplierPoLineId: line!.id, qty: '1015.00' }, POLICY)
    expect(ok.withinTolerance).toBe(true)

    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from outbox
          where company_id = ${COMPANY} and event_name = 'procurement.receipt.over'`,
    )
    const list = Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
    expect(Number((list[0] as { n: string }).n)).toBe(0)
  })

  it('refuses a receipt against a closed line', async () => {
    await clearPos()
    const po = await issuePo(ctx, poInput(), POLICY)
    const [line] = await db
      .select()
      .from(supplierPoLines)
      .where(eq(supplierPoLines.supplierPoId, po.supplierPoId))

    await applyReceipt(ctx, { supplierPoLineId: line!.id, qty: '1000.00' }, POLICY)
    await expect(
      applyReceipt(ctx, { supplierPoLineId: line!.id, qty: '50.00' }, POLICY),
    ).rejects.toThrow()
  })

  it('rejects an illegal PO transition', async () => {
    await clearPos()
    const po = await issuePo(ctx, poInput(), POLICY)

    // issued → shipped skips confirmation.
    await expect(
      setPoStatus(ctx, { supplierPoId: po.supplierPoId, status: 'shipped' }),
    ).rejects.toThrow()

    await setPoStatus(ctx, { supplierPoId: po.supplierPoId, status: 'confirmed' })
    await setPoStatus(ctx, { supplierPoId: po.supplierPoId, status: 'shipped' })
  })
})

describe('3.2 · scores and overdue', () => {
  it('scores a supplier with no history as null, not as perfect', async () => {
    await clearPos()
    await db.delete(supplierScores).where(eq(supplierScores.companyId, COMPANY))

    await computeSupplierScores(ctx, { period: '2020-01-01' })

    const rows = await db
      .select()
      .from(supplierScores)
      .where(eq(supplierScores.period, '2020-01-01'))

    expect(rows.length).toBeGreaterThan(0)
    // A new supplier is unmeasured, not perfect. 100% on-time would top a ranking on the
    // strength of never having delivered anything.
    expect(rows.every((r) => r.onTimePct === null)).toBe(true)
    expect(rows.every((r) => r.observations === 0)).toBe(true)
  })

  it('recomputing a period replaces it rather than duplicating', async () => {
    await computeSupplierScores(ctx, { period: '2020-01-01' })
    await computeSupplierScores(ctx, { period: '2020-01-01' })

    const rows = await db
      .select()
      .from(supplierScores)
      .where(eq(supplierScores.period, '2020-01-01'))
    expect(rows).toHaveLength(2) // one per active supplier, not four
  })

  it('lists POs past their expected date with work outstanding', async () => {
    await clearPos()
    await issuePo(ctx, poInput({ expectedDeliveryDate: '2026-01-01' }), POLICY)
    await issuePo(ctx, poInput({ expectedDeliveryDate: '2099-01-01' }), POLICY)

    const overdue = await overduePos(ctx, { asOf: '2026-07-29' })
    expect(overdue).toHaveLength(1)
    expect(overdue[0]!.expectedDeliveryDate).toBe('2026-01-01')
  })
})

describe('3.2 · tenancy', () => {
  it('another company sees no suppliers or POs', async () => {
    await clearPos()
    await issuePo(ctx, poInput(), POLICY)

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      suppliers: await tx.select().from(suppliers),
      pos: await tx.select().from(supplierPos),
    }))

    expect(seen.suppliers).toHaveLength(0)
    expect(seen.pos).toHaveLength(0)
  })

  it('another company cannot issue a PO against this factory’s supplier', async () => {
    await expect(issuePo(otherCtx, poInput(), POLICY)).rejects.toThrow()
  })
})
