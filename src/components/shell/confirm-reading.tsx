'use client'

import { useState } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { Badge, Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { confirmMyDraft, discardMyDraft } from '@/modules/approvals/actions'

import { humanise, ValueEditor } from './reading-fields'

/**
 * What MARBIM read, shown to the person who asked for it, before anybody else is asked.
 *
 * The step this closes was a real hole in the loop. A merchandiser dropped a purchase order
 * on the intake screen, was told it had been read, and the draft went straight into an
 * approver's inbox — where somebody who does not have the document was asked to verify
 * quantities against it. The person holding the paper, the only one who could say "that says
 * 12,000, not 1,200", never saw the reading at all. Per-field confidence tells a reviewer
 * where to look; it cannot tell them what the page said.
 *
 * So: the raiser sees every field with what the extractor read and how sure it was, fixes
 * what is wrong, and confirms. Only then does it become an approval anybody else can see.
 *
 * **Their edits are the better telemetry.** A correction made here is made against the
 * source, before anyone else's opinion is in the room — which is why the server files them
 * apart from the reviewer's, and why a corrected field's confidence becomes 1 rather than
 * keeping the number the extractor no longer owns.
 */

export interface DraftField {
  name: string
  value: unknown
  confidence: number | null
  /** Chosen from a picker when the document was sent — shown by name, never editable. */
  supplied?: { label: string }
}

export interface UnconfirmedDraft {
  id: string
  moduleId: string
  targetTable: string
  fields: DraftField[]
  model: string | null
}

/** The reading's weakest field — the one worth reading first. */
function weakest(fields: DraftField[]): number | null {
  // Only what the extractor actually read. A picked field is scored 1 because a person
  // chose it, and letting that into the minimum would say the reading was surer than it is
  // — in the direction that matters, since this number is what decides whether to look.
  const scored = fields
    .filter((f) => !f.supplied)
    .map((f) => f.confidence)
    .filter((c): c is number => c !== null)
  return scored.length > 0 ? Math.min(...scored) : null
}

export function ConfirmReading({ drafts }: { drafts: readonly UnconfirmedDraft[] }) {
  const [openId, setOpenId] = useState<string | null>(null)
  const draft = drafts.find((d) => d.id === openId) ?? null

  if (drafts.length === 0) return null

  return (
    <section
      style={{
        border: '1px solid var(--fx-border-default)',
        borderRadius: 'var(--fx-radius-md)',
        background: 'var(--fx-bg-surface)',
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      <div>
        <div style={{ font: "600 15px/1.2 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
          MARBIM read {drafts.length === 1 ? 'a document' : `${drafts.length} documents`} for you
        </div>
        <p
          style={{
            margin: '5px 0 0',
            font: "400 13px/1.5 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
          }}
        >
          Check it against the paper before it goes for approval. Nobody else can see these
          yet — an approver who does not have the document cannot check it for you.
        </p>
      </div>

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {drafts.map((d) => {
          const low = weakest(d.fields)
          return (
            <li
              key={d.id}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: '10px 12px',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-sm)',
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  font: "400 13.5px/1.4 var(--fx-font-sans)",
                  color: 'var(--fx-text-primary)',
                }}
              >
                {d.targetTable.replace(/_/g, ' ')} · {d.moduleId}
              </span>
              {low !== null ? (
                <Badge tone={low < 0.8 ? 'warning' : 'neutral'}>
                  weakest {Math.round(low * 100)}%
                </Badge>
              ) : null}
              <Button variant="primary" onClick={() => setOpenId(d.id)}>
                Check it
              </Button>
            </li>
          )
        })}
      </ul>

      {draft ? <ReadingModal draft={draft} onClose={() => setOpenId(null)} /> : null}
    </section>
  )
}

function ReadingModal({ draft, onClose }: { draft: UnconfirmedDraft; onClose: () => void }) {
  // Values, not text. `ValueEditor` hands back the same SHAPE it was given — a grid stays
  // an array of cells — so nothing here has to parse anything, and there is no JSON for a
  // person to get wrong.
  const [edits, setEdits] = useState<Record<string, unknown>>({})
  const [busy, setBusy] = useState<'confirm' | 'discard' | null>(null)
  const [error, setError] = useState<string | null>(null)

  function corrections(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const field of draft.fields) {
      // Picked, not read. There is no editor for it, so there is nothing to diff.
      if (field.supplied) continue
      if (!(field.name in edits)) continue
      // Compared structurally: re-selecting the same grid cell is not a correction, and
      // recording it as one would poison the extractor's error rate with non-edits.
      if (JSON.stringify(edits[field.name]) === JSON.stringify(field.value)) continue
      out[field.name] = edits[field.name]
    }
    return out
  }

  async function run(what: 'confirm' | 'discard') {
    setBusy(what)
    setError(null)
    try {
      if (what === 'confirm') {
        unwrap(await confirmMyDraft({ pendingChangeId: draft.id, corrections: corrections() }))
      } else {
        unwrap(await discardMyDraft({ pendingChangeId: draft.id }))
      }
      onClose()
      window.location.reload()
    } catch (e) {
      setError(actionErrorMessage(e, 'That did not go through.'))
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={760}
      title={`What MARBIM read — ${draft.targetTable.replace(/_/g, ' ')}`}
      footer={
        <>
          <Button variant="ghost" disabled={busy !== null} onClick={() => void run('discard')}>
            {busy === 'discard' ? 'Discarding…' : 'It read it wrong — discard'}
          </Button>
          <Button variant="primary" disabled={busy !== null} onClick={() => void run('confirm')}>
            {busy === 'confirm' ? 'Sending…' : 'This is right — send for approval'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

        <p
          style={{
            margin: 0,
            font: "400 12.5px/1.6 var(--fx-font-sans)",
            color: 'var(--fx-text-tertiary)',
          }}
        >
          Every value below came off the document{draft.model ? ` (read by ${draft.model})` : ''}.
          The percentage is how sure the reader was of that field — low is worth checking, high
          is not a guarantee. Anything you change is recorded as yours and counts as certain.
        </p>

        {draft.fields.map((field) => {
          const shown = field.name in edits ? edits[field.name] : field.value
          const low = field.confidence !== null && field.confidence < 0.8

          /*
           * A field the person picked, shown by its name.
           *
           * It arrived as a uuid, and a uuid is the one value nobody can check by reading
           * it — but "Bestseller A/S" is exactly what somebody WOULD notice was wrong. Not
           * editable, because retyping an id by hand is a silent write against a different
           * record, and the way to change it is to send the document again against the
           * right buyer.
           */
          if (field.supplied) {
            return (
              <div key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                  <span style={{ font: "500 13.5px/1 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
                    {humanise(field.name)}
                  </span>
                  <span style={{ font: "400 12px/1 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
                    you chose this
                  </span>
                </div>
                <div
                  style={{
                    padding: '9px 11px',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-sm)',
                    background: 'var(--fx-bg-sunken)',
                    font: "400 13px/1.5 var(--fx-font-sans)",
                    color: 'var(--fx-text-secondary)',
                  }}
                >
                  {field.supplied.label}
                </div>
              </div>
            )
          }

          return (
            <div key={field.name} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span
                  style={{
                    font: "500 13.5px/1 var(--fx-font-sans)",
                    color: 'var(--fx-text-primary)',
                  }}
                >
                  {humanise(field.name)}
                </span>
                {field.confidence !== null ? (
                  <span
                    style={{
                      font: "400 12px/1 var(--fx-font-sans)",
                      color: low ? 'var(--fx-warning)' : 'var(--fx-text-tertiary)',
                    }}
                  >
                    {low ? 'worth checking' : 'read clearly'} · {Math.round(field.confidence * 100)}%
                  </span>
                ) : (
                  <span
                    style={{
                      font: "400 12px/1 var(--fx-font-sans)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    you supplied this
                  </span>
                )}
              </div>
              <ValueEditor
                value={shown}
                invalid={low}
                onChange={(next) => setEdits((prev) => ({ ...prev, [field.name]: next }))}
              />
            </div>
          )
        })}
      </div>
    </Modal>
  )
}
