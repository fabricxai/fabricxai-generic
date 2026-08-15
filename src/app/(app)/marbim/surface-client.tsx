'use client'

import { useEffect, useRef, useState, useTransition } from 'react'

import {
  AnswerActions,
  AnswerText,
  PartialAnswerNotice,
  SuggestedPrompts,
  ToolStrip,
  UserBubble,
  type ToolStep,
} from '@/components/fx/ai'
import { EmptyState } from '@/components/fx/feedback'
import { unwrap, type ActionFailure } from '@/lib/action-failure'
import { MarbimMark, type MarkState } from '@/components/fx/mark'
import { ask, loadChatTurns } from '@/modules/marbim/actions'
import {
  MARBIM_TIERS,
  surfaceLabelFor,
  type MarbimTier,
} from '@/modules/marbim/surface-label'

import { AttachControl, type Attachment } from './attach-client'
import {
  READABLE_BY_MARBIM,
  ReadDocumentFlow,
  UnreadableNote,
  type ReadDocumentHandle,
} from './read-document-client'

interface Turn {
  id: string
  question: string
  answer: string | null
  toolSteps: ToolStep[]
  failed: boolean
  /** `marbim large · 4 tools · 2.4 s` — product name, not the vendor id. */
  receipt: string | null
  /** How many tools actually ran. Decides what the footer is allowed to claim. */
  toolsRun: number
  vote?: 'up' | 'down' | null
  copied?: boolean
}

/**
 * The line under a tool strip: which product tier, how many tools, how long.
 *
 * The caption uses "marbim fast" / "marbim large". The vendor model that actually ran
 * is still recorded on the turn server-side — this string is only what a person reads.
 */
function receiptOf(model: string, toolCount: number, durationMs?: number): string {
  /*
   * "N tools" means N tools RAN, and since 6.5 that is finally true. It counted requests
   * before the execution loop existed, which is a fabricated citation — worse than no
   * citation, because it stops the reader checking (plan 6.2, audit AI-B3).
   */
  const tools =
    toolCount === 0 ? 'no tools run' : toolCount === 1 ? '1 tool' : `${toolCount} tools`
  const label = surfaceLabelFor(model) ?? model
  if (durationMs === undefined) return `${label} · ${tools}`
  const seconds = (durationMs / 1000).toFixed(1)
  return `${label} · ${tools} · ${seconds} s`
}

function turnsFromStored(
  rows: Exclude<Awaited<ReturnType<typeof loadChatTurns>>, ActionFailure>,
): Turn[] {
  return rows.map((row) => {
    const toolsRun = row.toolCalls.length
    return {
      id: row.id,
      question: row.question,
      answer: row.answer,
      failed: false,
      toolsRun,
      receipt: row.model ? receiptOf(row.model, toolsRun) : null,
      toolSteps: [
        {
          label: 'reading the department primers',
          state: 'done' as const,
        },
        ...row.toolCalls.map(
          (c): ToolStep => ({
            label: c.name,
            state: c.ok ? 'done' : 'failed',
            ...(c.error ? { meta: c.error } : c.ms ? { meta: `${c.ms} ms` } : {}),
          }),
        ),
      ],
    }
  })
}

/**
 * What the strip is allowed to claim (plan 6.2 → 6.5, audit AI-B3).
 *
 * The caveat used to be the FALLBACK — `turn.receipt ?? 'MARBIM states no number it did not
 * read from a tool'` — which put a grounding promise under an empty strip and replaced it
 * with a receipt the moment an answer arrived. Both halves were wrong: the promise was false
 * because nothing executed a tool, and it vanished at exactly the moment it mattered.
 *
 * 6.2 made it unconditional and true. 6.5 landed the execution loop, so it is now CONDITIONAL
 * on what actually happened — which is the state this was always heading for and the reason
 * the wording was kept precise rather than softened:
 *
 *  - tools ran → say what the strip above already lists, and that the rest is the model;
 *  - no tools ran → the 6.2 sentence, unchanged, because it is still exactly true.
 *
 * A turn where the model answered from the primers alone is COMMON and not a failure. Most
 * questions to a department copilot are "how does UD work", not "what is order 4410's
 * balance" — and the difference between those two is precisely what a reader needs to see.
 */
function StripFooter({ receipt, toolsRun }: { receipt?: string | null; toolsRun: number }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {receipt ? <span>{receipt}</span> : null}
      <span>
        {toolsRun > 0
          ? `Read from your factory’s data through the ${toolsRun === 1 ? 'tool' : 'tools'} above. Anything not listed there came from the department primers and the model’s own knowledge.`
          : 'Answered from the department primers and the model’s own knowledge. No tool was run, so no figure here has been read from your factory’s data — check anything you are about to act on.'}
      </span>
    </span>
  )
}

/**
 * The conversation surface.
 *
 * The mark carries the request state — listening while the composer has focus,
 * thinking between send and first token, resolved when the answer lands. It is
 * the only loading affordance on this screen.
 */
export function MarbimSurface({
  conversationId,
  suggestions,
  prefill = null,
  packLabel,
  readOnly,
  fromModule,
  floatingMark = true,
  autoFocus = false,
  initialTier = 'fast',
}: {
  conversationId: string
  suggestions: readonly string[]
  /** Seed for the composer from an "ask about this row" affordance. Stamped so the same
      text re-seeds; consumed by adjusting state during render, never by an effect. */
  prefill?: { text: string; at: number } | null
  packLabel: string
  readOnly: boolean
  /**
   * The screen this was opened from, so the answer leads with that department's primer
   * instead of all twenty-one. The page has no single module; the slide-over does.
   */
  fromModule?: string
  /**
   * The page pins the mark to the viewport corner. Inside the slide-over that would place
   * it over the screen behind the panel — the mark belongs to the surface, not the window —
   * so the panel renders its own in the header instead.
   */
  floatingMark?: boolean
  autoFocus?: boolean
  /** Composer starting tier — "marbim fast" or "marbim large". */
  initialTier?: MarbimTier
}) {
  const [turns, setTurns] = useState<Turn[]>([])
  const [hydrating, setHydrating] = useState(true)
  const [draft, setDraft] = useState('')
  // The adjust-during-render pattern (same as the tier): when a NEW prefill arrives, it
  // replaces the draft once; typing afterwards is the person's own.
  const [seenPrefill, setSeenPrefill] = useState<number | null>(null)
  if (prefill && prefill.at !== seenPrefill) {
    setSeenPrefill(prefill.at)
    setDraft(prefill.text)
  }
  const [tier, setTier] = useState<MarbimTier>(initialTier)
  const [focused, setFocused] = useState(false)
  const [mark, setMark] = useState<MarkState>('rest')
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [readyIds, setReadyIds] = useState<Set<string>>(() => new Set())
  const [pending, startTransition] = useTransition()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /*
   * The imperative handle of each read flow, filled by a CALLBACK ref.
   *
   * It used to be a map of refs built during render — `readHandleFor(id)` reading and writing
   * `readRefs.current` inline in JSX — which React's lint refuses outright: a render that
   * touches a ref is a render that is not a pure function of its inputs, and under concurrent
   * rendering it can run twice or be thrown away. A callback ref runs AFTER commit, which is
   * the moment the handle actually exists.
   */
  const readHandles = useRef(new Map<string, ReadDocumentHandle | null>())

  /*
   * Follow the prop when the PANEL changes it, without an effect.
   *
   * The tier is chosen in the composer, so it is this component's state; but the panel also
   * hands one down, and that has to win when it changes. Adjusting state during render — the
   * pattern React documents for exactly this — costs one extra render pass and no effect at
   * all, where `useEffect(() => setTier(…))` is a second commit and a cascading render its
   * own lint rule objects to.
   */
  const [lastGivenTier, setLastGivenTier] = useState(initialTier)
  if (initialTier !== lastGivenTier) {
    setLastGivenTier(initialTier)
    setTier(initialTier)
  }

  /*
   * Load this conversation's turns.
   *
   * It used to clear turns, attachments, ready ids and the draft synchronously here first —
   * five setState calls in an effect body, which is a cascading render React's lint refuses.
   * They are unnecessary: the mount sites key this component on `conversationId`, so picking
   * a thread from history mounts a NEW surface whose initial state is already empty. The
   * effect is left with the one thing an effect is for — talking to something outside React.
   */
  useEffect(() => {
    let cancelled = false
    void loadChatTurns({ conversationId })
      .then((rows) => {
        if (cancelled) return
        // A refusal comes back as a value; `unwrap` re-throws it into the catch below.
        setTurns(turnsFromStored(unwrap(rows)))
      })
      .catch(() => {
        if (!cancelled) setTurns([])
      })
      .finally(() => {
        if (!cancelled) setHydrating(false)
      })
    return () => {
      cancelled = true
    }
  }, [conversationId])

  // The slide-over opens because somebody wants to type. Landing the caret in the composer
  // is the difference between a panel and a panel you have to click into first.
  useEffect(() => {
    if (autoFocus && !hydrating) inputRef.current?.focus()
  }, [autoFocus, hydrating, conversationId])

  function send(question: string) {
    const text = question.trim()
    const docStarts: ReadDocumentHandle[] = []
    for (const attachment of attachments) {
      const handle = readHandles.current.get(attachment.documentId)
      if (handle?.isReady()) docStarts.push(handle)
    }

    if ((!text && docStarts.length === 0) || pending) return

    setDraft('')

    // Document reads first — they are independent of the chat turn index.
    for (const handle of docStarts) {
      void handle.start()
    }

    if (!text) {
      setMark('thinking')
      setTimeout(() => setMark('rest'), 600)
      return
    }

    const turnIndex = turns.length
    const localId = `${conversationId}:${turnIndex}`

    setTurns((t) => [
      ...t,
      {
        id: localId,
        question: text,
        answer: null,
        // One step, and it is the one genuinely happening. What the model will go on to
        // read is not knowable yet, and a plausible trace drawn ahead of the work is the
        // fabricated citation this screen spent 6.2 removing.
        toolSteps: [{ label: 'reading the department primers', state: 'active' }],
        failed: false,
        receipt: null,
        toolsRun: 0,
      },
    ])
    setMark('thinking')

    startTransition(async () => {
      try {
        // A refusal comes back as a value (production masks thrown messages); `unwrap`
        // re-throws it locally so the catch below marks the turn failed.
        const result = unwrap(
          await ask({
            conversationId,
            turnIndex,
            question: text,
            fromModule,
            tier,
          }),
        )
        setTurns((t) =>
          t.map((turn) =>
            turn.id === localId
              ? {
                  ...turn,
                  answer: result.answer,
                  toolSteps: [
                    {
                      label: 'reading the department primers',
                      meta: Object.entries(result.primerVersions)
                        .map(([m, v]) => `${m} ${v}`)
                        .join(' · '),
                      state: 'done',
                    },
                    /*
                     * `done` and `failed` are real again (plan 6.5). These are EXECUTIONS —
                     * the loop validated each call against the tool's own zod, ran it, and
                     * fed the result back — so the strip is a citation rather than a list
                     * of wishes. `requested` stays in the union for the capped case below.
                     */
                    ...result.toolCalls.map(
                      (c): ToolStep => ({
                        label: c.name,
                        state: c.ok ? 'done' : 'failed',
                        ...(c.error ? { meta: c.error } : c.ms ? { meta: `${c.ms} ms` } : {}),
                      }),
                    ),
                    // Said on the strip, because an answer forced out at the cap is one the
                    // model wanted more information for and did not get.
                    ...(result.cappedAtIterationLimit
                      ? [
                          {
                            label: 'stopped asking for tools',
                            meta: 'the answer was written from what had been read by then',
                            state: 'requested' as const,
                          },
                        ]
                      : []),
                  ],
                  receipt: receiptOf(result.model, result.toolCalls.length, result.durationMs),
                  toolsRun: result.toolCalls.length,
                }
              : turn,
          ),
        )
        setMark('resolved')
        setTimeout(() => setMark('rest'), 900)
      } catch {
        setTurns((t) =>
          t.map((turn) => (turn.id === localId ? { ...turn, failed: true } : turn)),
        )
        setMark('blocked')
      }
    })
  }

  const canSend = Boolean(draft.trim() || readyIds.size > 0) && !pending && !hydrating

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 880,
        // Grow into the slide-over body / full-page column so the composer docks.
        // height:% fails when the parent only has min-height; flex:1 needs a
        // definite parent height (the page sets one; the panel body is a flex child).
        flex: 1,
        minHeight: 0,
        width: '100%',
      }}
    >
      <div
        className="fx-scroll-quiet"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 24,
        }}
      >
        {hydrating ? (
          <span
            style={{
              font: '400 12.5px/1.4 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            Loading conversation…
          </span>
        ) : turns.length === 0 ? (
          <EmptyState
            title="Ask about an order, a line, or a date"
            body="MARBIM reads what your role can already read. It proposes changes for you to approve — it never writes to this factory itself."
          />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
            {turns.map((turn) => (
              <div key={turn.id} style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                <UserBubble>{turn.question}</UserBubble>

                <div style={{ display: 'flex', gap: 14 }}>
                  <div
                    style={{
                      width: 30,
                      height: 30,
                      borderRadius: 'var(--fx-radius-full)',
                      background: 'var(--fx-bg-surface)',
                      border: '1px solid var(--fx-border-default)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}
                  >
                    <MarbimMark
                      state={turn.answer || turn.failed ? 'rest' : 'thinking'}
                      size={20}
                      label={null}
                    />
                  </div>

                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 14,
                      minWidth: 0,
                      flex: 1,
                    }}
                  >
                    <ToolStrip
                      steps={turn.toolSteps}
                      footer={<StripFooter receipt={turn.receipt} toolsRun={turn.toolsRun} />}
                    />

                    {turn.failed ? (
                      <PartialAnswerNotice
                        trusted="Nothing above was written."
                        untrusted="The run stopped before it produced an answer, so there is nothing here to act on."
                        onRetry={() => send(turn.question)}
                      />
                    ) : turn.answer ? (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <AnswerText>{turn.answer}</AnswerText>
                        <AnswerActions
                          vote={turn.vote ?? null}
                          copied={turn.copied}
                          onCopy={() => {
                            void navigator.clipboard?.writeText(turn.answer ?? '').then(() => {
                              setTurns((list) =>
                                list.map((row) =>
                                  row.id === turn.id ? { ...row, copied: true } : row,
                                ),
                              )
                              window.setTimeout(() => {
                                setTurns((list) =>
                                  list.map((row) =>
                                    row.id === turn.id ? { ...row, copied: false } : row,
                                  ),
                                )
                              }, 1500)
                            })
                          }}
                          onGood={() => {
                            setTurns((list) =>
                              list.map((row) =>
                                row.id === turn.id
                                  ? { ...row, vote: row.vote === 'up' ? null : 'up' }
                                  : row,
                              ),
                            )
                          }}
                          onBad={() => {
                            setTurns((list) =>
                              list.map((row) =>
                                row.id === turn.id
                                  ? { ...row, vote: row.vote === 'down' ? null : 'down' }
                                  : row,
                              ),
                            )
                          }}
                          onRetry={() => send(turn.question)}
                        />
                      </div>
                    ) : (
                      <AnswerText streaming>{''}</AnswerText>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        {!hydrating && turns.length === 0 ? (
          <SuggestedPrompts label={packLabel} prompts={suggestions} onPick={send} />
        ) : null}
      </div>

      <div
        style={{
          flexShrink: 0,
          border: '1px solid var(--fx-border-default)',
          borderRadius: 'var(--fx-radius-lg)',
          background: 'var(--fx-bg-surface)',
          padding: '13px 15px',
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        <textarea
          ref={inputRef}
          value={draft}
          rows={2}
          onFocus={() => {
            setFocused(true)
            if (mark === 'rest') setMark('listening')
          }}
          onBlur={() => {
            setFocused(false)
            if (mark === 'listening') setMark('rest')
          }}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              send(draft)
            }
          }}
          placeholder="Ask about an order, a line, or a date…"
          aria-label="Ask MARBIM"
          style={{
            border: 'none',
            outline: 'none',
            resize: 'none',
            background: 'transparent',
            color: 'var(--fx-text-primary)',
            font: '400 15px/1.5 var(--fx-font-sans)',
          }}
        />
        {/* The bridge from "attached" to "drafted": prepare with chips, start with Send.
            Hidden for read-only roles — their submit would 403, and chips that refuse are
            worse than no chips. Keyed by document id so a second attach gets its own flow.

            A file it cannot read gets a SENTENCE rather than nothing. The upload allowlist
            is wider than what can be drafted from (legacy .doc, HEIC), and the difference
            used to be expressed as silence: the file appeared, no chips came, and there was
            no way to tell a slow screen from an unsupported one. */}
        {!readOnly
          ? attachments.map((a) =>
              READABLE_BY_MARBIM(a.mimeType) ? (
                <ReadDocumentFlow
                  key={a.documentId}
                  ref={(handle) => {
                    readHandles.current.set(a.documentId, handle)
                  }}
                  attachment={a}
                  onReadyChange={(ready) => {
                    setReadyIds((prev) => {
                      const next = new Set(prev)
                      if (ready) next.add(a.documentId)
                      else next.delete(a.documentId)
                      return next
                    })
                  }}
                />
              ) : (
                <UnreadableNote key={a.documentId} attachment={a} />
              ),
            )
          : null}
        <AttachControl
          attachments={attachments}
          onAttach={(a) => setAttachments((list) => [...list, a])}
          onRemove={(id) => {
            readHandles.current.delete(id)
            setReadyIds((prev) => {
              const next = new Set(prev)
              next.delete(id)
              return next
            })
            setAttachments((list) => list.filter((a) => a.documentId !== id))
          }}
          disabled={readOnly}
        >
          <label style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as MarbimTier)}
              aria-label="MARBIM model"
              disabled={pending}
              style={{
                appearance: 'none',
                WebkitAppearance: 'none',
                background: 'transparent',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-sm)',
                padding: '9px 28px 9px 11px',
                font: '500 12px/1 var(--fx-font-mono)',
                color: 'var(--fx-text-secondary)',
                cursor: pending ? 'not-allowed' : 'pointer',
                minHeight: 44,
                backgroundImage:
                  "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6' viewBox='0 0 10 6'%3E%3Cpath fill='%236B7280' d='M1 1l4 4 4-4'/%3E%3C/svg%3E\")",
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 10px center',
              }}
            >
              {MARBIM_TIERS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <span
            style={{ font: '400 11.5px/1.4 var(--fx-font-mono)', color: 'var(--fx-text-tertiary)' }}
          >
            {readOnly ? 'read-only role · answers only' : 'proposes drafts · never writes'}
          </span>
          {/* The one amber moment on this screen. */}
          <button
            onClick={() => send(draft)}
            disabled={!canSend}
            aria-label="Send"
            style={{
              marginLeft: 'auto',
              width: 44,
              height: 44,
              borderRadius: 'var(--fx-radius-md)',
              background: canSend ? 'var(--fx-accent)' : 'var(--fx-bg-sunken)',
              color: canSend ? 'var(--fx-accent-on)' : 'var(--fx-text-disabled)',
              border: 'none',
              cursor: canSend ? 'pointer' : 'not-allowed',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              font: '600 16px/1 var(--fx-font-sans)',
            }}
          >
            ↑
          </button>
        </AttachControl>
      </div>

      <p
        style={{
          margin: 0,
          padding: '0 4px',
          font: '400 11.5px/1.45 var(--fx-font-mono)',
          color: 'var(--fx-text-tertiary)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        AI can be wrong — check before you act · proposes drafts · never writes
      </p>

      {/* Bottom-right, in whichever of its six states fits. */}
      {floatingMark ? (
        <div style={{ position: 'fixed', right: 28, bottom: 28, zIndex: 40 }}>
          <MarbimMark
            state={focused && mark === 'rest' ? 'listening' : mark}
            size={32}
            label={null}
          />
        </div>
      ) : null}
    </div>
  )
}
