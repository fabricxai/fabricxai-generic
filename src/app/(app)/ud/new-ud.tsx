'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { ReadIntoForm, ReadMark, type ReadFields } from '@/components/shell/read-into-form'
import { DateInput, TextInput } from '@/components/fx/forms'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { createUd } from '@/modules/commercial/actions'

interface Item {
  itemRef: string
  qty: string
  unit: string
}

/**
 * Recording a customs Utilization Declaration (plan 5.5).
 *
 * `createUd` has existed since 2.2 with no action and no screen, and the consequence is
 * sharper than the LC's: the UD balance gate **fails closed**, so with no declaration on
 * record no bonded fabric can be issued at all. A factory running duty-free cloth — which is
 * most of them — would find the store refusing every issue against a gate it had no way to
 * satisfy from the product.
 *
 * ## The authorised items ARE the declaration
 *
 * Not metadata on it. Every bonded issue in the factory is checked against these quantities,
 * so the zod refuses an empty list rather than storing a shell somebody fills in later — a
 * UD recorded wrong is a gate calibrated wrong, and the exposure is legal rather than
 * commercial.
 *
 * ## The unit is free text, deliberately
 *
 * Declarations use whatever the customs office wrote — YDS, YD, MTR. Normalising it here
 * would silently equate two units, and the gate refuses to convert between them precisely so
 * that never matters. What it must not do is quietly decide they are the same.
 */
export function NewUdButton() {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [number, setNumber] = useState('')
  const [issueDate, setIssueDate] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [items, setItems] = useState<Item[]>([{ itemRef: '', qty: '', unit: '' }])
  const [readAs, setReadAs] = useState<Record<string, number | null>>({})

  /**
   * What the customs declaration said, into the boxes.
   *
   * The authorised items come back as a list and replace the blank row rather than appending
   * to it — a UD naming three materials should produce three rows, not three plus an empty
   * one somebody has to notice and delete.
   *
   * `itemRef` is left exactly as the paper words it. The gate matches a store issue against
   * this text, and tidying "12oz stretch denim" into a house code here is how a reconciliation
   * stops balancing.
   */
  function fill(read: ReadFields) {
    const v = read.values
    const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))
    if (v.number !== undefined) setNumber(str(v.number))
    if (v.issueDate !== undefined) setIssueDate(str(v.issueDate))
    if (v.validUntil !== undefined) setValidUntil(str(v.validUntil))

    const read_items = Array.isArray(v.authorizedItems) ? (v.authorizedItems as Record<string, unknown>[]) : []
    if (read_items.length > 0) {
      setItems(
        read_items.map((row) => ({
          itemRef: str(row.itemRef),
          qty: str(row.qty),
          unit: str(row.unit),
        })),
      )
    }
    setReadAs(read.confidence)
  }

  const filled = items.filter(
    (i) => i.itemRef.trim() !== '' && i.qty.trim() !== '' && i.unit.trim() !== '',
  )
  const ready = number.trim() !== '' && filled.length > 0

  function setItem(index: number, patch: Partial<Item>) {
    setItems((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = await createUd({
          number: number.trim(),
          ...(issueDate ? { issueDate } : {}),
          ...(validUntil ? { validUntil } : {}),
          authorizedItems: filled.map((i) => ({
            itemRef: i.itemRef.trim(),
            qty: i.qty.trim(),
            unit: i.unit.trim(),
          })),
        })

        setOpen(false)
        router.push(`/ud/${result.udId}`)
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.ud.create_failed'), locale))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        {t('ui.ud.new_ud')}
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title={t('ui.ud.new_ud')}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ReadIntoForm
            kindId="ud_scan"
            prompt="the customs declaration"
            onFilled={fill}
          />

          <TextInput
            label={t('ui.ud.number')}
            hint={readAs.number !== undefined ? <ReadMark confidence={readAs.number} /> : t('ui.ud.number_hint')}
            mono
            required
            value={number}
            onChange={(e) => setNumber(e.target.value)}
          />

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{t('ui.ud.issue_date')}</span>
              <DateInput
                value={issueDate}
                onChange={setIssueDate}
                style={fieldStyle}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{t('ui.ud.valid_until')}</span>
              <DateInput
                value={validUntil}
                onChange={setValidUntil}
                style={fieldStyle}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
              {t('ui.ud.authorized_items')}
            </span>
            <span style={{ font: "400 12.5px/1.45 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
              {t('ui.ud.items_hint')}
            </span>

            {items.map((item, index) => (
              <div
                key={index}
                className="fx-stack-tablet"
                style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 130px 110px', gap: 10 }}
              >
                <TextInput
                  label=""
                  placeholder={t('ui.ud.item_ref')}
                  mono
                  value={item.itemRef}
                  onChange={(e) => setItem(index, { itemRef: e.target.value })}
                />
                <TextInput
                  label=""
                  placeholder={t('ui.ud.qty')}
                  mono
                  inputMode="decimal"
                  value={item.qty}
                  onChange={(e) => setItem(index, { qty: e.target.value })}
                />
                <TextInput
                  label=""
                  placeholder={t('ui.ud.unit')}
                  mono
                  value={item.unit}
                  onChange={(e) => setItem(index, { unit: e.target.value })}
                />
              </div>
            ))}

            <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setItems((rows) => [...rows, { itemRef: '', qty: '', unit: '' }])}
              >
                {t('ui.ud.add_item')}
              </Button>
            </div>
          </div>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t('ui.common.cancel')}
            </Button>
            <Button variant="primary" onClick={submit} disabled={pending || !ready}>
              {t('ui.ud.record_it')}
            </Button>
          </div>
        </div>
      </Modal>
    </>
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
