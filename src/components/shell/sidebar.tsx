'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

import { useT } from '@/components/fx/locale'
import { Badge } from '@/components/fx/primitives'

import { navLabelKey, navSectionKey, NAV_SECTIONS, type NavItem, type NavSection } from './nav'
import { NavIcon } from './nav-icons'

/**
 * The sidebar. The active item is marked by a 2px amber slash at the wordmark's
 * 34° plus a bg-selected wash — an active indicator, which the amber rule
 * sanctions, and under 24px so it does not consume the view's amber moment.
 *
 * `badges` carries counts the shell already computed (Approve routed pending).
 * Zero / missing means no chip — a badge that cannot be cleared teaches people
 * to stop reading badges.
 */
export function Sidebar({
  items,
  badges = {},
}: {
  items: readonly NavItem[]
  badges?: Readonly<Record<string, number>>
}) {
  const pathname = usePathname()
  const t = useT()

  const bySection = NAV_SECTIONS.map((section) => ({
    ...section,
    items: items.filter((i) => i.section === section.id),
  })).filter((s) => s.items.length > 0)

  return (
    <nav
      aria-label={t('ui.nav.modules_aria')}
      className="fx-sidebar"
      style={{
        width: 232,
        flexShrink: 0,
        borderRight: '1px solid var(--fx-border-subtle)',
        background: 'var(--fx-bg-surface)',
        padding: '20px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 22,
        overflowY: 'auto',
      }}
    >
      {bySection.map((section) => (
        <div key={section.id} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <div
            className="fx-sidebar-section"
            style={{
              font: "500 11px/1 var(--fx-font-mono)",
              letterSpacing: '.09em',
              textTransform: 'uppercase',
              color: 'var(--fx-text-tertiary)',
              padding: '0 12px 8px',
            }}
          >
            {t(navSectionKey(section.id))}
          </div>
          {section.items.map((item) => (
            <SidebarLink
              key={item.id}
              item={item}
              label={t(navLabelKey(item.id))}
              active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
              badge={badges[item.id] ?? 0}
            />
          ))}
        </div>
      ))}
    </nav>
  )
}

function SidebarLink({
  item,
  label,
  active,
  badge,
}: {
  item: NavItem
  label: string
  active: boolean
  badge: number
}) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className="fx-sidebar-link"
      /*
       * The accessible name is on the LINK, not only in the text (plan 4.4).
       *
       * Under 900px the label is hidden and the glyph is all that renders. Without this a
       * collapsed sidebar reads to a screen reader as a column of unlabelled links — which
       * is not a smaller sidebar, it is no sidebar at all. `title` gives the same word to a
       * long-press on the tablet this collapse exists for.
       */
      aria-label={badge > 0 ? `${label}, ${badge} waiting` : label}
      title={label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '10px 12px',
        minHeight: 'var(--fx-tap-min)',
        borderRadius: 'var(--fx-radius-md)',
        font: "500 14px/1.2 var(--fx-font-sans)",
        textDecoration: 'none',
        background: active ? 'var(--fx-bg-selected)' : 'transparent',
        color: active ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 2,
          height: 15,
          flexShrink: 0,
          transform: 'skewX(var(--fx-slash-angle))',
          background: active ? 'var(--fx-accent)' : 'transparent',
        }}
      />
      <NavIcon id={item.id} />
      <span className="fx-sidebar-label" style={{ flex: 1, minWidth: 0 }}>
        {label}
      </span>
      {badge > 0 ? (
        <span className="fx-sidebar-label">
          <Badge tone="accent">{badge > 99 ? '99+' : badge}</Badge>
        </span>
      ) : null}
    </Link>
  )
}

/** Section id → label, used by the top bar breadcrumb. English; see `navSectionKey`. */
export function sectionLabel(id: NavSection): string {
  return NAV_SECTIONS.find((s) => s.id === id)?.label ?? ''
}
