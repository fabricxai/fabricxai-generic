import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { EmptyState, InlineAlert, LockedState } from '@/components/fx/feedback'
import { Ident } from '@/components/fx/format'
import { PayloadSummary } from '@/components/shell/reading-fields'
import { Badge } from '@/components/fx/primitives'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { canSee, NAV } from '@/components/shell/nav'
import {
  FACTORY_TIMEZONE,
  factoryToday,
  shiftFactoryDate,
  startOfFactoryDay,
  toFactoryDate,
} from '@/lib/dates'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { refusedRows, refusedSummary } from '@/modules/core/offline-sync'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'

/**
 * The reconciliation report (plan 4.5, audit FE-M6).
 *
 * A floor write has three outcomes and only one of them loses work. Applied and duplicate
 * both end with the row in a table. **Refused** ends with it on a tablet, behind a badge and
 * a Dismiss link — and Dismiss deletes it. So a challan counted at the delivery bay and
 * refused for a UD balance existed nowhere the moment somebody tapped the link.
 *
 * The record was always there. `offline_keys` has kept every refusal since the sync endpoint
 * was written — the reason, the module, the operation, the device's own clock — and nothing
 * read it. What was missing is the payload, which is the difference between telling a
 * storekeeper a GRN was lost and letting them enter it again.
 *
 * Read-only, and it stays that way. There is nothing to resolve here: re-entering the work
 * happens on the screen that owns it, and a "mark as handled" button on a record would
 * invite somebody to clear the row instead of doing the work.
 */
export const dynamic = 'force-dynamic'

/** Two weeks. Long enough to cover a tablet that spent a weekend offline, short enough to read. */
const WINDOW_DAYS = 14

export default async function RefusedPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()
  const profile = await companyProfile(ctx)
  const item = NAV.find((n) => n.id === 'refused')!

  if (!canSee(item, ctx.roles, profile?.factoryType ?? 'woven')) {
    return <LockedState what={tui(locale, 'ui.nav.locked_refused')} />
  }

  // Whole factory days, not a rolling 336 hours. A window that starts mid-afternoon on its
  // first day drops half of that day's refusals and nothing says so.
  const since = startOfFactoryDay(shiftFactoryDate(factoryToday(), -(WINDOW_DAYS - 1)))
  const [buckets, rows] = await Promise.all([
    refusedSummary(ctx, { since }),
    refusedRows(ctx, { since }),
  ])

  const total = buckets.reduce((sum, b) => sum + b.refused, 0)

  return (
    <>
      <PageHeader
        eyebrow={tui(locale, 'ui.refused.eyebrow')}
        title={tui(locale, 'ui.refused.title')}
        meta={tui(locale, 'ui.refused.meta', { days: WINDOW_DAYS })}
        ownsAmber={false}
      />

      {total === 0 ? (
        <EmptyState
          title={tui(locale, 'ui.refused.empty_title')}
          body={tui(locale, 'ui.refused.empty_body')}
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
          <InlineAlert tone="warning">{tui(locale, 'ui.refused.why')}</InlineAlert>

          {/* ── Per day, per handler ─────────────────────────────────────── */}
          <section>
            <SectionHeading>{tui(locale, 'ui.refused.col_day')}</SectionHeading>

            {/*
              * Four columns, so it stacks rather than scrolls on a tablet (plan 4.4): each
              * row here is its own grid and every cell says what it is.
              */}
            <Card padding={0}>
              {buckets.map((bucket) => (
                <div
                  key={`${bucket.day}-${bucket.moduleId}-${bucket.operation}`}
                  className="fx-stack-tablet"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '130px minmax(0, 1fr) 110px minmax(0, 1.4fr)',
                    gap: 14,
                    alignItems: 'center',
                    padding: '14px 18px',
                    borderTop: '1px solid var(--fx-border-subtle)',
                  }}
                >
                  <Ident size={13}>{bucket.day}</Ident>

                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <Eyebrow>{tui(locale, 'ui.refused.col_handler')}</Eyebrow>
                    <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>
                      {bucket.moduleId} · {bucket.operation.replace(/_/g, ' ')}
                    </span>
                  </span>

                  <span>
                    <Badge tone="danger">
                      {tui(
                        locale,
                        bucket.refused === 1 ? 'ui.refused.count_one' : 'ui.refused.count_other',
                        { count: bucket.refused },
                      )}
                    </Badge>
                  </span>

                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                    <Eyebrow>{tui(locale, 'ui.refused.col_reasons')}</Eyebrow>
                    {/*
                      * The reason KEY, not a translated sentence.
                      *
                      * These are thrown by fifteen modules and the catalogue answers them
                      * one at a time; rendering a key that has no copy would put a dotted
                      * identifier in front of somebody. The full sentence is on the row
                      * below, where there is space for it — here it is the grouping.
                      */}
                    <span
                      style={{
                        font: "400 12px/1.4 var(--fx-font-mono)",
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {bucket.reasons.join(' · ')}
                    </span>
                  </span>
                </div>
              ))}
            </Card>
          </section>

          {/* ── Every row, with what was on it ───────────────────────────── */}
          <section>
            <SectionHeading>{tui(locale, 'ui.refused.detail_heading')}</SectionHeading>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {rows.map((row) => (
                <Card key={row.offlineKey}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'baseline',
                        gap: 12,
                        flexWrap: 'wrap',
                      }}
                    >
                      <span style={{ font: "600 14px/1.3 var(--fx-font-sans)" }}>
                        {row.moduleId} · {row.operation.replace(/_/g, ' ')}
                      </span>
                      {/*
                        * Both clocks. They can be days apart — a tablet that spent a
                        * weekend offline captured on Friday and was refused on Monday — and
                        * showing one would file the lost work against the wrong day.
                        */}
                      <span
                        style={{
                          font: "400 12px/1.3 var(--fx-font-mono)",
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {row.capturedAt
                          ? tui(locale, 'ui.refused.captured', {
                              when: toFactoryDate(row.capturedAt, FACTORY_TIMEZONE),
                            })
                          : tui(locale, 'ui.refused.captured_unknown')}
                        {' · '}
                        {tui(locale, 'ui.refused.refused_at', {
                          when: toFactoryDate(row.refusedAt, FACTORY_TIMEZONE),
                        })}
                      </span>
                    </div>

                    <div
                      style={{
                        font: "400 13.5px/1.5 var(--fx-font-sans)",
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {reasonOf(row.error) ?? tui(locale, 'ui.refused.reason_unknown')}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                      <Eyebrow>{tui(locale, 'ui.refused.payload_heading')}</Eyebrow>
                      {row.payload ? (
                        <span
                          className="fx-scroll-x"
                          // Focusable, or a keyboard cannot scroll it (WCAG 2.1.1).
                          tabIndex={0}
                          style={{
                            display: 'block',
                            padding: '10px 12px',
                            background: 'var(--fx-bg-sunken)',
                            border: '1px solid var(--fx-border-subtle)',
                            borderRadius: 'var(--fx-radius-sm)',
                          }}
                        >
                          {/* Was `JSON.stringify(payload, null, 2)` in a <pre>. This page
                              exists so somebody can see WHY their write was refused, and a
                              raw object is that reason written in a language they do not
                              read. */}
                          <PayloadSummary payload={row.payload as Record<string, unknown>} />
                        </span>
                      ) : (
                        <span
                          style={{
                            font: "400 12.5px/1.4 var(--fx-font-sans)",
                            color: 'var(--fx-text-tertiary)',
                          }}
                        >
                          {tui(locale, 'ui.refused.payload_missing')}
                        </span>
                      )}
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  )
}

/**
 * The sentence the module threw, if it left one.
 *
 * `AppError.toJSON()` carries `message` — the human line — beside `messageKey`. Preferred
 * over resolving the key here, because the catalogue is still English-only for most desk
 * refusals and a missing key renders as itself: a dotted identifier where an explanation
 * belongs. Reading the stored message shows what the operator's own device showed.
 */
function reasonOf(error: Record<string, unknown> | null): string | null {
  if (!error) return null
  const message = error.message
  if (typeof message === 'string' && message.trim()) return message
  const key = error.messageKey
  return typeof key === 'string' ? key : null
}
