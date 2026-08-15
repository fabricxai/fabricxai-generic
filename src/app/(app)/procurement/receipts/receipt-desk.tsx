'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Ident } from '@/components/fx/format'
import { Badge, Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { recordReceipt } from '@/modules/procurement/actions'
import { unwrap } from '@/lib/action-failure'

interface Line {
  lineId: string
  supplierPoId: string
  poNumber: string
  supplierName: string
  currency: string
  itemCode: string
  itemName: string
  orderedQty: string
  receivedQty: string
  outstandingQty: string
  unit: string
  unitPrice: string
  status: string
  expectedDeliveryDate: string | null
  daysToDelivery: number | null
}

/**
 * Record what turned up.
 *
 * **The quantity is not pre-filled with the outstanding balance.** It would be right most of
 * the time, and that is the problem: a field already holding the right-looking number gets
 * confirmed rather than read, and the one delivery that was short goes in as complete. The
 * outstanding figure sits next to the field where it can be compared, and a one-tap button
 * fills it for the common case — deliberately, rather than by default.
 *
 * **An over-receipt is warned about before it is sent, and still allowed.** The goods are on
 * the shelf; refusing the entry means somebody writes it on paper instead and the ledger
 * stops matching the store. The screen says what it will do — flag it, and tell finance —
 * so the person is not surprised by a warning they could have seen coming.
 *
 * **What happened is reported from the server's answer, not assumed.** `applyReceipt`
 * returns whether the line closed and what is still outstanding, so the confirmation says
 * what actually happened rather than what the click intended.
 */
export function ReceiptDesk({
  lines,
  tolerancePct,
}: {
  lines: readonly Line[]
  tolerancePct: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [openId, setOpenId] = useState<string | null>(null)
  const [qty, setQty] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function open(line: Line) {
    setOpenId(openId === line.lineId ? null : line.lineId)
    setQty('')
    setFailure(null)
  }

  /** Over the ordered quantity, and by how much — computed for the warning only. */
  function overBy(line: Line): number {
    const entered = Number(qty)
    if (!Number.isFinite(entered) || entered <= 0) return 0
    const over = Number(line.receivedQty) + entered - Number(line.orderedQty)
    return over > 0 ? over : 0
  }

  function send(line: Line) {
    if (qty.trim() === '') return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await recordReceipt({ supplierPoLineId: line.lineId, qty: qty.trim() }),
        )

        // The server's own answer, not a restatement of the request.
        const tail = result.closed
          ? 'The line is closed.'
          : `${result.outstandingQty} ${line.unit} still outstanding.`
        const over = !result.withinTolerance
          ? ` Over-received by ${result.overReceiptQty} ${line.unit}, past the ${tolerancePct}% allowance — finance has been told.`
          : ''

        setDone(`${line.itemCode} on ${line.poNumber}: ${tail}${over}`)
        setOpenId(null)
        setQty('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The receipt was not recorded.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {done ? <InlineAlert tone="success">{done}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {/* Below the confirmation, never instead of it. */}
      {lines.length === 0 ? (
        <EmptyState
          title="Nothing is outstanding"
          body="Every issued purchase order has been received in full. Lines that were short-closed are not shown here — that balance was deliberately written off, and re-offering it invites a second receipt against a settled account."
        />
      ) : null}

      {lines.map((line) => {
        const isOpen = openId === line.lineId
        const over = isOpen ? overBy(line) : 0
        const late = line.daysToDelivery !== null && line.daysToDelivery < 0

        return (
          <div key={line.lineId} style={surface}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 13, flexWrap: 'wrap' }}>
              <Ident size={13}>{line.poNumber}</Ident>
              <span style={{ font: "500 14.5px/1.3 var(--fx-font-sans)" }}>{line.itemName}</span>
              <Ident size={11}>{line.itemCode}</Ident>
              <span
                style={{
                  font: "400 13px/1.3 var(--fx-font-sans)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {line.supplierName}
              </span>

              {line.status === 'received_partial' ? <Badge tone="info">part received</Badge> : null}

              {late ? (
                <Badge tone="danger">
                  {Math.abs(line.daysToDelivery!)}{' '}
                  {Math.abs(line.daysToDelivery!) === 1 ? 'day' : 'days'} late
                </Badge>
              ) : line.expectedDeliveryDate === null ? (
                <Badge tone="warning">no date promised</Badge>
              ) : (
                <Badge tone="neutral">due {line.expectedDeliveryDate}</Badge>
              )}

              <span
                data-numeric
                style={{
                  marginLeft: 'auto',
                  font: "400 13px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-secondary)',
                }}
              >
                {line.receivedQty} of {line.orderedQty} {line.unit}
              </span>

              <button onClick={() => open(line)} style={linkButton}>
                {isOpen ? 'Cancel' : 'Receive'}
              </button>
            </div>

            {isOpen ? (
              <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                    <span style={labelStyle}>How much arrived ({line.unit})</span>
                    <input
                      value={qty}
                      onChange={(e) => setQty(e.target.value)}
                      inputMode="decimal"
                      placeholder="count it"
                      autoFocus
                      style={{ ...control, width: 160, textAlign: 'right' }}
                    />
                  </label>

                  {/* Offered, never pre-filled. A field that already holds the expected
                      number gets confirmed instead of read. */}
                  <Button variant="secondary" onClick={() => setQty(line.outstandingQty)}>
                    All {line.outstandingQty} outstanding
                  </Button>

                  <Button
                    variant="primary"
                    disabled={pending || qty.trim() === ''}
                    onClick={() => send(line)}
                  >
                    {pending ? 'Recording…' : 'Record it'}
                  </Button>
                </div>

                {over > 0 ? (
                  <InlineAlert tone="warning">
                    That is {over.toFixed(2)} {line.unit} more than was ordered. It will be
                    recorded — the goods are on the shelf, and a ledger that disagrees with the
                    store is worse than an over-receipt — and flagged against the{' '}
                    {tolerancePct}% allowance, with finance told if it exceeds it.
                  </InlineAlert>
                ) : null}

                <span
                  style={{
                    font: "400 12px/1.6 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {line.receivedQty} already received against {line.orderedQty} ordered ·{' '}
                  {line.outstandingQty} {line.unit} outstanding. Receiving the balance closes the
                  line, and a closed line is what scores this supplier on time.
                </span>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

const surface: React.CSSProperties = {
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
  borderRadius: 'var(--fx-radius-md)',
  padding: '13px 18px',
  minHeight: 'var(--fx-row-height)',
}

const labelStyle: React.CSSProperties = {
  font: "500 11px/1.3 var(--fx-font-mono)",
  textTransform: 'uppercase',
  letterSpacing: '.06em',
  color: 'var(--fx-text-tertiary)',
}

const control: React.CSSProperties = {
  minWidth: 0,
  padding: '9px 11px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-canvas)',
  color: 'var(--fx-text-primary)',
  font: "400 14px/1.4 var(--fx-font-mono)",
}

const linkButton: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: "400 13px/1.4 var(--fx-font-sans)",
  color: 'var(--fx-text-tertiary)',
  textDecoration: 'underline',
  cursor: 'pointer',
}
