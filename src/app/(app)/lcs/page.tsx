import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { compareDecimalStrings } from '@/lib/quantity'
import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { WorkCue } from '@/components/shell/work-cue'
import { canWrite, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { buyerAccounts } from '@/modules/buyers/queries'
import { companyProfile } from '@/modules/settings/service'
import { exposureByCurrency, register, type LcAlert, type LcRow } from '@/modules/commercial/queries'
import type { BankDocsPolicy } from '@/modules/commercial/service'
import { getPolicy } from '@/modules/settings/service'

import { NewLcButton } from './new-lc'

/**
 * 2.1 LC Register.
 *
 * The two dates are the point of this screen. Shipping inside expiry but past
 * the latest shipment date produces a discrepancy the buyer has to waive, and
 * that is the most common way a factory's money gets stuck at a bank — so both
 * clocks are shown on every row rather than one standing for the other.
 */
export const dynamic = 'force-dynamic'

export default async function LcsPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')
  const btbLimitPct = policy.btbLimitPct ?? 75
  // An LC is "expiring" once it is inside the window the factory already uses to
  // escalate a stuck discrepancy — past that point there is no longer time to
  // fix a problem before the credit lapses.
  const expiringWithinDays = policy.discrepancyEscalateAfterDays * 3

  const [rows, exposure] = await Promise.all([
    register(ctx, { now: new Date(), expiringWithinDays, btbLimitPct }),
    exposureByCurrency(ctx),
  ])

  const flagged = rows.filter((r) => r.alerts.length > 0)

  const profile = await companyProfile(ctx)
  const mayWrite = canWrite(
    NAV.find((n) => n.id === 'lcs')!,
    ctx.roles,
    profile?.factoryType ?? 'woven',
  )
  // An LC belongs to a buyer's bank, so the buyer has to exist first. Read through the
  // buyers module's own queries (rule 11).
  const buyers = mayWrite ? await buyerAccounts(ctx) : []

  return (
    <>
      <PageHeader
        actions={mayWrite ? <NewLcButton buyers={buyers} /> : undefined}
        eyebrow="LC register"
        title={rows.length === 0 ? 'No credits on file' : `${rows.length} letters of credit`}
        meta={flagged.length > 0 ? `${flagged.length} need attention` : undefined}
        ownsAmber
      />

      <WorkCue
        items={
          flagged.length > 0
            ? [
                {
                  label: `${flagged.length} credit${flagged.length === 1 ? '' : 's'} need attention`,
                  href: '/lcs',
                },
              ]
            : []
        }
      />

      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <Link
          href="/lcs/submissions"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            minHeight: 44,
            padding: '10px 14px',
            borderRadius: 'var(--fx-radius-md)',
            border: '1px solid var(--fx-border-default)',
            font: "500 13px/1 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
            textDecoration: 'none',
          }}
        >
          Documents at the bank
        </Link>
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
        {exposure.length > 0 ? (
          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {/* Never netted across currencies — there is no ambient rate in this
                system, and an owner's exposure screen is the worst place to
                invent the first one. */}
            {exposure.map((e) => (
              <div
                key={e.currency}
                style={{
                  background: 'var(--fx-bg-surface)',
                  border: '1px solid var(--fx-border-subtle)',
                  borderRadius: 'var(--fx-radius-md)',
                  padding: '16px 20px',
                  minWidth: 200,
                }}
              >
                <Eyebrow>Open exposure · {e.currency}</Eyebrow>
                <div
                  data-numeric
                  style={{ font: "600 26px/1.1 var(--fx-font-sans)", marginTop: 6 }}
                >
                  {e.openValue}
                </div>
                <div style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                  across {e.count} active {e.count === 1 ? 'credit' : 'credits'}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {flagged.length > 0 ? (
          <section>
            <SectionHeading eyebrow={`BTB limit ${btbLimitPct}%`}>Needs attention</SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {flagged.map((lc) => (
                <LcAlertCard key={lc.id} lc={lc} />
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <SectionHeading>The register</SectionHeading>

          {rows.length === 0 ? (
            <EmptyState
              title="No letters of credit yet"
              body="A master LC is what the buyer opens to pay for an order. Back-to-back credits for fabric and trims are drawn against it, and never past its limit."
              action={
                mayWrite ? (
                  <span style={{ font: '400 13px/1.4 var(--fx-font-sans)', color: 'var(--fx-text-tertiary)' }}>
                    Use New LC above to record the first one.
                  </span>
                ) : (
                  <Link
                    href="/lcs/submissions"
                    style={{
                      font: '500 13px/1 var(--fx-font-sans)',
                      color: 'var(--fx-accent-pressed)',
                      textDecoration: 'none',
                    }}
                  >
                    Documents at the bank →
                  </Link>
                )
              }
            />
          ) : (
            /*
             * Scrolls sideways inside the card, not with the page (plan 4.4).
             *
             * Seven columns cannot stack — the header is one grid and every row is another,
             * so stacking would leave the labels above columns they no longer line up with.
             * The minimum keeps each column readable and lets the card scroll; a cut-off
             * column says there is more to the right, which a page that quietly grew wider
             * than the screen does not.
             */
            <div
              className="fx-scroll-x"
              // Focusable, or a keyboard cannot scroll it (WCAG 2.1.1). Found by 7.2's
              // axe sweep at the tablet viewport — the check 4.4 could not make when it
              // added this wrapper, because there was no browser to make it in.
              tabIndex={0}
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                overflowY: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.4fr 1fr 1fr .9fr .9fr .8fr .8fr',
                  minWidth: 780,
                  gap: 12,
                  padding: '10px 18px 10px 21px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 11px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>LC number</div>
                <div>Buyer</div>
                <div style={{ textAlign: 'right' }}>Value</div>
                <div>Latest ship</div>
                <div>Expiry</div>
                <div style={{ textAlign: 'right' }}>BTB</div>
                <div style={{ textAlign: 'right' }}>Status</div>
              </div>

              {rows.map((lc) => (
                <div
                  key={lc.id}
                  className="fx-selvage"
                  data-status={selvageFor(lc)}
                  data-critical={lc.alerts.some((a) => a.kind === 'expired' || a.kind === 'discrepant') || undefined}
                  style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
                >
                  <div
                    style={{
                      flex: 1,
                                            display: 'grid',
                      gridTemplateColumns: '1.4fr 1fr 1fr .9fr .9fr .8fr .8fr',
                      minWidth: 780,
                      gap: 12,
                      padding: '13px 18px',
                      alignItems: 'center',
                      minHeight: 'var(--fx-row-height)',
                    }}
                  >
                    <Link
                      href={`/lcs/${lc.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                      aria-label={`Open ${lc.number}`}
                    >
                      <Ident>{lc.number}</Ident>
                    </Link>
                    <span style={{ font: "400 13.5px/1.3 var(--fx-font-sans)" }}>
                      {lc.buyerName ?? '—'}
                    </span>
                    <span
                      data-numeric
                      data-mono
                      style={{
                        font: "400 13px/1.3 var(--fx-font-mono)",
                        textAlign: 'right',
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {lc.value} {lc.currency}
                    </span>
                    <DateCell date={lc.latestShipmentDate} days={lc.daysToLatestShipment} />
                    <DateCell date={lc.expiryDate} days={lc.daysToExpiry} />
                    <span
                      data-numeric
                      style={{
                        font: "400 12.5px/1.3 var(--fx-font-mono)",
                        textAlign: 'right',
                        color:
                          lc.btbUsedPct && compareDecimalStrings(lc.btbUsedPct, String(btbLimitPct)) > 0
                            ? 'var(--fx-danger)'
                            : 'var(--fx-text-secondary)',
                      }}
                    >
                      {lc.btbCount === 0 ? '—' : `${lc.btbUsedPct ?? '—'}%`}
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <Badge tone={lc.status === 'active' ? 'success' : 'neutral'}>{lc.status}</Badge>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function selvageFor(lc: LcRow): 'on-track' | 'at-risk' | 'late' | 'done' {
  if (lc.status === 'closed') return 'done'
  const worst = lc.alerts[0]
  if (!worst) return 'on-track'
  if (
    worst.kind === 'expired' ||
    worst.kind === 'latest_shipment_passed' ||
    worst.kind === 'discrepant' ||
    worst.kind === 'btb_over_limit'
  ) {
    return 'late'
  }
  return 'at-risk'
}

function DateCell({ date, days }: { date: string | null; days: number | null }) {
  if (!date) {
    return <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>—</span>
  }

  const colour =
    days === null
      ? 'var(--fx-text-secondary)'
      : days < 0
        ? 'var(--fx-danger)'
        : days <= 21
          ? 'var(--fx-warning)'
          : 'var(--fx-text-secondary)'

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span data-numeric data-mono style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: colour }}>
        {date}
      </span>
      {days !== null ? (
        <span data-numeric style={{ font: "400 11px/1.3 var(--fx-font-mono)", color: colour }}>
          {days < 0 ? `${Math.abs(days)} d past` : `${days} d`}
        </span>
      ) : null}
    </span>
  )
}

function LcAlertCard({ lc }: { lc: LcRow }) {
  return (
    <div
      className="fx-selvage"
      data-status={selvageFor(lc)}
      data-critical={lc.alerts.some((a) => a.kind === 'expired' || a.kind === 'discrepant') || undefined}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        boxShadow: 'var(--fx-sh1)',
      }}
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <Link
                      href={`/lcs/${lc.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                      aria-label={`Open ${lc.number}`}
                    >
                      <Ident>{lc.number}</Ident>
                    </Link>
          {lc.buyerName ? (
            <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>{lc.buyerName}</span>
          ) : null}
          <span
            data-numeric
            data-mono
            style={{
              marginLeft: 'auto',
              font: "400 12.5px/1 var(--fx-font-mono)",
              color: 'var(--fx-text-secondary)',
            }}
          >
            {lc.value} {lc.currency}
          </span>
        </div>

        {lc.alerts.map((a, i) => (
          <InlineAlert key={i} tone={toneFor(a)}>
            {describe(a)}
          </InlineAlert>
        ))}
      </div>
    </div>
  )
}

function toneFor(a: LcAlert): 'warning' | 'danger' {
  return a.kind === 'expiring' ? 'warning' : 'danger'
}

function describe(a: LcAlert): string {
  switch (a.kind) {
    case 'latest_shipment_passed':
      return `Latest shipment passed ${a.days} days ago. Anything leaving now is a discrepancy the buyer has to waive.`
    case 'expiring':
      return `Expires in ${a.days} days. Documents have to be at the bank's counters before then, not merely posted.`
    case 'expired':
      return `Expired ${a.days} days ago. The bank will not accept documents against it.`
    case 'discrepant':
      return `${a.count} submission${a.count === 1 ? '' : 's'} sitting discrepant at the bank${
        a.oldestDays !== null ? `, the oldest for ${a.oldestDays} days` : ''
      }. Money is stuck until somebody answers.`
    case 'btb_over_limit':
      return `Back-to-backs are at ${a.usedPct}% of this master, over the ${a.limitPct}% limit. The factory owes its suppliers more than this credit will pay it.`
  }
}
