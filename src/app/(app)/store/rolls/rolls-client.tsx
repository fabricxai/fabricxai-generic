'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import { Ident } from '@/components/fx/format'
import { useLocale, useT } from '@/components/fx/locale'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { draftStockAdjustment } from '@/modules/store/actions'
import type { RollRow } from '@/modules/store/queries'

/**
 * Rolls for one item, and the correction path.
 *
 * The reason codes are a fixed list rather than free text because "why" is what the
 * approver is judging — `damaged` and `miscount` are different conversations, and a note
 * saying "adjustment" tells them nothing. The free-text note is required on top of it, and
 * the zod schema refuses anything under ten characters: an adjustment without a stated
 * reason is a number somebody will have to explain to a customs officer later.
 */
const REASONS = [
  { code: 'miscount', labelKey: 'ui.store.reason_miscount' },
  { code: 'damaged', labelKey: 'ui.store.reason_damaged' },
  { code: 'shortage_on_receipt', labelKey: 'ui.store.reason_shortage_on_receipt' },
  { code: 'written_off', labelKey: 'ui.store.reason_written_off' },
  { code: 'found', labelKey: 'ui.store.reason_found' },
] as const

export function RollsClient({
  items,
  selectedItemId,
  rolls,
}: {
  items: readonly {
    itemId: string
    code: string
    name: string
    onHand: string
    unit: string
    rollCount: number
  }[]
  selectedItemId: string
  rolls: readonly RollRow[]
}) {
  const t = useT()
  const router = useRouter()
  const [adjusting, setAdjusting] = useState<RollRow | null>(null)
  const [returning, setReturning] = useState<RollRow | null>(null)
  const [drafted, setDrafted] = useState<string | null>(null)
  const [returned, setReturned] = useState<string | null>(null)
  /*
   * Shade filter (role audit 2.7c). The shade-mix warning names GROUPS — "this order
   * already drew shade A" — and this list then made the storekeeper hunt for them row by
   * row. Client state, not a URL param: the item picker reloads the page and a filter is
   * a glance, not a place.
   */
  const [shade, setShade] = useState<string | null>(null)

  const shadeGroups = [...new Set(rolls.map((roll) => roll.shadeGroup).filter(Boolean))] as string[]
  const shown = shade ? rolls.filter((roll) => roll.shadeGroup === shade) : rolls

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
      {drafted ? (
        <InlineAlert tone="success">
          {t('ui.store.adjust_drafted', { summary: drafted })}
        </InlineAlert>
      ) : null}

      {returned ? (
        <InlineAlert tone="success">{t('ui.store.return_queued', { roll: returned })}</InlineAlert>
      ) : null}

      {/* ── Item picker ──────────────────────────────────────────────────── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {items.map((item) => {
          const on = item.itemId === selectedItemId
          return (
            <button
              key={item.itemId}
              onClick={() => router.push(`/store/rolls?item=${item.itemId}`)}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                minHeight: 44,
                padding: '10px 14px',
                borderRadius: 'var(--fx-radius-full)',
                border: `1px solid ${on ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                background: on ? 'var(--fx-text-primary)' : 'transparent',
                color: on ? 'var(--fx-text-inverse)' : 'var(--fx-text-secondary)',
                cursor: 'pointer',
                font: "500 12.5px/1.3 var(--fx-font-sans)",
              }}
            >
              <span style={{ font: "500 12px/1 var(--fx-font-mono)" }}>{item.code}</span>
              {t.plural('ui.store.roll_count', item.rollCount)}
            </button>
          )
        })}
      </div>

      {/* ── The rolls ────────────────────────────────────────────────────── */}
      <SectionHeading eyebrow={t('ui.store.roll_lot_eyebrow')}>
        {t('ui.store.rolls_all_heading')}
      </SectionHeading>

      {shadeGroups.length > 1 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: -14 }}>
          {[null, ...shadeGroups].map((group) => {
            const on = shade === group
            return (
              <button
                key={group ?? 'all'}
                onClick={() => setShade(group)}
                style={{
                  minHeight: 'var(--fx-tap-min)',
                  padding: '8px 14px',
                  borderRadius: 'var(--fx-radius-sm)',
                  border: `1px solid ${on ? 'var(--fx-accent)' : 'var(--fx-border-default)'}`,
                  background: on ? 'var(--fx-accent-subtle)' : 'transparent',
                  color: 'var(--fx-text-primary)',
                  cursor: 'pointer',
                  font: "500 12.5px/1 var(--fx-font-sans)",
                }}
              >
                {group === null
                  ? t('ui.store.shade_all')
                  : t('ui.store.shade_label', { group })}
              </button>
            )
          })}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {shown.map((roll) => (
          <div
            key={roll.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.1fr 0.9fr 0.8fr 110px 100px 110px',
              gap: 12,
              alignItems: 'center',
              padding: '12px 16px',
              minHeight: 56,
              border: '1px solid var(--fx-border-subtle)',
              borderLeft: `3px solid ${roll.status === 'in_stock' ? 'transparent' : 'var(--fx-text-disabled)'}`,
              background: 'var(--fx-bg-surface)',
            }}
          >
            <Ident>{roll.rollNo}</Ident>
            <span style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {roll.shadeGroup
                ? t('ui.store.shade_label', { group: roll.shadeGroup })
                : t('ui.store.no_shade')}
              {roll.dyeLot ? ` · ${roll.dyeLot}` : ''}
            </span>
            <span style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {roll.challanNo} · {roll.receivedAt}
            </span>
            <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", textAlign: 'right' }}>
              {roll.qty} {roll.unit}
            </span>
            <span style={{ textAlign: 'center' }}>
              <Badge tone={roll.locationKind === 'bonded' ? 'warning' : 'neutral'}>
                {roll.locationCode}
              </Badge>
            </span>
            <span style={{ textAlign: 'right' }}>
              {roll.status === 'in_stock' ? (
                <Button variant="ghost" onClick={() => setAdjusting(roll)}>
                  {t('ui.store.adjust_button')}
                </Button>
              ) : roll.status === 'issued' ? (
                /* Cloth comes back — a lay finished short, a shade was wrong, a roll should
                   never have gone out. The machine has always allowed it; until now nothing
                   could make the move and the storekeeper's only option was to leave it. */
                <Button variant="ghost" onClick={() => setReturning(roll)}>
                  {t('ui.store.send_back')}
                </Button>
              ) : (
                <span style={{ font: "400 11.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                  {roll.status.replace('_', ' ')}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      {returning ? (
        <ReturnDialog
          roll={returning}
          onClose={() => setReturning(null)}
          onReturned={(summary) => {
            setReturning(null)
            setReturned(summary)
            router.refresh()
          }}
        />
      ) : null}

      {adjusting ? (
        <AdjustDialog
          roll={adjusting}
          itemId={selectedItemId}
          onClose={() => setAdjusting(null)}
          onDrafted={(summary) => {
            setAdjusting(null)
            setDrafted(summary)
            router.refresh()
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Sending a roll back to the rack.
 *
 * A floor write like receiving and issuing, so it goes through the offline batch endpoint
 * (rule 7) rather than a server action — the rack is where the signal is worst, and a
 * storekeeper holding a roll should not have to be online to record that it came back.
 *
 * The reason is a sentence, not a code. A return gives back a bonded draw, and what an
 * auditor reads months later is this line — "wrong shade for the lay" and "failed 4-point,
 * held for the mill claim" are different facts, and no fixed list would hold them both.
 */
function ReturnDialog({
  roll,
  onClose,
  onReturned,
}: {
  roll: RollRow
  onClose: () => void
  onReturned: (summary: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const { capture } = useOfflineQueue()
  const [reason, setReason] = useState('')
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)

  // Ten characters, the same floor the payload sets: the screen refuses first, at the one
  // moment somebody is looking, rather than after a round trip.
  const ready = reason.trim().length >= 10

  function send() {
    if (!ready) return
    setFailure(null)
    startTransition(async () => {
      try {
        await capture({
          moduleId: 'store',
          operation: 'return_rolls',
          payload: { rollIds: [roll.id], reason: reason.trim() },
        })
        onReturned(roll.rollNo)
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.store.return_failed'), locale))
      }
    })
  }

  return (
    <Modal open onClose={onClose} title={t('ui.store.return_title', { roll: roll.rollNo })}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

        {roll.udNumber ? (
          <InlineAlert tone="info">
            {t('ui.store.return_bonded_note', { ud: roll.udNumber })}
          </InlineAlert>
        ) : null}

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.store.return_reason_label')}
          </span>
          <textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder={t('ui.store.return_reason_placeholder')}
            style={{
              width: '100%',
              minWidth: 0,
              padding: '10px 12px',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-sm)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
              font: "400 14px/1.5 var(--fx-font-sans)",
              resize: 'vertical',
            }}
          />
          <span style={{ font: "400 12px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            {t('ui.store.return_hint')}
          </span>
        </label>

        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <Button variant="ghost" onClick={onClose}>
            {t('ui.common.cancel')}
          </Button>
          <Button variant="primary" disabled={!ready || pending} onClick={send}>
            {t('ui.store.return_submit')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

function AdjustDialog({
  roll,
  itemId,
  onClose,
  onDrafted,
}: {
  roll: RollRow
  itemId: string
  onClose: () => void
  onDrafted: (summary: string) => void
}) {
  const t = useT()
  const locale = useLocale()
  const [counted, setCounted] = useState('')
  const [reasonCode, setReasonCode] = useState<string>(REASONS[0].code)
  const [note, setNote] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // The storekeeper enters what they COUNTED, not a delta. Asking somebody at a rack to
  // work out "−12.50" from 100 and 87.5 is asking them to make an arithmetic mistake that
  // then goes to an approver as a fact.
  const countedQty = Number(counted)
  const valid = counted !== '' && Number.isFinite(countedQty) && countedQty >= 0
  const delta = valid ? countedQty - Number(roll.qty) : 0
  const noteTooShort = note.trim().length < 10

  function submit() {
    setError(null)
    if (!valid || delta === 0 || noteTooShort) return

    startTransition(async () => {
      try {
        await draftStockAdjustment({
          itemId,
          rollId: roll.id,
          qtyDelta: delta.toFixed(2),
          unit: roll.unit,
          reasonCode,
          note: note.trim(),
        })
        onDrafted(`${roll.rollNo} · ${delta > 0 ? '+' : ''}${delta.toFixed(2)} ${roll.unit}`)
      } catch (e) {
        setError(actionErrorMessage(e, t('ui.store.adjust_refused'), locale))
      }
    })
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={t('ui.store.adjust_title', { roll: roll.rollNo })}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('ui.common.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid || delta === 0 || noteTooShort || pending}
            onClick={submit}
          >
            {t('ui.store.adjust_submit')}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
          {[
            { label: t('ui.store.cell_system_says'), value: `${roll.qty} ${roll.unit}` },
            {
              label: t('ui.store.cell_you_counted'),
              value: valid ? `${countedQty.toFixed(2)} ${roll.unit}` : '—',
            },
            {
              label: t('ui.store.cell_difference'),
              value: valid ? `${delta > 0 ? '+' : ''}${delta.toFixed(2)} ${roll.unit}` : '—',
              tone: delta < 0 ? 'danger' : delta > 0 ? 'success' : 'plain',
            },
          ].map((cell) => (
            <div key={cell.label}>
              <div
                style={{
                  font: "400 11px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {cell.label}
              </div>
              <div
                style={{
                  marginTop: 6,
                  font: "600 19px/1.1 var(--fx-font-sans)",
                  color:
                    cell.tone === 'danger'
                      ? 'var(--fx-danger)'
                      : cell.tone === 'success'
                        ? 'var(--fx-success)'
                        : 'var(--fx-text-primary)',
                }}
              >
                {cell.value}
              </div>
            </div>
          ))}
        </div>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.store.field_counted_qty')}
          </span>
          <input
            inputMode="decimal"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
            placeholder={roll.qty}
            style={{
              minHeight: 44,
              padding: '10px 12px',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-sm)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
              font: "400 15px/1.4 var(--fx-font-mono)",
            }}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.store.field_reason')}
          </span>
          <select
            value={reasonCode}
            onChange={(e) => setReasonCode(e.target.value)}
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
            {REASONS.map((reason) => (
              <option key={reason.code} value={reason.code}>
                {t(reason.labelKey)}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
            {t('ui.store.field_what_happened')}
            {noteTooShort && note.length > 0 ? t('ui.store.note_too_short') : ''}
          </span>
          <textarea
            rows={3}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={t('ui.store.note_placeholder')}
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

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

        <InlineAlert tone="info">{t('ui.store.adjust_pending_note')}</InlineAlert>
      </div>
    </Modal>
  )
}
