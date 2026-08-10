'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { raiseSampleRequest } from '@/modules/sampling/actions'

interface OrderChoice {
  id: string
  label: string
  styleCode: string | null
}

const TYPES = ['pp', 'proto', 'fit', 'sms', 'top', 'shipment'] as const

/**
 * Raising a sample, from the room that makes them (live-test finding, Phase 5).
 *
 * `raiseSampleRequest` had an action and no screen, and no MARBIM tool drafts a request
 * either — so the record the PP gate looks up BY could not be created from the product,
 * and every cutting card in the building was locked behind a chain whose first link had
 * no origin. PP leads the type list because it is the one the gate reads.
 */
export function NewSampleButton({ orders }: { orders: readonly OrderChoice[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [type, setType] = useState<(typeof TYPES)[number]>('pp')
  const [orderId, setOrderId] = useState('')
  const [styleCode, setStyleCode] = useState('')
  const [requestNo, setRequestNo] = useState('')
  const [dueDate, setDueDate] = useState('')

  const ready = requestNo.trim() !== '' && styleCode.trim() !== '' && orderId !== ''

  function pickOrder(id: string) {
    setOrderId(id)
    // The code FOLLOWS the order — the PP gate looks the sample up by order + style
    // code, so a stale code from a previously-picked order is a sample that never opens
    // its gate. A hand edit after picking still sticks; switching orders resets it.
    const order = orders.find((option) => option.id === id)
    if (order?.styleCode) setStyleCode(order.styleCode)
  }

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await raiseSampleRequest({
            orderId,
            type,
            styleCode: styleCode.trim(),
            requestNo: requestNo.trim(),
            ...(dueDate ? { dueDate } : {}),
          }),
        )
        setOpen(false)
        router.push(`/sampling/${result.sampleRequestId}`)
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The sample was not raised.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        New sample
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Raise a sample request">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>What kind</span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
              style={control}
            >
              {TYPES.map((option) => (
                <option key={option} value={option}>
                  {option === 'pp' ? 'PP — pre-production (the one cutting waits on)' : option}
                </option>
              ))}
            </select>
          </label>

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
            <span
              style={{ font: "400 12.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
            >
              The PP gate looks the sample up by order and style code — a PP sample for an
              order that does not exist is refused outright.
            </span>
          </label>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}
          >
            <TextInput
              label="Style code"
              mono
              value={styleCode}
              onChange={(e) => setStyleCode(e.target.value)}
            />
            <TextInput
              label="Request no"
              mono
              placeholder="SMP-2044-PP"
              value={requestNo}
              onChange={(e) => setRequestNo(e.target.value)}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Due</span>
              <DateInput
                value={dueDate}
                onChange={setDueDate}
                style={control}
              />
            </label>
          </div>

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
