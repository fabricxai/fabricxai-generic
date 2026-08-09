/**
 * Event consumers — the wires between modules, end to end.
 *
 * Every pair here was built from both ends and never connected: 8.1 emitted a payload
 * shaped exactly as 2.1's entry point expects, 2.1 emitted one shaped for 11.1's, and
 * nothing carried them. These tests drive the real handlers against real rows.
 *
 * What is asserted:
 *
 *  - a shipment's bank handoff opens a presentation in 2.1;
 *  - a realization posted in 2.1 closes the receivable in 11.1, keeping the shortfall;
 *  - a completed cut and a confirmed departure actualise the RIGHT TNA milestone;
 *  - a redelivery is a no-op, because every handler is independently idempotent;
 *  - a missing counterpart is skipped rather than retried into an alert.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, processedEvents, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import '@/modules/commercial/register'
import { docSubmissions, lcs } from '@/modules/commercial/schema'
import { postRealization, setSubmissionStatus } from '@/modules/commercial/service'
import type { RequestCtx } from '@/modules/core/ctx'
import '@/modules/finance/register'
import { invoices, receivables } from '@/modules/finance/schema'
import { draftInvoice } from '@/modules/finance/service'
import { orders, orderStyles, tnaMilestones } from '@/modules/orders/schema'
import { rfqs } from '@/modules/rfq/schema'
import '@/modules/shipment/register'
import { shipments } from '@/modules/shipment/schema'
import { EVENT_HANDLERS, runEventConsumer, type EventJobData } from '@/worker/processors/consumers'
import { QUEUE } from '@/worker/queues'

import type { Job } from 'bullmq'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const USER = `con-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['owner'] }

const FINANCE_POLICY = { defaultRealizationLagDays: 30 }
const BANK_POLICY = { discrepancyEscalateAfterDays: 5, explainShortfallAbovePct: '5' }

let buyerId: string
let orderId: string
let lcId: string

/** Drive a handler exactly as the worker would. */
const deliver = (eventName: string, payload: Record<string, unknown>, eventId = randomUUID()) =>
  runEventConsumer({
    name: eventName,
    data: { eventId, companyId: COMPANY, payload } satisfies EventJobData,
  } as Job<EventJobData>)

beforeAll(async () => {
  await db
    .insert(companies)
    .values({ id: COMPANY, name: 'Wire Co', slug: `wire-${COMPANY.slice(0, 8)}` })
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Wire' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  buyerId = buyer!.id

  const [order] = await db
    .insert(orders)
    .values({ companyId: COMPANY, buyerId, poNumbers: ['PO-1'], createdBy: USER })
    .returning({ id: orders.id })
  orderId = order!.id

  const [lc] = await db
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
  lcId = lc!.id

  // The calendars a won RFQ resolves against.
  const { seedDefaultTnaTemplates } = await import('@/modules/orders/service')
  await seedDefaultTnaTemplates(ctx)
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id = ${COMPANY}`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const reset = async () => {
  await db.delete(receivables).where(eq(receivables.companyId, COMPANY))
  await db.delete(invoices).where(eq(invoices.companyId, COMPANY))
  await db.delete(docSubmissions).where(eq(docSubmissions.companyId, COMPANY))
  await db.delete(shipments).where(eq(shipments.companyId, COMPANY))
  await db.delete(tnaMilestones).where(eq(tnaMilestones.companyId, COMPANY))
  await db.delete(rfqs).where(eq(rfqs.companyId, COMPANY))
  // Everything except the fixture order the milestone tests hang off.
  await db.delete(orders).where(sql`company_id = ${COMPANY} and source_rfq_id is not null`)
}

const newShipment = async () => {
  const [row] = await db
    .insert(shipments)
    .values({
      companyId: COMPANY,
      orderId,
      lcId,
      partialNo: Math.floor(Math.random() * 100000) + 1,
      plannedExFactory: '2026-08-10',
      expNumber: 'EXP-2026-0001',
      createdBy: USER,
    })
    .returning({ id: shipments.id })
  return row!.id
}

describe('the routing table', () => {
  it('has a handler for every wire this commit claims to connect', () => {
    expect(Object.keys(EVENT_HANDLERS).sort()).toEqual([
      'cutting.order.complete',
      // An approved invoice fills the open bank presentation's invoiced amount — without
      // it a realization has nothing to post against (live-test finding, Phase 8).
      'finance.invoice.drafted',
      'finance.realized',
      'maintenance.ticket.resolved',
      // Not a cross-module write like the others — it is the extraction runner reacting to
      // its own queue event so a pasted PO is read in seconds rather than on the poller's
      // five-minute tick (plan 6.6, audit AI-M4).
      'marbim.extraction.queued',
      'orders.order.status_changed',
      'production.downtime.machine',
      'quality.final.passed',
      'rfq.won',
      'shipment.docs.ready_for_bank',
      'shipment.ex_factory.confirmed',
    ])
  })

  it('ignores an event nobody consumes', async () => {
    // Most events exist so somebody can be notified. An unhandled one is not an error.
    await expect(deliver('planning.allocation.created', { orderId })).resolves.toBeUndefined()
  })
})

describe('8.1 → 2.1 · the bank handoff opens a presentation', () => {
  it('opens one carrying the document kinds and the invoice value', async () => {
    await reset()
    const shipmentId = await newShipment()
    await draftInvoice(
      ctx,
      {
        orderId,
        shipmentId,
        number: `INV-${randomUUID().slice(0, 8)}`,
        invoiceDate: '2026-08-01',
        value: '50000.00',
        currency: 'USD',
      },
      FINANCE_POLICY,
    )

    await deliver('shipment.docs.ready_for_bank', {
      shipmentId,
      orderId,
      expNumber: 'EXP-2026-0001',
      kinds: ['commercial_invoice', 'bl'],
    })

    const [submission] = await db
      .select()
      .from(docSubmissions)
      .where(eq(docSubmissions.shipmentId, shipmentId))

    expect(submission).toBeDefined()
    expect(submission!.lcId).toBe(lcId)
    // The invoice value came from 11.1 rather than being left null.
    expect(submission!.invoicedAmount).toBe('50000.00')
    expect((submission!.docs as { kind: string }[]).map((d) => d.kind)).toEqual([
      'commercial_invoice',
      'bl',
    ])
  })

  it('a redelivery does not open a second presentation', async () => {
    await reset()
    const shipmentId = await newShipment()
    const eventId = randomUUID()

    await deliver('shipment.docs.ready_for_bank', { shipmentId, kinds: ['bl'] }, eventId)
    // Same event id: caught by processed_events.
    await deliver('shipment.docs.ready_for_bank', { shipmentId, kinds: ['bl'] }, eventId)
    // A DIFFERENT event id for the same shipment — a re-presentation. Caught by the
    // handler's own idempotency, which is the guarantee that actually matters.
    await deliver('shipment.docs.ready_for_bank', { shipmentId, kinds: ['bl'] })

    const rows = await db
      .select()
      .from(docSubmissions)
      .where(eq(docSubmissions.shipmentId, shipmentId))
    expect(rows).toHaveLength(1)
  })

  it('skips a shipment with no LC rather than retrying into an alert', async () => {
    await reset()
    const [row] = await db
      .insert(shipments)
      .values({
        companyId: COMPANY,
        orderId,
        partialNo: 999,
        plannedExFactory: '2026-08-10',
        createdBy: USER,
      })
      .returning({ id: shipments.id })

    const eventId = randomUUID()
    await expect(
      deliver('shipment.docs.ready_for_bank', { shipmentId: row!.id }, eventId),
    ).resolves.toBeUndefined()

    // Marked processed so it does not come back every retry.
    const marked = await db
      .select()
      .from(processedEvents)
      .where(and(eq(processedEvents.eventId, eventId), eq(processedEvents.queue, QUEUE.derive)))
    expect(marked).toHaveLength(1)
  })
})

describe('2.1 → 11.1 · a realization closes the receivable', () => {
  it('carries the shortfall through, rather than closing at the invoice value', async () => {
    await reset()
    const shipmentId = await newShipment()
    const drafted = await draftInvoice(
      ctx,
      {
        orderId,
        shipmentId,
        number: `INV-${randomUUID().slice(0, 8)}`,
        invoiceDate: '2026-08-01',
        value: '50000.00',
        currency: 'USD',
      },
      FINANCE_POLICY,
    )

    // The real 2.1 path, so the payload is the one that module actually emits.
    const { submissionId } = await (
      await import('@/modules/commercial/service')
    ).openSubmission(ctx, {
      lcId,
      shipmentId,
      docs: [],
      invoicedAmount: '50000.00',
      currency: 'USD',
    })
    await setSubmissionStatus(ctx, {
      submissionId,
      bankStatus: 'submitted',
      submittedAt: '2026-08-05',
    })
    await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })
    await postRealization(
      ctx,
      { submissionId, realizedAmount: '49250.00', realizedAt: '2026-08-20' },
      BANK_POLICY,
    )

    // The event 2.1 emitted, delivered as the relay would.
    const emitted = await db.execute<{ payload: Record<string, unknown> }>(
      sql`select payload from outbox
          where company_id = ${COMPANY} and event_name = 'finance.realized'
          order by occurred_at desc limit 1`,
    )
    const list = Array.isArray(emitted) ? emitted : ((emitted as { rows?: unknown[] }).rows ?? [])
    const payload = (list[0] as { payload: Record<string, unknown> }).payload

    await deliver('finance.realized', payload)

    const [receivable] = await db
      .select()
      .from(receivables)
      .where(eq(receivables.invoiceId, drafted.invoiceId))

    expect(receivable!.status).toBe('realized')
    expect(receivable!.realizedAmount).toBe('49250.00')
    // The $750 the bank kept. A receivable closed at the invoice value would lose it.
    expect(receivable!.shortfall).toBe('750.00')
  })

  it('skips a realization for a shipment with no invoice yet', async () => {
    await reset()
    const shipmentId = await newShipment()

    // A sequencing gap, not an error: retrying five times then paging somebody at 3am
    // teaches people to ignore the alerts.
    await expect(
      deliver('finance.realized', {
        shipmentId,
        realizedAmount: '1000.00',
        realizedAt: '2026-08-20',
      }),
    ).resolves.toBeUndefined()
  })

  it('a redelivery does not settle the receivable twice', async () => {
    await reset()
    const shipmentId = await newShipment()
    const drafted = await draftInvoice(
      ctx,
      {
        orderId,
        shipmentId,
        number: `INV-${randomUUID().slice(0, 8)}`,
        invoiceDate: '2026-08-01',
        value: '50000.00',
        currency: 'USD',
      },
      FINANCE_POLICY,
    )

    const payload = {
      shipmentId,
      realizedAmount: '49250.00',
      realizedAt: '2026-08-20',
    }

    await deliver('finance.realized', payload)
    // A different event id, so processed_events does not catch it — the handler's own
    // refusal to re-settle is what has to hold.
    await expect(deliver('finance.realized', payload)).rejects.toThrow(/already_settled/)

    const [receivable] = await db
      .select()
      .from(receivables)
      .where(eq(receivables.invoiceId, drafted.invoiceId))
    expect(receivable!.realizedAmount).toBe('49250.00')
  })
})

describe('1.2 → 1.3 · a won RFQ becomes an order', () => {
  const wonEvent = (rfqId: string, over: Record<string, unknown> = {}) => ({
    rfqId,
    buyerId,
    styleCode: 'ST-100',
    quantity: 12000,
    unit: 'pcs',
    sizeRatio: { S: 1, M: 2, L: 2, XL: 1 },
    sizeBreakdown: { S: 2000, M: 4000, L: 4000, XL: 2000 },
    // Four decimal places, because that is what a real win carries: `quotes.fob_price`
    // is numeric(14,4), so the live payload says "4.9800" even when the price is $4.98.
    // The first live win failed for exactly this — the fixture said '4.98' and never
    // exercised the seam.
    fobPrice: '4.9800',
    currency: 'USD',
    requestedShipDate: '2026-11-15',
    ...over,
  })

  const newRfq = async () => {
    const [row] = await db
      .insert(rfqs)
      .values({
        companyId: COMPANY,
        buyerId,
        title: 'Basic tee 12k',
        // What a merchandiser actually types. Resolved through the alias map.
        productType: 'tshirt',
        quantity: 12000,
        currency: 'USD',
        status: 'quoted',
        createdBy: USER,
      })
      .returning({ id: rfqs.id })
    return row!.id
  }

  it('creates the order and its style, carrying price and ship date', async () => {
    await reset()
    const rfqId = await newRfq()

    await deliver('rfq.won', wonEvent(rfqId))

    const [order] = await db.select().from(orders).where(eq(orders.sourceRfqId, rfqId))
    expect(order).toBeDefined()
    expect(order!.buyerId).toBe(buyerId)
    // The whole plan is generated backwards from this date.
    expect(order!.plannedExFactoryDate).toBe('2026-11-15')

    const styles = await db.select().from(orderStyles).where(eq(orderStyles.orderId, order!.id))
    expect(styles).toHaveLength(1)
    expect(styles[0]!.styleCode).toBe('ST-100')
    expect(styles[0]!.contractedQty).toBe(12000)
    // "4.9800" from the quote lands as "4.98" in the order book — same number, the
    // formatting trimmed at the seam rather than refused by orders' 2-place zod.
    expect(styles[0]!.unitPrice).toBe('4.98')
  })

  it('creates NO breakdown — the colours come with the buyer’s PO', async () => {
    await reset()
    const rfqId = await newRfq()
    await deliver('rfq.won', wonEvent(rfqId))

    const [order] = await db.select().from(orders).where(eq(orders.sourceRfqId, rfqId))
    const [style] = await db.select().from(orderStyles).where(eq(orderStyles.orderId, order!.id))

    const { orderBreakdowns } = await import('@/modules/orders/schema')
    const cells = await db
      .select()
      .from(orderBreakdowns)
      .where(eq(orderBreakdowns.orderStyleId, style!.id))

    // An RFQ carries a size RATIO, not a colour × size grid. Inventing a placeholder
    // colour would put a number on the cutting floor no buyer ever asked for — and 5.1
    // already refuses to spread a lay against a style with no breakdown, so the gap is
    // caught by a gate that exists.
    expect(cells).toHaveLength(0)
  })

  it('a redelivery does not create a second order', async () => {
    await reset()
    const rfqId = await newRfq()

    await deliver('rfq.won', wonEvent(rfqId))
    // A different event id, so processed_events does not catch it — the unique index on
    // `source_rfq_id` and the handler's own check are what must hold.
    await deliver('rfq.won', wonEvent(rfqId))

    const rows = await db.select().from(orders).where(eq(orders.sourceRfqId, rfqId))
    // Two orders for one win would double the factory's committed capacity against a
    // single buyer commitment.
    expect(rows).toHaveLength(1)
  })

  it('generates the schedule from the template matching the product type', async () => {
    await reset()
    const rfqId = await newRfq()

    await deliver('rfq.won', wonEvent(rfqId))

    const [order] = await db.select().from(orders).where(eq(orders.sourceRfqId, rfqId))
    const milestones = await db
      .select()
      .from(tnaMilestones)
      .where(eq(tnaMilestones.orderId, order!.id))

    expect(milestones.length).toBeGreaterThan(5)

    // The three names other modules query BY NAME. Without them the PP escalation, the
    // pre-final readiness check and the ripple are all blind to this order.
    const names = milestones.map((m) => m.name)
    expect(names).toContain('cutting')
    expect(names).toContain('final_inspection')
    expect(names).toContain('ex_factory')

    // Anchored on the requested ship date, which is what the whole calendar is built
    // backwards from.
    const exFactory = milestones.find((m) => m.name === 'ex_factory')!
    expect(exFactory.plannedDate).toBe('2026-11-15')

    // And it is a real chain: cutting sits well before shipping.
    const cutting = milestones.find((m) => m.name === 'cutting')!
    expect(cutting.plannedDate < exFactory.plannedDate).toBe(true)
  })

  it('picks the WOVEN calendar for a shirt, not the knit one', async () => {
    await reset()
    const [row] = await db
      .insert(rfqs)
      .values({
        companyId: COMPANY,
        buyerId,
        title: 'Oxford shirt 8k',
        productType: 'shirt',
        quantity: 8000,
        currency: 'USD',
        status: 'quoted',
        createdBy: USER,
      })
      .returning({ id: rfqs.id })

    await deliver('rfq.won', wonEvent(row!.id, { quantity: 8000 }))

    const [order] = await db.select().from(orders).where(eq(orders.sourceRfqId, row!.id))
    const milestones = await db
      .select()
      .from(tnaMilestones)
      .where(eq(tnaMilestones.orderId, order!.id))

    // A woven shirt needs cloth woven to order: fabric lands two months out, not six weeks.
    // Giving it the knit calendar would put the ship date a month early from day one.
    const fabric = milestones.find((m) => m.name === 'fabric_in_house')!
    expect(fabric.plannedDate < '2026-09-20').toBe(true)
  })

  it('creates the order but NO schedule for an unknown product type', async () => {
    await reset()
    const [row] = await db
      .insert(rfqs)
      .values({
        companyId: COMPANY,
        buyerId,
        title: 'Swim shorts 3k',
        productType: 'swimwear',
        quantity: 3000,
        currency: 'USD',
        status: 'quoted',
        createdBy: USER,
      })
      .returning({ id: rfqs.id })

    await deliver('rfq.won', wonEvent(row!.id, { quantity: 3000 }))

    const [order] = await db.select().from(orders).where(eq(orders.sourceRfqId, row!.id))

    // The order exists and is usable. Only the calendar is missing — a visible gap rather
    // than a silently wrong one, because falling back to the shortest template would give
    // swimwear a 90-day schedule nobody chose.
    expect(order).toBeDefined()
    const milestones = await db
      .select()
      .from(tnaMilestones)
      .where(eq(tnaMilestones.orderId, order!.id))
    expect(milestones).toHaveLength(0)
  })

  it('skips a win for an RFQ nobody can see', async () => {
    await reset()
    await expect(deliver('rfq.won', wonEvent(randomUUID()))).resolves.toBeUndefined()
  })

  it('skips a win carrying no usable quantity', async () => {
    await reset()
    const rfqId = await newRfq()

    await expect(deliver('rfq.won', wonEvent(rfqId, { quantity: 0 }))).resolves.toBeUndefined()
    expect(await db.select().from(orders).where(eq(orders.sourceRfqId, rfqId))).toHaveLength(0)
  })
})

describe('→ 1.3 · milestones actualise', () => {
  const milestone = (name: string, plannedDate: string) =>
    db.insert(tnaMilestones).values({ companyId: COMPANY, orderId, name, plannedDate })

  it('actualises the RIGHT milestone when an order has several', async () => {
    await reset()
    // `ex_factory` is inserted FIRST on purpose: a handler that matched on order alone
    // would take whichever row came back first, so putting the wrong one there is what
    // makes this test able to fail.
    await milestone('ex_factory', '2026-09-01')
    await milestone('cutting', '2026-08-01')
    await milestone('sewing', '2026-08-15')

    await deliver('cutting.order.complete', { orderId, completedOn: '2026-08-03' })

    const rows = await db.select().from(tnaMilestones).where(eq(tnaMilestones.orderId, orderId))
    const cutting = rows.find((r) => r.name === 'cutting')!
    const shipment = rows.find((r) => r.name === 'ex_factory')!

    expect(cutting.actualDate).toBe('2026-08-03')
    expect(cutting.status).toBe('done')
    // Untouched. Selecting by order alone would have hit whichever row came back first.
    expect(shipment.actualDate).toBeNull()
    expect(rows.find((r) => r.name === 'sewing')!.actualDate).toBeNull()
  })

  it('uses the date on the event, not the day the job happened to run', async () => {
    await reset()
    await milestone('ex_factory', '2026-09-01')

    await deliver('shipment.ex_factory.confirmed', { orderId, actualExFactory: '2026-08-28' })

    const [row] = await db
      .select()
      .from(tnaMilestones)
      .where(and(eq(tnaMilestones.orderId, orderId), eq(tnaMilestones.name, 'ex_factory')))
    expect(row!.actualDate).toBe('2026-08-28')
  })

  it('does not move a date somebody has since corrected', async () => {
    await reset()
    await milestone('cutting', '2026-08-01')

    await deliver('cutting.order.complete', { orderId, completedOn: '2026-08-03' })
    // A redelivery with a different date must not overwrite the recorded actual.
    await deliver('cutting.order.complete', { orderId, completedOn: '2026-08-09' })

    const [row] = await db
      .select()
      .from(tnaMilestones)
      .where(and(eq(tnaMilestones.orderId, orderId), eq(tnaMilestones.name, 'cutting')))
    expect(row!.actualDate).toBe('2026-08-03')
  })

  it('applies the RIPPLE, moving every milestone downstream of the slip', async () => {
    await reset()
    // A real dependency chain: sewing waits on cutting, shipping waits on sewing.
    await db.insert(tnaMilestones).values([
      {
        companyId: COMPANY,
        orderId,
        name: 'cutting',
        plannedDate: '2026-08-01',
        dependsOn: [],
        critical: true,
      },
      {
        companyId: COMPANY,
        orderId,
        name: 'sewing',
        plannedDate: '2026-08-10',
        dependsOn: [{ name: 'cutting', gapDays: 9 }],
        critical: true,
      },
      {
        companyId: COMPANY,
        orderId,
        name: 'ex_factory',
        plannedDate: '2026-09-01',
        dependsOn: [{ name: 'sewing', gapDays: 22 }],
        critical: true,
      },
    ])

    // Cutting finished six days late.
    await deliver('cutting.order.complete', { orderId, completedOn: '2026-08-07' })

    const rows = await db.select().from(tnaMilestones).where(eq(tnaMilestones.orderId, orderId))
    const sewing = rows.find((r) => r.name === 'sewing')!
    const exFactory = rows.find((r) => r.name === 'ex_factory')!

    // The whole point of going through 1.3's `actualizeMilestone` rather than writing the
    // table: a direct write would record the actual date and leave the rest of the calendar
    // still claiming the order was on time.
    expect(sewing.plannedDate).not.toBe('2026-08-10')
    expect(exFactory.plannedDate).not.toBe('2026-09-01')
    expect(sewing.plannedDate > '2026-08-10').toBe(true)
  })

  it('is a no-op when the order has no such milestone', async () => {
    await reset()
    await expect(
      deliver('cutting.order.complete', { orderId, completedOn: '2026-08-03' }),
    ).resolves.toBeUndefined()
  })
})

describe('1.3 → 1.6 · closing an order compiles its outcome', () => {
  it('compiles on close, and only on close', async () => {
    await reset()
    const { orderOutcomes } = await import('@/modules/memory/schema')
    await db.delete(orderOutcomes).where(eq(orderOutcomes.orderId, orderId))

    // Every other transition belongs to somebody else. An order entering production has no
    // outcome to compile, and compiling one then would freeze a record of nothing.
    await deliver('orders.order.status_changed', {
      orderId,
      from: 'confirmed',
      to: 'in_production',
    })
    expect(
      await db.select().from(orderOutcomes).where(eq(orderOutcomes.orderId, orderId)),
    ).toHaveLength(0)

    await deliver('orders.order.status_changed', { orderId, from: 'shipped_full', to: 'closed' })

    const compiled = await db
      .select()
      .from(orderOutcomes)
      .where(eq(orderOutcomes.orderId, orderId))
    expect(compiled).toHaveLength(1)
    // This fixture order has none of the four inputs. The flags say so rather than letting
    // the empty arrays read as a clean, defect-free, on-time run.
    expect(compiled[0]!.compiledSources).toMatchObject({ defects: false, margins: false })
  })

  it('a redelivered close does not file a second account of the same order', async () => {
    await reset()
    const { orderOutcomes } = await import('@/modules/memory/schema')

    const eventId = randomUUID()
    await deliver('orders.order.status_changed', { orderId, from: 'shipped_full', to: 'closed' })
    await deliver(
      'orders.order.status_changed',
      { orderId, from: 'shipped_full', to: 'closed' },
      eventId,
    )

    expect(
      await db.select().from(orderOutcomes).where(eq(orderOutcomes.orderId, orderId)),
    ).toHaveLength(1)
  })
})

describe('6.1 → 9.1 · a machine stoppage raises a maintenance ticket', () => {
  it('opens one at line_down priority, once per stoppage', async () => {
    await reset()
    const { lines } = await import('@/modules/planning/schema')
    const { machines, tickets } = await import('@/modules/maintenance/schema')

    const [line] = await db
      .insert(lines)
      .values({ companyId: COMPANY, code: `L-${randomUUID().slice(0, 6)}`, name: 'Line' })
      .returning({ id: lines.id })

    const [machine] = await db
      .insert(machines)
      .values({ companyId: COMPANY, machineType: 'overlock', lineId: line!.id })
      .returning({ id: machines.id })

    const downtimeId = randomUUID()
    const event = {
      downtimeId,
      lineId: line!.id,
      machineId: machine!.id,
      reason: 'machine',
      startedAt: '2026-03-01T04:00:00Z',
    }

    await deliver('production.downtime.machine', event)
    // Redelivered with a different event id, which is what the outbox actually does.
    await deliver('production.downtime.machine', event)

    const raised = await db.select().from(tickets).where(eq(tickets.downtimeId, downtimeId))
    // One stoppage, one ticket. Three would read as three breakdowns in the outlier report.
    expect(raised).toHaveLength(1)
    expect(raised[0]!.priority).toBe('line_down')
    expect(raised[0]!.source).toBe('downtime_auto')

    await db.delete(tickets).where(eq(tickets.downtimeId, downtimeId))
    await db.delete(machines).where(eq(machines.id, machine!.id))
    await db.delete(lines).where(eq(lines.id, line!.id))
  })
})

