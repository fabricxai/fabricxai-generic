import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { describeException, exceptionKindLabel } from '@/components/fx/exception-copy'
import { LockedState } from '@/components/fx/feedback'
import { CoverageNote, ExceptionRow, FigureTile } from '@/components/fx/figures'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { WorkCue } from '@/components/shell/work-cue'
import { canSee, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import {
  buyerScorecards,
  cash,
  efficiencyTrend,
  exceptions,
  dhuTrend,
  listSavedReports,
  listScheduledExports,
  orderBook,
  otd,
  type AnalyticsPolicy,
} from '@/modules/analytics/queries'
import { requestLocale } from '@/lib/ui-locale'
import { companyProfile, getPolicy } from '@/modules/settings/service'

/**
 * 11.2 Owner Dashboard.
 *
 * `modules/analytics` is read-only by lint, and this screen inherits that: it
 * imports queries and nothing else. Every figure arrives as `Figure<T>`, which
 * is either a value or the reason there isn't one — so a computation that fails
 * shows why rather than collapsing to a zero somebody acts on.
 */
export const dynamic = 'force-dynamic'

/** The period is one ratio over the whole window, never the mean of daily points. */
function windowFor(now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
  return { from, to }
}

export default async function DashboardPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const profile = await companyProfile(ctx)
  const locale = await requestLocale(profile?.locale)
  const item = NAV.find((n) => n.id === 'dashboard')!

  // Deliberately narrow — this is the whole-factory view.
  if (!canSee(item, ctx.roles, profile?.factoryType ?? 'woven')) {
    return <LockedState what="the owner dashboard" />
  }

  const now = new Date()
  const window = windowFor(now)
  const policy = await getPolicy<AnalyticsPolicy>(ctx, 'analytics')

  // Every panel is independent, so one failing computation must not blank the
  // others — each figure already carries its own unavailable reason.
  const [feed, book, delivery, efficiency, dhu, cashUsd, scorecards, saved, scheduled] =
    await Promise.all([
      exceptions(ctx, now, policy),
      orderBook(ctx),
      otd(ctx, window, policy),
      efficiencyTrend(ctx, window, policy),
      dhuTrend(ctx, window, policy),
      cash(ctx, profile?.baseCurrency ?? 'USD'),
      buyerScorecards(ctx, window, policy),
      listSavedReports(ctx),
      listScheduledExports(ctx),
    ])

  const pieces = book.byStatus.reduce((sum, s) => sum + s.pieces, 0)
  const high = feed.exceptions.filter((e) => e.severity === 'high').length

  return (
    <>
      <PageHeader
        eyebrow={profile?.legalName ?? 'Factory'}
        title="Today"
        meta={`${window.from} → ${window.to}`}
        // Amber only when something is actually waiting. A dashboard that glows on a quiet
        // morning has spent the one signal it has by the time something is genuinely wrong.
        ownsAmber={feed.exceptions.length > 0}
      />

      <WorkCue
        items={
          feed.exceptions.length > 0
            ? [
                {
                  label: `${feed.exceptions.length} exception${feed.exceptions.length === 1 ? '' : 's'} on Your work`,
                  href: '/home',
                },
              ]
            : []
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
        <section>
          <SectionHeading eyebrow={high > 0 ? `${high} need a decision` : undefined}>
            What is wrong right now
          </SectionHeading>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {feed.exceptions.length === 0 ? (
              <div
                style={{
                  background: 'var(--fx-bg-surface)',
                  border: '1px solid var(--fx-border-subtle)',
                  borderRadius: 'var(--fx-radius-md)',
                  padding: 24,
                  font: "400 14px/1.55 var(--fx-font-sans)",
                  color: 'var(--fx-text-secondary)',
                }}
              >
                Nothing open in the feed.
              </div>
            ) : (
              feed.exceptions.map((e) => (
                <ExceptionRow
                  key={e.id}
                  kind={exceptionKindLabel(e.kind, locale)}
                  /* The PO number, not the milestone's primary key. `e.ref` is a uuid, and a
                     uuid tells the owner nothing about which order is in trouble. */
                  reference={e.subject ?? '—'}
                  truth={describeException({ kind: e.kind, subject: e.subject, detail: e.detail }, locale)}
                  /* `since` is preserved by the worker, so the age keeps
                     counting from when it first became true. */
                  age={e.ageDays === 0 ? 'today' : `${e.ageDays} days`}
                  severity={e.severity}
                />
              ))
            )}
            <CoverageNote coverage={feed.coverage} />
          </div>
        </section>

        <section>
          <SectionHeading>The numbers</SectionHeading>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
              gap: 16,
            }}
          >
            <FigureTile
              label="Order book"
              figure={{ value: book.totalOrders }}
              unit="orders"
              basis={`${pieces.toLocaleString()} pieces across ${book.byStatus.length} statuses`}
              source="counted from the order book"
            />

            <FigureTile
              label="On-time delivery"
              figure={delivery.pct}
              unit={'value' in delivery.pct ? '%' : undefined}
              basis={`${delivery.onTime} of ${delivery.shipments} shipments left on the ex-factory date`}
              source={`minimum ${policy.minShipmentsForOtd} shipments before a percentage is stated`}
            />

            {/* `direction` is already semantic — the analytics layer knows a
                falling DHU is improving and a falling efficiency is not, so the
                screen never re-interprets which way is good. */}
            <FigureTile
              label="Efficiency"
              figure={efficiency.period}
              unit={'value' in efficiency.period ? '%' : undefined}
              basis={`${efficiency.points.length} line-days of hourly output`}
              source="earned minutes over available minutes, as one ratio for the period"
              tone={toneFor(efficiency.direction)}
            />

            <FigureTile
              label="DHU"
              figure={dhu.period}
              basis={`${dhu.points.length} days of inline checks`}
              source="defects per hundred units"
              tone={toneFor(dhu.direction)}
            />

            <FigureTile
              label={`Cash position · ${cashUsd.net.currency}`}
              figure={{ value: cashUsd.net.amount }}
              basis={`${cashUsd.inflow.amount} in against ${cashUsd.outflow.amount} out`}
              /* Netting across currencies would invent an exchange rate, so the
                 tile states the one currency it was computed in. */
              source={`one currency only — ${cashUsd.net.currency} receivables against ${cashUsd.net.currency} payables`}
            />
          </div>
        </section>

        {/* ── Who is worth the capacity ─────────────────────────────────── */}
        <section>
          <SectionHeading
            eyebrow={`${scorecards.filter((s) => s.rated).length} of ${scorecards.length} rated`}
          >
            Buyers
          </SectionHeading>

          {scorecards.length === 0 ? (
            <div style={quietCard}>No buyer has enough history in this window to place.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {scorecards.map((s) => (
                <div
                  key={s.buyerId}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 80px minmax(0, 1.4fr)',
                    gap: 14,
                    alignItems: 'center',
                    padding: '12px 18px',
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                  }}
                >
                  <span style={{ font: "500 14px/1.3 var(--fx-font-sans)", minWidth: 0 }}>
                    {s.buyerId.slice(0, 8)}
                  </span>

                  {/* A score OR a reason, never both. Printing 0 beside "too few orders"
                      invites somebody to read the zero as the answer. */}
                  <span
                    data-numeric
                    style={{
                      font: "600 17px/1.2 var(--fx-font-mono)",
                      textAlign: 'right',
                      color: s.rated ? 'var(--fx-text-primary)' : 'var(--fx-text-tertiary)',
                    }}
                  >
                    {s.rated ? s.score : '—'}
                  </span>

                  <span
                    style={{
                      font: "400 12px/1.4 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                      textAlign: 'right',
                      minWidth: 0,
                    }}
                  >
                    {s.rated
                      ? `otd ${s.components.otd ?? '—'} · dhu ${s.components.dhu ?? '—'} · margin ${s.components.margin ?? '—'}`
                      : (s.reason ?? 'not rated')}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Saved and scheduled ───────────────────────────────────────── */}
        <section>
          <SectionHeading eyebrow={`${saved.length} saved · ${scheduled.length} scheduled`}>
            Reports
          </SectionHeading>

          {saved.length === 0 && scheduled.length === 0 ? (
            <div style={quietCard}>
              Nothing saved yet. A report asked for in words through MARBIM can be kept here and
              scheduled to arrive without anybody opening this screen.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {saved.map((r) => (
                <div key={r.id} style={reportRow}>
                  <span style={{ font: "500 13.5px/1.3 var(--fx-font-sans)", flex: 1, minWidth: 0 }}>
                    {r.name}
                  </span>
                  <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                    saved
                  </span>
                </div>
              ))}
              {scheduled.map((r) => (
                <div key={r.id} style={reportRow}>
                  <span style={{ font: "500 13.5px/1.3 var(--fx-font-sans)", flex: 1, minWidth: 0 }}>
                    {/* A schedule has no name of its own — it is an instruction about a
                        saved report, so it borrows that report's name rather than
                        inventing one. */}
                    {saved.find((x) => x.id === r.savedReportId)?.name ?? 'report'}
                  </span>
                  <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                    {r.period} · {r.format} · {r.recipients.length}{' '}
                    {r.recipients.length === 1 ? 'recipient' : 'recipients'}
                    {r.nextRunAt ? ` · next ${r.nextRunAt.toISOString().slice(0, 10)}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

const quietCard: React.CSSProperties = {
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
  borderRadius: 'var(--fx-radius-md)',
  padding: 22,
  font: "400 14px/1.55 var(--fx-font-sans)",
  color: 'var(--fx-text-secondary)',
}

const reportRow: React.CSSProperties = {
  display: 'flex',
  gap: 12,
  alignItems: 'center',
  padding: '11px 18px',
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
}

/** `unknown` and `flat` both stay neutral: neither is news. */
function toneFor(direction: string): 'neutral' | 'good' | 'warning' {
  if (direction === 'improving') return 'good'
  if (direction === 'worsening') return 'warning'
  return 'neutral'
}

/**
 * One sentence saying what is true and what it costs.
 *
 * The feed stores structured detail rather than a sentence, so the wording lives
 * here where it can change without a migration.
 */
