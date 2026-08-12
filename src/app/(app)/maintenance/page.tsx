import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { TicketActions } from '@/components/fx/ticket-actions'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import {
  fleet,
  spares,
  ticketBoard,
  unassigned,
} from '@/modules/maintenance/queries'
import { PendingReadings } from '@/components/shell/pending-readings'
import { RaisedDrafts } from '@/components/shell/raised-drafts'

/**
 * 9.1 Maintenance.
 *
 * A floor screen ordered by what stops production rather than by what arrived
 * first: `line_down` is a whole sewing line standing idle, `normal` is a
 * machine somebody can work around. Within a priority, the oldest wins — the
 * one that has been down longest.
 */
export const dynamic = 'force-dynamic'

export default async function MaintenancePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const now = new Date()
  const [board, parts, machines, noLine] = await Promise.all([
    ticketBoard(ctx, { now }),
    spares(ctx),
    fleet(ctx),
    unassigned(ctx),
  ])

  const down = board.filter((t) => t.priority === 'line_down')
  const unclaimed = board.filter((t) => t.status === 'open')
  const out = parts.filter((p) => p.out)
  const low = parts.filter((p) => p.low && !p.out)

  return (
    <FloorScreen>
      <PageHeader
        eyebrow="Maintenance"
        title={board.length === 0 ? 'Nothing open' : `${board.length} open tickets`}
        meta={down.length > 0 ? `${down.length} line down` : undefined}
        ownsAmber
      />

      {/* Their corrections and overrides route to an inbox they cannot see (2.1). */}
      <PendingReadings />
      <RaisedDrafts />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {down.length > 0 ? (
          <InlineAlert tone="danger">
            {down.length} {down.length === 1 ? 'line is' : 'lines are'} stopped. Everything else on
            this screen can wait.
          </InlineAlert>
        ) : null}

        {out.length > 0 ? (
          <InlineAlert tone="warning">
            {out.length} spare {out.length === 1 ? 'part is' : 'parts are'} at zero. The next repair
            needing one stops — a shortfall is recorded rather than refused, so stock never goes
            negative but a gap can still be real.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading eyebrow={`${unclaimed.length} unclaimed`}>Tickets</SectionHeading>

          {board.length === 0 ? (
            <EmptyState
              title="No open tickets"
              body="Tickets arrive two ways: a mechanic raises one, or a recorded stoppage on the line board raises one automatically — once per stoppage, never twice."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {board.map((t) => (
                <TicketActions
                  key={t.id}
                  ticket={{
                    ticketId: t.id,
                    status: t.status,
                    priority: t.priority,
                    machineLabel: t.machineType
                      ? `${t.machineType}${t.machineSerial ? ` · ${t.machineSerial}` : ''}`
                      : null,
                    lineCode: t.lineCode,
                    notes: t.notes,
                    // Minutes, not hours — see the note on `openMinutes`. Computed in the
                    // query so the whole board agrees on one instant.
                    openedMinutesAgo: t.openMinutes ?? 0,
                  }}
                />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeading eyebrow={`${parts.length} parts`}>Spares</SectionHeading>
          {parts.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 15px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              No spare parts on file.
            </div>
          ) : (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr',
                  gap: 12,
                  padding: '12px 20px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 12px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>Code</div>
                <div>Part</div>
                <div style={{ textAlign: 'right' }}>On hand</div>
                <div style={{ textAlign: 'right' }}>Reorder at</div>
                <div style={{ textAlign: 'right' }}>State</div>
              </div>

              {parts.map((p) => (
                <div
                  key={p.id}
                  className={p.low ? 'fx-selvage' : undefined}
                  data-status={p.out ? 'late' : p.low ? 'at-risk' : undefined}
                  style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
                >
                  <div
                    style={{
                      flex: 1,
                      display: 'grid',
                      gridTemplateColumns: '1fr 2fr 1fr 1fr 1fr',
                      gap: 12,
                      padding: '13px 20px',
                      alignItems: 'center',
                      minHeight: 'var(--fx-row-height)',
                    }}
                  >
                    <Ident size={14}>{p.code}</Ident>
                    <span style={{ font: "400 15px/1.3 var(--fx-font-sans)" }}>{p.name}</span>
                    <span
                      data-numeric
                      style={{
                        font: "600 16px/1.2 var(--fx-font-mono)",
                        textAlign: 'right',
                        color: p.out ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                      }}
                    >
                      {p.onHand}
                    </span>
                    <span
                      data-numeric
                      style={{
                        font: "400 14px/1.2 var(--fx-font-mono)",
                        textAlign: 'right',
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {p.minLevel}
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      {p.out ? (
                        <Badge tone="danger">out</Badge>
                      ) : p.low ? (
                        <Badge tone="warning">reorder</Badge>
                      ) : (
                        <Badge tone="success">ok</Badge>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
          {low.length > 0 ? (
            <div
              style={{
                marginTop: 10,
                font: "400 13px/1.4 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {low.length} more at or below the reorder level
            </div>
          ) : null}
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
            <SectionHeading eyebrow={`${machines.length} machines`}>Fleet</SectionHeading>
            <span style={{ display: 'flex', gap: 18 }}>
              <Link href="/maintenance/pm" style={sectionLink}>
                Preventive maintenance →
              </Link>
              <Link href="/maintenance/machines" style={sectionLink}>
                Registry — add and move machines →
              </Link>
            </span>
          </div>

          {noLine > 0 ? (
            <div
              style={{
                marginBottom: 10,
                font: "400 13px/1.4 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {noLine} {noLine === 1 ? 'machine is' : 'machines are'} not assigned to a line
            </div>
          ) : null}

          {machines.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 15px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              No machines registered.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {machines.map((m) => (
                <div
                  key={m.id}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '13px 20px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    flexWrap: 'wrap',
                    minHeight: 'var(--fx-row-height)',
                  }}
                >
                  <span style={{ font: "500 15px/1.3 var(--fx-font-sans)" }}>{m.machineType}</span>
                  {m.brand || m.model ? (
                    <span
                      style={{ font: "400 13px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
                    >
                      {[m.brand, m.model].filter(Boolean).join(' ')}
                    </span>
                  ) : null}
                  {m.serial ? <Ident size={12}>{m.serial}</Ident> : null}
                  <Badge>{m.lineCode ?? 'unassigned'}</Badge>
                  {m.openTickets > 0 ? (
                    <span style={{ marginLeft: 'auto' }}>
                      <Badge tone="warning">{m.openTickets} open</Badge>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <FloorTabs
        tabs={[
          { href: '/maintenance', label: 'Tickets' },
          { href: '/maintenance/pm', label: 'PM' },
          { href: '/maintenance/machines', label: 'Registry' },
        ]}
      />
    </FloorScreen>
  )
}

const sectionLink: React.CSSProperties = {
  minHeight: 'var(--fx-tap-min)',
  display: 'inline-flex',
  alignItems: 'center',
  font: "400 13px/1.4 var(--fx-font-sans)",
  color: 'var(--fx-text-secondary)',
}
