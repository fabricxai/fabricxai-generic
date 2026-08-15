'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { Ident } from '@/components/fx/format'
import { Badge, Button } from '@/components/fx/primitives'
import { markPmDone } from '@/modules/maintenance/actions'
import { unwrap } from '@/lib/action-failure'

interface Row {
  scheduleId: string
  machineId: string
  machineType: string
  brand: string | null
  serial: string | null
  lineCode: string | null
  cadence: string
  dueOn: string
  daysOverdue: number
  neverServiced: boolean
  checklist: string[]
}

type Tick = { ok: boolean | null; note: string }

/**
 * Sign a preventive-maintenance visit off, check by check.
 *
 * **A step can be passed, failed, or not yet answered — three states, not two.** A checkbox
 * has two, and its unchecked state means both "I looked and it was wrong" and "I have not
 * looked". Those are the two things a service record most needs to tell apart: the first is
 * a fault somebody should raise a ticket for, the second is an unfinished job. Every step
 * starts unanswered and the visit cannot be filed until each one is either.
 *
 * **A failed step is recorded, not blocked.** The mechanic still files the visit — the
 * record is what was found, and hiding a failure to keep the sheet clean is exactly how a
 * machine ends up "serviced" and broken. The screen says a failure needs a ticket, and
 * leaves raising it to the person who saw it.
 *
 * **Re-filing the same visit is safe.** `completePm` dedupes on (machine, schedule, day) and
 * returns `alreadyRecorded` — a second tap on a handset is not a second service, and the
 * screen says which happened rather than showing a success either way.
 */
export function PmChecklist({ rows, today }: { rows: readonly Row[]; today: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [openId, setOpenId] = useState<string | null>(null)
  const [ticks, setTicks] = useState<Record<number, Tick>>({})
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const key = (row: Row) => `${row.machineId}|${row.scheduleId}`

  function open(row: Row) {
    const id = key(row)
    setOpenId(openId === id ? null : id)
    setTicks(Object.fromEntries(row.checklist.map((_, i) => [i, { ok: null, note: '' }])))
    setFailure(null)
  }

  function file(row: Row) {
    const answered = row.checklist.every((_, i) => ticks[i]?.ok !== null && ticks[i]?.ok !== undefined)
    if (!answered) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await markPmDone({
          scheduleId: row.scheduleId,
          machineId: row.machineId,
          completedOn: today,
          checked: row.checklist.map((step, i) => ({
            step,
            ok: ticks[i]?.ok === true,
            ...(ticks[i]?.note.trim() ? { note: ticks[i]!.note.trim() } : {}),
          })),
          }),
        )

        setDone(
          result.alreadyRecorded
            ? `${row.machineType} was already signed off today — nothing was recorded twice.`
            : `${row.machineType} signed off for ${today}.`,
        )
        setOpenId(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The service was not recorded.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {done ? <InlineAlert tone="success">{done}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {rows.map((row) => {
        const id = key(row)
        const isOpen = openId === id
        const answered = row.checklist.filter((_, i) => ticks[i]?.ok != null).length
        const failed = row.checklist.filter((_, i) => ticks[i]?.ok === false).length

        return (
          <div key={id} style={surface}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap' }}>
              <span style={{ font: "500 15px/1.3 var(--fx-font-sans)" }}>{row.machineType}</span>

              {row.serial ? <Ident size={12}>{row.serial}</Ident> : null}
              {row.brand ? (
                <span
                  style={{
                    font: "400 13px/1.3 var(--fx-font-sans)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {row.brand}
                </span>
              ) : null}

              <Badge tone="neutral">{row.cadence}</Badge>
              {row.lineCode ? <Badge tone="neutral">{row.lineCode}</Badge> : <Badge tone="warning">no line</Badge>}

              {/* Never serviced outranks days-overdue in the telling: "1,240 days overdue"
                  on a machine registered last week is arithmetic, not a fact. */}
              {row.neverServiced ? (
                <Badge tone="danger">never serviced</Badge>
              ) : row.daysOverdue > 0 ? (
                <Badge tone="danger">
                  {row.daysOverdue} {row.daysOverdue === 1 ? 'day' : 'days'} overdue
                </Badge>
              ) : (
                <Badge tone="warning">due today</Badge>
              )}

              <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
                {row.checklist.length === 0 ? (
                  <span
                    style={{
                      font: "400 12.5px/1.4 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    no checks written — cannot be signed off
                  </span>
                ) : (
                  <button onClick={() => open(row)} style={linkButton}>
                    {isOpen ? 'Close' : `Do the ${row.checklist.length} checks`}
                  </button>
                )}
              </span>
            </div>

            {isOpen ? (
              <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
                {row.checklist.map((step, i) => {
                  const tick = ticks[i] ?? { ok: null, note: '' }
                  return (
                    <div
                      key={step}
                      style={{
                        display: 'flex',
                        gap: 12,
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        paddingBottom: 10,
                        borderBottom: '1px solid var(--fx-border-subtle)',
                      }}
                    >
                      <span style={{ flex: '1 1 260px', font: "400 14px/1.5 var(--fx-font-sans)" }}>
                        {step}
                      </span>

                      {/* Three states. An unticked checkbox cannot tell "wrong" from
                          "not looked at yet", and those are the two a record must separate. */}
                      <span style={{ display: 'flex', gap: 6 }}>
                        <Choice
                          on={tick.ok === true}
                          tone="ok"
                          onClick={() => setTicks({ ...ticks, [i]: { ...tick, ok: true } })}
                        >
                          OK
                        </Choice>
                        <Choice
                          on={tick.ok === false}
                          tone="bad"
                          onClick={() => setTicks({ ...ticks, [i]: { ...tick, ok: false } })}
                        >
                          Not OK
                        </Choice>
                      </span>

                      <input
                        value={tick.note}
                        onChange={(e) => setTicks({ ...ticks, [i]: { ...tick, note: e.target.value } })}
                        placeholder={tick.ok === false ? 'what was wrong' : 'note (optional)'}
                        style={{ ...control, flex: '1 1 220px' }}
                      />
                    </div>
                  )
                })}

                {failed > 0 ? (
                  <InlineAlert tone="warning">
                    {failed} {failed === 1 ? 'check' : 'checks'} failed. File the visit anyway —
                    the record is what was found, and a clean sheet on a faulty machine is worse
                    than a failed one. Raise a ticket for what you found.
                  </InlineAlert>
                ) : null}

                <div style={{ display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                  <Button
                    variant="primary"
                    disabled={pending || answered < row.checklist.length}
                    onClick={() => file(row)}
                  >
                    {pending ? 'Filing…' : 'File the visit'}
                  </Button>
                  <span
                    style={{
                      font: "400 12px/1.5 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {answered} of {row.checklist.length} answered
                    {answered < row.checklist.length
                      ? ' — every step needs an answer before this can be filed'
                      : ` · recorded against ${today}`}
                  </span>
                </div>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function Choice({
  on,
  tone,
  onClick,
  children,
}: {
  on: boolean
  tone: 'ok' | 'bad'
  onClick: () => void
  children: React.ReactNode
}) {
  const accent = tone === 'ok' ? 'var(--fx-success)' : 'var(--fx-danger)'
  return (
    <button
      onClick={onClick}
      aria-pressed={on}
      style={{
        padding: '7px 14px',
        borderRadius: 'var(--fx-radius-sm)',
        border: `1px solid ${on ? accent : 'var(--fx-border-default)'}`,
        background: on ? `color-mix(in srgb, ${accent} 14%, transparent)` : 'transparent',
        color: on ? accent : 'var(--fx-text-secondary)',
        font: "500 12.5px/1.2 var(--fx-font-sans)",
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  )
}

const surface: React.CSSProperties = {
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
  borderRadius: 'var(--fx-radius-md)',
  padding: '14px 18px',
}

const control: React.CSSProperties = {
  minWidth: 0,
  padding: '8px 11px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-canvas)',
  color: 'var(--fx-text-primary)',
  font: "400 13px/1.4 var(--fx-font-sans)",
}

const linkButton: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: "400 13px/1.4 var(--fx-font-sans)",
  color: 'var(--fx-text-tertiary)',
  textDecoration: 'underline',
  cursor: 'pointer',
}
