import { daysBetween } from '@/lib/dates'
import { myRaisedDrafts } from '@/modules/approvals/queries'
import { agingDiscrepancies, type BankDocsPolicy } from '@/modules/commercial/service'
import { capExceptions } from '@/modules/compliance/service'
import { register } from '@/modules/commercial/queries'
import type { RequestCtx } from '@/modules/core/ctx'
import { finalInspectionLots, recentFinalInspections } from '@/modules/quality/queries'
import { getPolicy } from '@/modules/settings/service'
import { shipmentBoard } from '@/modules/shipment/queries'
import { cuttableOrders, recentLays } from '@/modules/cutting/queries'
import { pmWorklist, ticketBoard } from '@/modules/maintenance/queries'
import { orderList } from '@/modules/orders/queries'
import { board } from '@/modules/planning/queries'
import { openRequisitions, purchaseOrders } from '@/modules/procurement/queries'
import { outstandingRequisitions, recentGrns } from '@/modules/store/queries'
import { activeGazette, payrollRunList } from '@/modules/workforce/queries'

import type { Words } from '@/components/shell/nav'

import { capRows, HOME_COPY, type WorkRow } from './home-copy'
import type { HomeSection } from './home-view'

/**
 * "Your work" for the desks that never had one (adoption plan 2.2).
 *
 * The composed queue existed for owner, admin and merchandiser; a storekeeper who wanted to
 * know whether anything waited on them had to remember which of their four screens to check,
 * and check each one. Same recipe as the merchandiser's: no work_items table, no new state —
 * each section is a query the desk's own screens already run, capped and worded.
 *
 * One section rule carried over from the strip on their module homes: "my raised drafts"
 * appears here too, because for these roles the answer to "what happened to my correction"
 * lives on no other composed surface.
 */
/**
 * Every desk, now. The first four gained composition in adoption plan 2.2; the role audit
 * (UI-UX-ROLE-AUDIT S1) found the morning ritual inconsistent — six desks had no `/home` at
 * all, so a mechanic with a CAP assigned to them had no surface anywhere that would say so.
 * The earlier reasoning for leaving floor roles off ("their queue IS their landing") was
 * right about the queue and wrong about the rest: the composed home also carries the
 * cross-desk items — corrective actions assigned to this person, drafts they raised — that
 * their own screens never show.
 */
export type DeskRole =
  | 'store'
  | 'quality'
  | 'shipment'
  | 'commercial'
  | 'procurement'
  | 'planner'
  | 'cutting'
  | 'maintenance'
  | 'hr'
  | 'compliance'

const DESK_ROLES = [
  'store',
  'quality',
  'shipment',
  'commercial',
  'procurement',
  'planner',
  'cutting',
  'maintenance',
  'hr',
  'compliance',
] as const

export function deskRoleFor(roles: readonly string[]): DeskRole | null {
  for (const role of DESK_ROLES) {
    if (roles.includes(role)) return role
  }
  return null
}

export async function deskSections(
  ctx: RequestCtx,
  role: DeskRole,
  today: string,
  /** The floor reads Bangla; these sections are keyed, not hardcoded (adoption plan 5.5). */
  t: Words,
): Promise<HomeSection[]> {
  const builders: Record<DeskRole, () => Promise<HomeSection[]>> = {
    store: () => storeSections(ctx, t),
    quality: () => qualitySections(ctx, t),
    shipment: () => shipmentSections(ctx, today, t),
    commercial: () => commercialSections(ctx, today, t),
    procurement: () => procurementSections(ctx, t),
    planner: () => plannerSections(ctx, today, t),
    cutting: () => cuttingSections(ctx, t),
    maintenance: () => maintenanceSections(ctx, today, t),
    hr: () => hrSections(ctx, t),
    compliance: () => complianceSections(ctx, today, t),
  }
  const sections: HomeSection[] = await builders[role]()

  sections.push(await capsAssignedSection(ctx, today, t))
  sections.push(await raisedSection(ctx, t))
  return sections
}

/**
 * Corrective actions assigned to THIS person, wherever they sit (adoption plan 5.4).
 *
 * Compliance was the most isolated desk in the product: a CAP needs the store to fix a
 * blocked exit or maintenance to guard a machine, and the only place it appeared was the
 * compliance screen those people never open. `capExceptions` already computes the deadline
 * ladder and carries the owner; this puts it where the owner actually looks.
 *
 * Filtered to the caller — an unassigned CAP is compliance's problem until somebody owns it,
 * and showing it to everybody would make the section noise on four desks at once.
 */
export async function capsAssignedSection(
  ctx: RequestCtx,
  today: string,
  t: Words,
): Promise<HomeSection> {
  const all = await capExceptions(ctx, today)
  const mine = all.filter((cap) => cap.ownerUserId === ctx.userId)
  const cap = capRows(mine)

  return {
    id: 'caps',
    title: t('ui.desk.caps_assigned'),
    eyebrow: mine.length > 0 ? `${mine.length}` : undefined,
    seeAllHref: '/compliance',
    more: cap.more,
    empty: t('ui.desk.caps_assigned_empty'),
    rows: cap.rows.map((row): WorkRow => {
      const days = daysBetween(today, row.deadline)
      return {
        id: row.capId,
        title: `${row.severity} finding · corrective action`,
        why:
          days < 0
            ? `Overdue by ${Math.abs(days)} day(s) — deadline was ${row.deadline}.`
            : `Due ${row.deadline} — ${days} day(s) left.`,
        href: '/compliance',
        age: days < 0 ? `${Math.abs(days)}d over` : `${days}d`,
        severity: days < 0 || row.severity === 'critical' ? 'high' : 'medium',
        cta: HOME_COPY.open,
      }
    }),
  }
}

/** The links the calm state offers, per desk — their own screens, not the office's. */
export function deskCalmLinks(role: DeskRole, t: Words): { href: string; label: string }[] {
  switch (role) {
    case 'store':
      return [
        { href: '/store/receive', label: t('ui.desk.calm_receive') },
        { href: '/store', label: t('ui.desk.calm_store') },
      ]
    case 'quality':
      return [{ href: '/quality/inline', label: t('ui.desk.calm_inline') }]
    case 'shipment':
      return [{ href: '/shipment', label: t('ui.desk.calm_shipment') }]
    case 'commercial':
      return [{ href: '/lcs', label: t('ui.desk.calm_lcs') }]
    case 'procurement':
      return [{ href: '/procurement', label: t('ui.desk.calm_procurement') }]
    case 'planner':
      return [{ href: '/planning', label: t('ui.desk.calm_planning') }]
    case 'cutting':
      return [{ href: '/cutting', label: t('ui.desk.calm_cutting') }]
    case 'maintenance':
      return [{ href: '/maintenance', label: t('ui.desk.calm_maintenance') }]
    case 'hr':
      return [{ href: '/workforce', label: t('ui.desk.calm_workforce') }]
    case 'compliance':
      return [{ href: '/compliance', label: t('ui.desk.calm_compliance') }]
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function storeSections(ctx: RequestCtx, t: Words): Promise<HomeSection[]> {
  const [outstanding, grns] = await Promise.all([
    outstandingRequisitions(ctx),
    recentGrns(ctx, 25),
  ])

  const outstandingCap = capRows(outstanding)
  const awaiting = grns.filter((grn) => grn.inspectionStatus === 'pending')
  const awaitingCap = capRows(awaiting)

  return [
    {
      id: 'issue',
      title: t('ui.desk.store_to_issue'),
      eyebrow: outstanding.length > 0 ? `${outstanding.length} line(s)` : undefined,
      seeAllHref: '/store/issue',
      more: outstandingCap.more,
      empty: t('ui.desk.store_to_issue_empty'),
      rows: outstandingCap.rows.map(
        (line): WorkRow => ({
          id: line.requisitionLineId,
          title: `${line.itemCode} · ${line.poNumbers[0] ?? 'order'}`,
          why: `${line.outstandingQty} ${line.unit} of ${line.requiredQty} still to issue — ${line.itemName}.`,
          href: '/store/issue',
          severity: 'medium',
          cta: HOME_COPY.open,
        }),
      ),
    },
    {
      id: 'inspect',
      title: t('ui.desk.store_awaiting'),
      eyebrow: awaiting.length > 0 ? `${awaiting.length} GRN(s)` : undefined,
      seeAllHref: '/store/rolls',
      more: awaitingCap.more,
      empty: t('ui.desk.store_awaiting_empty'),
      rows: awaitingCap.rows.map(
        (grn): WorkRow => ({
          id: grn.id,
          title: `Challan ${grn.challanNo}`,
          why: grn.bonded
            ? `${grn.lineCount} line(s), bonded — fabric cannot issue until the 4-point check clears it.`
            : `${grn.lineCount} line(s) received, not yet inspected.`,
          href: '/store/rolls',
          age: grn.receivedAt,
          severity: grn.bonded ? 'high' : 'medium',
          cta: HOME_COPY.open,
        }),
      ),
    },
  ]
}

async function qualitySections(ctx: RequestCtx, t: Words): Promise<HomeSection[]> {
  const [finals, lots] = await Promise.all([
    recentFinalInspections(ctx, 25),
    finalInspectionLots(ctx),
  ])
  // A failed lot does not ship until re-inspection — the landing's own warning, as work.
  const failed = finals.filter((row) => row.verdict === 'fail')
  const failedCap = capRows(failed)

  /*
   * Newly inspectable: pieces have come off finishing and nobody has drawn a sample yet
   * (role audit 1.6). The inverse of the queue's old defect — it used to offer "Inspect"
   * on orders with nothing sewn; now that `finishedQty` is real, the same number tells an
   * inspector where a lot is actually waiting for them.
   */
  const inspectable = lots.filter((lot) => lot.finishedQty > 0 && lot.history.length === 0)
  const inspectableCap = capRows(inspectable)

  return [
    {
      id: 'inspectable',
      title: t('ui.desk.quality_inspectable'),
      eyebrow: inspectable.length > 0 ? `${inspectable.length} lot(s)` : undefined,
      seeAllHref: '/quality/final',
      more: inspectableCap.more,
      empty: t('ui.desk.quality_inspectable_empty'),
      rows: inspectableCap.rows.map(
        (row): WorkRow => ({
          id: row.orderId,
          title: `${row.poNumber ?? ''} · ${row.styleCode ?? ''}`.trim(),
          why: t('ui.desk.quality_inspectable_row', {
            finished: row.finishedQty.toLocaleString(),
            ordered: (row.contractedQty ?? 0).toLocaleString(),
          }),
          href: '/quality/final',
          severity: 'medium',
          cta: HOME_COPY.open,
        }),
      ),
    },
    {
      id: 'failed',
      title: t('ui.desk.quality_failed'),
      eyebrow: failed.length > 0 ? `${failed.length} lot(s)` : undefined,
      seeAllHref: '/quality/final',
      more: failedCap.more,
      empty: t('ui.desk.quality_failed_empty'),
      rows: failedCap.rows.map(
        (row): WorkRow => ({
          id: row.id,
          title: `${row.inspectionNo} · lot of ${row.lotQty.toLocaleString()}`,
          why:
            row.criticalFound > 0
              ? `Failed on a critical defect — ${row.criticalFound} found, accept 0.`
              : `Failed at ${row.standard}: ${row.majorFound} major against accept ${row.majorAccept}.`,
          href: '/quality/final',
          severity: 'high',
          cta: HOME_COPY.open,
        }),
      ),
    },
  ]
}

async function shipmentSections(ctx: RequestCtx, today: string, t: Words): Promise<HomeSection[]> {
  const board = await shipmentBoard(ctx)
  const open = board.filter((row) => !row.actualExFactory)

  // The two gates this desk discovers at the door, surfaced as the morning's list instead.
  const noExp = open.filter((row) => !row.expNumber)
  const closing = open.filter(
    (row) =>
      row.latestShipmentDate &&
      daysBetween(today, row.latestShipmentDate) <= 7 &&
      daysBetween(today, row.latestShipmentDate) >= 0,
  )
  const noExpCap = capRows(noExp)
  const closingCap = capRows(closing)

  return [
    {
      id: 'exp',
      title: t('ui.desk.shipment_no_exp'),
      eyebrow: noExp.length > 0 ? `${noExp.length} shipment(s)` : undefined,
      seeAllHref: '/shipment',
      more: noExpCap.more,
      empty: t('ui.desk.shipment_no_exp_empty'),
      rows: noExpCap.rows.map(
        (row): WorkRow => ({
          id: row.id,
          title: `${row.poNumber ?? 'order'} · partial ${row.partialNo}`,
          why: 'No EXP number yet — nothing goes to the bank without one.',
          href: '/shipment',
          severity: 'high',
          cta: HOME_COPY.open,
        }),
      ),
    },
    {
      id: 'closing',
      title: t('ui.desk.shipment_closing'),
      eyebrow: closing.length > 0 ? `${closing.length} inside 7d` : undefined,
      seeAllHref: '/shipment',
      more: closingCap.more,
      empty: t('ui.desk.shipment_closing_empty'),
      rows: closingCap.rows.map((row): WorkRow => {
        const days = daysBetween(today, row.latestShipmentDate!)
        return {
          id: row.id,
          title: `${row.poNumber ?? 'order'} · ${row.lcNumber ?? 'no LC'}`,
          why: `Latest shipment ${row.latestShipmentDate} — ${days} day(s) to have goods on the vessel.`,
          href: '/shipment',
          age: `${days}d`,
          severity: days <= 3 ? 'high' : 'medium',
          cta: HOME_COPY.open,
        }
      }),
    },
  ]
}

async function commercialSections(ctx: RequestCtx, today: string, t: Words): Promise<HomeSection[]> {
  const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')
  const [credits, discrepant] = await Promise.all([
    register(ctx, {
      now: new Date(`${today}T00:00:00Z`),
      // The same window the LC register itself uses.
      expiringWithinDays: policy.discrepancyEscalateAfterDays * 3,
      btbLimitPct: policy.btbLimitPct ?? 75,
    }),
    agingDiscrepancies(ctx, { today }, policy),
  ])

  const alerting = credits.filter((row) => row.alerts.length > 0)
  const alertingCap = capRows(alerting)
  const discrepantCap = capRows(discrepant)

  return [
    {
      id: 'credits',
      title: t('ui.desk.commercial_credits'),
      eyebrow: alerting.length > 0 ? `${alerting.length} credit(s)` : undefined,
      seeAllHref: '/lcs',
      more: alertingCap.more,
      empty: t('ui.desk.commercial_credits_empty'),
      rows: alertingCap.rows.map((row): WorkRow => {
        const worst = row.alerts[0]!
        return {
          id: row.id,
          title: `${row.number} · ${row.buyerName ?? 'buyer'}`,
          why: describeLcAlert(worst),
          href: `/lcs/${row.id}`,
          severity: worst.kind === 'expiring' ? 'medium' : 'high',
          cta: HOME_COPY.open,
        }
      }),
    },
    {
      id: 'discrepant',
      title: t('ui.desk.commercial_discrepant'),
      eyebrow: discrepant.length > 0 ? `${discrepant.length} aging` : undefined,
      seeAllHref: '/lcs/submissions',
      more: discrepantCap.more,
      empty: t('ui.desk.commercial_discrepant_empty'),
      rows: discrepantCap.rows.map(
        (row): WorkRow => ({
          id: row.submissionId,
          title: t('ui.desk.commercial_discrepant_row'),
          why: row.notes ?? `Discrepant for ${row.days} day(s) with no note.`,
          href: '/lcs/submissions',
          age: `${row.days}d`,
          severity: 'high',
          cta: HOME_COPY.open,
        }),
      ),
    },
  ]
}

function describeLcAlert(alert: { kind: string; [key: string]: unknown }): string {
  switch (alert.kind) {
    case 'latest_shipment_passed':
      return `Latest shipment date has passed — ${String(alert.days)} day(s) ago.`
    case 'expiring':
      return `Expires in ${String(alert.days)} day(s).`
    case 'expired':
      return `Expired ${String(alert.days)} day(s) ago.`
    case 'discrepant':
      return `${String(alert.count)} discrepant presentation(s) outstanding.`
    case 'btb_over_limit':
      return `BTB usage ${String(alert.usedPct)}% against a ${String(alert.limitPct)}% ceiling.`
    default:
      return alert.kind
  }
}

async function raisedSection(ctx: RequestCtx, t: Words): Promise<HomeSection> {
  const drafts = await myRaisedDrafts(ctx, 6)
  const cap = capRows(drafts)
  return {
    id: 'mine',
    title: t('ui.desk.my_drafts'),
    eyebrow: drafts.length > 0 ? `${drafts.length}` : undefined,
    more: cap.more,
    empty: t('ui.desk.my_drafts_empty'),
    rows: cap.rows.map(
      (draft): WorkRow => ({
        id: draft.id,
        title: draft.targetTable,
        why:
          draft.status === 'rejected' && draft.reviewNote
            ? `Rejected — ${draft.reviewNote}`
            : HOME_COPY.draftStatus[draft.status] ?? draft.status,
        href: '/home',
        severity: draft.status === 'rejected' || draft.status === 'failed' ? 'high' : 'low',
        cta: '',
      }),
    ),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The six desks the role audit found without a morning (S1)
// ─────────────────────────────────────────────────────────────────────────────

async function procurementSections(ctx: RequestCtx, t: Words): Promise<HomeSection[]> {
  const now = new Date()
  const [prs, pos] = await Promise.all([
    openRequisitions(ctx, { now }),
    purchaseOrders(ctx, { now }),
  ])

  const urgent = prs.filter((pr) => pr.daysToNeeded !== null && pr.daysToNeeded <= 7)
  const urgentCap = capRows(urgent)

  const overdue = pos.filter((po) => po.daysToDelivery !== null && po.daysToDelivery < 0)
  const overdueCap = capRows(overdue)

  return [
    {
      id: 'urgent-prs',
      title: t('ui.desk.proc_urgent'),
      eyebrow: urgent.length > 0 ? `${urgent.length}` : undefined,
      seeAllHref: '/procurement',
      more: urgentCap.more,
      empty: t('ui.desk.proc_urgent_empty'),
      rows: urgentCap.rows.map((pr): WorkRow => ({
        id: pr.id,
        title: pr.prNo,
        why:
          pr.daysToNeeded !== null && pr.daysToNeeded < 0
            ? t('ui.desk.proc_urgent_overdue', { days: Math.abs(pr.daysToNeeded) })
            : t('ui.desk.proc_urgent_row', { days: pr.daysToNeeded ?? 0 }),
        href: `/procurement/${pr.id}`,
        age: pr.daysToNeeded !== null ? `${pr.daysToNeeded}d` : '—',
        severity: pr.daysToNeeded !== null && pr.daysToNeeded <= 2 ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    },
    {
      id: 'overdue-pos',
      title: t('ui.desk.proc_overdue'),
      eyebrow: overdue.length > 0 ? `${overdue.length}` : undefined,
      seeAllHref: '/procurement',
      more: overdueCap.more,
      empty: t('ui.desk.proc_overdue_empty'),
      rows: overdueCap.rows.map((po): WorkRow => ({
        id: po.id,
        title: `${po.poNumber} · ${po.supplierName ?? ''}`.trim(),
        why: t('ui.desk.proc_overdue_row', { days: Math.abs(po.daysToDelivery ?? 0) }),
        href: '/procurement',
        age: `${Math.abs(po.daysToDelivery ?? 0)}d over`,
        severity: 'high',
        cta: HOME_COPY.open,
      })),
    },
  ]
}

/**
 * The planner's morning is three questions the board answers one cell at a time: what starts
 * today, what has nowhere to run tomorrow, and what is sold but not yet on any line. One
 * board read over a 30-day horizon answers all three — the horizon is why "unallocated"
 * here means "no run in the next month", which is the version of the question a planner
 * actually asks (an order allocated for week six is not this morning's problem).
 */
async function plannerSections(ctx: RequestCtx, today: string, t: Words): Promise<HomeSection[]> {
  const [lines, orders] = await Promise.all([
    board(ctx, { from: today, days: 30 }),
    orderList(ctx, { now: new Date() }),
  ])

  const allocations = lines.flatMap((line) => line.allocations)
  const startingToday = allocations.filter(
    (a) => a.startDate === today && (a.status === 'planned' || a.status === 'confirmed'),
  )
  const startCap = capRows(startingToday)

  const allocatedOrderIds = new Set(allocations.map((a) => a.orderId))
  const unallocated = orders.filter(
    (o) =>
      (o.status === 'confirmed' || o.status === 'in_production') &&
      o.contractedQty !== null &&
      !allocatedOrderIds.has(o.id),
  )
  const unallocCap = capRows(unallocated)

  return [
    {
      id: 'starting',
      title: t('ui.desk.plan_starting'),
      eyebrow: startingToday.length > 0 ? `${startingToday.length}` : undefined,
      seeAllHref: '/planning',
      more: startCap.more,
      empty: t('ui.desk.plan_starting_empty'),
      rows: startCap.rows.map((a): WorkRow => ({
        id: a.id,
        title: `${a.lineCode} · ${a.poNumber ?? a.styleCode ?? ''}`.trim(),
        why: t('ui.desk.plan_starting_row', { pieces: a.plannedTotal.toLocaleString() }),
        href: '/planning',
        age: 'today',
        severity: 'medium',
        cta: HOME_COPY.open,
      })),
    },
    {
      id: 'unallocated',
      title: t('ui.desk.plan_unallocated'),
      eyebrow: unallocated.length > 0 ? `${unallocated.length}` : undefined,
      seeAllHref: '/planning',
      more: unallocCap.more,
      empty: t('ui.desk.plan_unallocated_empty'),
      rows: unallocCap.rows.map((o): WorkRow => ({
        id: o.id,
        title: `${o.poNumbers[0] ?? ''} · ${o.styleCode ?? ''}`.trim(),
        why: t('ui.desk.plan_unallocated_row', {
          pieces: (o.contractedQty ?? 0).toLocaleString(),
        }),
        href: '/planning',
        age: o.daysToExFactory !== null ? `${o.daysToExFactory}d to ship` : '—',
        severity: o.health === 'late' || o.health === 'risk' ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    },
  ]
}

async function cuttingSections(ctx: RequestCtx, t: Words): Promise<HomeSection[]> {
  const [cuttable, lays] = await Promise.all([cuttableOrders(ctx), recentLays(ctx, 40)])

  const cuttableCap = capRows(cuttable)
  const open = lays.filter((lay) => lay.status === 'open')
  const openCap = capRows(open)

  return [
    {
      id: 'cuttable',
      title: t('ui.desk.cut_ready'),
      eyebrow: cuttable.length > 0 ? `${cuttable.length}` : undefined,
      seeAllHref: '/cutting',
      more: cuttableCap.more,
      empty: t('ui.desk.cut_ready_empty'),
      rows: cuttableCap.rows.map((o): WorkRow => ({
        id: o.orderId,
        title: `${o.poNumber ?? ''} · ${o.styleCode}`.trim(),
        why: t('ui.desk.cut_ready_row'),
        href: '/cutting/lay',
        age: '—',
        severity: 'medium',
        cta: HOME_COPY.open,
      })),
    },
    {
      id: 'open-lays',
      title: t('ui.desk.cut_open'),
      eyebrow: open.length > 0 ? `${open.length}` : undefined,
      seeAllHref: '/cutting/report',
      more: openCap.more,
      empty: t('ui.desk.cut_open_empty'),
      rows: openCap.rows.map((lay): WorkRow => ({
        id: lay.id,
        title: `${lay.layNo} · ${lay.color}`,
        why: t('ui.desk.cut_open_row'),
        href: '/cutting/report',
        age: '—',
        severity: 'medium',
        cta: HOME_COPY.open,
      })),
    },
  ]
}

async function maintenanceSections(
  ctx: RequestCtx,
  today: string,
  t: Words,
): Promise<HomeSection[]> {
  const [tickets, pm] = await Promise.all([ticketBoard(ctx, { now: new Date() }), pmWorklist(ctx, today)])

  // Line-down first: an unclaimed ticket from a recorded stoppage is a line making nothing.
  const unclaimed = [...tickets]
    .filter((ticket) => ticket.status === 'open')
    .sort((a, b) => Number(b.fromDowntime) - Number(a.fromDowntime))
  const unclaimedCap = capRows(unclaimed)

  const overduePm = pm.filter((row) => row.daysOverdue > 0)
  const pmCap = capRows(overduePm)

  return [
    {
      id: 'unclaimed',
      title: t('ui.desk.maint_unclaimed'),
      eyebrow: unclaimed.length > 0 ? `${unclaimed.length}` : undefined,
      seeAllHref: '/maintenance',
      more: unclaimedCap.more,
      empty: t('ui.desk.maint_unclaimed_empty'),
      rows: unclaimedCap.rows.map((ticket): WorkRow => ({
        id: ticket.id,
        title: [ticket.lineCode, ticket.machineType].filter(Boolean).join(' · ') || t('ui.desk.maint_unnamed'),
        why: ticket.fromDowntime
          ? t('ui.desk.maint_line_down', { minutes: ticket.openMinutes ?? 0 })
          : t('ui.desk.maint_reported', { hours: ticket.openHours ?? 0 }),
        href: '/maintenance',
        age: ticket.openHours !== null ? `${ticket.openHours}h` : '—',
        severity: ticket.fromDowntime ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    },
    {
      id: 'pm-overdue',
      title: t('ui.desk.maint_pm'),
      eyebrow: overduePm.length > 0 ? `${overduePm.length}` : undefined,
      seeAllHref: '/maintenance/pm',
      more: pmCap.more,
      empty: t('ui.desk.maint_pm_empty'),
      rows: pmCap.rows.map((row): WorkRow => ({
        id: row.scheduleId,
        title: [row.machineType, row.serial].filter(Boolean).join(' · '),
        why: t('ui.desk.maint_pm_row', { days: row.daysOverdue }),
        href: '/maintenance/pm',
        age: `${row.daysOverdue}d over`,
        severity: row.daysOverdue > 14 ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    },
  ]
}

/**
 * HR's morning is one question with four doors behind it: where is this month's pay?
 * The run list already knows — the newest run's status names the next door, and no run at
 * all for the current period is itself the answer ("nothing computed yet").
 */
async function hrSections(ctx: RequestCtx, t: Words): Promise<HomeSection[]> {
  const [runs, gazette] = await Promise.all([payrollRunList(ctx, 3), activeGazette(ctx)])
  const latest = runs[0] ?? null

  const rows: WorkRow[] = []
  if (latest && latest.status !== 'disbursed') {
    rows.push({
      id: latest.id,
      title: t('ui.desk.hr_run_title', { period: latest.period }),
      why:
        latest.status === 'draft'
          ? t('ui.desk.hr_run_draft')
          : latest.status === 'approved'
            ? t('ui.desk.hr_run_approved')
            : t('ui.desk.hr_run_other', { status: latest.status }),
      href: '/workforce',
      age: latest.period,
      severity: 'medium',
      cta: HOME_COPY.open,
    })
  }
  if (!gazette) {
    rows.push({
      id: 'no-gazette',
      title: t('ui.desk.hr_no_gazette'),
      why: t('ui.desk.hr_no_gazette_why'),
      href: '/workforce',
      age: '—',
      severity: 'high',
      cta: HOME_COPY.open,
    })
  }

  return [
    {
      id: 'payroll',
      title: t('ui.desk.hr_payroll'),
      eyebrow: rows.length > 0 ? `${rows.length}` : undefined,
      seeAllHref: '/workforce',
      empty: t('ui.desk.hr_payroll_empty'),
      rows,
    },
  ]
}

async function complianceSections(
  ctx: RequestCtx,
  today: string,
  t: Words,
): Promise<HomeSection[]> {
  // ALL open CAPs, not only the caller's — chasing the deadline ladder across owners is the
  // compliance officer's whole job, and `capsAssignedSection` below already carries "mine".
  const caps = await capExceptions(ctx, today)
  const cap = capRows(caps)

  return [
    {
      id: 'cap-ladder',
      title: t('ui.desk.comp_ladder'),
      eyebrow: caps.length > 0 ? `${caps.length}` : undefined,
      seeAllHref: '/compliance',
      more: cap.more,
      empty: t('ui.desk.comp_ladder_empty'),
      rows: cap.rows.map((row): WorkRow => {
        const days = daysBetween(today, row.deadline)
        return {
          id: row.capId,
          title: t('ui.desk.comp_ladder_row', { severity: row.severity }),
          why:
            days < 0
              ? t('ui.desk.comp_overdue', { days: Math.abs(days), deadline: row.deadline })
              : t('ui.desk.comp_due', { days, deadline: row.deadline }),
          href: '/compliance',
          age: days < 0 ? `${Math.abs(days)}d over` : `${days}d`,
          severity: days < 0 || row.severity === 'critical' ? 'high' : 'medium',
          cta: HOME_COPY.open,
        }
      }),
    },
  ]
}
