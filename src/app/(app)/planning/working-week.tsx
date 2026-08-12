'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { setLineCalendar } from '@/modules/planning/actions'

/**
 * When these lines work.
 *
 * Every cell on the board is `shift_minutes` minus planned downtime, read from
 * `line_calendars` — and nothing in the product ever wrote that table. A factory that drew
 * its own eight lines through the setup screen got a grid that was blank forever, and the
 * board said so honestly ("a blank cell is a day the line is not working") without anybody
 * being able to do anything about it. Booking work then reported the pieces had nowhere to be
 * made, which was true.
 *
 * ## Friday, not Sunday
 *
 * The default working week is Saturday through Thursday with Friday off, because that is the
 * Bangladeshi week. A calendar UI that defaults to a Saturday-Sunday weekend makes every
 * factory using this product correct the same two checkboxes forever, and the one that forgets
 * has a board that promises Friday production it will not get.
 */

/** ISO weekday numbers, in the order a Bangladeshi week reads. */
const WEEK = [
  { iso: 6, label: 'Sat' },
  { iso: 7, label: 'Sun' },
  { iso: 1, label: 'Mon' },
  { iso: 2, label: 'Tue' },
  { iso: 3, label: 'Wed' },
  { iso: 4, label: 'Thu' },
  { iso: 5, label: 'Fri' },
] as const

const DEFAULT_WORKING = [6, 7, 1, 2, 3, 4]

export function WorkingWeekButton({
  lines,
  today,
  covered,
}: {
  lines: readonly { id: string; code: string; name: string }[]
  today: string
  /** How many of these lines already have any working day in the window. */
  covered: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const [picked, setPicked] = useState<string[]>(lines.map((l) => l.id))
  const [weekdays, setWeekdays] = useState<number[]>(DEFAULT_WORKING)
  const [from, setFrom] = useState(today)
  const [to, setTo] = useState(addMonths(today, 3))
  const [shift, setShift] = useState('480')
  const [downtime, setDowntime] = useState('30')
  const [manpower, setManpower] = useState('')

  // eslint-disable-next-line fabricxai/no-float-money -- minutes, not money
  const shiftMinutes = Number.parseInt(shift, 10) || 0
  // eslint-disable-next-line fabricxai/no-float-money -- minutes, not money
  const downMinutes = Number.parseInt(downtime, 10) || 0

  const ready =
    picked.length > 0 &&
    weekdays.length > 0 &&
    from !== '' &&
    to !== '' &&
    to >= from &&
    shiftMinutes > 0 &&
    downMinutes < shiftMinutes

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await setLineCalendar({
            lineIds: picked,
            from,
            to,
            weekdays,
            shiftMinutes,
            plannedDowntimeMinutes: downMinutes,
            // eslint-disable-next-line fabricxai/no-float-money -- people, not money
            ...(manpower.trim() ? { manpower: Number.parseInt(manpower, 10) } : {}),
          }),
        )
        setDone(`${result.lineDays.toLocaleString()} line-days set, ${result.from} to ${result.to}.`)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The working week was not saved.'))
      }
    })
  }

  if (lines.length === 0) return null

  return (
    <>
      <Button variant={covered === 0 ? 'primary' : 'ghost'} onClick={() => setOpen(true)}>
        {covered === 0 ? 'Set the working week' : 'Working week'}
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          setDone(null)
        }}
        width={620}
        title="When do these lines work?"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <p style={{ margin: 0, font: "400 13px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
            Every square on the board is one line on one day. A line with no working day has
            no capacity, so nothing can be planned onto it — this is where that is decided.
          </p>

          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <legend style={{ font: "500 13px/1.3 var(--fx-font-sans)", padding: 0 }}>Lines</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {lines.map((line) => {
                const on = picked.includes(line.id)
                return (
                  <button
                    key={line.id}
                    type="button"
                    onClick={() =>
                      setPicked((prev) =>
                        on ? prev.filter((id) => id !== line.id) : [...prev, line.id],
                      )
                    }
                    style={chip(on)}
                  >
                    {line.code}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <fieldset style={{ border: 0, margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <legend style={{ font: "500 13px/1.3 var(--fx-font-sans)", padding: 0 }}>Working days</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
              {WEEK.map((day) => {
                const on = weekdays.includes(day.iso)
                return (
                  <button
                    key={day.iso}
                    type="button"
                    onClick={() =>
                      setWeekdays((prev) =>
                        on ? prev.filter((d) => d !== day.iso) : [...prev, day.iso],
                      )
                    }
                    style={chip(on)}
                  >
                    {day.label}
                  </button>
                )
              })}
            </div>
          </fieldset>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Labelled label="From">
              <DateInput value={from} onChange={setFrom} style={BOX} />
            </Labelled>
            <Labelled label="Until">
              <DateInput value={to} onChange={setTo} style={BOX} />
            </Labelled>
          </div>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
            <TextInput
              label="Shift (minutes)"
              inputMode="numeric"
              value={shift}
              onChange={(e) => setShift(e.target.value)}
              hint="480 is an eight-hour shift."
            />
            <TextInput
              label="Planned downtime"
              inputMode="numeric"
              value={downtime}
              onChange={(e) => setDowntime(e.target.value)}
              hint="Changeover, maintenance, tea."
            />
            <TextInput
              label="Operators"
              inputMode="numeric"
              value={manpower}
              onChange={(e) => setManpower(e.target.value)}
              hint="Leave blank to use each line's own head count."
            />
          </div>

          {done ? <InlineAlert tone="success">{done}</InlineAlert> : null}
          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
          {downMinutes >= shiftMinutes && shiftMinutes > 0 ? (
            <InlineAlert tone="warning">
              Planned downtime has to be less than the shift, or the line earns nothing.
            </InlineAlert>
          ) : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {done ? 'Close' : 'Cancel'}
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              {pending ? 'Saving…' : 'Set the calendar'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function addMonths(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

const BOX: React.CSSProperties = {
  font: "400 15px/1.2 var(--fx-font-mono)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  width: '100%',
}

const chip = (on: boolean): React.CSSProperties => ({
  font: "500 13px/1 var(--fx-font-mono)",
  padding: '9px 13px',
  minHeight: 'var(--fx-tap-min)',
  borderRadius: 'var(--fx-radius-sm)',
  cursor: 'pointer',
  border: `1px solid ${on ? 'var(--fx-accent)' : 'var(--fx-border-default)'}`,
  background: on ? 'var(--fx-accent-subtle)' : 'var(--fx-bg-surface)',
  color: on ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
})

function Labelled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{label}</span>
      {children}
    </label>
  )
}
