'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Toast } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { updateStyleDetails } from '@/modules/orders/actions'

/**
 * Filling in the style's own identity (design canvas, "Style & documents").
 *
 * The dossier is read from four modules and only one panel on it belongs to this one —
 * season, pattern, packing. So this is the only editable thing on the tab, and it is
 * hidden behind a disclosure: a merchandiser opens the papers to READ them fifty times
 * for every once they correct a field, and a form sitting open changes what the page is
 * for.
 *
 * Blank fields are omitted rather than sent as empty strings. The service leaves absent
 * keys alone, so somebody typing the pattern number does not blank the season beside it —
 * which is what a naive "post the whole form" would do to four fields they never touched.
 */
const FIELDS = [
  { key: 'season', label: 'Season', hint: 'AW-26' },
  { key: 'customerLabel', label: 'Buyer’s label', hint: 'how the buyer names it' },
  { key: 'patternNo', label: 'Pattern no', hint: 'PTN-4471' },
  { key: 'basedOnStyle', label: 'Based on', hint: 'the style it was cut from' },
  { key: 'packingMethod', label: 'Packing', hint: 'flat pack, hanger, poly bag' },
] as const

type FieldKey = (typeof FIELDS)[number]['key']

export function StyleDetailsForm({
  orderStyleId,
  current,
}: {
  orderStyleId: string
  current: Record<FieldKey, string | null>
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [values, setValues] = useState<Record<FieldKey, string>>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, current[f.key] ?? ''])) as Record<
      FieldKey,
      string
    >,
  )

  function save() {
    setFailure(null)
    startTransition(async () => {
      const changed: Record<string, string> = {}
      for (const field of FIELDS) {
        const value = values[field.key].trim()
        if (value && value !== (current[field.key] ?? '')) changed[field.key] = value
      }

      if (Object.keys(changed).length === 0) {
        setOpen(false)
        return
      }

      try {
        unwrap(await updateStyleDetails({ orderStyleId, ...changed }))
        setOpen(false)
        setToast('Style details saved.')
        setTimeout(() => setToast(null), 5200)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The style details could not be saved.'))
      }
    })
  }

  if (!open) {
    return (
      <>
        <div style={{ marginTop: 14 }}>
          <Button variant="ghost" onClick={() => setOpen(true)}>
            Fill in style details
          </Button>
        </div>
        {toast ? <Toast message={toast} /> : null}
      </>
    )
  }

  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 14,
        }}
      >
        {FIELDS.map((field) => (
          <TextInput
            key={field.key}
            label={field.label}
            hint={field.hint}
            value={values[field.key]}
            onChange={(event) =>
              setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
            }
          />
        ))}
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Button onClick={save} disabled={pending}>
          {pending ? 'Saving…' : 'Save details'}
        </Button>
        <Button variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
