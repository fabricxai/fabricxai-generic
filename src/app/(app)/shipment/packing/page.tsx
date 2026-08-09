import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { desc, eq, inArray } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderStyles, orders } from '@/modules/orders/schema'
import { cartons } from '@/modules/shipment/schema'
import { remainingToPackFor } from '@/modules/shipment/service'

import { PackingClient } from './packing-client'

/**
 * 8.1 Shipment · finishing and packing (canvas P1/P3).
 *
 * The last floor screen before goods leave. A finisher reports what came off the line and a
 * packer builds cartons from it, one colour and size per carton.
 *
 * **Packed can exceed finished, and the screen has to show it rather than prevent it.** The
 * service allows an over-pack on the READ so the grid can display the problem — a packer who
 * is told "cannot render" learns nothing, whereas a red cell tells them which colour and
 * size to go and count again. The write still refuses, and accepting a genuine over-ship is
 * a manager's decision, not a packer's.
 */
export const dynamic = 'force-dynamic'

export default async function PackingPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const liveOrders = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        styleId: orderStyles.id,
        styleCode: orderStyles.styleCode,
      })
      .from(orders)
      .leftJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .where(inArray(orders.status, ['confirmed', 'in_production', 'shipped_partial'])),
  )

  if (liveOrders.length === 0) {
    return (
      <FloorScreen>
        <PageHeader eyebrow="Shipment · packing" title="Nothing to pack" ownsAmber />
        <EmptyState
          title="No live orders"
          body="Cartons are packed against an order. An order that has shipped or closed is no longer packable."
        />
      </FloorScreen>
    )
  }

  const { order: requested } = await searchParams
  const active = liveOrders.find((o) => o.id === requested) ?? liveOrders[0]!

  const [grid, recent] = await Promise.all([
    remainingToPackFor(ctx, { orderId: active.id }),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          id: cartons.id,
          cartonNo: cartons.cartonNo,
          contents: cartons.contents,
          totalQty: cartons.totalQty,
          createdAt: cartons.createdAt,
        })
        .from(cartons)
        .where(eq(cartons.orderId, active.id))
        .orderBy(desc(cartons.createdAt))
        .limit(6),
    ),
  ])

  const cells = [
    ...new Set([
      ...Object.keys(grid.ordered),
      ...Object.keys(grid.finished),
      ...Object.keys(grid.packed),
    ]),
  ].sort()

  const overPacked = cells.filter(
    (cell) => (grid.packed[cell] ?? 0) > (grid.finished[cell] ?? 0),
  ).length

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/shipment', label: 'Shipment' }}
        eyebrow="Shipment · finishing and packing"
        title={active.poNumbers?.[0] ?? active.styleCode ?? 'Order'}
        meta={overPacked > 0 ? `${overPacked} cells packed beyond finished` : undefined}
        ownsAmber
      />
      <PackingClient
        orderId={active.id}
        orderStyleId={active.styleId}
        orders={liveOrders.map((o) => ({
          id: o.id,
          label: o.poNumbers?.[0] ?? o.styleCode ?? o.id.slice(0, 8),
        }))}
        cells={cells}
        ordered={grid.ordered}
        finished={grid.finished}
        packed={grid.packed}
        remaining={grid.remaining}
        recent={recent.map((c) => ({
          id: c.id,
          cartonNo: c.cartonNo,
          totalQty: c.totalQty,
          contents: c.contents,
          at: c.createdAt.toISOString(),
        }))}
      />
    </FloorScreen>
  )
}
