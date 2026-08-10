'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { createOrder } from '@/modules/orders/actions'

/**
 * Opening an order from the desk (plan 5.1, audit FE-B2).
 *
 * `createOrder` has existed since 1.3 and was reachable from exactly two places: the
 * `rfq.won` consumer, and the approve inbox committing a PO somebody had uploaded. Both
 * are real paths and neither is available when a merchandiser is holding a purchase order
 * that MARBIM cannot read — which, with no provider registered, is every purchase order.
 *
 * ## The style is not optional
 *
 * `createOrder` refuses an empty style list, so this form asks for one rather than opening a
 * shell to be filled in later. An order with no style is an order nothing can be cut, costed
 * or planned against, and it would sit in the book looking like work.
 *
 * ## What is deliberately not here
 *
 * The breakdown and the TNA. A colour × size grid is entered against a style that exists,
 * and a schedule is generated from a template against a ship date — both are the order
 * detail screen's job, and asking for fifteen cells in a create dialog is how somebody
 * abandons it halfway and creates nothing.
 */
export function NewOrderButton({
  buyers,
}: {
  buyers: readonly { id: string; name: string }[]
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [buyerId, setBuyerId] = useState('')
  const [poNumber, setPoNumber] = useState('')
  const [exFactory, setExFactory] = useState('')
  const [styleCode, setStyleCode] = useState('')
  const [contractedQty, setContractedQty] = useState('')
  const [unitPrice, setUnitPrice] = useState('')

  // eslint-disable-next-line fabricxai/no-float-money -- pieces, not money; a blank or a typo falls to 0 and fails `required` below
  const qty = Number.parseInt(contractedQty, 10) || 0
  const ready = buyerId !== '' && poNumber.trim() !== '' && styleCode.trim() !== ''

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const { orderId } = await createOrder({
          order: {
            buyerId,
            poNumbers: [poNumber.trim()],
            ...(exFactory ? { plannedExFactoryDate: exFactory } : {}),
          },
          styles: [
            {
              styleCode: styleCode.trim(),
              ...(qty > 0 ? { contractedQty: qty } : {}),
              // Sent as typed. The service parses it as a money string and refuses a
              // malformed one — parsing it here would round somebody's price on the way in.
              ...(unitPrice.trim() ? { unitPrice: unitPrice.trim() } : {}),
            },
          ],
        })

        setOpen(false)
        // Straight to the order, because the next two things — the grid and the schedule —
        // are both there and neither exists yet.
        router.push(`/orders/${orderId}`)
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.orders.create_failed'), locale))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('ui.orders.new_order')}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t('ui.orders.new_order')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
              {t('ui.orders.buyer')}
            </span>
            <select
              value={buyerId}
              onChange={(e) => setBuyerId(e.target.value)}
              style={{
                font: "400 15px/1.2 var(--fx-font-sans)",
                padding: '10px 12px',
                minHeight: 'var(--fx-tap-min)',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-md)',
                background: 'var(--fx-bg-surface)',
                color: 'var(--fx-text-primary)',
              }}
            >
              <option value="">{t('ui.orders.choose_buyer')}</option>
              {buyers.map((buyer) => (
                <option key={buyer.id} value={buyer.id}>
                  {buyer.name}
                </option>
              ))}
            </select>
            {buyers.length === 0 ? (
              // Said here rather than left as an empty dropdown: the reason nothing can be
              // chosen is that nothing exists, and the fix is on another screen.
              <span
                style={{ font: "400 12.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
              >
                {t('ui.orders.no_buyers')}
              </span>
            ) : null}
          </label>

          <TextInput
            label={t('ui.orders.po_number')}
            required
            value={poNumber}
            onChange={(e) => setPoNumber(e.target.value)}
          />

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
              {t('ui.orders.planned_ex_factory')}
            </span>
            <DateInput
              value={exFactory}
              onChange={setExFactory}
              style={{
                font: "400 15px/1.2 var(--fx-font-mono)",
                padding: '10px 12px',
                minHeight: 'var(--fx-tap-min)',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-md)',
                background: 'var(--fx-bg-surface)',
                color: 'var(--fx-text-primary)',
              }}
            />
          </label>

          <TextInput
            label={t('ui.orders.style_code')}
            required
            value={styleCode}
            onChange={(e) => setStyleCode(e.target.value)}
            hint={t('ui.orders.style_hint')}
          />

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <TextInput
              label={t('ui.orders.contracted_qty')}
              inputMode="numeric"
              value={contractedQty}
              onChange={(e) => setContractedQty(e.target.value)}
            />
            <TextInput
              label={t('ui.orders.unit_price')}
              inputMode="decimal"
              value={unitPrice}
              onChange={(e) => setUnitPrice(e.target.value)}
            />
          </div>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('ui.common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending || !ready}>
              {t('ui.orders.create_order')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
