import Link from 'next/link'

import { Card } from '@/components/fx/data'
import { InlineAlert } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { FactPair } from '@/components/fx/tna'
import type { LcCoverageRow } from '@/modules/commercial/queries'

/**
 * The credit behind the order, on the order (design canvas, order page).
 *
 * A merchandiser owns the ship date and commercial owns the credit, and until now
 * nothing put the two on one screen — so the conflict between them was discovered by the
 * bank. The two dates that decide it are easy to confuse and are therefore both named in
 * full: LATEST SHIPMENT is the last day goods may leave, EXPIRY is the last day documents
 * may be presented. Shipping inside expiry but past latest shipment produces a
 * discrepancy the buyer has to waive, which is the commonest way a factory's money gets
 * stuck at a bank.
 *
 * Read-only, and it says so. `commercial` is the writer for `lcs` (rule 11): a
 * merchandiser who needs the date moved amends nothing here — they either move their own
 * ex-factory or ask commercial for an amendment, and the card links to the register where
 * that happens.
 *
 * BTB headroom is on the card for a reason that is not obvious from the order desk: the
 * import PO that buys this order's fabric is refused when the back-to-back ceiling is
 * already drawn, and the person who feels that refusal is the merchandiser whose fabric
 * does not arrive.
 */
const TONE: Record<string, 'success' | 'neutral' | 'danger'> = {
  active: 'success',
  draft: 'neutral',
  expired: 'danger',
  closed: 'neutral',
}

export function LcCard({
  rows,
  plannedExFactoryDate,
  seesPrices,
}: {
  rows: readonly LcCoverageRow[]
  plannedExFactoryDate: string | null
  seesPrices: boolean
}) {
  if (rows.length === 0) {
    return (
      <section>
        <SectionHeading eyebrow="read-only — commercial owns this">
          Letter of credit
        </SectionHeading>
        <Card>
          <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
            No credit is linked to this order yet. Confirmed orders usually run ahead of
            their LC for a few weeks; the bank documents cannot be raised until one is.
          </p>
        </Card>
      </section>
    )
  }

  return (
    <section>
      <SectionHeading eyebrow="read-only — commercial owns this">Letter of credit</SectionHeading>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {rows.map((lc) => (
          <Card key={lc.lcId}>
            <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
              <FactPair label="LC number">
                <Link
                  href={`/lcs/${lc.lcId}`}
                  style={{ color: 'var(--fx-accent-pressed)', textDecoration: 'none' }}
                >
                  <span data-mono>{lc.number}</span>
                </Link>{' '}
                <Badge tone={TONE[lc.status] ?? 'neutral'}>{lc.status}</Badge>
              </FactPair>

              <FactPair label="Latest shipment">
                <span data-mono>{lc.latestShipmentDate ?? '—'}</span>
                {/* The float against THIS order's plan, said in words: a bare date leaves
                    the subtraction to somebody reading two dates on different rows. */}
                {lc.floatDays !== null ? (
                  <span
                    style={{
                      font: '400 13px/1.4 var(--fx-font-sans)',
                      fontWeight: 400,
                      color: lc.conflict ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
                    }}
                  >
                    {lc.floatDays >= 0
                      ? ` · ${lc.floatDays} d before your ex-factory`
                      : ` · ${-lc.floatDays} d AFTER your ex-factory`}
                  </span>
                ) : null}
              </FactPair>

              <FactPair label="Expiry">
                <span data-mono>{lc.expiryDate ?? '—'}</span>
                {lc.daysToExpiry !== null ? (
                  <span
                    style={{
                      font: '400 13px/1.4 var(--fx-font-sans)',
                      fontWeight: 400,
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {lc.daysToExpiry >= 0
                      ? ` · ${lc.daysToExpiry} d`
                      : ` · expired ${-lc.daysToExpiry} d ago`}
                  </span>
                ) : null}
              </FactPair>

              {seesPrices ? (
                <FactPair label="BTB headroom">
                  <span data-mono data-numeric>
                    {lc.headroom.free} {lc.currency}
                  </span>
                  <span
                    style={{
                      font: '400 13px/1.4 var(--fx-font-sans)',
                      fontWeight: 400,
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {' '}
                    · drawn {lc.headroom.used} of {lc.headroom.limit} · the limit is{' '}
                    {lc.headroom.limitPct}% of the master
                  </span>
                </FactPair>
              ) : null}
            </div>

            {lc.conflict ? (
              <div style={{ marginTop: 14 }}>
                <InlineAlert tone="danger">
                  Ex-factory {plannedExFactoryDate ?? '—'} is after {lc.number}&rsquo;s latest
                  shipment of {lc.latestShipmentDate}. Move the date or have commercial amend
                  the credit — the bank will refuse documents for goods that left later.
                </InlineAlert>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </section>
  )
}
