/**
 * 1.3 integration — the two suites that are never skipped for any module (PLAYBOOK §5):
 * cross-company reads return zero rows, and one illegal transition per status field
 * asserts a 409. Plus the breakdown revision rules, which are where the money is.
 *
 * Runs against real Postgres with the application role, so tenancy assertions are real
 * RLS results rather than application-level checks that could be forgotten.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { auditLog, companies, documents, outbox, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx, SystemCtx } from '@/modules/core/ctx'
import { AppError } from '@/modules/core/errors'
import { orderBreakdowns, orderFiles, orderRevisions, orderStyles, orders, tnaMilestones, tnaTemplates } from '@/modules/orders/schema'
import {
  actualizeMilestone,
  generateTna,
  previewRipple,
  createOrder,
  saveBreakdown,
  setOrderStatus,
} from '@/modules/orders/service'
import { runTnaScan } from '@/modules/orders/jobs'
import { ordersModule } from '@/modules/orders/register'
import { peekEntity } from '@/modules/core/drawer'
import { approve, propose } from '@/modules/core/pending-changes'
import { __resetRegistry, registerModule } from '@/modules/core/registry'
import { pendingChanges } from '@/db/schema/core'
import { withTenantRead } from '@/modules/core/tenancy'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY_A = randomUUID()
const COMPANY_B = randomUUID()
const USER_A = `ord-a-${randomUUID().slice(0, 8)}`
const USER_B = `ord-b-${randomUUID().slice(0, 8)}`
/** Second signer in company A — order revisions are ⚖, the author cannot sign (3.1). */
const SIGNER_A = `ord-sign-${randomUUID().slice(0, 8)}`
const BUYER_A = randomUUID()
const TEMPLATE_A = randomUUID()

const ctxA: RequestCtx = { companyId: COMPANY_A, userId: USER_A, roles: ['merchandiser'] }
const ctxB: RequestCtx = { companyId: COMPANY_B, userId: USER_B, roles: ['merchandiser'] }
const signerCtxA: RequestCtx = { companyId: COMPANY_A, userId: SIGNER_A, roles: ['merchandiser'] }
const systemA: SystemCtx = { companyId: COMPANY_A, userId: null, roles: ['owner'], system: true }

const EX_FACTORY = '2026-06-30'

let orderId: string
let styleId: string

beforeAll(async () => {
  await db
    .insert(companies)
    .values([
      { id: COMPANY_A, name: 'Orders Alpha', slug: `ord-a-${COMPANY_A.slice(0, 8)}` },
      { id: COMPANY_B, name: 'Orders Beta', slug: `ord-b-${COMPANY_B.slice(0, 8)}` },
    ])
    .onConflictDoNothing()

  await db
    .insert(users)
    .values([
      { id: USER_A, email: `${USER_A}@fabricxai.test`, name: 'Alpha Merch' },
      { id: USER_B, email: `${USER_B}@fabricxai.test`, name: 'Beta Merch' },
      { id: SIGNER_A, email: `${SIGNER_A}@fabricxai.test`, name: 'Alpha Signer' },
    ])
    .onConflictDoNothing()

  await db
    .insert(buyers)
    .values({ id: BUYER_A, companyId: COMPANY_A, code: 'HM', name: 'H&M' })
    .onConflictDoNothing()

  await db.insert(tnaTemplates).values({
    id: TEMPLATE_A,
    companyId: COMPANY_A,
    name: 'Knit top 90d',
    productType: 'knit-top',
    milestones: [
      { name: 'fabric_in_house', offsetDaysBeforeExFactory: 60, dependsOn: [], critical: true },
      {
        name: 'cutting_start',
        offsetDaysBeforeExFactory: 45,
        dependsOn: ['fabric_in_house'],
        critical: true,
      },
      {
        name: 'ex_factory',
        offsetDaysBeforeExFactory: 0,
        dependsOn: ['cutting_start'],
        critical: true,
      },
    ],
  })

  const [order] = await db
    .insert(orders)
    .values({
      companyId: COMPANY_A,
      buyerId: BUYER_A,
      poNumbers: ['PO-9931'],
      currency: 'USD',
      qtyTolerancePct: '3.00',
      ownerUserId: USER_A,
      createdBy: USER_A,
    })
    .returning({ id: orders.id })
  orderId = order!.id

  const [style] = await db
    .insert(orderStyles)
    .values({
      companyId: COMPANY_A,
      orderId,
      styleCode: 'ST-100',
      contractedQty: 10_000,
      unitPrice: '4.75',
      currency: 'USD',
    })
    .returning({ id: orderStyles.id })
  styleId = style!.id
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY_A}, ${COMPANY_B})`)
  await db.delete(companies).where(eq(companies.id, COMPANY_A))
  await db.delete(companies).where(eq(companies.id, COMPANY_B))
  await db.delete(users).where(eq(users.id, USER_A))
  await db.delete(users).where(eq(users.id, USER_B))
  await client.end()
})

describe('1.3 · tenancy', () => {
  it('a company cannot read another company’s orders — zero rows, by RLS', async () => {
    const visibleToB = await withTenantRead(ctxB, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    )
    expect(visibleToB).toHaveLength(0)

    const visibleToA = await withTenantRead(ctxA, (tx) =>
      tx.select().from(orders).where(eq(orders.id, orderId)),
    )
    expect(visibleToA).toHaveLength(1)
  })

  it('a cross-company write is refused rather than silently scoped', async () => {
    // Company B tries to touch A's style. Not "forbidden" — invisible.
    await expect(
      saveBreakdown(ctxB, {
        orderStyleId: styleId,
        cells: [{ color: 'Navy', size: 'M', qty: 10_000 }],
        buyerRevision: false,
      }),
    ).rejects.toMatchObject({ code: 'not_found' })
  })
})

describe('1.3 · breakdown', () => {
  it('accepts a grid that totals within the buyer’s tolerance', async () => {
    const result = await saveBreakdown(ctxA, {
      orderStyleId: styleId,
      cells: [
        { color: 'Navy', size: 'M', qty: 4_000 },
        { color: 'Navy', size: 'L', qty: 3_000 },
        { color: 'Ecru', size: 'M', qty: 3_000 },
      ],
      buyerRevision: false,
    })

    expect(result.totalQty).toBe(10_000)
    expect(result.revision).toBe(1)
    expect(result.isNewRevision).toBe(false)
  })

  it('refuses a grid outside tolerance — that is a claim, not a rounding difference', async () => {
    await expect(
      saveBreakdown(ctxA, {
        orderStyleId: styleId,
        // 3% of 10,000 is 300; 9,000 is far outside it.
        cells: [{ color: 'Navy', size: 'M', qty: 9_000 }],
        buyerRevision: false,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      messageKey: 'orders.errors.breakdown_outside_tolerance',
    })
  })

  it('refuses the same colour/size twice instead of losing one to the unique index', async () => {
    await expect(
      saveBreakdown(ctxA, {
        orderStyleId: styleId,
        cells: [
          { color: 'Navy', size: 'M', qty: 5_000 },
          { color: 'Navy', size: 'M', qty: 5_000 },
        ],
        buyerRevision: false,
      }),
    ).rejects.toMatchObject({ messageKey: 'orders.errors.duplicate_breakdown_cell' })
  })

  it('a correction overwrites the active revision; a buyer change creates a new one', async () => {
    const corrected = await saveBreakdown(ctxA, {
      orderStyleId: styleId,
      cells: [
        { color: 'Navy', size: 'M', qty: 5_000 },
        { color: 'Navy', size: 'L', qty: 5_000 },
      ],
      buyerRevision: false,
    })
    expect(corrected.revision).toBe(1)
    expect(corrected.isNewRevision).toBe(false)

    const revised = await saveBreakdown(ctxA, {
      orderStyleId: styleId,
      cells: [
        { color: 'Navy', size: 'M', qty: 5_100 },
        { color: 'Navy', size: 'L', qty: 4_900 },
      ],
      buyerRevision: true,
      reason: 'Buyer amended the size ratio',
    })
    expect(revised.revision).toBe(2)
    expect(revised.isNewRevision).toBe(true)

    // Revision 1 survives — "what were we cutting to in March" stays answerable.
    const rev1 = await db
      .select()
      .from(orderBreakdowns)
      .where(and(eq(orderBreakdowns.orderStyleId, styleId), eq(orderBreakdowns.revision, 1)))
    expect(rev1).toHaveLength(2)

    const [revisionRow] = await db
      .select()
      .from(orderRevisions)
      .where(and(eq(orderRevisions.orderId, orderId), eq(orderRevisions.revision, 2)))
    expect(revisionRow?.reason).toBe('Buyer amended the size ratio')
    expect(revisionRow?.diff).toMatchObject({ totalBefore: 10_000, totalAfter: 10_000 })
  })
})

describe('1.3 · TNA', () => {
  it('generates the calendar and denormalises ex-factory onto the order', async () => {
    const result = await generateTna(ctxA, {
      orderId,
      templateId: TEMPLATE_A,
      exFactoryDate: EX_FACTORY,
    })

    expect(result.milestones).toHaveLength(3)

    const rows = await db.select().from(tnaMilestones).where(eq(tnaMilestones.orderId, orderId))
    expect(rows).toHaveLength(3)
    expect(rows.find((m) => m.name === 'cutting_start')?.plannedDate).toBe('2026-05-16')

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
    expect(order?.plannedExFactoryDate).toBe(EX_FACTORY)
  })

  it('previewRipple writes nothing', async () => {
    const [fabric] = await db
      .select()
      .from(tnaMilestones)
      .where(and(eq(tnaMilestones.orderId, orderId), eq(tnaMilestones.name, 'fabric_in_house')))

    const preview = await previewRipple(ctxA, {
      milestoneId: fabric!.id,
      actualDate: '2026-05-07', // planned 2026-05-01, six days late
    })

    expect(preview.exFactorySlipDays).toBe(6)
    expect(preview.newExFactoryDate).toBe('2026-07-06')

    // The whole point of a preview: nothing changed.
    const [after] = await db.select().from(tnaMilestones).where(eq(tnaMilestones.id, fabric!.id))
    expect(after?.actualDate).toBeNull()
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
    expect(order?.plannedExFactoryDate).toBe(EX_FACTORY)
  })

  it('actualizing applies the ripple, moves the ship date, and emits', async () => {
    const [fabric] = await db
      .select()
      .from(tnaMilestones)
      .where(and(eq(tnaMilestones.orderId, orderId), eq(tnaMilestones.name, 'fabric_in_house')))

    const ripple = await actualizeMilestone(ctxA, {
      milestoneId: fabric!.id,
      actualDate: '2026-05-07',
    })
    expect(ripple.exFactorySlipDays).toBe(6)

    const rows = await db.select().from(tnaMilestones).where(eq(tnaMilestones.orderId, orderId))
    expect(rows.find((m) => m.name === 'cutting_start')?.plannedDate).toBe('2026-05-22')
    expect(rows.find((m) => m.name === 'ex_factory')?.plannedDate).toBe('2026-07-06')

    const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
    expect(order?.plannedExFactoryDate).toBe('2026-07-06')

    const events = await db
      .select()
      .from(outbox)
      .where(and(eq(outbox.companyId, COMPANY_A), eq(outbox.eventName, 'orders.tna.ex_factory_slipped')))
    expect(events.length).toBeGreaterThan(0)

    const audits = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, COMPANY_A), eq(auditLog.targetId, orderId)))
    expect(audits.length).toBeGreaterThan(0)
  })

  it('refuses to actualize the same milestone twice', async () => {
    const [fabric] = await db
      .select()
      .from(tnaMilestones)
      .where(and(eq(tnaMilestones.orderId, orderId), eq(tnaMilestones.name, 'fabric_in_house')))

    await expect(
      actualizeMilestone(ctxA, { milestoneId: fabric!.id, actualDate: '2026-05-09' }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 })
  })

  it('regenerating preserves what already happened', async () => {
    const result = await generateTna(ctxA, {
      orderId,
      templateId: TEMPLATE_A,
      exFactoryDate: '2026-07-15',
    })

    expect(result.preserved).toBe(1)

    const [fabric] = await db
      .select()
      .from(tnaMilestones)
      .where(and(eq(tnaMilestones.orderId, orderId), eq(tnaMilestones.name, 'fabric_in_house')))

    // The recorded actual date survives a template regeneration.
    expect(fabric?.actualDate).toBe('2026-05-07')
  })

  it('the nightly scan derives statuses and is quiet on a second run', async () => {
    const first = await runTnaScan(systemA, { today: '2026-07-14' })
    expect(first.scanned).toBeGreaterThan(0)

    // Nothing changed between runs, so nothing should be re-raised.
    const second = await runTnaScan(systemA, { today: '2026-07-14' })
    expect(second.atRisk).toBe(0)
    expect(second.late).toBe(0)
  })
})

describe('1.3 · order state machine', () => {
  it('walks the legal path', async () => {
    const first = await setOrderStatus(ctxA, { orderId, status: 'in_production' })
    expect(first).toEqual({ from: 'confirmed', to: 'in_production' })

    await setOrderStatus(ctxA, { orderId, status: 'shipped_partial' })
  })

  it('refuses an illegal transition with a 409 listing what IS allowed', async () => {
    // Goods are on a vessel; the order is settled through shipment, not by cancelling.
    const thrown = await setOrderStatus(ctxA, { orderId, status: 'cancelled' }).catch(
      (e: unknown) => e,
    )

    expect(thrown).toBeInstanceOf(AppError)
    const error = thrown as AppError
    expect(error.status).toBe(409)
    expect(error.code).toBe('illegal_transition')
    expect(error.details).toMatchObject({ field: 'status', from: 'shipped_partial', to: 'cancelled' })
    expect(error.details.allowed).toEqual(['shipped_full', 'closed'])
  })

  it('a breakdown edit after production start becomes a revision automatically', async () => {
    // The order is shipped_partial. Even without buyerRevision, this is history now.
    const result = await saveBreakdown(ctxA, {
      orderStyleId: styleId,
      cells: [
        { color: 'Navy', size: 'M', qty: 5_050 },
        { color: 'Navy', size: 'L', qty: 4_950 },
      ],
      buyerRevision: false,
    })

    expect(result.isNewRevision).toBe(true)
    expect(result.revision).toBe(3)
  })
})

describe('1.3 · the desk originates as well as advances (plan 5.1)', () => {
  /*
   * Every service in this module was reachable from exactly two places — the `rfq.won`
   * consumer and the approve inbox's commit handlers — so the product could advance an
   * order that arrived from somewhere else and could not open one. What is asserted here is
   * the shape the DESK sends, because that is the new caller and the one nothing covered.
   */
  it('a hand-entered order arrives with its style, which is what makes it usable', async () => {
    const created = await createOrder(ctxA, {
      order: {
        buyerId: BUYER_A,
        poNumbers: [`PO-DESK-${randomUUID().slice(0, 6)}`],
        currency: 'USD',
        plannedExFactoryDate: '2026-11-20',
      },
      styles: [{ styleCode: 'ST-DESK', contractedQty: 12_000, unitPrice: '4.25', currency: 'USD' }],
    })

    const [order] = await db.select().from(orders).where(eq(orders.id, created.orderId))
    expect(order?.plannedExFactoryDate).toBe('2026-11-20')

    // The part that matters. An order with no style is an order nothing can be cut, costed
    // or planned against — it would sit in the book looking like work.
    const styles = await db
      .select()
      .from(orderStyles)
      .where(eq(orderStyles.orderId, created.orderId))
    expect(styles).toHaveLength(1)
    expect(styles[0]?.contractedQty).toBe(12_000)
  })

  it('a desk-proposed amendment validates and commits through the same handler', async () => {
    /*
     * The action cannot be called here — it reads `headers()` — so this sends exactly the
     * payload it builds. That is the point: `proposeOrderRevision` names a zod key and an
     * operation, and a mismatch between what the screen sends and what the module registered
     * is invisible until somebody clicks approve.
     */
    __resetRegistry()
    registerModule({ ...ordersModule })

    const [before] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))

    const draft = await propose(ctxA, {
      moduleId: 'orders',
      targetTable: 'order_breakdowns',
      // `insert` with no targetId — see the note in `proposeOrderRevision`. An `update`
      // carrying the STYLE id would make the inbox look order_styles up in
      // order_breakdowns and show the reviewer no before at all.
      operation: 'insert',
      zodSchemaKey: 'order_revision_v1',
      source: 'user_draft',
      payload: {
        orderStyleId: styleId,
        // Still sums to the contracted 10,000 — a grid that does not is refused by the
        // tolerance check, which is the point of the check and not of this case.
        cells: [
          { color: 'Navy', size: 'M', qty: 6_000 },
          { color: 'Navy', size: 'L', qty: 4_000 },
        ],
        reason: 'Buyer dropped the L split on the phone',
      },
    })

    expect(draft.status).toBe('pending')
    await approve(signerCtxA, { pendingChangeId: draft.id })

    const [after] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))
    // The floor cuts to `activeRevision`; an amendment that did not move it would leave
    // people working to a grid nobody agreed.
    expect(after!.activeRevision).toBe(before!.activeRevision + 1)
  })

  it('once cutting has started, even a correction is a new revision', async () => {
    /*
     * The other door, and the rule that surprised this case into being written properly.
     *
     * `isNewRevision` is `buyerRevision || productionStarted`. Before production a
     * correction overwrites the active revision — the case earlier in this file asserts
     * that. AFTER it, a correction still bumps, because the floor has been cutting to the
     * old grid and quietly overwriting it would leave bundles on a table matching no
     * revision on record. The desk's "save as a correction" button inherits that, so a
     * merchandiser who expected a silent fix gets a numbered one.
     */
    // Whatever the earlier cases left it at, as long as production has begun — the rule
    // keys on that, not on one status, and pinning a specific one here would make this case
    // fail for a reason that has nothing to do with breakdowns.
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId))
    expect(['in_production', 'shipped_partial', 'shipped_full']).toContain(order?.status)

    const [before] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))

    const result = await saveBreakdown(ctxA, {
      orderStyleId: styleId,
      cells: [
        { color: 'Navy', size: 'M', qty: 6_100 },
        { color: 'Navy', size: 'L', qty: 3_900 },
      ],
      buyerRevision: false,
      reason: 'Recount off the PO',
    })

    expect(result.isNewRevision).toBe(true)
    const [after] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))
    expect(after!.activeRevision).toBe(before!.activeRevision + 1)
  })
})

describe('1.3 · applyRevision — the AI → approve → commit loop', () => {
  it('an approved buyer amendment lands as a new revision with its evidence', async () => {
    // Registering here rather than in beforeAll: the registry is module-global and other
    // suites reset it, so the module has to be present at the moment approve() resolves.
    __resetRegistry()
    registerModule({ ...ordersModule })

    const [styleBefore] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))
    const revisionBefore = styleBefore!.activeRevision

    // MARBIM extracts this from the buyer's amendment email, with real per-field
    // confidence — not a constant.
    const draft = await propose(ctxA, {
      moduleId: 'orders',
      targetTable: 'order_breakdowns',
      operation: 'insert',
      zodSchemaKey: 'order_revision_v1',
      payload: {
        orderStyleId: styleId,
        cells: [
          { color: 'Navy', size: 'M', qty: 5_200 },
          { color: 'Navy', size: 'L', qty: 4_800 },
        ],
        reason: 'Buyer email 2026-05-20: swap 100 pcs L to M',
      },
      fieldConfidence: { orderStyleId: 0.99, cells: 0.86, reason: 0.94 },
      source: 'ai_extraction',
      extractorVersion: 'po-extract-v3',
    })

    expect(draft.status).toBe('pending')

    const approved = await approve(signerCtxA, { pendingChangeId: draft.id })

    // The handler returns the ORDER id — a revision is a change to the order, not to one
    // breakdown row, and the audit trail should point where a human would look.
    expect(approved.committedRowId).toBe(orderId)

    const [styleAfter] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))
    expect(styleAfter!.activeRevision).toBe(revisionBefore + 1)

    const cells = await db
      .select()
      .from(orderBreakdowns)
      .where(
        and(
          eq(orderBreakdowns.orderStyleId, styleId),
          eq(orderBreakdowns.revision, styleAfter!.activeRevision),
        ),
      )
    expect(cells.map((c) => c.qty).sort((a, b) => a - b)).toEqual([4_800, 5_200])

    // The evidence row: who asked, and why.
    const [revisionRow] = await db
      .select()
      .from(orderRevisions)
      .where(
        and(eq(orderRevisions.orderId, orderId), eq(orderRevisions.revision, styleAfter!.activeRevision)),
      )
    expect(revisionRow?.reason).toContain('Buyer email')

    // And the draft is closed with a pointer to what it became.
    const [committed] = await db
      .select()
      .from(pendingChanges)
      .where(eq(pendingChanges.id, draft.id))
    expect(committed?.status).toBe('committed')
    expect(committed?.committedRowId).toBe(orderId)
  })

  it('a draft that would break the tolerance gate fails at approve, committing nothing', async () => {
    __resetRegistry()
    registerModule({ ...ordersModule })

    const [styleBefore] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))

    const draft = await propose(ctxA, {
      moduleId: 'orders',
      targetTable: 'order_breakdowns',
      operation: 'insert',
      zodSchemaKey: 'order_revision_v1',
      payload: {
        orderStyleId: styleId,
        // 6,000 against a contracted 10,000 with 3% tolerance.
        cells: [{ color: 'Navy', size: 'M', qty: 6_000 }],
        reason: 'Misread scan',
      },
      fieldConfidence: { orderStyleId: 0.99, cells: 0.41, reason: 0.7 },
      source: 'ai_extraction',
    })

    // The gate is server-side and applies to approved AI writes exactly as it applies to
    // a merchandiser typing — approval is not a bypass.
    await expect(approve(signerCtxA, { pendingChangeId: draft.id })).rejects.toMatchObject({
      messageKey: 'orders.errors.breakdown_outside_tolerance',
    })

    const [styleAfter] = await db.select().from(orderStyles).where(eq(orderStyles.id, styleId))
    expect(styleAfter!.activeRevision).toBe(styleBefore!.activeRevision)
  })
})

describe('the order peek (spec §3)', () => {
  it('answers the drawer with the desk facts, by the PO a person can actually see', async () => {
    // The chip carries the code, not the uuid — resolution rides the module's own
    // refResolver, so the peek and the copilot answer the same references.
    const peek = await peekEntity(ctxA, 'order', 'PO-9931')

    expect(peek.id).toBe(orderId)
    expect(peek.title).toBe('PO-9931')
    expect(peek.subtitle).toContain('H&M')
    expect(peek.subtitle).toContain('ST-100')
    expect(peek.href).toBe(`/orders/${orderId}`)
    expect(peek.facts).toContainEqual({
      labelKey: 'ui.peek.order_qty',
      value: '10,000',
      mono: true,
    })
  })

  it('carries the filed papers as onward peeks — the one-level stack in its natural use', async () => {
    const docId = randomUUID()
    await db.insert(documents).values({
      id: docId,
      companyId: COMPANY_A,
      bucket: 'test',
      objectKey: `ord-peek/${docId}`,
      filename: 'po-9931.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 52_120,
      status: 'ready',
    })
    // First reader of order_files: the registry existed since the schema shipped and
    // nothing consumed it until the peek.
    await db.insert(orderFiles).values({
      companyId: COMPANY_A,
      orderId,
      documentId: docId,
      label: 'buyer PO scan',
    })

    const peek = await peekEntity(ctxA, 'order', orderId)
    expect(peek.related).toContainEqual({
      kind: 'document',
      reference: docId,
      label: 'buyer PO scan',
    })

    // And the onward peek answers through core's document kind.
    const doc = await peekEntity(ctxA, 'document', docId)
    expect(doc.title).toBe('po-9931.pdf')
  })

  it('is invisible across the fence', async () => {
    await expect(peekEntity(ctxB, 'order', orderId)).rejects.toMatchObject({
      code: 'not_found',
      messageKey: 'errors.reference_not_found',
    })
  })
})
