import { EntityRef } from '@/components/shell/entity-drawer'
import { FACTORY_TIMEZONE } from '@/lib/dates'
import type { TimelineEvent } from '@/modules/orders/queries'

/**
 * The Order File's timeline (specs/order-centric-core.md §2).
 *
 * One chronological merge of everything that ever happened to this order, newest
 * first — read from traces that already existed in five tables and were never shown
 * together. The question it answers is the one nobody could answer before: what has
 * been done to this order, by whom, and in what order.
 *
 * Each kind renders as its own sentence rather than a generic "audit row": "Nafisa
 * moved it to in_production" is a fact a merchandiser reads; `orders.status: [status]`
 * is a row a developer reads.
 */
const stamp = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: FACTORY_TIMEZONE,
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(at)

/** Who did it, when nobody is recorded — a job, a job's job, or a person since gone. */
const actor = (name: string | null) => name ?? 'the system'

function line(event: TimelineEvent) {
  switch (event.kind) {
    case 'created':
      return <>Order opened by {actor(event.byName)}</>
    case 'status':
      return (
        <>
          {actor(event.byName)} moved it {event.from ? `from ${event.from} ` : ''}to{' '}
          <strong style={{ fontWeight: 600 }}>{event.to ?? 'a new status'}</strong>
        </>
      )
    case 'approval':
      return (
        <>
          {actor(event.byName)} approved a change to {event.targetTable}
          <span style={{ color: 'var(--fx-text-tertiary)' }}> · {event.source}</span>
        </>
      )
    case 'document':
      return (
        <>
          {/* Peekable: the paper opens beside the timeline rather than replacing it. */}
          <EntityRef kind="document" reference={event.documentId}>
            {event.label ?? event.filename}
          </EntityRef>{' '}
          filed to this order
        </>
      )
    case 'milestone':
      return (
        <>
          <strong style={{ fontWeight: 600 }}>{event.name}</strong> completed
        </>
      )
    case 'revision':
      return (
        <>
          {actor(event.byName)} committed revision {event.revision}
          {event.reason ? <span style={{ color: 'var(--fx-text-tertiary)' }}> · {event.reason}</span> : null}
        </>
      )
  }
}

/** A milestone completion is a factory-day fact and carries no clock — say only the day. */
const isDayOnly = (event: TimelineEvent) => event.kind === 'milestone'

export function OrderTimeline({ events }: { events: readonly TimelineEvent[] }) {
  if (events.length === 0) {
    return (
      <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
        Nothing has happened to this order yet.
      </p>
    )
  }

  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' }}>
      {events.map((event, index) => (
        <li
          key={`${event.kind}-${event.at.getTime()}-${index}`}
          style={{
            display: 'flex',
            gap: 16,
            padding: '11px 0',
            borderTop: index === 0 ? 'none' : '1px solid var(--fx-border-subtle)',
            alignItems: 'baseline',
          }}
          className="fx-stack-tablet"
        >
          <span
            data-mono
            style={{
              font: '400 12px/1.4 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
              minWidth: 108,
            }}
          >
            {isDayOnly(event) ? stamp(event.at).split(',')[0] : stamp(event.at)}
          </span>
          <span style={{ font: '400 13.5px/1.5 var(--fx-font-sans)' }}>{line(event)}</span>
        </li>
      ))}
    </ol>
  )
}
