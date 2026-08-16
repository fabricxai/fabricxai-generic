import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { Badge } from '@/components/fx/primitives'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import type { Locale } from '@/lib/i18n'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { cuttableOrders, recentLays } from '@/modules/cutting/queries'

import { RaisedDrafts } from '@/components/shell/raised-drafts'

import { ReleaseMarkerButton } from './release-marker'

/**
 * 5.1 Cutting.
 *
 * Two gates guard spreading a lay, both server-side and both failing CLOSED:
 * the buyer's PP sample must be approved, and fabric must actually have been
 * issued to this order. Cutting before PP approval is how a factory makes
 * eighty thousand garments to a spec the buyer then rejects, with the fabric
 * already cut — so the gate blocks visibly and says which precondition failed.
 */
export const dynamic = 'force-dynamic'

export default async function CuttingPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const [lays, orders] = await Promise.all([recentLays(ctx), cuttableOrders(ctx)])

  // The styles the floor could be asked to cut, so the marker form can offer them rather
  // than making somebody retype a code a lay will later match on exactly.
  const styles = [...new Set(orders.map((o) => o.styleCode).filter(Boolean))].sort()

  // `lay_status` is open | cut | cancelled — there is no "closed", so the old
  // `!== 'closed'` test excluded nothing and counted every cut and cancelled lay as still
  // on the table. A cutting floor reads this number to decide whether there is space to
  // spread, and it was answering "three in progress" at an empty table.
  const open = lays.filter((l) => l.status === 'open').length
  const unreported = lays.filter((l) => l.reportedPieces === null).length

  return (
    <FloorScreen>
      <PageHeader
        eyebrow={tui(locale, 'ui.cutting.eyebrow')}
        title={
          lays.length === 0
            ? tui(locale, 'ui.cutting.overview_empty_title')
            : tui(locale, open === 1 ? 'ui.cutting.lays_open_one' : 'ui.cutting.lays_open_other', {
                count: open,
              })
        }
        meta={
          unreported > 0 ? tui(locale, 'ui.cutting.unreported_meta', { count: unreported }) : undefined
        }
        ownsAmber
        /* The door 5.1 never had. It sits here rather than only on the lay screen because
           a marker is released once per style, ahead of the spread — the moment somebody
           has the CAD plan in front of them, not the moment the table is waiting. */
        actions={<ReleaseMarkerButton styles={styles} />}
      />

      <RaisedDrafts />

      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(
          [
            { href: '/cutting/lay', labelKey: 'ui.cutting.nav_start_lay' },
            { href: '/cutting/report', labelKey: 'ui.cutting.nav_cut_report' },
            { href: '/cutting/wastage', labelKey: 'ui.cutting.nav_wastage' },
          ] as const
        ).map(({ href, labelKey }) => (
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
            {tui(locale, labelKey)}
          </Link>
        ))}
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        <Card padding="18px 22px">
          <Eyebrow>{tui(locale, 'ui.cutting.prereq_eyebrow')}</Eyebrow>
          <div
            style={{
              display: 'flex',
              gap: 28,
              flexWrap: 'wrap',
              marginTop: 12,
              font: "400 15px/1.55 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
            }}
          >
            <span>
              <strong style={{ color: 'var(--fx-text-primary)' }}>
                {tui(locale, 'ui.cutting.prereq_pp_title')}
              </strong>{' '}
              {tui(locale, 'ui.cutting.prereq_pp_body')}
            </span>
            <span>
              <strong style={{ color: 'var(--fx-text-primary)' }}>
                {tui(locale, 'ui.cutting.prereq_fabric_title')}
              </strong>{' '}
              {tui(locale, 'ui.cutting.prereq_fabric_body')}
            </span>
          </div>
          {/* Both are checked on the server when the lay is created; neither is
              a disabled button, because a disabled button explains nothing. */}
          <div
            style={{
              marginTop: 12,
              font: "400 13px/1.5 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {tui(locale, 'ui.cutting.prereq_note')}
          </div>
        </Card>

        <section>
          <SectionHeading eyebrow={tui(locale, 'ui.cutting.ready_eyebrow', { count: orders.length })}>
            {tui(locale, 'ui.cutting.ready_heading')}
          </SectionHeading>
          {orders.length === 0 ? (
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
              {tui(locale, 'ui.cutting.ready_none')}
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {orders.map((o) => (
                // The card IS the action: a cutter tapping the order they are about to
                // spread is the whole navigation, and a separate "start a lay" button
                // elsewhere would be one more thing to find on a tablet.
                <Link
                  key={o.orderStyleId}
                  href={`/cutting/lay?order=${o.orderId}`}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '14px 18px',
                    minWidth: 180,
                    minHeight: 44,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <Ident size={14}>{o.poNumber ?? '—'}</Ident>
                  <span style={{ font: "600 16px/1.3 var(--fx-font-sans)" }}>{o.styleCode}</span>
                  <span
                    style={{
                      font: "400 12px/1.3 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {tui(locale, 'ui.cutting.start_lay_arrow')}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeading>{tui(locale, 'ui.cutting.lays_heading')}</SectionHeading>

          {lays.length === 0 ? (
            <EmptyState
              title={tui(locale, 'ui.cutting.lays_empty_title')}
              body={tui(locale, 'ui.cutting.lays_empty_body')}
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
                  gridTemplateColumns: '1fr 1fr 1fr .7fr .9fr .9fr .9fr',
                  minWidth: 780,
                  gap: 12,
                  padding: '12px 20px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 12px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>{tui(locale, 'ui.cutting.col_lay')}</div>
                <div>{tui(locale, 'ui.cutting.col_order')}</div>
                <div>{tui(locale, 'ui.cutting.col_colour')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.cutting.col_plies')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.cutting.col_fabric')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.cutting.col_cut')}</div>
                <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.cutting.col_status')}</div>
              </div>

              {lays.map((lay) => (
                <div
                  key={lay.id}
                  className="fx-selvage"
                  // Same phantom status as the header count had: `lay_status` is
                  // open | cut | cancelled. A cut lay is finished work and reads as done;
                  // one still open with no report is the one somebody has to chase.
                  data-status={
                    lay.status === 'cancelled'
                      ? 'done'
                      : lay.reportedPieces === null
                        ? 'at-risk'
                        : 'done'
                  }
                  style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
                >
                  <div
                    style={{
                      flex: 1,
                      display: 'grid',
                      gridTemplateColumns: '1fr 1fr 1fr .7fr .9fr .9fr .9fr',
                      minWidth: 780,
                      gap: 12,
                      padding: '14px 20px',
                      alignItems: 'center',
                      minHeight: 'var(--fx-row-height)',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <Ident size={14}>{lay.layNo}</Ident>
                      {lay.offlineKey ? (
                        <span
                          style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                        >
                          {tui(locale, 'ui.cutting.from_a_device')}
                        </span>
                      ) : null}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                      <span style={{ font: "500 15px/1.3 var(--fx-font-sans)" }}>
                        {lay.poNumber ?? '—'}
                      </span>
                      <span
                        style={{ font: "400 13px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
                      >
                        {lay.styleCode ?? '—'}
                      </span>
                    </div>

                    <span style={{ font: "500 15px/1.3 var(--fx-font-sans)" }}>{lay.color}</span>

                    <span
                      data-numeric
                      style={{ font: "400 15px/1.2 var(--fx-font-mono)", textAlign: 'right' }}
                    >
                      {lay.plies}
                    </span>

                    <span
                      data-numeric
                      data-mono
                      style={{
                        font: "400 14px/1.2 var(--fx-font-mono)",
                        textAlign: 'right',
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {lay.fabricDrawnMeters ?? '—'}
                      <span style={{ color: 'var(--fx-text-tertiary)', fontSize: 12, marginLeft: 4 }}>
                        {tui(locale, 'ui.cutting.unit_meters')}
                      </span>
                    </span>

                    {/* Unreported is not zero: the lay is spread and nobody has
                        yet said how many pieces came off it. */}
                    <span
                      data-numeric
                      style={{
                        font: "600 16px/1.2 var(--fx-font-mono)",
                        textAlign: 'right',
                        color:
                          lay.reportedPieces === null
                            ? 'var(--fx-text-tertiary)'
                            : 'var(--fx-text-primary)',
                      }}
                    >
                      {lay.reportedPieces === null
                        ? tui(locale, 'ui.cutting.not_reported')
                        : lay.reportedPieces}
                    </span>

                    <span style={{ textAlign: 'right' }}>
                      {/* The same phantom status as the count above: `closed` is not in
                          `lay_status` (open | cut | cancelled), so this compared against a
                          value that can never appear and every finished lay wore the
                          neutral badge of one still on the table. `cut` is the success
                          state — the bundles exist and the table is free. */}
                      <Badge tone={lay.status === 'cut' ? 'success' : 'neutral'}>
                        {layStatus(locale, lay.status)}
                      </Badge>
                    </span>
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
                {tui(locale, 'ui.cutting.bundles_note')}
              </div>
            </div>
          )}
        </section>
      </div>
      <FloorTabs
        tabs={[
          { href: '/cutting', label: 'Queue' },
          { href: '/cutting/lay', label: 'Lay' },
          { href: '/cutting/report', label: 'Report' },
        ]}
      />
    </FloorScreen>
  )
}

/**
 * The three values of `lay_status`, as words rather than as column values.
 *
 * `LayRow.status` is a plain string, so a fourth value added to the enum without touching
 * this screen renders raw instead of as a missing key — wrong-looking, but readable, which
 * on a floor tablet is the safer failure.
 */
const LAY_STATUS_COPY: Record<string, string> = {
  open: 'ui.cutting.status_open',
  cut: 'ui.cutting.status_cut',
  cancelled: 'ui.cutting.status_cancelled',
}

function layStatus(locale: Locale, status: string): string {
  const key = LAY_STATUS_COPY[status]
  return key ? tui(locale, key) : status
}
