'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { openShipment } from '@/modules/shipment/actions'

interface OrderChoice {
  id: string
  label: string
  plannedExFactory: string | null
  lcId: string | null
  lcNumber: string | null
}

/**
 * Opening a shipment against an order (live-test finding, Phase 7).
 *
 * `openShipment` sat on the unreachable list, so the board could only ever show shipments
 * somebody had seeded — and the whole packing → EXP → bank chain hangs off one. Partial
 * shipments are NUMBERED here rather than implied: an order that ships in two halves is
 * two records, and "which half is at the bank" is the question the number answers.
 */
export function NewShipmentButton({ orders }: { orders: readonly OrderChoice[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [orderId, setOrderId] = useState('')
  const [partialNo, setPartialNo] = useState('1')
  const [plannedExFactory, setPlannedExFactory] = useState('')
  const [forwarder, setForwarder] = useState('')
  const [mode, setMode] = useState<'sea' | 'air'>('sea')

  const order = orders.find((o) => o.id === orderId)
  const ready = orderId !== '' && plannedExFactory !== '' && Number(partialNo) > 0

  function pickOrder(id: string) {
    setOrderId(id)
    const picked = orders.find((o) => o.id === id)
    // The order's own ex-factory date is the shipment's planned date until somebody says
    // otherwise — retyping a date the order already states is how the two drift apart.
    if (picked?.plannedExFactory) setPlannedExFactory(picked.plannedExFactory)
  }

  function submit() {
    if (!ready || !order) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await openShipment({
            orderId,
            partialNo: Number(partialNo),
            plannedExFactory,
            // The credit the order is covered by, so the shipment's dates are checked
            // against the right one without anybody re-picking it.
            ...(order.lcId ? { lcId: order.lcId } : {}),
            ...(forwarder.trim() ? { forwarder: forwarder.trim() } : {}),
            mode,
          }),
        )
        setOpen(false)
        router.refresh()
        void result
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The shipment was not opened.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Open a shipment
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Open a shipment">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Order</span>
            <select value={orderId} onChange={(e) => pickOrder(e.target.value)} style={control}>
              <option value="">Choose the order</option>
              {orders.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            {order ? (
              <span
                style={{ font: "400 12.5px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
              >
                {order.lcNumber
                  ? `covered by ${order.lcNumber} — its latest-shipment date is what this is checked against`
                  : 'no credit covers this order yet, so no date check can be made'}
              </span>
            ) : null}
          </label>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '110px 1fr 1fr', gap: 12 }}
          >
            <TextInput
              label="Partial no"
              mono
              inputMode="numeric"
              value={partialNo}
              onChange={(e) => setPartialNo(e.target.value)}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Planned ex-factory</span>
              <DateInput
                value={plannedExFactory}
                onChange={setPlannedExFactory}
                style={control}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>How it travels</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'sea' | 'air')}
                style={control}
              >
                <option value="sea">Sea</option>
                <option value="air">Air</option>
              </select>
            </label>
          </div>

          <TextInput
            label="Forwarder"
            placeholder="DSV · Maersk · …"
            value={forwarder}
            onChange={(e) => setForwarder(e.target.value)}
          />

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            A partial shipment is numbered, never implied: an order leaving in two halves is
            two records, and the number is what tells the bank which half its documents
            belong to.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Open it
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const control: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}
