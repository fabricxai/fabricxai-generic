import { daysBetween } from '@/lib/dates'
import { myRaisedDrafts } from '@/modules/approvals/queries'
import { agingDiscrepancies, type BankDocsPolicy } from '@/modules/commercial/service'
import { register } from '@/modules/commercial/queries'
import type { RequestCtx } from '@/modules/core/ctx'
import { recentFinalInspections } from '@/modules/quality/queries'
import { getPolicy } from '@/modules/settings/service'
import { shipmentBoard } from '@/modules/shipment/queries'
import { outstandingRequisitions, recentGrns } from '@/modules/store/queries'

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
): Promise<HomeSection[]> {
  const sections: HomeSection[] =
    role === 'store'
      ? await storeSections(ctx)
      : role === 'quality'
        ? await qualitySections(ctx)
        : role === 'shipment'
          ? await shipmentSections(ctx, today)
          : await commercialSections(ctx, today)

  sections.push(await raisedSection(ctx))
  return sections
}

/** The links the calm state offers, per desk — their own screens, not the office's. */
export function deskCalmLinks(role: DeskRole): { href: string; label: string }[] {
  switch (role) {
    case 'store':
      return [
        { href: '/store/receive', label: HOME_COPY.deskCalmReceive },
        { href: '/store', label: HOME_COPY.deskCalmStore },
      ]
    case 'quality':
      return [{ href: '/quality/inline', label: HOME_COPY.deskCalmInline }]
    case 'shipment':
      return [{ href: '/shipment', label: HOME_COPY.deskCalmShipment }]
    case 'commercial':
      return [{ href: '/lcs', label: HOME_COPY.deskCalmLcs }]
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function storeSections(ctx: RequestCtx): Promise<HomeSection[]> {
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
      title: HOME_COPY.storeToIssue,
      eyebrow: outstanding.length > 0 ? `${outstanding.length} line(s)` : undefined,
      seeAllHref: '/store/issue',
      more: outstandingCap.more,
      empty: HOME_COPY.storeToIssueEmpty,
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
      title: HOME_COPY.storeAwaitingInspection,
      eyebrow: awaiting.length > 0 ? `${awaiting.length} GRN(s)` : undefined,
      seeAllHref: '/store/rolls',
      more: awaitingCap.more,
      empty: HOME_COPY.storeAwaitingEmpty,
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

async function qualitySections(ctx: RequestCtx): Promise<HomeSection[]> {
  const finals = await recentFinalInspections(ctx, 25)
  // A failed lot does not ship until re-inspection — the landing's own warning, as work.
  const failed = finals.filter((row) => row.verdict === 'fail')
  const failedCap = capRows(failed)

  return [
    {
      id: 'failed',
      title: HOME_COPY.qualityFailedLots,
      eyebrow: failed.length > 0 ? `${failed.length} lot(s)` : undefined,
      seeAllHref: '/quality/final',
      more: failedCap.more,
      empty: HOME_COPY.qualityFailedEmpty,
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

async function shipmentSections(ctx: RequestCtx, today: string): Promise<HomeSection[]> {
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
      title: HOME_COPY.shipmentNoExp,
      eyebrow: noExp.length > 0 ? `${noExp.length} shipment(s)` : undefined,
      seeAllHref: '/shipment',
      more: noExpCap.more,
      empty: HOME_COPY.shipmentNoExpEmpty,
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
      title: HOME_COPY.shipmentClosing,
      eyebrow: closing.length > 0 ? `${closing.length} inside 7d` : undefined,
      seeAllHref: '/shipment',
      more: closingCap.more,
      empty: HOME_COPY.shipmentClosingEmpty,
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

async function commercialSections(ctx: RequestCtx, today: string): Promise<HomeSection[]> {
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
      title: HOME_COPY.commercialCredits,
      eyebrow: alerting.length > 0 ? `${alerting.length} credit(s)` : undefined,
      seeAllHref: '/lcs',
      more: alertingCap.more,
      empty: HOME_COPY.commercialCreditsEmpty,
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
      title: HOME_COPY.commercialDiscrepant,
      eyebrow: discrepant.length > 0 ? `${discrepant.length} aging` : undefined,
      seeAllHref: '/lcs/submissions',
      more: discrepantCap.more,
      empty: HOME_COPY.commercialDiscrepantEmpty,
      rows: discrepantCap.rows.map(
        (row): WorkRow => ({
          id: row.submissionId,
          title: HOME_COPY.commercialDiscrepantRow,
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

async function raisedSection(ctx: RequestCtx): Promise<HomeSection> {
  const drafts = await myRaisedDrafts(ctx, 6)
  const cap = capRows(drafts)
  return {
    id: 'mine',
    title: HOME_COPY.myDrafts,
    eyebrow: drafts.length > 0 ? `${drafts.length}` : undefined,
    more: cap.more,
    empty: HOME_COPY.myDraftsEmpty,
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
