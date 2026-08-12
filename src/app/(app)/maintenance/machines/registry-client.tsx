'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { ReadIntoForm, type ReadFields } from '@/components/shell/read-into-form'
import { actionErrorMessage } from '@/lib/action-error'
import { Ident } from '@/components/fx/format'
import { Badge, Button } from '@/components/fx/primitives'
import { DateInput } from '@/components/fx/forms'
import { addMachine, moveMachine } from '@/modules/maintenance/actions'
import { factoryToday } from '@/lib/dates'

interface Machine {
  id: string
  machineType: string
  brand: string | null
  model: string | null
  serial: string | null
  purchasedAt: string | null
  lineId: string | null
  lineCode: string | null
  openTickets: number
  assignmentHistory: { lineId: string; from: string | null; to: string | null }[]
}

interface Line {
  id: string
  code: string
  name: string | null
}

/**
 * The registry: add a machine, and move one between lines.
 *
 * **Moving asks for the date it moved, not today.** The floor is rebalanced on a Sunday and
 * entered on a Tuesday, and the assignment history is what attributes a breakdown to a line.
 * Stamping "now" would credit two days of one line's downtime to another — quietly, and in
 * the direction that makes whoever is entering it look better.
 *
 * **The serial is optional but pressed for.** A machine with no serial cannot be told apart
 * from its neighbour on a warranty claim, and its service history is unprovable. It is not a
 * required field because a factory registering forty machines on a Sunday afternoon will
 * type forty blanks rather than walk the floor — and forty machines with no serial is better
 * than none in the registry at all.
 */
export function MachineRegistry({
  machines,
  lines,
}: {
  machines: readonly Machine[]
  lines: readonly Line[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [adding, setAdding] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [movingId, setMovingId] = useState<string | null>(null)

  const [form, setForm] = useState({
    machineType: '',
    brand: '',
    model: '',
    serial: '',
    lineId: '',
  })

  const lineCode = (id: string) => lines.find((l) => l.id === id)?.code ?? 'a line since removed'

  function add() {
    if (!form.machineType.trim()) return
    setFailure(null)

    startTransition(async () => {
      try {
        await addMachine({
          machineType: form.machineType.trim(),
          ...(form.brand.trim() ? { brand: form.brand.trim() } : {}),
          ...(form.model.trim() ? { model: form.model.trim() } : {}),
          ...(form.serial.trim() ? { serial: form.serial.trim() } : {}),
          ...(form.lineId ? { lineId: form.lineId } : {}),
        })
        setNote(`${form.machineType.trim()} registered.`)
        setForm({ machineType: '', brand: '', model: '', serial: '', lineId: '' })
        setAdding(false)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The machine was not registered.'))
      }
    })
  }

  function move(machineId: string, lineId: string, on: string) {
    setFailure(null)
    startTransition(async () => {
      try {
        await moveMachine({ machineId, lineId: lineId === '' ? null : lineId, on })
        setMovingId(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The machine was not moved.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {note ? <InlineAlert tone="success">{note}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {/* ── Add ──────────────────────────────────────────────────────────── */}
      {adding ? (
        <div style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {/* Four hundred machines is four hundred of these typed off oily metal, and the
              serial — the field a spare part is ordered against — is the one that must be
              exact. The line stays a picker: where a machine stands is where somebody put
              it, not something stamped on the plate. */}
          <ReadIntoForm
            kindId="machine_nameplate"
            prompt="a photo of the nameplate"
            onFilled={(read: ReadFields) => {
              const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))
              setForm((prev) => ({
                ...prev,
                machineType: str(read.values.machineType) || prev.machineType,
                brand: str(read.values.brand) || prev.brand,
                model: str(read.values.model) || prev.model,
                serial: str(read.values.serial) || prev.serial,
              }))
            }}
          />

          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            <Field label="Type" required>
              <input
                value={form.machineType}
                onChange={(e) => setForm({ ...form, machineType: e.target.value })}
                placeholder="single needle lockstitch"
                style={{ ...control, width: 220 }}
              />
            </Field>
            <Field label="Brand">
              <input
                value={form.brand}
                onChange={(e) => setForm({ ...form, brand: e.target.value })}
                placeholder="Juki"
                style={{ ...control, width: 130 }}
              />
            </Field>
            <Field label="Model">
              <input
                value={form.model}
                onChange={(e) => setForm({ ...form, model: e.target.value })}
                placeholder="DDL-8700"
                style={{ ...control, width: 140 }}
              />
            </Field>
            <Field label="Serial">
              <input
                value={form.serial}
                onChange={(e) => setForm({ ...form, serial: e.target.value })}
                placeholder="off the plate"
                style={{ ...control, width: 160 }}
              />
            </Field>
            <Field label="Line">
              <select
                value={form.lineId}
                onChange={(e) => setForm({ ...form, lineId: e.target.value })}
                style={{ ...control, width: 150 }}
              >
                <option value="">No line yet</option>
                {lines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.code}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button variant="primary" disabled={!form.machineType.trim() || pending} onClick={add}>
              {pending ? 'Registering…' : 'Register it'}
            </Button>
            <button onClick={() => setAdding(false)} style={linkButton}>
              Cancel
            </button>
            <span
              style={{
                font: "400 12px/1.5 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              Only the type is required. A serial is what makes a warranty claim and a service
              history provable, so it is worth walking back for.
            </span>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="primary" onClick={() => setAdding(true)}>
            Register a machine
          </Button>
        </div>
      )}

      {/* ── The fleet ────────────────────────────────────────────────────── */}
      {machines.map((machine) => (
        <div key={machine.id} style={{ ...surface, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <span style={{ font: "500 15px/1.3 var(--fx-font-sans)" }}>{machine.machineType}</span>

            {machine.brand || machine.model ? (
              <span
                style={{
                  font: "400 13px/1.3 var(--fx-font-sans)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {[machine.brand, machine.model].filter(Boolean).join(' ')}
              </span>
            ) : null}

            {machine.serial ? (
              <Ident size={12}>{machine.serial}</Ident>
            ) : (
              <Badge tone="warning">no serial</Badge>
            )}

            {machine.lineCode ? (
              <Badge tone="neutral">{machine.lineCode}</Badge>
            ) : (
              // Said plainly: an unplaced machine's stoppages belong to no line, so they
              // vanish from every per-line downtime figure rather than showing as zero.
              <Badge tone="warning">on no line</Badge>
            )}

            {machine.openTickets > 0 ? (
              <Badge tone="danger">
                {machine.openTickets} open {machine.openTickets === 1 ? 'ticket' : 'tickets'}
              </Badge>
            ) : null}

            <span style={{ marginLeft: 'auto' }}>
              <button
                onClick={() => setMovingId(movingId === machine.id ? null : machine.id)}
                style={linkButton}
              >
                {movingId === machine.id ? 'Cancel' : 'Move it'}
              </button>
            </span>
          </div>

          {movingId === machine.id ? (
            <MoveRow
              lines={lines}
              currentLineId={machine.lineId}
              pending={pending}
              onMove={(lineId, on) => move(machine.id, lineId, on)}
            />
          ) : null}

          {machine.assignmentHistory.length > 1 ? (
            <div
              style={{
                font: "400 12px/1.6 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {/* Oldest first, as recorded. Appended, never rewritten. */}
              {machine.assignmentHistory
                .map(
                  (entry) =>
                    `${lineCode(entry.lineId)} ${entry.from ?? '?'} → ${entry.to ?? 'now'}`,
                )
                .join('  ·  ')}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

/**
 * Where and when.
 *
 * The date defaults to today because that is usually right, and is editable because it is
 * usually right rather than always — see the note on the component above.
 */
function MoveRow({
  lines,
  currentLineId,
  pending,
  onMove,
}: {
  lines: readonly Line[]
  currentLineId: string | null
  pending: boolean
  onMove: (lineId: string, on: string) => void
}) {
  const [lineId, setLineId] = useState(currentLineId ?? '')
  // Not `new Date()` during render — the clock is read once, in an effect-free initialiser.
  const [on, setOn] = useState(() => factoryToday())

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
      <Field label="Move to">
        <select value={lineId} onChange={(e) => setLineId(e.target.value)} style={{ ...control, width: 160 }}>
          <option value="">Take it off the floor</option>
          {lines.map((line) => (
            <option key={line.id} value={line.id}>
              {line.code}
            </option>
          ))}
        </select>
      </Field>

      <Field label="On">
        <DateInput value={on} onChange={setOn} style={{ ...control, width: 160 }} />
      </Field>

      <Button
        variant="secondary"
        disabled={pending || lineId === (currentLineId ?? '')}
        onClick={() => onMove(lineId, on)}
      >
        {pending ? 'Moving…' : 'Record the move'}
      </Button>

      <span
        style={{
          font: "400 12px/1.5 var(--fx-font-mono)",
          color: 'var(--fx-text-tertiary)',
          maxWidth: 380,
        }}
      >
        The date matters: downtime is attributed to whichever line the machine was on at the
        time, so a floor rebalanced on Sunday and entered on Tuesday needs Sunday&rsquo;s date.
      </span>
    </div>
  )
}

function Field({
  label,
  required,
  children,
}: {
  label: string
  required?: boolean
  children: React.ReactNode
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <span style={labelStyle}>
        {label}
        {required ? ' *' : ''}
      </span>
      {children}
    </label>
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
