'use client'

import { useT } from '@/components/fx/locale'
import { MarbimMark } from '@/components/fx/mark'

import { requestMarbimOpen } from './marbim-open'

/**
 * "Ask about this row" (adoption plan 1.3).
 *
 * One tap on a desk row opens the panel with the row's own code seeded in the composer —
 * "Ask about PO-BF-2044: ". The person finishes the question; a canned question would be a
 * button wearing a chat costume, and the half-typed prompt is what teaches the grammar of
 * asking. The CODE travels, not the uuid, because the ref-resolvers accept exactly what is
 * printed on the row — the same identifier the person would say out loud.
 *
 * Rendered inside rows that are themselves links, so the click must not navigate: this is
 * the one affordance on the row that opens a panel instead of a page.
 */
export function AskAboutRow({ code, label }: { code: string; label?: string }) {
  const t = useT()

  return (
    <button
      type="button"
      aria-label={t('ui.marbim.ask_about_row', { code })}
      title={t('ui.marbim.ask_about_row', { code })}
      onClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        requestMarbimOpen(`${label ?? code}: `)
      }}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        padding: 0,
        border: '1px solid transparent',
        borderRadius: 'var(--fx-radius-sm)',
        background: 'transparent',
        color: 'var(--fx-text-tertiary)',
        cursor: 'pointer',
        flexShrink: 0,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.borderColor = 'var(--fx-border-default)'
        e.currentTarget.style.color = 'var(--fx-text-secondary)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.borderColor = 'transparent'
        e.currentTarget.style.color = 'var(--fx-text-tertiary)'
      }}
    >
      <MarbimMark size={20} />
    </button>
  )
}
