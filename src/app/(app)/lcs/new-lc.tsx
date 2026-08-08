'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { createLc } from '@/modules/commercial/actions'

/**
 * Recording a letter of credit (plan 5.5).
 *
 * `createLc` has existed since 2.1 with no action and no screen over it, so the credit that
 * every shipment date, every BTB ceiling and every bank presentation is checked against
 * could only arrive by seeding.
 *
 * ## The two dates
 *
 * Latest shipment is when the goods must be ON the vessel; expiry is when the documents must
 * be AT the bank. They are separate fields because a shipment can meet one and miss the
 * other and still go unpaid — and the `lcLatestShipment` gate reads the first of them before
 * it will let a departure be confirmed. Both are optional here because a credit is often
 * recorded from an advice that has not yet been amended, and refusing the record would leave
 * the factory with no credit at all rather than an incomplete one.
 *
 * ## Documents are a MAP, not a list
 *
 * 8.1 looks a required document up BY KIND when it assembles a presentation. A list would
 * make every lookup a scan and every typo silently absent — a bill of lading nobody asked
 * for is a presentation that comes back from the counter.
 */
const DOC_KINDS = [
  'commercial_invoice',
  'packing_list',
  'bl',
  'certificate_of_origin',
  'beneficiary_certificate',
  // A buyer's credit routinely calls for both (LC-4471 on the live tenant did): the
  // third-party inspection certificate, and the EXP form copy the bank requires before
  // any export proceeds move. The map accepts any kind — only this list was short.
  'inspection_certificate',
  'exp_form',
] as const

export function NewLcButton({ buyers }: { buyers: readonly { id: string; name: string }[] }) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [buyerId, setBuyerId] = useState('')
  const [number, setNumber] = useState('')
  const [value, setValue] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [tolerancePct, setTolerancePct] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [latestShipment, setLatestShipment] = useState('')
  const [expiry, setExpiry] = useState('')
  const [docs, setDocs] = useState<Record<string, boolean>>({})

  const ready = buyerId !== '' && number.trim() !== '' && value.trim() !== ''

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = await createLc({
          buyerId,
          number: number.trim(),
          value: value.trim(),
          currency,
          ...(tolerancePct.trim() ? { tolerancePct: tolerancePct.trim() } : {}),
          ...(issueDate ? { issueDate } : {}),
          ...(latestShipment ? { latestShipmentDate: latestShipment } : {}),
          ...(expiry ? { expiryDate: expiry } : {}),
          // Only the kinds actually ticked. An empty map is legal and means the checklist
          // gets built from whatever the shipment desk supplies instead.
          docsRequired: Object.fromEntries(Object.entries(docs).filter(([, on]) => on)),
        })

        setOpen(false)
        router.push(`/lcs/${result.lcId}`)
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.lcs.create_failed'), locale))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('ui.lcs.new_lc')}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t('ui.lcs.new_lc')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{t('ui.lcs.buyer')}</span>
            <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} style={fieldStyle}>
              <option value="">{t('ui.lcs.choose_buyer')}</option>
              {buyers.map((buyer) => (
                <option key={buyer.id} value={buyer.id}>
                  {buyer.name}
                </option>
              ))}
            </select>
            <span style={{ font: "400 12.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
              {t('ui.lcs.buyer_hint')}
            </span>
          </label>

          <TextInput
            label={t('ui.lcs.number')}
            mono
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 110px 110px', gap: 12 }}>
            <TextInput
              label={t('ui.lcs.value')}
              mono
              inputMode="decimal"
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
            <TextInput
              label={t('ui.lcs.currency')}
              mono
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
            />
            <TextInput
              label={t('ui.lcs.tolerance')}
              mono
              inputMode="decimal"
              value={tolerancePct}
              onChange={(e) => setTolerancePct(e.target.value)}
            />
          </div>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
            <DateField label={t('ui.lcs.issue_date')} value={issueDate} onChange={setIssueDate} />
            <DateField
              label={t('ui.lcs.latest_shipment')}
              value={latestShipment}
              onChange={setLatestShipment}
            />
            <DateField label={t('ui.lcs.expiry')} value={expiry} onChange={setExpiry} />
          </div>
          <span style={{ font: "400 12.5px/1.45 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            {t('ui.lcs.dates_hint')}
          </span>

          <fieldset style={{ border: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <legend style={{ font: "500 13px/1.3 var(--fx-font-sans)", padding: 0 }}>
              {t('ui.lcs.docs_required')}
            </legend>
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {DOC_KINDS.map((kind) => (
                <label
                  key={kind}
                  style={{ display: 'flex', alignItems: 'center', gap: 7, cursor: 'pointer' }}
                >
                  <input
                    type="checkbox"
                    checked={docs[kind] ?? false}
                    onChange={(e) => setDocs((d) => ({ ...d, [kind]: e.target.checked }))}
                    style={{ width: 17, height: 17, accentColor: 'var(--fx-text-primary)' }}
                  />
                  <span style={{ font: "400 13px/1.3 var(--fx-font-sans)" }}>
                    {t(`ui.lcs.doc_${kind}`)}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('ui.common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending || !ready}>
              {t('ui.lcs.record_it')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function DateField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (next: string) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{label}</span>
      <input
        type="date"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={fieldStyle}
      />
    </label>
  )
}

const fieldStyle: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-mono)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}
