import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { canWrite, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'
import { NewRequisitionButton } from './new-requisition'
import { NewQuoteButton } from './new-quote'
import { NewSupplierButton } from './new-supplier'

import {
  openRequisitions,
  purchaseOrders,
  supplierBook,
  type PoRow,
} from '@/modules/procurement/queries'
import { itemList } from '@/modules/store/queries'

/**
 * 4.1 Procurement & Suppliers.
 *
 * An import PO must be linked to a back-to-back credit before it is issued —
 * over-opening BTBs against a master is how a factory ends up owing its
 * suppliers more than the buyer will ever pay it. The gate is on the supplier's
 * ORIGIN rather than the currency, because a local mill invoicing in USD is
 * still a local purchase.
 */
export const dynamic = 'force-dynamic'

export default async function ProcurementPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const now = new Date()
  const [pos, suppliers, requisitions, items] = await Promise.all([
    purchaseOrders(ctx, { now }),
    supplierBook(ctx),
    openRequisitions(ctx, { now }),
    itemList(ctx),
  ])

  const ungated = pos.filter((p) => p.importWithoutBtb)
  const late = pos.filter((p) => p.daysToDelivery !== null && p.daysToDelivery < 0)
  const urgentPrs = requisitions.filter((r) => r.daysToNeeded !== null && r.daysToNeeded <= 7)

  const profile = await companyProfile(ctx)
  const mayWrite = canWrite(
    NAV.find((n) => n.id === 'procurement')!,
    ctx.roles,
    profile?.factoryType ?? 'woven',
  )

  return (
    <>
      <PageHeader
        eyebrow="Procurement"
        title={pos.length === 0 ? 'No purchase orders' : `${pos.length} purchase orders`}
        meta={late.length > 0 ? `${late.length} overdue` : undefined}
        ownsAmber
        actions={
          mayWrite ? (
            <div style={{ display: 'flex', gap: 10 }}>
              <NewRequisitionButton items={items} />
              <NewQuoteButton
                requisitions={requisitions.map((r) => ({
                  id: r.id,
                  prNo: r.prNo,
                  neededBy: r.neededBy,
                }))}
                suppliers={suppliers.map((s) => ({ id: s.id, name: s.name, origin: s.origin }))}
                items={items}
              />
              <NewSupplierButton />
            </div>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {/* The gate refuses this at issue time, so a row here means something
            bypassed it — worth saying loudly rather than rendering as normal. */}
        {ungated.length > 0 ? (
          <InlineAlert tone="danger">
            {ungated.length} import {ungated.length === 1 ? 'PO has' : 'POs have'} no back-to-back
            credit linked. Those were issued outside the gate — the factory is committed to a
            supplier with nothing funding it.
          </InlineAlert>
        ) : null}

        {urgentPrs.length > 0 ? (
          <InlineAlert tone="warning">
            {urgentPrs.length} {urgentPrs.length === 1 ? 'requisition is' : 'requisitions are'}{' '}
            needed within a week and not yet ordered.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading eyebrow={`${requisitions.length} open`}>Requisitions</SectionHeading>
          {requisitions.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 14px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              Nothing waiting. A requisition becomes a PO once quotes are compared on landed cost.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
              {requisitions.map((r) => {
                const urgent = r.daysToNeeded !== null && r.daysToNeeded <= 7
                return (
                  <div
                    key={r.id}
                    style={{
                      background: 'var(--fx-bg-surface)',
                      border: '1px solid var(--fx-border-subtle)',
                      borderRadius: 'var(--fx-radius-md)',
                      padding: '14px 18px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 6,
                      minWidth: 190,
                    }}
                  >
                    <Link
                      href={`/procurement/${r.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                      aria-label={`Open ${r.prNo}`}
                    >
                      <Ident size={13}>{r.prNo}</Ident>
                    </Link>
                    <Badge tone={r.status === 'quoted' ? 'info' : 'neutral'}>{r.status}</Badge>
                    <span
                      data-numeric
                      style={{
                        font: "400 12.5px/1.3 var(--fx-font-mono)",
                        color: urgent ? 'var(--fx-warning)' : 'var(--fx-text-tertiary)',
                      }}
                    >
                      {r.neededBy
                        ? r.daysToNeeded! < 0
                          ? `needed ${Math.abs(r.daysToNeeded!)} d ago`
                          : `needed in ${r.daysToNeeded} d`
                        : 'no date'}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <SectionHeading>Purchase orders</SectionHeading>
            {/* Where a PO actually ends. Until something is received a PO stays `issued`
                forever and its supplier scores blank. */}
            <Link
              href="/procurement/receipts"
              style={{
                font: "400 13px/1.4 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              Goods in — record what arrived →
            </Link>
          </div>

          {pos.length === 0 ? (
            <EmptyState
              title="No purchase orders"
              body="Quotes are compared on landed cost — price, duty and freight together — and a quote that cannot arrive by the needed-by date is excluded rather than ranked last."
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
                  gridTemplateColumns: '1.1fr 1.4fr .8fr 1fr 1fr 1fr .9fr',
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
                <div>PO</div>
                <div>Supplier</div>
                <div>Origin</div>
                <div style={{ textAlign: 'right' }}>Value</div>
                <div>BTB</div>
                <div>Expected</div>
                <div style={{ textAlign: 'right' }}>Lines</div>
              </div>

              {pos.map((po) => (
                <PoRowView key={po.id} po={po} />
              ))}
            </div>
          )}
        </section>

        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <SectionHeading eyebrow={`${suppliers.length} active`}>Suppliers</SectionHeading>
            <Link
              href="/procurement/scorecard"
              style={{
                font: "400 13px/1.4 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              How they have performed →
            </Link>
          </div>
          {suppliers.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 14px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              No suppliers yet.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {suppliers.map((s) => (
                <div
                  key={s.id}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '13px 18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    flexWrap: 'wrap',
                    minHeight: 'var(--fx-row-height)',
                  }}
                >
                  <Ident size={13}>{s.code}</Ident>
                  <span style={{ font: "500 15px/1.3 var(--fx-font-sans)" }}>{s.name}</span>
                  <Badge>{s.type.replace(/_/g, ' ')}</Badge>
                  <Badge tone={s.origin === 'import' ? 'info' : 'neutral'}>{s.origin}</Badge>
                  <span
                    data-numeric
                    style={{
                      marginLeft: 'auto',
                      font: "400 13px/1.3 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {s.openPos} open · {s.defaultCurrency}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function PoRowView({ po }: { po: PoRow }) {
  const late = po.daysToDelivery !== null && po.daysToDelivery < 0

  return (
    <div
      className="fx-selvage"
      data-status={
        po.importWithoutBtb || late
          ? 'late'
          : po.status === 'received'
            ? 'done'
            : po.lines.open > 0
              ? 'on-track'
              : 'done'
      }
      data-critical={po.importWithoutBtb || undefined}
      style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
    >
      <div
        style={{
          flex: 1,
                    display: 'grid',
          gridTemplateColumns: '1.1fr 1.4fr .8fr 1fr 1fr 1fr .9fr',
          minWidth: 780,
          gap: 12,
          padding: '13px 18px',
          alignItems: 'center',
          minHeight: 'var(--fx-row-height)',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <Ident size={13}>{po.poNumber}</Ident>
          <Badge>{po.status.replace(/_/g, ' ')}</Badge>
        </div>

        <span style={{ font: "400 14px/1.3 var(--fx-font-sans)" }}>{po.supplierName}</span>

        <span>
          <Badge tone={po.origin === 'import' ? 'info' : 'neutral'}>{po.origin}</Badge>
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
          {po.totalValue ? `${po.totalValue} ${po.currency}` : '—'}
        </span>

        <span
          style={{
            font: "400 12.5px/1.3 var(--fx-font-mono)",
            color: po.importWithoutBtb ? 'var(--fx-danger)' : 'var(--fx-text-secondary)',
          }}
        >
          {po.btbNumber ?? (po.origin === 'import' ? 'MISSING' : 'not needed')}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span
            data-numeric
            data-mono
            style={{
              font: "400 12.5px/1.3 var(--fx-font-mono)",
              color: late ? 'var(--fx-danger)' : 'var(--fx-text-secondary)',
            }}
          >
            {po.expectedDeliveryDate ?? '—'}
          </span>
          {po.daysToDelivery !== null ? (
            <span
              data-numeric
              style={{
                font: "400 11.5px/1.3 var(--fx-font-mono)",
                color: late ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
              }}
            >
              {late ? `${Math.abs(po.daysToDelivery)} d late` : `${po.daysToDelivery} d`}
            </span>
          ) : null}
        </div>

        {/* Per line, because a half-received PO is two different situations at
            once and the shortfall is what somebody actually chases. */}
        <div
          style={{ textAlign: 'right', display: 'flex', flexDirection: 'column', gap: 2 }}
        >
          <span data-numeric style={{ font: "500 13px/1.3 var(--fx-font-mono)" }}>
            {po.lines.received}/{po.lines.total}
          </span>
          {po.lines.shortClosed > 0 ? (
            <span
              style={{ font: "400 11.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-warning)' }}
            >
              {po.lines.shortClosed} short-closed
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
}
