import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Badge } from '@/components/fx/primitives'
import { StatTile } from '@/components/fx/data'
import { EmptyState } from '@/components/fx/feedback'
import { Ident } from '@/components/fx/format'
import { milestoneLabel } from '@/components/fx/tna'
import { SectionHeading, StatusLabel } from '@/components/fx/signature'
import { AskAboutRow } from '@/components/shell/ask-about-row'
import { PageHeader } from '@/components/shell/page-shell'
import { WorkCue } from '@/components/shell/work-cue'
import { canWrite, NAV } from '@/components/shell/nav'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { env } from '@/lib/env'
import { factoryToday, FACTORY_TIMEZONE } from '@/lib/dates'
import { activeModuleIds } from '@/modules/core/activation'
import { getCtx } from '@/modules/core/session'
import { buyerAccounts } from '@/modules/buyers/queries'
import { lcCoverageForOrders, type LcCoverageRow } from '@/modules/commercial/queries'
import { companyProfile, getPolicy } from '@/modules/settings/service'
import type { BankDocsPolicy } from '@/modules/commercial/service'
import {
  orderBookSummary,
  orderList,
  weekMilestones,
  type OrderHealth,
} from '@/modules/orders/queries'
import { requestLocale } from '@/lib/ui-locale'
import type { Locale } from '@/lib/i18n'
import { tui } from '@/lib/i18n-ui'

import { AskStrip } from './ask-strip'
import { lcConflictBasis } from './lc-tile'
import { NewOrderButton } from './new-order'
import { WeekStrip, weekDays } from './week-strip'

/**
 * 1.3 Order Desk — the book.
 *
 * The selvage carries order health and the status column repeats it in words,
 * because a wall of rows read at arm's length has to survive somebody who does
 * not see the difference between amber and red.
 */
export const dynamic = 'force-dynamic'

const SELVAGE: Record<OrderHealth, 'on-track' | 'at-risk' | 'late' | 'done'> = {
  ok: 'on-track',
  risk: 'at-risk',
  late: 'late',
  done: 'done',
}

const WORD: Record<OrderHealth, string> = {
  ok: 'ui.orders.health_ok',
  risk: 'ui.orders.health_risk',
  late: 'ui.orders.health_late',
  done: 'ui.orders.health_done',
}

/**
 * The order's own status, in words.
 *
 * It was rendered raw, so a desk with a healthy order book printed `shipped_partial` and
 * `in_production` at people — the same defect as the milestone key one line below, found
 * the same way: by looking at a tenant that had actually reached those states. An unmapped
 * status falls through to the identifier rather than to an empty badge, because a missing
 * word should look like one.
 */
const STATUS_WORD: Record<string, string> = {
  confirmed: 'confirmed',
  in_production: 'in production',
  shipped_partial: 'part shipped',
  shipped_full: 'shipped',
  closed: 'closed',
  cancelled: 'cancelled',
}

/**
 * The credit behind a PO, in one cell (design canvas, "Your week").
 *
 * Two facts and no more: which credit, and whether this order's own dates fit inside it.
 * `conflict` means the plan already ships after the date the bank named — documents will
 * be refused for goods that left too late — so it is said in words on the row rather than
 * left to a colour, and it reads before the expiry countdown because it bites first.
 *
 * An order with no credit is not an error. It is an order confirmed before the LC arrived,
 * which is most of them for their first few weeks, and the cell says so plainly instead of
 * showing a dash somebody has to interpret.
 */
function LcCell({ row, locale }: { row: LcCoverageRow | null; locale: Locale }) {
  if (!row) {
    return (
      <span style={{ font: '400 12.5px/1.3 var(--fx-font-sans)', color: 'var(--fx-text-tertiary)' }}>
        {tui(locale, 'ui.orders.lc_none')}
      </span>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
      <span data-mono style={{ font: '400 13px/1.3 var(--fx-font-mono)', color: 'var(--fx-text-secondary)' }}>
        {row.number}
      </span>
      {row.conflict ? (
        <StatusLabel status="late">{tui(locale, 'ui.orders.lc_conflict')}</StatusLabel>
      ) : row.daysToExpiry !== null ? (
        <span style={{ font: '400 12px/1.3 var(--fx-font-mono)', color: 'var(--fx-text-tertiary)' }}>
          {row.daysToExpiry >= 0
            ? tui(locale, 'ui.orders.days', { days: row.daysToExpiry })
            : tui(locale, 'ui.orders.lc_expired', { days: -row.daysToExpiry })}
        </span>
      ) : null}
    </div>
  )
}

export default async function OrdersPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()
  const now = new Date()
  const today = factoryToday()
  const rows = await orderList(ctx, { now })
  const late = rows.filter((r) => r.health === 'late').length
  const risk = rows.filter((r) => r.health === 'risk').length

  // Read through the buyers module's own queries (rule 11), not its tables.
  const profile = await companyProfile(ctx)
  const mayWrite = canWrite(
    NAV.find((n) => n.id === 'orders')!,
    ctx.roles,
    profile?.factoryType ?? 'woven',
  )
  const buyers = mayWrite ? await buyerAccounts(ctx) : []
  // A viewer sees the operation, not the commercial terms (live-test finding, Phase 9).
  const seesPrices = ctx.roles.some((r) => r !== 'viewer' && r !== 'member')

  const cueItems = [
    ...(late > 0 ? [{ label: `${late} late order${late === 1 ? '' : 's'}`, href: '/orders' }] : []),
    ...(risk > 0 ? [{ label: `${risk} at risk`, href: '/orders' }] : []),
  ]

  /*
   * The week, the headline figures, and the credit behind each PO (design canvas,
   * "Your week"). Everything below is a read; the desk gains no new way to write.
   *
   * The LC column exists only where the tenant actually runs `commercial`. An order desk
   * in a factory with the LC register switched off would otherwise carry a column that is
   * empty for a reason nobody on that desk can see — the same rule the workspace tabs
   * follow, asked of the same switchboard.
   */
  const activeModules = await activeModuleIds(ctx)
  const showLc = activeModules.has('commercial')

  const [summary, week, coverage] = await Promise.all([
    orderBookSummary(ctx, { now }),
    weekMilestones(ctx, { from: today, to: weekDays(today, 5)[4]! }),
    showLc
      ? getPolicy<BankDocsPolicy>(ctx, 'commercial').then((policy) =>
          lcCoverageForOrders(ctx, rows.map((row) => row.id), {
            now,
            limitPct: policy.btbLimitPct ?? 75,
          }),
        )
      : Promise.resolve([] as LcCoverageRow[]),
  ])

  // One order can draw on more than one credit. The column shows the one that bites
  // first — a conflict before a clean credit, then the nearest expiry — because a cell
  // showing the healthiest of two credits is a cell that hides the refusal.
  const lcByOrder = new Map<string, LcCoverageRow>()
  for (const row of coverage) {
    const held = lcByOrder.get(row.orderId)
    if (
      !held ||
      (row.conflict && !held.conflict) ||
      (row.conflict === held.conflict &&
        (row.daysToExpiry ?? Infinity) < (held.daysToExpiry ?? Infinity))
    ) {
      lcByOrder.set(row.orderId, row)
    }
  }

  const lcConflicts = [...lcByOrder.values()].filter((row) => row.conflict)

  // One track list, used by the header and every row — they are one table, and two copies
  // of a grid template is how a header stops lining up with the columns beneath it.
  const COLUMNS = showLc
    ? '1.1fr 1fr 1.6fr .8fr .9fr .8fr .9fr .9fr'
    : '1.1fr 1fr 1.6fr .8fr .9fr .8fr .9fr'

  /*
   * Dates and month names turn over with the device, identifiers and money do not (the
   * canvas's Bangla artboard states the rule). `en-GB` here printed "August-এ শিপমেন্ট"
   * on a Bangla desk — the sentence translated and the month inside it did not, which is
   * worse than either language alone.
   */
  const dateLocale = locale === 'bn' ? 'bn-BD' : 'en-GB'

  const monthName = summary.shipping
    ? new Intl.DateTimeFormat(dateLocale, { timeZone: FACTORY_TIMEZONE, month: 'long' }).format(
        new Date(`${summary.shipping.month}-01T00:00:00Z`),
      )
    : null

  const weekOf = new Intl.DateTimeFormat(dateLocale, {
    timeZone: FACTORY_TIMEZONE,
    day: 'numeric',
    month: 'short',
  }).format(new Date(`${today}T00:00:00Z`))

  return (
    <>
      <PageHeader
        eyebrow={tui(locale, 'ui.orders.desk_eyebrow', { date: weekOf })}
        title={rows.length === 0 ? 'No orders yet' : tui(locale, 'ui.orders.desk_title')}
        meta={
          rows.length === 0
            ? undefined
            : [
                tui(
                  locale,
                  summary.openOrders === 1
                    ? 'ui.orders.desk_meta_one'
                    : 'ui.orders.desk_meta_other',
                  { count: summary.openOrders },
                ),
                ...(late > 0 ? [tui(locale, 'ui.orders.desk_meta_late', { count: late })] : []),
              ].join(' · ')
        }
        ownsAmber
        actions={mayWrite ? <NewOrderButton buyers={buyers} /> : undefined}
      />

      <WorkCue items={cueItems} />

      {rows.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28, marginBottom: 32 }}>
          {/*
            * The four figures the desk is asked for before anything else. Each says what
            * it was measured against and when it was measured — a stale number is worse
            * than a missing one, and these are read at 8am against a scan that ran at 5.
            */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              gap: 14,
            }}
          >
            <StatTile
              label={tui(locale, 'ui.orders.tile_book_value')}
              value={
                <span data-numeric data-mono style={{ font: '600 26px/1.1 var(--fx-font-mono)' }}>
                  {!seesPrices
                    ? '•••'
                    : summary.bookValue.length === 0
                      ? '—'
                      : summary.bookValue
                          .map((entry) => `${entry.total} ${entry.currency}`)
                          .join(' · ')}
                </span>
              }
              basis={tui(
                locale,
                summary.openOrders === 1 ? 'ui.orders.desk_meta_one' : 'ui.orders.desk_meta_other',
                { count: summary.openOrders },
              )}
            />
            <StatTile
              label={
                monthName
                  ? tui(locale, 'ui.orders.tile_shipping', { month: monthName })
                  : tui(locale, 'ui.orders.tile_shipping_none')
              }
              value={
                <span data-numeric data-mono style={{ font: '600 26px/1.1 var(--fx-font-mono)' }}>
                  {summary.shipping ? summary.shipping.qty.toLocaleString() : '—'}
                  <span style={{ font: '400 13px/1 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
                    {' '}
                    {tui(locale, 'ui.production.unit_pcs')}
                  </span>
                </span>
              }
              basis={
                summary.shipping && summary.shipping.poNumbers.length > 0
                  ? summary.shipping.poNumbers.slice(0, 2).join(' and ')
                  : tui(locale, 'ui.orders.tile_shipping_undated')
              }
            />
            <StatTile
              label={tui(locale, 'ui.orders.tile_at_risk')}
              value={
                <span data-numeric data-mono style={{ font: '600 26px/1.1 var(--fx-font-mono)' }}>
                  {summary.atRiskMilestones + summary.lateMilestones}
                </span>
              }
              basis={
                summary.lateMilestones > 0
                  ? tui(locale, 'ui.orders.tile_at_risk_late', { count: summary.lateMilestones })
                  : tui(locale, 'ui.orders.tile_at_risk_clear')
              }
              status={
                summary.lateMilestones > 0
                  ? 'late'
                  : summary.atRiskMilestones > 0
                    ? 'at-risk'
                    : 'on-track'
              }
              critical={summary.lateMilestones > 0}
            />
            {showLc ? (
              <StatTile
                label={tui(locale, 'ui.orders.tile_lc')}
                value={
                  <span data-numeric data-mono style={{ font: '600 26px/1.1 var(--fx-font-mono)' }}>
                    {lcConflicts.length}
                  </span>
                }
                basis={lcConflictBasis(
                  [...lcByOrder.values()],
                  (orderId) => rows.find((row) => row.id === orderId)?.poNumbers[0] ?? null,
                  locale,
                )}
                status={lcConflicts.length > 0 ? 'late' : 'on-track'}
                critical={lcConflicts.length > 0}
              />
            ) : null}
          </div>

          {env.MARBIM_ENABLED ? <AskStrip /> : null}

          <section>
            <SectionHeading eyebrow={tui(locale, 'ui.orders.week_eyebrow')}>
              {tui(locale, 'ui.orders.week_title')}
            </SectionHeading>
            <WeekStrip
              days={weekDays(today, 5)}
              milestones={week}
              today={today}
              locale={locale}
            />
          </section>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <EmptyState
          title="The book is empty"
          body="Orders arrive from a buyer PO — drop one on MARBIM and it drafts the order, its TNA and the size breakdown for you to approve. Or open one here and enter it yourself."
          action={
            mayWrite ? (
              <span style={{ font: '400 13px/1.4 var(--fx-font-sans)', color: 'var(--fx-text-tertiary)' }}>
                Use New order above, or check Your work for drafts.
              </span>
            ) : ctx.roles.some((r) => r === 'owner' || r === 'admin' || r === 'merchandiser') ? (
              <Link
                href="/home"
                style={{
                  font: '500 13px/1 var(--fx-font-sans)',
                  color: 'var(--fx-accent-pressed)',
                  textDecoration: 'none',
                }}
              >
                See Your work →
              </Link>
            ) : undefined
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
        <section>
        <SectionHeading eyebrow={tui(locale, 'ui.orders.book_eyebrow')}>
          {tui(locale, 'ui.orders.book_title')}
        </SectionHeading>
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
              gridTemplateColumns: COLUMNS,
              minWidth: showLc ? 900 : 780,
              gap: 14,
              padding: '10px 18px 10px 21px',
              background: 'var(--fx-bg-sunken)',
              font: "500 11px/1 var(--fx-font-mono)",
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            <div>{tui(locale, 'ui.orders.col_po')}</div>
            <div>{tui(locale, 'ui.orders.col_buyer')}</div>
            <div>{tui(locale, 'ui.orders.col_style')}</div>
            <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.orders.col_qty')}</div>
            <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.orders.col_value')}</div>
            <div>{tui(locale, 'ui.orders.col_ex_factory')}</div>
            {showLc ? <div>{tui(locale, 'ui.orders.col_lc')}</div> : null}
            <div style={{ textAlign: 'right' }}>{tui(locale, 'ui.orders.col_status')}</div>
          </div>

          {rows.map((row) => (
            <Link
              key={row.id}
              href={`/orders/${row.id}`}
              className="fx-selvage"
              data-status={SELVAGE[row.health]}
              data-critical={row.health === 'late' || undefined}
              style={{
                borderTop: '1px solid var(--fx-border-subtle)',
                textDecoration: 'none',
                color: 'inherit',
                display: 'flex',
              }}
            >
              <div
                style={{
                  flex: 1,
                                    display: 'grid',
                  gridTemplateColumns: COLUMNS,
                  minWidth: showLc ? 900 : 780,
                  gap: 14,
                  padding: '14px 18px',
                  alignItems: 'center',
                  minHeight: 'var(--fx-row-height)',
                }}
              >
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <Ident>{row.poNumbers[0] ?? '—'}</Ident>
                  {/* The code travels, not the uuid — the resolvers read what the row prints. */}
                  {row.poNumbers[0] ? <AskAboutRow code={row.poNumbers[0]} /> : null}
                </span>
                <span style={{ font: "400 14px/1.3 var(--fx-font-sans)" }}>
                  {row.buyerName ?? '—'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                  <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>
                    {row.styleCode ?? '—'}
                  </span>
                  {row.description ? (
                    <span
                      style={{
                        font: "400 12.5px/1.3 var(--fx-font-sans)",
                        color: 'var(--fx-text-tertiary)',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {row.description}
                    </span>
                  ) : null}
                </div>
                <span
                  data-numeric
                  style={{
                    font: "400 13px/1.3 var(--fx-font-mono)",
                    color: 'var(--fx-text-secondary)',
                    textAlign: 'right',
                  }}
                >
                  {row.contractedQty?.toLocaleString() ?? '—'}
                </span>
                {/* Money renders as the stored decimal string with its currency —
                    never parsed into a float on the way to the screen. */}
                <span
                  data-numeric
                  data-mono
                  style={{
                    font: "400 13px/1.3 var(--fx-font-mono)",
                    color: 'var(--fx-text-secondary)',
                    textAlign: 'right',
                  }}
                >
                  {!seesPrices ? '•••' : row.totalValue ? `${row.totalValue} ${row.currency}` : '—'}
                </span>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  <span
                    data-numeric
                    data-mono
                    style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                  >
                    {row.plannedExFactoryDate ?? '—'}
                  </span>
                  {row.daysToExFactory !== null && row.health !== 'done' ? (
                    <span
                      style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                    >
                      {row.daysToExFactory >= 0
                        ? tui(locale, 'ui.orders.days', { days: row.daysToExFactory })
                        : tui(locale, 'ui.orders.days_over', { days: -row.daysToExFactory })}
                    </span>
                  ) : null}
                </div>
                {showLc ? <LcCell row={lcByOrder.get(row.id) ?? null} locale={locale} /> : null}
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    alignItems: 'flex-end',
                    textAlign: 'right',
                  }}
                >
                  <StatusLabel status={SELVAGE[row.health]}>{tui(locale, WORD[row.health])}</StatusLabel>
                  {row.headline ? (
                    <span
                      style={{
                        font: "400 12px/1.3 var(--fx-font-sans)",
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {milestoneLabel(row.headline, locale)}
                    </span>
                  ) : (
                    <Badge>{STATUS_WORD[row.status] ?? row.status}</Badge>
                  )}
                </div>
              </div>
            </Link>
          ))}
        </div>
        </section>
      )}
      {/* The Desk skin's pocket bar — never for the viewer, whose only capability is this
          page and whose tabs would point at locked doors. */}
      {ctx.roles.some((r) => ['merchandiser', 'commercial', 'owner', 'admin'].includes(r)) ? (
        <FloorTabs
          tabs={[
            { href: '/home', label: 'My work' },
            { href: '/orders', label: 'Orders' },
            { href: '/marbim/intake', label: 'Capture' },
          ]}
        />
      ) : null}
    </>
  )
}
