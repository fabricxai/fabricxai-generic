'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

/**
 * The bottom tab bar that makes a floor screen feel like an app (mobile contract §3,
 * plan 4.2 — first user: the Hour app).
 *
 * Phones only: CSS hides it above the phone breakpoint (`.fx-floor-tabs` in theme.css),
 * so the desktop layout is byte-identical — the contract's non-regression rule. On a
 * phone it sits fixed at the bottom, thumb-height, and carries the two or three places
 * this role's day actually moves between. It deliberately duplicates rail entries rather
 * than replacing them: the rail is the map, the tabs are the pocket.
 */
export interface FloorTab {
  href: string
  label: string
}

export function FloorTabs({ tabs }: { tabs: readonly FloorTab[] }) {
  const pathname = usePathname()

  return (
    <nav className="fx-floor-tabs" aria-label="Floor">
      {tabs.map((tab) => {
        const on = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={on ? 'page' : undefined}
            style={{
              flex: 1,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              minHeight: 52,
              font: `${on ? 600 : 500} 13px/1 var(--fx-font-sans)`,
              color: on ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
              textDecoration: 'none',
              borderTop: `2px solid ${on ? 'var(--fx-accent)' : 'transparent'}`,
            }}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
