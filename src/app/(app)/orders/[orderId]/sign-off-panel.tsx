import Link from 'next/link'

import { Card } from '@/components/fx/data'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'

import type { SignOffRow, SignOffState } from './sign-off'

/**
 * "What the departments have signed" (design canvas, order dossier).
 *
 * One row per gate, in lifecycle order, each owned by a different department. The value is
 * not any single row — it is reading down the column and seeing where the order stops.
 *
 * The states are rendered so that ABSENCE cannot be mistaken for approval. A row nobody
 * has answered is not blank; it says what is missing and, where the answer is "FabricXAI
 * does not record that", it says that instead of pretending the department has not got to
 * it yet. A grey tick and an unanswered question look identical at a glance, which is how
 * a panel like this stops being read.
 */
const TONE: Record<SignOffState, { dot: string; badge: 'success' | 'warning' | 'danger' | 'neutral' }> = {
  done: { dot: 'var(--fx-success)', badge: 'success' },
  open: { dot: 'var(--fx-warning)', badge: 'warning' },
  attention: { dot: 'var(--fx-danger)', badge: 'danger' },
  none: { dot: 'var(--fx-border-strong)', badge: 'neutral' },
  off: { dot: 'var(--fx-border-subtle)', badge: 'neutral' },
  unmodelled: { dot: 'var(--fx-border-subtle)', badge: 'neutral' },
}

export function SignOffPanel({ rows }: { rows: readonly SignOffRow[] }) {
  const answered = rows.filter((row) => row.state === 'done').length
  const askable = rows.filter((row) => row.state !== 'off' && row.state !== 'unmodelled').length

  return (
    <section>
      <SectionHeading eyebrow={`${answered} of ${askable} gates passed · in lifecycle order`}>
        What the departments have signed
      </SectionHeading>
      <Card>
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {rows.map((row, index) => (
            <li
              key={row.key}
              style={{
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
                padding: '13px 0',
                borderTop: index === 0 ? 'none' : '1px solid var(--fx-border-subtle)',
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 9,
                  height: 9,
                  borderRadius: '50%',
                  marginTop: 5,
                  flexShrink: 0,
                  background: TONE[row.state].dot,
                }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'baseline', flexWrap: 'wrap' }}>
                  <span
                    style={{
                      font: '500 13.5px/1.3 var(--fx-font-sans)',
                      color:
                        row.state === 'off' || row.state === 'unmodelled'
                          ? 'var(--fx-text-tertiary)'
                          : 'var(--fx-text-primary)',
                    }}
                  >
                    {row.label}
                  </span>
                  {row.badge ? <Badge tone={TONE[row.state].badge}>{row.badge}</Badge> : null}
                  {/* Said in words, not only in grey. Somebody scanning for what is
                      outstanding must not read "we cannot record this" as "not done yet". */}
                  {row.state === 'unmodelled' ? <Badge tone="neutral">not recorded here</Badge> : null}
                </div>
                <p
                  style={{
                    margin: '3px 0 0',
                    font: '400 12.5px/1.55 var(--fx-font-sans)',
                    color: 'var(--fx-text-secondary)',
                  }}
                >
                  {row.detail}
                </p>
              </div>
              {row.href ? (
                <Link
                  href={row.href}
                  style={{
                    font: '500 12px/1 var(--fx-font-sans)',
                    color: 'var(--fx-accent-pressed)',
                    textDecoration: 'none',
                    whiteSpace: 'nowrap',
                    marginTop: 3,
                  }}
                >
                  Open
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>
    </section>
  )
}
