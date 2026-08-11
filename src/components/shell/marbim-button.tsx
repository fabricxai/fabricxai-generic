'use client'

import { MarbimMark } from '@/components/fx/mark'

import { requestMarbimOpen } from './marbim-open'

/**
 * "Ask MARBIM" in the top bar.
 *
 * The FAB (X.2 canvas, P3) is the designed entry point and stays. This one is here as well
 * because the FAB is a mark with no words: it is the right affordance for somebody who
 * already knows what MARBIM is, and no affordance at all for somebody on their first day.
 * The two cost one line of chrome between them.
 */
export function MarbimButton() {
  return (
    <button
      onClick={() => requestMarbimOpen()}
      aria-haspopup="dialog"
      title="Ask MARBIM (⌘K)"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        height: 32,
        padding: '0 12px',
        borderRadius: 'var(--fx-radius-md)',
        border: '1px solid var(--fx-border-default)',
        background: 'var(--fx-bg-surface)',
        color: 'var(--fx-text-secondary)',
        font: "500 12.5px/1 var(--fx-font-sans)",
        cursor: 'pointer',
      }}
    >
      <MarbimMark state="rest" size={20} label={null} />
      Ask MARBIM
    </button>
  )
}
