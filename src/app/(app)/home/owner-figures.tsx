import { buyerAccounts } from '@/modules/buyers/queries'
import {
  buyerScorecards,
  cash,
  dhuTrend,
  efficiencyTrend,
  listSavedReports,
  listScheduledExports,
  orderBook,
  otd,
  type AnalyticsPolicy,
} from '@/modules/analytics/queries'
import type { RequestCtx } from '@/modules/core/ctx'
import { getPolicy } from '@/modules/settings/service'

import { FigureTile } from '@/components/fx/figures'
import { SectionHeading } from '@/components/fx/signature'

/**
 * The owner's figures, below the owner's queues (plan 2.1, audit S2).
 *
 * These sections were `/dashboard` — a second morning screen that opened, like home, with
 * the exceptions feed, so the most important user's first habit was split across two doors
 * claiming the same job. The queues and the figures belong on one screen in one order:
 * queues first because they are actionable, figures after because they are context. The
 * dashboard route now redirects here and the rail lost an entry.
 *
 * Lifted, not rewritten — every figure keeps its denominator and its as-of, and a score OR
 * a reason is shown, never both. One thing changed on the way: the buyer column printed
 * `buyerId.slice(0, 8)`, a truncated uuid, on the owner's own screen (the standing no-raw-
 * identifiers rule; nobody had walked this screen as an owner until the role audit did).
 * Buyers now show their names.
 */
export async function OwnerFigures({ ctx }: { ctx: RequestCtx }) {
  const now = new Date()
  const to = now.toISOString().slice(0, 10)
  const from = new Date(now.getTime() - 30 * 86_400_000).toISOString().slice(0, 10)
  const window = { from, to }

  const policy = await getPolicy<AnalyticsPolicy>(ctx, 'analytics')

  // Independent panels: one failing computation must not blank the others — each figure
  // carries its own unavailable reason.
  const [book, delivery, efficiency, dhu, cashUsd, scorecards, saved, scheduled, buyers] =
    await Promise.all([
      orderBook(ctx),
      otd(ctx, window, policy),
      efficiencyTrend(ctx, window, policy),
      dhuTrend(ctx, window, policy),
      cash(ctx, 'USD'),
      buyerScorecards(ctx, window, policy),
      listSavedReports(ctx),
      listScheduledExports(ctx),
      buyerAccounts(ctx),
    ])

  const buyerName = new Map(buyers.map((b) => [b.id, b.name]))
  const pieces = book.byStatus.reduce((sum, s) => sum + s.pieces, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36, marginTop: 36 }}>
      <section>
        <SectionHeading eyebrow={`${window.from} → ${window.to}`}>The numbers</SectionHeading>

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

          {/* `direction` is already semantic — the analytics layer knows a falling DHU is
              improving and a falling efficiency is not, so the screen never re-interprets
              which way is good. */}
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
            /* Netting across currencies would invent an exchange rate, so the tile states
               the one currency it was computed in. */
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
                  {buyerName.get(s.buyerId) ?? 'a buyer since removed'}
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
                  {/* A schedule has no name of its own — it is an instruction about a saved
                      report, so it borrows that report's name rather than inventing one. */}
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
