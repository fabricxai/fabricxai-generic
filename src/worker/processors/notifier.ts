/**
 * The `notify` queue — turning a relayed domain event into somebody being told.
 *
 * The relay routes by prefix: events that cause another module to WRITE go to `derive`, and
 * everything else lands here. Until now nothing listened, so "everything else is somebody
 * being told something" was aspirational — the events arrived and stopped.
 *
 * Modules that already call `notify()` inside their own jobs keep doing so, and this file
 * deliberately does not duplicate them. What it covers is the other case: a fact a module
 * committed and emitted, which somebody in a DIFFERENT department needs to hear about. A
 * roll failing 4-point inspection is the store's problem, not quality's; a lot failing AQL
 * is the shipping clerk's. The module that discovered it has no business knowing who cares.
 *
 * **An event with no rule is not an error.** Most events exist so a screen can be rebuilt or
 * an audit answered, and only some are news. An unmapped event completes quietly, exactly as
 * the derive router treats an unconsumed one — but it is logged, because a fact nobody is
 * told about is a decision somebody made, and it should be visible in the log rather than
 * inferred from silence.
 */
import type { Job } from 'bullmq'

import { notify, type NotifyInput } from '@/modules/core/notifications'
import type { Role } from '@/modules/core/ctx'
import { systemCtx } from './consumers'

export interface NotifyJobData {
  eventId: string
  companyId: string
  payload: Record<string, unknown>
}

/**
 * What a rule produces. `null` means "this particular event turned out not to be news" —
 * a rule may look at the payload and decline, which is different from having no rule.
 */
type NotifyRule = (
  payload: Record<string, unknown>,
  eventId: string,
) => Omit<NotifyInput, 'dedupeKey'> & { dedupeKey?: string } | null

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v))

/**
 * Event name → who hears about it.
 *
 * Every entry answers one question: which department finds out something they could not
 * have known from their own screens. If the answer is "the one that raised it", there is
 * no rule — they already know.
 */
export const NOTIFY_RULES: Readonly<Record<string, NotifyRule>> = {
  /**
   * A roll failed 4-point. The STORE hears, not quality: quality already knows, and the
   * store is the department holding a roll it can no longer issue.
   */
  'quality.fabric.rejected': (p, id) => ({
    role: 'store' as Role,
    kind: 'quality.fabric.rejected',
    severity: 'warning',
    titleKey: 'quality.notifications.fabric_rejected.title',
    params: {
      pointsPer100SqYd: str(p.pointsPer100SqYd),
      threshold: str(p.threshold),
    },
    moduleId: 'quality',
    entityTable: 'fabric_inspections',
    entityId: str(p.fabricInspectionId),
    dedupeKey: `quality.fabric_rejected:${str(p.fabricInspectionId) || id}`,
  }),

  /**
   * A lot failed its AQL. Shipment hears, because the consequence is theirs — the goods do
   * not leave, and the final-inspection gate will refuse the bank handoff.
   */
  'quality.final.failed': (p, id) => ({
    role: 'shipment' as Role,
    kind: 'quality.final.failed',
    severity: 'critical',
    titleKey: 'quality.notifications.final_failed.title',
    params: { lotQty: str(p.lotQty), sampleSize: str(p.sampleSize) },
    moduleId: 'quality',
    entityTable: 'final_inspections',
    entityId: str(p.finalInspectionId),
    dedupeKey: `quality.final_failed:${str(p.finalInspectionId) || id}`,
  }),

  /**
   * A bank handoff was refused for a missing EXP. Commercial hears: the EXP comes from the
   * AD bank and it is their errand, not the shipping clerk's.
   */
  'shipment.exp.missing': (p, id) => ({
    role: 'commercial' as Role,
    kind: 'shipment.exp.missing',
    severity: 'critical',
    titleKey: 'shipment.notifications.exp_missing.title',
    params: { shipmentId: str(p.shipmentId) },
    moduleId: 'shipment',
    entityTable: 'shipments',
    entityId: str(p.shipmentId),
    dedupeKey: `shipment.exp_missing:${str(p.shipmentId) || id}`,
  }),

  /**
   * Shipped quantity outside the LC's tolerance band. Commercial hears, because the bank
   * raises it and they are the ones who will argue it.
   */
  'shipment.lc_tolerance.breach': (p, id) => ({
    role: 'commercial' as Role,
    kind: 'shipment.lc_tolerance.breach',
    severity: 'critical',
    titleKey: 'shipment.notifications.tolerance_breach.title',
    params: {
      direction: str(p.direction),
      varianceQty: str(p.varianceQty),
      tolerancePct: str(p.tolerancePct),
    },
    moduleId: 'shipment',
    entityTable: 'shipments',
    entityId: str(p.shipmentId),
    dedupeKey: `shipment.tolerance_breach:${str(p.shipmentId) || id}`,
  }),

  /**
   * An owner approved a cost sheet below the margin floor. The owner already knows — they
   * did it — so this goes to FINANCE, who will otherwise meet the shortfall as a surprise
   * in the order's P&L three months later.
   */
  'costing.sheet.below_floor_approved': (p, id) => ({
    role: 'finance' as Role,
    kind: 'costing.below_floor',
    severity: 'warning',
    titleKey: 'costing.notifications.below_floor.title',
    params: {
      styleCode: str(p.styleCode),
      achievedMarginPct: str(p.achievedMarginPct),
      floorPct: str(p.floorPct),
    },
    moduleId: 'costing',
    entityTable: 'cost_sheets',
    entityId: str(p.sheetId),
    dedupeKey: `costing.below_floor:${str(p.sheetId) || id}`,
  }),

  /**
   * Cutting used materially more fabric than the marker said. The STORE hears: they are
   * holding the balance, and the requisition they sized is now wrong.
   */
  'cutting.report.variance': (p, id) => ({
    role: 'store' as Role,
    kind: 'cutting.wastage.variance',
    severity: 'warning',
    titleKey: 'cutting.notifications.wastage_variance.title',
    params: { wastagePct: str(p.wastagePct), threshold: str(p.threshold) },
    moduleId: 'cutting',
    entityTable: 'cut_reports',
    entityId: str(p.cutReportId),
    dedupeKey: `cutting.wastage:${str(p.cutReportId) || id}`,
  }),

  /**
   * A UD has been drawn past its authorisation. This is duty owed and a penalty exposure,
   * so the OWNER hears — it is not a commercial housekeeping item.
   */
  'commercial.ud.overdrawn': (p, id) => ({
    role: 'owner' as Role,
    kind: 'commercial.ud.overdrawn',
    severity: 'critical',
    titleKey: 'commercial.notifications.ud_overdrawn.title',
    params: { udNumber: str(p.udNumber), itemRef: str(p.itemRef), shortfall: str(p.shortfall) },
    moduleId: 'commercial',
    entityTable: 'uds',
    entityId: str(p.udId),
    dedupeKey: `commercial.ud_overdrawn:${str(p.udId)}:${str(p.itemRef) || id}`,
  }),

  /**
   * More arrived than was ordered, past the allowance the factory negotiated.
   *
   * FINANCE hears. Procurement recorded the receipt, so they know goods turned up — what
   * they cannot see is the consequence, which is an invoice for material nobody ordered
   * landing on somebody else's desk in three weeks. The goods are not refused: they are
   * physically in the store, and a ledger that disagrees with the shelf is worse than an
   * over-receipt. Somebody just has to decide whether to pay for it.
   */
  'procurement.receipt.over': (p, id) => ({
    role: 'finance' as Role,
    kind: 'procurement.receipt.over',
    severity: 'warning',
    titleKey: 'procurement.notifications.over_receipt.title',
    params: {
      orderedQty: str(p.orderedQty),
      receivedQty: str(p.receivedQty),
      overReceiptQty: str(p.overReceiptQty),
      tolerancePct: str(p.tolerancePct),
    },
    moduleId: 'procurement',
    entityTable: 'supplier_po_lines',
    entityId: str(p.supplierPoLineId),
    dedupeKey: `procurement.over_receipt:${str(p.supplierPoLineId) || id}`,
  }),

  /**
   * Measurements out of tolerance on a sampled size. Quality raised it; the MERCHANDISER
   * hears, because it is the buyer conversation that follows.
   */
  'quality.measurement.failed': (p, id) => ({
    role: 'merchandiser' as Role,
    kind: 'quality.measurement.failed',
    severity: 'warning',
    titleKey: 'quality.notifications.measurement_failed.title',
    params: { sampledSize: str(p.sampledSize) },
    moduleId: 'quality',
    entityTable: 'measurement_checks',
    entityId: str(p.measurementCheckId),
    dedupeKey: `quality.measurement_failed:${str(p.measurementCheckId) || id}`,
  }),

  /**
   * A document a person typed out has become a draft (plan 6.5, audit AI-H5).
   *
   * Told to the PERSON who queued it, not to a role — the exception to this file's usual
   * rule, and for a good reason. Extraction is the one asynchronous thing in the product a
   * user starts by hand and then waits on: they paste a buyer's PO, get "queued", and the
   * poller runs up to five minutes later. Without this they learn their draft is ready by
   * going back and looking, which most people do not, which is how an approve inbox fills
   * with drafts nobody opens.
   *
   * `requestedBy` can be null when the job was seeded or its user was deleted. `notify()`
   * refuses a notification addressed to nobody, so the rule declines instead — a dropped
   * notification is better than a throw that retries five times and pages somebody.
   */
  'marbim.extraction.succeeded': (p, id) => {
    const userId = str(p.requestedBy)
    if (!userId) return null

    return {
      userId,
      kind: 'marbim.extraction.succeeded',
      severity: 'info' as const,
      titleKey: 'marbim.notifications.extraction_succeeded.title',
      bodyKey: 'marbim.notifications.extraction_succeeded.body',
      params: { extractorName: str(p.extractorName) },
      moduleId: 'marbim',
      entityTable: 'pending_changes',
      entityId: str(p.pendingChangeId),
      /*
       * Home, not `/approve`.
       *
       * The reading now waits on THIS person to check it against the paper, and `/approve`
       * is the reviewer's queue — which filters on `pending` and is therefore empty for
       * them. The notification used to say "your document was read" and send them to a
       * screen showing nothing at all.
       */
      href: '/home',
      dedupeKey: `marbim.extraction_succeeded:${str(p.jobId) || id}`,
    }
  },

  /**
   * The document will not be read, and nobody is going to retry it.
   *
   * `rejected` only — NOT `failed`. A failed job is retryable and will be picked up again by
   * the next poll, and telling somebody about a provider timeout that fixes itself in five
   * minutes is how a notification bell becomes something people mute. This is the terminal
   * one: attempts exhausted, or an input this extractor cannot read, and the answer is to
   * enter it by hand.
   */
  'marbim.extraction.rejected': (p, id) => {
    const userId = str(p.requestedBy)
    if (!userId) return null

    return {
      userId,
      kind: 'marbim.extraction.rejected',
      severity: 'warning' as const,
      titleKey: 'marbim.notifications.extraction_rejected.title',
      bodyKey: 'marbim.notifications.extraction_rejected.body',
      params: { reason: str(p.reason).slice(0, 200) },
      moduleId: 'marbim',
      entityTable: 'extraction_jobs',
      entityId: str(p.jobId),
      href: '/marbim/intake',
      dedupeKey: `marbim.extraction_rejected:${str(p.jobId) || id}`,
    }
  },
}

/**
 * The `notify` queue's entry point.
 *
 * Idempotency is the notification's own `dedupeKey`, derived from the entity the event is
 * about rather than the event id where possible — a redelivery and a genuine re-emission
 * about the same fact are both things a person should be told once.
 */
export async function runNotifyJob(job: Job<NotifyJobData>): Promise<{ notified: string | null }> {
  const rule = NOTIFY_RULES[job.name]

  if (!rule) {
    // Visible, not silent. Most events are not news, but "which ones did we decide are
    // not" should be answerable from the log rather than by reading this file.
    return { notified: null }
  }

  const spec = rule(job.data.payload, job.data.eventId)
  if (!spec) return { notified: null }

  const ctx = systemCtx(job.data.companyId)

  await notify(ctx, {
    ...spec,
    dedupeKey: spec.dedupeKey ?? `${job.name}:${job.data.eventId}`,
  })

  return { notified: spec.kind }
}
