'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { NumpadInput, SyncPill } from '@/components/fx/floor'
import { useT } from '@/components/fx/locale'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import type { Translator } from '@/lib/i18n-ui'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'

interface LineRow {
  lineId: string
  code: string
  name: string
  /**
   * The day plan's target, or NULL when nothing was planned for this line today.
   *
   * Not zero. A target of zero is a number, and the screen printed it as if the office had
   * set it — while nothing measured against it: `achievedPct` needs a denominator, and the
   * day-close skips a line with no plan entirely. A supervisor entered a day's output
   * believing it was being counted and no figure was ever produced from it (§9, F47).
   */
  target: number | null
  orderId: string | null
  alreadyEntered: boolean
}

interface Stoppage {
  id: string
  lineId: string
  lineCode: string
  reason: string
  note: string | null
  startedAt: string
}

const REASONS = [
  { code: 'machine', labelKey: 'ui.production.reason_machine' },
  { code: 'feeding', labelKey: 'ui.production.reason_feeding' },
  { code: 'absent', labelKey: 'ui.production.reason_absent' },
  { code: 'power', labelKey: 'ui.production.reason_power' },
  { code: 'other', labelKey: 'ui.production.reason_other' },
] as const

/**
 * A `downtime_reason` as the word a supervisor reads, not as the column value.
 *
 * The short form, because it goes in a badge next to the line code. A sixth value added to
 * the enum without touching this screen renders raw rather than as a missing key — wrong but
 * readable, which on a floor tablet is the safer failure.
 */
const DOWNTIME_REASON_COPY: Record<string, string> = {
  machine: 'ui.production.downtime_machine',
  feeding: 'ui.production.downtime_feeding',
  absent: 'ui.production.downtime_absent',
  power: 'ui.production.downtime_power',
  other: 'ui.production.downtime_other',
}

function downtimeReason(t: Translator, reason: string): string {
  const key = DOWNTIME_REASON_COPY[reason]
  return key ? t(key) : reason
}

/** Whole minutes since a stoppage opened. */
function minutesSince(iso: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60_000))
}

/**
 * One number per line, for this hour.
 *
 * Entries are captured, never posted directly: the batch is idempotent on (line, hour), so
 * a tablet that loses the network mid-shift and replays an hour later produces the same
 * row rather than a second one.
 *
 * A stopped line is shown in the list rather than in a separate screen. The supervisor who
 * knows the line stopped is the one entering its zero, and asking them to navigate to log
 * it is how stoppages go unlogged and the day's lost minutes never add up.
 */
export function HourlyClient({
  producedOn,
  hour,
  lines,
  machines,
  stoppages,
}: {
  producedOn: string
  hour: number
  lines: readonly LineRow[]
  /** What a machine stoppage can name, so the ticket says which machine. */
  machines: readonly { id: string; label: string; lineId: string | null }[]
  stoppages: readonly Stoppage[]
}) {
  const t = useT()
  const router = useRouter()
  const { capture, online, queued, syncing, refused, sync, clear } = useOfflineQueue()

  const [entries, setEntries] = useState<Record<string, string>>({})
  const [sent, setSent] = useState<string | null>(null)
  const [stopping, setStopping] = useState<LineRow | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  const stoppedByLine = new Map(stoppages.map((s) => [s.lineId, s]))

  const filled = lines.filter((l) => (entries[l.lineId] ?? '').trim() !== '')
  // eslint-disable-next-line fabricxai/no-float-money -- floor keypad piece counts summed for the confirmation toast; integers, never money
  const total = filled.reduce((n, l) => n + (Number.parseInt(entries[l.lineId]!, 10) || 0), 0)

  async function submit() {
    if (filled.length === 0) return

    await capture({
      moduleId: 'production',
      operation: 'record_hourly_outputs',
      payload: {
        entries: filled.map((line) => ({
          lineId: line.lineId,
          ...(line.orderId ? { orderId: line.orderId } : {}),
          producedOn,
          hourSlot: hour,
          // No plan means no target to record against; the zod default stores 0, which is
          // what the column holds either way. What must not happen is the SCREEN calling
          // that zero a plan.
          target: line.target ?? 0,
          // eslint-disable-next-line fabricxai/no-float-money -- floor keypad piece count (integer), not money; NaN falls back to 0 and the server validates the payload
          actual: Number.parseInt(entries[line.lineId]!, 10) || 0,
        })),
      },
    })

    setSent(t.plural('ui.production.counted_summary', filled.length, { total }))
    setEntries({})
    /*
     * Refresh only when the write actually reached the server. Offline, the row lives in
     * the queue and this screen's local state already says so — router.refresh() would
     * re-fetch a page the network cannot serve and tear down the screen the person just
     * saved on (found by 4.2's airplane-mode gate; the queue had captured the write, the
     * person saw a blank page). The later sync is what refreshes the server's view.
     */
    if (online) {
      await sync()
      router.refresh()
    }
  }

  /**
   * Capture, drain, then re-read.
   *
   * `capture()` writes to the device and kicks the queue without waiting for it, so
   * refreshing straight after raced the flush: the supervisor logged a stoppage, the screen
   * came back unchanged, and the only reasonable conclusion is that it did not work. The
   * banner says what happened immediately; the refresh waits for the server to agree.
   */
  async function captureThenRefresh(
    write: { operation: string; payload: Record<string, unknown> },
    confirmation: string,
  ) {
    await capture({ moduleId: 'production', ...write })
    setNoted(confirmation)
    // Same rule as the hour save: no refresh against a network that is not there.
    if (online) {
      await sync()
      router.refresh()
    }
  }

  async function logStoppage(line: LineRow, reason: string, note: string, machineId: string) {
    setStopping(null)
    await captureThenRefresh(
      {
        operation: 'open_downtime',
        payload: {
          lineId: line.lineId,
          startedAt: new Date().toISOString(),
          reason,
          // Only a machine stoppage carries one — the ticket it raises is about THAT
          // machine, and a mechanic should not have to walk the floor to find out which.
          ...(reason === 'machine' && machineId ? { machineId } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        },
      },
      t('ui.production.stoppage_logged', {
        line: line.code,
        reason: downtimeReason(t, reason),
      }),
    )
  }

  async function resolveStoppage(stoppage: Stoppage) {
    await captureThenRefresh(
      {
        operation: 'close_downtime',
        payload: { downtimeId: stoppage.id, endedAt: new Date().toISOString() },
      },
      t('ui.production.stoppage_resolved', {
        line: stoppage.lineCode,
        minutes: minutesSince(stoppage.startedAt),
      }),
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />

      {refused.length > 0 ? (
        <InlineAlert tone="danger">
          {t.plural('ui.production.entries_refused', refused.length)}
          {refused.map((r) => (
            <button
              key={r.offlineKey}
              onClick={() => void clear(r.offlineKey)}
              style={{
                marginLeft: 8,
                background: 'transparent',
                border: 'none',
                textDecoration: 'underline',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {t('ui.common.dismiss')}
            </button>
          ))}
        </InlineAlert>
      ) : null}

      {noted ? <InlineAlert tone="info">{noted}</InlineAlert> : null}

      {sent ? (
        <InlineAlert tone="success">
          {t('ui.production.counted_done', { summary: sent })}{' '}
          {online ? t('ui.production.sent') : t('ui.production.held_offline')}
        </InlineAlert>
      ) : null}

      <SectionHeading
        eyebrow={t('ui.production.hour_range', { from: hour, to: hour + 1 })}
      >
        {t('ui.production.hourly_heading')}
      </SectionHeading>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {lines.map((line) => {
          const stopped = stoppedByLine.get(line.lineId)
          return (
            <div
              key={line.lineId}
              style={{
                display: 'grid',
                // minmax(0, …) so the flexible tracks may shrink past their content's
                // min-width — otherwise the numpad forces the row wider than the tablet.
                gridTemplateColumns: '110px minmax(0, 1fr) 150px minmax(0, 1fr)',
                gap: 14,
                alignItems: 'center',
                padding: '12px 18px',
                minHeight: 72,
                border: '1px solid var(--fx-border-subtle)',
                borderLeft: `3px solid ${stopped ? 'var(--fx-danger)' : 'transparent'}`,
                background: 'var(--fx-bg-surface)',
              }}
            >
              <div>
                <div style={{ font: "600 17px/1.2 var(--fx-font-sans)" }}>{line.code}</div>
                <div
                  style={{
                    font: "400 12px/1.3 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {line.target === null
                    ? t('ui.production.no_plan_today')
                    : t('ui.production.target_value', { target: line.target })}
                </div>
              </div>

              <div>
                {stopped ? (
                  <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                    <Badge tone="danger">
                      {t('ui.production.stopped_reason', {
                        reason: downtimeReason(t, stopped.reason),
                      })}
                    </Badge>
                    <span
                      style={{
                        font: "400 12.5px/1.3 var(--fx-font-mono)",
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {t('ui.production.minutes_value', {
                        minutes: minutesSince(stopped.startedAt),
                      })}
                    </span>
                  </span>
                ) : line.alreadyEntered ? (
                  <span
                    style={{
                      font: "400 12.5px/1.3 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {t('ui.production.already_counted')}
                  </span>
                ) : null}
              </div>

              <NumpadInput
                label={t('ui.production.line_output_label', { line: line.code })}
                value={entries[line.lineId] ?? ''}
                onChange={(next) => setEntries((e) => ({ ...e, [line.lineId]: next }))}
              />

              <div style={{ textAlign: 'right' }}>
                {stopped ? (
                  <Button variant="ghost" onClick={() => void resolveStoppage(stopped)}>
                    {t('ui.production.line_running_again')}
                  </Button>
                ) : (
                  <Button variant="ghost" onClick={() => setStopping(line)}>
                    {t('ui.production.log_stoppage')}
                  </Button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          {filled.length === 0
            ? t('ui.production.uncounted_hour_note')
            : t.plural('ui.production.counted_summary', filled.length, { total })}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button
            variant="primary"
            size="lg"
            disabled={filled.length === 0}
            onClick={() => void submit()}
          >
            {t('ui.production.save_hour_button', { hour })}
          </Button>
        </span>
      </div>

      {stopping ? (
        <StoppageDialog
          line={stopping}
          machines={machines}
          onClose={() => setStopping(null)}
          onLog={(reason, note, machineId) =>
            void logStoppage(stopping, reason, note, machineId)
          }
        />
      ) : null}
    </div>
  )
}

function StoppageDialog({
  line,
  machines,
  onClose,
  onLog,
}: {
  line: LineRow
  machines: readonly { id: string; label: string; lineId: string | null }[]
  onClose: () => void
  onLog: (reason: string, note: string, machineId: string) => void
}) {
  const t = useT()
  const [reason, setReason] = useState<string>(REASONS[0].code)
  const [note, setNote] = useState('')
  // This line's machines first — the one that stopped is almost always standing on it.
  const onThisLine = machines.filter((m) => m.lineId === line.lineId)
  const elsewhere = machines.filter((m) => m.lineId !== line.lineId)
  const [machineId, setMachineId] = useState(onThisLine[0]?.id ?? '')

  return (
    <Modal
      open
      onClose={onClose}
      title={t('ui.production.stoppage_title', { line: line.code })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('ui.common.cancel')}
          </Button>
          <Button
            variant="primary"
            // A machine stoppage without its machine is the ticket that says "machine not
            // identified" — the one thing the mechanic needed.
            disabled={reason === 'machine' && machineId === ''}
            onClick={() => onLog(reason, note, machineId)}
          >
            {t('ui.production.log_stoppage_button')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.production.field_why')}
          </span>
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={{
              minHeight: 44,
              padding: '10px 12px',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-sm)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
              font: "400 14px/1.4 var(--fx-font-sans)",
            }}
          >
            {REASONS.map((r) => (
              <option key={r.code} value={r.code}>
                {t(r.labelKey)}
              </option>
            ))}
          </select>
        </label>

        {reason === 'machine' ? (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
              {t('ui.production.field_which_machine')}
            </span>
            <select
              value={machineId}
              onChange={(e) => setMachineId(e.target.value)}
              style={{
                minHeight: 44,
                padding: '10px 12px',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-sm)',
                background: 'var(--fx-bg-surface)',
                color: 'var(--fx-text-primary)',
                font: "400 14px/1.4 var(--fx-font-sans)",
              }}
            >
              <option value="">{t('ui.production.choose_machine')}</option>
              {onThisLine.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
              {elsewhere.length > 0 ? (
                <optgroup label={t('ui.production.machines_elsewhere')}>
                  {elsewhere.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
        ) : null}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.production.field_what_happened')}
          </span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('ui.production.note_placeholder')}
            style={{
              padding: '10px 12px',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-sm)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
              font: "400 14px/1.5 var(--fx-font-sans)",
              resize: 'vertical',
            }}
          />
        </label>

        <InlineAlert tone="info">{t('ui.production.stoppage_note')}</InlineAlert>
      </div>
    </Modal>
  )
}
