'use client'

import { useCallback, useEffect, useState, useTransition } from 'react'

import { Badge, Button } from '@/components/fx/primitives'
import { Card } from '@/components/fx/data'
import { EmptyState, InlineAlert, Modal, Toast } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { Eyebrow } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { GridSummary, humanise, looksLikeGrid } from '@/components/shell/reading-fields'
import { MarbimMark, type MarkState } from '@/components/fx/mark'
import { approveDraft, draftFields, rejectDraft } from '@/modules/approvals/actions'
import type { DraftDetail } from '@/modules/approvals/queries'

import {
  BATCH_CONCURRENCY,
  mapWithLimit,
  stillSelected,
  summariseBatch,
  type RowOutcome,
} from './batch'

/** The row shape the server page hands over — dates already serialised. */
export interface InboxRowView {
  id: string
  moduleId: string
  targetTable: string
  operation: string
  source: string
  createdAt: string
  ageHours: number
  weakestConfidence: number | null
  requiredRoles: string[]
  approvalsRequired: number
  approvals: number
  approvedByMe: boolean
  title: string
  reference: string | null
  fromModel: boolean
  aging: boolean
}

/**
 * Rejecting always asks for a reason, because the item goes back to whoever
 * drafted it and "rejected" with no reason is a dead end they cannot act on.
 */
const REASONS = [
  'Wrong figure read from the source',
  'Not what the buyer confirmed',
  'No capacity for this change',
  'Needs commercial or LC action first',
  'Duplicate of another pending item',
] as const

const EMPTY_CORRECTIONS: Record<string, unknown> = {}

export function ApproveInbox({
  rows,
  escalateAfterHours,
}: {
  rows: InboxRowView[]
  escalateAfterHours: number
}) {
  const [focus, setFocus] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [rejecting, setRejecting] = useState<InboxRowView | null>(null)
  const [toast, setToast] = useState<string>('')
  const [mark, setMark] = useState<MarkState>('rest')
  const [pending, startTransition] = useTransition()
  /** Per-row results of the last batch. Cleared by the reviewer, not by a timer. */
  const [outcomes, setOutcomes] = useState<RowOutcome<InboxRowView>[]>([])

  const flash = useCallback((message: string, state: MarkState = 'resolved') => {
    setToast(message)
    setMark(state)
    setTimeout(() => {
      setToast('')
      setMark('rest')
    }, 4400)
  }, [])

  /**
   * Corrections per row, held by the LIST rather than each row.
   *
   * Both ways to approve live up here — the Approve button and the keyboard `a`, which
   * signs the FOCUSED row — so corrections kept inside a row would be invisible to the
   * keyboard. A reviewer who fixed a ship date and pressed `a` would have signed the
   * uncorrected draft and been told it went through, which is worse than not offering the
   * edit at all.
   */
  const [corrections, setCorrections] = useState<Record<string, Record<string, unknown>>>({})

  const onApprove = useCallback(
    (row: InboxRowView) => {
      const rowCorrections = corrections[row.id]
      setMark('thinking')
      startTransition(async () => {
        try {
          const result = unwrap(await approveDraft({
            pendingChangeId: row.id,
            // Omitted rather than sent empty: `{}` and "nothing was corrected" are the same
            // fact, and the telemetry should not record an edit that did not happen.
            ...(rowCorrections && Object.keys(rowCorrections).length > 0
              ? { corrections: rowCorrections }
              : {}),
          }))
          flash(
            result.status === 'committed'
              ? `Approved and committed · ${row.title}`
              : `Approved · waiting on ${result.approvalsRequired - result.approvals} more signature(s)`,
          )
        } catch (error) {
          setMark('blocked')
          setToast(actionErrorMessage(error, 'That did not go through'))
        }
      })
    },
    // `corrections` is read inside, so it MUST be here: without it the callback closes over
    // whatever the map held when it was created, and `a` would sign a draft with the edits
    // the reviewer made two keystrokes ago — or none. The lint rule caught this.
    [flash, corrections],
  )

  // j/k to move, a to approve, r to reject, x to select. Desk screens are
  // keyboard-first: a merchandiser clearing 40 drafts should never need the mouse.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName)) return
      if (rejecting) return
      if (rows.length === 0) return

      const k = e.key.toLowerCase()
      const current = rows[Math.min(focus, rows.length - 1)]
      if (!current) return

      if (k === 'j') {
        e.preventDefault()
        setFocus((f) => Math.min(f + 1, rows.length - 1))
      } else if (k === 'k') {
        e.preventDefault()
        setFocus((f) => Math.max(f - 1, 0))
      } else if (k === 'a') {
        e.preventDefault()
        onApprove(current)
      } else if (k === 'r') {
        e.preventDefault()
        setRejecting(current)
      } else if (k === 'x') {
        e.preventDefault()
        setSelected((s) =>
          s.includes(current.id) ? s.filter((x) => x !== current.id) : [...s, current.id],
        )
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [rows, focus, rejecting, onApprove])

  if (rows.length === 0) {
    return (
      <EmptyState
        title="Nothing routed to you"
        body="Drafts appear here when a rule sends them to a role you hold. Your own work stays in its own module until then. Alerts from jobs live in the Alerts control up top — not here."
      />
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <KeyLegend />

      <BatchOutcomes outcomes={outcomes} onDismiss={() => setOutcomes([])} />

      <Card padding={0}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            padding: '13px 18px',
            borderBottom: '1px solid var(--fx-border-subtle)',
            flexWrap: 'wrap',
          }}
        >
          <label style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={selected.length > 0 && selected.length === rows.length}
              onChange={(e) => setSelected(e.target.checked ? rows.map((r) => r.id) : [])}
              style={{ width: 18, height: 18, accentColor: 'var(--fx-text-primary)' }}
            />
            <span style={{ font: "500 12.5px/1 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
              Select all
            </span>
          </label>
          <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
            {selected.length > 0
              ? `${selected.length} selected`
              : 'select rows to approve in one pass'}
          </span>

          {selected.length > 0 ? (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
              {/* With a selection live, the batch action owns the view's amber
                  moment and every per-row Approve falls back to outlined. */}
              <Button
                variant="primary"
                onClick={() => {
                  const batch = rows.filter((r) => selected.includes(r.id))
                  setOutcomes([])
                  setMark('thinking')
                  startTransition(async () => {
                    const settled = await mapWithLimit<InboxRowView, RowOutcome<InboxRowView>>(
                      batch,
                      BATCH_CONCURRENCY,
                      async (row) => {
                        try {
                          const result = unwrap(await approveDraft({ pendingChangeId: row.id }))
                          return result.status === 'committed'
                            ? { kind: 'committed', row }
                            : {
                                kind: 'awaiting',
                                row,
                                remaining: result.approvalsRequired - result.approvals,
                              }
                        } catch (error) {
                          // Kept per row. The batch used to discard every `reason`, so a
                          // reviewer was told three of forty failed and never which three
                          // or why — which leaves re-approving all forty as the only move.
                          return {
                            kind: 'failed',
                            row,
                            message: actionErrorMessage(error, 'That did not go through'),
                          }
                        }
                      },
                    )

                    setOutcomes(settled)

                    // Exactly what did not commit stays selected, so trying again is one
                    // click and never re-approves something that already went through.
                    // Clearing the selection up front — which is what this did — made a
                    // partial failure unrecoverable without picking the rows out by hand.
                    setSelected(stillSelected(settled))

                    const summary = summariseBatch(settled)
                    flash(summary.headline, summary.failed > 0 ? 'blocked' : 'resolved')
                  })
                }}
              >
                Approve {selected.length} selected
              </Button>
            </div>
          ) : null}
        </div>

        {rows.map((row, idx) => (
          <InboxRowItem
            key={row.id}
            row={row}
            focused={idx === focus}
            checked={selected.includes(row.id)}
            /* Exactly one amber fill in the list: the focused row's Approve,
               and only while no batch selection is competing for it. */
            primary={idx === focus && selected.length === 0}
            escalateAfterHours={escalateAfterHours}
            busy={pending}
            onFocus={() => setFocus(idx)}
            onCheck={() =>
              setSelected((s) =>
                s.includes(row.id) ? s.filter((x) => x !== row.id) : [...s, row.id],
              )
            }
            corrections={corrections[row.id] ?? EMPTY_CORRECTIONS}
            onCorrect={(field, value) =>
              setCorrections((prev) => {
                const forRow = { ...(prev[row.id] ?? {}) }
                // Restoring the drafted value REMOVES the correction rather than recording
                // an edit to the same value — otherwise a field a reviewer merely clicked
                // into would count as one they had fixed, and the extractor would be
                // scored for a mistake it did not make.
                if (value === undefined) delete forRow[field]
                else forRow[field] = value
                return { ...prev, [row.id]: forRow }
              })
            }
            onApprove={() => onApprove(row)}
            onReject={() => setRejecting(row)}
          />
        ))}

        <div
          style={{
            padding: '13px 18px',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <span style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
            <span style={{ width: 3, height: 13, background: 'var(--fx-danger)' }} />
            <span style={{ font: "400 11px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              selvage = age · over {escalateAfterHours}h escalates
            </span>
          </span>
          <span
            style={{
              font: "400 12px/1.4 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
              marginLeft: 'auto',
            }}
          >
            rejecting always asks for a reason — it goes back to the drafter
          </span>
        </div>
      </Card>

      <RejectDialog
        // Keyed on the row so the reason and note reset for each item rather
        // than carrying a previous rejection's text into the next one.
        key={rejecting?.id ?? 'none'}
        row={rejecting}
        onClose={() => setRejecting(null)}
        onDone={(title) => {
          setRejecting(null)
          flash(`Rejected · ${title} sent back to the drafter`)
        }}
      />

      {/* The mark sits bottom-right in whichever of its six states fits. */}
      <div style={{ position: 'fixed', right: 28, bottom: 28, zIndex: 40 }}>
        <MarbimMark state={mark} size={32} label={null} />
      </div>

      {toast ? (
        <div style={{ position: 'fixed', left: 28, bottom: 28, zIndex: 50, maxWidth: 460 }}>
          <Toast message={toast} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * What the batch did, row by row.
 *
 * Shown only when something did NOT simply commit. A panel listing forty successes is noise
 * a reviewer learns to close without reading, and the next time it carries a refusal they
 * close that too. The toast already carries the headline; this exists to name the ones that
 * need a second look and say what stopped them.
 *
 * Dismissed by the reviewer rather than on a timer: a refusal that disappears after four
 * seconds while somebody is reading the row it names is a refusal they have to reproduce.
 */
function BatchOutcomes({
  outcomes,
  onDismiss,
}: {
  outcomes: RowOutcome<InboxRowView>[]
  onDismiss: () => void
}) {
  const unresolved = outcomes.filter((o) => o.kind !== 'committed')
  if (unresolved.length === 0) return null

  const failed = unresolved.filter((o) => o.kind === 'failed').length
  const committed = outcomes.length - unresolved.length

  return (
    <InlineAlert
      tone={failed > 0 ? 'danger' : 'warning'}
      action={
        <Button variant="ghost" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ font: "600 13px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
          {committed} of {outcomes.length} committed. These did not:
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {unresolved.map((outcome) => (
            <li key={outcome.row.id} style={{ font: "400 13px/1.45 var(--fx-font-sans)" }}>
              <span style={{ color: 'var(--fx-text-primary)', fontWeight: 500 }}>
                {outcome.row.title}
              </span>
              {outcome.row.reference ? (
                <span style={{ color: 'var(--fx-text-tertiary)' }}> · {outcome.row.reference}</span>
              ) : null}
              <span style={{ color: 'var(--fx-text-secondary)' }}>
                {' — '}
                {outcome.kind === 'awaiting'
                  ? `your approval is recorded; waiting on ${outcome.remaining} more signature(s)`
                  : outcome.message}
              </span>
            </li>
          ))}
        </ul>
        <div style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          these rows are still selected — nothing already committed will be approved twice
        </div>
      </div>
    </InlineAlert>
  )
}

function InboxRowItem({
  row,
  focused,
  checked,
  primary,
  escalateAfterHours,
  busy,
  onFocus,
  onCheck,
  onApprove,
  corrections,
  onCorrect,
  onReject,
}: {
  row: InboxRowView
  focused: boolean
  checked: boolean
  primary: boolean
  escalateAfterHours: number
  busy: boolean
  onFocus: () => void
  onCheck: () => void
  onApprove: () => void
  /** field → the reviewer's replacement, owned by the list so `a` can see it too. */
  corrections: Record<string, unknown>
  onCorrect: (field: string, value: unknown) => void
  onReject: () => void
}) {
  /**
   * The fields, fetched when the row is opened.
   *
   * `undefined` is "not asked for yet", `null` is "asked, and the draft was gone" — a draft
   * somebody else decided while this list sat open. Collapsing the two would show an empty
   * field list for a draft that no longer exists, which reads as "this writes nothing".
   */
  const [fields, setFields] = useState<DraftDetail | null | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [open, setOpen] = useState(false)


  function toggle() {
    const next = !open
    setOpen(next)
    if (!next || fields !== undefined || loading) return

    setLoading(true)
    void draftFields({ pendingChangeId: row.id })
      .then(setFields)
      .catch(() => setFields(null))
      .finally(() => setLoading(false))
  }

  const atRisk = row.ageHours >= escalateAfterHours
  const ageing = !atRisk && row.ageHours >= escalateAfterHours / 2

  const ageColour = atRisk
    ? 'var(--fx-danger)'
    : ageing
      ? 'var(--fx-warning)'
      : 'var(--fx-text-tertiary)'

  return (
    <div style={{ borderBottom: '1px solid var(--fx-border-subtle)' }}>
    <div
      onFocus={onFocus}
      onMouseEnter={onFocus}
      style={{
        display: 'flex',
        alignItems: 'stretch',
        background: focused ? 'var(--fx-bg-hover)' : 'transparent',
        boxShadow: focused ? 'inset 0 0 0 2px var(--fx-focus)' : 'none',
      }}
    >
      {/* Selvage carries age. Never amber — this is a verdict, not an action. */}
      <div
        style={{
          flexShrink: 0,
          width: atRisk ? 5 : 3,
          background: ageColour === 'var(--fx-text-tertiary)' ? 'var(--fx-border-subtle)' : ageColour,
        }}
      />

      <div style={{ padding: '18px 0 0 16px', alignSelf: 'flex-start' }}>
        <input
          type="checkbox"
          checked={checked}
          onChange={onCheck}
          aria-label={`Select ${row.title}`}
          style={{ width: 18, height: 18, accentColor: 'var(--fx-text-primary)' }}
        />
      </div>

      <div
        className="fx-stack-tablet"
        style={{
          flex: 1,
          minWidth: 0,
          display: 'grid',
          gridTemplateColumns: '1.7fr 150px 118px 120px 168px',
          gap: 16,
          padding: '14px 18px',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            {row.reference ? <Ident size={12}>{row.reference}</Ident> : null}
            <Badge>{row.moduleId}</Badge>
            {row.approvedByMe ? <Badge tone="info">waiting on a colleague</Badge> : null}
          </div>
          {/* The title opens the draft. Approving without reading what a draft writes is
              the one thing this inbox exists to prevent, so the way to read it is the most
              obvious thing in the row. */}
          <button
            onClick={toggle}
            aria-expanded={open}
            style={{
              font: "600 15.5px/1.3 var(--fx-font-sans)",
              color: 'var(--fx-text-primary)',
              textWrap: 'pretty',
              background: 'transparent',
              border: 'none',
              padding: 0,
              textAlign: 'left',
              cursor: 'pointer',
            }}
          >
            {open ? '▾ ' : '▸ '}
            {row.title}
          </button>
          <div
            style={{
              font: "400 13px/1.4 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
            }}
          >
            {row.operation} on {row.targetTable.replace(/_/g, ' ')}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <Eyebrow>Source</Eyebrow>
          <div style={{ font: "400 13px/1.35 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
            {row.fromModel ? 'MARBIM draft' : 'user edit'}
          </div>
          <div style={{ font: "400 12px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            {row.source}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <Eyebrow>Confidence</Eyebrow>
          <ConfidenceTicks confidence={row.weakestConfidence} source={row.source} />
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Eyebrow>Age</Eyebrow>
          <div data-numeric style={{ font: "500 13px/1.2 var(--fx-font-mono)", color: ageColour }}>
            {row.ageHours}h
          </div>
          <div style={{ font: "400 12px/1.3 var(--fx-font-sans)", color: ageColour }}>
            {atRisk ? 'at risk' : ageing ? 'ageing' : 'fresh'}
          </div>
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button variant="ghost" size="sm" onClick={onReject} disabled={busy}>
            Reject
          </Button>
          <Button
            variant={primary ? 'primary' : 'secondary'}
            size="sm"
            onClick={onApprove}
            disabled={busy}
          >
            Approve
          </Button>
        </div>
      </div>
    </div>

      {open ? (
        <DraftFields
          detail={fields}
          loading={loading}
          corrections={corrections}
          onCorrect={onCorrect}
        />
      ) : null}
    </div>
  )
}

/**
 * What the draft would actually write.
 *
 * Every field is shown, not just the uncertain ones. A reviewer deciding whether to sign
 * needs the whole row that is about to exist — a panel that showed only what the extractor
 * doubted would hide a confidently-wrong value, which is the kind this inbox catches worst.
 *
 * Confidence sits on the field it belongs to. The row's single number is the WEAKEST of
 * these, which tells somebody there is a soft field and not which one; that is only useful
 * next to the value itself.
 */
function DraftFields({
  detail,
  loading,
  corrections,
  onCorrect,
}: {
  detail: DraftDetail | null | undefined
  loading: boolean
  /**
   * WHY this draft has no confidence, which "no confidence" alone cannot say.
   *
   * A null score has two causes and they are opposites. `user_draft` means a person typed
   * the value. `ai_chat` means a model composed it in conversation, where there is no
   * extractor to ask and inventing a number is refused (`validateConfidence`). Rendering
   * both as "typed by a person" credited a machine's transcription to a human — on a screen
   * that named the source `ai_chat` two inches above it.
   */
  /** field → the reviewer's replacement. Absent means "as drafted". */
  corrections: Record<string, unknown>
  /** `undefined` clears a correction, restoring the drafted value. */
  onCorrect: (field: string, value: unknown) => void
}) {
  if (loading || detail === undefined) {
    return <div style={panelStyle}>Reading the draft…</div>
  }

  if (detail === null) {
    return (
      <div style={panelStyle}>
        This draft is no longer pending — somebody else has already decided it.
      </div>
    )
  }

  if (detail.fields.length === 0) {
    // Refused rather than rendered as an empty list: `assertExtractionConfidence` will not
    // let a fieldless draft exist, so one here means something is wrong upstream.
    return <div style={panelStyle}>This draft writes no fields, which should not happen.</div>
  }

  return (
    <div style={{ ...panelStyle, display: 'flex', flexDirection: 'column', gap: 2 }}>
      {detail.fields.map((field) => (
        <div
          key={field.field}
          style={{
            display: 'grid',
            gridTemplateColumns: '200px 1fr 132px',
            gap: 14,
            alignItems: 'baseline',
            padding: '7px 0',
          }}
        >
          <span style={{ font: "500 12.5px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}>
            {field.field}
          </span>

          {/* Every part is rendered. Laying a list out is not the same as summarising it —
              "2 items" would be a value the reviewer never saw, and these are the buyer's
              own words about restricted chemicals. */}
          <span style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
            {/*
              What it is now, when this replaces something. An update showed only the
              incoming value, so a breakdown revision read as a fresh grid rather than a
              change to the one the floor is cutting to.
            */}
            {field.changed && field.before !== undefined ? (
              <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span
                  style={{
                    font: "400 11px/1.3 var(--fx-font-mono)",
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                    color: 'var(--fx-text-tertiary)',
                    flexShrink: 0,
                  }}
                >
                  now
                </span>
                <span style={{ textDecoration: 'line-through', opacity: 0.75 }}>
                  <FieldValue value={field.before} />
                </span>
              </span>
            ) : null}

            <span style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
              {field.changed && field.before !== undefined ? (
                <span
                  style={{
                    font: "400 11px/1.3 var(--fx-font-mono)",
                    textTransform: 'uppercase',
                    letterSpacing: '.06em',
                    color: 'var(--fx-text-secondary)',
                    flexShrink: 0,
                  }}
                >
                  becomes
                </span>
              ) : null}
              <EditableValue
                field={field.field}
                drafted={field.after}
                corrected={corrections[field.field]}
                onCorrect={onCorrect}
              />
            </span>

            {/* A field the draft leaves exactly as it is. Shown greyed rather than hidden:
                a reviewer needs to know what a change does NOT touch. */}
            {!field.changed ? (
              <span
                style={{
                  font: "400 11.5px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                unchanged
              </span>
            ) : null}
          </span>

          <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
            {field.confidence === null ? (
              <span style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                {/* Absence, not a fake 1.0 — but say WHICH absence. */}
                {modelComposed(detail.source)
                  ? 'model wrote this · unscored'
                  : 'typed by a person'}
              </span>
            ) : (
              <ConfidenceTicks confidence={field.confidence} />
            )}
          </span>
        </div>
      ))}

      <AuditTrail detail={detail} />

      <div
        style={{
          marginTop: 8,
          paddingTop: 8,
          borderTop: '1px solid var(--fx-border-subtle)',
          font: "400 12px/1.5 var(--fx-font-mono)",
          color: 'var(--fx-text-tertiary)',
        }}
      >
        {detail.operation} on {detail.targetTable.replace(/_/g, ' ')}
        {detail.model ? ` · read by ${detail.model}` : ''}
        {detail.extractorVersion ? ` · extractor v${detail.extractorVersion}` : ''}
        {detail.sourceDocumentId ? ' · from an attached document' : ''}
      </div>
    </div>
  )
}


/** "14:22" — the audit trail is a sequence of events, and a date without a time is not one. */
function clockTime(value: Date | string): string {
  const at = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(at.getTime())) return ''
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Whose hands this draft has passed through, on the screen where it is signed.
 *
 * The data has been complete since the module landed — `pending_changes.created_by`, the
 * `pending_change_approvals` rows, the `audit_log` interceptor — and none of it reached this
 * panel. A reviewer countersigning a colleague's work could not see whose work it was, which
 * is the one fact a countersignature is for. It surfaced only in Settings → audit viewer,
 * behind owner/admin, minutes of scrolling away from the decision it belongs to.
 *
 * Rendered as a sequence rather than a table: a trail reads as "she drafted it, then he
 * approved it", and the gap where the next signature goes is itself information.
 */
function AuditTrail({ detail }: { detail: DraftDetail }) {
  const { draftedBy, approvals } = detail.provenance

  // A draft with no recorded author is a real state — imports and integrations have no person
  // behind them — and inventing "system" for it would be a claim the row does not make.
  const drafter = draftedBy ? (draftedBy.name ?? 'someone who has left') : 'no named author'

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--fx-border-subtle)' }}>
      <Eyebrow>Trail</Eyebrow>
      <ol style={{ margin: '6px 0 0', padding: 0, listStyle: 'none' }}>
        <li style={TRAIL_ROW}>
          <span style={{ color: 'var(--fx-text-secondary)' }}>drafted by {drafter}</span>
          <span>{clockTime(detail.createdAt)}</span>
        </li>

        {approvals.map((signature, index) => (
          <li key={`${signature.name ?? 'gone'}-${index}`} style={TRAIL_ROW}>
            <span style={{ color: 'var(--fx-text-secondary)' }}>
              approved by {signature.name ?? 'someone who has left'} ({signature.role})
            </span>
            <span>{clockTime(signature.at)}</span>
          </li>
        ))}

        {approvals.length === 0 ? (
          // The absent signature, said out loud. An empty list here would read as "no trail
          // recorded" — the opposite of the truth, which is that nobody has signed yet.
          <li style={{ ...TRAIL_ROW, color: 'var(--fx-text-tertiary)' }}>
            <span>awaiting a first signature</span>
          </li>
        ) : null}
      </ol>
    </div>
  )
}

const TRAIL_ROW: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: 12,
  font: "400 12px/1.7 var(--fx-font-mono)",
  color: 'var(--fx-text-tertiary)',
}

/**
 * One field's value, correctable in place.
 *
 * The runbook's Phase 1 asks a merchandiser to "correct the ship date, then approve", and
 * until now she could do neither half: the panel rendered values as text, so a wrong field
 * meant rejecting the whole draft and asking for it again. `approveDraft` had taken a
 * `corrections` map the entire time — the extractor's own scoring depends on it — and
 * nothing ever sent one.
 *
 * ## Scalars, and rows of scalars
 *
 * A string, number, boolean or date gets an input. So does every cell of a list of flat
 * objects — a BOM's lines, a requirements list — through `EditableRows`, which is the
 * structured editor this comment used to say was somebody else's problem.
 *
 * It was not an academic gap. A tech pack states no consumption for sew thread (it is
 * derived from stitch length, not printed), the extractor honestly returns zero, and
 * `bom_lines_consumption_positive` refuses the row — so a twelve-line BOM with eleven good
 * lines could only be rejected whole and asked for again. The reviewer's remedy for one
 * wrong number should be to type the number.
 *
 * What stays read-only is anything NOT a flat list of scalars: a nested grid of breakdown
 * cells keyed by colour and size is a shape a row editor would misrepresent, and a text box
 * holding JSON is a way to corrupt a payload with a misplaced brace.
 *
 * ## Typing is preserved
 *
 * A quantity edited to "36000" must go back as the NUMBER 36000, not the string. The
 * drafted value's type is the guide, because zod re-validates the payload at approve and a
 * string where a number belongs is refused there — correctly, and confusingly, three layers
 * from the box that was typed in.
 */
function EditableValue({
  field,
  drafted,
  corrected,
  onCorrect,
}: {
  field: string
  drafted: unknown
  corrected: unknown
  onCorrect: (field: string, value: unknown) => void
}) {
  /*
   * Above the early returns, because a hook must run in the same order on every render.
   *
   * What the person typed, kept apart from what will be sent: a numeric field emits a
   * NUMBER, and rendering it back eats a decimal point mid-keystroke — "16." parses to 16,
   * the box redraws as "16", and 16.50 arrives as 1650.
   */
  const [typed, setTyped] = useState<string | null>(null)

  // A flat list of objects — the shape a BOM, a requirements list and a findings batch all
  // take — gets the row editor rather than being read-only.
  if (isRowList(drafted)) {
    return (
      <EditableRows
        field={field}
        drafted={drafted}
        corrected={Array.isArray(corrected) ? (corrected as RowList) : undefined}
        onCorrect={onCorrect}
      />
    )
  }

  const editable =
    drafted === null ||
    drafted === undefined ||
    ['string', 'number', 'boolean'].includes(typeof drafted)

  if (!editable) return <FieldValue value={drafted} />

  const shown = corrected !== undefined ? corrected : drafted
  const dirty = corrected !== undefined
  const text = typed ?? (shown === null || shown === undefined ? '' : String(shown))

  /** Back to the drafted TYPE, so zod sees what it expects at approve. */
  const retype = (raw: string): unknown => {
    if (raw === '') return null
    if (typeof drafted === 'number') {
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    if (typeof drafted === 'boolean') return raw === 'true'
    return raw
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <input
        aria-label={field}
        value={text}
        onChange={(e) => {
          setTyped(e.target.value)
          const next = retype(e.target.value)
          // Typing it back to the drafted value is not a correction. Without this, a
          // reviewer who clicked in and out would be recorded as having fixed the field,
          // and the extractor scored for a mistake it did not make.
          onCorrect(field, String(next) === String(drafted) ? undefined : next)
        }}
        style={{
          font: "400 13px/1.4 var(--fx-font-mono)",
          padding: '4px 8px',
          minWidth: 200,
          maxWidth: '100%',
          borderRadius: 'var(--fx-radius-sm)',
          border: `1px solid ${dirty ? 'var(--fx-accent)' : 'var(--fx-border-default)'}`,
          background: 'var(--fx-bg-surface)',
          color: 'var(--fx-text-primary)',
        }}
      />
      {dirty ? (
        <button
          type="button"
          onClick={() => {
            setTyped(null)
            onCorrect(field, undefined)
          }}
          style={{
            font: "400 11px/1.3 var(--fx-font-mono)",
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            color: 'var(--fx-text-tertiary)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          corrected · undo
        </button>
      ) : null}
    </span>
  )
}

type Row = Record<string, unknown>
type RowList = readonly Row[]

/** A leaf a text box can hold without lying about it. */
const isScalar = (v: unknown): boolean =>
  v === null || v === undefined || ['string', 'number', 'boolean'].includes(typeof v)

/**
 * A list of flat objects — every row an object, every cell a scalar.
 *
 * Deliberately narrow. A breakdown grid keyed by colour and size is also "an array of
 * objects" and is NOT this: a row editor would flatten a two-dimensional thing into a
 * one-dimensional one, and a reviewer correcting it would be correcting a shape the payload
 * does not have.
 */
function isRowList(value: unknown): value is RowList {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (row) =>
        row !== null &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        Object.values(row as Row).every(isScalar),
    )
  )
}

/**
 * The rows of a drafted list, each cell editable.
 *
 * ## Why the whole array is the correction
 *
 * `approve` merges corrections into the payload with a shallow spread, so the unit of
 * correction is a TOP-LEVEL field. Editing one cell therefore sends the entire list back —
 * eleven untouched rows and one fixed one — which is also what makes the change legible in
 * the correction telemetry: the extractor is scored on the field it got wrong, not on a
 * path expression nobody can read six months later.
 *
 * ## Why the type is taken from the cell, not the input
 *
 * `consumption: 0.02` must go back as a NUMBER. A text input yields strings, zod re-validates
 * at approve, and a string where a number belongs is refused three layers from the box that
 * was typed in — which is exactly the class of error this editor exists to end.
 */
function EditableRows({
  field,
  drafted,
  corrected,
  onCorrect,
}: {
  field: string
  drafted: RowList
  corrected: RowList | undefined
  onCorrect: (field: string, value: unknown) => void
}) {
  const rows = corrected ?? drafted

  /*
   * What the person typed, per cell, kept apart from what will be sent.
   *
   * The field emits a NUMBER for a numeric cell, and rendering that number back into the box
   * eats a decimal point mid-keystroke: "0." parses to 0, the box redraws as "0", and the
   * next character lands on it — so 0.02 became 2 and 0.255 became 255. Silent, and it lands
   * in a bill of materials.
   */
  const [typed, setTyped] = useState<Record<string, string>>({})
  // Every key any row carries, first-seen order — a row that omits an optional field must
  // not shift the columns under the rows around it.
  const columns = [...new Set(drafted.flatMap((row) => Object.keys(row)))]

  const retype = (raw: string, was: unknown): unknown => {
    if (raw === '') return null
    if (typeof was === 'number') {
      const n = Number(raw)
      return Number.isFinite(n) ? n : raw
    }
    if (typeof was === 'boolean') return raw === 'true'
    return raw
  }

  function edit(rowIndex: number, key: string, raw: string) {
    setTyped((prev) => ({ ...prev, [`${rowIndex}:${key}`]: raw }))

    const next = rows.map((row, i) =>
      i === rowIndex ? { ...row, [key]: retype(raw, drafted[rowIndex]?.[key]) } : { ...row },
    )
    // Back to what was drafted is not a correction — same rule the scalar editor holds to,
    // so a reviewer who clicks through every cell is not recorded as having fixed them.
    onCorrect(field, JSON.stringify(next) === JSON.stringify(drafted) ? undefined : next)
  }

  const dirty = corrected !== undefined

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="fx-scroll-x" tabIndex={0} style={{ display: 'block', maxWidth: '100%' }}>
        <table style={{ borderCollapse: 'collapse', font: "400 12px/1.4 var(--fx-font-mono)" }}>
          <thead>
            <tr>
              {columns.map((key) => (
                <th
                  key={key}
                  scope="col"
                  style={{
                    textAlign: 'left',
                    padding: '2px 6px 4px 0',
                    color: 'var(--fx-text-tertiary)',
                    fontWeight: 500,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                {columns.map((key) => {
                  const value = row[key]
                  const changed =
                    dirty && JSON.stringify(value) !== JSON.stringify(drafted[i]?.[key])
                  return (
                    <td key={key} style={{ padding: '2px 6px 2px 0' }}>
                      <input
                        aria-label={`${field} row ${i + 1} ${key}`}
                        value={
                          typed[`${i}:${key}`] ??
                          (value === null || value === undefined ? '' : String(value))
                        }
                        onChange={(e) => edit(i, key, e.target.value)}
                        style={{
                          font: "400 12px/1.4 var(--fx-font-mono)",
                          padding: '3px 6px',
                          width: Math.min(Math.max(String(value ?? '').length + 3, 8), 34) + 'ch',
                          borderRadius: 'var(--fx-radius-sm)',
                          border: `1px solid ${changed ? 'var(--fx-accent)' : 'var(--fx-border-default)'}`,
                          background: 'var(--fx-bg-surface)',
                          color: 'var(--fx-text-primary)',
                        }}
                      />
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </span>
      {dirty ? (
        <button
          type="button"
          onClick={() => {
            setTyped({})
            onCorrect(field, undefined)
          }}
          style={{
            alignSelf: 'flex-start',
            font: "400 11px/1.3 var(--fx-font-mono)",
            textTransform: 'uppercase',
            letterSpacing: '.06em',
            color: 'var(--fx-text-tertiary)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
          }}
        >
          corrected · undo all
        </button>
      ) : null}
    </span>
  )
}

/**
 * A field's value, in full.
 *
 * A list of objects — buyer requirements, BOM lines, breakdown cells — is the common shape
 * here, and as one line of JSON it is technically complete and practically unreadable. It
 * gets one block per entry with its keys spelled out. Nothing is dropped or counted: the
 * reviewer of a compliance clause has to be able to read the clause.
 */
function FieldValue({ value }: { value: unknown }) {
  const scalar = (v: unknown): string =>
    v === null || v === undefined ? '—' : String(v)

  /*
   * The colour × size grid, as a grid.
   *
   * Rendered identically to what the raiser confirmed, deliberately: an approver looking at
   * a different picture from the person who checked it against the paper makes "I checked
   * it" and "I approved it" two claims about two different things.
   */
  if (looksLikeGrid(value)) return <GridSummary cells={value} />

  if (Array.isArray(value) && value.some((v) => v !== null && typeof v === 'object')) {
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {value.map((entry, i) => (
          <span
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingLeft: 10,
              borderLeft: '2px solid var(--fx-border-default)',
            }}
          >
            {entry !== null && typeof entry === 'object' ? (
              Object.entries(entry as Record<string, unknown>).map(([k, v]) => (
                <span key={k} style={{ font: "400 12.5px/1.5 var(--fx-font-sans)" }}>
                  <span style={{ color: 'var(--fx-text-tertiary)' }}>{humanise(k)}: </span>
                  {/* Recurse rather than stringify: a style's breakdown is a nested array,
                      and `JSON.stringify` on it put a wall of braces in front of the one
                      person whose job is to check the quantities. */}
                  {v !== null && typeof v === 'object' ? (
                    <FieldValue value={v} />
                  ) : (
                    <span style={{ color: 'var(--fx-text-primary)' }}>{scalar(v)}</span>
                  )}
                </span>
              ))
            ) : (
              <span style={{ font: "400 12.5px/1.5 var(--fx-font-sans)" }}>{scalar(entry)}</span>
            )}
          </span>
        ))}
      </span>
    )
  }

  return (
    <span
      data-numeric
      style={{
        font: "400 13px/1.5 var(--fx-font-mono)",
        color: 'var(--fx-text-primary)',
        wordBreak: 'break-word',
      }}
    >
      {scalar(value)}
    </span>
  )
}

const panelStyle: React.CSSProperties = {
  padding: '14px 18px 16px 62px',
  background: 'var(--fx-bg-canvas)',
  font: "400 13px/1.5 var(--fx-font-sans)",
  color: 'var(--fx-text-secondary)',
}

/**
 * Sources whose drafts a MODEL composed and which therefore carry no measurement.
 *
 * `ai_chat` is the one that exists today: a model chose tool arguments in conversation, so
 * there is no extractor, no second pass, and nothing that could produce a per-field number —
 * `validateConfidence` refuses one outright rather than accept an invented figure. That
 * refusal is right, and it left the inbox unable to distinguish "nobody measured this
 * because a person typed it" from "nobody measured this because a machine wrote it".
 *
 * `ai_extraction` is deliberately absent: it always carries real scores, so it never reaches
 * the null branch.
 */
const MODEL_COMPOSED = new Set(['ai_chat'])
const modelComposed = (source: string): boolean => MODEL_COMPOSED.has(source)

/**
 * Ten slashes at the mark's 34°. Below 0.90 the fill turns warning — the one
 * field the extractor was least sure about is the field to read first.
 * A human draft has NO confidence, which is absence, not a fake 1.0.
 */
function ConfidenceTicks({
  confidence,
  source,
}: {
  confidence: number | null
  /** Optional: the row summary knows it, a per-field tick already resolved it. */
  source?: string
}) {
  if (confidence === null) {
    return (
      <span style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
        {source !== undefined && modelComposed(source) ? 'unscored' : 'human edit'}
      </span>
    )
  }

  const filled = Math.round(confidence * 10)
  const low = confidence < 0.9
  const colour = low ? 'var(--fx-warning)' : 'var(--fx-accent)'

  return (
    <>
      <span
        data-numeric
        style={{
          font: '500 13px/1.2 var(--fx-font-mono)',
          color: low ? 'var(--fx-warning)' : 'var(--fx-text-primary)',
        }}
      >
        {confidence.toFixed(2)}
      </span>
      <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {Array.from({ length: 10 }, (_, i) => (
          <span
            key={i}
            style={{
              width: 2,
              height: 12,
              flexShrink: 0,
              transform: 'skewX(var(--fx-slash-angle))',
              background: i < filled ? colour : 'var(--fx-border-default)',
            }}
          />
        ))}
      </span>
    </>
  )
}

function RejectDialog({
  row,
  onClose,
  onDone,
}: {
  row: InboxRowView | null
  onClose: () => void
  onDone: (title: string) => void
}) {
  const [reason, setReason] = useState<string>('')
  const [note, setNote] = useState('')
  const [busy, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  if (!row) return null

  return (
    <Modal
      open
      onClose={onClose}
      title="Send this back"
      width={520}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!reason || busy}
            onClick={() =>
              startTransition(async () => {
                try {
                  unwrap(await rejectDraft({ pendingChangeId: row.id, reason, note: note || undefined }))
                  onDone(row.title)
                } catch (e) {
                  setError(actionErrorMessage(e, 'That did not go through'))
                }
              })
            }
          >
            Reject
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          {row.title} goes back to whoever drafted it, with your reason attached. No row is
          written.
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {REASONS.map((r) => (
            <label
              key={r}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                font: "400 14px/1.4 var(--fx-font-sans)",
                color: 'var(--fx-text-primary)',
              }}
            >
              <input
                type="radio"
                name="reject-reason"
                checked={reason === r}
                onChange={() => setReason(r)}
                style={{ accentColor: 'var(--fx-accent)' }}
              />
              {r}
            </label>
          ))}
        </div>

        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          placeholder="Anything the drafter needs to know (optional)"
          style={{
            background: 'var(--fx-bg-surface)',
            color: 'var(--fx-text-primary)',
            border: '1px solid var(--fx-border-default)',
            borderRadius: 'var(--fx-radius-sm)',
            padding: '11px 13px',
            font: "400 14px/1.55 var(--fx-font-sans)",
            resize: 'vertical',
          }}
        />

        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}
      </div>
    </Modal>
  )
}

function KeyLegend() {
  const keys: [string, string][] = [
    ['j / k', 'move'],
    ['a', 'approve'],
    ['r', 'reject'],
    ['x', 'select'],
  ]
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      {keys.map(([k, what]) => (
        <span key={k} style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
          <kbd
            style={{
              font: "500 11px/1 var(--fx-font-mono)",
              background: 'var(--fx-bg-sunken)',
              border: '1px solid var(--fx-border-subtle)',
              borderRadius: 'var(--fx-radius-sm)',
              padding: '5px 7px',
              color: 'var(--fx-text-secondary)',
            }}
          >
            {k}
          </kbd>
          <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
            {what}
          </span>
        </span>
      ))}
    </div>
  )
}
