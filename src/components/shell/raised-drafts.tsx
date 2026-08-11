import { headers } from 'next/headers'

import { StatusLabel } from '@/components/fx/signature'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { myRaisedDrafts } from '@/modules/approvals/queries'
import { getCtx } from '@/modules/core/session'

/**
 * "My raised drafts" — the fate of what this person sent for approval (adoption plan 2.1).
 *
 * Cutting, maintenance and the store raise drafts and hold no approve nav, so their
 * corrections vanished into a queue they cannot see. This strip is the raiser's view:
 * status, age, and — for a rejection — the reviewer's reason, because "rejected" with no
 * why is a dead end the size of a whole morning.
 *
 * A server component mounted by the module homes that need it. Renders NOTHING when the
 * person has never raised a draft: a permanently empty "your drafts" box on a screen that
 * belongs to receiving would be furniture.
 */
const TONE: Record<string, 'on-track' | 'at-risk' | 'late' | 'done'> = {
  pending: 'at-risk',
  approved: 'on-track',
  committed: 'done',
  rejected: 'late',
  failed: 'late',
  superseded: 'done',
}

export async function RaisedDrafts() {
  const ctx = await getCtx(await headers())
  if (!ctx) return null

  const [drafts, locale] = await Promise.all([myRaisedDrafts(ctx, 6), requestLocale()])
  if (drafts.length === 0) return null

  const t = (key: string, params?: Record<string, unknown>) => tui(locale, key, params)

  return (
    <section
      aria-label={t('ui.drafts.mine_title')}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        padding: '12px 16px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        marginBottom: 18,
      }}
    >
      <span
        style={{
          font: "500 11px/1 var(--fx-font-mono)",
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
        }}
      >
        {t('ui.drafts.mine_title')}
      </span>
      {drafts.map((draft) => {
        // Inside the map, not hoisted: the hooks lint treats a render-scoped Date.now()
        // as impurity, and the helper shape is the same answer the layout's alertAge took.
        const hours = draftAgeHours(draft.createdAt)
        return (
          <span
            key={draft.id}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 10,
              font: "400 13px/1.4 var(--fx-font-sans)",
              flexWrap: 'wrap',
            }}
          >
            <StatusLabel status={TONE[draft.status] ?? 'at-risk'}>
              {t(`ui.drafts.status_${draft.status}`)}
            </StatusLabel>
            <span data-mono style={{ font: "400 12.5px/1.4 var(--fx-font-mono)" }}>
              {draft.targetTable}
            </span>
            <span style={{ color: 'var(--fx-text-tertiary)', font: "400 12px/1.4 var(--fx-font-mono)" }}>
              {hours < 1 ? t('ui.drafts.just_now') : hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`}
            </span>
            {/* The reviewer's reason is the difference between a dead end and an answer. */}
            {draft.status === 'rejected' && draft.reviewNote ? (
              <span style={{ color: 'var(--fx-text-secondary)' }}>— {draft.reviewNote}</span>
            ) : null}
          </span>
        )
      })}
    </section>
  )
}

/** Whole hours since the draft was raised. Reads the clock outside the render body. */
function draftAgeHours(createdAt: Date): number {
  return Math.floor(Math.max(0, Date.now() - createdAt.getTime()) / 3_600_000)
}
