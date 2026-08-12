import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { canWrite, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'
import { orderList } from '@/modules/orders/queries'
import { board, openScenarios, smvByStyle, type BoardLine } from '@/modules/planning/queries'
import { factoryToday } from '@/lib/dates'

import { RunActions } from './allocation-actions'
import { NewAllocationButton } from './new-allocation'
import { WorkingWeekButton } from './working-week'

/**
 * 5.2 Planning Board.
 *
 * Lines down, days across. The board's honesty rests on one distinction: a
 * line-day over-committed ON PURPOSE is different from one over-committed by
 * accident, and `accepted_violations` is what tells them apart. A board that
 * alarms about a decision somebody already took is one planners stop reading.
 */
export const dynamic = 'force-dynamic'

const WINDOW_DAYS = 14

export default async function PlanningPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const from = factoryToday()
  const [lines, scenarios, orders, smvs] = await Promise.all([
    board(ctx, { from, days: WINDOW_DAYS }),
    openScenarios(ctx),
    orderList(ctx, { now: new Date() }),
    smvByStyle(ctx),
  ])

  const profile = await companyProfile(ctx)
  const mayWrite = canWrite(
    NAV.find((n) => n.id === 'planning')!,
    ctx.roles,
    profile?.factoryType ?? 'woven',
  )

  const dates = lines[0]?.days.map((d) => d.date) ?? []

  /*
   * Every line blank for the whole window. Distinct from "this line is off on Friday": it
   * means nobody has told the system when any of them work, and until this said so the board
   * looked like a factory with nothing booked rather than one that cannot book anything.
   */
  const noCalendar =
    lines.length > 0 && lines.every((l) => l.days.every((d) => d.availableMinutes === 0))

  // Committed on a day the line is not working at all — the loudest kind of wrong.
  const onNonWorkingDays = lines.flatMap((l) =>
    l.days.filter((d) => d.committed > 0 && d.availableMinutes === 0).map((d) => ({ line: l.code, date: d.date })),
  )

  const acceptedCount = lines.reduce(
    (n, l) => n + l.allocations.reduce((m, a) => m + a.acceptedViolations.length, 0),
    0,
  )

  return (
    <>
      <PageHeader
        eyebrow={`Planning · ${WINDOW_DAYS} days from ${from}`}
        title={lines.length === 0 ? 'No lines' : `${lines.length} lines`}
        meta={scenarios.length > 0 ? `${scenarios.length} draft scenarios` : undefined}
        ownsAmber
        actions={
          mayWrite ? (
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
            <WorkingWeekButton
              today={from}
              covered={lines.filter((l) => l.days.some((d) => d.availableMinutes > 0)).length}
              lines={lines.map((l) => ({ id: l.lineId, code: l.code, name: l.name }))}
            />
            <NewAllocationButton
              today={from}
              lines={lines.map((l) => ({ id: l.lineId, code: l.code, name: l.name }))}
              /* Only orders there is something to make. A cancelled or shipped order on the
                 picker is a planner reading five names to find the two that are work. */
              orders={orders
                .filter((o) => o.contractedQty && o.status !== 'cancelled' && o.status !== 'closed')
                .map((o) => ({
                  orderId: o.id,
                  orderStyleId: o.orderStyleId,
                  label: `${o.poNumbers[0] ?? '—'} · ${o.styleCode ?? '—'} · ${(o.contractedQty ?? 0).toLocaleString()} pcs`,
                  qty: o.contractedQty ?? 0,
                  styleCode: o.styleCode,
                  smv: o.styleCode ? (smvs.get(o.styleCode) ?? null) : null,
                }))}
            />
            </div>
          ) : undefined
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {noCalendar ? (
          <InlineAlert tone="warning">
            None of these lines has a working day set in this window, so every square is
            empty and nothing can be planned onto them. Set the working week — which days
            they run, how long the shift is — and the board fills in.
          </InlineAlert>
        ) : null}

        {onNonWorkingDays.length > 0 ? (
          <InlineAlert tone="danger">
            {onNonWorkingDays.length} line-{onNonWorkingDays.length === 1 ? 'day is' : 'days are'}{' '}
            booked on a day with no shift at all. Those pieces have nowhere to be made —
            {' '}
            {onNonWorkingDays
              .slice(0, 3)
              .map((v) => `${v.line} ${v.date}`)
              .join(', ')}
            {onNonWorkingDays.length > 3 ? ' and others' : ''}.
          </InlineAlert>
        ) : null}

        {acceptedCount > 0 ? (
          <InlineAlert tone="info">
            {acceptedCount} overload{acceptedCount === 1 ? '' : 's'} on this board {acceptedCount === 1 ? 'was' : 'were'}{' '}
            accepted deliberately. They are shown as decisions, not as problems to fix.
          </InlineAlert>
        ) : null}

        {lines.length === 0 ? (
          <EmptyState
            title="No production lines"
            body="Lines belong to a floor in a factory unit. Once they exist with a working calendar, orders can be allocated across them."
          />
        ) : (
          <Card padding={0}>
            <div style={{ overflowX: 'auto' }}>
              <div style={{ minWidth: 120 + dates.length * 74 }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: `140px repeat(${dates.length}, 1fr)`,
                    gap: 4,
                    padding: '12px 18px',
                    background: 'var(--fx-bg-sunken)',
                    font: "500 11px/1.3 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  <div>Line</div>
                  {dates.map((d) => (
                    <div key={d} style={{ textAlign: 'center' }}>
                      {d.slice(8)}/{d.slice(5, 7)}
                    </div>
                  ))}
                </div>

                {lines.map((line) => (
                  <LineRow key={line.lineId} line={line} />
                ))}
              </div>
            </div>

            <div
              style={{
                padding: '12px 18px',
                borderTop: '1px solid var(--fx-border-subtle)',
                font: "400 12.5px/1.5 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              a blank cell is a day the line is not working · pieces are read per date from each
              allocation, never as a flat daily rate
            </div>
          </Card>
        )}

        {lines.some((l) => l.allocations.length > 0) ? (
          <section>
            <SectionHeading>What is booked</SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {lines.flatMap((l) =>
                l.allocations.map((a) => (
                  <div
                    key={a.id}
                    className="fx-selvage"
                    data-status={
                      a.status === 'done' ? 'done' : a.acceptedViolations.length > 0 ? 'at-risk' : 'on-track'
                    }
                    style={{
                      background: 'var(--fx-bg-surface)',
                      border: '1px solid var(--fx-border-subtle)',
                      borderRadius: 'var(--fx-radius-md)',
                    }}
                  >
                    <div
                      style={{
                        padding: '13px 20px',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 14,
                        flexWrap: 'wrap',
                        flex: 1,
                      }}
                    >
                      <Badge>{a.lineCode}</Badge>
                      {a.poNumber ? <Ident size={13}>{a.poNumber}</Ident> : null}
                      <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>
                        {a.styleCode ?? 'style not set'}
                      </span>
                      <span
                        data-numeric
                        style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                      >
                        {a.startDate} → {a.endDate}
                      </span>
                      <span data-numeric style={{ font: "500 14px/1.3 var(--fx-font-mono)" }}>
                        {a.plannedTotal.toLocaleString()} pcs
                      </span>
                      <Badge tone={a.status === 'active' ? 'success' : 'neutral'}>{a.status}</Badge>

                      <RunActions
                        run={{
                          id: a.id,
                          lineCode: a.lineCode,
                          styleCode: a.styleCode,
                          startDate: a.startDate,
                          endDate: a.endDate,
                          plannedDaily: a.plannedDaily,
                          plannedTotal: a.plannedTotal,
                          status: a.status,
                        }}
                        canWrite={mayWrite}
                      />

                      {a.acceptedViolations.length > 0 ? (
                        <span
                          style={{
                            width: '100%',
                            font: "400 12.5px/1.5 var(--fx-font-mono)",
                            color: 'var(--fx-text-secondary)',
                          }}
                        >
                          overloaded on purpose:{' '}
                          {a.acceptedViolations
                            .map((v) => String(v.facts.date ?? '—'))
                            .join(', ')}
                        </span>
                      ) : null}

                      {a.acceptedUnreadable > 0 ? (
                        <span
                          style={{
                            width: '100%',
                            font: "400 12.5px/1.4 var(--fx-font-mono)",
                            color: 'var(--fx-warning)',
                          }}
                        >
                          {a.acceptedUnreadable} accepted{' '}
                          {a.acceptedUnreadable === 1 ? 'overload' : 'overloads'} could not be read —
                          this run may be over-committed without it showing
                        </span>
                      ) : null}
                    </div>
                  </div>
                )),
              )}
            </div>
          </section>
        ) : null}
      </div>
    </>
  )
}

function LineRow({ line }: { line: BoardLine }) {
  // The dates a planner signed off. `facts.date` is where the violation carries it — the
  // cell shades differently for a day somebody chose to overload than for one that just is.
  const accepted = new Set(
    line.allocations.flatMap((a) =>
      a.acceptedViolations.map((v) => String(v.facts.date ?? '')).filter(Boolean),
    ),
  )

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `140px repeat(${line.days.length}, 1fr)`,
        gap: 4,
        padding: '10px 18px',
        borderTop: '1px solid var(--fx-border-subtle)',
        alignItems: 'center',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ font: "600 15px/1.2 var(--fx-font-sans)" }}>{line.code}</span>
        <span style={{ font: "400 11.5px/1.2 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          {line.capacityManpower ? `${line.capacityManpower} operators` : line.name}
        </span>
      </div>

      {line.days.map((day) => {
        const working = day.availableMinutes > 0
        const booked = day.committed > 0
        const onPurpose = accepted.has(day.date)

        return (
          <div
            key={day.date}
            title={
              working
                ? `${day.committed} pcs · ${day.availableMinutes} min available`
                : 'no shift this day'
            }
            style={{
              minHeight: 46,
              borderRadius: 'var(--fx-radius-sm)',
              // A non-working day is blank, not zero — the line is closed, not idle.
              background: !working
                ? 'transparent'
                : booked
                  ? 'var(--fx-bg-sunken)'
                  : 'var(--fx-bg-surface)',
              border: !working
                ? '1px dashed var(--fx-border-subtle)'
                : booked && !onPurpose && day.committed > 0
                  ? '1px solid var(--fx-border-default)'
                  : '1px solid var(--fx-border-subtle)',
              // An accepted overload gets a warning rim rather than an alarm.
              boxShadow: onPurpose ? 'inset 0 0 0 2px var(--fx-warning)' : undefined,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {working && booked ? (
              <span data-numeric style={{ font: "500 13px/1 var(--fx-font-mono)" }}>
                {day.committed}
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
