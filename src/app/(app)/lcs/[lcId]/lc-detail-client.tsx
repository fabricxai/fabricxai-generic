'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { DateInput } from '@/components/fx/forms'
import { linkLcToOrder, openBtbCredit, recordLcAmendment } from '@/modules/commercial/actions'
import { factoryToday } from '@/lib/dates'

interface Amendment {
  id: string
  number: number
  changed: { field: string; from: string | null; to: string | null }[]
  tightened: boolean
  receivedAt: string
  createdAt: string
}

interface Btb {
  id: string
  number: string
  value: string
  currency: string
  status: string
  openedAt: string | null
  expiryDate: string | null
}

interface LinkedOrder {
  orderId: string
  poNumbers: string[]
  plannedExFactoryDate: string | null
  status: string
  floatDays: number | null
}

interface Lc {
  id: string
  number: string
  value: string
  currency: string
  tolerancePct: string
  status: string
  latestShipmentDate: string | null
  expiryDate: string | null
  docsRequired: Record<string, unknown>
  amendments: Amendment[]
  btbs: Btb[]
  headroom: { limit: string; used: string; free: string; limitPct: number }
  linkedOrders: LinkedOrder[]
}

const AMENDABLE: readonly { key: string; label: string; date: boolean }[] = [
  { key: 'value', label: 'Value', date: false },
  { key: 'tolerancePct', label: 'Tolerance %', date: false },
  { key: 'latestShipmentDate', label: 'Latest shipment', date: true },
  { key: 'expiryDate', label: 'Expiry', date: true },
]

/**
 * One credit, and everything drawn on it.
 *
 * The BTB panel refuses locally BEFORE calling the server, and the server refuses again.
 * That is not redundancy for its own sake: the local check is what lets the screen explain
 * the shortfall while the number is still on the form, and the server check is what makes
 * it true. Only the server's answer writes anything.
 */
export function LcDetailClient({
  lc,
  daysToLatestShipment,
  daysToExpiry,
  coverable,
}: {
  lc: Lc
  daysToLatestShipment: number | null
  daysToExpiry: number | null
  /** The buyer's live orders this credit does not cover yet. */
  coverable: readonly { id: string; label: string }[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [field, setField] = useState<string>('latestShipmentDate')
  const [nextValue, setNextValue] = useState('')
  const [receivedAt, setReceivedAt] = useState(factoryToday())

  const [btbNumber, setBtbNumber] = useState('')
  const [btbValue, setBtbValue] = useState('')
  const [coverOrderId, setCoverOrderId] = useState('')

  const [noted, setNoted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // eslint-disable-next-line fabricxai/no-float-money -- local BTB headroom preview only; the server re-runs the exact gate (rule 8) and only its answer writes
  const free = Number.parseFloat(lc.headroom.free)
  // Commas stripped BEFORE parsing: parseFloat("62,000.00") silently stops at the comma
  // and answers 62 — which is how a live tester opened a sixty-two-DOLLAR back-to-back
  // while typing sixty-two thousand, sailing under the headroom gate on a formatting
  // character. The server's zod would have refused the comma; the old code converted it
  // to a clean wrong number first.
  // eslint-disable-next-line fabricxai/no-float-money -- half-typed keyboard value for the same preview; NaN falls back to 0, the server recomputes exactly
  const asking = Number.parseFloat(btbValue.replace(/,/g, '')) || 0
  // Local preview only. The server runs the same check and its answer is the one that counts.
  const wouldExceed = asking > 0 && asking > free

  function amend() {
    if (!nextValue.trim()) return
    setFailure(null)
    startTransition(async () => {
      try {
        const result = await recordLcAmendment({
          lcId: lc.id,
          diff: { [field]: nextValue.trim() },
          receivedAt,
        })
        setNoted(
          `Amendment ${result.number} recorded${result.tightened ? ' — it TIGHTENS the credit' : ''}.`,
        )
        setNextValue('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The amendment was not recorded.'))
      }
    })
  }

  function cover() {
    if (!coverOrderId) return
    setFailure(null)
    startTransition(async () => {
      try {
        const result = unwrap(await linkLcToOrder({ lcId: lc.id, orderId: coverOrderId }))
        setNoted(
          result.floatDays === null
            ? 'Covered. The order has no planned ex-factory date yet, so the float cannot be computed.'
            : result.floatDays < 0
              ? `Covered — and already in CONFLICT: the order ships ${-result.floatDays} day(s) after the latest shipment date.`
              : `Covered. ${result.floatDays} day(s) of float before the latest shipment date.`,
        )
        setCoverOrderId('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The order was not covered.'))
      }
    })
  }

  function openBtb() {
    if (!btbNumber.trim() || asking <= 0) return
    setFailure(null)
    startTransition(async () => {
      try {
        await openBtbCredit({
          masterLcId: lc.id,
          number: btbNumber.trim(),
          value: asking.toFixed(2),
          currency: lc.currency,
          openedAt: factoryToday(),
        })
        setNoted(`Back-to-back ${btbNumber.trim()} opened.`)
        setBtbNumber('')
        setBtbValue('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The BTB was not opened.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {/* ── The two deadlines ────────────────────────────────────────────── */}
      <section>
        <SectionHeading
          eyebrow={lc.amendments.length > 0 ? `${lc.amendments.length} amendments on file` : undefined}
        >
          Terms as amended
        </SectionHeading>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
            gap: 1,
            background: 'var(--fx-border-subtle)',
            border: '1px solid var(--fx-border-subtle)',
          }}
        >
          {[
            { label: 'Value', value: `${lc.value} ${lc.currency}` },
            { label: 'Tolerance', value: `± ${lc.tolerancePct}%` },
            {
              label: 'Latest shipment',
              value: lc.latestShipmentDate ?? '—',
              note: dayNote(daysToLatestShipment, 'on the vessel by'),
              tone: urgent(daysToLatestShipment),
            },
            {
              label: 'Expiry',
              value: lc.expiryDate ?? '—',
              note: dayNote(daysToExpiry, 'documents at the bank by'),
              tone: urgent(daysToExpiry),
            },
          ].map((cell) => (
            <div key={cell.label} style={{ background: 'var(--fx-bg-surface)', padding: '14px 16px' }}>
              <div style={label}>{cell.label}</div>
              <div
                style={{
                  marginTop: 6,
                  font: "600 19px/1.2 var(--fx-font-sans)",
                  color: cell.tone ?? 'var(--fx-text-primary)',
                }}
              >
                {cell.value}
              </div>
              {cell.note ? (
                <div
                  style={{
                    marginTop: 4,
                    font: "400 11.5px/1.4 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {cell.note}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <p
          style={{
            marginTop: 10,
            marginBottom: 0,
            font: "400 12px/1.6 var(--fx-font-mono)",
            color: 'var(--fx-text-tertiary)',
          }}
        >
          Two different deadlines. Goods must be on the vessel by the latest shipment date;
          documents must be at the bank by expiry. Meeting one and missing the other is still
          an unpaid shipment.
        </p>
      </section>

      {/* ── The orders this credit covers ───────────────────────────────────
        * The join the conflict detector and the countdown alerts run through. It had no
        * writer until the live test reached Phase 3 — every conflict the module could
        * detect was unreachable, because this list was permanently empty.
        */}
      <section>
        <SectionHeading
          eyebrow={
            lc.linkedOrders.length > 0
              ? `${lc.linkedOrders.length} covered`
              : 'conflict detection has nothing to check until an order is covered'
          }
        >
          Orders this credit covers
        </SectionHeading>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {lc.linkedOrders.map((order) => (
            <div
              key={order.orderId}
              style={{
                display: 'flex',
                gap: 14,
                flexWrap: 'wrap',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '12px 16px',
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
              }}
            >
              <span style={{ font: "500 14px/1.3 var(--fx-font-mono)" }}>
                {order.poNumbers[0] ?? order.orderId.slice(0, 8)}
                <span style={{ marginLeft: 10 }}>
                  <Badge>{order.status}</Badge>
                </span>
              </span>
              <span
                style={{
                  font: "400 12.5px/1.4 var(--fx-font-mono)",
                  color:
                    order.floatDays === null
                      ? 'var(--fx-text-tertiary)'
                      : order.floatDays < 0
                        ? 'var(--fx-danger)'
                        : order.floatDays <= 2
                          ? 'var(--fx-warning)'
                          : 'var(--fx-text-secondary)',
                }}
              >
                {order.floatDays === null
                  ? 'no ex-factory date — float unknown'
                  : order.floatDays < 0
                    ? `ships ${-order.floatDays} day(s) AFTER latest shipment — conflict`
                    : `ships ${order.plannedExFactoryDate} · ${order.floatDays} day(s) of float`}
              </span>
            </div>
          ))}

          {coverable.length > 0 ? (
            <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <label
                style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 260px', minWidth: 0 }}
              >
                <span style={fieldLabel}>Cover an order of this buyer</span>
                <select
                  value={coverOrderId}
                  onChange={(e) => setCoverOrderId(e.target.value)}
                  style={control}
                >
                  <option value="">Choose the order</option>
                  {coverable.map((order) => (
                    <option key={order.id} value={order.id}>
                      {order.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="secondary" onClick={cover} disabled={pending || coverOrderId === ''}>
                Cover it
              </Button>
            </div>
          ) : lc.linkedOrders.length === 0 ? (
            <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              This buyer has no live order to cover yet — the order comes first, then the credit
              that pays for it.
            </p>
          ) : null}
        </div>
      </section>

      {/* ── Amendments ───────────────────────────────────────────────────── */}
      <section>
        <SectionHeading eyebrow="the replaced value is kept, never overwritten">
          Record an amendment
        </SectionHeading>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 200px', minWidth: 0 }}>
            <span style={fieldLabel}>What changed</span>
            <select value={field} onChange={(e) => setField(e.target.value)} style={control}>
              {AMENDABLE.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 180px', minWidth: 0 }}>
            <span style={fieldLabel}>New value</span>
            <input
              type={AMENDABLE.find((a) => a.key === field)?.date ? 'date' : 'text'}
              value={nextValue}
              onChange={(e) => setNextValue(e.target.value)}
              style={control}
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 1 170px', minWidth: 0 }}>
            <span style={fieldLabel}>Advised on</span>
            <DateInput
              value={receivedAt}
              onChange={setReceivedAt}
              style={control}
            />
          </label>

          <Button variant="secondary" disabled={!nextValue.trim() || pending} onClick={amend}>
            Record
          </Button>
        </div>

        {lc.amendments.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 16 }}>
            {lc.amendments.map((a) => (
              <div
                key={a.id}
                style={{
                  padding: '12px 16px',
                  background: 'var(--fx-bg-surface)',
                  border: '1px solid var(--fx-border-subtle)',
                  borderLeft: a.tightened ? '3px solid var(--fx-warning)' : undefined,
                }}
              >
                <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                  <span style={{ font: "600 13.5px/1.2 var(--fx-font-sans)" }}>
                    Amendment {a.number}
                  </span>
                  <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                    advised {a.receivedAt}
                  </span>
                  {a.tightened ? <Badge tone="warning">tightens the credit</Badge> : null}
                </div>
                {a.changed.map((c) => (
                  <div
                    key={c.field}
                    style={{
                      marginTop: 6,
                      font: "400 12.5px/1.5 var(--fx-font-mono)",
                      color: 'var(--fx-text-secondary)',
                    }}
                  >
                    {c.field}: <s style={{ color: 'var(--fx-text-tertiary)' }}>{c.from ?? '—'}</s>{' '}
                    → {c.to ?? '—'}
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : null}
      </section>

      {/* ── Back-to-back ─────────────────────────────────────────────────── */}
      <section>
        <SectionHeading eyebrow={`capped at ${lc.headroom.limitPct}% of the master`}>
          Back-to-back credit
        </SectionHeading>

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 1,
            background: 'var(--fx-border-subtle)',
            border: '1px solid var(--fx-border-subtle)',
            marginBottom: 16,
          }}
        >
          {[
            { label: 'Limit', value: lc.headroom.limit },
            { label: 'Committed', value: lc.headroom.used },
            {
              label: 'Headroom left',
              value: lc.headroom.free,
              tone: free <= 0 ? 'var(--fx-danger)' : undefined,
            },
          ].map((cell) => (
            <div key={cell.label} style={{ background: 'var(--fx-bg-surface)', padding: '14px 16px' }}>
              <div style={label}>{cell.label}</div>
              <div
                style={{
                  marginTop: 6,
                  font: "600 20px/1.2 var(--fx-font-sans)",
                  color: cell.tone ?? 'var(--fx-text-primary)',
                }}
              >
                {cell.value} {lc.currency}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 200px', minWidth: 0 }}>
            <span style={fieldLabel}>BTB number</span>
            <input value={btbNumber} onChange={(e) => setBtbNumber(e.target.value)} style={control} />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 1 180px', minWidth: 0 }}>
            <span style={fieldLabel}>Value ({lc.currency})</span>
            <input
              inputMode="decimal"
              value={btbValue}
              onChange={(e) => setBtbValue(e.target.value)}
              style={control}
            />
          </label>
          <Button
            variant="primary"
            disabled={!btbNumber.trim() || asking <= 0 || wouldExceed || pending}
            onClick={openBtb}
          >
            Open the BTB
          </Button>
        </div>

        {wouldExceed ? (
          <div
            style={{
              marginTop: 14,
              border: '1px solid var(--fx-danger)',
              borderLeft: '5px solid var(--fx-danger)',
              background: 'var(--fx-bg-surface)',
              padding: '16px 18px',
            }}
          >
            <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
              <span style={{ font: "600 15px/1.2 var(--fx-font-sans)" }}>
                This BTB cannot be opened
              </span>
              <span
                style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
              >
                nothing written
              </span>
            </div>
            <p
              style={{
                margin: '8px 0 0',
                font: "400 13px/1.6 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              {asking.toFixed(2)} {lc.currency} against {lc.headroom.free} {lc.currency} of
              headroom — over by {(asking - free).toFixed(2)}. A back-to-back credit the master
              cannot fund is a commitment to a supplier with no money behind it.
            </p>
            <p
              style={{
                margin: '8px 0 0',
                font: "400 12.5px/1.6 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              Ways out — open it for the headroom that exists, or ask the buyer to raise the
              master LC.
            </p>
          </div>
        ) : null}

        {lc.btbs.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 16 }}>
            {lc.btbs.map((b) => (
              <div
                key={b.id}
                style={{
                  display: 'flex',
                  gap: 14,
                  alignItems: 'center',
                  flexWrap: 'wrap',
                  padding: '10px 16px',
                  background: 'var(--fx-bg-surface)',
                  border: '1px solid var(--fx-border-subtle)',
                }}
              >
                <span style={{ font: "600 13.5px/1.2 var(--fx-font-mono)" }}>{b.number}</span>
                <span data-numeric data-mono>
                  {b.value} {b.currency}
                </span>
                <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge>
                {b.expiryDate ? (
                  <span
                    style={{
                      font: "400 12px/1 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    expires {b.expiryDate}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </section>
    </div>
  )
}

function dayNote(days: number | null, prefix: string): string | undefined {
  if (days === null) return undefined
  if (days < 0) return `${prefix} — ${Math.abs(days)} days ago`
  return `${prefix} — ${days} days`
}

function urgent(days: number | null): string | undefined {
  if (days === null) return undefined
  if (days < 0) return 'var(--fx-danger)'
  return days <= 21 ? 'var(--fx-warning)' : undefined
}

const label: React.CSSProperties = {
  font: "400 10.5px/1 var(--fx-font-mono)",
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--fx-text-tertiary)',
}

const fieldLabel: React.CSSProperties = { font: "500 13px/1.3 var(--fx-font-sans)" }

const control: React.CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  padding: '10px 12px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 14px/1.4 var(--fx-font-sans)",
}
