import { daysBetween } from '@/lib/dates'
import { myRaisedDrafts } from '@/modules/approvals/queries'
import { agingDiscrepancies, type BankDocsPolicy } from '@/modules/commercial/service'
import { capExceptions } from '@/modules/compliance/service'
import { register } from '@/modules/commercial/queries'
import type { RequestCtx } from '@/modules/core/ctx'
import { recentFinalInspections } from '@/modules/quality/queries'
import { getPolicy } from '@/modules/settings/service'
import { shipmentBoard } from '@/modules/shipment/queries'
import { outstandingRequisitions, recentGrns } from '@/modules/store/queries'

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
export type DeskRole = 'store' | 'quality' | 'shipment' | 'commercial'

export function deskRoleFor(roles: readonly string[]): DeskRole | null {
  for (const role of ['store', 'quality', 'shipment', 'commercial'] as const) {
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
  const sections: HomeSection[] =
    role === 'store'
      ? await storeSections(ctx, t)
      : role === 'quality'
        ? await qualitySections(ctx, t)
        : role === 'shipment'
          ? await shipmentSections(ctx, today, t)
          : await commercialSections(ctx, today, t)

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
  const finals = await recentFinalInspections(ctx, 25)
  // A failed lot does not ship until re-inspection — the landing's own warning, as work.
  const failed = finals.filter((row) => row.verdict === 'fail')
  const failedCap = capRows(failed)

  return [
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
