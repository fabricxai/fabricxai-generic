import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { Badge } from '@/components/fx/primitives'
import { RunRateCard } from '@/components/fx/run-rate'
import { SectionHeading } from '@/components/fx/signature'
import { FactPair } from '@/components/fx/tna'
import { PageHeader } from '@/components/shell/page-shell'
import { canWrite, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'
import { orderDetail, tnaTemplateChoices } from '@/modules/orders/queries'
import { orderStatusMachine, type OrderStatus } from '@/modules/orders/service'
import { orderRunRate } from '@/modules/production/queries'
import { factoryToday, FACTORY_TIMEZONE } from '@/lib/dates'

import { OrderBreakdown } from './breakdown-client'
import { OrderStatusControl } from './status-control'
import { OrderTna } from './tna-client'

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
}: {
  params: Promise<{ orderId: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const { orderId } = await params
  const order = await orderDetail(ctx, orderId)
  if (!order) notFound()

  // The same decision the shell's read-only banner makes, asked here so the timeline is
  // given no hand to move it with rather than offering a button that a role check refuses.
  const profile = await companyProfile(ctx)
  const mayWrite = canWrite(
    NAV.find((n) => n.id === 'orders')!,
    ctx.roles,
    profile?.factoryType ?? 'woven',
  )

  const po = order.poNumbers[0] ?? order.id.slice(0, 8)
  const late = order.milestones.filter((m) => m.status === 'late').length

  // The run rate is only meaningful once there is a quantity to burn down against. An order
  // with no contracted quantity is still being negotiated, and a card that reads "completes
  // never" on it is noise on a screen a merchandiser lives in.
  const contractedQty = order.style?.contractedQty ?? null
  const forecast = contractedQty
    ? await orderRunRate(ctx, {
        orderId: order.id,
        contractedQty,
        asOf: factoryToday(),
        milestoneDate:
          order.milestones.find((m) => m.name === 'sewing_end')?.plannedDate ?? null,
      })
    : null

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
                {order.style?.unitPrice
                  ? `${order.style.unitPrice} ${order.style.currency}`
                  : '—'}
              </span>
            </FactPair>
            <FactPair label="Order value">
              <span data-numeric data-mono>
                {order.totalValue ? `${order.totalValue} ${order.currency}` : '—'}
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

        {forecast ? (
          <section>
            <SectionHeading eyebrow="read-only · a window into the sewing floor">
              Where production has got to
            </SectionHeading>
            <RunRateCard forecast={forecast} />
          </section>
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
      </div>
    </>
  )
}
