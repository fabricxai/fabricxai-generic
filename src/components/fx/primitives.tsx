'use client'

import type { ButtonHTMLAttributes, CSSProperties, ReactNode } from 'react'

/**
 * Actions, chips and small display primitives.
 *
 * The amber rule governs this file. `primary` is the only amber-filled variant,
 * and a view gets at most one of it — unless the MARBIM mark is animating in
 * that view, in which case the mark owns the amber and the primary action falls
 * back to ink. That fallback is what `deferAmber` expresses.
 */

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'link'
export type ButtonSize = 'sm' | 'md' | 'lg'

const PADDING: Record<ButtonSize, string> = {
  sm: '8px 14px',
  md: '10px 18px',
  lg: '13px 22px',
}

const FONT_SIZE: Record<ButtonSize, number> = { sm: 13, md: 14, lg: 15 }

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /**
   * The mark is animating in this view, so it owns the amber moment and this
   * button renders as ink instead. Never two amber fills in one viewport.
   */
  deferAmber?: boolean
  full?: boolean
}

export function Button({
  variant = 'secondary',
  size = 'md',
  deferAmber = false,
  full = false,
  disabled,
  style,
  children,
  ...rest
}: ButtonProps) {
  const base: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    borderRadius: 'var(--fx-radius-md)',
    padding: PADDING[size],
    font: `600 ${FONT_SIZE[size]}px/1 var(--fx-font-sans)`,
    cursor: disabled ? 'not-allowed' : 'pointer',
    transition: 'background var(--fx-dur-state), border-color var(--fx-dur-state), color var(--fx-dur-state)',
    width: full ? '100%' : undefined,
    /*
     * EVERY size, not only lg (role audit 1.8). Restricting the floor to `lg` assumed
     * screens would choose the right size, and the audit measured what they actually chose:
     * six sub-38px Inspect buttons on the final-inspection queue, three on the ticket
     * board — ghost `md` rows on screens inspectors and mechanics use one-handed. The
     * token already answers density (36px desk, 48px floor), so the fix is letting it
     * apply. Desktop rows grow ≤4px; touch rows grow to a target a thumb can hit.
     */
    minHeight: 'var(--fx-tap-min)',
  }

  const effective = variant === 'primary' && deferAmber ? 'ink' : variant

  const skin: Record<string, CSSProperties> = {
    // The one amber fill. Text on amber is always ink, never white.
    primary: {
      background: 'var(--fx-accent)',
      color: 'var(--fx-accent-on)',
      border: 'none',
    },
    ink: {
      background: 'var(--fx-text-primary)',
      color: 'var(--fx-text-inverse)',
      border: 'none',
    },
    secondary: {
      background: 'transparent',
      color: 'var(--fx-text-primary)',
      border: '1px solid var(--fx-border-default)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--fx-text-primary)',
      border: '1px solid transparent',
      padding: size === 'md' ? '10px 14px' : PADDING[size],
    },
    // Danger is the one place white-on-fill is correct: it is not amber.
    danger: {
      background: 'var(--fx-danger)',
      color: '#FFFFFF',
      border: 'none',
    },
    link: {
      background: 'transparent',
      color: 'var(--fx-text-primary)',
      border: 'none',
      padding: 0,
      textDecoration: 'underline',
      textUnderlineOffset: 3,
    },
  }

  const off: CSSProperties = disabled
    ? {
        background: 'transparent',
        color: 'var(--fx-text-disabled)',
        border: '1px solid var(--fx-border-subtle)',
      }
    : {}

  return (
    <button
      disabled={disabled}
      style={{ ...base, ...skin[effective], ...off, ...style }}
      {...rest}
    >
      {children}
    </button>
  )
}

export function IconButton({
  label,
  children,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) {
  return (
    <button
      aria-label={label}
      title={label}
      style={{
        width: 38,
        height: 38,
        minWidth: 'var(--fx-tap-min)',
        minHeight: 'var(--fx-tap-min)',
        background: 'transparent',
        border: '1px solid var(--fx-border-default)',
        borderRadius: 'var(--fx-radius-md)',
        cursor: 'pointer',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--fx-text-secondary)',
        ...style,
      }}
      {...rest}
    >
      {children}
    </button>
  )
}

/** Active segment uses bg-selected — amber at 12%, never a fill. */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      style={{
        display: 'inline-flex',
        border: '1px solid var(--fx-border-default)',
        borderRadius: 'var(--fx-radius-md)',
        overflow: 'hidden',
        background: 'var(--fx-bg-surface)',
      }}
    >
      {options.map((o) => {
        const active = o.value === value
        return (
          <button
            key={o.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            style={{
              background: active ? 'var(--fx-bg-selected)' : 'transparent',
              color: active ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
              border: 'none',
              padding: '10px 16px',
              minHeight: 'var(--fx-tap-min)',
              cursor: 'pointer',
              font: "600 13px/1 var(--fx-font-sans)",
            }}
          >
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'accent'

/**
 * Mono-caps status badge. `accent` is reserved for the one thing amber means:
 * a person must act — a pending approval, a MARBIM draft. Never a plain status.
 */
export function Badge({
  tone = 'neutral',
  cut = false,
  children,
}: {
  tone?: BadgeTone
  /** The cut corner, bottom-left on chips. One per group. */
  cut?: boolean
  children: ReactNode
}) {
  const tones: Record<BadgeTone, { fg: string; bg: string }> = {
    neutral: { fg: 'var(--fx-text-tertiary)', bg: 'transparent' },
    success: { fg: 'var(--fx-success)', bg: 'transparent' },
    warning: { fg: 'var(--fx-warning)', bg: 'transparent' },
    danger: { fg: 'var(--fx-danger)', bg: 'transparent' },
    info: { fg: 'var(--fx-info)', bg: 'transparent' },
    accent: { fg: 'var(--fx-accent-pressed)', bg: 'var(--fx-accent-subtle)' },
  }
  const t = tones[tone]

  return (
    <span
      className={cut ? 'fx-cut-chip' : undefined}
      style={{
        display: 'inline-block',
        font: "500 11px/1 var(--fx-font-mono)",
        letterSpacing: '.05em',
        textTransform: 'uppercase',
        color: t.fg,
        background: t.bg,
        border: `1px solid ${t.bg === 'transparent' ? 'var(--fx-border-subtle)' : 'transparent'}`,
        borderRadius: cut ? 0 : 'var(--fx-radius-sm)',
        padding: '5px 8px',
      }}
    >
      {children}
    </span>
  )
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
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
      {children}
    </kbd>
  )
}

export function Avatar({ initials, size = 26 }: { initials: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: 'var(--fx-radius-full)',
        background: 'var(--fx-bg-sunken)',
        border: '2px solid var(--fx-bg-surface)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: `600 ${Math.round(size * 0.38)}px/1 var(--fx-font-sans)`,
        color: 'var(--fx-text-secondary)',
        flexShrink: 0,
      }}
    >
      {initials}
    </span>
  )
}

export function AvatarGroup({ people, extra }: { people: string[]; extra?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ display: 'inline-flex' }}>
        {people.map((p, i) => (
          <span key={p} style={{ marginLeft: i === 0 ? 0 : -8 }}>
            <Avatar initials={p} />
          </span>
        ))}
      </span>
      {extra ? (
        <span style={{ font: "400 13px/1 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
          +{extra} more
        </span>
      ) : null}
    </span>
  )
}
