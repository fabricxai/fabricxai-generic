'use client'

import type { CSSProperties, ReactNode } from 'react'
import { useState } from 'react'

import { MarbimMark } from './mark'
import { Eyebrow, type SelvageStatus } from './signature'

/**
 * Cards, tables, tabs and the rest of the data layer.
 *
 * The table is the workhorse of this product, so it carries the selvage edge
 * natively: a 3px status stripe on the row's left rim (5px on the critical
 * path) with the verdict repeated in a status column, because colour never
 * carries state alone.
 */

/* ── Card ─────────────────────────────────────────────────
   `cut` marks the ONE card in a group that matters. Never more than one per
   group, and radius is dropped on that corner rather than doubled. */

export function Card({
  children,
  cut = false,
  padding = 24,
  style,
  className,
}: {
  children: ReactNode
  cut?: boolean
  padding?: number | string
  style?: CSSProperties
  className?: string
}) {
  return (
    <div
      className={[cut ? 'fx-cut' : undefined, className].filter(Boolean).join(' ')}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        boxShadow: 'var(--fx-sh1)',
        padding,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/* ── Stat tile ────────────────────────────────────────────
   Eyebrow, figure, then the denominator. The owner dashboard requires every
   figure to carry what it was measured against, so `basis` is not optional
   decoration — a ratio without its denominator is a rumour. */

export function StatTile({
  label,
  value,
  basis,
  status,
  critical,
  asOf,
}: {
  label: ReactNode
  value: ReactNode
  /** What the figure was measured against — "3 on the critical path", "of 412 pcs". */
  basis?: ReactNode
  status?: SelvageStatus
  critical?: boolean
  /** When the figure was computed. Stale numbers are worse than missing ones. */
  asOf?: ReactNode
}) {
  const body = (
    <div style={{ padding: '17px 20px', display: 'flex', flexDirection: 'column', gap: 7, flex: 1 }}>
      <Eyebrow>{label}</Eyebrow>
      <div>{value}</div>
      {basis ? (
        <div style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
          {basis}
        </div>
      ) : null}
      {asOf ? (
        <div style={{ font: "400 11px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          as of {asOf}
        </div>
      ) : null}
    </div>
  )

  if (!status) {
    return (
      <div
        style={{
          background: 'var(--fx-bg-surface)',
          border: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-md)',
          boxShadow: 'var(--fx-sh1)',
          display: 'flex',
        }}
      >
        {body}
      </div>
    )
  }

  return (
    <div
      className="fx-selvage"
      data-status={status}
      data-critical={critical || undefined}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        boxShadow: 'var(--fx-sh1)',
      }}
    >
      {body}
    </div>
  )
}

/* ── Data table ───────────────────────────────────────────── */

export interface Column<Row> {
  key: string
  header: ReactNode
  /** CSS grid track, e.g. "1.6fr" or "120px". */
  width?: string
  align?: 'left' | 'right'
  render: (row: Row) => ReactNode
}

export interface TableRow {
  id: string
  status?: SelvageStatus
  critical?: boolean
}

export function DataTable<Row extends TableRow>({
  columns,
  rows,
  loading = false,
  empty,
  onRowClick,
  selectedId,
  caption,
}: {
  columns: readonly Column<Row>[]
  rows: readonly Row[]
  loading?: boolean
  empty?: ReactNode
  onRowClick?: (row: Row) => void
  selectedId?: string
  caption?: string
}) {
  const track = columns.map((c) => c.width ?? '1fr').join(' ')
  const selvaged = rows.some((r) => r.status)

  return (
    <div
      role="table"
      aria-label={caption}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        overflow: 'hidden',
      }}
    >
      <div
        role="row"
        style={{
          display: 'grid',
          gridTemplateColumns: track,
          gap: 16,
          padding: selvaged ? '10px 22px 10px 25px' : '10px 22px',
          background: 'var(--fx-bg-sunken)',
          font: "500 11px/1 var(--fx-font-mono)",
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
          position: 'sticky',
          top: 0,
          zIndex: 1,
        }}
      >
        {columns.map((c) => (
          <div key={c.key} role="columnheader" style={{ textAlign: c.align ?? 'left' }}>
            {c.header}
          </div>
        ))}
      </div>

      {loading ? (
        <TableSkeleton columns={columns.length} track={track} />
      ) : rows.length === 0 ? (
        <div style={{ padding: 48 }}>{empty ?? <EmptyRow />}</div>
      ) : (
        rows.map((row) => {
          const selected = row.id === selectedId
          const cells = (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: track,
                gap: 16,
                alignItems: 'center',
                padding: '13px 18px 13px 15px',
                flex: 1,
                minWidth: 0,
                minHeight: 'var(--fx-row-height)',
                font: "400 14px/1.3 var(--fx-font-sans)",
              }}
            >
              {columns.map((c) => (
                <div
                  key={c.key}
                  role="cell"
                  style={{ textAlign: c.align ?? 'left', minWidth: 0 }}
                >
                  {c.render(row)}
                </div>
              ))}
            </div>
          )

          return (
            <div
              key={row.id}
              role="row"
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              onKeyDown={
                onRowClick
                  ? (e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        onRowClick(row)
                      }
                    }
                  : undefined
              }
              className={row.status ? 'fx-selvage' : undefined}
              data-status={row.status}
              data-critical={row.critical || undefined}
              style={{
                borderTop: '1px solid var(--fx-border-subtle)',
                cursor: onRowClick ? 'pointer' : undefined,
                // Selected uses bg-selected — amber at 12%, never a fill.
                background: selected ? 'var(--fx-bg-selected)' : undefined,
                display: row.status ? undefined : 'flex',
              }}
            >
              {cells}
            </div>
          )
        })
      )}
    </div>
  )
}

function TableSkeleton({ columns, track }: { columns: number; track: string }) {
  return (
    <>
      {Array.from({ length: 4 }, (_, r) => (
        <div
          key={r}
          style={{
            display: 'grid',
            gridTemplateColumns: track,
            gap: 16,
            padding: '16px 22px',
            borderTop: '1px solid var(--fx-border-subtle)',
          }}
        >
          {Array.from({ length: columns }, (_, c) => (
            <div
              key={c}
              style={{
                height: 11,
                width: `${45 + ((r * 7 + c * 13) % 40)}%`,
                borderRadius: 'var(--fx-radius-sm)',
                background: 'var(--fx-bg-sunken)',
                backgroundImage:
                  'linear-gradient(90deg, transparent, var(--fx-bg-hover), transparent)',
                backgroundSize: '200% 100%',
                animation: 'fx-shimmer 1.6s linear infinite',
              }}
            />
          ))}
        </div>
      ))}
    </>
  )
}

function EmptyRow() {
  return (
    <div style={{ textAlign: 'center', color: 'var(--fx-text-tertiary)' }}>
      <MarbimMark size={32} label={null} />
      <div style={{ marginTop: 12, font: "400 14px/1.5 var(--fx-font-sans)" }}>Nothing here yet</div>
    </div>
  )
}

/* ── Tabs ─────────────────────────────────────────────────
   The active tab takes an amber underline. It is the one selected-state
   exception to the single-amber-moment rule, because it is under 24px. */

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
}: {
  tabs: readonly { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
  label?: string
}) {
  return (
    <div
      role="tablist"
      aria-label={label}
      style={{ display: 'flex', gap: 26, borderBottom: '1px solid var(--fx-border-subtle)' }}
    >
      {tabs.map((t) => {
        const active = t.value === value
        return (
          <button
            key={t.value}
            role="tab"
            aria-selected={active}
            onClick={() => onChange(t.value)}
            style={{
              background: 'transparent',
              border: 'none',
              padding: '0 0 13px',
              cursor: 'pointer',
              font: "600 14px/1 var(--fx-font-sans)",
              color: active ? 'var(--fx-text-primary)' : 'var(--fx-text-tertiary)',
              borderBottom: `2px solid ${active ? 'var(--fx-accent)' : 'transparent'}`,
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

export function Breadcrumbs({ trail }: { trail: readonly { label: string; href?: string }[] }) {
  return (
    <nav
      className="fx-breadcrumbs"
      aria-label="Breadcrumb"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        font: "400 13px/1 var(--fx-font-sans)",
        color: 'var(--fx-text-tertiary)',
      }}
    >
      {trail.map((c, i) => {
        const last = i === trail.length - 1
        return (
          <span key={c.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
            {i > 0 ? <span style={{ opacity: 0.5 }}>/</span> : null}
            {c.href && !last ? (
              <a href={c.href} style={{ textDecoration: 'none', color: 'inherit' }}>
                {c.label}
              </a>
            ) : (
              <span
                aria-current={last ? 'page' : undefined}
                style={{
                  color: last ? 'var(--fx-text-primary)' : 'inherit',
                  fontWeight: last ? 500 : 400,
                }}
              >
                {c.label}
              </span>
            )}
          </span>
        )
      })}
    </nav>
  )
}

export function Accordion({
  items,
}: {
  items: readonly { id: string; question: ReactNode; body: ReactNode }[]
}) {
  const [open, setOpen] = useState<string | null>(items[0]?.id ?? null)

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {items.map((item) => {
        const isOpen = open === item.id
        return (
          <div key={item.id} style={{ borderBottom: '1px solid var(--fx-border-subtle)' }}>
            <button
              aria-expanded={isOpen}
              onClick={() => setOpen(isOpen ? null : item.id)}
              style={{
                width: '100%',
                background: 'transparent',
                border: 'none',
                padding: '14px 0',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                cursor: 'pointer',
                font: "600 14px/1.3 var(--fx-font-sans)",
                color: 'var(--fx-text-primary)',
                textAlign: 'left',
              }}
            >
              {item.question}
              <span
                aria-hidden="true"
                style={{
                  font: "400 11px/1 var(--fx-font-sans)",
                  color: 'var(--fx-text-tertiary)',
                  transform: isOpen ? 'rotate(180deg)' : undefined,
                  transition: 'transform var(--fx-dur-state)',
                }}
              >
                ▾
              </span>
            </button>
            {isOpen ? (
              <div
                style={{
                  font: "400 14px/1.55 var(--fx-font-sans)",
                  color: 'var(--fx-text-secondary)',
                  padding: '0 0 16px',
                  textWrap: 'pretty',
                }}
              >
                {item.body}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
