'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { Badge, Button } from '@/components/fx/primitives'
import { savePmSchedule } from '@/modules/maintenance/actions'

type Cadence = 'daily' | 'weekly' | 'monthly'

interface Schedule {
  id: string
  machineType: string
  cadence: string
  checklist: string[]
  machines: number
}

/**
 * What gets checked on a type of machine, and how often.
 *
 * **Schedules are per TYPE, not per machine.** Twenty-four lockstitch heads share one
 * checklist; writing it per machine means twenty-four places to update when the check
 * changes, and twenty-three that get forgotten. The reach count on each row is how somebody
 * sees what a change is about to affect.
 *
 * **A schedule covering zero machines is shown, not hidden.** It almost always means the
 * machine type was typed differently here than in the registry — "overlock" against
 * "4-thread overlock" — and the schedule silently covers nothing while looking complete.
 *
 * **Editing never rewrites history.** `pm_completions` stores the steps actually checked on
 * the day, so changing a checklist changes what happens next, not what happened.
 */
export function ScheduleEditor({
  schedules,
  machineTypes,
}: {
  schedules: readonly Schedule[]
  machineTypes: readonly string[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [machineType, setMachineType] = useState('')
  const [cadence, setCadence] = useState<Cadence>('monthly')
  const [steps, setSteps] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const parsed = steps
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  const covers = machineTypes.includes(machineType)
  const ready = machineType.trim() !== '' && parsed.length > 0

  function load(schedule: Schedule) {
    setMachineType(schedule.machineType)
    setCadence(schedule.cadence as Cadence)
    setSteps(schedule.checklist.join('\n'))
    setOpen(true)
    setNote(null)
    setFailure(null)
  }

  function save() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = await savePmSchedule({ machineType: machineType.trim(), cadence, checklist: parsed })
        setNote(
          result.replaced
            ? `Replaced the ${cadence} checklist for ${machineType.trim()}. Services already recorded keep the steps that were checked on the day.`
            : `${cadence} schedule for ${machineType.trim()} created — every machine of that type is now on the list.`,
        )
        setMachineType('')
        setSteps('')
        setOpen(false)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The schedule was not saved.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {note ? <InlineAlert tone="success">{note}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {schedules.map((schedule) => (
        <div key={schedule.id} style={surface}>
          <div style={{ display: 'flex', gap: 13, alignItems: 'center', flexWrap: 'wrap' }}>
            <span style={{ font: "500 14.5px/1.3 var(--fx-font-sans)" }}>{schedule.machineType}</span>
            <Badge tone="neutral">{schedule.cadence}</Badge>
            <Badge tone="neutral">
              {schedule.checklist.length} {schedule.checklist.length === 1 ? 'check' : 'checks'}
            </Badge>

            {/* The typo detector. A schedule naming a type nobody owns looks complete and
                covers nothing at all. */}
            {schedule.machines === 0 ? (
              <Badge tone="warning">covers no machines — check the type name</Badge>
            ) : (
              <span
                style={{
                  font: "400 12.5px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {schedule.machines} {schedule.machines === 1 ? 'machine' : 'machines'}
              </span>
            )}

            <span style={{ marginLeft: 'auto' }}>
              <button onClick={() => load(schedule)} style={linkButton}>
                Edit the checks
              </button>
            </span>
          </div>

          <ol
            style={{
              margin: '10px 0 0',
              paddingLeft: 20,
              font: "400 13px/1.7 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
            }}
          >
            {schedule.checklist.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
      ))}

      {open ? (
        <div style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={labelStyle}>Machine type</span>
              <input
                value={machineType}
                onChange={(e) => setMachineType(e.target.value)}
                list="fx-machine-types"
                placeholder="4-thread overlock"
                style={{ ...control, width: 260 }}
              />
              {/* Typed against the registry's own vocabulary, because the match is exact —
                  "overlock" and "4-thread overlock" are two different types to `pmDue`. */}
              <datalist id="fx-machine-types">
                {machineTypes.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={labelStyle}>How often</span>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as Cadence)}
                style={{ ...control, width: 140 }}
              >
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
          </div>

          {machineType.trim() !== '' && !covers ? (
            <InlineAlert tone="warning">
              No machine in the registry is typed &ldquo;{machineType.trim()}&rdquo;. The match is
              exact, so this schedule would cover nothing until a machine is registered under
              that exact name.
            </InlineAlert>
          ) : null}

          <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <span style={labelStyle}>The checks — one per line</span>
            <textarea
              rows={6}
              value={steps}
              onChange={(e) => setSteps(e.target.value)}
              placeholder={'Clean and oil the hook\nCheck needle bar play\nInspect the belt for wear\nTest the thread trimmer'}
              style={{ ...control, resize: 'vertical', font: "400 13.5px/1.6 var(--fx-font-mono)" }}
            />
          </label>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={!ready || pending} onClick={save}>
              {pending ? 'Saving…' : `Save ${parsed.length} ${parsed.length === 1 ? 'check' : 'checks'}`}
            </Button>
            <button onClick={() => setOpen(false)} style={linkButton}>
              Cancel
            </button>
            <span style={{ font: "400 12px/1.5 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              One schedule per type and cadence — saving over an existing pair replaces its
              checks, and leaves services already recorded exactly as they were.
            </span>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            {schedules.length === 0 ? 'Write the first schedule' : 'Add a schedule'}
          </Button>
        </div>
      )}
    </div>
  )
}

const surface: React.CSSProperties = {
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
  borderRadius: 'var(--fx-radius-md)',
  padding: '14px 18px',
}

const labelStyle: React.CSSProperties = {
  font: "500 11px/1.3 var(--fx-font-mono)",
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: 'var(--fx-text-tertiary)',
}

const control: React.CSSProperties = {
  minWidth: 0,
  padding: '9px 11px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-canvas)',
  color: 'var(--fx-text-primary)',
  font: "400 13.5px/1.4 var(--fx-font-sans)",
}

const linkButton: React.CSSProperties = {
  // A text link is still a tap target — density-sized like every Button (plan 1.8/4.4).
  minHeight: 'var(--fx-tap-min)',
  display: 'inline-flex',
  alignItems: 'center',
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: "400 13px/1.4 var(--fx-font-sans)",
  color: 'var(--fx-text-tertiary)',
  textDecoration: 'underline',
  cursor: 'pointer',
}
