import { headers } from 'next/headers'
import { formatFactoryDate } from '@/lib/dates'
import { redirect } from 'next/navigation'

import { compareDecimalStrings } from '@/lib/quantity'
import { CloseOutNote } from '@/components/fx/close-out-note'
import { Card } from '@/components/fx/data'
import { SavableCard } from '@/components/fx/save-card'
import { EmptyState, LockedState } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { env } from '@/lib/env'
import { getCtx } from '@/modules/core/session'
import { NOTE_EDIT_WINDOW_DAYS, noteWindowOpen } from '@/modules/memory/memory'
import { outcomes, type Pair } from '@/modules/memory/queries'

/**
 * 1.6 Order Memory.
 *
 * What the factory learned from an order it has already shipped. Every figure
 * is planned against actual, because the quoted number is the one everybody
 * already remembers — the useful one is what it turned out to cost.
 */
export const dynamic = 'force-dynamic'

export default async function MemoryPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  /*
   * The copilot's off-switch, honoured (plan 6.1).
   *
   * `MARBIM_ENABLED` had zero runtime consumers, so with it off this screen opened and
   * every question hard-failed against a provider that was never registered. A factory
   * should be told the copilot is not available rather than shown one that does not work.
   */
  if (!env.MARBIM_ENABLED) return <LockedState what="order memory" />

  const now = new Date()
  const cards = await outcomes(ctx)

  return (
    <>
      <PageHeader
        eyebrow="Order memory"
        title={cards.length === 0 ? 'Nothing compiled yet' : `${cards.length} closed orders`}
        ownsAmber
      />

      {cards.length === 0 ? (
        <EmptyState
          title="No outcomes yet"
          body="An outcome is compiled when an order closes — actual consumption, the efficiency curve, what went wrong and what the margin really was. The merchandiser then has seven days to add what a number cannot say."
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {cards.map((card) => {
            const gaps = Object.entries(card.compiledSources ?? {}).filter(([, ok]) => !ok)

            return (
              <SavableCard
                key={card.outcomeId}
                filename={`${card.poNumber ?? card.styleCode ?? 'order'}-outcome`}
              >
              <Card padding={0}>
                <div
                  style={{
                    padding: '18px 22px 14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 12,
                    flexWrap: 'wrap',
                    borderBottom: '1px solid var(--fx-border-subtle)',
                  }}
                >
                  {card.poNumber ? <Ident>{card.poNumber}</Ident> : null}
                  {card.styleCode ? <Badge>{card.styleCode}</Badge> : null}
                  {card.buyerName ? (
                    <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>{card.buyerName}</span>
                  ) : null}
                  <span
                    data-numeric
                    style={{
                      marginLeft: 'auto',
                      font: "400 12px/1 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {card.piecesProduced.toLocaleString()} pcs · compiled{' '}
                    {formatFactoryDate(card.compiledAt)}
                  </span>
                </div>

                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                    gap: 20,
                    padding: '18px 22px',
                  }}
                >
                  <PairFigure label="Margin" pair={card.margin} unit="%" basis={card.marginBasis} />

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <Eyebrow>Measured consumption</Eyebrow>
                    {card.consumption.length === 0 ? (
                      <span
                        style={{ font: "500 15px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                      >
                        not measured
                      </span>
                    ) : (
                      card.consumption.slice(0, 3).map((line) => (
                        <span
                          key={line.itemRef}
                          data-numeric
                          style={{ font: "400 13px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                        >
                          {line.perPiece} {line.uom}
                          <span style={{ color: 'var(--fx-text-tertiary)' }}> · {line.itemRef}</span>
                        </span>
                      ))
                    )}
                    <span style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
                      issued over pieces produced
                    </span>
                  </div>

                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <Eyebrow>Went wrong</Eyebrow>
                    <span data-numeric style={{ font: "500 15px/1.3 var(--fx-font-mono)" }}>
                      {card.delayEvents.length} delays · {card.topDefects.length} defect types
                    </span>
                  </div>
                </div>

                {/* A source the compiler could not read is a gap in the memory,
                    and saying so is the difference between "nothing went wrong"
                    and "we did not look". */}
                {gaps.length > 0 || card.unreadable > 0 ? (
                  <div
                    style={{
                      padding: '11px 22px',
                      borderTop: '1px solid var(--fx-border-subtle)',
                      font: "400 12px/1.5 var(--fx-font-mono)",
                      color: 'var(--fx-warning)',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    {gaps.length > 0 ? (
                      <span>compiled without: {gaps.map(([k]) => k.replace(/_/g, ' ')).join(', ')}</span>
                    ) : null}
                    {/* Distinct from a gap: the compiler HAD this input, and
                        this reader could not make sense of what it wrote. */}
                    {card.unreadable > 0 ? (
                      <span>
                        {card.unreadable} stored{' '}
                        {card.unreadable === 1 ? 'entry' : 'entries'} could not be read — this
                        record is incomplete
                      </span>
                    ) : null}
                  </div>
                ) : null}

                {card.note ? (
                  <div
                    style={{
                      padding: '16px 22px',
                      borderTop: '1px solid var(--fx-border-subtle)',
                      background: 'var(--fx-bg-sunken)',
                    }}
                  >
                    <Eyebrow>What a number cannot say</Eyebrow>
                    <div
                      style={{
                        font: "400 14px/1.6 var(--fx-font-sans)",
                        color: 'var(--fx-text-primary)',
                        textWrap: 'pretty',
                        marginTop: 8,
                      }}
                    >
                      {card.note}
                    </div>
                  </div>
                ) : (
                  // No note yet. The close-out prompt only appears while the window is
                  // open — after it, `CloseOutNote` says so rather than offering a box that
                  // the service would refuse.
                  <div
                    style={{
                      padding: '16px 22px',
                      borderTop: '1px solid var(--fx-border-subtle)',
                      background: 'var(--fx-bg-sunken)',
                    }}
                  >
                    <Eyebrow>Closing {card.poNumber ?? 'this order'}</Eyebrow>
                    <div style={{ marginTop: 10 }}>
                      <CloseOutNote
                        orderId={card.orderId}
                        poNumber={card.poNumber}
                        existingNote={card.note}
                        windowOpen={noteWindowOpen(card.compiledAt, now)}
                        daysLeft={Math.max(
                          0,
                          NOTE_EDIT_WINDOW_DAYS -
                            Math.floor(
                              (now.getTime() - card.compiledAt.getTime()) / 86_400_000,
                            ),
                        )}
                      />
                    </div>
                  </div>
                )}
              </Card>
              </SavableCard>
            )
          })}
        </div>
      )}

      <div style={{ marginTop: 36 }}>
        <SectionHeading eyebrow="how this is used">Seeding the next quote</SectionHeading>
        <Card>
          <div
            style={{
              font: "400 14px/1.6 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
              textWrap: 'pretty',
            }}
          >
            When a new style is costed, the studio looks for the closest thing this factory
            has already made and offers its <em>measured</em> consumption as the starting
            point rather than the planned figure. The merchandiser can take it or leave it —
            but the number they are arguing with is one this factory actually achieved.
          </div>
        </Card>
      </div>
    </>
  )
}

function PairFigure({
  label,
  pair,
  unit,
  basis,
}: {
  label: string
  pair: Pair
  unit?: string
  basis?: string | null
}) {
  const worse = pair.variancePct !== null && compareDecimalStrings(pair.variancePct, '0') < 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <Eyebrow>{label}</Eyebrow>

      {pair.actual === null ? (
        <span style={{ font: "500 15px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          not compiled
        </span>
      ) : (
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
          <span
            data-numeric
            style={{
              font: "600 20px/1.2 var(--fx-font-sans)",
              color: worse ? 'var(--fx-warning)' : 'var(--fx-text-primary)',
            }}
          >
            {pair.actual}
            {unit}
          </span>
          {pair.planned !== null ? (
            <span
              data-numeric
              style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
            >
              quoted {pair.planned}
              {unit}
            </span>
          ) : null}
        </span>
      )}

      <span style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
        {pair.variancePct !== null
          ? `${compareDecimalStrings(pair.variancePct, '0') >= 0 ? '+' : ''}${pair.variancePct} pts vs quote`
          : 'no quote on file to compare'}
        {basis ? ` · on ${basis}` : ''}
      </span>
    </div>
  )
}
