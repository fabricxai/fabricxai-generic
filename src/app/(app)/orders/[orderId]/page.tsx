import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { Badge } from '@/components/fx/primitives'
import { FinalReadinessStrip } from '@/components/fx/final-readiness'
import { RunRateCard } from '@/components/fx/run-rate'
import { SectionHeading } from '@/components/fx/signature'
import { FactPair } from '@/components/fx/tna'
import { PageHeader } from '@/components/shell/page-shell'
import { canSee, canWrite, NAV } from '@/components/shell/nav'
import { requestLocale } from '@/lib/ui-locale'
import { activeModuleIds } from '@/modules/core/activation'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'
import { lcCoverageForOrders, type LcCoverageRow } from '@/modules/commercial/queries'
import type { BankDocsPolicy } from '@/modules/commercial/service'
import { orderDetail, orderFileRefs, orderTimeline, tnaTemplateChoices } from '@/modules/orders/queries'
import { orderPulse, orderStatusMachine, type OrderStatus } from '@/modules/orders/service'
import { orderRunRate } from '@/modules/production/queries'
import { preFinalReadiness, type QualityPolicy } from '@/modules/quality/service'
import { checkPpApprovalFor } from '@/modules/sampling/service'
import { getPolicy } from '@/modules/settings/service'
import { shipmentBoard } from '@/modules/shipment/queries'
import { factoryToday, FACTORY_TIMEZONE } from '@/lib/dates'

import { OrderBreakdown } from './breakdown-client'
import { LcCard } from './lc-card'
import { OrderDocuments } from './documents'
import { PulseStrip } from './pulse-strip'
import { OrderStatusControl } from './status-control'
import { OrderTimeline } from './timeline'
import { OrderTna } from './tna-client'
import { WorkspaceTabs, type WorkspaceTab } from './workspace-tabs'

/**
 * 1.3 Order Desk — one order.
 *
 * The TNA and the breakdown are the two things a merchandiser opens this screen
 * for, so both are on the page rather than behind tabs. What IS behind a tab is
 * everything that belongs to another module — the LC, the documents — because
 * those are read across a boundary and owned elsewhere.
 */
export const dynamic = 'force-dynamic'

export default async function OrderDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ orderId: string }>
  searchParams: Promise<{ tab?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const { orderId } = await params
  const order = await orderDetail(ctx, orderId)
  if (!order) notFound()

  // The same decision the shell's read-only banner makes, asked here so the timeline is
  // given no hand to move it with rather than offering a button that a role check refuses.
  const profile = await companyProfile(ctx)
  const factoryType = profile?.factoryType ?? 'woven'
  const mayWrite = canWrite(NAV.find((n) => n.id === 'orders')!, ctx.roles, factoryType)

  /*
   * Which tabs exist: module activation ∩ role permission (spec §2).
   *
   * Both answers come from where they already live — `activeModuleIds` is the tenant's
   * switchboard and `canSee` is the nav's own audience rule, the same one the sidebar
   * and MARBIM's tool scope read. A second list here would be a third truth about who
   * may see a department's numbers, and the one that drifted would be this one.
   *
   * Tabs are (nav id → module id) because a tab is a WINDOW onto another module: the
   * production tab shows what `lines` shows, gated by whether `production` runs here.
   */
  const activeModules = await activeModuleIds(ctx)
  const tabAllowed = (navId: string, moduleId: string): boolean => {
    const item = NAV.find((n) => n.id === navId)
    return Boolean(item) && activeModules.has(moduleId) && canSee(item!, ctx.roles, factoryType)
  }

  const locale = await requestLocale(profile?.locale)

  /*
   * A viewer sees the operation, not the commercial terms (live-test finding, Phase 9:
   * the redaction the role promises existed nowhere). Redacted server-side, so the price
   * never reaches the browser — a ••• painted over a value in the payload is not hiding.
   */
  const seesPrices = ctx.roles.some((r) => r !== 'viewer' && r !== 'member')

  const po = order.poNumbers[0] ?? order.id.slice(0, 8)
  const late = order.milestones.filter((m) => m.status === 'late').length
  const today = factoryToday()

  const showProduction = tabAllowed('lines', 'production')
  const showShipping = tabAllowed('shipment', 'shipment')

  const files = await orderFileRefs(ctx, order.id)

  const TABS: WorkspaceTab[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'timeline', label: 'Timeline' },
    ...(files.length > 0
      ? [{ id: 'documents', label: 'Documents', hint: String(files.length) }]
      : [{ id: 'documents', label: 'Documents' }]),
    ...(showProduction ? [{ id: 'production', label: 'Production' }] : []),
    ...(showShipping ? [{ id: 'shipping', label: 'Shipping' }] : []),
  ]

  // A tab a caller cannot see falls back to Overview rather than 404ing: the link may
  // have been pasted by somebody whose roles differ, and an order they CAN read should
  // still open.
  const requested = (await searchParams).tab ?? 'overview'
  const tab = TABS.some((t) => t.id === requested) ? requested : 'overview'

  /*
   * The pulse (spec §2), assembled through each owner's read surface — sampling answers
   * its own gate, the shipment board its own numbers — and decided by a pure function.
   * Read on every tab: the strip is the reason the workspace exists, and hiding it
   * behind Overview would mean the blocker vanishes exactly when somebody goes looking
   * at the department it blocks.
   */
  const ppGate = order.style
    ? await checkPpApprovalFor(ctx, { orderId: order.id, orderStyleId: order.style.id })
    : null
  const shipRows = showShipping
    ? (await shipmentBoard(ctx)).filter((row) => row.orderId === order.id)
    : []

  /*
   * The credits covering this order (design canvas, order page). Read through
   * commercial's own query — the LC belongs to that module and this screen is a window
   * onto it (rule 11), which is also why the card offers no way to change one.
   *
   * The plan-level conflict reaches the strip as a fact: ex-factory falling after the
   * credit's latest shipment is a refusal already written into the schedule, and it was
   * previously discovered by the bank because no screen put the two dates together.
   */
  const showLc = activeModules.has('commercial')
  const lcRows: LcCoverageRow[] = showLc
    ? await lcCoverageForOrders(ctx, [order.id], {
        now: new Date(),
        limitPct: (await getPolicy<BankDocsPolicy>(ctx, 'commercial')).btbLimitPct ?? 75,
      })
    : []

  const pulse = orderPulse({
    status: order.status as OrderStatus,
    today,
    milestones: order.milestones,
    ppGate,
    shipments: shipRows,
    lcs: lcRows.map((lc) => ({
      number: lc.number,
      floatDays: lc.floatDays,
      daysToExpiry: lc.daysToExpiry,
    })),
  })

  // The run rate is only meaningful once there is a quantity to burn down against. An order
  // with no contracted quantity is still being negotiated, and a card that reads "completes
  // never" on it is noise on a screen a merchandiser lives in.
  const contractedQty = order.style?.contractedQty ?? null
  const forecast =
    contractedQty && tab === 'production'
      ? await orderRunRate(ctx, {
          orderId: order.id,
          contractedQty,
          asOf: today,
          milestoneDate:
            order.milestones.find((m) => m.name === 'sewing_end')?.plannedDate ?? null,
        })
      : null

  /*
   * Will this order fail its final? (adoption plan 5.2). `preFinalReadiness` reached only a
   * MARBIM tool — a question neither the merchandiser nor the QC desk knew to ask. Read for
   * THIS order out of the window's list; null when its final is outside the horizon.
   */
  const qualityPolicy = await getPolicy<QualityPolicy>(ctx, 'quality')
  const readiness =
    (await preFinalReadiness(ctx, { today, windowDays: 21 }, qualityPolicy)).find(
      (row) => row.orderId === order.id,
    ) ?? null

  // Only the tab being rendered pays for its own read — the point of server tabs.
  const events = tab === 'timeline' ? await orderTimeline(ctx, order.id) : []

  return (
    <>
      <PageHeader
        back={{ href: '/orders', label: 'Order desk' }}
        eyebrow={order.buyerName ?? 'Order'}
        title={po}
        meta={order.plannedExFactoryDate ? `ship ${order.plannedExFactoryDate}` : undefined}
        // The header thread rule IS this view's amber moment, so nothing below
        // it takes an amber fill.
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
        {/* The strip, then the tabs — what the order needs before where to look. */}
        <PulseStrip pulse={pulse} locale={locale} />

        <WorkspaceTabs tabs={TABS} active={tab} basePath={`/orders/${order.id}`} />

        {tab === 'timeline' ? <OrderTimeline events={events} /> : null}
        {tab === 'documents' ? <OrderDocuments files={files} /> : null}

        {tab === 'production' ? (
          forecast ? (
            <section>
              <SectionHeading eyebrow="read-only · a window into the sewing floor">
                Where production has got to
              </SectionHeading>
              <RunRateCard forecast={forecast} />
            </section>
          ) : (
            <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
              Nothing has been sewn against this order yet, or it has no contracted quantity
              to burn down against.
            </p>
          )
        ) : null}

        {tab === 'shipping' ? (
          shipRows.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {shipRows.map((row) => (
                <div
                  key={row.id}
                  style={{
                    display: 'flex',
                    gap: 14,
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    padding: '13px 18px',
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                  }}
                >
                  <Badge>partial {row.partialNo}</Badge>
                  <Badge tone={row.expNumber ? 'success' : 'danger'}>
                    {row.expNumber ? `EXP ${row.expNumber}` : 'no EXP'}
                  </Badge>
                  <span data-mono style={{ font: '400 13px/1.4 var(--fx-font-mono)' }}>
                    {row.actualExFactory ?? row.plannedExFactory ?? '—'}
                  </span>
                  {/* The blockers the board already computes — one list, not a second
                      opinion about what stops a bank submission. */}
                  <span
                    style={{
                      font: '400 13px/1.4 var(--fx-font-sans)',
                      color: row.blockers.length > 0 ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
                    }}
                  >
                    {row.blockers.length > 0 ? row.blockers.join(' · ') : 'ready for the bank'}
                  </span>
                </div>
              ))}
            </div>
          ) : (
            <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
              No shipment has been raised against this order yet.
            </p>
          )
        ) : null}

        {tab !== 'overview' ? null : (
        <>
        <FinalReadinessStrip readiness={readiness} />

        <Card>
          <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
            <FactPair label="Style">
              {order.style?.styleCode ?? '—'}
              {order.style?.description ? (
                <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>
                  {' '}
                  · {order.style.description}
                </span>
              ) : null}
            </FactPair>
            <FactPair label="Contracted">
              <span data-numeric>{order.style?.contractedQty?.toLocaleString() ?? '—'} pcs</span>
            </FactPair>
            <FactPair label="Unit price">
              <span data-numeric data-mono>
                {!seesPrices
                  ? '•••'
                  : order.style?.unitPrice
                    ? `${order.style.unitPrice} ${order.style.currency}`
                    : '—'}
              </span>
            </FactPair>
            <FactPair label="Order value">
              <span data-numeric data-mono>
                {!seesPrices ? '•••' : order.totalValue ? `${order.totalValue} ${order.currency}` : '—'}
              </span>
            </FactPair>
            <FactPair label="Status">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <Badge tone={late > 0 ? 'danger' : 'neutral'}>{order.status}</Badge>
                {mayWrite ? (
                  <OrderStatusControl
                    orderId={order.id}
                    nextStatuses={orderStatusMachine.next(order.status as OrderStatus)}
                  />
                ) : null}
              </span>
            </FactPair>
          </div>
        </Card>

        {showLc ? (
          <LcCard
            rows={lcRows}
            plannedExFactoryDate={order.plannedExFactoryDate}
            seesPrices={seesPrices}
          />
        ) : null}

        <section>
          <SectionHeading eyebrow={late > 0 ? `${late} late` : undefined}>
            Time and action
          </SectionHeading>
          <OrderTna
            orderId={order.id}
            milestones={order.milestones}
            canWrite={mayWrite}
            /* Only fetched when the schedule is empty — the generate control is for the
               order that has none, and the picker's options are the same active templates
               the rfq.won consumer chooses from. */
            templates={order.milestones.length === 0 ? await tnaTemplateChoices(ctx) : []}
            defaultExFactory={order.plannedExFactoryDate}
          />
        </section>

        <section>
          <SectionHeading
            eyebrow={order.style ? `revision ${order.style.activeRevision}` : undefined}
          >
            Size breakdown
          </SectionHeading>
          <OrderBreakdown
            cells={order.breakdown}
            orderStyleId={order.style?.id ?? null}
            contractedQty={order.style?.contractedQty}
            tolerancePct={order.qtyTolerancePct}
            canWrite={mayWrite}
          />
        </section>

        {/*
          * The evidence, finally on a screen. Every revision has written a cell-level
          * before/after with its reason and author since the module shipped — the row
          * that answers "the buyer says they never asked for that" — and nothing read
          * it until a live tester approved an amendment and asked where the change
          * went. Newest first: the question is always about the latest one.
          */}
        {order.revisions.length > 0 ? (
          <section>
            <SectionHeading eyebrow="who changed the grid, and why">
              Revision history
            </SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {order.revisions.map((rev) => (
                <div
                  key={rev.revision}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 6,
                    padding: '12px 18px',
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                  }}
                >
                  <div
                    style={{
                      display: 'flex',
                      gap: 12,
                      flexWrap: 'wrap',
                      alignItems: 'baseline',
                      justifyContent: 'space-between',
                    }}
                  >
                    <span style={{ font: "500 13px/1.4 var(--fx-font-sans)" }}>
                      <Badge tone={rev.revision === order.style?.activeRevision ? 'success' : 'neutral'}>
                        rev {rev.revision}
                      </Badge>{' '}
                      {rev.reason ?? ''}
                    </span>
                    <span
                      style={{
                        font: "400 12px/1.4 var(--fx-font-mono)",
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {rev.byName ?? 'someone who has left'} ·{' '}
                      {new Intl.DateTimeFormat('en-GB', {
                        timeZone: FACTORY_TIMEZONE,
                        day: '2-digit',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                      }).format(rev.at)}
                    </span>
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      gap: 14,
                      flexWrap: 'wrap',
                      font: "400 12.5px/1.5 var(--fx-font-mono)",
                      color: 'var(--fx-text-secondary)',
                    }}
                  >
                    {rev.cells.map((cell) => (
                      <span key={cell.key}>
                        {cell.key}{' '}
                        {cell.from === null
                          ? `new · ${cell.to?.toLocaleString()}`
                          : cell.to === null
                            ? `${cell.from.toLocaleString()} → removed`
                            : `${cell.from.toLocaleString()} → ${cell.to.toLocaleString()}`}
                      </span>
                    ))}
                    {rev.totalBefore !== null &&
                    rev.totalAfter !== null &&
                    rev.totalBefore !== rev.totalAfter ? (
                      <span style={{ color: 'var(--fx-warning)' }}>
                        total {rev.totalBefore.toLocaleString()} → {rev.totalAfter.toLocaleString()}
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        </>
        )}
      </div>
    </>
  )
}
