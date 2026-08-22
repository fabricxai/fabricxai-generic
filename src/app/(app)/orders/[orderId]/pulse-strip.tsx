import type { Locale } from '@/lib/i18n'
import { t } from '@/lib/i18n'
import type { OrderPulse } from '@/modules/orders/service'

/**
 * The pulse strip — "the platform drives the user" (specs/order-centric-core.md §2).
 *
 * What the order waits for next, then what is in the way, worst first. Every line is a
 * fact `orderPulse` computed with an i18n key and its numbers; this only renders them,
 * which is what keeps the strip and a MARBIM narration of the same order from drifting
 * into two different stories.
 *
 * Nothing when there is nothing: an order in motion with no blocker shows the next
 * milestone alone, and a closed one shows no strip at all. A banner that is always
 * present is a banner nobody reads.
 */
export function PulseStrip({ pulse, locale }: { pulse: OrderPulse; locale: Locale }) {
  if (!pulse.next && pulse.facts.length === 0) return null

  const worst = pulse.facts.some((f) => f.severity === 'critical')
    ? 'critical'
    : pulse.facts.length > 0
      ? 'warning'
      : 'calm'

  const edge =
    worst === 'critical'
      ? 'var(--fx-danger)'
      : worst === 'warning'
        ? 'var(--fx-warning)'
        : 'var(--fx-border-default)'

  return (
    <section
      aria-label="What this order is waiting on"
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderLeft: `3px solid ${edge}`,
        borderRadius: 'var(--fx-radius-md)',
        padding: '14px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {pulse.next ? (
        <div style={{ font: '500 14px/1.45 var(--fx-font-sans)' }}>
          <span style={{ color: 'var(--fx-text-secondary)' }}>Next: </span>
          {pulse.next.name}
          {pulse.next.plannedDate ? (
            <span data-mono style={{ font: '400 13px/1.4 var(--fx-font-mono)', color: 'var(--fx-text-secondary)' }}>
              {' · '}
              {pulse.next.plannedDate}
              {/* Days-to is the number a merchandiser reacts to; negative means the
                  planned date has already passed and nobody has actualised it. */}
              {pulse.next.daysTo !== null
                ? pulse.next.daysTo >= 0
                  ? ` · in ${pulse.next.daysTo}d`
                  : ` · ${-pulse.next.daysTo}d overdue`
                : ''}
            </span>
          ) : null}
          {pulse.next.ownerRole ? (
            <span style={{ font: '400 13px/1.4 var(--fx-font-sans)', color: 'var(--fx-text-tertiary)' }}>
              {' · '}
              {pulse.next.ownerRole}
            </span>
          ) : null}
        </div>
      ) : null}

      {pulse.facts.map((fact) => (
        <div
          key={`${fact.key}:${JSON.stringify(fact.params)}`}
          style={{
            font: '400 13.5px/1.5 var(--fx-font-sans)',
            color:
              fact.severity === 'critical' ? 'var(--fx-danger)' : 'var(--fx-text-secondary)',
          }}
        >
          {t(locale, fact.key, fact.params)}
        </div>
      ))}
    </section>
  )
}
