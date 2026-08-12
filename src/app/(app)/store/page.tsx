import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { recentGrns, stockOnHand } from '@/modules/store/queries'

import { PendingReadings } from '@/components/shell/pending-readings'
import { RaisedDrafts } from '@/components/shell/raised-drafts'

/**
 * 3.1 Store.
 *
 * A floor screen, and the one place the difference between ON HAND and FREE
 * matters most: on-hand includes stock already promised to another order, and
 * issuing against it is how two cutting tables are sent the same roll.
 */
export const dynamic = 'force-dynamic'

export default async function StorePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const [stock, grns] = await Promise.all([stockOnHand(ctx), recentGrns(ctx)])

  const overReserved = stock.filter((s) => s.overReserved)
  const bondedWithoutUd = grns.filter((g) => g.bonded && !g.udId)

  return (
    <FloorScreen>
      <PageHeader
        eyebrow={tui(locale, 'ui.store.index_eyebrow')}
        title={
          stock.length === 0
            ? tui(locale, 'ui.store.nothing_in_stock')
            : tui(
                locale,
                stock.length === 1 ? 'ui.store.index_title_one' : 'ui.store.index_title_other',
                { count: stock.length },
              )
        }
        meta={
          overReserved.length > 0
            ? tui(
                locale,
                overReserved.length === 1
                  ? 'ui.store.index_meta_over_reserved_one'
                  : 'ui.store.index_meta_over_reserved_other',
                { count: overReserved.length },
              )
            : undefined
        }
        ownsAmber
      />

      {/* Their corrections and overrides route to an inbox they cannot see (2.1). */}
      <PendingReadings />
      <RaisedDrafts />

      {/* The store is four screens, not one: the count, the rolls behind it, what the
          floor is owed, and what arrived. A storekeeper moves between them all shift. */}
      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(
          [
            { href: '/store/rolls', label: tui(locale, 'ui.store.nav_rolls') },
            { href: '/store/issue', label: tui(locale, 'ui.store.nav_issue') },
            { href: '/store/receive', label: tui(locale, 'ui.store.nav_receive') },
          ] as const
        ).map(({ href, label }) => (
          <Link
            key={href}
            href={href}
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
            {label}
          </Link>
        ))}
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {/* A bonded receipt without a UD is legal exposure, not a data quality
            nit — the schema requires the pairing, so this should be empty. */}
        {bondedWithoutUd.length > 0 ? (
          <InlineAlert tone="danger">
            {tui(
              locale,
              bondedWithoutUd.length === 1
                ? 'ui.store.bonded_without_ud_one'
                : 'ui.store.bonded_without_ud_other',
              { count: bondedWithoutUd.length },
            )}
          </InlineAlert>
        ) : null}

        {overReserved.length > 0 ? (
          <InlineAlert tone="warning">
            {tui(
              locale,
              overReserved.length === 1
                ? 'ui.store.over_reserved_alert_one'
                : 'ui.store.over_reserved_alert_other',
              { count: overReserved.length },
            )}
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading>{tui(locale, 'ui.store.stock_heading')}</SectionHeading>

          {stock.length === 0 ? (
            <EmptyState
              title={tui(locale, 'ui.store.stock_empty_title')}
              body={tui(locale, 'ui.store.stock_empty_body')}
            />
          ) : (
            /*
             * Scrolls sideways inside the card, not with the page (plan 4.4).
             *
             * Six columns of stock cannot stack: the header is one grid and every row is
             * another, so stacking would leave the labels above a column they no longer
             * line up with. A minimum width keeps the numbers readable and lets the card
             * scroll — a cut-off column tells a storekeeper there is more to the right,
             * which a page that quietly grew wider than the screen does not.
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
                  gridTemplateColumns: '1fr 2fr .8fr .9fr .9fr .9fr',
                  minWidth: 720,
                  gap: 12,
                  padding: '12px 20px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 12px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>{tui(locale, 'ui.store.col_code')}</div>
                <div>{tui(locale, 'ui.store.col_item')}</div>
                <div>{tui(locale, 'ui.store.col_rolls')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.store.col_on_hand')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.store.col_reserved')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.store.col_free')}</div>
              </div>

              {stock.map((row) => (
                <div
                  key={row.itemId}
                  className={row.overReserved ? 'fx-selvage' : undefined}
                  data-status={row.overReserved ? 'late' : undefined}
                  style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
                >
                  <div
                    style={{
                      flex: 1,
                      display: 'grid',
                      gridTemplateColumns: '1fr 2fr .8fr .9fr .9fr .9fr',
                      minWidth: 720,
                      gap: 12,
                      padding: '14px 20px',
                      alignItems: 'center',
                      minHeight: 'var(--fx-row-height)',
                    }}
                  >
                    <Ident size={14}>{row.code}</Ident>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span style={{ font: "500 16px/1.3 var(--fx-font-sans)" }}>{row.name}</span>
                      <span
                        style={{ font: "400 13px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
                      >
                        {row.spec ?? row.kind}
                      </span>
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span data-numeric style={{ font: "400 15px/1.2 var(--fx-font-mono)" }}>
                        {row.rollCount}
                      </span>
                      {/* Dye lots are not interchangeable — two shade groups in
                          one item is a decision somebody has to make, not a total. */}
                      {row.shadeGroups.length > 1 ? (
                        <span
                          style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-warning)' }}
                        >
                          {tui(
                            locale,
                            row.shadeGroups.length === 1
                              ? 'ui.store.shades_count_one'
                              : 'ui.store.shades_count_other',
                            { count: row.shadeGroups.length },
                          )}
                        </span>
                      ) : null}
                    </div>

                    <Qty value={row.onHand} unit={row.unit} tone="secondary" />
                    <Qty value={row.reserved} unit={row.unit} tone="tertiary" />
                    <Qty
                      value={row.free}
                      unit={row.unit}
                      tone={row.overReserved ? 'danger' : 'primary'}
                      strong
                    />
                  </div>
                </div>
              ))}

              <div
                style={{
                  padding: '12px 20px',
                  borderTop: '1px solid var(--fx-border-subtle)',
                  font: "400 13px/1.4 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {tui(locale, 'ui.store.free_formula')}
              </div>
            </div>
          )}
        </section>

        <section>
          <SectionHeading eyebrow={tui(locale, 'ui.store.grns_recent_eyebrow', { count: grns.length })}>
            {tui(locale, 'ui.store.grns_heading')}
          </SectionHeading>

          {grns.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 24,
                font: "400 15px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              {tui(locale, 'ui.store.grns_none')}
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {grns.map((g) => (
                <div
                  key={g.id}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '14px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    flexWrap: 'wrap',
                    minHeight: 'var(--fx-row-height)',
                  }}
                >
                  <Ident size={14}>{g.challanNo}</Ident>
                  <span
                    data-numeric
                    style={{ font: "400 14px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                  >
                    {g.receivedAt}
                  </span>
                  {g.bonded ? (
                    <Badge tone={g.udId ? 'info' : 'danger'}>
                      {tui(
                        locale,
                        g.udId ? 'ui.store.badge_bonded_ud' : 'ui.store.badge_bonded_no_ud',
                      )}
                    </Badge>
                  ) : (
                    <Badge>{tui(locale, 'ui.store.badge_general')}</Badge>
                  )}
                  <Badge tone={g.inspectionStatus === 'passed' ? 'success' : 'neutral'}>
                    {g.inspectionStatus}
                  </Badge>
                  {/* Shows the storekeeper their tablet's record actually landed. */}
                  {g.offlineKey ? (
                    <span
                      style={{
                        marginLeft: 'auto',
                        font: "400 12px/1.3 var(--fx-font-mono)",
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {tui(locale, 'ui.store.entered_on_device')}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </FloorScreen>
  )
}

function Qty({
  value,
  unit,
  tone,
  strong,
}: {
  value: string
  unit: string
  tone: 'primary' | 'secondary' | 'tertiary' | 'danger'
  strong?: boolean
}) {
  return (
    <span
      data-numeric
      data-mono
      style={{
        font: `${strong ? 600 : 400} ${strong ? 17 : 15}px/1.2 var(--fx-font-mono)`,
        color: tone === 'danger' ? 'var(--fx-danger)' : `var(--fx-text-${tone})`,
        textAlign: 'right',
      }}
    >
      {value}
      <span style={{ color: 'var(--fx-text-tertiary)', fontSize: 12, marginLeft: 4 }}>{unit}</span>
    </span>
  )
}
