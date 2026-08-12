import type { ReactNode } from 'react'

import { Lockup, ThreadRule } from '@/components/fx/signature'

import { FactoryChip } from './factory-chip'
import { TopBarSearch } from './search/top-bar-search'
import { ThemeToggle } from './theme-toggle'

/**
 * The top bar and the page header.
 *
 * The page header closes with an accent thread rule — 2px strokes at 115°,
 * the counter-thread to the slash rule's 34° warp. It runs once per page,
 * directly under the h1 block, and it COUNTS AS the view's amber moment: a
 * header carrying a thread rule does not also get an amber primary button.
 * That is what `ownsAmber` reports to the screen below it.
 */

export function TopBar({
  account,
  companyName,
  actions,
}: {
  /**
   * The signed-in person, as a rendered element.
   *
   * A slot rather than name/role props: the menu is a client component (it signs out and
   * opens) and this header is not, so the shell passes it down already built rather than
   * becoming a client component itself to hold one button.
   */
  account: ReactNode
  companyName: string
  /**
   * Slot for shell-level controls — the MARBIM launcher lives here. A slot rather than a
   * prop for each one, so the shell chrome does not have to know what a copilot is.
   */
  actions?: ReactNode
}) {
  return (
    <header
      className="fx-topbar"
      style={{
        height: 60,
        flexShrink: 0,
        borderBottom: '1px solid var(--fx-border-subtle)',
        background: 'var(--fx-bg-surface)',
        display: 'grid',
        // The 240px floor holds the search box usable on a desk. Below 900px it is dropped
        // in theme.css — see the tablet block there — because a floor that cannot yield
        // takes its width out of the factory chip and the account menu instead of itself.
        gridTemplateColumns: 'minmax(0, 1fr) minmax(240px, 420px) minmax(0, 1fr)',
        alignItems: 'center',
        gap: 16,
        padding: '0 24px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
        {/* Lockup pins its imgs with alignSelf:flex-start (to avoid stretch in
            column layouts). Wrap so that pin is against this box, not the header,
            and the logo sits on the bar's vertical center with the other chrome. */}
        <span style={{ display: 'inline-flex', alignItems: 'center' }}>
          <Lockup height={26} />
        </span>

        <FactoryChip name={companyName} />
      </div>

      <div style={{ justifySelf: 'center', width: '100%' }}>
        <TopBarSearch />
      </div>

      <div
        style={{
          justifySelf: 'end',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          minWidth: 0,
        }}
      >
        {actions}
        <ThemeToggle />
        {account}
      </div>
    </header>
  )
}

export function PageHeader({
  eyebrow,
  title,
  meta,
  actions,
  /**
   * Pass false when the screen's amber moment belongs elsewhere — an animating
   * mark, or a single primary action further down. The rule permits one, not both.
   */
  ownsAmber = true,
  /**
   * Way back to the parent list. Detail pages need this in the header — a breadcrumb
   * trail alone reads as decoration, and the sidebar does not say "leave this record".
   */
  back,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  meta?: ReactNode
  actions?: ReactNode
  ownsAmber?: boolean
  back?: { href: string; label: string }
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 32 }}>
      {/* Wraps rather than squeezes: a title and its actions on one line at 768px leaves
          the buttons overlapping the heading. The actions drop under it instead. */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          gap: 20,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
          {back ? (
            <a
              href={back.href}
              style={{
                alignSelf: 'flex-start',
                font: '500 13px/1 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
                textDecoration: 'none',
                // A thumb target on phones, a text link on desktop — the density token
                // resolves the difference (plan 4.4's sweep found it at 13px).
                minHeight: 'var(--fx-tap-min)',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              ← {back.label}
            </a>
          ) : null}
          {eyebrow ? (
            <div
              style={{
                font: "400 12px/1 var(--fx-font-mono)",
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {eyebrow}
            </div>
          ) : null}
          <h1
            style={{
              font: "700 34px/1.15 var(--fx-font-sans)",
              letterSpacing: 'var(--fx-tracking-display)',
              margin: 0,
              color: 'var(--fx-text-primary)',
            }}
          >
            {title}
          </h1>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          {meta ? (
            <span style={{ font: "400 13px/1.5 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}>
              {meta}
            </span>
          ) : null}
          {actions}
        </div>
      </div>
      <ThreadRule variant={ownsAmber ? 'accent' : 'muted'} />
    </div>
  )
}

/** The 1280px content column every desk screen sits in. */
export function PageBody({ children }: { children: ReactNode }) {
  return (
    <main
      // Marks the page slot for the MARBIM panel's host desaturation — while the panel is
      // open the screen behind it is context, not content. The rule lives in theme.css
      // because the panel is a sibling of this element, not an ancestor.
      data-fx-host
      className="fx-page-body"
      style={{
        flex: 1,
        // Without this the main cannot shrink below its widest child, so one over-wide
        // table pushed the whole flex row — sidebar included — off the side of a tablet.
        // A flex item defaults to `min-width: auto`, which is the trap.
        minWidth: 0,
        overflowY: 'auto',
        background: 'var(--fx-bg-canvas)',
        padding: '32px 48px 96px',
      }}
    >
      <div style={{ maxWidth: 'var(--fx-content-max)', margin: '0 auto' }}>{children}</div>
    </main>
  )
}
