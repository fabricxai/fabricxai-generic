import Link from 'next/link'

import { StatusLabel } from '@/components/fx/signature'
import { milestoneLabel } from '@/components/fx/tna'
import type { Locale } from '@/lib/i18n'
import { FACTORY_TIMEZONE } from '@/lib/dates'
import type { WeekMilestone } from '@/modules/orders/queries'

/**
 * "This week" — every milestone on the desk's orders, by day (design canvas,
 * Merchandiser flow / "Your week").
 *
 * The order book says which orders are late. It has never said what a person is meant to
 * DO today, and that is the column the Excel order book had: sorted by date, read down,
 * work from the top. Losing it is why the spreadsheet outlived its replacement on more
 * than one desk.
 *
 * A day is a column and a milestone is a line inside it, so the week reads at arm's
 * length. Status is said three ways — colour on the selvage, the word in the label, the
 * position in the week — because a floor manager reading over somebody's shoulder in
 * daylight gets colour last if at all.
 *
 * Every line names the department that owes it. A merchandiser is accountable for the
 * order, not for their own rows in it: trims landing late is store's task and the
 * merchandiser's problem, and a week that showed only their own tasks would be a
 * calendar of the things already under control.
 */
const STATUS: Record<string, { tone: 'on-track' | 'at-risk' | 'late' | 'done'; word: string }> = {
  done: { tone: 'done', word: 'done' },
  late: { tone: 'late', word: 'late' },
  at_risk: { tone: 'at-risk', word: 'at risk' },
  on_track: { tone: 'on-track', word: 'on track' },
  pending: { tone: 'on-track', word: 'planned' },
}

const dayName = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: FACTORY_TIMEZONE,
    weekday: 'short',
    day: 'numeric',
  }).format(new Date(`${iso}T00:00:00Z`))

/** The five working days from `from` — Bangladesh works Sunday to Thursday, so the
    window is whatever the caller hands over, not a hardcoded Monday. */
export function weekDays(from: string, count: number): string[] {
  const start = Date.parse(`${from}T00:00:00Z`)
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  )
}

export function WeekStrip({
  days,
  milestones,
  today,
  locale,
}: {
  days: readonly string[]
  milestones: readonly WeekMilestone[]
  today: string
  locale: Locale
}) {
  const byDay = new Map<string, WeekMilestone[]>()
  for (const milestone of milestones) {
    byDay.set(milestone.plannedDate, [...(byDay.get(milestone.plannedDate) ?? []), milestone])
  }

  if (milestones.length === 0) {
    return (
      <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
        Nothing is due on any order this week. Milestones appear here from each order&rsquo;s
        time and action plan.
      </p>
    )
  }

  return (
    <div
      className="fx-scroll-x"
      tabIndex={0}
      style={{ display: 'flex', gap: 12, alignItems: 'stretch', paddingBottom: 4 }}
    >
      {days.map((day) => {
        const rows = byDay.get(day) ?? []
        const isToday = day === today

        return (
          <div
            key={day}
            style={{
              flex: '1 0 190px',
              minWidth: 190,
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              padding: '12px 14px',
              background: isToday ? 'var(--fx-bg-sunken)' : 'var(--fx-bg-surface)',
              border: `1px solid ${isToday ? 'var(--fx-border-default)' : 'var(--fx-border-subtle)'}`,
              borderRadius: 'var(--fx-radius-md)',
            }}
          >
            <div
              style={{
                font: '500 11px/1 var(--fx-font-mono)',
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: isToday ? 'var(--fx-text-primary)' : 'var(--fx-text-tertiary)',
              }}
            >
              {dayName(day)}
              {isToday ? ' · today' : ''}
            </div>

            {rows.length === 0 ? (
              <span
                style={{ font: '400 12.5px/1.4 var(--fx-font-sans)', color: 'var(--fx-text-tertiary)' }}
              >
                nothing due
              </span>
            ) : (
              rows.map((row) => {
                const status = STATUS[row.status] ?? STATUS.pending!
                return (
                  <Link
                    key={row.id}
                    href={`/orders/${row.orderId}`}
                    className="fx-selvage"
                    data-status={status.tone}
                    data-critical={row.status === 'late' || undefined}
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 3,
                      padding: '8px 10px',
                      textDecoration: 'none',
                      color: 'inherit',
                      background: 'var(--fx-bg-surface)',
                      border: '1px solid var(--fx-border-subtle)',
                      borderRadius: 'var(--fx-radius-sm)',
                    }}
                  >
                    <span
                      style={{
                        display: 'flex',
                        gap: 8,
                        alignItems: 'baseline',
                        justifyContent: 'space-between',
                      }}
                    >
                      <span style={{ font: '500 13px/1.35 var(--fx-font-sans)' }}>
                        {milestoneLabel(row.name, locale)}
                      </span>
                      <StatusLabel status={status.tone}>{status.word}</StatusLabel>
                    </span>
                    <span
                      style={{
                        font: '400 12px/1.4 var(--fx-font-sans)',
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {[row.poNumber, row.buyerName, row.ownerRole].filter(Boolean).join(' · ')}
                    </span>
                  </Link>
                )
              })
            )}
          </div>
        )
      })}
    </div>
  )
}
