import { headers } from 'next/headers'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { randomUUID } from 'node:crypto'

import { marbimEntryFor } from '@/components/shell/marbim-context'
import { InlineAlert, LockedState } from '@/components/fx/feedback'
import { PageHeader } from '@/components/shell/page-shell'
import { env } from '@/lib/env'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'

import { MarbimSurface } from './surface-client'

/**
 * X.2 MARBIM — the assistant surface.
 *
 * Suggested prompts are chosen server-side from the caller's roles. A read-only
 * role gets read-only starting points and no draft tools at all: absent, not
 * disabled, so nobody learns what they are missing by finding it greyed out.
 */
export const dynamic = 'force-dynamic'

export default async function MarbimPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  /*
   * The copilot's off-switch, honoured (plan 6.1).
   *
   * `MARBIM_ENABLED` had zero runtime consumers, so with it off this screen opened and
   * every question hard-failed against a provider that was never registered. A factory
   * should be told the copilot is not available rather than shown one that does not work.
   */
  if (!env.MARBIM_ENABLED) return <LockedState what="MARBIM" />

  // Shared with the shell's slide-over, so the two surfaces cannot disagree about what a
  // given role may ask for. See `components/shell/marbim-context`.
  const entry = marbimEntryFor(ctx.roles)
  const locale = await requestLocale()

  /*
   * A member has no desk yet, and this page is their entire world — MARBIM and Settings are
   * all their sidebar offers. Without this banner the landing looked broken rather than
   * pending ("my account doesn't work" is the message every new signup sent), because
   * nothing anywhere said the state they were in was WAITING, or on whom (role audit 1.7).
   */
  const awaitingDesk = !ctx.roles.some((role) => role !== 'member')

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        // Definite height (not only minHeight) so the flex:1 surface can grow and
        // dock the composer. Top bar 60 + PageBody top pad 32; leave a thin gap
        // above the main's bottom pad so the input sits near the viewport floor.
        height: 'calc(100dvh - 60px - 32px - 16px)',
        marginBottom: -80,
      }}
    >
      <PageHeader
        eyebrow="MARBIM"
        title="Ask about this factory"
        meta={entry.readOnly ? 'read-only role' : undefined}
        // The send button owns the amber on this screen.
        ownsAmber={false}
      />

      {awaitingDesk ? (
        <InlineAlert tone="info">{tui(locale, 'ui.marbim.awaiting_desk')}</InlineAlert>
      ) : null}

      {/*
        * The door intake never had. The whole extraction pipeline — kinds, queue,
        * per-field confidence, the approve-inbox landing — was reachable only by typing
        * /marbim/intake into the address bar: no nav entry, no link, nothing. A tester
        * followed the instruction "use intake", found only this chat, and typed their
        * tech pack INTO the conversation — where the model, seeing words about intake,
        * politely narrated an extraction that was never queued.
        */}
      <div style={{ margin: '0 0 12px' }}>
        <Link
          href="/marbim/intake"
          style={{ font: "500 13.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-accent)' }}
        >
          Have a document to read? Intake — pick its kind, paste its text →
        </Link>
      </div>

      <MarbimSurface
        conversationId={randomUUID()}
        suggestions={entry.suggestions}
        packLabel={entry.packLabel}
        readOnly={entry.readOnly}
      />
    </div>
  )
}
