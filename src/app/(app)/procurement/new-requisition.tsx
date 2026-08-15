'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { createPurchaseRequisition } from '@/modules/procurement/actions'
import { unwrap } from '@/lib/action-failure'

interface Item {
  id: string
  code: string
  name: string
  uom: string
}

interface DraftLine {
  itemId: string
  qty: string
}

/**
 * Raise a requisition by hand (live-test finding, Phase 4).
 *
 * `createPurchaseRequisition` had an action, a role gate and a zod that refuses an empty
 * line list — and no screen called it, so the procurement chain had no first link: the
 * requisition page compares quotes and issues POs against requisitions that could only
 * arrive by seeding. `purchase_requisitions` is even a registered pending target, and no
 * MARBIM tool drafts one either. This is the door.
 */
export function NewRequisitionButton({ items }: { items: readonly Item[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const [prNo, setPrNo] = useState('')
  const [neededBy, setNeededBy] = useState('')
  const [lines, setLines] = useState<DraftLine[]>([{ itemId: '', qty: '' }])

  const itemOf = (id: string) => items.find((item) => item.id === id)

  const complete = lines.filter((line) => line.itemId && Number(line.qty) > 0)
  const ready = prNo.trim() !== '' && neededBy !== '' && complete.length > 0

  function setLine(index: number, patch: Partial<DraftLine>) {
    setLines((rows) => rows.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await createPurchaseRequisition({
          prNo: prNo.trim(),
          neededBy,
          lines: complete.map((line) => ({
            itemId: line.itemId,
            qty: line.qty.trim(),
            // The unit is the ITEM's unit, not a choice: a requisition for yarn in yards
            // is a transcription error, not an option to offer.
            unit: itemOf(line.itemId)?.uom ?? 'pcs',
          })),
          }),
        )

        setOpen(false)
        setPrNo('')
        setNeededBy('')
        setLines([{ itemId: '', qty: '' }])
        router.push(`/procurement/${result.purchaseRequisitionId}`)
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The requisition was not raised.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        New requisition
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Raise a requisition">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <TextInput
            label="PR number"
            mono
            required
            placeholder="PR-1101"
            value={prNo}
            onChange={(e) => setPrNo(e.target.value)}
          />

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Needed by</span>
            <DateInput
              value={neededBy}
              onChange={setNeededBy}
              style={control}
            />
            <span
              style={{ font: "400 12.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}
            >
              The date the material must be IN the store — quotes whose lead time lands
              after it are refused as infeasible, not ranked last.
            </span>
          </label>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {lines.map((line, index) => {
              const item = itemOf(line.itemId)
              return (
                <div
                  key={index}
                  className="fx-stack-tablet"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 110px 60px auto',
                    gap: 10,
                    alignItems: 'center',
                  }}
                >
                  <select
                    value={line.itemId}
                    onChange={(e) => setLine(index, { itemId: e.target.value })}
                    style={control}
                  >
                    <option value="">Choose the item</option>
                    {items.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.code} · {option.name}
                      </option>
                    ))}
                  </select>
                  <TextInput
                    label=""
                    mono
                    inputMode="decimal"
                    placeholder="qty"
                    value={line.qty}
                    onChange={(e) => setLine(index, { qty: e.target.value })}
                  />
                  <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}>
                    {item?.uom ?? '—'}
                  </span>
                  <Button
                    variant="ghost"
                    onClick={() => setLines((rows) => rows.filter((_, i) => i !== index))}
                    disabled={lines.length === 1}
                  >
                    ×
                  </Button>
                </div>
              )
            })}
            <div>
              <Button
                variant="ghost"
                onClick={() => setLines((rows) => [...rows, { itemId: '', qty: '' }])}
              >
                ＋ add a line
              </Button>
            </div>
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
