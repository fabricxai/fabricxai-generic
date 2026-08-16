'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { Card } from '@/components/fx/data'
import { FloorScreen, NumpadInput, RejectedWrites, SyncPill } from '@/components/fx/floor'
import { useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { Eyebrow } from '@/components/fx/signature'
import { Modal } from '@/components/fx/feedback'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import type { Translator } from '@/lib/i18n-ui'
import type { LineRow } from '@/modules/production/queries'

/**
 * A `downtime_reason` as the word a supervisor reads, not as the column value.
 *
 * `openDowntime.reason` arrives as a plain string, so a sixth value added to the enum
 * without touching this screen renders raw rather than as a missing key — wrong-looking but
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

/**
 * The hourly board.
 *
 * Entry is offline-first: tapping Save writes to IndexedDB and returns
 * immediately. What the operator did is recorded the moment they did it; posting
 * it is the system's problem. The pill is the only honest signal of what has
 * actually reached the server.
 */
// `lines` used to be a prop here and was consumed by nothing but a
// `{lines.length === 0 ? null : null}` left over from an earlier draft. The page still
// needs the list for its own header count; this component works entirely from `rows`.
export function LineBoard({
  rows,
  producedOn,
  shiftHours,
  plannedTargetByLine = {},
}: {
  rows: LineRow[]
  producedOn: string
  shiftHours: number
  /** Today's planned target per line — a cell opens with it in the box (live-test papercut). */
  plannedTargetByLine?: Record<string, number>
}) {
  const t = useT()
  const { online, queued, refused, syncing, capture, sync, clear } = useOfflineQueue()
  const router = useRouter()
  const [entry, setEntry] = useState<{ line: LineRow; hour: number } | null>(null)

  const hourSlots = Array.from({ length: shiftHours }, (_, i) => i + 8)

  return (
    <FloorScreen>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />
          <span style={{ font: "400 14px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
            {t('ui.production.saved_here_first')}
          </span>
        </div>

        <RejectedWrites refused={refused} onDismiss={(k) => void clear(k)} />

        <Card padding={0}>
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 860 }}>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: `120px repeat(${hourSlots.length}, 1fr) 120px`,
                  gap: 8,
                  padding: '12px 18px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 12px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>{t('ui.production.col_line')}</div>
                {hourSlots.map((h) => (
                  <div key={h} style={{ textAlign: 'center' }}>
                    {h}:00
                  </div>
                ))}
                <div style={{ textAlign: 'right' }}>{t('ui.production.col_day')}</div>
              </div>

              {rows.map((row) => (
                <div
                  key={row.lineId}
                  className="fx-selvage"
                  data-status={
                    row.target === 0 ? undefined : row.variance < 0 ? 'at-risk' : 'on-track'
                  }
                  style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
                >
                  <div
                    style={{
                      flex: 1,
                      display: 'grid',
                      gridTemplateColumns: `120px repeat(${hourSlots.length}, 1fr) 120px`,
                      gap: 8,
                      padding: '10px 18px',
                      alignItems: 'center',
                      minHeight: 'var(--fx-row-height)',
                    }}
                  >
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      <span style={{ font: "600 17px/1.2 var(--fx-font-sans)" }}>{row.code}</span>
                      {row.openDowntime ? (
                        <span
                          style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-danger)' }}
                        >
                          {t('ui.production.stopped_reason', {
                            reason: downtimeReason(t, row.openDowntime.reason),
                          })}
                        </span>
                      ) : null}
                    </div>

                    {hourSlots.map((h) => {
                      const cell = row.hours.find((c) => c.hourSlot === h)
                      return (
                        <button
                          key={h}
                          onClick={() => setEntry({ line: row, hour: h })}
                          // The dot is decorative; the reason belongs in the button's name,
                          // or a screen-reader user has no way to know an hour was explained.
                          aria-label={
                            cell
                              ? `${row.code} ${h}:00 — ${cell.actual} of ${cell.target}${cell.remark ? `. ${cell.remark}` : ''}`
                              : `${row.code} ${h}:00 — not counted`
                          }
                          style={{
                            minHeight: 48,
                            borderRadius: 'var(--fx-radius-sm)',
                            border: '1px solid var(--fx-border-subtle)',
                            background: cell ? 'var(--fx-bg-surface)' : 'var(--fx-bg-sunken)',
                            cursor: 'pointer',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: 1,
                          }}
                        >
                          {cell ? (
                            <>
                              <span
                                data-numeric
                                style={{
                                  font: "600 17px/1 var(--fx-font-mono)",
                                  color:
                                    cell.actual < cell.target
                                      ? 'var(--fx-warning)'
                                      : 'var(--fx-text-primary)',
                                }}
                              >
                                {cell.actual}
                              </span>
                              <span
                                data-numeric
                                style={{
                                  font: "400 11px/1 var(--fx-font-mono)",
                                  color: 'var(--fx-text-tertiary)',
                                }}
                              >
                                /{cell.target}
                              </span>
                              {/*
                                * An hour with something said about it is marked, so a
                                * supervisor can see there is a reason to open rather than
                                * tapping twelve cells to find out. The remark itself is in
                                * the box — a cell is 48px and a sentence does not fit.
                                */}
                              {cell.remark ? (
                                <span
                                  aria-hidden
                                  style={{
                                    width: 4,
                                    height: 4,
                                    borderRadius: '50%',
                                    background: 'var(--fx-text-tertiary)',
                                  }}
                                />
                              ) : null}
                            </>
                          ) : (
                            /* Empty, not zero: nobody has said what happened
                               this hour, and a zero would say they made none. */
                            <span
                              style={{ font: "400 15px/1 var(--fx-font-mono)", color: 'var(--fx-text-disabled)' }}
                            >
                              —
                            </span>
                          )}
                        </button>
                      )
                    })}

                    <div
                      style={{
                        textAlign: 'right',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 2,
                      }}
                    >
                      <span data-numeric style={{ font: "600 18px/1.1 var(--fx-font-mono)" }}>
                        {row.actual}
                      </span>
                      <span
                        data-numeric
                        style={{
                          font: "400 12px/1.2 var(--fx-font-mono)",
                          color:
                            row.variance < 0
                              ? 'var(--fx-warning)'
                              : row.variance > 0
                                ? 'var(--fx-success)'
                                : 'var(--fx-text-tertiary)',
                        }}
                      >
                        {row.target === 0
                          ? t('ui.production.no_target')
                          : `${row.variance >= 0 ? '+' : ''}${row.variance} · ${row.achievedPct}%`}
                      </span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div
            style={{
              padding: '12px 18px',
              borderTop: '1px solid var(--fx-border-subtle)',
              font: "400 13px/1.4 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {t('ui.production.empty_hour_note')}
          </div>
        </Card>
      </div>

      <HourEntry
        key={entry ? `${entry.line.lineId}-${entry.hour}` : 'none'}
        entry={entry}
        producedOn={producedOn}
        plannedTarget={entry ? (plannedTargetByLine[entry.line.lineId] ?? null) : null}
        onClose={() => setEntry(null)}
        onSave={async (target, actual, remark) => {
          if (!entry) return
          await capture({
            moduleId: 'production',
            operation: 'record_hourly_outputs',
            payload: {
              entries: [
                {
                  lineId: entry.line.lineId,
                  producedOn,
                  hourSlot: entry.hour,
                  target: Number(target),
                  actual: Number(actual),
                  // Always sent from this box, empty string included: it is the one that
                  // asks, so silence here is a deliberate clear rather than no opinion.
                  remark,
                },
              ],
            },
          })
          setEntry(null)
          /*
           * Drain, then re-read — the same rule the hourly keypad already follows.
           *
           * `capture()` writes to the device and kicks the queue without waiting, so this
           * box used to close onto a board still showing the hour as never counted. The
           * write had landed; nothing on screen said so, and the only reasonable conclusion
           * is that it did not work — so the supervisor types it again. Now doubly true: a
           * remark typed here and then invisible is the discard this feature exists to end,
           * wearing a different hat (§9, F48).
           *
           * Offline, deliberately neither: the queue holds the write and `router.refresh()`
           * would re-fetch a page the network cannot serve, tearing down the screen the
           * person just saved on. The later sync is what refreshes the server's view.
           */
          if (online) {
            await sync()
            router.refresh()
          }
        }}
      />
    </FloorScreen>
  )
}

function HourEntry({
  entry,
  producedOn,
  plannedTarget,
  onClose,
  onSave,
}: {
  entry: { line: LineRow; hour: number } | null
  producedOn: string
  /** The day plan's target for this line, when one exists — the box opens holding it. */
  plannedTarget: number | null
  onClose: () => void
  onSave: (target: string, actual: string, remark: string) => Promise<void>
}) {
  const t = useT()
  const existing = entry?.line.hours.find((c) => c.hourSlot === entry.hour)
  // An already-counted hour keeps ITS recorded target; a fresh one opens with the plan's,
  // because the supervisor confirms the target, they do not re-derive it from memory.
  const [target, setTarget] = useState(
    existing ? String(existing.target) : plannedTarget !== null ? String(plannedTarget) : '',
  )
  const [actual, setActual] = useState(existing ? String(existing.actual) : '')
  /*
   * Why the hour went the way it did. Opens holding what is already on the row — the sheet
   * reading puts one here, and this is where it is read and corrected. Emptying the box
   * clears it, which is the one write that says so deliberately (§9, F43).
   */
  const [remark, setRemark] = useState(existing?.remark ?? '')
  const [busy, setBusy] = useState(false)

  if (!entry) return null

  const valid = /^\d+$/.test(target.trim()) && /^\d+$/.test(actual.trim())

  return (
    <Modal
      open
      onClose={onClose}
      width={420}
      title={`${entry.line.code} · ${entry.hour}:00`}
      footer={
        <>
          <Button variant="secondary" size="lg" onClick={onClose} disabled={busy}>
            {t('ui.common.cancel')}
          </Button>
          <Button
            variant="primary"
            size="lg"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onSave(target.trim(), actual.trim(), remark.trim())
              } finally {
                setBusy(false)
              }
            }}
          >
            {t('ui.common.save')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <Eyebrow>{producedOn}</Eyebrow>
        <NumpadInput
          label={t('ui.production.field_target_hour')}
          value={target}
          onChange={setTarget}
          unit={t('ui.production.unit_pcs')}
          autoFocus
        />
        <NumpadInput
          label={t('ui.production.field_actual')}
          value={actual}
          onChange={setActual}
          unit={t('ui.production.unit_pcs')}
        />
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.production.field_hour_remark')}
          </span>
          <input
            value={remark}
            onChange={(e) => setRemark(e.target.value)}
            maxLength={200}
            placeholder={t('ui.production.field_hour_remark_placeholder')}
            style={{
              minHeight: 'var(--fx-tap-min)',
              padding: '10px 12px',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-md)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
              font: "400 14px/1.4 var(--fx-font-sans)",
            }}
          />
          <span style={{ font: "400 12px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            {t('ui.production.field_hour_remark_hint')}
          </span>
        </label>
        <span style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
          {t('ui.production.saved_on_tablet_note')}
        </span>
      </div>
    </Modal>
  )
}
