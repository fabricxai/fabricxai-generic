'use client'

import { MarbimMark } from '@/components/fx/mark'
import { Kbd } from '@/components/fx/primitives'

import { useT } from '@/components/fx/locale'
import { requestMarbimOpen } from '@/components/shell/marbim-open'

/**
 * The desk's own way in to MARBIM (design canvas, "Your week").
 *
 * The top bar has carried an Ask MARBIM button since the shell shipped, and a person
 * looking at a book of six orders still had to invent the question themselves. These are
 * openings, not answers: each one seeds the composer and stops, exactly as
 * `AskAboutRow` does, because a button that fired a canned question would be a chat
 * costume on a report — and the half-typed prompt is what teaches somebody the grammar
 * of asking a second, better question.
 *
 * The prompts are about the ORDER BOOK, not about the app. "What slips if fabric lands
 * three days late" is a merchandiser's morning; "how do I use this screen" is a manual.
 */
const PROMPTS = ['ui.orders.ask_slip', 'ui.orders.ask_update', 'ui.orders.ask_waiting'] as const

export function AskStrip() {
  const t = useT()

  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        flexWrap: 'wrap',
        alignItems: 'center',
        padding: '12px 16px',
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          font: '500 13px/1.3 var(--fx-font-sans)',
          color: 'var(--fx-text-secondary)',
        }}
      >
        <MarbimMark size={20} />
        {t('ui.orders.ask_marbim')}
      </span>

      {PROMPTS.map((key) => (
        <button
          key={key}
          type="button"
          onClick={() => requestMarbimOpen(`${t(key)} `)}
          style={{
            font: '400 13px/1.3 var(--fx-font-sans)',
            color: 'var(--fx-text-primary)',
            padding: '7px 12px',
            minHeight: 34,
            background: 'var(--fx-bg-sunken)',
            border: '1px solid var(--fx-border-subtle)',
            borderRadius: 'var(--fx-radius-sm)',
            cursor: 'pointer',
          }}
        >
          {t(key)}
        </button>
      ))}

      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
        <Kbd>⌘K</Kbd>
      </span>
    </div>
  )
}
