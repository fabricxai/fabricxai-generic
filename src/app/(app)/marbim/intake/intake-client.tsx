'use client'

import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { uploadDocument } from '@/lib/upload-document'
import { intakeContext, readDocument, type ContextOption } from '@/modules/marbim/actions'

interface Kind {
  id: string
  label: string
  hint: string
  moduleId: string
  targetTable: string
  /** True when the kind needs ids no document carries — the screen fetches the pickers. */
  needsContext: boolean
}

interface ContextField {
  field: string
  label: string
  options: ContextOption[]
}

type Attachment =
  | { state: 'none' }
  | { state: 'uploading'; filename: string }
  | {
      state: 'attached'
      documentId: string
      filename: string
      /** The model opens it directly. */
      modelReadable: boolean
      /** The server converts it to text first. Either one can carry the submission. */
      serverReadable: boolean
    }
  | { state: 'failed'; message: string }

/** Text-bearing types the browser can read without anything parsing them. */
const READABLE = /\.(txt|csv|md|eml|json)$/i

/**
 * Types the extract model reads natively — the server's `MODEL_READABLE_MIME`, mirrored here
 * so the button can enable before a round-trip. The server re-checks against the stored
 * mime, so a spoofed type gets refused at the door, not queued.
 */
const MODEL_READABLE = /^(application\/pdf|image\/(jpeg|png|webp))$/

/**
 * Types the SERVER turns into text before the model sees them.
 *
 * The two sets are separate because they read differently and the screen says so, but they
 * are equally submittable — which the send gate did not know. `fileCarries` tested only
 * `MODEL_READABLE`, so attaching a buyer's PO as the .docx it actually arrives as left the
 * button disabled, with no explanation, on the one screen built to read it. The server had
 * accepted that exact file since the converter was written.
 *
 * Mirrors `TEXT_EXTRACTABLE_MIME` in `lib/document-text.ts`. `.csv` is in both places on
 * purpose: it fills the paste box client-side as well, and either route works.
 */
const SERVER_READABLE =
  /^(text\/csv|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet))$/

/**
 * Say what it is, give MARBIM the text, optionally attach the original.
 *
 * **The type is chosen before anything else.** Picking first means the screen can say where
 * the draft will land before somebody commits work to it — "this becomes a draft order in the
 * approve inbox" is the sentence that lets them notice they picked wrong, and it is useless
 * afterwards.
 *
 * **Text or a readable file — either is enough.** Pasted text is read when it exists.
 * Without it, a PDF or photo (JPEG/PNG/WebP) is handed to the extract model directly — the
 * vendor's own reader sees the pages, and per-field confidence measures the whole journey
 * from pixels to value. A Word file or spreadsheet is converted to text on the server and
 * read the same way. Only what neither can open (a legacy .doc, a HEIC photo) still needs
 * its text pasted, and the copy under the box says which is which so nobody drops a scan and
 * waits for a draft that cannot come.
 *
 * **Queued, not done.** The queue is now immediate rather than a five-minute tick (plan 6.6:
 * `marbim.extraction.queued` routes to the derive queue), but the confirmation still says
 * queued rather than implying a draft exists — a model call is seconds with a real failure
 * rate, and a screen that said "drafted" would send somebody to an approve inbox that is
 * still empty.
 */
export function IntakeClient({ kinds }: { kinds: readonly Kind[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const fileRef = useRef<HTMLInputElement>(null)

  const [chosen, setChosen] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [attachment, setAttachment] = useState<Attachment>({ state: 'none' })
  const [queued, setQueued] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const [context, setContext] = useState<ContextField[]>([])
  const [contextValues, setContextValues] = useState<Record<string, string>>({})

  const kind = kinds.find((k) => k.id === chosen) ?? null

  // Every declared field answered. The button is disabled until then rather than the
  // server refusing after an upload — the person has already done the work by that point.
  const contextComplete = context.every((field) => contextValues[field.field])

  function pick(k: Kind) {
    setChosen(k.id)
    setQueued(null)
    setFailure(null)
    setContext([])
    setContextValues({})

    if (!k.needsContext) return
    void intakeContext(k.id)
      .then(setContext)
      .catch((error: unknown) =>
        setFailure(actionErrorMessage(error, 'The choices could not be loaded.')),
      )
  }

  async function onFile(file: File) {
    if (!kind) return
    setFailure(null)
    setAttachment({ state: 'uploading', filename: file.name })

    try {
      // The document is filed under the module it will be drafted into, not under MARBIM.
      // A UD scan belongs to commercial whether or not a model ever read it.
      const uploaded = await uploadDocument(file, { kind: kind.id, moduleId: kind.moduleId })
      setAttachment({
        state: 'attached',
        documentId: uploaded.documentId,
        filename: file.name,
        modelReadable: MODEL_READABLE.test(file.type),
        serverReadable: SERVER_READABLE.test(file.type),
      })

      // A text file can fill the box itself. A PDF cannot, and pretending otherwise by
      // silently leaving the box empty is how somebody submits nothing to read.
      if (READABLE.test(file.name) && text.trim() === '') {
        setText((await file.text()).slice(0, 200_000))
      }
    } catch (error) {
      setAttachment({
        state: 'failed',
        message: actionErrorMessage(error, 'The upload did not complete.'),
      })
    }
  }

  // The file carries the submission by itself when ANYTHING can read it — the model
  // directly, or the server's converter first. Both end up as source text for the same
  // extractor, the same measured confidence and the same approve inbox.
  const fileCarries =
    attachment.state === 'attached' && (attachment.modelReadable || attachment.serverReadable)
  const readable = text.trim() !== '' || fileCarries

  function send() {
    if (!kind || !readable || !contextComplete) return
    setFailure(null)

    startTransition(async () => {
      try {
        // A refusal comes back as a value (production masks thrown messages); `unwrap`
        // re-throws it locally so the catch below shows the server's real sentence.
        const result = unwrap(
          await readDocument({
            kindId: kind.id,
            sourceText: text.trim() === '' ? undefined : text,
            documentId: attachment.state === 'attached' ? attachment.documentId : undefined,
            contextValues,
          }),
        )
        setQueued(result.label)
        setChosen(null)
        setText('')
        setAttachment({ state: 'none' })
        setContext([])
        setContextValues({})
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'MARBIM was not asked to read it.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {queued ? (
        <InlineAlert tone="success">
          {queued} queued. MARBIM starts reading it now and files a draft — it will appear in
          the approve inbox, not in the module, until somebody signs it. You will be told when
          it is ready.
        </InlineAlert>
      ) : null}

      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
      {attachment.state === 'failed' ? (
        <InlineAlert tone="warning">
          {attachment.message} The text below is still readable without it — the attachment
          only lets an approver check the original.
        </InlineAlert>
      ) : null}

      {/* ── What is it? ──────────────────────────────────────────────────── */}
      <section>
        <SectionHeading eyebrow="you say what it is — a classifier that guessed wrong would be worse">
          What are we reading?
        </SectionHeading>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))',
            gap: 10,
          }}
        >
          {kinds.map((k) => {
            const on = k.id === chosen
            return (
              <button
                key={k.id}
                onClick={() => pick(k)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  textAlign: 'left',
                  minHeight: 92,
                  padding: '14px 16px',
                  borderRadius: 'var(--fx-radius-md)',
                  border: `1px solid ${on ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                  background: on
                    ? 'color-mix(in srgb, var(--fx-accent) 10%, var(--fx-bg-surface))'
                    : 'var(--fx-bg-surface)',
                  color: 'var(--fx-text-primary)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ font: '600 14px/1.3 var(--fx-font-sans)' }}>{k.label}</span>
                <span
                  style={{
                    font: '400 12px/1.5 var(--fx-font-sans)',
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {k.hint}
                </span>
              </button>
            )
          })}
        </div>
      </section>

      {/* ── What the paper cannot say ────────────────────────────────────── */}
      {kind && context.length > 0 ? (
        <section>
          <SectionHeading eyebrow="the extractor cannot find these — the document does not carry them">
            What the document does not say
          </SectionHeading>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {context.map((field) => (
              <label
                key={field.field}
                style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 520 }}
              >
                <span style={{ font: '500 13px/1.3 var(--fx-font-sans)' }}>{field.label}</span>
                <select
                  value={contextValues[field.field] ?? ''}
                  onChange={(e) =>
                    setContextValues((prev) => ({ ...prev, [field.field]: e.target.value }))
                  }
                  style={{
                    padding: '10px 12px',
                    border: '1px solid var(--fx-border-default)',
                    borderRadius: 'var(--fx-radius-sm)',
                    background: 'var(--fx-bg-surface)',
                    color: 'var(--fx-text-primary)',
                    font: '400 14px/1.5 var(--fx-font-sans)',
                  }}
                >
                  <option value="">Choose…</option>
                  {field.options.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.detail ? `${option.label} — ${option.detail}` : option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}

            {/* Why a person is being asked at all. Without this the picker reads as an
                omission in the extractor rather than a fact about paper. */}
            <span
              style={{
                font: '400 12px/1.6 var(--fx-font-mono)',
                color: 'var(--fx-text-tertiary)',
              }}
            >
              A buyer&rsquo;s PO names the buyer in words; the id we file them under exists only
              here, and no document has ever carried it. What you choose is recorded as yours —
              certain, and shown apart from what the model read.
            </span>
          </div>
        </section>
      ) : null}

      {/* ── The text ─────────────────────────────────────────────────────── */}
      {kind ? (
        <section>
          <SectionHeading eyebrow={`drafts into ${kind.moduleId} · ${kind.targetTable}`}>
            The text to read
          </SectionHeading>

          <textarea
            rows={10}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Paste the ${kind.label.replace(/^An? /, '').toLowerCase()} here — from the buyer's email, or selected out of the PDF viewer.`}
            style={{
              width: '100%',
              minWidth: 0,
              padding: '12px 14px',
              border: '1px solid var(--fx-border-default)',
              borderRadius: 'var(--fx-radius-sm)',
              background: 'var(--fx-bg-surface)',
              color: 'var(--fx-text-primary)',
              font: '400 13px/1.6 var(--fx-font-mono)',
              resize: 'vertical',
            }}
          />

          <p
            style={{
              marginTop: 8,
              marginBottom: 0,
              font: '400 12px/1.6 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {/* Said plainly rather than discovered — which types are read how. */}
            Paste the text, or skip it: attach the file below instead. A PDF or photo (JPEG,
            PNG, WebP) is read by the model directly, pages and all. A Word document or
            spreadsheet is converted to text on the server first — tables included — and read
            the same way. Only a legacy .doc or a HEIC photo still needs its text pasted here.
            When you paste AND attach, the paste is what gets read. A .txt or .csv attachment
            fills this box on its own.
          </p>
        </section>
      ) : null}

      {/* ── The original ─────────────────────────────────────────────────── */}
      {kind ? (
        <section>
          <SectionHeading eyebrow="optional — so an approver can check the text against the paper">
            The original document
          </SectionHeading>

          <input
            ref={fileRef}
            type="file"
            /*
             * Word and Excel belong here, and were missing.
             *
             * The server has read them since the day the extractor was written:
             * `readDocument` accepts anything in `TEXT_EXTRACTABLE_MIME`, and
             * `marbim/service.ts` converts the bytes before the model ever sees them. Only
             * this attribute — and the sentence below it, which told people to paste
             * instead — kept the door shut. A buyer's PO arrives as a .docx more often than
             * as anything else, so the one document this screen exists for was the one it
             * would not take.
             */
            accept="application/pdf,image/*,.txt,.csv,.md,.eml,.docx,.xlsx,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            style={{ display: 'none' }}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void onFile(file)
              e.target.value = ''
            }}
          />

          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <Button
              variant="secondary"
              disabled={attachment.state === 'uploading' || pending}
              onClick={() => fileRef.current?.click()}
            >
              {attachment.state === 'uploading' ? 'Uploading…' : 'Attach the original'}
            </Button>

            {attachment.state === 'attached' ? (
              <span
                style={{
                  font: '400 13px/1.4 var(--fx-font-mono)',
                  color: 'var(--fx-text-secondary)',
                }}
              >
                {attachment.filename} attached
                {text.trim() !== ''
                  ? ''
                  : attachment.modelReadable
                    ? ' — the model will read it directly'
                    : attachment.serverReadable
                      ? ' — its text will be read'
                      : ''}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}

      {/* ── Send ─────────────────────────────────────────────────────────── */}
      {kind ? (
        <section style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div>
            <Button
              variant="primary"
              disabled={pending || !readable || !contextComplete || attachment.state === 'uploading'}
              onClick={send}
            >
              {pending ? 'Sending…' : 'Ask MARBIM to read it'}
            </Button>
          </div>

          <p
            style={{
              margin: 0,
              font: '400 12px/1.6 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            Whatever it reads becomes a draft with a confidence on every field, waiting in the
            approve inbox. Nothing reaches {kind.targetTable} until a person signs it — that is
            what makes reading a document with a model safe, and it does not depend on the
            model being right.
          </p>
        </section>
      ) : null}
    </div>
  )
}
