import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Breadcrumbs, StatTile } from '@/components/fx/data'
import { InlineAlert } from '@/components/fx/feedback'
import { Figure } from '@/components/fx/format'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { awaitingReceipt } from '@/modules/procurement/queries'
import { getPolicy } from '@/modules/settings/service'
import type { ProcurementPolicy } from '@/modules/procurement/service'

import { ReceiptDesk } from './receipt-desk'

/**
 * 3.2 Goods in — recording what actually turned up.
 *
 * `applyReceipt` was written, tested and called by nothing, and it is the far end of every
 * purchase order this system issues. Two things were dead because of it.
 *
 * **No PO could ever close.** A line stays `open` until something receives against it, so
 * every PO sat at `issued` forever and the overdue alert counted orders that had arrived
 * weeks ago.
 *
 * **Every supplier's on-time score was blank.** `computeSupplierScores` measures a receipt's
 * `closedAt` against the PO's expected delivery date. With no receipts there are no closed
 * lines, so the scorecard read `no closed receipts` against every supplier in the factory —
 * correctly, and permanently.
 *
 * **An over-receipt is recorded, not refused.** Past the negotiated allowance the goods are
 * still physically on the shelf; a ledger that disagrees with the store is worse than an
 * over-receipt, and refusing the entry just means somebody writes it down on paper instead.
 * It is recorded, flagged, and finance is told — because they are the ones who will be
 * invoiced for material nobody ordered.
 */
export const dynamic = 'force-dynamic'

export default async function ReceiptsPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const now = new Date()
  const [lines, policy] = await Promise.all([
    awaitingReceipt(ctx, { now }),
    getPolicy<ProcurementPolicy>(ctx, 'procurement'),
  ])

  const late = lines.filter((l) => l.daysToDelivery !== null && l.daysToDelivery < 0)
  const partial = lines.filter((l) => l.status === 'received_partial')
  const undated = lines.filter((l) => l.expectedDeliveryDate === null)

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[{ label: 'Procurement', href: '/procurement' }, { label: 'Goods in' }]}
        />
      </div>

      <PageHeader
        back={{ href: '/procurement', label: 'Procurement' }}
        eyebrow="Procurement · goods in"
        title={
          lines.length === 0
            ? 'Nothing outstanding'
            : `${lines.length} ${lines.length === 1 ? 'line' : 'lines'} awaiting goods`
        }
        meta={late.length > 0 ? `${late.length} past their date` : undefined}
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 14,
          }}
        >
          <StatTile
            label="Past their delivery date"
            value={<Figure value={late.length} />}
            basis={late.length > 0 ? 'chase these before anything else' : 'nothing overdue'}
            status={late.length > 0 ? 'late' : undefined}
          />
          <StatTile
            label="Part received"
            value={<Figure value={partial.length} />}
            basis={partial.length > 0 ? 'some arrived, a balance still owed' : 'none'}
          />
          <StatTile
            label="No date promised"
            value={<Figure value={undated.length} />}
            // Not overdue and not fine: a line with no expected date can never be late,
            // so it never appears in any chase list and never scores the supplier either.
            basis={
              undated.length > 0
                ? 'cannot be late, and cannot score the supplier on time'
                : 'every line has a date'
            }
            status={undated.length > 0 ? 'at-risk' : undefined}
          />
        </div>

        {undated.length > 0 ? (
          <InlineAlert tone="info">
            {undated.length}{' '}
            {undated.length === 1 ? 'line has' : 'lines have'} no expected delivery date on their
            purchase order. Receiving against them still closes the line, but on-time is measured
            against that date — so those receipts count towards nothing in the supplier scorecard,
            in either direction.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading eyebrow="latest first — what to chase before walking to the bay">
            Awaiting goods
          </SectionHeading>

          {/*
            Rendered even with nothing outstanding, and the desk owns the empty state.
            Swapping it for an `EmptyState` here unmounted the component holding the
            confirmation — so recording the LAST outstanding receipt emptied the list and
            said nothing at all, which is the one receipt somebody most wants confirmed.
          */}
          <ReceiptDesk lines={lines} tolerancePct={policy.overReceiptTolerancePct ?? '0'} />
        </section>
      </div>
    </>
  )
}
