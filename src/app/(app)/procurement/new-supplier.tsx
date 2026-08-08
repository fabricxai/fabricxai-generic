'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { createSupplier } from '@/modules/procurement/actions'

const TYPES = ['yarn', 'fabric_mill', 'trims', 'embellishment', 'subcontract'] as const
const ORIGINS = ['local', 'import'] as const

/**
 * Adding a supplier (plan 5.5).
 *
 * `createSupplier` has existed since 3.2 with no action over it, so the only route into the
 * supplier book was the approve inbox committing a MARBIM draft — and with no provider
 * registered that path does not run. A factory with no suppliers cannot record a quote,
 * compare one, or issue a purchase order: the whole module starts here.
 *
 * ## Origin is not a label
 *
 * Local and import are different purchases. An import PO needs BTB headroom before it may be
 * issued, and the fabric it brings in needs a UD before it can be issued to the floor — both
 * gates key off this field. Choosing it wrong does not show up until a purchase order is
 * refused, or worse, is not.
 */
export function NewSupplierButton() {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<(typeof TYPES)[number]>('fabric_mill')
  const [origin, setOrigin] = useState<(typeof ORIGINS)[number]>('local')
  const [paymentTerms, setPaymentTerms] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [contactName, setContactName] = useState('')
  const [contactEmail, setContactEmail] = useState('')

  const ready = code.trim() !== '' && name.trim() !== ''

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        await createSupplier({
          code: code.trim(),
          name: name.trim(),
          type,
          origin,
          ...(paymentTerms.trim() ? { paymentTerms: paymentTerms.trim() } : {}),
          defaultCurrency: currency.trim() || 'USD',
          // Only a contact that has a name. An email with nobody attached to it is a row
          // somebody has to guess at when a delivery is late.
          ...(contactName.trim()
            ? {
                contacts: [
                  {
                    name: contactName.trim(),
                    ...(contactEmail.trim() ? { email: contactEmail.trim() } : {}),
                  },
                ],
              }
            : {}),
        })

        setOpen(false)
        setCode('')
        setName('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.procurement.supplier_failed'), locale))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('ui.procurement.new_supplier')}
      </Button>

      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title={t('ui.procurement.new_supplier')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '140px minmax(0, 1fr)', gap: 12 }}>
            <TextInput
              label={t('ui.procurement.supplier_code')}
              mono
              required
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
            />
            <TextInput
              label={t('ui.procurement.supplier_name')}
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {t('ui.procurement.supplier_type')}
              </span>
              <select
                value={type}
                onChange={(e) => setType(e.target.value as (typeof TYPES)[number])}
                style={fieldStyle}
              >
                {TYPES.map((option) => (
                  <option key={option} value={option}>
                    {t(`ui.procurement.type_${option}`)}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {t('ui.procurement.origin')}
              </span>
              <select
                value={origin}
                onChange={(e) => setOrigin(e.target.value as (typeof ORIGINS)[number])}
                style={fieldStyle}
              >
                {ORIGINS.map((option) => (
                  <option key={option} value={option}>
                    {t(`ui.procurement.origin_${option}`)}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <span style={{ font: "400 12.5px/1.45 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            {t('ui.procurement.origin_hint')}
          </span>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 110px', gap: 12 }}>
            <TextInput
              label={t('ui.procurement.payment_terms')}
              value={paymentTerms}
              onChange={(e) => setPaymentTerms(e.target.value)}
            />
            <TextInput
              label={t('ui.procurement.default_currency')}
              mono
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
          </div>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <TextInput
              label={t('ui.procurement.contact_name')}
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
            <TextInput
              label={t('ui.procurement.contact_email')}
              type="email"
              value={contactEmail}
              onChange={(e) => setContactEmail(e.target.value)}
            />
          </div>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('ui.common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending || !ready}>
              {t('ui.procurement.add_supplier')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const fieldStyle: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}
