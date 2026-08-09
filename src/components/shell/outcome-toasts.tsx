'use client'

import { useEffect, useRef, useState } from 'react'

import { OUTCOME_EVENT, type OutcomeDetail, type OutcomeKind } from '@/lib/notify'

interface Shown extends OutcomeDetail {
  id: number
}

const TONE: Record<OutcomeKind, { border: string; mark: string; label: string }> = {
  done: { border: 'var(--fx-success)', mark: '✓', label: 'done' },
  refused: { border: 'var(--fx-warning)', mark: '✕', label: 'refused' },
  failed: { border: 'var(--fx-danger)', mark: '!', label: 'failed' },
}

/**
 * The shell's outcome stack — mounted once in the app layout, fed by `notifyOutcome`.
 *
 * Bottom-right, small, self-dismissing: a receipt, not a dialog. It repeats what the
 * screen already says inline, because the inline banner is the one that scrolls away
 * and the person mid-task needs the answer to "did that happen?" where their eye is.
 */
export function OutcomeToasts() {
  const [shown, setShown] = useState<Shown[]>([])
  const nextId = useRef(1)
  const lastMessage = useRef<{ message: string; at: number }>({ message: '', at: 0 })

  useEffect(() => {
    function onOutcome(e: Event) {
      const detail = (e as CustomEvent<OutcomeDetail>).detail
      if (!detail?.message) return

      // The same sentence twice within a second is one outcome reported by two layers
      // (an inline banner and a catch block), not two outcomes.
      const now = Date.now()
      if (detail.message === lastMessage.current.message && now - lastMessage.current.at < 1000) {
        return
      }
      lastMessage.current = { message: detail.message, at: now }

      const id = nextId.current++
      setShown((s) => [...s.slice(-3), { ...detail, id }])
      setTimeout(() => {
        setShown((s) => s.filter((t) => t.id !== id))
      }, 6000)
    }

    window.addEventListener(OUTCOME_EVENT, onOutcome)
    return () => window.removeEventListener(OUTCOME_EVENT, onOutcome)
  }, [])

  if (shown.length === 0) return null

  return (
    <div
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 80,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        maxWidth: 'min(380px, calc(100vw - 32px))',
      }}
    >
      {shown.map((toast) => {
        const tone = TONE[toast.kind]
        return (
          <div
            key={toast.id}
            onClick={() => setShown((s) => s.filter((t) => t.id !== toast.id))}
            style={{
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
              padding: '10px 14px',
              background: 'var(--fx-bg-raised)',
              border: '1px solid var(--fx-border-subtle)',
              borderLeft: `3px solid ${tone.border}`,
              borderRadius: 'var(--fx-radius-md)',
              boxShadow: 'var(--fx-sh2)',
              cursor: 'pointer',
            }}
          >
            <span
              aria-hidden
              style={{
                font: "600 12px/1.4 var(--fx-font-mono)",
                color: tone.border,
                flexShrink: 0,
              }}
            >
              {tone.mark}
            </span>
            <span
              style={{
                font: "400 13px/1.45 var(--fx-font-sans)",
                color: 'var(--fx-text-primary)',
                overflowWrap: 'anywhere',
              }}
            >
              {toast.message}
            </span>
          </div>
        )
      })}
    </div>
  )
}
