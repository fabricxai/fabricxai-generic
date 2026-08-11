import type { ReactNode } from 'react'

import { t, type Locale } from '@/lib/i18n'

import { Eyebrow } from './signature'

/**
 * The TNA milestone timeline and the colour × size breakdown grid — the two
 * components the Order Desk is built around, shared with sampling and planning.
 *
 * Milestone status is never recomputed here. It comes from the nightly scan, so
 * the board and the escalation email always agree about what is late.
 */

export type MilestoneStatus = 'pending' | 'on_track' | 'at_risk' | 'late' | 'done'

/** Status → selvage colour and the mono-caps word that must accompany it. */
const STATUS: Record<MilestoneStatus, { label: string; selvage: string; colour: string }> = {
  // `done` says nothing about whether it happened late — that is a question for
  // the variance report, not for a chip on a board.
  done: { label: 'done', selvage: 'var(--fx-border-strong)', colour: 'var(--fx-text-tertiary)' },
  on_track: { label: 'on track', selvage: 'var(--fx-success)', colour: 'var(--fx-success)' },
  at_risk: { label: 'at risk', selvage: 'var(--fx-warning)', colour: 'var(--fx-warning)' },
  late: { label: 'late', selvage: 'var(--fx-danger)', colour: 'var(--fx-danger)' },
  pending: { label: 'planned', selvage: 'var(--fx-border-subtle)', colour: 'var(--fx-text-tertiary)' },
}

export interface Milestone {
  id: string
  name: string
  plannedDate: string | null
  actualDate: string | null
  dependsOn: { name: string; gapDays: number | null }[]
  /** Dependencies on the row that would not parse, if the caller counted them. */
  dependsOnUnreadable?: number
  critical: boolean
  ownerRole: string | null
  status: string
}

function fmt(date: string | null): string {
  if (!date) return '—'
  const d = new Date(date)
  if (Number.isNaN(d.getTime())) return date
  return `${String(d.getUTCDate()).padStart(2, '0')} ${
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]
  }`
}

/**
 * `pp_approval` is the identifier the engine, the escalation job and the board
 * all key off. Only the screen turns it into words, and a name with no entry
 * falls back to the key rather than to an empty cell — a missing translation
 * should look like one.
 */
export function milestoneLabel(name: string, locale: Locale): string {
  return t(locale, `orders.milestones.${name}`)
}

const label = milestoneLabel

export function MilestoneTimeline({
  milestones,
  onActualize,
  locale = 'en',
}: {
  milestones: readonly Milestone[]
  /** Absent for roles that may read the TNA but not move it. */
  onActualize?: (m: Milestone) => void
  locale?: Locale
}) {
  return (
    <div
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.8fr 90px 90px 1.1fr 110px',
          gap: 12,
          padding: '10px 18px 10px 21px',
          background: 'var(--fx-bg-sunken)',
          font: "500 11px/1 var(--fx-font-mono)",
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
        }}
      >
        <div>Milestone</div>
        <div>Planned</div>
        <div>Actual</div>
        <div>Owner</div>
        <div style={{ textAlign: 'right' }}>Status</div>
      </div>

      {milestones.map((m) => {
        const s = STATUS[(m.status as MilestoneStatus) ?? 'pending'] ?? STATUS.pending
        return (
          <div
            key={m.id}
            className="fx-selvage"
            style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
          >
            {/* The selvage is set inline because it carries a per-row colour and
                a per-row width — 5px means this one moves the ship date. */}
            <div
              style={{
                width: m.critical ? 5 : 3,
                flexShrink: 0,
                background: s.selvage,
                marginLeft: -3,
              }}
            />
            <div
              style={{
                flex: 1,
                minWidth: 0,
                display: 'grid',
                gridTemplateColumns: '1.8fr 90px 90px 1.1fr 110px',
                gap: 12,
                alignItems: 'center',
                padding: '13px 18px',
                minHeight: 'var(--fx-row-height)',
              }}
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
                <span
                  style={{
                    font: "500 14px/1.3 var(--fx-font-sans)",
                    color: m.status === 'done' ? 'var(--fx-text-tertiary)' : 'var(--fx-text-primary)',
                  }}
                >
                  {label(m.name, locale)}
                  {m.critical ? (
                    <span
                      style={{
                        font: "500 10px/1 var(--fx-font-mono)",
                        letterSpacing: '.05em',
                        color: 'var(--fx-text-tertiary)',
                        marginLeft: 8,
                      }}
                    >
                      CP
                    </span>
                  ) : null}
                </span>
                {/* An unreadable dependency is reported, never hidden: "waits on
                    nothing" and "waits on something I could not read" are
                    different facts about when this milestone can start. */}
                {m.dependsOnUnreadable ? (
                  <span
                    style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-warning)' }}
                  >
                    {m.dependsOnUnreadable} dependenc
                    {m.dependsOnUnreadable === 1 ? 'y' : 'ies'} could not be read
                  </span>
                ) : null}
                {m.dependsOn.length > 0 ? (
                  <span
                    style={{ font: "400 12px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
                  >
                    {/* The gap is shown because it is a decision, not spacing:
                        4 days after PP approval is somebody's judgement. */}
                    waits on{' '}
                    {m.dependsOn
                      .map((d) =>
                        d.gapDays === null
                          ? label(d.name, locale)
                          : `${label(d.name, locale)} +${d.gapDays}d`,
                      )
                      .join(', ')}
                  </span>
                ) : null}
              </div>

              <span data-numeric data-mono style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}>
                {fmt(m.plannedDate)}
              </span>
              <span
                data-numeric
                data-mono
                style={{
                  font: "400 13px/1.3 var(--fx-font-mono)",
                  color: m.actualDate ? 'var(--fx-text-primary)' : 'var(--fx-text-tertiary)',
                }}
              >
                {fmt(m.actualDate)}
              </span>
              <span style={{ font: "400 13px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
                {m.ownerRole ?? '—'}
              </span>

              <div style={{ textAlign: 'right' }}>
                {onActualize && !m.actualDate ? (
                  <button
                    onClick={() => onActualize(m)}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--fx-border-default)',
                      borderRadius: 'var(--fx-radius-md)',
                      padding: '7px 11px',
                      font: "600 12px/1 var(--fx-font-sans)",
                      color: 'var(--fx-text-primary)',
                      cursor: 'pointer',
                    }}
                  >
                    Mark done
                  </button>
                ) : (
                  /* Colour never carries state alone — the word repeats it. */
                  <span
                    style={{
                      font: "500 11px/1 var(--fx-font-mono)",
                      letterSpacing: '.05em',
                      textTransform: 'uppercase',
                      color: s.colour,
                    }}
                  >
                    {s.label}
                  </span>
                )}
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/**
 * The colour × size matrix.
 *
 * Totals are shown per row, per column and overall, because the number a
 * merchandiser is actually checking is whether the grid still adds up to the
 * contracted quantity — and finding that out by adding fifteen cells by eye is
 * how a 2,000-piece error reaches the cutting floor.
 */
export function BreakdownGrid({
  cells,
  contractedQty,
  tolerancePct,
}: {
  cells: readonly { color: string; size: string; qty: number }[]
  contractedQty?: number | null
  tolerancePct?: string | null
}) {
  if (cells.length === 0) {
    return (
      <div
        style={{
          border: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-md)',
          padding: 28,
          font: "400 14px/1.55 var(--fx-font-sans)",
          color: 'var(--fx-text-secondary)',
          background: 'var(--fx-bg-surface)',
        }}
      >
        No breakdown yet. Cutting cannot start until this grid exists.
      </div>
    )
  }

  const colors = [...new Set(cells.map((c) => c.color))]
  const sizes = [...new Set(cells.map((c) => c.size))]
  const at = (color: string, size: string) =>
    cells.find((c) => c.color === color && c.size === size)?.qty ?? 0

  const total = cells.reduce((sum, c) => sum + c.qty, 0)
  const colTotal = (size: string) =>
    cells.filter((c) => c.size === size).reduce((s, c) => s + c.qty, 0)

  // Tolerance is a percentage as a decimal string; basis points keep the
  // boundary case exact rather than putting it on the wrong side of a float.
  // A tolerance PERCENTAGE, converted once to basis points so the comparison below is
  // integer maths. Mirrors the conversion `checkBreakdownTotal` does server-side, which
  // is the number that actually decides.
  // eslint-disable-next-line fabricxai/no-float-money
  const bp = tolerancePct ? Math.round(Number.parseFloat(tolerancePct) * 100) : 0
  const slack = contractedQty ? Math.floor((contractedQty * bp) / 10_000) : 0
  const within = contractedQty === null || contractedQty === undefined
    ? true
    : total >= contractedQty - slack && total <= contractedQty + slack

  const track = `1.2fr repeat(${sizes.length}, 1fr) 1fr`

  return (
    <div
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: track,
          gap: 10,
          padding: '10px 18px',
          background: 'var(--fx-bg-sunken)',
          font: "500 11px/1 var(--fx-font-mono)",
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
        }}
      >
        <div>Colour</div>
        {sizes.map((s) => (
          <div key={s} style={{ textAlign: 'right' }}>
            {s}
          </div>
        ))}
        <div style={{ textAlign: 'right' }}>Total</div>
      </div>

      {colors.map((color) => {
        const rowTotal = sizes.reduce((s, size) => s + at(color, size), 0)
        return (
          <div
            key={color}
            style={{
              display: 'grid',
              gridTemplateColumns: track,
              gap: 10,
              padding: '12px 18px',
              borderTop: '1px solid var(--fx-border-subtle)',
              alignItems: 'center',
            }}
          >
            <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>{color}</span>
            {sizes.map((size) => (
              <span
                key={size}
                data-numeric
                style={{
                  font: "400 13px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-secondary)',
                  textAlign: 'right',
                }}
              >
                {at(color, size).toLocaleString()}
              </span>
            ))}
            <span
              data-numeric
              style={{
                font: "500 13px/1.3 var(--fx-font-mono)",
                color: 'var(--fx-text-primary)',
                textAlign: 'right',
              }}
            >
              {rowTotal.toLocaleString()}
            </span>
          </div>
        )
      })}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: track,
          gap: 10,
          padding: '12px 18px',
          borderTop: '1px solid var(--fx-border-default)',
          background: 'var(--fx-bg-sunken)',
          alignItems: 'center',
        }}
      >
        <Eyebrow>Total</Eyebrow>
        {sizes.map((size) => (
          <span
            key={size}
            data-numeric
            style={{
              font: "500 13px/1.3 var(--fx-font-mono)",
              color: 'var(--fx-text-secondary)',
              textAlign: 'right',
            }}
          >
            {colTotal(size).toLocaleString()}
          </span>
        ))}
        <span
          data-numeric
          style={{
            font: "600 14px/1.3 var(--fx-font-mono)",
            color: within ? 'var(--fx-text-primary)' : 'var(--fx-danger)',
            textAlign: 'right',
          }}
        >
          {total.toLocaleString()}
        </span>
      </div>

      {contractedQty ? (
        <div
          style={{
            padding: '11px 18px',
            font: "400 12px/1.4 var(--fx-font-mono)",
            color: within ? 'var(--fx-text-tertiary)' : 'var(--fx-danger)',
            borderTop: '1px solid var(--fx-border-subtle)',
          }}
        >
          contracted {contractedQty.toLocaleString()}
          {slack > 0 ? ` ±${slack.toLocaleString()}` : ''} ·{' '}
          {/* pieces, not money: `total` is a garment count from the colour x size grid. */}
          {/* eslint-disable-next-line fabricxai/no-float-money */}
          {within ? 'within tolerance' : `out by ${Math.abs(total - contractedQty).toLocaleString()}`}
        </div>
      ) : null}
    </div>
  )
}

/** A labelled figure pair used across the order header. */
export function FactPair({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ font: "400 12px/1 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
        {label}
      </span>
      <span style={{ font: "500 14px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
        {children}
      </span>
    </div>
  )
}
