'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import {
  createSubmission,
  postLcRealization,
  updateSubmissionStatus,
} from '@/modules/commercial/actions'

interface Lc {
  id: string
  number: string
  currency: string
  buyerName: string | null
}

interface Submission {
  id: string
  lcId: string
  lcNumber: string
  buyerName: string | null
  bankStatus: string
  docs: string[]
  invoicedAmount: string | null
  realizedAmount: string | null
  currency: string
  submittedAt: string | null
  discrepantSince: string | null
  discrepancyNotes: string | null
  realizedAt: string | null
  shortfallReason: string | null
  escalated: boolean
}

/** The document set a bank expects for a garment export presentation. */
const DOC_KINDS = [
  'commercial_invoice',
  'packing_list',
  'bl',
  'certificate_of_origin',
  'inspection_certificate',
  'beneficiary_certificate',
] as const

const NEXT_STATUS: Record<string, readonly ('preparing' | 'submitted' | 'accepted' | 'discrepant')[]> =
  {
    preparing: ['submitted'],
    submitted: ['accepted', 'discrepant'],
    discrepant: ['submitted', 'accepted'],
    accepted: [],
    realized: [],
  }

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  preparing: 'neutral',
  submitted: 'neutral',
  accepted: 'success',
  discrepant: 'danger',
  realized: 'success',
}

function daysSince(date: string, today: string): number {
  return Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000)
}

/**
 * Presentations at the bank.
 *
 * `realized` is not in any status dropdown. It is reached only by posting a realization,
 * which carries an amount and a date and computes the shortfall — because "accepted" and
 * "paid" are different facts, and a factory that conflates them cannot tell you which
 * shipments it is still owed for.
 */
export function SubmissionsClient({
  today,
  lcs,
  submissions,
  escalateAfterDays,
}: {
  today: string
  lcs: readonly Lc[]
  submissions: readonly Submission[]
  escalateAfterDays: number
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [lcId, setLcId] = useState(lcs[0]?.id ?? '')
  const [docs, setDocs] = useState<string[]>(['commercial_invoice', 'packing_list', 'bl'])
  const [invoiced, setInvoiced] = useState('')

  const [realizing, setRealizing] = useState<Submission | null>(null)
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  const [noted, setNoted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  const lc = lcs.find((l) => l.id === lcId)

  function create() {
    if (!lc || docs.length === 0) return
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(
          await createSubmission({
            lcId: lc.id,
            docs,
            ...(invoiced.trim() ? { invoicedAmount: invoiced.trim() } : {}),
            currency: lc.currency,
          }),
        )
        setNoted(`Presentation opened against ${lc.number}.`)
        setInvoiced('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The presentation was not opened.'))
      }
    })
  }

  function move(s: Submission, status: 'preparing' | 'submitted' | 'accepted' | 'discrepant') {
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(
          await updateSubmissionStatus({
            submissionId: s.id,
            lcId: s.lcId,
            bankStatus: status,
            ...(status === 'submitted' ? { submittedAt: today } : {}),
            ...(status === 'discrepant' ? { discrepancyNotes: 'Raised by the bank.' } : {}),
          }),
        )
        setNoted(`${s.lcNumber} · ${status}.`)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The status did not change.'))
      }
    })
  }

  function realize() {
    if (!realizing || !amount.trim()) return
    setFailure(null)
    startTransition(async () => {
      try {
        const result = unwrap(
          await postLcRealization({
            submissionId: realizing.id,
            lcId: realizing.lcId,
            realizedAmount: amount.trim(),
            realizedAt: today,
            ...(reason.trim() ? { shortfallReason: reason.trim() } : {}),
          }),
        )
        setNoted(
          `Realized ${result.realizedAmount} — short by ${result.shortfall} (${result.shortfallPct}%).`,
        )
        setRealizing(null)
        setAmount('')
        setReason('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The realization was not posted.'))
      }
    })
  }

  // Shown live so the reason box appears while the number is still being typed, rather than
  // after the server refuses it.
  // eslint-disable-next-line fabricxai/no-float-money -- live shortfall preview beside the input; the server recomputes the exact figure on post and that is what is stored
  const invoicedOf = realizing?.invoicedAmount ? Number.parseFloat(realizing.invoicedAmount) : 0
  // eslint-disable-next-line fabricxai/no-float-money -- half-typed keyboard amount for the same preview; NaN falls back to 0
  const realizedOf = Number.parseFloat(amount) || 0
  const shortPct = invoicedOf > 0 ? ((invoicedOf - realizedOf) / invoicedOf) * 100 : 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {/* ── New submission ───────────────────────────────────────────────── */}
      <section>
        <SectionHeading eyebrow="what the bank will receive">New submission</SectionHeading>

        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '1 1 240px', minWidth: 0 }}>
            <span style={fieldLabel}>Against</span>
            <select value={lcId} onChange={(e) => setLcId(e.target.value)} style={control}>
              {lcs.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.number} · {l.buyerName ?? 'buyer'}
                </option>
              ))}
            </select>
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: '0 1 200px', minWidth: 0 }}>
            <span style={fieldLabel}>Invoiced ({lc?.currency ?? ''})</span>
            <input
              inputMode="decimal"
              value={invoiced}
              onChange={(e) => setInvoiced(e.target.value)}
              style={control}
            />
          </label>

          <Button variant="primary" disabled={docs.length === 0 || pending} onClick={create}>
            Open the presentation
          </Button>
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 14 }}>
          {DOC_KINDS.map((kind) => {
            const on = docs.includes(kind)
            return (
              <button
                key={kind}
                onClick={() =>
                  setDocs((d) => (on ? d.filter((x) => x !== kind) : [...d, kind]))
                }
                style={{
                  minHeight: 40,
                  padding: '8px 14px',
                  borderRadius: 'var(--fx-radius-md)',
                  border: `1px solid ${on ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                  background: on ? 'var(--fx-text-primary)' : 'transparent',
                  color: on ? 'var(--fx-text-inverse)' : 'var(--fx-text-secondary)',
                  cursor: 'pointer',
                  font: "400 12.5px/1 var(--fx-font-mono)",
                }}
              >
                {kind.replace(/_/g, ' ')}
              </button>
            )
          })}
        </div>
      </section>

      {/* ── The book ─────────────────────────────────────────────────────── */}
      <section>
        <SectionHeading
          eyebrow={`a discrepancy escalates after ${escalateAfterDays} days`}
        >
          Presentations
        </SectionHeading>

        {submissions.length === 0 ? (
          <span style={{ font: "400 12.5px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
            nothing has been presented yet
          </span>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {submissions.map((s) => {
              const age = s.discrepantSince ? daysSince(s.discrepantSince, today) : null
              const overdue = age !== null && age >= escalateAfterDays
              return (
                <div
                  key={s.id}
                  style={{
                    padding: '14px 18px',
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderLeft: overdue
                      ? '3px solid var(--fx-danger)'
                      : s.bankStatus === 'discrepant'
                        ? '3px solid var(--fx-warning)'
                        : undefined,
                  }}
                >
                  <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ font: "600 14px/1.2 var(--fx-font-mono)" }}>{s.lcNumber}</span>
                    <span style={{ font: "400 12.5px/1.2 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
                      {s.buyerName ?? 'buyer'}
                    </span>
                    <Badge tone={STATUS_TONE[s.bankStatus] ?? 'neutral'}>{s.bankStatus}</Badge>
                    {age !== null && s.bankStatus === 'discrepant' ? (
                      <Badge tone={overdue ? 'danger' : 'warning'}>
                        discrepant {age} {age === 1 ? 'day' : 'days'}
                      </Badge>
                    ) : null}
                    <span style={{ marginLeft: 'auto', display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {(NEXT_STATUS[s.bankStatus] ?? []).map((next) => (
                        <Button key={next} variant="ghost" disabled={pending} onClick={() => move(s, next)}>
                          {next}
                        </Button>
                      ))}
                      {s.bankStatus === 'accepted' || s.bankStatus === 'discrepant' ? (
                        <Button
                          variant="secondary"
                          disabled={pending}
                          onClick={() => {
                            setRealizing(s)
                            setAmount(s.invoicedAmount ?? '')
                            setReason('')
                          }}
                        >
                          Post the realization
                        </Button>
                      ) : null}
                    </span>
                  </div>

                  <div
                    style={{
                      marginTop: 8,
                      font: "400 12px/1.6 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {s.docs.map((d) => d.replace(/_/g, ' ')).join(' · ') || 'no documents listed'}
                    {s.invoicedAmount ? ` — invoiced ${s.invoicedAmount} ${s.currency}` : ''}
                    {s.realizedAmount
                      ? ` · realized ${s.realizedAmount} ${s.currency} on ${s.realizedAt}`
                      : ''}
                  </div>

                  {s.shortfallReason ? (
                    <div
                      style={{
                        marginTop: 6,
                        font: "400 12.5px/1.5 var(--fx-font-sans)",
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      Shortfall reason — {s.shortfallReason}
                    </div>
                  ) : null}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {realizing ? (
        <Modal
          open
          onClose={() => setRealizing(null)}
          title={`Realization · ${realizing.lcNumber}`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setRealizing(null)}>
                Cancel
              </Button>
              <Button variant="primary" disabled={!amount.trim() || pending} onClick={realize}>
                Post
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={fieldLabel}>Amount credited ({realizing.currency})</span>
              <input
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                style={control}
              />
            </label>

            <span style={{ font: "400 12px/1.6 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              Invoiced {realizing.invoicedAmount ?? '—'} {realizing.currency}
              {invoicedOf > 0 && realizedOf > 0
                ? ` · short by ${(invoicedOf - realizedOf).toFixed(2)} (${shortPct.toFixed(1)}%)`
                : ''}
              . Bank charges come off before crediting, so a small shortfall is normal.
            </span>

            {shortPct > 5 ? (
              <>
                <InlineAlert tone="warning">
                  That is more than bank charges. A deduction this size is a dispute or a
                  discount — the server will refuse it without a written reason.
                </InlineAlert>
                <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span style={fieldLabel}>What was deducted, and why</span>
                  <textarea
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    style={{ ...control, minHeight: 60, resize: 'vertical' }}
                  />
                </label>
              </>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  )
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
