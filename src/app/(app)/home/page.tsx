import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { t } from '@/lib/i18n'
import { tui } from '@/lib/i18n-ui'
import { describeException, exceptionKindLabel } from '@/components/fx/exception-copy'
import { requestLocale } from '@/lib/ui-locale'
import { exceptions, type AnalyticsPolicy } from '@/modules/analytics/queries'
import { inboxRows } from '@/modules/approvals/queries'
import type { ApprovalsPolicy } from '@/modules/approvals/service'
import { pipeline } from '@/modules/buyers/queries'
import type { BuyerDeskPolicy } from '@/modules/buyers/service'
import { listUnread } from '@/modules/core/notifications'
import { getCtx } from '@/modules/core/session'
import { orderList } from '@/modules/orders/queries'
import { board as rfqBoard } from '@/modules/rfq/queries'
import { ppBlockingAlerts, type SamplingPolicy } from '@/modules/sampling/service'
import { companyProfile, getPolicy } from '@/modules/settings/service'

import {
  ageDaysLabel,
  ageLabel,
  capRows,
  draftWhy,
  exceptionHref,
  HOME_COPY,
  type WorkRow,
} from './home-copy'
import { capsAssignedSection, deskCalmLinks, deskRoleFor, deskSections } from './desk-sections'
import { HomeView, type HomeSection } from './home-view'
import { OwnerFigures } from './owner-figures'

/**
 * Your work — composed from existing signals, no work_items table.
 *
 * Owner / admin get drafts + exceptions + alerts, plus a short desk summary when
 * merch queues are hot. Merchandiser gets drafts plus the desk queues themselves.
 * Thin composer: auth → queries → presenter.
 */
export const dynamic = 'force-dynamic'

export default async function HomePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const isOwnerView = ctx.roles.some((r) => r === 'owner' || r === 'admin')

  const [profile, approvalsPolicy, buyerPolicy, samplingPolicy] = await Promise.all([
    companyProfile(ctx),
    getPolicy<ApprovalsPolicy>(ctx, 'approvals'),
    getPolicy<BuyerDeskPolicy>(ctx, 'buyers'),
    getPolicy<SamplingPolicy>(ctx, 'sampling'),
  ])
  const locale = await requestLocale(profile?.locale)
  /** The desks read Bangla; the office sections still use HOME_COPY (adoption plan 5.5). */
  const words = (key: string, params?: Record<string, unknown>) => tui(locale, key, params)

  const drafts = await inboxRows(ctx, { now, limit: 12 }, approvalsPolicy)

  /*
   * Which composition this person gets (adoption plan 2.2). The office feed wins for
   * anyone who has one — same precedence the landing uses — and the four desks that never
   * had a composed queue get their own below, early-returned so a storekeeper's morning
   * does not run the merchandising desk's four queries to render none of them.
   */
  const desk =
    isOwnerView || ctx.roles.includes('merchandiser') ? null : deskRoleFor(ctx.roles)

  const draftCap = capRows(drafts)
  const sections: HomeSection[] = [
    {
      id: 'decide',
      title: HOME_COPY.decideNow,
      eyebrow: drafts.length > 0 ? `${drafts.length} waiting` : undefined,
      seeAllHref: '/approve',
      more: draftCap.more,
      empty: HOME_COPY.decideEmpty,
      rows: draftCap.rows.map((d) => ({
        id: d.id,
        title: d.title,
        why: draftWhy({
          moduleId: d.moduleId,
          aging: d.aging,
          ageHours: d.ageHours,
          fromModel: d.fromModel,
        }),
        href: '/approve',
        age: ageLabel(d.ageHours),
        severity: d.aging
          ? 'high'
          : d.ageHours >= approvalsPolicy.agingEscalateAfterHours / 2
            ? 'medium'
            : 'low',
        cta: HOME_COPY.decide,
      })),
    },
  ]

  if (desk) {
    sections.push(...(await deskSections(ctx, desk, today, words)))
    const calm = sections.every((s) => s.rows.length === 0)
    return <HomeView sections={sections} calm={calm} calmLinks={deskCalmLinks(desk, words)} />
  }

  const [buyersBoard, quotes, orders, pp] = await Promise.all([
    pipeline(ctx, { now, quietAfterDays: buyerPolicy.quietAfterDays }),
    rfqBoard(ctx, { now }),
    orderList(ctx, { now }),
    ppBlockingAlerts(ctx, { today }, samplingPolicy),
  ])

  if (isOwnerView) {
    const analyticsPolicy = await getPolicy<AnalyticsPolicy>(ctx, 'analytics')
    const [feed, unread] = await Promise.all([
      exceptions(ctx, now, analyticsPolicy),
      listUnread(ctx, 12),
    ])

    const feedCap = capRows(feed.exceptions)
    const high = feed.exceptions.filter((e) => e.severity === 'high').length
    sections.push({
      id: 'wrong',
      title: HOME_COPY.whatIsWrong,
      eyebrow: high > 0 ? `${high} high` : undefined,
      seeAllHref: '/dashboard',
      more: feedCap.more,
      empty: HOME_COPY.wrongEmpty,
      rows: feedCap.rows.map((e) => ({
        id: e.id,
        // The subject, not the uuid. `e.ref` is the milestone's primary key — true, unique,
        // and not something anybody in the building can act on.
        title: e.subject
          ? `${e.subject} · ${exceptionKindLabel(e.kind, locale)}`
          : exceptionKindLabel(e.kind, locale),
        why: describeException({ kind: e.kind, subject: e.subject, detail: e.detail }, locale),
        href: exceptionHref(e.kind),
        age: ageDaysLabel(e.ageDays),
        severity: e.severity,
        cta: HOME_COPY.open,
      })),
    })

    const alertCap = capRows(unread)
    sections.push({
      id: 'alerts',
      title: HOME_COPY.alerts,
      eyebrow: unread.length > 0 ? `${unread.length} unread` : undefined,
      more: alertCap.more,
      empty: HOME_COPY.alertsEmpty,
      rows: alertCap.rows.map((n) => ({
        id: n.id,
        title: t(locale, n.titleKey, (n.params ?? {}) as Record<string, unknown>),
        why: n.bodyKey
          ? t(locale, n.bodyKey, (n.params ?? {}) as Record<string, unknown>)
          : n.kind.replace(/\./g, ' '),
        href: n.href ?? (n.moduleId ? `/${n.moduleId}` : '/home'),
        age: ageLabel(Math.max(0, (now.getTime() - n.createdAt.getTime()) / 3_600_000)),
        severity: n.severity === 'critical' ? 'high' : n.severity === 'warning' ? 'medium' : 'low',
        cta: HOME_COPY.open,
      })),
    })

    const deskRows = deskSummaryRows({
      quietN: buyersBoard.quiet.length,
      quoteN: quoteNeedCount(quotes),
      riskN: orders.filter((o) => o.health === 'risk' || o.health === 'late').length,
      ppN: pp.length,
    })
    if (deskRows.length > 0) {
      sections.push({
        id: 'desks',
        title: 'Desks that need a person',
        empty: '',
        rows: deskRows,
      })
    }
  } else {
    // Merchandiser (and any other role that can open /home): full desk sections.
    const quietCap = capRows(buyersBoard.quiet)
    sections.push({
      id: 'quiet',
      title: HOME_COPY.quietBuyers,
      eyebrow: buyersBoard.quiet.length > 0 ? `${buyersBoard.quiet.length} quiet` : undefined,
      seeAllHref: '/buyers',
      more: quietCap.more,
      empty: HOME_COPY.quietEmpty,
      rows: quietCap.rows.map((lead) => ({
        id: lead.id,
        title: lead.companyName,
        why: `Nobody has touched this lead in ${lead.daysQuiet} days · ${lead.stage}.`,
        href: '/buyers',
        age: `${lead.daysQuiet}d`,
        severity: lead.daysQuiet >= 28 ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    })

    const quotePool = quoteNeedRows(quotes)
    const quoteCap = capRows(quotePool)
    sections.push({
      id: 'quotes',
      title: HOME_COPY.quotesNeedingYou,
      eyebrow: quotePool.length > 0 ? `${quotePool.length} to chase` : undefined,
      seeAllHref: '/rfq',
      more: quoteCap.more,
      empty: HOME_COPY.quotesEmpty,
      rows: quoteCap.rows.map((r) => ({
        id: r.id,
        title: r.title,
        why:
          r.daysToDeadline !== null && r.daysToDeadline < 0
            ? `Past deadline by ${Math.abs(r.daysToDeadline)} day(s)${
                r.openClarifications ? ` · ${r.openClarifications} open question(s)` : ''
              }.`
            : `${r.openClarifications} open clarification(s) waiting.`,
        href: '/rfq',
        age:
          r.daysToDeadline !== null && r.daysToDeadline < 0
            ? `${Math.abs(r.daysToDeadline)}d late`
            : undefined,
        severity: r.daysToDeadline !== null && r.daysToDeadline < 0 ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    })

    const atRisk = orders.filter((o) => o.health === 'risk' || o.health === 'late')
    const riskCap = capRows(atRisk)
    sections.push({
      id: 'orders',
      title: HOME_COPY.ordersAtRisk,
      eyebrow: atRisk.length > 0 ? `${atRisk.length} flagged` : undefined,
      seeAllHref: '/orders',
      more: riskCap.more,
      empty: HOME_COPY.ordersEmpty,
      rows: riskCap.rows.map((o) => ({
        id: o.id,
        title: `${o.poNumbers[0] ?? o.id.slice(0, 8)} · ${o.buyerName ?? 'buyer'}`,
        why: o.headline
          ? `${o.health === 'late' ? 'Late' : 'At risk'} — ${o.headline}.`
          : o.health === 'late'
            ? 'A milestone is late.'
            : 'A milestone is at risk.',
        href: `/orders/${o.id}`,
        age: o.daysToExFactory !== null ? `${o.daysToExFactory}d to ex-factory` : undefined,
        severity: o.health === 'late' ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    })

    const ppCap = capRows(pp)
    sections.push({
      id: 'pp',
      title: HOME_COPY.ppBlocking,
      eyebrow: pp.length > 0 ? `${pp.length} style(s)` : undefined,
      seeAllHref: '/sampling',
      more: ppCap.more,
      empty: HOME_COPY.ppEmpty,
      rows: ppCap.rows.map((a) => ({
        id: `${a.orderId}:${a.styleCode}`,
        title: `PP · ${a.styleCode}`,
        why: a.overdue
          ? `Cutting date ${a.cuttingPlannedDate} has passed without PP approval.`
          : `Cutting planned ${a.cuttingPlannedDate} · ${a.daysToCutting} day(s) left without PP approval.`,
        href: '/sampling',
        age: a.overdue ? 'overdue' : `${a.daysToCutting}d`,
        severity: a.overdue ? 'high' : 'medium',
        cta: HOME_COPY.open,
      })),
    })
  }

  // A CAP assigned to an office role lands here too (adoption plan 5.4) — compliance
  // reaches whoever owns the fix, wherever they sit.
  sections.push(await capsAssignedSection(ctx, today, words))

  const calm = sections.every((s) => s.rows.length === 0)

  /*
   * Day one is not a quiet morning (finding D4).
   *
   * The calm copy — "nothing waiting on you, the factory pulse and the order book are a
   * good place to look" — is written for an established factory having a slow Tuesday.
   * A merchandiser signing in on a tenant with no orders was sent to two empty screens
   * and told nothing about the one act that unblocks every other desk: no buyer, no
   * enquiry, no order, no work anywhere in the building.
   *
   * Keyed on the order book being genuinely empty rather than on an account age, because
   * that is the condition the copy is actually about.
   */
  const dayOne = calm && orders.length === 0
  const calmLinks = dayOne
    ? [
        { href: '/setup', label: 'Set the factory up' },
        { href: '/buyers', label: 'Add your first buyer' },
        { href: '/orders', label: HOME_COPY.calmOrders },
      ]
    : isOwnerView
      ? [
          // The figures render on this page now (plan 2.1) — the calm link points at the
          // order book, not at a dashboard that redirects straight back here.
          { href: '/orders', label: HOME_COPY.calmOrders },
        ]
      : [
          { href: '/buyers', label: 'Buyer desk' },
          { href: '/orders', label: HOME_COPY.calmOrders },
        ]

  return (
    <HomeView
      sections={sections}
      calm={calm}
      dayOne={dayOne}
      calmLinks={calmLinks}
      /* The owner's second morning, folded into the first (plan 2.1): queues above because
         they are actionable, figures below because they are context. Never for the
         merchandiser branch — their figures live on their own desks. */
      after={isOwnerView ? <OwnerFigures ctx={ctx} /> : undefined}
    />
  )
}

function quoteNeedCount(quotes: Awaited<ReturnType<typeof rfqBoard>>): number {
  return quoteNeedRows(quotes).length
}

function quoteNeedRows(quotes: Awaited<ReturnType<typeof rfqBoard>>) {
  const clarifying = quotes.groups
    .flatMap((g) => g.rfqs)
    .filter((r) => r.openClarifications > 0)
  const seen = new Set(quotes.overdue.map((r) => r.id))
  return [...quotes.overdue, ...clarifying.filter((r) => !seen.has(r.id))]
}

function deskSummaryRows(input: {
  quietN: number
  quoteN: number
  riskN: number
  ppN: number
}): WorkRow[] {
  const rows: WorkRow[] = []
  if (input.quietN > 0) {
    rows.push({
      id: 'desk-quiet',
      title: `${input.quietN} quiet lead${input.quietN === 1 ? '' : 's'}`,
      why: 'Nobody has spoken to these buyers recently.',
      href: '/buyers',
      severity: 'medium',
      cta: HOME_COPY.open,
    })
  }
  if (input.quoteN > 0) {
    rows.push({
      id: 'desk-quotes',
      title: `${input.quoteN} quote${input.quoteN === 1 ? '' : 's'} needing a chase`,
      why: 'Past deadline or sitting on an open clarification.',
      href: '/rfq',
      severity: 'medium',
      cta: HOME_COPY.open,
    })
  }
  if (input.riskN > 0) {
    rows.push({
      id: 'desk-orders',
      title: `${input.riskN} order${input.riskN === 1 ? '' : 's'} at risk or late`,
      why: 'TNA headlines that need a merchandiser.',
      href: '/orders',
      severity: 'high',
      cta: HOME_COPY.open,
    })
  }
  if (input.ppN > 0) {
    rows.push({
      id: 'desk-pp',
      title: `${input.ppN} PP style${input.ppN === 1 ? '' : 's'} blocking cut`,
      why: 'Cutting dates inside the PP window without approval.',
      href: '/sampling',
      severity: 'high',
      cta: HOME_COPY.open,
    })
  }
  return rows
}
