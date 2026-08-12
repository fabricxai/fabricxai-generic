'use client'

import { useRef, useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { MarbimMark, type MarkState } from '@/components/fx/mark'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { uploadDocument, type UploadedDocument } from '@/lib/upload-document'
import { readIntoForm } from '@/modules/marbim/actions'

/**
 * "I am holding the paper" — a document read straight into the form that is already open.
 *
 * ## Why this had to exist
 *
 * The copilot could read a purchase order, a SWIFT advice and a customs declaration, and had
 * been able to for some time. It could only be asked from one screen, `/marbim/intake`, which
 * nothing linked to. So the actual path for a commercial officer with a credit advice in hand
 * was: leave the LC register, find MARBIM in the navigation, choose a document kind, choose a
 * buyer, upload, wait, go to their home screen, confirm the reading, and wait for somebody
 * else to approve it — while the "Record a credit" button they started next to opened a blank
 * form with eighteen fields. Nobody would ever pick the first path, so nobody used the
 * extraction at all. The audit of every input dialog in the app found the same thing
 * everywhere: not one of twenty-seven offered a document.
 *
 * ## What it does and does not do
 *
 * It fills fields. It writes nothing. The person then checks what was read, corrects what is
 * wrong and presses the dialog's own save — the ordinary manual action, with its own role
 * wall and its own validation. So the writer is still the human, and no AI write skips
 * `pending_changes`, because no AI write happens.
 *
 * That also makes this strictly better than typing rather than a different, more supervised
 * route: before, reaching for the model meant a slower and more heavily reviewed path than
 * doing it by hand, which is precisely backwards as an incentive.
 *
 * ## Confidence is shown per field, and it is a measurement
 *
 * `onFilled` receives what was read and how sure the reader was of each field, so the dialog
 * can mark the two dates it guessed differently from the credit number it read off a label.
 * A percentage is not a promise — it says where to look first.
 */

export interface ReadFields {
  values: Record<string, unknown>
  confidence: Record<string, number | null>
  model: string
  /**
   * The document as it was stored, so a caller that also wants to KEEP it does not make the
   * person attach it twice.
   *
   * The store's receive screen is the case this exists for: it has always photographed the
   * challan as evidence — a supplier will invoice against that paper and a customs officer
   * may ask for it — and now the same photograph fills the form. One drop, both jobs.
   */
  document: UploadedDocument
}

export function ReadIntoForm({
  kindId,
  prompt,
  contextValues,
  contextMissing,
  onFilled,
}: {
  /** Which intake kind — `buyer_po`, `lc_swift`, `ud_scan`. */
  kindId: string
  /** What to hold up, in this desk's words: "the SWIFT advice", "the buyer's purchase order". */
  prompt: string
  /** Ids the person has already chosen in the dialog, merged over the reading at confidence 1. */
  contextValues?: Record<string, string>
  /** Said instead of the drop zone when the reading needs a choice not yet made. */
  contextMissing?: string | null
  onFilled: (read: ReadFields) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [pending, startTransition] = useTransition()
  const [stage, setStage] = useState<'idle' | 'uploading' | 'reading'>('idle')
  const [failure, setFailure] = useState<string | null>(null)
  const [read, setRead] = useState<{ count: number; model: string } | null>(null)
  const [dragging, setDragging] = useState(false)

  function handle(file: File) {
    setFailure(null)
    setRead(null)
    setStage('uploading')

    startTransition(async () => {
      try {
        const uploaded = await uploadDocument(file, { kind: kindId, moduleId: 'marbim' })
        setStage('reading')

        const result = unwrap(
          await readIntoForm({
            kindId,
            documentId: uploaded.documentId,
            ...(contextValues && Object.keys(contextValues).length > 0 ? { contextValues } : {}),
          }),
        )

        const values: Record<string, unknown> = {}
        const confidence: Record<string, number | null> = {}
        for (const field of result.fields) {
          values[field.name] = field.value
          confidence[field.name] = field.confidence
        }

        onFilled({ values, confidence, model: result.model, document: uploaded })
        setRead({ count: result.fields.length, model: result.model })
      } catch (error) {
        setFailure(actionErrorMessage(error, 'That document could not be read.'))
      } finally {
        setStage('idle')
      }
    })
  }

  const busy = pending || stage !== 'idle'

  /*
   * One shape everywhere.
   *
   * The zone is the same rectangle in every dialog it appears in — same height, same corner,
   * same mark in the same place — so that after seeing it once on the order desk a person
   * recognises it on the LC register without reading it again. It is the affordance that has
   * to be learned exactly once.
   */
  const state: MarkState = stage === 'reading' ? 'listening' : read ? 'resolved' : 'rest'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        role="button"
        tabIndex={contextMissing ? -1 : 0}
        aria-disabled={contextMissing ? true : undefined}
        aria-label={contextMissing ?? `Drop ${prompt} here`}
        onClick={() => {
          if (!contextMissing && !busy) fileRef.current?.click()
        }}
        onKeyDown={(e) => {
          // A drop target that only accepts a mouse is a drop target half the floor cannot
          // use — the same reason every tap target in this product has a minimum size.
          if ((e.key === 'Enter' || e.key === ' ') && !contextMissing && !busy) {
            e.preventDefault()
            fileRef.current?.click()
          }
        }}
        onDragOver={(e) => {
          if (contextMissing) return
          e.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          if (contextMissing) return
          const file = e.dataTransfer.files[0]
          if (file) handle(file)
        }}
        style={{
          // Slightly curved, never a pill: this is a sheet of paper's worth of space, and a
          // rounded rectangle is what the rest of the surface is built from.
          borderRadius: 'var(--fx-radius-md)',
          border: `1.5px dashed ${
            dragging ? 'var(--fx-accent)' : contextMissing ? 'var(--fx-border-subtle)' : 'var(--fx-border-strong)'
          }`,
          background: dragging ? 'var(--fx-accent-subtle)' : 'var(--fx-bg-sunken)',
          // Fixed so the dialog does not jump between its three states, and modest so it
          // never becomes the tallest thing in a form it is only the doorway to.
          minHeight: 92,
          padding: '14px 16px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          cursor: contextMissing ? 'default' : busy ? 'progress' : 'pointer',
          opacity: contextMissing ? 0.75 : 1,
          transition: 'border-color 120ms var(--fx-ease-enter), background 120ms var(--fx-ease-enter)',
          outline: 'none',
        }}
      >
        <MarbimMark size={32} state={contextMissing ? 'blocked' : state} label={null} />

        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span
            style={{
              font: "500 13.5px/1.35 var(--fx-font-sans)",
              color: contextMissing ? 'var(--fx-text-tertiary)' : 'var(--fx-text-primary)',
            }}
          >
            {contextMissing
              ? contextMissing
              : busy
                ? stage === 'uploading'
                  ? 'Uploading…'
                  : 'Reading it…'
                : `Drop ${prompt} here`}
          </span>
          {contextMissing ? null : (
            <span
              style={{
                font: "400 12.5px/1.4 var(--fx-font-sans)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {busy
                ? 'This takes a few seconds.'
                : 'MARBIM fills the fields below. You check them and save — nothing is written until you do.'}
            </span>
          )}
        </div>

        {contextMissing || busy ? null : (
          <span
            style={{
              font: "500 12.5px/1 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
              borderBottom: '1px solid var(--fx-border-default)',
              paddingBottom: 2,
              whiteSpace: 'nowrap',
              flexShrink: 0,
            }}
          >
            or choose a file
          </span>
        )}

        <input
          ref={fileRef}
          type="file"
          hidden
          accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.xlsx,.csv,.txt,application/pdf,image/*"
          onChange={(e) => {
            const file = e.target.files?.[0]
            if (file) handle(file)
            // Cleared so choosing the SAME file again re-reads it — after a correction that
            // went wrong, picking the identical document is the obvious retry.
            e.target.value = ''
          }}
        />
      </div>

      {read ? (
        <InlineAlert tone="success">
          {read.count} field{read.count === 1 ? '' : 's'} filled in from the document, read by{' '}
          {read.model}. Check them against the paper — the percentages say where to look first
          — then save.
        </InlineAlert>
      ) : null}

      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
    </div>
  )
}

/**
 * How sure the reader was of one field, next to that field.
 *
 * Shown only for fields that were actually read: a value the person typed or picked has no
 * reading risk and marking it 100% would be flattery, not information.
 */
export function ReadMark({ confidence }: { confidence: number | null | undefined }) {
  if (confidence === null || confidence === undefined) return null
  const low = confidence < 0.8
  return (
    <span
      style={{
        font: "400 11.5px/1 var(--fx-font-sans)",
        color: low ? 'var(--fx-warning)' : 'var(--fx-text-tertiary)',
        marginLeft: 8,
        whiteSpace: 'nowrap',
      }}
    >
      {low ? 'worth checking' : 'read'} · {Math.round(confidence * 100)}%
    </span>
  )
}
