import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { checkPpApprovalFor } from '@/modules/sampling/service'
import { cuttableOrders, issuedRollsForOrder } from '@/modules/cutting/queries'
import { markers } from '@/modules/cutting/schema'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { eq } from 'drizzle-orm'

import { LayClient } from './lay-client'

/**
 * 5.1 Cutting · start a lay (canvas P2).
 *
 * Both gates are evaluated HERE as well as in `createLay`, and that is not duplication —
 * they answer different questions. The service's check is the wall: it refuses the write.
 * This one is the sign on the door: it tells a cutter *before* they measure and pick rolls
 * that this style cannot be spread yet, and says which gate is holding it.
 *
 * A cutter who gets that answer after choosing has already moved fabric.
 */
export const dynamic = 'force-dynamic'

export default async function StartLayPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const orders = await cuttableOrders(ctx)

  if (orders.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/cutting', label: 'Cutting' }}
          eyebrow={tui(locale, 'ui.cutting.lay_eyebrow')}
          title={tui(locale, 'ui.cutting.lay_nothing_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.cutting.lay_empty_title')}
          body={tui(locale, 'ui.cutting.lay_empty_body')}
        />
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

  const requested = (await searchParams).order
  const target = orders.find((o) => o.orderId === requested) ?? orders[0]!

  const [gate, rolls, markerRows] = await Promise.all([
    checkPpApprovalFor(ctx, { orderId: target.orderId, orderStyleId: target.orderStyleId }),
    issuedRollsForOrder(ctx, target.orderId),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          id: markers.id,
          code: markers.code,
          sizeRatio: markers.sizeRatio,
          layLengthMeters: markers.layLengthMeters,
          efficiencyPct: markers.efficiencyPct,
          fabricWidthInches: markers.fabricWidthInches,
        })
        .from(markers)
        .where(eq(markers.styleCode, target.styleCode)),
    ),
  ])

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/cutting', label: 'Cutting' }}
        eyebrow={tui(locale, 'ui.cutting.lay_eyebrow')}
        title={`${target.poNumber ?? tui(locale, 'ui.cutting.order_fallback')} · ${target.styleCode}`}
        meta={gate.passed ? undefined : tui(locale, 'ui.cutting.meta_blocked')}
        ownsAmber
      />

      {!gate.passed ? (
        <InlineAlert tone="danger">
          {tui(locale, 'ui.cutting.pp_gate_blocked')}
          {/* The gate's key, not a sentence about it — it is the reference the sample room
              is asked about, so it stays untranslated and quotable. */}
          {gate.reasonKey
            ? ` ${tui(locale, 'ui.cutting.pp_gate_reason', { reason: gate.reasonKey })}`
            : ''}
        </InlineAlert>
      ) : null}

      <LayClient
        orders={orders}
        target={target}
        markers={markerRows}
        rolls={rolls}
        blocked={!gate.passed}
      />
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
