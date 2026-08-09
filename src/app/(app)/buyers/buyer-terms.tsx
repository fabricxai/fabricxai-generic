'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { factoryToday } from '@/lib/dates'
import { setBuyerTerms } from '@/modules/buyers/actions'

/**
 * Putting a buyer's terms on file (live-test finding, Phase 7).
 *
 * The versioned rows the AQL gate and the LC tolerance band read had no origin: the
 * final-inspection desk refused every lot with "no terms on file", and there was nowhere
 * to put terms ON file. Each save is a NEW version from its valid-from date — an order
 * taken in January is judged by January's terms whatever changes later.
 */
export function BuyerTermsButton({
  buyers,
}: {
  buyers: readonly { id: string; name: string }[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  const [buyerId, setBuyerId] = useState('')
  const [validFrom, setValidFrom] = useState(factoryToday())
  const [payment, setPayment] = useState<'lc' | 'tt' | 'dp'>('lc')
  const [incoterm, setIncoterm] = useState('FOB')
  const [tolerancePct, setTolerancePct] = useState('3')
  const [aqlLevel, setAqlLevel] = useState('2.5')
  const [minorAqlLevel, setMinorAqlLevel] = useState('4.0')

  const ready =
    buyerId !== '' &&
    validFrom !== '' &&
    incoterm.trim() !== '' &&
    tolerancePct.trim() !== '' &&
    aqlLevel.trim() !== ''

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await setBuyerTerms({
            buyerId,
            validFrom,
            payment,
            incoterm: incoterm.trim(),
            tolerancePct: tolerancePct.trim(),
            aqlLevel: aqlLevel.trim(),
            ...(minorAqlLevel.trim() ? { minorAqlLevel: minorAqlLevel.trim() } : {}),
          }),
        )
        setNoted(
          `Terms v${result.version} on file for ${buyers.find((b) => b.id === buyerId)?.name ?? 'the buyer'}.`,
        )
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The terms were not recorded.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Buyer terms
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Put a buyer's terms on file">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 160px', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Buyer</span>
              <select value={buyerId} onChange={(e) => setBuyerId(e.target.value)} style={control}>
                <option value="">Choose the buyer</option>
                {buyers.map((buyer) => (
                  <option key={buyer.id} value={buyer.id}>
                    {buyer.name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Valid from</span>
              <input
                type="date"
                value={validFrom}
                onChange={(e) => setValidFrom(e.target.value)}
                style={control}
              />
            </label>
          </div>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Payment</span>
              <select
                value={payment}
                onChange={(e) => setPayment(e.target.value as 'lc' | 'tt' | 'dp')}
                style={control}
              >
                <option value="lc">LC — letter of credit</option>
                <option value="tt">TT — telegraphic transfer</option>
                <option value="dp">DP — documents against payment</option>
              </select>
            </label>
            <TextInput
              label="Incoterm"
              mono
              value={incoterm}
              onChange={(e) => setIncoterm(e.target.value)}
            />
            <TextInput
              label="Ship tolerance %"
              mono
              inputMode="decimal"
              value={tolerancePct}
              onChange={(e) => setTolerancePct(e.target.value)}
            />
          </div>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <TextInput
              label="AQL major"
              mono
              inputMode="decimal"
              value={aqlLevel}
              onChange={(e) => setAqlLevel(e.target.value)}
            />
            <TextInput
              label="AQL minor"
              mono
              inputMode="decimal"
              value={minorAqlLevel}
              onChange={(e) => setMinorAqlLevel(e.target.value)}
            />
          </div>

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            The final-inspection desk samples at these AQL levels and the shipment desk holds
            quantities to this tolerance. Each save is a new version from its date — what
            governed an order on the day it was taken never moves.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Done
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Put it on file
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
