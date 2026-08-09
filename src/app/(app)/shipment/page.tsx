import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { ShipmentActions } from '@/components/fx/shipment-actions'
import { SavableCard } from '@/components/fx/save-card'
import { PageHeader } from '@/components/shell/page-shell'
import { eq } from 'drizzle-orm'

import { lcs } from '@/modules/commercial/schema'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { orderList } from '@/modules/orders/queries'
import { orderLcs } from '@/modules/orders/schema'
import { shipmentBoard, type ShipmentRow } from '@/modules/shipment/queries'

import { NewShipmentButton } from './new-shipment'

/**
 * 8.2 Shipment.
 *
 * The screen answers "can this go to the bank yet", and the EXP number is the
 * reason it usually cannot. An EXP is mandatory per export shipment under
 * Bangladesh Bank rules — without one the presentation cannot legally be made
 * at all, so the server hard-blocks the handoff and records the attempt.
 *
 * Everything else that blocks is a completeness problem. The screen keeps them
 * in that order, because fixing them the other way round wastes a day.
 */
export const dynamic = 'force-dynamic'

const PORT_STAGES = ['planned', 'ex_factory', 'at_port', 'on_board', 'delivered'] as const

export default async function ShipmentPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const rows = await shipmentBoard(ctx)

  /*
   * The orders a shipment can be opened against, with the credit that covers each
   * (live-test finding, Phase 7: `openShipment` had no screen, so the board could only
   * show seeded shipments). The LC comes through `order_lcs` — the join the whole
   * date-conflict machinery already runs on — so the shipment's dates are checked
   * against the right credit without anybody re-picking it.
   */
  const orderRows = await orderList(ctx)
  const coverage = await withTenantRead(ctx, (tx) =>
    tx
      .select({ orderId: orderLcs.orderId, lcId: lcs.id, lcNumber: lcs.number })
      .from(orderLcs)
      .innerJoin(lcs, eq(lcs.id, orderLcs.lcId)),
  )
  const lcByOrder = new Map(coverage.map((c) => [c.orderId, c]))
  const shippableOrders = orderRows
    .filter((row) => !['closed', 'cancelled'].includes(row.status))
    .map((row) => ({
      id: row.id,
      label: `${row.poNumbers[0] ?? row.id.slice(0, 8)} · ${row.styleCode ?? ''}`,
      plannedExFactory: row.plannedExFactoryDate,
      lcId: lcByOrder.get(row.id)?.lcId ?? null,
      lcNumber: lcByOrder.get(row.id)?.lcNumber ?? null,
    }))

  const noExp = rows.filter((r) => !r.expNumber && r.portStatus !== 'planned')
  const pastDeadline = rows.filter(
    (r) => r.daysAgainstLatestShipment !== null && r.daysAgainstLatestShipment < 0,
  )
  const ready = rows.filter((r) => r.blockers.length === 0)

  return (
    <>
      <PageHeader
        eyebrow="Shipment"
        title={rows.length === 0 ? 'No shipments' : `${rows.length} shipments`}
        meta={ready.length > 0 ? `${ready.length} ready for the bank` : undefined}
        ownsAmber
        actions={<NewShipmentButton orders={shippableOrders} />}
      />

      {/* The packing floor is this module's second screen, and the sidebar carries one
          entry per module — without this link the screen was reachable only by typing
          the URL (live-test finding, Phase 7). */}
      <nav style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Link
          href="/shipment/packing"
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
          Packing floor
        </Link>
      </nav>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        {noExp.length > 0 ? (
          <InlineAlert tone="danger">
            {noExp.length} {noExp.length === 1 ? 'shipment has' : 'shipments have'} left the factory
            with no EXP number. The bank presentation cannot legally be made until one exists —
            this is not a form to fill in later.
          </InlineAlert>
        ) : null}

        {pastDeadline.length > 0 ? (
          <InlineAlert tone="warning">
            {pastDeadline.length} {pastDeadline.length === 1 ? 'shipment left' : 'shipments left'}{' '}
            after the LC&rsquo;s latest shipment date. Those documents will be discrepant unless the
            buyer waives it.
          </InlineAlert>
        ) : null}

        {rows.length === 0 ? (
          <EmptyState
            title="Nothing shipping"
            body="A shipment is created once cartons are packed and loaded. Its document checklist comes from the LC's own docs_required, so what the buyer asked for is what gets prepared."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {rows.map((s) => (
              <SavableCard
                key={s.id}
                filename={`${s.poNumber ?? s.id.slice(0, 8)}-shipment-${s.partialNo}`}
              >
                <ShipmentCard shipment={s} />
              </SavableCard>
            ))}
          </div>
        )}

        <SectionHeading eyebrow="server-enforced">The gate</SectionHeading>
        <div
          style={{
            background: 'var(--fx-bg-surface)',
            border: '1px solid var(--fx-border-subtle)',
            borderRadius: 'var(--fx-radius-md)',
            padding: '18px 22px',
            font: "400 15px/1.6 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
            textWrap: 'pretty',
          }}
        >
          Handing documents to the bank is refused without an EXP number, and the refusal is
          recorded in its own transaction so the attempt survives even though the handoff did
          not. A trail of somebody trying to present without one is worth having.
        </div>
      </div>
    </>
  )
}

function ShipmentCard({ shipment }: { shipment: ShipmentRow }) {
  const blocked = shipment.blockers.length > 0
  const late =
    shipment.daysAgainstLatestShipment !== null && shipment.daysAgainstLatestShipment < 0
  const stageIndex = PORT_STAGES.indexOf(shipment.portStatus)

  return (
    <div
      className="fx-selvage"
      data-status={late ? 'late' : blocked ? 'at-risk' : 'on-track'}
      data-critical={(!shipment.expNumber && shipment.portStatus !== 'planned') || undefined}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        boxShadow: 'var(--fx-sh1)',
      }}
    >
      <div style={{ padding: '16px 22px', display: 'flex', flexDirection: 'column', gap: 12, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {shipment.poNumber ? <Ident size={14}>{shipment.poNumber}</Ident> : null}
          <Badge>partial {shipment.partialNo}</Badge>
          <Badge>{shipment.mode}</Badge>
          {shipment.lcNumber ? (
            <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {shipment.lcNumber}
            </span>
          ) : null}
          <span style={{ marginLeft: 'auto' }}>
            {shipment.expNumber ? (
              <Badge tone="success">EXP {shipment.expNumber}</Badge>
            ) : (
              /* The one blocker that is legal rather than procedural. */
              <Badge tone="danger">no EXP</Badge>
            )}
          </span>
        </div>

        {/* Port progress as the slash rule. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ display: 'flex', gap: 5 }}>
            {PORT_STAGES.map((stage, i) => (
              <span
                key={stage}
                title={stage}
                style={{
                  width: 3,
                  height: 16,
                  transform: 'skewX(var(--fx-slash-angle))',
                  background: i <= stageIndex ? 'var(--fx-text-primary)' : 'var(--fx-border-default)',
                }}
              />
            ))}
          </span>
          <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
            {shipment.portStatus.replace(/_/g, ' ')}
            {shipment.blAwb ? ` · ${shipment.blAwb}` : ''}
            {shipment.forwarder ? ` · ${shipment.forwarder}` : ''}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap' }}>
          <Fact label="Ex-factory">
            {shipment.actualExFactory ?? shipment.plannedExFactory ?? '—'}
            {shipment.actualExFactory ? null : (
              <span style={{ color: 'var(--fx-text-tertiary)' }}> planned</span>
            )}
          </Fact>

          {shipment.latestShipmentDate ? (
            <Fact label="LC deadline" tone={late ? 'danger' : undefined}>
              {shipment.latestShipmentDate}
              <span style={{ color: late ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)' }}>
                {' '}
                {late
                  ? `· ${Math.abs(shipment.daysAgainstLatestShipment!)} d late`
                  : `· ${shipment.daysAgainstLatestShipment} d spare`}
              </span>
            </Fact>
          ) : null}

          <Fact label="Packed">
            {shipment.cartonCount} cartons · {shipment.packedQty.toLocaleString()} pcs
          </Fact>

          <Fact label="Packing list">
            {shipment.packingList
              ? `v${shipment.packingList.version} · ${shipment.packingList.status}`
              : 'none'}
          </Fact>
        </div>

        {shipment.docs.length > 0 ? (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {shipment.docs.map((d) => (
              <Badge
                key={d.kind}
                tone={d.status === 'submitted' ? 'success' : d.status === 'ready' ? 'info' : 'neutral'}
              >
                {d.kind.replace(/_/g, ' ')} · {d.status}
              </Badge>
            ))}
          </div>
        ) : null}

        {blocked ? (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              paddingTop: 4,
              borderTop: '1px solid var(--fx-border-subtle)',
            }}
          >
            <Eyebrow>Blocking the bank</Eyebrow>
            {shipment.blockers.map((b) => (
              <span
                key={b}
                style={{
                  font: "400 13.5px/1.5 var(--fx-font-sans)",
                  color: b === 'no EXP number' ? 'var(--fx-danger)' : 'var(--fx-text-secondary)',
                }}
              >
                {b}
              </span>
            ))}
          </div>
        ) : (
          <span
            style={{
              font: "500 13.5px/1.4 var(--fx-font-sans)",
              color: 'var(--fx-success)',
              paddingTop: 4,
            }}
          >
            Ready to present
          </span>
        )}
      </div>

      <ShipmentActions
        state={{
          shipmentId: shipment.id,
          orderId: shipment.orderId,
          expNumber: shipment.expNumber,
          actualExFactory: shipment.actualExFactory,
          packingList: shipment.packingList
            ? {
                id: shipment.packingList.id,
                version: shipment.packingList.version,
                status: shipment.packingList.status,
              }
            : null,
          blockers: shipment.blockers,
          docs: shipment.docs,
          cartonCount: shipment.cartonCount,
          unloadedCartons: shipment.unloadedCartons,
        }}
      />
    </div>
  )
}

function Fact({
  label,
  children,
  tone,
}: {
  label: string
  children: React.ReactNode
  tone?: 'danger'
}) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
        {label}
      </span>
      <span
        data-numeric
        style={{
          font: "500 14px/1.3 var(--fx-font-mono)",
          color: tone === 'danger' ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
        }}
      >
        {children}
      </span>
    </span>
  )
}
