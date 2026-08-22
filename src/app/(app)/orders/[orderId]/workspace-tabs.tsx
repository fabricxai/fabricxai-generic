import Link from 'next/link'

/**
 * The order workspace's tab strip (specs/order-centric-core.md §2).
 *
 * Links with a `?tab=` param rather than client state, deliberately: each tab reads a
 * different module's data, and a server-rendered tab fetches only its own — a client
 * switch would mean loading every tab's queries on every visit, including tabs the
 * caller's roles cannot see. It also makes a tab linkable, which is what somebody
 * pasting "look at the shipping on this order" into a chat actually needs.
 *
 * Which tabs exist is decided by the page: module activation ∩ role permission (spec).
 * This renders what it is given.
 */
export interface WorkspaceTab {
  id: string
  label: string
  /** Rendered beside the label — a count, a blocker marker. */
  hint?: string
}

export function WorkspaceTabs({
  tabs,
  active,
  basePath,
}: {
  tabs: readonly WorkspaceTab[]
  active: string
  basePath: string
}) {
  return (
    <div
      role="tablist"
      aria-label="Order workspace"
      style={{
        display: 'flex',
        gap: 26,
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--fx-border-subtle)',
      }}
    >
      {tabs.map((tab) => {
        const on = tab.id === active
        return (
          <Link
            key={tab.id}
            href={`${basePath}?tab=${tab.id}`}
            role="tab"
            aria-selected={on}
            style={{
              padding: '0 0 13px',
              textDecoration: 'none',
              font: `600 14px/1 var(--fx-font-sans)`,
              color: on ? 'var(--fx-text-primary)' : 'var(--fx-text-tertiary)',
              borderBottom: `2px solid ${on ? 'var(--fx-accent)' : 'transparent'}`,
              marginBottom: -1,
              display: 'inline-flex',
              alignItems: 'baseline',
              gap: 6,
            }}
          >
            {tab.label}
            {tab.hint ? (
              <span style={{ font: '500 11.5px/1 var(--fx-font-mono)', color: 'var(--fx-text-tertiary)' }}>
                {tab.hint}
              </span>
            ) : null}
          </Link>
        )
      })}
    </div>
  )
}
