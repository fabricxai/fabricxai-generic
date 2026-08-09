/**
 * Event consumers — the bridge between modules that were built to fit and never connected.
 *
 * Until now every module emitted its outbox events and nothing listened. Each pair below
 * was built from both ends: one module emits a payload shaped exactly as the other's entry
 * point expects, and the two halves were tested independently. This file is the wire.
 *
 * Three rules govern everything here:
 *
 *  1. **Every handler is independently idempotent.** A queue redelivers, and
 *     `processed_events` is a fast path rather than the guarantee — see the note on
 *     `runEventConsumer` for exactly which window it does and does not close. These
 *     handlers write money, so re-running one must be a no-op on its own terms.
 *  2. **A missing counterpart is not a failure.** A `finance.realized` for a shipment with
 *     no invoice yet is a sequencing gap, not an error: retrying it five times and then
 *     alerting somebody at 3am teaches people to ignore the alerts. It is logged and
 *     marked processed.
 *  3. **The consumer never invents context.** It runs as a system actor scoped to the
 *     event's own company, and calls the owning module's service — it does not write
 *     another module's tables itself (CLAUDE.md rule 11).
 */
import type { Job } from 'bullmq'
import { and, eq } from 'drizzle-orm'

import { processedEvents } from '@/db/schema/core'
import type { SystemCtx } from '@/modules/core/ctx'
import { isAppError } from '@/modules/core/errors'
import { markProcessed } from '@/modules/core/outbox'
import { withTenantRead, withTenantTx } from '@/modules/core/tenancy'

import { hasProvider } from '@/modules/marbim/provider'
import { runExtraction } from '@/modules/marbim/service'
import type { MarbimPolicy } from '@/modules/marbim/service'
import { getPolicy } from '@/modules/settings/service'

import { QUEUE } from '../queues'
import { factoryToday } from '@/lib/dates'
import { fitToScale } from '@/lib/quantity'

export interface EventJobData {
  eventId: string
  companyId: string
  payload: Record<string, unknown>
}

/**
 * The actor a consumer runs as: a system context scoped to the company on the event.
 *
 * `roles: ['owner']` is broader than it should be. It matches what the scheduler already
 * does, and there is no `system` role to narrow it to — adding one means auditing every
 * role check in the repo, which is not this commit. Logged in docs/STUBS.md. Two things
 * limit the blast radius meanwhile: the context is company-scoped so RLS binds it exactly
 * as it binds a request, and `userId` is null so nothing it writes is attributed to a
 * person who did not do it.
 */
export function systemCtx(companyId: string): SystemCtx {
  return { companyId, userId: null, roles: ['owner'], system: true }
}

type Handler = (ctx: SystemCtx, payload: Record<string, unknown>) => Promise<void>

/** A counterpart that is not there yet. Logged and swallowed — see rule 2 above. */
class NotReadyYet extends Error {
  override readonly name = 'NotReadyYet'
}

const notReady = (reason: string): never => {
  throw new NotReadyYet(reason)
}

// ─────────────────────────────────────────────────────────────────────────────
// The handlers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 8.1 handed its document set to the bank → 2.1 opens the presentation.
 *
 * The EXP gate has already passed by the time this event exists — 8.1 refuses the handoff
 * without it — so this consumer does not re-check it. What it does is give the commercial
 * desk a row to track the bank's response against.
 */
const onDocsReadyForBank: Handler = async (ctx, payload) => {
  const shipmentId = String(payload.shipmentId ?? '')
  if (!shipmentId) notReady('event carries no shipmentId')

  const { shipments } = await import('@/modules/shipment/schema')
  const { docSubmissions } = await import('@/modules/commercial/schema')
  const { openSubmission } = await import('@/modules/commercial/service')
  const { withTenantRead } = await import('@/modules/core/tenancy')

  const existing = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: docSubmissions.id })
      .from(docSubmissions)
      .where(eq(docSubmissions.shipmentId, shipmentId))
    return row
  })

  // A second event for the same shipment — a re-presentation — reuses the row, because the
  // bank treats it as the same presentation.
  if (existing) return

  const shipment = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx.select().from(shipments).where(eq(shipments.id, shipmentId))
    return row
  })

  if (!shipment) notReady(`shipment ${shipmentId} not visible`)
  if (!shipment!.lcId) notReady(`shipment ${shipmentId} has no LC to present against`)

  // The invoice value, if 11.1 has raised one. A presentation can be opened without it and
  // have it filled in later; refusing here would leave the commercial desk with nothing to
  // track while they chase the invoice.
  const { invoices } = await import('@/modules/finance/schema')
  const invoiced = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ value: invoices.value, currency: invoices.currency })
      .from(invoices)
      .where(eq(invoices.shipmentId, shipmentId))
    return row
  })

  await openSubmission(ctx, {
    lcId: shipment!.lcId!,
    shipmentId,
    docs: Array.isArray(payload.kinds)
      ? (payload.kinds as string[]).map((kind) => ({ kind, status: 'submitted' }))
      : [],
    invoicedAmount: invoiced?.value,
    currency: invoiced?.currency ?? 'USD',
  })
}

/**
 * 11.1 raised an invoice → 2.1 fills the open presentation's invoiced amount.
 *
 * The presentation is opened when documents reach the bank, usually before the invoice is
 * approved — and a realization cannot post against a presentation with no invoiced amount.
 * Idempotent: `fillSubmissionInvoice` leaves alone a submission already carrying an amount
 * or already realized.
 */
const onInvoiceDrafted: Handler = async (ctx, payload) => {
  const shipmentId = payload.shipmentId ? String(payload.shipmentId) : null
  const value = payload.value ? String(payload.value) : null
  if (!shipmentId || !value) return

  const { fillSubmissionInvoice } = await import('@/modules/commercial/service')
  await fillSubmissionInvoice(ctx, {
    shipmentId,
    invoicedAmount: value,
    currency: String(payload.currency ?? 'USD'),
  })
}

/**
 * 2.1 posted a realization → 11.1 closes the receivable.
 *
 * The payload carries BOTH the invoiced and realized amounts, because the difference is what
 * the bank kept and the receivable has to record it rather than closing at the invoice value.
 */
const onFinanceRealized: Handler = async (ctx, payload) => {
  const shipmentId = payload.shipmentId ? String(payload.shipmentId) : null
  if (!shipmentId) notReady('realization carries no shipmentId')

  const { invoices } = await import('@/modules/finance/schema')
  const { postRealizationToReceivable } = await import('@/modules/finance/service')
  const { withTenantRead } = await import('@/modules/core/tenancy')

  const invoice = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: invoices.id })
      .from(invoices)
      .where(eq(invoices.shipmentId, shipmentId!))
    return row
  })

  // No invoice raised for this shipment yet. A sequencing gap, not an error.
  if (!invoice) notReady(`no invoice for shipment ${shipmentId}`)

  await postRealizationToReceivable(ctx, {
    invoiceId: invoice!.id,
    submissionId: payload.submissionId ? String(payload.submissionId) : undefined,
    realizedAmount: String(payload.realizedAmount),
    realizedAt: String(payload.realizedAt),
  })
}

/**
 * 5.1 finished cutting a style → 1.3 actualises the cutting milestone.
 *
 * The milestone is actualised on the date the event says, not on today: a day-close that
 * runs late must not record the cutting as having finished when the job happened to run.
 */
const onCuttingComplete: Handler = async (ctx, payload) => {
  const orderId = String(payload.orderId ?? '')
  if (!orderId) notReady('event carries no orderId')

  await actualiseMilestone(ctx, {
    orderId,
    name: 'cutting',
    on: typeof payload.completedOn === 'string' ? payload.completedOn : factoryToday(),
  })
}

/** 8.1 confirmed ex-factory → 1.3 actualises the shipment milestone. */
const onExFactoryConfirmed: Handler = async (ctx, payload) => {
  const orderId = String(payload.orderId ?? '')
  if (!orderId) notReady('event carries no orderId')

  await actualiseMilestone(ctx, {
    orderId,
    name: 'ex_factory',
    on: String(payload.actualExFactory ?? factoryToday()),
  })
}

/**
 * 7.1 final inspection passed → 1.3 actualises the `final_inspection` milestone.
 *
 * Only on a PASS. A failed lot has not reached the milestone — it is going to be re-worked
 * and re-inspected — and stamping the date anyway would tell the TNA the order is further
 * along than it is, which is precisely the moment a merchandiser stops chasing it. The
 * failure raises its own alert; it does not move the calendar.
 */
const onFinalInspectionPassed: Handler = async (ctx, payload) => {
  const orderId = String(payload.orderId ?? '')
  if (!orderId) notReady('event carries no orderId')

  await actualiseMilestone(ctx, {
    orderId,
    name: 'final_inspection',
    on: typeof payload.inspectedOn === 'string' ? payload.inspectedOn : factoryToday(),
  })
}

/**
 * 9.1 ticket resolved → 6.1 closes the stoppage it came from.
 *
 * The canvas is explicit that this happens "unprompted": a mechanic who has just got a
 * machine running should not then be asked to file how long it was broken. They would
 * guess, and the guess is the number the line's efficiency is measured on.
 *
 * Only for tickets that CAME FROM a stoppage. A mechanic's own ticket for a machine that
 * was already idle has no downtime behind it, and closing one that does not exist would
 * invent minutes the floor never lost.
 */
const onTicketResolved: Handler = async (ctx, payload) => {
  const downtimeId = payload.downtimeId
  if (typeof downtimeId !== 'string' || !downtimeId) {
    // Not a sequencing gap — a manual ticket legitimately has none. Nothing to do.
    return
  }

  const { closeLineDowntime } = await import('@/modules/production/service')

  await closeLineDowntime(ctx, {
    downtimeId,
    // The moment the mechanic said the machine was running. `closeLineDowntime` refuses an
    // already-closed downtime, which is what makes a redelivery of this event a no-op.
    endedAt: new Date().toISOString(),
  })
}

/**
 * Mark a TNA milestone actual, through 1.3's own operation.
 *
 * This used to write `tna_milestones` directly, which was wrong twice over: it broke rule
 * 11, and — much worse — it skipped the RIPPLE. `actualizeMilestone` reschedules everything
 * downstream of a slip in the same transaction, so a cut that finished six days late moved
 * the sewing and shipping dates with it. The direct write recorded the actual date and left
 * the rest of the calendar claiming the order was still on time.
 */
async function actualiseMilestone(
  ctx: SystemCtx,
  input: { orderId: string; name: string; on: string },
): Promise<void> {
  const { actualizeMilestone, findMilestone } = await import('@/modules/orders/service')

  const milestone = await findMilestone(ctx, { orderId: input.orderId, name: input.name })
  // No such milestone on this order. Some orders have no TNA, and that is not this
  // consumer's problem to solve.
  if (!milestone) return
  // Already actual. A redelivery must not move a date somebody has since corrected —
  // `actualizeMilestone` would throw, so the check is here rather than as a caught error.
  if (milestone.actualDate) return

  await actualizeMilestone(ctx, { milestoneId: milestone.id, actualDate: input.on })
}

/**
 * 1.2 won an RFQ → 1.3 creates the order.
 *
 * The last wire in the chain, and the one that closes the loop from enquiry to production.
 * `wonPayload` already refused anything an order cannot be created from — no size ratio, no
 * requested ship date — so by the time this event exists the payload is complete.
 *
 * Idempotent on the RFQ: a redelivery finds the order already carrying this `rfqId` and
 * returns. Creating a second order for one win would double the factory's committed
 * capacity against a single buyer commitment.
 */
const onRfqWon: Handler = async (ctx, payload) => {
  const rfqId = String(payload.rfqId ?? '')
  if (!rfqId) notReady('win carries no rfqId')

  const { createOrder } = await import('@/modules/orders/service')
  const { orders } = await import('@/modules/orders/schema')
  const { rfqs } = await import('@/modules/rfq/schema')

  const existing = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: orders.id })
      .from(orders)
      .where(eq(orders.sourceRfqId, rfqId))
    return row
  })

  // Already created. Two orders for one win would double the committed capacity.
  if (existing) return

  const rfq = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx.select().from(rfqs).where(eq(rfqs.id, rfqId))
    return row
  })
  if (!rfq) notReady(`RFQ ${rfqId} not visible`)

  const quantity = Number(payload.quantity)
  if (!Number.isInteger(quantity) || quantity <= 0) {
    notReady(`win for RFQ ${rfqId} carries no usable quantity`)
  }

  const created = await createOrder(ctx, {
    sourceRfqId: rfqId,
    order: {
      buyerId: String(payload.buyerId),
      // The PO number arrives with the buyer's actual purchase order. Until then the RFQ
      // is what the order is known by — a placeholder here would look like a real PO
      // number on a document.
      poNumbers: [`RFQ-${rfq!.title}`.slice(0, 60)],
      currency: String(payload.currency ?? 'USD'),
      plannedExFactoryDate: String(payload.requestedShipDate),
      ownerUserId: rfq!.ownerUserId ?? undefined,
    },
    styles: [
      {
        styleCode: String(payload.styleCode),
        contractedQty: quantity,
        // Quotes carry four decimal places ("6.9500"); the order book stores two. Same
        // number, different formatting — `fitToScale` trims the zeros and REFUSES a price
        // that would actually lose a digit, because an order that does not match the quote
        // the buyer holds is worse than no order.
        unitPrice: fitToScale(String(payload.fobPrice), 2, 'the won quote price'),
        currency: String(payload.currency ?? 'USD'),
      },
    ],
  })

  // ── The calendar ──
  //
  // Generated here rather than left to a merchandiser, because an order with no schedule is
  // an order nothing downstream has a date to be late against: 1.4's PP escalation, 7.1's
  // pre-final readiness and 8.1's LC countdown all read milestones by name.
  //
  // A product type with no template does NOT get one invented. Falling back to the shortest
  // calendar would give a jacket a 90-day schedule and a ship date that was wrong from the
  // day it was created. The order still exists and is usable; only the schedule is missing,
  // and that is a visible gap rather than a silently wrong one.
  const { findTemplateForProductType, generateTna } = await import('@/modules/orders/service')
  const template = await findTemplateForProductType(ctx, { productType: rfq!.productType })

  if (!template) {
    console.warn(
      `[consumer] rfq.won: order ${created.orderId} created without a TNA — ` +
        `no template for product type "${rfq!.productType}"`,
    )
    return
  }

  await generateTna(ctx, {
    orderId: created.orderId,
    templateId: template.id,
    exFactoryDate: String(payload.requestedShipDate),
  })
}


/**
 * An order closed → compile its outcome (1.6).
 *
 * The only moment the factory's own record of an order can be assembled: production has
 * stopped, the cartons have shipped, and finance has settled — but the tables it is built
 * from are still live and will keep moving. Compiling now is what freezes it.
 *
 * Idempotent by construction: `compileOutcome` upserts on `order_id`, so a redelivery
 * recompiles the same row rather than filing a second, competing account of one order. It
 * deliberately leaves the merchandiser's note alone.
 */
async function onOrderStatusChanged(ctx: SystemCtx, payload: Record<string, unknown>) {
  // Every other transition is somebody else's business.
  if (payload.to !== 'closed') return

  const orderId = String(payload.orderId)

  /*
   * Freeze the money BEFORE the outcome that reads it (live-test finding, Phase 8):
   * `accrueOrderCosts` and `orderPnl` had no production caller at all, so
   * `order_profitability` stayed empty forever and the outcome card's margin had nothing
   * behind it. Accrual needs shipped pieces to divide by and a style with an approved
   * cost sheet to compare against — an order closed without either is a legitimate close
   * whose waterfall simply cannot exist, so those two skip with a log rather than
   * poisoning the queue; the outcome is still compiled either way.
   */
  const { cartons } = await import('@/modules/shipment/schema')
  const { orderStyles } = await import('@/modules/orders/schema')

  const { pieces, styleCode } = await withTenantRead(ctx, async (tx) => {
    const packed = await tx
      .select({ totalQty: cartons.totalQty })
      .from(cartons)
      .where(eq(cartons.orderId, orderId))
    const [style] = await tx
      .select({ styleCode: orderStyles.styleCode })
      .from(orderStyles)
      .where(eq(orderStyles.orderId, orderId))
    return {
      pieces: packed.reduce((sum, c) => sum + c.totalQty, 0),
      styleCode: style?.styleCode ?? null,
    }
  })

  if (pieces > 0 && styleCode) {
    try {
      const { accrueOrderCosts, orderPnl } = await import('@/modules/finance/service')
      const policy = await getPolicy<import('@/modules/finance/service').FinancePolicy>(
        ctx,
        'finance',
      )
      await accrueOrderCosts(ctx, { orderId, pieces, currency: 'USD' }, policy)
      await orderPnl(ctx, { orderId, styleCode }, policy)
    } catch (error) {
      if (!isAppError(error)) throw error
      // No approved sheet, no margin basis, nothing issued — refusals, not failures.
      console.warn(
        `[consumer] order ${orderId} closed without a profitability row: ${error.messageKey}`,
      )
    }
  } else {
    console.warn(
      `[consumer] order ${orderId} closed with ${pieces} packed pieces and ${
        styleCode ? 'a style' : 'no style'
      } — no per-piece accrual possible`,
    )
  }

  const { compileOutcome } = await import('@/modules/memory/service')
  await compileOutcome(ctx, { orderId })
}


/**
 * A machine stopped a line → raise a maintenance ticket (9.1).
 *
 * The brief calls for this link to be automatic, and the reason is simply what a floor looks
 * like: a supervisor with a dead line does not walk to a terminal and file paperwork. A
 * maintenance system that only knows about the breakdowns somebody remembered to report has
 * no idea which machines actually break.
 *
 * Idempotent on the downtime id — one stoppage is one ticket, however many times the outbox
 * redelivers. Three tickets from one stoppage would read as three breakdowns in the outlier
 * report and send a mechanic to strip a machine that failed once.
 */
async function onMachineDowntime(ctx: SystemCtx, payload: Record<string, unknown>) {
  const { openTicketFromDowntime } = await import('@/modules/maintenance/service')

  await openTicketFromDowntime(ctx, {
    downtimeId: String(payload.downtimeId),
    lineId: String(payload.lineId),
    machineId: payload.machineId ? String(payload.machineId) : null,
    startedAt: String(payload.startedAt),
    note: payload.note ? String(payload.note) : null,
  })
}

/**
 * A document was queued for extraction — read it now (plan 6.6, audit AI-M4).
 *
 * The poller runs every five minutes and stays, but as a SAFETY NET rather than the
 * mechanism. Five minutes is a very long time to watch a spinner after pasting a buyer's PO,
 * and it was the whole latency of the feature: median wait 2.5 minutes for work that takes
 * seconds. This makes the common case immediate and leaves the poller to pick up what events
 * cannot — a retryable failure waiting for its next attempt, a job queued while the worker
 * was down, a redelivery that arrived before the row was visible.
 *
 * ## Why this is safe to run twice
 *
 * `runExtraction` re-reads the job and returns early when it is no longer `queued` or
 * `failed`, so a redelivery racing the poller finds the row already succeeded and does
 * nothing. That is the same idempotency every handler in this file relies on, and it is
 * load-bearing here because the poller and this handler genuinely can overlap.
 *
 * ## Why it does not throw when there is no provider
 *
 * A deployment with the copilot enabled and no provider registered is a misconfiguration, and
 * 6.1 made it visible in job health. Throwing here would additionally retry the event five
 * times and park it — noise about a condition already reported, on a queue that has real work
 * on it.
 */
async function onExtractionQueued(ctx: SystemCtx, payload: Record<string, unknown>): Promise<void> {
  const jobId = String(payload.jobId ?? '')
  if (!jobId) return

  if (!hasProvider()) {
    console.warn(`[consumer] extraction ${jobId} left for the poller: no MARBIM provider`)
    return
  }

  const policy = await getPolicy<MarbimPolicy>(ctx, 'marbim')

  try {
    await runExtraction(ctx, { jobId }, policy)
  } catch (error) {
    /*
     * A rejected job throws `conflict`. Reachable here through a redelivery that arrives
     * after the poller already ran the job and rejected it — the work is terminally done,
     * and retrying the EVENT five times to rediscover that is noise on a queue with real
     * work on it.
     *
     * Anything else is rethrown: `runExtraction` records its own failures on the row, so an
     * exception escaping it is unexpected and worth a retry.
     */
    if (isAppError(error) && error.code === 'conflict') {
      console.warn(`[consumer] extraction ${jobId} was already closed: ${error.messageKey}`)
      return
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The routing table
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Event name → handler.
 *
 * An event with no handler is not an error: most events exist so somebody can be notified,
 * and only the ones that cause another module to WRITE need a consumer here.
 */
export const EVENT_HANDLERS: Readonly<Record<string, Handler>> = {
  'shipment.docs.ready_for_bank': onDocsReadyForBank,
  'finance.realized': onFinanceRealized,
  'finance.invoice.drafted': onInvoiceDrafted,
  'cutting.order.complete': onCuttingComplete,
  'shipment.ex_factory.confirmed': onExFactoryConfirmed,
  'rfq.won': onRfqWon,
  'orders.order.status_changed': onOrderStatusChanged,
  'production.downtime.machine': onMachineDowntime,
  'quality.final.passed': onFinalInspectionPassed,
  'maintenance.ticket.resolved': onTicketResolved,
  // Not a cross-module write, but the same argument: a fact committed in one place that has
  // to cause work somewhere else, promptly, rather than on a five-minute tick.
  'marbim.extraction.queued': onExtractionQueued,
}

/**
 * The `derive` queue's consumer entry point.
 *
 * **Where the idempotency actually lives.** `processed_events` is checked first and written
 * last, which leaves a window: a crash after the handler commits but before the mark means a
 * redelivery re-runs the handler. That window is safe because every handler above is
 * independently idempotent — `openSubmission` returns early on an existing presentation,
 * `postRealizationToReceivable` refuses a settled receivable, `actualiseMilestone` refuses a
 * milestone that already has a date.
 *
 * The alternative — marking first — would close that window and open a worse one: a crash
 * between the mark and the work drops the event permanently, and these handlers write money.
 * Doing the work twice is recoverable; not doing it at all is not.
 */
export async function runEventConsumer(job: Job<EventJobData>): Promise<void> {
  const handler = EVENT_HANDLERS[job.name]
  if (!handler) return

  const ctx = systemCtx(job.data.companyId)

  const alreadyDone = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ eventId: processedEvents.eventId })
      .from(processedEvents)
      .where(
        and(eq(processedEvents.eventId, job.data.eventId), eq(processedEvents.queue, QUEUE.derive)),
      )
    return row
  })
  if (alreadyDone) return

  try {
    await handler(ctx, job.data.payload ?? {})
  } catch (error) {
    if (error instanceof NotReadyYet) {
      // A counterpart that does not exist yet. Retrying would fail identically five times
      // and then page somebody about a sequencing gap. Marked so it does not come back.
      console.warn(`[consumer] ${job.name} skipped: ${error.message}`)
      await withTenantTx(ctx, (tx) => markProcessed(tx, job.data.eventId, QUEUE.derive))
      return
    }

    if (isAppError(error)) {
      console.error(`[consumer] ${job.name} failed: ${error.code} ${error.messageKey}`)
    }
    // Not marked: BullMQ retries, and the handler's own idempotency absorbs a partial
    // first attempt.
    throw error
  }

  await withTenantTx(ctx, (tx) => markProcessed(tx, job.data.eventId, QUEUE.derive))
}

