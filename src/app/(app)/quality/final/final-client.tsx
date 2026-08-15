'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { NumpadInput } from '@/components/fx/floor'
import { useLocale, useT } from '@/components/fx/locale'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import type { Translator } from '@/lib/i18n-ui'
import { previewAqlPlan } from '@/modules/quality/actions'
import { SyncPill } from '@/components/fx/floor'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import type { AqlPlan } from '@/modules/quality/quality'
import { unwrap } from '@/lib/action-failure'

interface DefectCode {
  category: string
  code: string
  label: string
  severity: string
}

interface History {
  id: string
  inspectionNo: string
  lotQty: number
  sampleSize: number
  verdict: string
  criticalFound: number
  majorFound: number
  minorFound: number
  inspectedAt: string
}

interface Lot {
  orderId: string
  orderStyleId: string | null
  poNumber: string | null
  buyerName: string | null
  styleCode: string | null
  contractedQty: number | null
  /** Pieces off finishing — the lot an inspection is actually drawn from. */
  finishedQty: number
  majorAql: string | null
  minorAql: string | null
  history: History[]
}

const LEVELS = ['I', 'II', 'III'] as const

const SEVERITY_TONE: Record<string, 'danger' | 'warning' | 'neutral'> = {
  critical: 'danger',
  major: 'warning',
  minor: 'neutral',
}

/**
 * `defect_severity` and `inspection_result` as words rather than as column values.
 *
 * Both fall back to the raw value, so a value added to either enum without touching this
 * screen renders wrong but readable rather than as a missing key.
 */
const SEVERITY_COPY: Record<string, string> = {
  critical: 'ui.quality.severity_critical',
  major: 'ui.quality.severity_major',
  minor: 'ui.quality.severity_minor',
}

const VERDICT_COPY: Record<string, string> = {
  pass: 'ui.quality.verdict_pass',
  fail: 'ui.quality.verdict_fail',
}

function severityLabel(t: Translator, severity: string): string {
  const key = SEVERITY_COPY[severity]
  return key ? t(key) : severity
}

function verdictLabel(t: Translator, verdict: string): string {
  const key = VERDICT_COPY[verdict]
  return key ? t(key) : verdict
}

/**
 * Running a final inspection.
 *
 * The plan is fetched from the server the moment the lot size and levels are known, and it
 * is the SAME `resolveAqlPlan` over the same versioned table that the verdict will use — so
 * "pull 200 pieces, accept 10 major" cannot disagree with what the submission decides. No
 * AQL arithmetic happens in this file at all; the counts below are just tallies of what the
 * inspector tapped.
 */
export function FinalClient({
  lots,
  defects,
}: {
  lots: readonly Lot[]
  defects: readonly DefectCode[]
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const { capture, online, queued, syncing, refused, sync, clear } = useOfflineQueue()

  const [lot, setLot] = useState<Lot | null>(null)
  const [lotQty, setLotQty] = useState('')
  const [level, setLevel] = useState<(typeof LEVELS)[number]>('II')
  const [inspectionNo, setInspectionNo] = useState('')
  const [found, setFound] = useState<Record<string, number>>({})
  const [plan, setPlan] = useState<AqlPlan | null>(null)
  const [planError, setPlanError] = useState<string | null>(null)
  // The verdict is carried as a FLAG next to its sentence, not sniffed out of the sentence.
  // Reading the tone off `text.includes('FAILED')` worked only while the copy was English:
  // in Bangla the word is not there, and a failed lot would have shown in the success tone.
  const [outcome, setOutcome] = useState<{ failed: boolean; text: string } | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  /**
   * Inspections filed from this device since the page loaded.
   *
   * The inspection number is derived from how many the lot already has, and that count only
   * moves when the server answers. Queuing broke it: three inspections captured on a dead
   * network would all be numbered `-1`, and `inspection_no` is unique per company — so two
   * of the three would be refused at sync, hours later, with the lot long since shipped or
   * reworked. Counting locally keeps them distinct while offline.
   */
  const [filedHere, setFiledHere] = useState<Record<string, number>>({})

  // eslint-disable-next-line fabricxai/no-float-money -- keypad lot size in pieces, quantity not money; NaN falls back to 0
  const qty = Number.parseInt(lotQty, 10) || 0

  // Tallies, not judgements. Severity comes from the code, and the verdict from the server.
  const counts = { critical: 0, major: 0, minor: 0 }
  for (const [code, n] of Object.entries(found)) {
    const severity = defects.find((d) => d.code === code)?.severity
    if (severity === 'critical' || severity === 'major' || severity === 'minor') {
      counts[severity] += n
    }
  }

  function open(next: Lot) {
    setLot(next)
    /*
     * The lot is what is FINISHED, not what was ordered.
     *
     * This prefilled the contracted quantity, and the AQL sample size is computed from the
     * lot size — so an inspection of the first 1,050 pieces off finishing was being sized as
     * if 18,000 were on the floor, which draws a bigger sample than the lot contains and
     * accepts on a plan nobody agreed to. Contracted is the fallback for an order whose
     * finishing has not been recorded here at all.
     */
    const prefilled = next.finishedQty > 0 ? next.finishedQty : (next.contractedQty ?? 0)
    setLotQty(prefilled > 0 ? String(prefilled) : '')
    const already = next.history.length + (filedHere[next.orderId] ?? 0)
    setInspectionNo(`FI-${next.poNumber ?? next.orderId.slice(0, 6)}-${already + 1}`)
    setFound({})
    setPlan(null)
    setPlanError(null)
    setFailure(null)
    // Fetch against the lot being opened, not the one in state — `setLot` has not landed
    // yet. Without this the screen prefills a lot size and then says "enter the lot size",
    // which reads as the field having failed to register.
    if (prefilled > 0) loadPlan(prefilled, level, next)
  }

  function loadPlan(nextQty: number, nextLevel: string, forLot: Lot | null = lot) {
    if (!forLot?.majorAql || !forLot.minorAql || nextQty <= 0) {
      setPlan(null)
      return
    }
    // Read out before the closure: narrowing does not survive into an async callback.
    const majorAql = forLot.majorAql
    const minorAql = forLot.minorAql

    setPlanError(null)
    startTransition(async () => {
      try {
        setPlan(
          unwrap(
            await previewAqlPlan({
            lotQty: nextQty,
            inspectionLevel: nextLevel,
            majorAql,
            minorAql,
            }),
          )
        )
      } catch (error) {
        setPlan(null)
        setPlanError(actionErrorMessage(error, t('ui.quality.no_plan'), locale))
      }
    })
  }

  /**
   * Queue the inspection (plan 4.1, audit FE-H5).
   *
   * A final inspection happens in a finishing area at the far end of a shed; this was one of
   * two floor screens still posting straight to a server action with no written reason for
   * it. Losing the network mid-inspection lost a count somebody had spent an hour making.
   *
   * **The verdict is still the server's.** Nothing here decides pass or fail — that is
   * computed from the versioned AQL table when the write lands, exactly as before, which is
   * what stops an inspector making a lot pass. What queuing changes is WHEN the inspector
   * learns it, so the confirmation says the inspection is saved and stops there rather than
   * guessing at an answer this file is deliberately not allowed to reach.
   */
  function submit() {
    if (!lot || !plan || qty <= 0) return
    setFailure(null)
    const orderId = lot.orderId

    startTransition(async () => {
      try {
        await capture({
          moduleId: 'quality',
          operation: 'final_inspection',
          payload: {
            orderId,
            ...(lot.orderStyleId ? { orderStyleId: lot.orderStyleId } : {}),
            inspectionNo,
            lotQty: qty,
            inspectionLevel: level,
            majorAql: lot.majorAql,
            minorAql: lot.minorAql,
            defects: Object.entries(found)
              .filter(([, n]) => n > 0)
              .map(([code, count]) => ({ code, count })),
          },
        })

        // Neutral tone deliberately: this is a receipt, not a verdict. The lot's history
        // shows what the server decided once the write has landed.
        setOutcome({ failed: false, text: t('ui.quality.final_queued', { inspection: inspectionNo }) })
        setFiledHere((f) => ({ ...f, [orderId]: (f[orderId] ?? 0) + 1 }))
        setLot(null)
        if (online) await sync()
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.quality.final_not_filed'), locale))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />

      {refused.length > 0 ? (
        <InlineAlert tone="danger">
          {t.plural('ui.quality.checks_refused', refused.length)}
          {refused.map((r) => (
            <button
              key={r.offlineKey}
              onClick={() => void clear(r.offlineKey)}
              style={{
                marginLeft: 8,
                background: 'transparent',
                border: 'none',
                textDecoration: 'underline',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {t('ui.common.dismiss')}
            </button>
          ))}
        </InlineAlert>
      ) : null}

      {outcome ? (
        <InlineAlert tone={outcome.failed ? 'danger' : 'success'}>{outcome.text}</InlineAlert>
      ) : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {/* ── The lot in front of you ──────────────────────────────────────── */}
      {lot ? (
        <section
          style={{
            border: '1px solid var(--fx-border-default)',
            background: 'var(--fx-bg-surface)',
            padding: '22px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 18,
          }}
        >
          <SectionHeading eyebrow={lot.buyerName ?? t('ui.quality.lot_eyebrow_fallback')}>
            {t('ui.quality.lot_heading', {
              lot: lot.poNumber ?? lot.orderId.slice(0, 8),
            })}
          </SectionHeading>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 14,
            }}
          >
            <NumpadInput
              label={t('ui.quality.field_lot_size')}
              value={lotQty}
              onChange={(v) => {
                setLotQty(v)
                // eslint-disable-next-line fabricxai/no-float-money -- keypad lot size in pieces to size the AQL plan, quantity not money; NaN falls back to 0
                loadPlan(Number.parseInt(v, 10) || 0, level)
              }}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {t('ui.quality.field_level')}
              </span>
              <select
                value={level}
                onChange={(e) => {
                  const next = e.target.value as (typeof LEVELS)[number]
                  setLevel(next)
                  loadPlan(qty, next)
                }}
                style={{
                  minHeight: 44,
                  minWidth: 0,
                  padding: '10px 12px',
                  border: '1px solid var(--fx-border-default)',
                  borderRadius: 'var(--fx-radius-sm)',
                  background: 'var(--fx-bg-surface)',
                  color: 'var(--fx-text-primary)',
                  font: "400 14px/1.4 var(--fx-font-sans)",
                }}
              >
                {LEVELS.map((l) => (
                  <option key={l} value={l}>
                    {t('ui.quality.level_option', { level: l })}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {t('ui.quality.field_inspection_no')}
              </span>
              <input
                value={inspectionNo}
                onChange={(e) => setInspectionNo(e.target.value)}
                style={{
                  minHeight: 44,
                  minWidth: 0,
                  padding: '10px 12px',
                  border: '1px solid var(--fx-border-default)',
                  borderRadius: 'var(--fx-radius-sm)',
                  background: 'var(--fx-bg-surface)',
                  color: 'var(--fx-text-primary)',
                  font: "400 14px/1.4 var(--fx-font-sans)",
                }}
              />
            </label>
          </div>

          {/* ── The rule, not just the numbers ───────────────────────────── */}
          <SectionHeading eyebrow={t('ui.quality.plan_eyebrow')}>
            {t('ui.quality.plan_heading')}
          </SectionHeading>

          {!lot.majorAql ? (
            <InlineAlert tone="warning">
              {t('ui.quality.no_buyer_terms', {
                buyer: lot.buyerName ?? t('ui.quality.this_buyer'),
              })}
            </InlineAlert>
          ) : planError ? (
            <InlineAlert tone="danger">{planError}</InlineAlert>
          ) : plan ? (
            <>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
                  gap: 1,
                  background: 'var(--fx-border-subtle)',
                  border: '1px solid var(--fx-border-subtle)',
                }}
              >
                {[
                  {
                    label: t('ui.quality.plan_pull'),
                    value: plan.hundredPercent
                      ? t('ui.quality.plan_pull_all', { count: plan.lotQty })
                      : String(plan.sampleSize),
                    note: plan.hundredPercent
                      ? t('ui.quality.plan_full_inspection')
                      : t('ui.quality.plan_pieces_note'),
                  },
                  {
                    label: t('ui.quality.plan_major_label', { aql: plan.majorAql }),
                    value: `${plan.majorAccept} / ${plan.majorReject}`,
                    note: t('ui.quality.plan_accept_reject'),
                  },
                  {
                    label: t('ui.quality.plan_minor_label', { aql: plan.minorAql }),
                    value: `${plan.minorAccept} / ${plan.minorReject}`,
                    note: t('ui.quality.plan_accept_reject'),
                  },
                  {
                    label: severityLabel(t, 'critical'),
                    value: '0',
                    note: t('ui.quality.plan_critical_note'),
                  },
                ].map((cell) => (
                  <div
                    key={cell.label}
                    style={{ background: 'var(--fx-bg-surface)', padding: '14px 16px' }}
                  >
                    <div
                      style={{
                        font: "400 10.5px/1.3 var(--fx-font-mono)",
                        letterSpacing: '.05em',
                        textTransform: 'uppercase',
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {cell.label}
                    </div>
                    <div style={{ marginTop: 6, font: "600 24px/1.1 var(--fx-font-sans)" }}>
                      {cell.value}
                    </div>
                    <div
                      style={{
                        marginTop: 3,
                        font: "400 11.5px/1.3 var(--fx-font-sans)",
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {cell.note}
                    </div>
                  </div>
                ))}
              </div>
              <p
                style={{
                  margin: 0,
                  font: "400 12px/1.6 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {t('ui.quality.plan_note')}
              </p>
            </>
          ) : (
            <span
              style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
            >
              {pending ? 'reading the sampling table…' : 'enter the lot size to see the plan'}
            </span>
          )}

          {/* ── Counting ─────────────────────────────────────────────────── */}
          {plan ? (
            <>
              <SectionHeading eyebrow={t('ui.quality.defects_eyebrow')}>
                {t('ui.quality.defects_heading')}
              </SectionHeading>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))',
                  gap: 10,
                }}
              >
                {defects.map((d) => {
                  const n = found[d.code] ?? 0
                  return (
                    <div
                      key={d.code}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '10px 12px',
                        border: `1px solid ${n > 0 ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                        borderRadius: 'var(--fx-radius-md)',
                        background: 'var(--fx-bg-surface)',
                        minHeight: 56,
                      }}
                    >
                      <span
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: 4,
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{d.label}</span>
                        <Badge tone={SEVERITY_TONE[d.severity] ?? 'neutral'}>{d.severity}</Badge>
                      </span>
                      <button
                        aria-label={`Remove one ${d.label}`}
                        disabled={n === 0}
                        onClick={() => setFound((f) => ({ ...f, [d.code]: Math.max(0, n - 1) }))}
                        style={tallyButton}
                      >
                        −
                      </button>
                      <span
                        style={{
                          minWidth: 22,
                          textAlign: 'center',
                          font: "600 16px/1 var(--fx-font-mono)",
                        }}
                      >
                        {n}
                      </span>
                      <button
                        aria-label={`Add one ${d.label}`}
                        onClick={() => setFound((f) => ({ ...f, [d.code]: n + 1 }))}
                        style={tallyButton}
                      >
                        +
                      </button>
                    </div>
                  )
                })}
              </div>

              <div style={{ display: 'flex', gap: 26, flexWrap: 'wrap', alignItems: 'center' }}>
                {(['critical', 'major', 'minor'] as const).map((severity) => {
                  const accept =
                    severity === 'critical'
                      ? 0
                      : severity === 'major'
                        ? plan.majorAccept
                        : plan.minorAccept
                  const over = counts[severity] > accept
                  return (
                    <span key={severity} style={{ display: 'flex', flexDirection: 'column' }}>
                      <span
                        style={{
                          font: "400 10.5px/1.3 var(--fx-font-mono)",
                          letterSpacing: '.05em',
                          textTransform: 'uppercase',
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {severity} found
                      </span>
                      <span
                        style={{
                          font: "600 22px/1.1 var(--fx-font-sans)",
                          color: over ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                        }}
                      >
                        {counts[severity]}
                        <span
                          style={{
                            font: "400 12px/1 var(--fx-font-mono)",
                            color: 'var(--fx-text-tertiary)',
                          }}
                        >
                          {' '}
                          / {accept} allowed
                        </span>
                      </span>
                    </span>
                  )
                })}

                <span style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
                  <Button variant="ghost" onClick={() => setLot(null)}>
                    {t('ui.boundary.not_found_back')}
                  </Button>
                  <Button variant="primary" size="lg" disabled={pending} onClick={submit}>
                    {pending ? t('ui.quality.filing') : t('ui.quality.submit_verdict')}
                  </Button>
                </span>
              </div>

              <p
                style={{
                  margin: 0,
                  font: "400 12px/1.6 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {t('ui.quality.verdict_server_note')}
              </p>
            </>
          ) : null}
        </section>
      ) : null}

      {/* ── The lots ─────────────────────────────────────────────────────── */}
      {lots.map((l) => {
        const last = l.history[0]
        return (
          <div
            className="fx-stack-tablet"
            key={l.orderId}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) 200px 190px 170px',
              gap: 14,
              alignItems: 'center',
              padding: '14px 18px',
              border: '1px solid var(--fx-border-subtle)',
              borderLeft: `3px solid ${
                last?.verdict === 'fail' ? 'var(--fx-danger)' : 'transparent'
              }`,
              background: 'var(--fx-bg-surface)',
            }}
          >
            <span style={{ minWidth: 0 }}>
              <span style={{ font: "600 15px/1.2 var(--fx-font-sans)" }}>
                {l.poNumber ?? l.orderId.slice(0, 8)}
              </span>
              <span
                style={{
                  display: 'block',
                  marginTop: 3,
                  font: "400 12px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {l.buyerName ?? 'no buyer'}
                {l.styleCode ? ` · ${l.styleCode}` : ''}
                {/* Finished over contracted. An inspector needs to know there is a lot to
                    sample before they walk to it — the queue used to show only what was
                    ordered, so an order with nothing sewn read exactly like one ready to
                    inspect. */}
                {l.finishedQty > 0
                  ? ` · ${l.finishedQty.toLocaleString()} of ${(l.contractedQty ?? 0).toLocaleString()} finished`
                  : ' · nothing finished yet'}
              </span>
            </span>

            <span
              style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
            >
              {l.majorAql
                ? `AQL ${l.majorAql} / ${l.minorAql}`
                : t('ui.quality.no_terms_short')}
            </span>

            <span>
              {last ? (
                <Badge tone={last.verdict === 'pass' ? 'success' : 'danger'}>
                  {/* Through verdictLabel, not the raw column: `pass` / `fail` are enum
                      values, and an inspector reading Bangla should not have to learn two
                      English words to read a badge. */}
                  {last.inspectionNo} · {verdictLabel(t, last.verdict)}
                </Badge>
              ) : (
                <span
                  style={{
                    font: "400 12px/1.3 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {t('ui.quality.never_inspected')}
                </span>
              )}
            </span>

            <span style={{ textAlign: 'right' }}>
              <Button
                variant="ghost"
                disabled={!l.majorAql || l.finishedQty === 0}
                onClick={() => open(l)}
              >
                {last ? t('ui.quality.reinspect') : t('ui.quality.inspect')}
              </Button>
            </span>
          </div>
        )
      })}
    </div>
  )
}

const tallyButton: React.CSSProperties = {
  width: 40,
  height: 40,
  flexShrink: 0,
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'transparent',
  color: 'var(--fx-text-primary)',
  cursor: 'pointer',
  font: "500 18px/1 var(--fx-font-sans)",
}
