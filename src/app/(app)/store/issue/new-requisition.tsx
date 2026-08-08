'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { raiseMaterialRequisition } from '@/modules/store/actions'

interface OrderChoice {
  id: string
  label: string
  qty: number | null
}

interface ItemChoice {
  id: string
  code: string
  name: string
  uom: string
}

/**
 * Sizing an order's material need, by hand (live-test finding, Phase 4).
 *
 * The issue desk serves outstanding requisition lines, and nothing could create a
 * requisition — the same missing first link the procurement chain had. This is the
 * explicit-lines door: item, consumption per piece, the order's quantity, wastage. The
 * BOM-sized path (the one that should be preferred once a style's BOM names the store's
 * own item codes) goes through the same action.
 */
export function NewStoreRequisition({
  orders,
  items,
}: {
  orders: readonly OrderChoice[]
  items: readonly ItemChoice[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [orderId, setOrderId] = useState('')
  const [orderQty, setOrderQty] = useState('')
  const [itemId, setItemId] = useState('')
  const [consumption, setConsumption] = useState('')
  const [wastagePct, setWastagePct] = useState('0')

  const item = items.find((option) => option.id === itemId)
  const ready =
    orderId !== '' && itemId !== '' && Number(orderQty) > 0 && Number(consumption) > 0

  function pickOrder(id: string) {
    setOrderId(id)
    const order = orders.find((option) => option.id === id)
    if (order?.qty && orderQty === '') setOrderQty(String(order.qty))
  }

  function submit() {
    if (!ready || !item) return
    setFailure(null)

    startTransition(async () => {
      try {
        unwrap(
          await raiseMaterialRequisition({
            orderId,
            orderQty: Number(orderQty),
            wastagePct: wastagePct.trim() || '0',
            lines: [{ itemId: item.id, consumptionPerPiece: consumption.trim(), unit: item.uom }],
          }),
        )
        setOpen(false)
        setOrderId('')
        setOrderQty('')
        setItemId('')
        setConsumption('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The requisition was not raised.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Request material
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Request material for an order">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Order</span>
            <select value={orderId} onChange={(e) => pickOrder(e.target.value)} style={control}>
              <option value="">Choose the order</option>
              {orders.map((order) => (
                <option key={order.id} value={order.id}>
                  {order.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Item</span>
            <select value={itemId} onChange={(e) => setItemId(e.target.value)} style={control}>
              <option value="">Choose the item</option>
              {items.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.code} · {option.name}
                </option>
              ))}
            </select>
          </label>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}
          >
            <TextInput
              label="Order pieces"
              mono
              inputMode="numeric"
              value={orderQty}
              onChange={(e) => setOrderQty(e.target.value)}
            />
            <TextInput
              label={`Per piece${item ? ` (${item.uom})` : ''}`}
              mono
              inputMode="decimal"
              placeholder="1.9583"
              value={consumption}
              onChange={(e) => setConsumption(e.target.value)}
            />
            <TextInput
              label="Wastage %"
              mono
              inputMode="decimal"
              value={wastagePct}
              onChange={(e) => setWastagePct(e.target.value)}
            />
          </div>

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            The need is computed as pieces × per-piece × (1 + wastage). When the style has a
            BOM whose lines name the store&rsquo;s items, prefer sizing from it — the
            requisition then carries the very numbers the order was priced on.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Raise it
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
