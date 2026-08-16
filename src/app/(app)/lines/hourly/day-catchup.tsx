'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { Button } from '@/components/fx/primitives'
import { ReadIntoForm, type ReadFields } from '@/components/shell/read-into-form'
import { actionErrorMessage } from '@/lib/action-error'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import { whatTheLineRan } from '@/modules/production/actions'

/**
 * A whole day off the clipboard, at the end of the day.
 *
 * The hourly screen is one hour across every line — right for a supervisor with a tablet at
 * the machine, which is how it is meant to work. It is not how it does work. Every sewing
 * line in Bangladesh keeps a paper hourly report, because paper works when the network does
 * not and the supervisor already trusts it, and what actually happens is somebody typing
 * eleven rows off that sheet at seven in the evening — the moment they are least able to.
 *
 * This is the other shape: one line, a whole day, read off a photograph of the sheet.
 *
 * ## Why the hours are shown before anything is saved
 *
 * "2-3" on a Bangladeshi sheet is two in the afternoon, and a reading that took it for two
 * in the morning would file an afternoon's output where nothing was made and nobody looks.
 * So every hour it read is listed, in words, with its output — and the supervisor confirms a
 * day they can see rather than a number they cannot.
 *
 * ## It goes through the offline queue, like every other floor write
 *
 * Not because this is likely to be used offline — it is used at a desk — but because the
 * queue is what makes a floor write idempotent. Somebody who taps twice on a bad connection
 * must not book the day twice.
 */

export interface CatchupLine {
  lineId: string
  code: string
}

/** What the day will be attached to, once the line and the date are both known. */
type Attachment =
  | { state: 'unknown' }
  | { state: 'asking' }
  | { state: 'planned'; label: string }
  | { state: 'none' }

interface ReadHour {
  hourSlot: number
  actual: number
  target: number | null
  remark: string | null
}

export function DayCatchupButton({ lines }: { lines: readonly CatchupLine[] }) {
  const router = useRouter()
  const { capture, online, sync } = useOfflineQueue()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [lineId, setLineId] = useState('')
  const [producedOn, setProducedOn] = useState('')
  const [hours, setHours] = useState<ReadHour[]>([])

  const [answer, setAnswer] = useState<{ key: string; value: Attachment } | null>(null)

  const line = lines.find((l) => l.lineId === lineId) ?? null
  const ready = line !== null && producedOn !== '' && hours.length > 0

  /*
   * Which order this day belongs to, asked for the DAY BEING ENTERED.
   *
   * The dialog used to send the order the line is running TODAY, which for a sheet from last
   * Tuesday is either nothing or the wrong order (§9, F44). The write no longer takes the
   * client's word for it — the service resolves the plan for `producedOn` itself — so this
   * asks only in order to say so, before anything is saved.
   *
   * Keyed on the line-day it asked about, and derived rather than assigned: an answer for
   * L3 can never be left on screen after the supervisor picks L4, and nothing sets state
   * synchronously in the effect.
   */
  const askKey = lineId !== '' && producedOn !== '' ? `${lineId}|${producedOn}` : null

  const attachment: Attachment =
    askKey === null
      ? { state: 'unknown' }
      : answer?.key === askKey
        ? answer.value
        : { state: 'asking' }

  useEffect(() => {
    if (askKey === null) return

    let live = true

    void whatTheLineRan({ lineId, planDate: producedOn })
      .then((result) => {
        if (!live) return
        // A refusal or a failure is not "nothing was planned" — stay quiet rather than claim
        // the day is unattached when we simply could not find out.
        const value: Attachment =
          result === null
            ? { state: 'none' }
            : 'label' in result
              ? { state: 'planned', label: result.label }
              : { state: 'unknown' }
        setAnswer({ key: askKey, value })
      })
      .catch(() => {
        if (live) setAnswer({ key: askKey, value: { state: 'unknown' } })
      })

    return () => {
      live = false
    }
  }, [askKey, lineId, producedOn])

  function fill(read: ReadFields) {
    const v = read.values
    const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))
    const num = (x: unknown) => {
      const parsed = Number(str(x))
      return Number.isFinite(parsed) ? Math.trunc(parsed) : null
    }

    if (v.producedOn !== undefined) setProducedOn(str(v.producedOn))

    /*
     * The line the sheet names, matched loosely on purpose.
     *
     * A supervisor writes "L-1" at the top of a sheet for the line this system calls "L1".
     * Comparing on digits and letters alone gets both, and there is no ambiguity to protect
     * against here the way there is with materials: a factory has eight lines, not eight
     * hundred items, and the code is right there in the picker beside it.
     */
    const wanted = str(v.lineCode).toLowerCase().replace(/[^a-z0-9]/g, '')
    const match = lines.find((l) => l.code.toLowerCase().replace(/[^a-z0-9]/g, '') === wanted)
    if (match) setLineId(match.lineId)

    const perHour = num(v.targetPerHour)
    const readHours = Array.isArray(v.hours) ? (v.hours as Record<string, unknown>[]) : []
    const parsed = readHours
      .map((row) => ({
        hourSlot: num(row.hourSlot),
        actual: num(row.actual),
        target: num(row.target) ?? perHour,
        remark: str(row.remark) || null,
      }))
      .filter((row): row is ReadHour => row.hourSlot !== null && row.actual !== null)
    setHours(parsed)

    const notes: string[] = []
    if (!match && wanted) {
      notes.push(`The sheet says line “${str(v.lineCode)}”, which is not one of yours — pick it below.`)
    }
    if (v.reference) {
      // Said rather than used: which order an hour belongs to is settled by the plan for the
      // day, not by what somebody wrote at the top of a page. What it IS attached to is shown
      // below, resolved for that date.
      notes.push(`The sheet names ${str(v.reference)}.`)
    }
    setNote(notes.length > 0 ? notes.join(' ') : null)
  }

  function submit() {
    if (!ready || !line) return
    setFailure(null)

    startTransition(async () => {
      try {
        await capture({
          moduleId: 'production',
          operation: 'record_hourly_outputs',
          payload: {
            // No orderId. This dialog enters a day that has already happened, and the only
            // thing that knows which order that day belongs to is the plan for that date —
            // which the service reads. Sending today's order here is what attached a whole
            // day to the wrong one (§9, F44).
            entries: hours.map((hour) => ({
              lineId: line.lineId,
              producedOn,
              hourSlot: hour.hourSlot,
              target: hour.target ?? 0,
              actual: hour.actual,
            })),
          },
        })
        if (online) await sync()
        setOpen(false)
        setHours([])
        setNote(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, "The day's hours were not saved."))
      }
    })
  }

  if (lines.length === 0) return null

  const total = hours.reduce((sum, hour) => sum + hour.actual, 0)

  return (
    <>
      <Button variant="ghost" onClick={() => setOpen(true)}>
        Catch up a whole day
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        width={620}
        title="A day off the hourly sheet"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ReadIntoForm kindId="hourly_sheet" prompt="the line's hourly sheet" onFilled={fill} />
          {note ? <InlineAlert tone="warning">{note}</InlineAlert> : null}

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Line</span>
              <select value={lineId} onChange={(e) => setLineId(e.target.value)} style={BOX}>
                <option value="">Choose the line</option>
                {lines.map((l) => (
                  <option key={l.lineId} value={l.lineId}>
                    {l.code}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Day</span>
              <span style={{ ...BOX, font: "400 14px/1.4 var(--fx-font-mono)", display: 'flex', alignItems: 'center' }}>
                {producedOn || '—'}
              </span>
            </label>
          </div>

          {/*
            * What the day attaches to, for the date on the sheet. A day booked against
            * nothing is invisible to the order it was sewn for and to WIP, and it used to
            * happen without a word (§9, F44).
            */}
          {attachment.state === 'planned' ? (
            <InlineAlert tone="info">
              This day goes against <strong>{attachment.label}</strong> — what {line?.code ?? 'the line'} was
              planned to run on {producedOn}.
            </InlineAlert>
          ) : null}
          {attachment.state === 'none' ? (
            <InlineAlert tone="warning">
              Nothing was planned for {line?.code ?? 'this line'} on {producedOn}, so these hours
              will be recorded against no order — the pieces will not count towards one. Plan
              that day on the line board first if they should.
            </InlineAlert>
          ) : null}

          {hours.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {hours.length} hours · {total.toLocaleString()} pieces
              </span>
              <div
                style={{
                  border: '1px solid var(--fx-border-subtle)',
                  borderRadius: 'var(--fx-radius-md)',
                  overflow: 'hidden',
                }}
              >
                {hours.map((hour) => (
                  <div
                    key={hour.hourSlot}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '110px 80px 1fr',
                      gap: 10,
                      padding: '8px 12px',
                      borderTop: '1px solid var(--fx-border-subtle)',
                      font: "400 13px/1.4 var(--fx-font-mono)",
                      color: 'var(--fx-text-secondary)',
                    }}
                  >
                    {/* In words, so an afternoon read as a morning is obvious on sight. */}
                    <span>{bandLabel(hour.hourSlot)}</span>
                    <span style={{ color: 'var(--fx-text-primary)' }}>{hour.actual}</span>
                    <span style={{ color: 'var(--fx-text-tertiary)' }}>{hour.remark ?? ''}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <p style={{ margin: 0, font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
              Drop the sheet above and every hour on it appears here to check before it is
              saved.
            </p>
          )}

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              {pending ? 'Saving…' : `Save ${hours.length} hours`}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

/** 14 → "2–3 pm". The band as the floor says it, so a misread hour is visible. */
function bandLabel(hourSlot: number): string {
  const twelve = (h: number) => (h % 12 === 0 ? 12 : h % 12)
  const suffix = hourSlot >= 12 ? 'pm' : 'am'
  return `${twelve(hourSlot)}–${twelve(hourSlot + 1)} ${suffix}`
}

const BOX: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  width: '100%',
}
