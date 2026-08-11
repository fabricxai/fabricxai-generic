'use client'

import { usePathname } from 'next/navigation'
import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import { MarbimSurface } from '@/app/(app)/marbim/surface-client'
import { MarbimMark } from '@/components/fx/mark'
import { useT } from '@/components/fx/locale'
import { listChatHistory } from '@/modules/marbim/actions'
import { tierFromSurfaceLabel } from '@/modules/marbim/surface-label'

import { MarbimHistoryView, type HistoryRow } from './marbim-history'
import { moduleForPath, screenLabelForPath, type MarbimEntry } from './marbim-context'
import { MARBIM_OPEN_EVENT } from './marbim-open'

const WIDTH_KEY = 'fabricxai.marbim.panelWidth'
const WIDTH_DEFAULT = 520
const WIDTH_MIN = 360
const WIDTH_MAX = 920

function clampWidth(value: number): number {
  const ceiling = Math.min(WIDTH_MAX, typeof window !== 'undefined' ? window.innerWidth : WIDTH_MAX)
  return Math.min(ceiling, Math.max(WIDTH_MIN, Math.round(value)))
}

/**
 * The stored width is read through `useSyncExternalStore`, which needs something to
 * subscribe to. Nothing outside this tab writes the key, so the subscription is a no-op —
 * declared honestly rather than omitted, because the hook's contract is that a change to the
 * store notifies React, and a future writer (a second panel, a settings screen) would
 * otherwise go unnoticed for reasons nobody could find.
 */
function subscribeToStoredWidth(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const relay = (e: StorageEvent) => {
    if (e.key === WIDTH_KEY) onChange()
  }
  window.addEventListener('storage', relay)
  return () => window.removeEventListener('storage', relay)
}

function readStoredWidth(): number {
  if (typeof window === 'undefined') return WIDTH_DEFAULT
  const raw = window.localStorage.getItem(WIDTH_KEY)
  const parsed = raw ? Number(raw) : NaN
  return Number.isFinite(parsed) ? clampWidth(parsed) : WIDTH_DEFAULT
}

/**
 * X.2 MARBIM Surface — the slide-over panel, built to the design canvas.
 *
 * Opens via the top-bar "Ask MARBIM" control or ⌘K. The panel opens OVER the screen
 * rather than replacing it, because the question a person has is almost always about
 * what they are looking at. Navigating away to ask it loses the thing they were pointing
 * at. That is also why the current screen's module is passed as `fromModule`: the answer
 * leads with that department's primer instead of all twenty-one.
 *
 * `/marbim` stays as the full-page surface — the right shape for a long session at a desk.
 *
 * Five things are load-bearing:
 *
 * 1. **The conversation id is generated on the client.** The shell re-renders on every
 *    navigation, so an id from the server would change mid-conversation and the turn indices
 *    would restart against a thread that already had turns.
 *
 * 2. **The thread survives close and navigation.** Once opened, the panel stays mounted
 *    (hidden when closed) so React state is not wiped; turns also reload from `chat_turns`
 *    when the conversation id changes. History lists this person's recent threads.
 *
 * 3. **The surface is imported, not reimplemented.** Two copies of the composer would drift,
 *    and the one people use less would be the one that rots.
 *
 * 4. **The scrim is deliberate.** An earlier build dropped it so the screen behind stayed
 *    clickable; the canvas says otherwise — scrim at .28 with the hatch, and the host
 *    desaturated to .55 (see `[data-marbim='open']` in theme.css). While MARBIM is open the
 *    screen behind is context, not content.
 */

export interface MarbimTrustLine {
  drafted: number
  approved: number
  correctedFields: number
  pending: number
  windowDays: number
}

export function MarbimPanel({ entry, trust }: { entry: MarbimEntry; trust: MarbimTrustLine }) {
  const [open, setOpen] = useState(false)
  // Mount once opened so close does not destroy the thread; stay mounted for the tab.
  const [mounted, setMounted] = useState(false)
  const [conversationId, setConversationId] = useState(() => globalThis.crypto.randomUUID())
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<HistoryRow[] | null>(null)
  const dragging = useRef(false)
  // "change scope" — narrow to this screen's department, or let MARBIM read across all of
  // them. The canvas puts this on the context chip; it is the one thing about a question
  // the panel cannot infer from where you are standing.
  const [wideScope, setWideScope] = useState(false)

  const words = useT()
  const pathname = usePathname()
  const screenModule = moduleForPath(pathname)
  const screenLabel = screenLabelForPath(pathname, words)

  /*
   * The stored width, read AFTER hydration.
   *
   * It cannot be the initial state: the server renders with no localStorage, and a client
   * that started from a stored width would mismatch. It used to be a mount effect calling
   * setState, which React's own lint objects to — an effect that sets state synchronously is
   * a cascading render. `useSyncExternalStore` is the supported way to read a store that
   * lives outside React: the server snapshot is the default, the client snapshot is what was
   * saved, and the swap happens without a second render pass of our own making.
   */
  const storedWidth = useSyncExternalStore(
    subscribeToStoredWidth,
    readStoredWidth,
    () => WIDTH_DEFAULT,
  )
  // Null until this session changes it, and then it wins — a resize is about the panel in
  // front of you, not about what a previous session preferred.
  const [sessionWidth, setSessionWidth] = useState<number | null>(null)
  const width = sessionWidth ?? storedWidth
  const setWidth = (next: number | ((current: number) => number)) =>
    setSessionWidth((current) =>
      typeof next === 'function' ? next(current ?? storedWidth) : next,
    )

  useEffect(() => {
    if (!mounted) return
    try {
      window.localStorage.setItem(WIDTH_KEY, String(width))
    } catch {
      // Private mode / quota — resize still works for the session.
    }
  }, [width, mounted])

  const onResizePointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    dragging.current = true
    const target = e.currentTarget
    target.setPointerCapture(e.pointerId)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    const onMove = (ev: PointerEvent) => {
      if (!dragging.current) return
      // Panel is right-docked: width is distance from the pointer to the right edge.
      setSessionWidth(clampWidth(window.innerWidth - ev.clientX))
    }
    const onUp = (ev: PointerEvent) => {
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      try {
        target.releasePointerCapture(ev.pointerId)
      } catch {
        // Already released.
      }
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }, [])

  const close = useCallback(() => {
    setHistoryOpen(false)
    setOpen(false)
  }, [])

  const openPanel = useCallback(() => {
    setMounted(true)
    setOpen(true)
  }, [])

  // The host desaturation is a stylesheet rule keyed on the document, because the element it
  // applies to is the page slot — a sibling this component cannot reach through React.
  useEffect(() => {
    const root = document.documentElement
    if (open) root.dataset.marbim = 'open'
    else delete root.dataset.marbim
    return () => {
      delete root.dataset.marbim
    }
  }, [open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (historyOpen) {
          setHistoryOpen(false)
          return
        }
        if (open) close()
        return
      }
      // ⌘K anywhere, per the canvas.
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        if (open) close()
        else openPanel()
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close, openPanel, historyOpen])

  // Any "Ask MARBIM" button anywhere — the top bar's, or a future in-context one on a
  // screen — asks through this rather than reaching into the panel's state.
  useEffect(() => {
    const onRequest = () => openPanel()
    window.addEventListener(MARBIM_OPEN_EVENT, onRequest)
    return () => window.removeEventListener(MARBIM_OPEN_EVENT, onRequest)
  }, [openPanel])

  useEffect(() => {
    if (!historyOpen) return
    let cancelled = false
    // Cleared by whoever OPENS the list, not here: a setState in an effect body is a
    // cascading render, and "show nothing while this loads" is a property of the gesture.
    void listChatHistory()
      .then((rows) => {
        if (!cancelled) setHistory(rows)
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [historyOpen])

  function startNewChat() {
    setConversationId(globalThis.crypto.randomUUID())
    setHistoryOpen(false)
  }

  function openConversation(id: string) {
    setConversationId(id)
    setHistoryOpen(false)
  }

  if (!mounted) return null

  return (
    <>
      {/* Scrim only while open — closed panel stays mounted but inert. */}
      {open ? (
        <div
          onClick={close}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 60,
            backgroundColor: 'rgb(24 29 41 / .28)',
            backgroundImage:
              'repeating-linear-gradient(146deg, transparent 0 7px, rgb(255 255 255 / .05) 7px 9px, transparent 9px 17px)',
          }}
        />
      ) : null}

      <aside
        role="dialog"
        aria-modal={open}
        aria-hidden={!open}
        // Not "Ask MARBIM" — the composer inside already carries that name, and two
        // nodes with the same accessible name make the panel and its input
        // indistinguishable to a screen reader.
        aria-label="MARBIM"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          zIndex: 61,
          width,
          maxWidth: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--fx-glass-bg)',
          backdropFilter: 'var(--fx-glass-blur)',
          WebkitBackdropFilter: 'var(--fx-glass-blur)',
          borderLeft: '1px solid var(--fx-glass-border)',
          boxShadow: 'var(--fx-sh3)',
          // Keep mounted when closed so the thread is not destroyed — hide instead.
          transform: open ? 'translateX(0)' : 'translateX(100%)',
          visibility: open ? 'visible' : 'hidden',
          pointerEvents: open ? 'auto' : 'none',
          transition: open ? undefined : 'visibility 0s linear 0.2s',
          animation: open ? 'fx-slide-in var(--fx-dur-overlay) var(--fx-ease-enter) both' : undefined,
        }}
      >
        {/* Left-edge grip — drag to widen or narrow. Width is remembered for the browser. */}
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize MARBIM"
          aria-valuenow={width}
          aria-valuemin={WIDTH_MIN}
          aria-valuemax={WIDTH_MAX}
          onPointerDown={onResizePointerDown}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') {
              e.preventDefault()
              setWidth((w) => clampWidth(w + 24))
            } else if (e.key === 'ArrowRight') {
              e.preventDefault()
              setWidth((w) => clampWidth(w - 24))
            }
          }}
          tabIndex={0}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: 10,
            marginLeft: -5,
            cursor: 'col-resize',
            zIndex: 2,
            touchAction: 'none',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 2,
              height: 40,
              borderRadius: 'var(--fx-radius-full)',
              background: 'var(--fx-border-default)',
            }}
          />
        </div>
        <header
          style={{
            padding: '18px 22px 14px',
            borderBottom: '1px solid var(--fx-border-subtle)',
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            flexShrink: 0,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span
              style={{
                width: 30,
                height: 30,
                borderRadius: 'var(--fx-radius-full)',
                // Surface plate so the theme's ink/white mark set stays
                // legible — an ink circle in light mode hid the ink strokes.
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-default)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <MarbimMark state="rest" size={20} label={null} />
            </span>
            <span
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 3,
                minWidth: 0,
              }}
            >
              <span style={{ font: '600 15px/1.2 var(--fx-font-sans)' }}>MARBIM</span>
              <span
                style={{
                  font: '400 12px/1.3 var(--fx-font-mono)',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {entry.packLabel} · ⌘K anywhere
              </span>
            </span>
            {!historyOpen ? (
              <button
                onClick={() => {
                  // Blank first, so a second visit does not show the previous list while
                  // the new one loads.
                  setHistory(null)
                  setHistoryOpen(true)
                }}
                aria-label="Earlier chats"
                title="Earlier chats"
                style={{
                  marginLeft: 'auto',
                  background: 'transparent',
                  border: '1px solid var(--fx-border-default)',
                  borderRadius: 'var(--fx-radius-md)',
                  padding: '9px 12px',
                  minHeight: 44,
                  font: '600 12.5px/1 var(--fx-font-mono)',
                  color: 'var(--fx-text-secondary)',
                  cursor: 'pointer',
                }}
              >
                earlier
              </button>
            ) : null}
            <button
              onClick={close}
              style={{
                marginLeft: historyOpen ? 'auto' : undefined,
                background: 'transparent',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-md)',
                padding: '9px 12px',
                minHeight: 44,
                font: '600 12.5px/1 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
                cursor: 'pointer',
              }}
            >
              Close
            </button>
          </div>

          {/* The scope chip stays on the chat view only — history has its own job. */}
          {!historyOpen ? (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                background: 'var(--fx-bg-sunken)',
                borderRadius: 'var(--fx-radius-md)',
                padding: '10px 12px',
                flexWrap: 'wrap',
              }}
            >
              <span
                style={{
                  width: 2,
                  height: 14,
                  transform: 'skewX(-34deg)',
                  background: 'var(--fx-accent)',
                  flexShrink: 0,
                }}
              />
              <span style={{ font: '500 13px/1.35 var(--fx-font-sans)' }}>
                {wideScope || !screenModule
                  ? 'Reading across every department'
                  : `You're on ${screenLabel}`}
              </span>
              <span
                style={{
                  font: '400 12px/1.3 var(--fx-font-mono)',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {wideScope || !screenModule ? 'all primers' : `${screenModule} primer leads`}
              </span>
              {screenModule ? (
                <button
                  onClick={() => setWideScope((v) => !v)}
                  style={{
                    marginLeft: 'auto',
                    background: 'transparent',
                    border: 'none',
                    font: '500 12px/1 var(--fx-font-mono)',
                    color: 'var(--fx-text-secondary)',
                    cursor: 'pointer',
                    textDecoration: 'underline',
                    textUnderlineOffset: 3,
                  }}
                >
                  change scope
                </button>
              ) : null}
            </div>
          ) : null}
        </header>

        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            padding: '20px 22px',
          }}
        >
          {/* Keep the chat mounted under history so going back does not wipe an in-flight turn. */}
          <div
            style={{
              display: historyOpen ? 'none' : 'flex',
              flexDirection: 'column',
              flex: 1,
              minHeight: 0,
            }}
          >
            <MarbimSurface
              /* A different thread is a different surface: keying it here is what lets the
                 surface treat "empty" as initial state rather than as five setState calls in
                 an effect. Panel open/close does not change the key, so a closed panel still
                 keeps its conversation. */
              key={conversationId}
              conversationId={conversationId}
              suggestions={entry.suggestions}
              packLabel={entry.packLabel}
              readOnly={entry.readOnly}
              fromModule={wideScope ? undefined : screenModule}
              initialTier={tierFromSurfaceLabel(entry.model)}
              floatingMark={false}
              autoFocus={open && !historyOpen}
            />
          </div>
          {historyOpen ? (
            <MarbimHistoryView
              history={history}
              activeId={conversationId}
              onOpen={openConversation}
              onNew={startNewChat}
              onBack={() => setHistoryOpen(false)}
            />
          ) : null}
        </div>

        {/* ── P4 · the trust footer ────────────────────────────────────
            Counted from this tenant's own drafts. A new factory sees zeroes, and that
            is the correct answer — borrowing somebody else's numbers to look
            established is exactly the dishonesty this line exists to refuse. */}
        <footer
          style={{
            padding: '12px 22px 16px',
            borderTop: '1px solid var(--fx-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            flexShrink: 0,
          }}
        >
          <span
            style={{
              font: '400 11.5px/1.4 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {trust.drafted === 0
              ? `no drafts yet · last ${trust.windowDays} days`
              : `drafted ${trust.drafted} · approved ${trust.approved} · corrected ${trust.correctedFields} fields`}
          </span>
          <a
            href="/approve"
            style={{
              font: '500 11.5px/1.4 var(--fx-font-mono)',
              marginLeft: 'auto',
            }}
          >
            audit trail
          </a>
        </footer>
      </aside>
    </>
  )
}
