'use client'

import type {
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { useId, useRef, useState } from 'react'

import { fromDateInputText, maskDateInput, toDateInputText } from '@/lib/dates'

import { useT } from './locale'

/**
 * Form primitives. Inputs use radius sm (4) and never carry a cut corner.
 * Every field renders label, hint and error from one wrapper so the error
 * state is impossible to forget.
 */

const CONTROL = {
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  padding: '11px 13px',
  font: "400 14px/1.2 var(--fx-font-sans)",
  width: '100%',
  minHeight: 'var(--fx-tap-min)',
} as const

export function Field({
  label,
  hint,
  error,
  required,
  children,
  htmlFor,
}: {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  required?: boolean
  children: ReactNode
  htmlFor?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 7 }}>
      <label
        htmlFor={htmlFor}
        style={{ font: "500 13px/1 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}
      >
        {label}
        {required ? <span style={{ color: 'var(--fx-danger)' }}> *</span> : null}
      </label>
      {children}
      {/* State is never colour-only: the error replaces the hint and is announced. */}
      {error ? (
        <div
          role="alert"
          style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-danger)' }}
        >
          {error}
        </div>
      ) : hint ? (
        <div style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export function TextInput({
  label,
  hint,
  error,
  mono,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
  /** Identifiers, LC numbers and quantities are always mono. */
  mono?: boolean
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} htmlFor={id}>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        style={{
          ...CONTROL,
          borderColor: error ? 'var(--fx-danger)' : 'var(--fx-border-default)',
          fontFamily: mono ? 'var(--fx-font-mono)' : undefined,
        }}
        {...rest}
      />
    </Field>
  )
}

export function TextArea({
  label,
  hint,
  error,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} htmlFor={id}>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        rows={rest.rows ?? 4}
        style={{
          ...CONTROL,
          lineHeight: 1.55,
          resize: 'vertical',
          borderColor: error ? 'var(--fx-danger)' : 'var(--fx-border-default)',
        }}
        {...rest}
      />
    </Field>
  )
}

export function Select({
  label,
  hint,
  error,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & {
  label: ReactNode
  hint?: ReactNode
  error?: ReactNode
}) {
  const id = useId()
  return (
    <Field label={label} hint={hint} error={error} required={rest.required} htmlFor={id}>
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        style={{ ...CONTROL, borderColor: error ? 'var(--fx-danger)' : 'var(--fx-border-default)' }}
        {...rest}
      >
        {children}
      </select>
    </Field>
  )
}

export function SearchField(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      type="search"
      style={{ ...CONTROL, background: 'var(--fx-bg-sunken)', border: '1px solid transparent' }}
      {...props}
    />
  )
}

/** Checked state uses an amber fill, but it is under 24px so it does not
    consume the view's amber moment. */
export function Checkbox({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: ReactNode
  disabled?: boolean
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        cursor: disabled ? 'not-allowed' : 'pointer',
        font: "400 14px/1 var(--fx-font-sans)",
        color: disabled ? 'var(--fx-text-disabled)' : 'var(--fx-text-primary)',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        style={{
          width: 17,
          height: 17,
          margin: 0,
          accentColor: 'var(--fx-accent)',
          cursor: 'inherit',
        }}
      />
      {label}
    </label>
  )
}

export function Radio({
  name,
  value,
  checked,
  onChange,
  label,
}: {
  name: string
  value: string
  checked: boolean
  onChange: (v: string) => void
  label: ReactNode
}) {
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 9,
        cursor: 'pointer',
        font: "400 14px/1 var(--fx-font-sans)",
        color: 'var(--fx-text-primary)',
      }}
    >
      <input
        type="radio"
        name={name}
        value={value}
        checked={checked}
        onChange={() => onChange(value)}
        style={{ width: 17, height: 17, margin: 0, accentColor: 'var(--fx-accent)' }}
      />
      {label}
    </label>
  )
}

export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      style={{
        width: 40,
        height: 23,
        borderRadius: 'var(--fx-radius-full)',
        padding: 3,
        border: 'none',
        cursor: 'pointer',
        display: 'flex',
        justifyContent: checked ? 'flex-end' : 'flex-start',
        background: checked ? 'var(--fx-accent)' : 'var(--fx-border-default)',
        transition: 'background var(--fx-dur-state)',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: 17,
          height: 17,
          borderRadius: 'var(--fx-radius-full)',
          background: '#FFFFFF',
          boxShadow: '0 1px 2px rgb(24 29 41 / .3)',
        }}
      />
    </button>
  )
}

export function Slider({
  label,
  value,
  onChange,
  min = 0,
  max = 100,
  step = 1,
  format,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  format?: (v: number) => string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          font: "400 12px/1 var(--fx-font-mono)",
          color: 'var(--fx-text-tertiary)',
        }}
      >
        <span>{label}</span>
        <span data-numeric>{format ? format(value) : value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        // A range input's `value` is a slider position. A money field uses the
        // decimal-string path, never this control.
        // eslint-disable-next-line fabricxai/no-float-money
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--fx-accent)' }}
      />
    </div>
  )
}

/**
 * A date, typed the way Bangladesh writes one.
 *
 * ## Why this is not `<input type="date">`
 *
 * A native date field renders in the BROWSER's locale, and no page can override that. On a
 * laptop configured for en-US it asks for mm/dd/yyyy while the person in front of it types
 * dd/mm — and for every day of the month up to the twelfth, both readings are valid dates,
 * so nothing complains and the wrong one is stored.
 *
 * That is not hypothetical: an LC expiry of 5 December was entered `05/12/2026`, stored as
 * 12 May, and only came to light because it landed before the credit's latest-shipment date
 * and hit a CHECK constraint (live test, Phase 3). Nothing guards an ex-factory date, a CAP
 * deadline or a wage period the same way — those would just have been wrong.
 *
 * So the field is a text input that states its order in its own placeholder, and the ISO
 * string never leaves this component. `value` and `onChange` speak `YYYY-MM-DD`, which is
 * what every zod, column and API below already expects; the browser's opinion about date
 * formatting is not consulted anywhere.
 *
 * The calendar is still there — a hidden native field supplies the picker for anyone who
 * would rather point than type, which on a tablet on the floor is most people. It is an
 * alternative route to the same state, never the source of truth for what is displayed.
 */
export function DateInput({
  value,
  onChange,
  invalid,
  style,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type'> & {
  /** `YYYY-MM-DD`, or `''`. The same contract the old `type="date"` had. */
  value: string
  /** `YYYY-MM-DD` once the date is real and complete; `''` while it is neither. */
  onChange: (iso: string) => void
  /** Paint the border as refused — for a field the SERVER rejected, not this parser. */
  invalid?: boolean
}) {
  const t = useT()
  const picker = useRef<HTMLInputElement>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [touched, setTouched] = useState(false)

  /*
   * What the box shows is DERIVED, not synchronised.
   *
   * The keystrokes in `draft` are only worth keeping while they still describe the ISO string
   * the parent is holding — which covers the two cases that matter and separates them without
   * an effect. Deleting a digit from a complete date emits `''`, and the half-finished text
   * must stay on screen: it parses to nothing, the parent holds nothing, they agree, the draft
   * wins. A prefill or a form reset changes `value` to something the draft does not describe:
   * they disagree, the prop wins and the stale keystrokes are simply ignored.
   *
   * Written as a state sync in an effect first, which is how the field could blank itself
   * mid-edit and why React's lint rule objects to the shape at all.
   */
  const text =
    draft !== null && fromDateInputText(draft) === (value || null)
      ? draft
      : toDateInputText(value)

  const malformed = touched && text.length > 0 && fromDateInputText(text) === null

  function handleTyping(next: string) {
    const masked = maskDateInput(next)
    setDraft(masked)
    // Emitting '' for an incomplete date keeps the parent's state honest: a half-typed
    // date is not a date, and a form that submits on Enter must not find yesterday's.
    onChange(fromDateInputText(masked) ?? '')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
        <input
          {...rest}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          maxLength={10}
          placeholder={t('ui.common.date_placeholder')}
          value={text}
          onChange={(e) => handleTyping(e.target.value)}
          onBlur={(e) => {
            setTouched(true)
            rest.onBlur?.(e)
          }}
          aria-invalid={malformed || invalid ? true : undefined}
          style={{
            ...CONTROL,
            fontFamily: 'var(--fx-font-mono)',
            paddingRight: 38,
            borderColor:
              malformed || invalid ? 'var(--fx-danger)' : 'var(--fx-border-default)',
            ...style,
          }}
        />

        {/*
         * The picker. The native field is what actually opens the calendar — `showPicker()`
         * is only valid on an element the browser is rendering, so it sits here at one pixel
         * with no pointer events rather than behind `display: none`. Its value is the ISO
         * string directly, which is the one case where the browser's format is unambiguous.
         */}
        <input
          ref={picker}
          type="date"
          tabIndex={-1}
          aria-hidden
          value={value}
          onChange={(e) => onChange(e.target.value)}
          style={{
            position: 'absolute',
            right: 30,
            bottom: 4,
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
            border: 0,
            padding: 0,
          }}
        />
        <button
          type="button"
          disabled={rest.disabled}
          aria-label={t('ui.common.date_pick')}
          onClick={() => {
            // Older browsers have no showPicker; typing still works, which is the point.
            try {
              picker.current?.showPicker()
            } catch {
              /* the field is the primary route; the calendar is the convenience */
            }
          }}
          style={{
            position: 'absolute',
            right: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 26,
            height: 26,
            padding: 0,
            border: 0,
            borderRadius: 'var(--fx-radius-sm)',
            background: 'transparent',
            color: 'var(--fx-text-tertiary)',
            cursor: rest.disabled ? 'default' : 'pointer',
          }}
        >
          <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden focusable="false">
            <rect x="1.5" y="2.5" width="13" height="12" rx="1.5" stroke="currentColor" />
            <path d="M1.5 6.5h13M5 1.5v2M11 1.5v2" stroke="currentColor" strokeLinecap="round" />
          </svg>
        </button>
      </div>

      {malformed ? (
        <div
          role="alert"
          style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-danger)' }}
        >
          {t('ui.common.date_invalid')}
        </div>
      ) : null}
    </div>
  )
}
