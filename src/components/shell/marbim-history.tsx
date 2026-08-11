'use client'

/**
 * Earlier chats — a full panel view, not a header dropdown.
 *
 * The first history UI jammed a scroll list under the title and shoved the scope chip
 * around. This one takes the body of the panel: one job, grouped by when, with the amber
 * slash marking the thread you are already in.
 */

export type HistoryRow = {
  conversationId: string
  preview: string
  turnCount: number
  lastAt: string
}

type Group = { label: string; rows: HistoryRow[] }

export function MarbimHistoryView({
  history,
  activeId,
  onOpen,
  onNew,
  onBack,
}: {
  history: HistoryRow[] | null
  activeId: string
  onOpen: (id: string) => void
  onNew: () => void
  onBack: () => void
}) {
  const groups = history ? groupByWhen(history) : null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 18,
        flex: 1,
        minHeight: 0,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexShrink: 0 }}>
        <button
          onClick={onBack}
          style={{
            background: 'transparent',
            border: 'none',
            padding: 0,
            font: '500 12.5px/1 var(--fx-font-mono)',
            color: 'var(--fx-text-secondary)',
            cursor: 'pointer',
            textDecoration: 'underline',
            textUnderlineOffset: 3,
          }}
        >
          ← back
        </button>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
          <span
            style={{
              font: '400 11px/1 var(--fx-font-mono)',
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            Earlier chats
          </span>
          <span style={{ font: '600 16px/1.25 var(--fx-font-sans)', color: 'var(--fx-text-primary)' }}>
            Pick up where you left off
          </span>
        </div>
        <button
          onClick={onNew}
          style={{
            marginLeft: 'auto',
            background: 'var(--fx-text-primary)',
            color: 'var(--fx-text-inverse)',
            border: 'none',
            borderRadius: 'var(--fx-radius-md)',
            padding: '11px 14px',
            minHeight: 44,
            font: '600 13px/1 var(--fx-font-sans)',
            cursor: 'pointer',
            flexShrink: 0,
          }}
        >
          New chat
        </button>
      </div>

      <div
        className="fx-scroll-quiet"
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 22,
        }}
      >
        {groups === null ? (
          <span
            style={{
              font: '400 12.5px/1.4 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            Loading…
          </span>
        ) : groups.length === 0 ? (
          <div
            style={{
              padding: '28px 4px',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <span style={{ font: '500 14.5px/1.4 var(--fx-font-sans)' }}>Nothing saved yet</span>
            <span
              style={{
                font: '400 13px/1.5 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
                textWrap: 'pretty',
              }}
            >
              Ask a question and it will show up here the next time you open earlier chats.
            </span>
          </div>
        ) : (
          groups.map((group) => (
            <section key={group.label} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div
                style={{
                  font: '400 11px/1 var(--fx-font-mono)',
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                  padding: '0 2px 6px',
                }}
              >
                {group.label}
              </div>
              {group.rows.map((row) => {
                const active = row.conversationId === activeId
                return (
                  <button
                    key={row.conversationId}
                    onClick={() => onOpen(row.conversationId)}
                    style={{
                      textAlign: 'left',
                      display: 'flex',
                      gap: 12,
                      alignItems: 'flex-start',
                      padding: '12px 12px 12px 10px',
                      border: '1px solid',
                      borderColor: active ? 'var(--fx-border-default)' : 'transparent',
                      borderRadius: 'var(--fx-radius-md)',
                      background: active ? 'var(--fx-bg-sunken)' : 'transparent',
                      cursor: 'pointer',
                    }}
                  >
                    <span
                      aria-hidden="true"
                      style={{
                        width: 2,
                        height: 16,
                        marginTop: 3,
                        flexShrink: 0,
                        transform: 'skewX(var(--fx-slash-angle))',
                        background: active ? 'var(--fx-accent)' : 'var(--fx-border-default)',
                      }}
                    />
                    <span
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 5,
                        minWidth: 0,
                        flex: 1,
                      }}
                    >
                      <span
                        style={{
                          font: '500 14px/1.4 var(--fx-font-sans)',
                          color: 'var(--fx-text-primary)',
                          display: '-webkit-box',
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {row.preview}
                      </span>
                      <span
                        style={{
                          font: '400 11.5px/1.3 var(--fx-font-mono)',
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {row.turnCount} {row.turnCount === 1 ? 'turn' : 'turns'}
                        {active ? ' · open now' : ` · ${relativeWhen(row.lastAt)}`}
                      </span>
                    </span>
                  </button>
                )
              })}
            </section>
          ))
        )}
      </div>
    </div>
  )
}

function groupByWhen(rows: HistoryRow[]): Group[] {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startOfYesterday = startOfToday - 86_400_000

  const today: HistoryRow[] = []
  const yesterday: HistoryRow[] = []
  const earlier: HistoryRow[] = []

  for (const row of rows) {
    const t = new Date(row.lastAt).getTime()
    if (Number.isNaN(t)) {
      earlier.push(row)
      continue
    }
    if (t >= startOfToday) today.push(row)
    else if (t >= startOfYesterday) yesterday.push(row)
    else earlier.push(row)
  }

  const groups: Group[] = []
  if (today.length) groups.push({ label: 'Today', rows: today })
  if (yesterday.length) groups.push({ label: 'Yesterday', rows: yesterday })
  if (earlier.length) groups.push({ label: 'Earlier', rows: earlier })
  return groups
}

function relativeWhen(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const diffMs = Date.now() - date.getTime()
  const mins = Math.round(diffMs / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days}d ago`
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
