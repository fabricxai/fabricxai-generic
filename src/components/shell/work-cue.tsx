import Link from 'next/link'

/**
 * In-module next-step strip — 1–3 cues pointing into the desk you're already on.
 *
 * Server-friendly: pure props, no data fetching. Pages compose counts from the
 * queries they already run and hand the bullets here.
 */
export interface WorkCueItem {
  label: string
  href: string
}

export function WorkCue({ items }: { items: readonly WorkCueItem[] }) {
  if (items.length === 0) {
    return (
      <div
        role="status"
        style={{
          marginBottom: 20,
          padding: '12px 16px',
          borderRadius: 'var(--fx-radius-md)',
          border: '1px solid var(--fx-border-subtle)',
          background: 'var(--fx-bg-surface)',
          font: '400 13.5px/1.45 var(--fx-font-sans)',
          color: 'var(--fx-text-secondary)',
        }}
      >
        Nothing waiting in this desk.
      </div>
    )
  }

  return (
    <div
      role="region"
      aria-label="Waiting on this desk"
      style={{
        marginBottom: 20,
        padding: '12px 16px',
        borderRadius: 'var(--fx-radius-md)',
        border: '1px solid var(--fx-border-subtle)',
        background: 'var(--fx-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <div
        style={{
          font: '500 11px/1 var(--fx-font-mono)',
          letterSpacing: '.08em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
        }}
      >
        Waiting here
      </div>
      <ul
        style={{
          margin: 0,
          padding: 0,
          listStyle: 'none',
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
        }}
      >
        {items.slice(0, 3).map((item) => (
          <li key={`${item.href}-${item.label}`}>
            <Link
              href={item.href}
              style={{
                font: '500 14px/1.4 var(--fx-font-sans)',
                color: 'var(--fx-text-primary)',
                textDecoration: 'none',
              }}
            >
              {item.label} →
            </Link>
          </li>
        ))}
      </ul>
    </div>
  )
}
