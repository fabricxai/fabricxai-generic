'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { factoryToday } from '@/lib/dates'
import { raiseInvoice } from '@/modules/finance/actions'

interface ShipmentChoice {
  id: string
  orderId: string
  label: string
  /** `INV-<PO>-<partial>` — the convention the kit and the seed both follow. */
  suggestedNumber: string
}

/**
 * Raising an invoice (live-test finding, Phase 8 — the receivable chain had no first link).
 *
 * A draft for the approve inbox, not a write: the modal says so, because a finance clerk
 * who believes the invoice exists the moment they press the button stops chasing the
 * approval, and the receivable that was never born ages invisibly.
 */
export function RaiseInvoiceButton({ shipments }: { shipments: readonly ShipmentChoice[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  const [shipmentId, setShipmentId] = useState('')
  const [number, setNumber] = useState('')
  const [invoiceDate, setInvoiceDate] = useState(factoryToday())
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('USD')

  const shipment = shipments.find((s) => s.id === shipmentId)
  const ready = shipment !== undefined && number.trim() !== '' && value.trim() !== ''

  function pickShipment(id: string) {
    setShipmentId(id)
    const picked = shipments.find((s) => s.id === id)
    if (picked) setNumber(picked.suggestedNumber)
  }

  function submit() {
    if (!ready || !shipment) return
    setFailure(null)

    startTransition(async () => {
      try {
        unwrap(
          await raiseInvoice({
            orderId: shipment.orderId,
            shipmentId: shipment.id,
            number: number.trim(),
            invoiceDate,
            value: value.trim(),
            currency: currency.trim().toUpperCase(),
          }),
        )
        setNoted(
          `${number.trim()} is in the approve inbox. Nothing exists — no invoice, no receivable — until it is signed.`,
        )
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The invoice was not drafted.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Raise an invoice
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Raise an invoice">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Shipment</span>
            <select value={shipmentId} onChange={(e) => pickShipment(e.target.value)} style={control}>
              <option value="">Choose the shipment being invoiced</option>
              {shipments.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </label>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 150px', gap: 12 }}
          >
            <TextInput
              label="Invoice number"
              mono
              value={number}
              onChange={(e) => setNumber(e.target.value)}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Invoice date</span>
              <DateInput
                value={invoiceDate}
                onChange={setInvoiceDate}
                style={control}
              />
            </label>
          </div>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 12 }}
          >
            <TextInput
              label="Value — from the commercial invoice"
              mono
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <TextInput
              label="Currency"
              mono
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            />
          </div>

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            This drafts the invoice for the approve inbox. When it is signed, the invoice and
            its receivable are created together — the expected date comes from the
            buyer&rsquo;s own realization history, not from payment terms.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Done
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Send for approval
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
