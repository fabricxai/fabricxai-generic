'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { DateInput, TextInput } from '@/components/fx/forms'
import { factoryToday } from '@/lib/dates'
import { issuePurchaseOrder, recordQuote } from '@/modules/procurement/actions'
import type { QuoteComparison } from '@/modules/procurement/procurement'
import { unwrap } from '@/lib/action-failure'

interface Supplier {
  id: string
  code: string
  name: string
  origin: string
  currency: string
}

interface Btb {
  id: string
  number: string
  value: string
  currency: string
  masterNumber: string
}

interface Line {
  itemId: string
  itemName: string
  qty: string
  unit: string
  comparison: QuoteComparison | null
  /** Why the comparison could not be computed, when it could not. */
  problem: string | null
}

/**
 * Choosing a supplier, and issuing the PO.
 *
 * **Cheapest is highlighted, never pre-selected.** The canvas is explicit about this and it
 * is worth honouring literally: the ranking knows landed cost, and nothing else. It does not
 * know that the mill two rows down has never sent a short roll, or that the cheapest one
 * disputed a claim last season. Pre-selecting would turn a judgement into a default, and
 * defaults are what people accept when they are busy.
 *
 * **Infeasible quotes are listed apart, greyed, unselectable.** A quote arriving after the
 * fabric is needed is not a worse option — ranking it last is how it eventually gets picked.
 */
export function RequisitionClient({
  prId,
  prNo,
  lines,
  rate,
  suppliers,
  btbs,
}: {
  prId: string
  prNo: string
  lines: readonly Line[]
  rate: string | null
  suppliers: readonly Supplier[]
  btbs: readonly Btb[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [chosen, setChosen] = useState<Record<string, string>>({})
  /*
   * No pre-selection, deliberately.
   *
   * This used to seed itself with `btbs[0]`, so a buyer who never opened the dropdown funded
   * an import PO from whatever credit happened to sort first — including one belonging to
   * another order entirely. An unchosen credit is an unanswered question, and the button
   * below stays disabled until it is answered.
   */
  const [btbId, setBtbId] = useState('')
  const [poNumber, setPoNumber] = useState(`PO-${prNo.replace(/^PR-/, '')}`)
  const [fxRate, setFxRate] = useState(rate ?? '0.0083')
  const [noted, setNoted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  // The quote being typed. Keyed by itemId; a line left fully blank is simply not quoted.
  const [quoteSupplierId, setQuoteSupplierId] = useState('')
  const [quotedOn, setQuotedOn] = useState(factoryToday())
  const [quoteLines, setQuoteLines] = useState<
    Record<string, { unitPrice: string; leadTimeDays: string; freight: string; dutyPct: string }>
  >({})

  const quotedEntries = lines.flatMap((line) => {
    const draft = quoteLines[line.itemId]
    return draft && draft.unitPrice.trim() !== '' && draft.leadTimeDays.trim() !== ''
      ? [{ line, draft }]
      : []
  })
  const quoteReady = quoteSupplierId !== '' && quotedOn !== '' && quotedEntries.length > 0

  function saveQuote() {
    if (!quoteReady) return
    setFailure(null)

    startTransition(async () => {
      try {
        unwrap(
          await recordQuote({
          purchaseRequisitionId: prId,
          supplierId: quoteSupplierId,
          currency: supplierOf(quoteSupplierId)?.currency ?? 'USD',
          quotedOn,
          lines: quotedEntries.map(({ line, draft }) => ({
            itemId: line.itemId,
            unitPrice: draft.unitPrice.trim(),
            leadTimeDays: Number(draft.leadTimeDays),
            ...(draft.freight.trim() ? { freight: draft.freight.trim() } : {}),
            ...(draft.dutyPct.trim() ? { dutyPct: draft.dutyPct.trim() } : {}),
          })),
          }),
        )
        setNoted(`Quote recorded for ${supplierOf(quoteSupplierId)?.name ?? 'the supplier'}.`)
        setQuoteLines({})
        setQuoteSupplierId('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The quote was not recorded.'))
      }
    })
  }

  const supplierOf = (id: string) => suppliers.find((s) => s.id === id) ?? null

  // Every line must be answered before a PO exists — a PO missing a line is a second PO
  // somebody has to remember to raise.
  const answered = lines.every((l) => chosen[l.itemId])
  const firstChoice = lines[0] ? chosen[lines[0].itemId] : undefined
  const supplier = firstChoice ? supplierOf(firstChoice) : null
  const needsBtb = supplier?.origin === 'import'

  function issue() {
    if (!supplier || !answered) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = unwrap(
          await issuePurchaseOrder({
          supplierId: supplier.id,
          purchaseRequisitionId: prId,
          poNumber: poNumber.trim(),
          currency: supplier.currency,
          ...(needsBtb && btbId ? { btbLcId: btbId } : {}),
          lines: lines.map((l) => {
            const ranked = l.comparison?.ranked.find(
              (r) => r.supplierId === chosen[l.itemId],
            )
            return {
              itemId: l.itemId,
              qty: ranked?.chargedQty ?? l.qty,
              unit: l.unit,
              // The quoted landed unit cost, not the headline price — it is what the
              // comparison ranked on and what the PO commits to.
              unitPrice: ranked?.landedUnitCost ?? '0.00',
            }
          }),
          }),
        )
        setNoted(
          `PO ${poNumber.trim()} issued — ${result.totalValue} ${result.currency} to ${supplier.name}.`,
        )
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The PO was not issued.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {/* ── Comparison per line ──────────────────────────────────────────── */}
      {lines.map((line) => (
        <section key={line.itemId}>
          <SectionHeading eyebrow={`${line.qty} ${line.unit} · ranked on landed cost`}>
            {line.itemName}
          </SectionHeading>

          {line.problem ? (
            <InlineAlert tone="warning">
              {line.problem} — quotes come in the currency each supplier works in, and a
              comparison across two of them is only a decision once somebody states the rate
              it was made at.
            </InlineAlert>
          ) : !line.comparison || line.comparison.ranked.length === 0 ? (
            <InlineAlert tone="info">
              No usable quote for this item yet. Record one before a PO can be raised.
            </InlineAlert>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {line.comparison.ranked.map((quote, index) => {
                const s = supplierOf(quote.supplierId)
                const picked = chosen[line.itemId] === quote.supplierId
                const cheapest = index === 0
                return (
                  <button
                    className="fx-stack-tablet"
                    key={quote.quoteId}
                    onClick={() =>
                      setChosen((c) => ({ ...c, [line.itemId]: quote.supplierId }))
                    }
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'minmax(0, 1fr) 130px 120px 130px 110px',
                      gap: 14,
                      alignItems: 'center',
                      textAlign: 'left',
                      padding: '13px 16px',
                      background: 'var(--fx-bg-surface)',
                      border: `1px solid ${picked ? 'var(--fx-text-primary)' : 'var(--fx-border-subtle)'}`,
                      // Highlighted, not chosen — see the file note.
                      borderLeft: cheapest ? '3px solid var(--fx-accent)' : undefined,
                      cursor: 'pointer',
                      color: 'var(--fx-text-primary)',
                    }}
                  >
                    <span style={{ minWidth: 0 }}>
                      <span style={{ font: "600 14px/1.2 var(--fx-font-sans)" }}>
                        {s?.name ?? quote.supplierId.slice(0, 8)}
                      </span>
                      <span
                        style={{
                          display: 'block',
                          marginTop: 3,
                          font: "400 11.5px/1.3 var(--fx-font-mono)",
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {s?.origin === 'import' ? 'import · needs a BTB' : 'local'} · arrives{' '}
                        {quote.arrivesOn}
                      </span>
                    </span>

                    <span style={cell}>
                      {quote.landedUnitCost} {quote.currency}
                      <span style={sub}>landed / {line.unit}</span>
                    </span>
                    <span style={cell}>
                      {/* An unstated duty is a hole in this ranking, not a zero. Saying
                          "not stated" is what stops the cheapest row reading as settled
                          when the row beneath it actually quoted its duty. */}
                      {quote.unstated.includes('duty') ? '—' : quote.dutyValue}
                      <span style={sub}>
                        {quote.unstated.includes('duty') ? 'duty not stated' : 'duty'}
                      </span>
                    </span>
                    <span style={cell}>
                      {quote.landedTotal}
                      <span style={sub}>
                        {quote.unstated.length > 0
                          ? `landed total, without ${quote.unstated.join(' or ')}`
                          : 'landed total'}
                      </span>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      {cheapest ? <Badge tone="warning">cheapest landed</Badge> : null}
                      {picked ? <Badge tone="success">chosen</Badge> : null}
                    </span>
                  </button>
                )
              })}

              {line.comparison.infeasible.length > 0 ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: '12px 16px',
                    border: '1px dashed var(--fx-border-default)',
                    background: 'transparent',
                  }}
                >
                  <div
                    style={{
                      font: "400 10.5px/1 var(--fx-font-mono)",
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: 'var(--fx-text-tertiary)',
                      marginBottom: 8,
                    }}
                  >
                    Cannot arrive in time
                  </div>
                  {line.comparison.infeasible.map((q) => (
                    <div
                      key={q.quoteId}
                      style={{
                        font: "400 12.5px/1.6 var(--fx-font-mono)",
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      arrives {q.arrivesOn} — after it is needed. Not ranked, because a list
                      that puts it last is a list somebody picks from the bottom.
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          )}
        </section>
      ))}

      {/* ── The rate the comparison was made at ──────────────────────────── */}
      <section>
        <SectionHeading eyebrow="stated, never fetched silently">
          Exchange rate · BDT to USD
        </SectionHeading>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '0 1 180px' }}>
            <span style={fieldLabel}>1 BDT in USD</span>
            <input
              inputMode="decimal"
              value={fxRate}
              onChange={(e) => setFxRate(e.target.value)}
              style={control}
            />
          </label>
          <Button
            variant="secondary"
            disabled={!fxRate.trim()}
            onClick={() => router.push(`/procurement/${prId}?rate=${encodeURIComponent(fxRate.trim())}`)}
          >
            Compare at this rate
          </Button>
          <span
            style={{
              font: "400 12px/1.6 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
              flex: '1 1 260px',
            }}
          >
            The rate travels with the comparison so the decision can be reconstructed later.
            A rate fetched at render time makes last month&rsquo;s choice unexplainable.
          </span>
        </div>
      </section>

      {/* ── Record a quote ───────────────────────────────────────────────────
        * The chain's missing middle link (live-test finding, Phase 4): the comparison
        * above ranks quotes and the section below issues a PO from the chosen one, and
        * NOTHING could enter a quote — `recordQuote` sat on the unreachable list, so a
        * requisition could be raised and never answered. Lead time is required per line:
        * a cheap quote arriving after the fabric is needed is not a cheaper quote.
        */}
      <section>
        <SectionHeading eyebrow="what a supplier answered — lead time is part of the price">
          Record a quote
        </SectionHeading>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 240px' }}>
              <span style={fieldLabel}>Supplier</span>
              <select
                value={quoteSupplierId}
                onChange={(e) => setQuoteSupplierId(e.target.value)}
                style={control}
              >
                <option value="">Choose the supplier</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.origin} · {s.currency}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '0 1 170px' }}>
              <span style={fieldLabel}>Quoted on</span>
              <DateInput
                value={quotedOn}
                onChange={setQuotedOn}
                style={control}
              />
            </label>
          </div>

          {lines.map((line) => {
            const draft = quoteLines[line.itemId] ?? { unitPrice: '', leadTimeDays: '', freight: '', dutyPct: '' }
            const patch = (next: Partial<typeof draft>) =>
              setQuoteLines((all) => ({ ...all, [line.itemId]: { ...draft, ...next } }))
            return (
              <div
                key={line.itemId}
                className="fx-stack-tablet"
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'minmax(0, 1fr) 110px 90px 100px 90px',
                  gap: 10,
                  alignItems: 'end',
                }}
              >
                <span style={{ font: "400 13px/1.4 var(--fx-font-sans)", alignSelf: 'center' }}>
                  {line.itemName}
                  <span style={{ color: 'var(--fx-text-tertiary)' }}> · {line.qty} {line.unit}</span>
                </span>
                <TextInput
                  label="Unit price"
                  mono
                  inputMode="decimal"
                  value={draft.unitPrice}
                  onChange={(e) => patch({ unitPrice: e.target.value })}
                />
                <TextInput
                  label="Lead days"
                  mono
                  inputMode="numeric"
                  value={draft.leadTimeDays}
                  onChange={(e) => patch({ leadTimeDays: e.target.value })}
                />
                <TextInput
                  label="Freight"
                  mono
                  inputMode="decimal"
                  value={draft.freight}
                  onChange={(e) => patch({ freight: e.target.value })}
                />
                <TextInput
                  label="Duty %"
                  mono
                  inputMode="decimal"
                  value={draft.dutyPct}
                  onChange={(e) => patch({ dutyPct: e.target.value })}
                />
              </div>
            )
          })}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button
              variant="secondary"
              disabled={pending || !quoteReady}
              onClick={saveQuote}
            >
              Record the quote
            </Button>
          </div>
        </div>
      </section>

      {/* ── Issue ────────────────────────────────────────────────────────── */}
      <section>
        <SectionHeading eyebrow="lines from the selected quote">Issue the PO</SectionHeading>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '0 1 220px' }}>
            <span style={fieldLabel}>PO number</span>
            <input value={poNumber} onChange={(e) => setPoNumber(e.target.value)} style={control} />
          </label>

          {needsBtb ? (
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 280px' }}>
              <span style={fieldLabel}>Back-to-back credit</span>
              <select value={btbId} onChange={(e) => setBtbId(e.target.value)} style={control}>
                <option value="">
                  {btbs.length === 0 ? 'no active BTB' : 'Choose the credit that funds it'}
                </option>
                {btbs.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.number} · {b.value} {b.currency} · under {b.masterNumber}
                  </option>
                ))}
              </select>
            </label>
          ) : null}

          <Button
            variant="primary"
            size="lg"
            disabled={!answered || pending || (needsBtb && btbId === '')}
            onClick={issue}
          >
            {pending ? 'Issuing…' : 'Issue the purchase order'}
          </Button>
        </div>

        <p
          style={{
            marginTop: 12,
            marginBottom: 0,
            font: "400 12px/1.6 var(--fx-font-mono)",
            color: 'var(--fx-text-tertiary)',
          }}
        >
          {!answered
            ? 'choose a supplier for every line — a PO missing a line is a second PO somebody has to remember'
            : needsBtb
              ? btbs.length === 0
                ? 'this supplier is an import mill and there is no active back-to-back credit — the gate will refuse, and nothing will be written'
                : btbId === ''
                  ? 'choose the credit that funds this order — an import PO is paid from a back-to-back, and which one is not a default'
                  : 'an import PO is funded from the back-to-back credit; the gate checks that it covers this order before anything is written'
              : 'a local supplier is paid in BDT — no back-to-back credit is involved'}
        </p>
      </section>
    </div>
  )
}

const cell: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  textAlign: 'right',
  font: "500 13.5px/1.3 var(--fx-font-mono)",
}

const sub: React.CSSProperties = {
  marginTop: 2,
  font: "400 10.5px/1 var(--fx-font-mono)",
  color: 'var(--fx-text-tertiary)',
}

const fieldLabel: React.CSSProperties = { font: "500 13px/1.3 var(--fx-font-sans)" }

const control: React.CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  padding: '10px 12px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 14px/1.4 var(--fx-font-sans)",
}
