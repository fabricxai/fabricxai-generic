import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderList } from '@/modules/orders/queries'
import { lines } from '@/modules/planning/schema'
import type { ProductionPolicy } from '@/modules/production/service'
import { getPolicy } from '@/modules/settings/service'
import { board } from '@/modules/production/queries'

import { LineBoard } from './board-client'
import { PlanDayButton } from './plan-day'
import { factoryToday } from '@/lib/dates'

/**
 * 6.1 Line Tracking ⚡.
 *
 * A floor screen: 56px rows, ≥48px targets, and every write goes through the
 * offline queue rather than straight to the server. A supervisor on a tablet
 * behind a concrete wall must never be blocked by a network they cannot fix.
 */
export const dynamic = 'force-dynamic'

/** A normal Bangladeshi sewing shift: 8 hours plus two of overtime. */
const SHIFT_HOURS = 10

export default async function LinesPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const today = factoryToday()
  // `activeLines(ctx)` used to be fetched here and passed to LineBoard, which consumed it
  // in a `{lines.length === 0 ? null : null}` left from an earlier draft — so it was a
  // database round trip on every load of a floor screen, feeding nothing. The header's
  // count comes from `rows`, which is the board itself.
  const [allRows, policy, allLineRows, orderRows] = await Promise.all([
    board(ctx, { producedOn: today, shiftHours: SHIFT_HOURS }),
    getPolicy<ProductionPolicy>(ctx, 'production'),
    // The plan-the-day door's choices (live-test finding: daily_line_plans had no
    // origin outside the seed). Orders read via the owner's queries, rule 11.
    withTenantRead(ctx, (tx) =>
      tx
        .select({ id: lines.id, code: lines.code })
        .from(lines)
        .where(eq(lines.isActive, true))
        .orderBy(lines.code),
    ),
    orderList(ctx),
  ])

  // The caller's line narrowing, honoured (live-test finding: a chief scoped to L1/L2
  // saw all eight). Scope comes from the session, never the client.
  const rows = ctx.lineScope
    ? allRows.filter((row) => ctx.lineScope!.includes(row.code))
    : allRows
  const lineRows = ctx.lineScope
    ? allLineRows.filter((row) => ctx.lineScope!.includes(row.code))
    : allLineRows

  // Behind means MATERIALLY behind, against the company's own threshold.
  //
  // This used to be `variance < 0` — any shortfall at all. A sewing line finishes a few
  // pieces under target most days, so every line was flagged: the header read "6 behind
  // target" on a floor where one line was stopped and one was quietly at 82%, and the two
  // that mattered were indistinguishable from the four that did not.
  const threshold = Number(policy.behindTargetPct ?? '95')
  const behind = rows.filter(
    (r) => r.target > 0 && (r.actual / r.target) * 100 < threshold,
  ).length

  return (
    <>
      <PageHeader
        eyebrow={tui(locale, 'ui.production.lines_eyebrow', { date: today })}
        title={
          rows.length === 0
            ? tui(locale, 'ui.production.no_lines_title')
            : tui(
                locale,
                rows.length === 1
                  ? 'ui.production.lines_count_one'
                  : 'ui.production.lines_count_other',
                { count: rows.length },
              )
        }
        meta={
          behind > 0 ? tui(locale, 'ui.production.behind_target_meta', { count: behind }) : undefined
        }
        ownsAmber={false}
        actions={
          <PlanDayButton
            lines={lineRows}
            orders={orderRows
              .filter((row) => !['shipped_full', 'closed', 'cancelled'].includes(row.status))
              .map((row) => ({
                id: row.id,
                label: `${row.poNumbers[0] ?? row.id.slice(0, 8)} · ${row.styleCode ?? ''}`,
              }))}
          />
        }
      />

      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
        <Link
          href="/lines/endline"
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
          {tui(locale, 'ui.production.nav_endline')}
        </Link>
        <Link
          href="/lines/hourly"
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
          {tui(locale, 'ui.production.nav_hourly')}
        </Link>
        {/* Opens outside the app shell — the wall board has no navigation, so the only way
            back is the browser. A new tab is the honest affordance, and it is also how this
            gets left running on the pillar screen. */}
        <a
          href="/board"
          target="_blank"
          rel="noreferrer"
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
          {tui(locale, 'ui.production.nav_wall_board')}
        </a>
      </nav>

      {rows.length === 0 ? (
        <EmptyState
          title={tui(locale, 'ui.production.lines_empty_title')}
          body={tui(locale, 'ui.production.lines_empty_body')}
        />
      ) : (
        <LineBoard rows={rows} producedOn={today} shiftHours={SHIFT_HOURS} />
      )}
    </>
  )
}
