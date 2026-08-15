'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { ReadIntoForm, ReadMark, type ReadFields } from '@/components/shell/read-into-form'
import { actionErrorMessage } from '@/lib/action-error'
import { matchItem } from '@/lib/match-item'
import { recordQuote } from '@/modules/procurement/actions'
import { unwrap } from '@/lib/action-failure'

/**
 * What a supplier came back with (found by auditing every input dialog in the app).
 *
 * `recordSupplierQuote` has existed since 5.5 — service, commit handler, the landed-cost
 * comparison that ranks quotes on freight and duty rather than on the sticker price. It was
 * reachable from exactly one place: the approve inbox, committing a draft that nothing could
 * raise, because there was no intake kind for a proforma either.
 *
 * So a procurement officer with three proformas on their desk could record none of them, and
 * `compareQuotesForItem` — the whole reason this module weighs anything — had nothing to
 * compare. The screen was the missing half of a feature that was otherwise finished.
 *
 * ## Landed cost, not the number in bold
 *
 * The dialog asks for freight and duty per line because that is what separates two quotes
 * that look identical. A CFR price includes the shipping and an FOB one does not; a mill
 * quoting three cents less and shipping EXW is more expensive. The proforma states this in
 * prose ("PRICE TERM: CFR CHATTOGRAM") and the reading pulls it out, but the figures stay
 * the buyer's to enter — a model guessing at duty would be guessing at a customs schedule.
 */

export interface QuoteRequisition {
  id: string
  prNo: string
  neededBy: string | null
}

export interface QuoteSupplier {
  id: string
  name: string
  origin: string
}

export interface QuoteItem {
  id: string
  code: string
  name: string
  uom: string
}

interface LineDraft {
  key: string
  itemId: string
  unitPrice: string
  leadTimeDays: string
  moq: string
  freight: string
  dutyPct: string
  /** What the proforma called it, kept so an unmatched line can say so. */
  readAs?: string
}

const blankLine = (n: number): LineDraft => ({
  key: `line-${n}`,
  itemId: '',
  unitPrice: '',
  leadTimeDays: '',
  moq: '',
  freight: '',
  dutyPct: '',
})

export function NewQuoteButton({
  requisitions,
  suppliers,
  items,
}: {
  requisitions: readonly QuoteRequisition[]
  suppliers: readonly QuoteSupplier[]
  items: readonly QuoteItem[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [readNote, setReadNote] = useState<string | null>(null)

  const [prId, setPrId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [currency, setCurrency] = useState('USD')
  const [quotedOn, setQuotedOn] = useState('')
  const [validUntil, setValidUntil] = useState('')
  const [priceTerm, setPriceTerm] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([blankLine(0)])
  /**
   * The proforma the reading came from, kept so it travels with the quote.
   *
   * The document is already uploaded by the time the fields are filled — reading it required
   * that. Dropping its id here is what left an approver with figures and no paper to check
   * them against, which is the whole justification for letting a model read it at all.
   */
  const [documentId, setDocumentId] = useState<string | null>(null)
  /** Per-field confidence from the reading, so each filled box can say how sure it was. */
  const [confidence, setConfidence] = useState<Record<string, number | null>>({})

  const filled = lines.filter((l) => l.itemId && l.unitPrice.trim())
  const ready = prId !== '' && supplierId !== '' && quotedOn !== '' && filled.length > 0

  const setLine = (key: string, patch: Partial<LineDraft>) =>
    setLines((rows) => rows.map((row) => (row.key === key ? { ...row, ...patch } : row)))

  /**
   * The proforma, into the lines.
   *
   * The requisition and the supplier stay with the person: a proforma names the mill in its
   * letterhead and the factory in the "TO:" block, and which supplier record that is remains
   * a judgement — the same reason a credit's buyer is picked rather than read.
   */
  function fill(read: ReadFields) {
    const v = read.values
    const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))

    setDocumentId(read.document.documentId)
    setConfidence(read.confidence)

    if (v.currency !== undefined) setCurrency(str(v.currency))
    if (v.quotedOn !== undefined) setQuotedOn(str(v.quotedOn))
    if (v.validUntil !== undefined) setValidUntil(str(v.validUntil))
    if (v.priceTerm !== undefined) setPriceTerm(str(v.priceTerm))

    const read_lines = Array.isArray(v.lines) ? (v.lines as Record<string, unknown>[]) : []
    if (read_lines.length === 0) return

    const unmatched: string[] = []
    setLines(
      read_lines.map((line, i) => {
        const match = matchItem(items, str(line.itemCode), str(line.itemName))
        if (!match) unmatched.push(str(line.itemName))
        return {
          key: `read-${i}`,
          itemId: match?.id ?? '',
          unitPrice: str(line.unitPrice),
          leadTimeDays: str(line.leadTimeDays),
          moq: str(line.moq),
          freight: str(line.freight),
          dutyPct: str(line.dutyPct),
          readAs: str(line.itemName),
        }
      }),
    )

    const notes: string[] = []
    if (unmatched.length > 0) {
      notes.push(
        `Not on the item list: ${unmatched.slice(0, 2).map((n) => `“${n}”`).join(', ')}${
          unmatched.length > 2 ? ` and ${unmatched.length - 2} more` : ''
        }. Pick the item on each line, or add it in factory setup first.`,
      )
    }
    if (v.priceTerm) {
      notes.push(
        `Priced ${str(v.priceTerm)} — check whether freight is already in the price before comparing this against another quote.`,
      )
    }
    setReadNote(notes.length > 0 ? notes.join(' ') : null)
  }

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        unwrap(
          await recordQuote({
          purchaseRequisitionId: prId,
          supplierId,
          currency: currency.trim().toUpperCase(),
          quotedOn,
          // The validity window and the paper itself, both of which the screen already had
          // and neither of which it used to send. An expired proforma that looks current is
          // a price somebody quotes back to a mill that has moved on.
          ...(validUntil ? { validUntil } : {}),
          ...(documentId ? { documentId } : {}),
          lines: filled.map((line) => ({
            itemId: line.itemId,
            unitPrice: line.unitPrice.trim(),
            // eslint-disable-next-line fabricxai/no-float-money -- days, not money
            leadTimeDays: Number.parseInt(line.leadTimeDays, 10) || 0,
            ...(line.moq.trim() ? { moq: line.moq.trim() } : {}),
            ...(line.freight.trim() ? { freight: line.freight.trim() } : {}),
            ...(line.dutyPct.trim() ? { dutyPct: line.dutyPct.trim() } : {}),
          })),
          }),
        )
        setOpen(false)
        setReadNote(null)
        setDocumentId(null)
        setConfidence({})
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The quote was not recorded.'))
      }
    })
  }

  if (requisitions.length === 0) return null

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Record a quote
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          setReadNote(null)
          setDocumentId(null)
          setConfidence({})
        }}
        width={760}
        title="Record a supplier quote"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <ReadIntoForm
            kindId="supplier_proforma"
            prompt="the proforma or quotation"
            onFilled={fill}
          />
          {readNote ? <InlineAlert tone="warning">{readNote}</InlineAlert> : null}

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <Field label="Against which requisition">
              <select value={prId} onChange={(e) => setPrId(e.target.value)} style={BOX}>
                <option value="">Choose the requisition</option>
                {requisitions.map((pr) => (
                  <option key={pr.id} value={pr.id}>
                    {pr.prNo}
                    {pr.neededBy ? ` · needed ${pr.neededBy}` : ''}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Who quoted">
              <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)} style={BOX}>
                <option value="">Choose the supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.origin}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 110px 1fr', gap: 12 }}>
            <Field label="Quoted on" read={confidence.quotedOn}>
              <DateInput value={quotedOn} onChange={setQuotedOn} style={BOX} />
            </Field>
            <Field label="Valid until" read={confidence.validUntil}>
              <DateInput value={validUntil} onChange={setValidUntil} style={BOX} />
            </Field>
            <TextInput
              label="Currency"
              mono
              value={currency}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())}
              {...(confidence.currency !== undefined
                ? { hint: <ReadMark confidence={confidence.currency} /> }
                : {})}
            />
            <TextInput
              label="Price term"
              mono
              value={priceTerm}
              onChange={(e) => setPriceTerm(e.target.value.toUpperCase())}
              hint={
                confidence.priceTerm !== undefined ? (
                  <ReadMark confidence={confidence.priceTerm} />
                ) : (
                  'CFR, FOB, EXW'
                )
              }
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>What they quoted</span>
            <p style={{ margin: 0, font: "400 12.5px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
              Freight and duty are what make two quotes comparable — a cheaper mill shipping
              EXW is not cheaper. Left blank they count as nothing stated, never as zero.
            </p>

            {lines.map((line) => (
              <div key={line.key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {line.readAs && !line.itemId ? (
                  <span style={{ font: "400 12px/1.4 var(--fx-font-sans)", color: 'var(--fx-warning)' }}>
                    read as “{line.readAs}” — pick the item
                  </span>
                ) : null}
                <div
                  className="fx-stack-tablet"
                  style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 90px 90px 90px 80px', gap: 8 }}
                >
                  <select
                    value={line.itemId}
                    onChange={(e) => setLine(line.key, { itemId: e.target.value })}
                    style={BOX}
                  >
                    <option value="">Choose the item</option>
                    {items.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.code} · {item.name}
                      </option>
                    ))}
                  </select>
                  <TextInput
                    label="Unit price"
                    mono
                    inputMode="decimal"
                    value={line.unitPrice}
                    onChange={(e) => setLine(line.key, { unitPrice: e.target.value })}
                  />
                  <TextInput
                    label="Lead days"
                    mono
                    inputMode="numeric"
                    value={line.leadTimeDays}
                    onChange={(e) => setLine(line.key, { leadTimeDays: e.target.value })}
                  />
                  <TextInput
                    label="MOQ"
                    mono
                    inputMode="decimal"
                    value={line.moq}
                    onChange={(e) => setLine(line.key, { moq: e.target.value })}
                  />
                  <TextInput
                    label="Freight"
                    mono
                    inputMode="decimal"
                    value={line.freight}
                    onChange={(e) => setLine(line.key, { freight: e.target.value })}
                  />
                  <TextInput
                    label="Duty %"
                    mono
                    inputMode="decimal"
                    value={line.dutyPct}
                    onChange={(e) => setLine(line.key, { dutyPct: e.target.value })}
                  />
                </div>
              </div>
            ))}

            <div>
              <Button
                variant="ghost"
                onClick={() => setLines((rows) => [...rows, blankLine(rows.length)])}
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
              {pending ? 'Recording…' : 'Record the quote'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const BOX: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  width: '100%',
}

function Field({
  label,
  children,
  read,
}: {
  label: string
  children: React.ReactNode
  /** How sure the reading was of this field. Absent for anything a person typed. */
  read?: number | null
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{label}</span>
      {children}
      {read !== undefined ? <ReadMark confidence={read} /> : null}
    </label>
  )
}
