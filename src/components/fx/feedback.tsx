'use client'

import type { ReactNode } from 'react'
import { useEffect, useRef } from 'react'

import { notifyOutcome } from '@/lib/notify'

import { useT } from './locale'
import { Button } from './primitives'
import { MarbimMark, MarbimSpinner } from './mark'

/**
 * Feedback surfaces: overlays, alerts, empty and loading states.
 *
 * There is no circular spinner in this system. Every loading affordance is the
 * MARBIM mark, and empty states are the one place the weave field and the mark
 * appear together.
 */

/* ── Modal ────────────────────────────────────────────────
   Radius lg, a cut corner top-right, and a weave-field scrim. */

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  /*
   * 640, up from 440 (live-test feedback, Phase 9): at 440 any modal with a row of
   * fields — a finding's severity/clause/description, a gazette's six grade columns —
   * clipped its own inputs to placeholder-width slivers. Wide enough to seat a form row,
   * still capped by the viewport on a phone.
   */
  width = 640,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backgroundColor: 'rgb(24 29 41 / .55)',
        backgroundImage:
          'repeating-linear-gradient(146deg, transparent 0 7px, rgb(255 255 255 / .06) 7px 9px, transparent 9px 17px)',
        animation: 'none',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        className="fx-cut"
        style={{
          background: 'var(--fx-bg-raised)',
          border: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-lg)',
          boxShadow: 'var(--fx-sh3)',
          padding: 32,
          width,
          maxWidth: 'min(100%, 94vw)',
          maxHeight: '90vh',
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        <h3
          style={{
            font: "600 22px/1.2 var(--fx-font-sans)",
            margin: 0,
            color: 'var(--fx-text-primary)',
          }}
        >
          {title}
        </h3>
        <div
          style={{
            font: "400 15px/1.55 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
            textWrap: 'pretty',
          }}
        >
          {children}
        </div>
        {footer ? (
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', marginTop: 6 }}>
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  )
}

/**
 * The confirm pattern, required for destructive and money actions. It states
 * the consequence rather than asking "are you sure?".
 */
export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  consequence,
  confirmLabel,
  cancelLabel = 'Keep it',
  danger = true,
}: {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: ReactNode
  consequence: ReactNode
  confirmLabel: string
  cancelLabel?: string
  danger?: boolean
}) {
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {consequence}
    </Modal>
  )
}

/* ── Drawer ───────────────────────────────────────────────
   Route-driven detail surface. Radius lg on the leading edge only. */

export function Drawer({
  open,
  onClose,
  title,
  children,
  width = 560,
  footer,
}: {
  open: boolean
  onClose: () => void
  title: ReactNode
  children: ReactNode
  width?: number
  footer?: ReactNode
}) {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 55,
        display: 'flex',
        justifyContent: 'flex-end',
        backgroundColor: 'rgb(24 29 41 / .45)',
        backgroundImage:
          'repeating-linear-gradient(146deg, transparent 0 7px, rgb(255 255 255 / .05) 7px 9px, transparent 9px 17px)',
      }}
    >
      <aside
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--fx-bg-surface)',
          borderLeft: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-lg) 0 0 var(--fx-radius-lg)',
          boxShadow: 'var(--fx-sh3)',
          width,
          maxWidth: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <header
          style={{
            padding: '22px 26px',
            borderBottom: '1px solid var(--fx-border-subtle)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 16,
          }}
        >
          <h2 style={{ font: "600 20px/1.2 var(--fx-font-sans)", margin: 0 }}>{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label="Close">
            ✕
          </Button>
        </header>
        <div style={{ padding: 26, overflowY: 'auto', flex: 1 }}>{children}</div>
        {footer ? (
          <footer
            style={{
              padding: '18px 26px',
              borderTop: '1px solid var(--fx-border-subtle)',
              display: 'flex',
              gap: 10,
              justifyContent: 'flex-end',
            }}
          >
            {footer}
          </footer>
        ) : null}
      </aside>
    </div>
  )
}

/* ── Inline alert ─────────────────────────────────────────
   A dot plus text, never a tinted background. Warning is --fx-warning,
   never amber: amber means a person must act, not that something is wrong. */

export type AlertTone = 'info' | 'success' | 'warning' | 'danger'

export function InlineAlert({
  tone = 'info',
  children,
  action,
}: {
  tone?: AlertTone
  children: ReactNode
  action?: ReactNode
}) {
  const colour = `var(--fx-${tone === 'info' ? 'info' : tone})`
  const outlined = tone === 'danger' || tone === 'warning'

  /*
   * A success banner announces itself to the shell's outcome stack on mount (live-test
   * feedback, Phase 9): the inline banner is the one that scrolls out of view, and the
   * edge toast is where a mid-task eye actually looks. Success only — danger and warning
   * outcomes are announced by `actionErrorMessage` at the moment they are formatted, and
   * a page's STATIC warnings (a gate explainer, a landing-page alert) must not toast on
   * every visit. The toast host dedupes the rare double.
   */
  const announceRef = useRef<HTMLDivElement>(null)
  const lastAnnounced = useRef('')
  // No deps on purpose: the effect runs after every render and the guard below makes each
  // distinct sentence announce exactly once, however React re-renders around it.
  useEffect(() => {
    if (tone !== 'success') return
    const text = announceRef.current?.textContent?.trim() ?? ''
    if (text && text !== lastAnnounced.current) {
      lastAnnounced.current = text
      notifyOutcome('done', text)
    }
  })

  return (
    <div
      ref={announceRef}
      role={tone === 'danger' ? 'alert' : 'status'}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 12,
        background: outlined ? 'transparent' : 'var(--fx-bg-sunken)',
        border: outlined ? `1px solid ${colour}` : '1px solid transparent',
        borderRadius: 'var(--fx-radius-md)',
        padding: '14px 16px',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 7,
          height: 7,
          borderRadius: 'var(--fx-radius-full)',
          background: colour,
          marginTop: 6,
          flexShrink: 0,
        }}
      />
      <div style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
        {children}
      </div>
      {action ? <div style={{ marginLeft: 'auto' }}>{action}</div> : null}
    </div>
  )
}

export function Toast({
  message,
  onUndo,
}: {
  message: ReactNode
  onUndo?: () => void
}) {
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        background: 'var(--fx-text-primary)',
        color: 'var(--fx-text-inverse)',
        borderRadius: 'var(--fx-radius-md)',
        padding: '13px 16px',
        boxShadow: 'var(--fx-sh2)',
      }}
    >
      <span style={{ font: "500 13px/1.4 var(--fx-font-sans)" }}>{message}</span>
      {onUndo ? (
        <button
          onClick={onUndo}
          style={{
            marginLeft: 'auto',
            background: 'transparent',
            border: 'none',
            color: 'var(--fx-accent)',
            font: "600 12px/1 var(--fx-font-sans)",
            cursor: 'pointer',
          }}
        >
          Undo
        </button>
      ) : null}
    </div>
  )
}

/* ── Empty, loading, error and locked ─────────────────────── */

/** The one place the weave field and the mark appear together. */
export function EmptyState({
  title,
  body,
  action,
}: {
  title: ReactNode
  body?: ReactNode
  action?: ReactNode
}) {
  return (
    <div
      className="fx-weave"
      style={{
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        padding: '34px 24px',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 16,
        textAlign: 'center',
        backgroundColor: 'var(--fx-bg-surface)',
      }}
    >
      <MarbimMark size={48} label={null} />
      <div style={{ font: "600 17px/1.25 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
        {title}
      </div>
      {body ? (
        <div
          style={{
            font: "400 14px/1.55 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
            maxWidth: '34ch',
            textWrap: 'pretty',
          }}
        >
          {body}
        </div>
      ) : null}
      {action}
    </div>
  )
}

/** The weave loader. Replaces every spinner in the product. */
export function LoadingState({ label = 'Loading' }: { label?: string }) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 14,
        padding: 48,
      }}
    >
      <MarbimSpinner size={48} label={label} />
      <span style={{ font: "400 13px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
        {label}
      </span>
    </div>
  )
}

export function ErrorState({
  title = 'That did not load',
  body,
  onRetry,
}: {
  title?: ReactNode
  body?: ReactNode
  onRetry?: () => void
}) {
  return (
    <div
      role="alert"
      style={{
        border: '1px solid var(--fx-danger)',
        borderRadius: 'var(--fx-radius-md)',
        padding: 28,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'flex-start',
        gap: 12,
      }}
    >
      {/* Blocked never animates — the mark desaturates and holds. */}
      <MarbimMark state="blocked" size={32} label={null} />
      <div style={{ font: "600 17px/1.25 var(--fx-font-sans)" }}>{title}</div>
      {body ? (
        <div style={{ font: "400 14px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
          {body}
        </div>
      ) : null}
      {onRetry ? (
        <Button variant="secondary" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  )
}

/**
 * The quiet 403. Leaks no data shape: no counts, no column headers, no
 * skeletons — a role without access should not learn the size of what it
 * cannot see.
 *
 * `holders` names who actually has the thing, for the cases where the default
 * "ask an owner or admin" is not merely unhelpful but wrong. Payroll is hr+owner
 * (rule 9), so an ADMIN reading that sentence was being told to ask themselves —
 * the one place in this product where the copy contradicted the rule it enforces
 * (day-one finding D2). Naming the holder leaks nothing the role list does not
 * already publish.
 */
export function LockedState({ what, holders }: { what: string; holders?: string }) {
  const t = useT()

  return (
    <div
      style={{
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        padding: 34,
        display: 'flex',
        alignItems: 'center',
        gap: 16,
        background: 'var(--fx-bg-surface)',
      }}
    >
      <MarbimMark state="blocked" size={32} label={null} />
      <div>
        <div style={{ font: "600 16px/1.3 var(--fx-font-sans)" }}>
          {t('ui.common.no_access', { what })}
        </div>
        <div
          style={{
            font: "400 14px/1.55 var(--fx-font-sans)",
            color: 'var(--fx-text-secondary)',
            marginTop: 4,
          }}
        >
          {holders ?? t('ui.common.ask_owner')}
        </div>
      </div>
    </div>
  )
}

/** Redacted field — the viewer sees the order book, but not the unit price. */
export function Redacted({ label = 'hidden' }: { label?: string }) {
  return (
    <span
      title={`Redacted — ${label}`}
      style={{
        font: "400 13px/1.3 var(--fx-font-mono)",
        color: 'var(--fx-text-tertiary)',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <span aria-hidden="true">🔒</span>
      •••
    </span>
  )
}

export function ProgressRing({ value, size = 62 }: { value: number; size?: number }) {
  const pct = Math.round(Math.min(Math.max(value, 0), 1) * 100)
  const inner = Math.round(size * 0.74)

  return (
    <div
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--fx-radius-full)',
        background: `conic-gradient(var(--fx-accent) 0 ${pct}%, var(--fx-bg-sunken) ${pct}% 100%)`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
      }}
    >
      <div
        style={{
          width: inner,
          height: inner,
          borderRadius: 'var(--fx-radius-full)',
          background: 'var(--fx-bg-surface)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          font: "600 13px/1 var(--fx-font-mono)",
          color: 'var(--fx-text-primary)',
        }}
        data-numeric
      >
        {pct}%
      </div>
    </div>
  )
}

export function Skeleton({ width = '100%', height = 11 }: { width?: string | number; height?: number }) {
  return (
    <div
      aria-hidden="true"
      style={{
        width,
        height,
        borderRadius: 'var(--fx-radius-sm)',
        background: 'var(--fx-bg-sunken)',
        backgroundImage: 'linear-gradient(90deg, transparent, var(--fx-bg-hover), transparent)',
        backgroundSize: '200% 100%',
        animation: 'fx-shimmer 1.6s linear infinite',
      }}
    />
  )
}

/**
 * "You can read this, and you cannot change it."
 *
 * The third of the three access patterns, and the one that had no treatment. Hidden and
 * locked both answer "may I open this"; nothing answered "may I act here". A role that
 * could open a screen found out it could not act by pressing a button and reading a
 * refusal — which is a poor way to learn it, and worse when the button looks live right up
 * to the click.
 *
 * Quiet on purpose. This is a fact about the reader's role, not a problem with the screen:
 * it sits above the content in the shell's own voice rather than as a warning, because
 * there is nothing here to fix and nobody has done anything wrong.
 */
export function ReadOnlyNote({ what }: { what: string }) {
  const t = useT()

  return (
    <div
      role="note"
      style={{
        display: 'flex',
        alignItems: 'baseline',
        gap: 10,
        marginBottom: 18,
        padding: '9px 14px',
        borderRadius: 'var(--fx-radius-sm)',
        border: '1px solid var(--fx-border-subtle)',
        background: 'var(--fx-bg-surface)',
      }}
    >
      <span
        style={{
          font: "500 11px/1.3 var(--fx-font-mono)",
          textTransform: 'uppercase',
          letterSpacing: '.06em',
          color: 'var(--fx-text-tertiary)',
          flexShrink: 0,
        }}
      >
        {t('ui.common.read_only')}
      </span>
      <span
        style={{
          font: "400 13px/1.5 var(--fx-font-sans)",
          color: 'var(--fx-text-secondary)',
        }}
      >
        {t('ui.common.read_only_body', { what })}
      </span>
    </div>
  )
}
