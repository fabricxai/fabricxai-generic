import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Breadcrumbs, StatTile } from '@/components/fx/data'
import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Figure, Ident } from '@/components/fx/format'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import {
  lastPeriodWithRecord,
  latestScoredPeriod,
  scoredPeriods,
  supplierScorecard,
} from '@/modules/procurement/queries'

import { PeriodPicker } from './period-picker'

/**
 * 3.2 Supplier scorecard.
 *
 * **Nothing here is ranked, and that is deliberate.** The obvious screen sorts suppliers
 * best-to-worst on a composite, and there is no composite: `supplierScore` returns four
 * independent metrics and no total, because weighting on-time against price is a commercial
 * judgement that changes per order. A number invented in the view layer to make a sort
 * possible would be a figure nobody could trace to anything (and the one people would then
 * quote). The table sorts by name; the reader decides what matters this time.
 *
 * **A blank is never a zero.** Every metric arrives nullable and stays that way to the
 * screen. A supplier with no closed receipts has no on-time percentage — not 0%, not 100% —
 * and each blank says which of those it is. The distinction decides whether somebody sends
 * them work.
 *
 * **Thin scores are labelled thin.** 100% on-time from one receipt and from forty are the
 * same number and not the same fact, so `observations` sits under every row.
 */
export const dynamic = 'force-dynamic'

/** The reject rate has no source yet — say which blank this is. See `computeSupplierScores`. */
const REJECTS_UNMEASURED = 'not measured'

function pct(value: string | null, unavailable: string) {
  return <Figure value={value === null ? null : `${value}%`} size={19} unavailable={unavailable} />
}

export default async function ScorecardPage({
  searchParams,
}: {
  searchParams: Promise<{ period?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const { period: requested } = await searchParams
  const [latest, periods] = await Promise.all([latestScoredPeriod(ctx), scoredPeriods(ctx)])

  // The period is resolved from what has actually been scored, never defaulted to today.
  // A screen that assumes "this month" and finds nothing cannot tell an unscored month
  // from a month with no activity, and renders an empty scorecard for both.
  const period = requested && periods.includes(requested) ? requested : latest

  if (!period) {
    return (
      <>
        <PageHeader eyebrow="Procurement" title="Supplier scorecard" ownsAmber />
        <EmptyState
          title="No period has been scored yet"
          body="Scores are computed overnight from closed receipts and the quotes suppliers returned. Nothing has run yet, which is not the same as every supplier having no record — there is simply nothing to read."
        />
      </>
    )
  }

  const rows = await supplierScorecard(ctx, { period })

  // Only fetched when this period turns out to be empty — see the alert below.
  const anyRecord = rows.some(
    (r) => r.observations > 0 || r.onTimePct !== null || r.priceIndex !== null || r.responsivenessPct !== null,
  )
  const lastWithRecord = anyRecord ? null : await lastPeriodWithRecord(ctx, { excluding: period })

  const scored = rows.filter((r) => r.observations > 0)
  const silent = rows.filter((r) => r.observations === 0)
  const thin = scored.filter((r) => r.observations < 3)

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[{ label: 'Procurement', href: '/procurement' }, { label: 'Scorecard' }]}
        />
      </div>

      <PageHeader
        back={{ href: '/procurement', label: 'Procurement' }}
        eyebrow="Procurement · supplier scorecard"
        title={`How suppliers performed in ${monthName(period)}`}
        meta={`${scored.length} of ${rows.length} with a record`}
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <PeriodPicker periods={periods} current={period} />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
            gap: 14,
          }}
        >
          <StatTile
            label="Suppliers with a record"
            value={<Figure value={scored.length} />}
            basis={`of ${rows.length} active`}
          />
          <StatTile
            label="Scores resting on under 3 receipts"
            value={<Figure value={thin.length} />}
            basis={thin.length > 0 ? 'read these as indicative, not as a record' : 'none'}
            status={thin.length > 0 ? 'at-risk' : undefined}
          />
          <StatTile
            label="Sent no work this period"
            value={<Figure value={silent.length} />}
            basis={
              silent.length > 0
                ? 'no receipts and no quotes — worth knowing before sending more'
                : 'none'
            }
          />
        </div>

        {/*
          The current month is scored every night, so it always has rows — and early in a
          month every one of them is empty. Without this a reader lands on a blank table
          and concludes the factory's suppliers have stopped performing, when the truth is
          that the month is three days old. The link is to the last period that had
          anything, named rather than silently substituted.
        */}
        {scored.length === 0 && lastWithRecord ? (
          <InlineAlert tone="info">
            Nothing has been received or quoted in {monthName(period)} yet — the month is still
            running, and an empty row here means no activity rather than poor performance. The
            most recent period with a record is{' '}
            <a href={`/procurement/scorecard?period=${lastWithRecord}`}>
              {monthName(lastWithRecord)}
            </a>
            .
          </InlineAlert>
        ) : null}

        {/* The reject column is structurally blank, and saying so once is better than a
            reader deciding for themselves what the empty cells mean. */}
        <InlineAlert tone="info">
          Reject rates are not measured yet. Quality records rejections against rolls, and the
          chain back from a roll to the purchase order it arrived on does not exist — so the
          column reads {REJECTS_UNMEASURED} rather than 0%, which would credit every supplier
          in the factory with a spotless record.
        </InlineAlert>

        <section>
          <SectionHeading eyebrow="sorted by name — there is no composite score to rank on">
            Every active supplier
          </SectionHeading>

          {rows.length === 0 ? (
            <EmptyState title="No active suppliers" body="Nothing to score." />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={metricRow}>
                <span style={{ ...headCell, flex: '1 1 210px' }}>Supplier</span>
                <span style={{ ...headCell, ...metricCell }}>On time</span>
                <span style={{ ...headCell, ...metricCell }}>Rejects</span>
                <span style={{ ...headCell, ...metricCell }}>Price index</span>
                <span style={{ ...headCell, ...metricCell }}>Quotes returned</span>
                <span style={{ ...headCell, ...metricCell }}>Based on</span>
              </div>

              {rows.map((row) => (
                <div key={row.supplierId} style={{ ...metricRow, ...rowSurface }}>
                  <span
                    style={{
                      flex: '1 1 210px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                    }}
                  >
                    <span style={{ font: "500 14.5px/1.3 var(--fx-font-sans)" }}>{row.name}</span>
                    <span style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                      <Ident size={11}>{row.code}</Ident>
                      <Badge tone={row.origin === 'import' ? 'info' : 'neutral'}>{row.origin}</Badge>
                    </span>
                  </span>

                  {/* Each blank names its own reason. "no closed receipts" and "everything
                      late" would otherwise render identically, and they are opposite facts. */}
                  <span style={metricCell}>{pct(row.onTimePct, 'no closed receipts')}</span>
                  <span style={metricCell}>{pct(row.qualityRejectPct, REJECTS_UNMEASURED)}</span>
                  <span style={metricCell}>
                    <Figure value={row.priceIndex} size={19} unavailable="no one to compare" />
                  </span>
                  <span style={metricCell}>
                    {pct(row.responsivenessPct, 'not asked to quote')}
                  </span>
                  <span
                    style={{
                      ...metricCell,
                      font: "400 12px/1.4 var(--fx-font-mono)",
                      color:
                        row.observations === 0
                          ? 'var(--fx-text-tertiary)'
                          : 'var(--fx-text-secondary)',
                    }}
                  >
                    {row.observations === 0
                      ? 'no receipts'
                      : `${row.observations} ${row.observations === 1 ? 'receipt' : 'receipts'}`}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>

        <p
          style={{
            margin: 0,
            font: '400 12px/1.6 var(--fx-font-mono)',
            color: 'var(--fx-text-tertiary)',
          }}
        >
          On time is per closed PO line against its expected delivery date. Price index compares
          a supplier against the others who quoted the SAME items — 100 is the field, 110 is ten
          per cent dearer — and items nobody else quoted are left out, so a sole quote does not
          score itself at par. Quotes returned counts replies against requests.
        </p>
      </div>
    </>
  )
}

/** `2026-08-01` → `August 2026`. The period is a month, so it reads as one. */
function monthName(period: string): string {
  const [year, month] = period.split('-')
  const names = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ]
  return `${names[Number(month) - 1] ?? period} ${year}`
}

const metricRow: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 14,
  flexWrap: 'wrap',
  padding: '13px 18px',
  minHeight: 'var(--fx-row-height)',
}

const rowSurface: React.CSSProperties = {
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
  borderRadius: 'var(--fx-radius-md)',
}

const headCell: React.CSSProperties = {
  font: "500 11px/1.3 var(--fx-font-mono)",
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: 'var(--fx-text-tertiary)',
}

/** Fixed width so the columns line up down the page without a grid. */
const metricCell: React.CSSProperties = {
  flex: '0 0 132px',
  textAlign: 'right',
}
