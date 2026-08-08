import { headers } from 'next/headers'
import { notFound, redirect } from 'next/navigation'

import { PageHeader } from '@/components/shell/page-shell'
import { lcDetail } from '@/modules/commercial/queries'
import type { BankDocsPolicy } from '@/modules/commercial/service'
import { getCtx } from '@/modules/core/session'
import { coverableOrders } from '@/modules/orders/queries'
import { getPolicy } from '@/modules/settings/service'

import { LcDetailClient } from './lc-detail-client'
import { factoryToday } from '@/lib/dates'

/**
 * 2.1 LC register · one credit (canvas P2).
 *
 * A letter of credit is the instrument that decides whether the factory gets paid, and
 * almost every way it goes wrong is a date or a number that moved without anybody noticing:
 *
 *  - **Amendments keep what they replaced.** A bank asks what the credit said on the day
 *    the goods shipped. An LC row that only holds current terms cannot answer.
 *  - **Latest shipment and expiry are different deadlines.** Goods on the vessel by one,
 *    documents at the bank by the other. Meeting one and missing the other is still unpaid.
 *  - **Back-to-back credits are capped as a share of the master.** Opening past that is a
 *    commitment to a supplier the master cannot fund, so it is a gate, not a warning.
 */
export const dynamic = 'force-dynamic'

export default async function LcDetailPage({ params }: { params: Promise<{ lcId: string }> }) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const { lcId } = await params
  const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')
  const lc = await lcDetail(ctx, lcId, policy.btbLimitPct ?? 75)
  if (!lc) notFound()

  // The buyer's live orders this credit could cover, minus the ones it already does.
  const linked = new Set(lc.linkedOrders.map((o) => o.orderId))
  const coverable = (await coverableOrders(ctx, lc.buyerId)).filter((o) => !linked.has(o.id))

  const today = factoryToday()
  const daysTo = (date: string | null): number | null =>
    date === null
      ? null
      : Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000)

  return (
    <>
      <PageHeader
        back={{ href: '/lcs', label: 'LC register' }}
        eyebrow={`Commercial · letters of credit · ${lc.buyerName ?? 'buyer'}`}
        title={lc.number}
        meta={`${lc.value} ${lc.currency} · ${lc.status}`}
        ownsAmber
      />

      <LcDetailClient
        lc={{
          ...lc,
          amendments: lc.amendments.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
        }}
        daysToLatestShipment={daysTo(lc.latestShipmentDate)}
        daysToExpiry={daysTo(lc.expiryDate)}
        coverable={coverable.map((o) => ({
          id: o.id,
          label: `${o.poNumbers[0] ?? o.id.slice(0, 8)}${o.plannedExFactoryDate ? ` · ships ${o.plannedExFactoryDate}` : ''}`,
        }))}
      />
    </>
  )
}
