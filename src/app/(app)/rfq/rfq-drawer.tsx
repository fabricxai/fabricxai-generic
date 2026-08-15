'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition, type ReactNode } from 'react'

import { InlineAlert, Modal, Toast } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { useLocale, useT } from '@/components/fx/locale'
import { Badge, Button } from '@/components/fx/primitives'
import { Eyebrow } from '@/components/fx/signature'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { factoryToday } from '@/lib/dates'
import { committedTrail } from '@/modules/approvals/actions'
import type { RecordTrail } from '@/modules/approvals/queries'
import { parseSizeRatio } from '@/modules/rfq/rfq'
import {
  askClarification,
  draftQuote,
  markRfqLost,
  markRfqWon,
  sendQuote,
} from '@/modules/rfq/actions'

/** What the board already has per row — the drawer needs no extra read. */
export interface DrawerRfq {
  id: string
  title: string
  styleCode: string | null
  buyerName: string | null
  status: string
  quantity: number
  unit: string
  currency: string
  targetPrice: string | null
  quote: { id: string; version: number; fobPrice: string; currency: string; status: string } | null
  openClarifications: number
  /** Null / empty when the enquiry never stated them — the win asks for them. */
  requestedShipDate: string | null
  sizeRatio: Record<string, number>
}

/**
 * 1.2 RFQ, made operable (plan 5.3, audit FE-S2).
 *
 * This module had **no `actions.ts` at all** over a complete service, so the board could be
 * watched and not worked: nothing could be quoted, sent, won or lost from a screen. With no
 * MARBIM provider registered the desk could not even receive an enquiry.
 *
 * ## Four buttons, in the order the work happens
 *
 * Quote → send → won or lost. Each is offered only when it is legal, read from the RFQ's own
 * status rather than from a guess: `rfqStatusMachine` allows `quoted → quoted`, which is a
 * RE-QUOTE and the most ordinary thing that happens when a buyer pushes back on price.
 *
 * ## The margin floor is not this file's decision
 *
 * `sendQuote` refuses a below-floor quote for anybody but an owner or an admin, and the
 * result says whether it WAS below. So the confirmation reports what was actually sent
 * rather than what the merchandiser expected to send — and the reason field appears because
 * the server asked for it, not because this screen guessed the price was thin.
 */
export function RfqDrawer({
  rfq,
  lossReasons,
  onClose,
}: {
  rfq: DrawerRfq | null
  lossReasons: readonly { code: string; label: string }[]
  onClose: () => void
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [failure, setFailure] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  const [styleCode, setStyleCode] = useState('')
  const [validity, setValidity] = useState('')
  const [belowFloorReason, setBelowFloorReason] = useState('')
  const [lossCode, setLossCode] = useState('')
  const [lossNote, setLossNote] = useState('')
  const [question, setQuestion] = useState('')
  const [wonShipDate, setWonShipDate] = useState('')
  const [wonRatioText, setWonRatioText] = useState('')

  if (!rfq) return null

  const live = rfq.status === 'open' || rfq.status === 'clarifying' || rfq.status === 'quoted'
  const draftable = live
  const sendable = rfq.quote?.status === 'draft'
  const decidable = rfq.status === 'quoted'

  // What the win still needs. An enquiry arrives as "36,000 pcs, mid-November window";
  // the acceptance is where a date and a ratio become firm, so the drawer asks for them
  // HERE rather than letting `markWon` refuse an order it cannot schedule or cut.
  const needsShipDate = decidable && !rfq.requestedShipDate
  const needsRatio =
    decidable && Object.values(rfq.sizeRatio ?? {}).filter((parts) => parts > 0).length === 0
  const wonRatio = parseSizeRatio(wonRatioText)
  const winReady = (!needsShipDate || wonShipDate !== '') && (!needsRatio || wonRatio !== null)

  function flash(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 6000)
  }

  function run(work: () => Promise<string>) {
    setFailure(null)
    startTransition(async () => {
      try {
        const message = await work()
        onClose()
        flash(message)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.rfq.action_failed'), locale))
      }
    })
  }

  return (
    <>
      <Modal open onClose={onClose} title={rfq.title}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone="info">{rfq.status}</Badge>
            {rfq.buyerName ? <Badge>{rfq.buyerName}</Badge> : null}
            <span style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {rfq.quantity.toLocaleString()} {rfq.unit}
              {rfq.targetPrice ? ` · target ${rfq.targetPrice} ${rfq.currency}` : ''}
            </span>
          </div>

          {rfq.quote ? (
            <InlineAlert tone="info">
              {t('ui.rfq.current_quote', {
                version: rfq.quote.version,
                price: rfq.quote.fobPrice,
                currency: rfq.quote.currency,
                status: rfq.quote.status,
              })}
            </InlineAlert>
          ) : null}

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          {/* ── Quote it ─────────────────────────────────────────────────── */}
          {draftable ? (
            <Section title={t('ui.rfq.draft_quote')}>
              <span style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                {/* The refusal worth explaining before it happens, not after. */}
                {t('ui.rfq.draft_quote_body')}
              </span>
              <TextInput
                label={t('ui.rfq.style_code')}
                mono
                value={styleCode || (rfq.styleCode ?? '')}
                onChange={(e) => setStyleCode(e.target.value)}
              />
              <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                  {t('ui.rfq.valid_until')}
                </span>
                <DateInput
                  value={validity}
                  onChange={setValidity}
                  style={dateStyle}
                />
              </label>
              <Right>
                <Button
                  variant="secondary"
                  disabled={pending || (styleCode || rfq.styleCode || '') === ''}
                  onClick={() =>
                    run(async () => {
                      const result = unwrap(
                        await draftQuote({
                          rfqId: rfq.id,
                          styleCode: styleCode || rfq.styleCode || '',
                          ...(validity ? { validityDate: validity } : {}),
                        }),
                      )
                      return result.supersededCount > 0
                        ? t('ui.rfq.quote_drafted_superseding', {
                            version: result.version,
                            price: result.fobPrice,
                            superseded: result.supersededCount,
                          })
                        : t('ui.rfq.quote_drafted', {
                            version: result.version,
                            price: result.fobPrice,
                            margin: result.achievedMarginPct,
                          })
                    })
                  }
                >
                  {t('ui.rfq.draft_it')}
                </Button>
              </Right>
            </Section>
          ) : null}

          {/* ── Send it ──────────────────────────────────────────────────── */}
          {sendable ? (
            <Section title={t('ui.rfq.send_quote')}>
              <TextInput
                label={t('ui.rfq.below_floor_reason')}
                hint={t('ui.rfq.below_floor_hint')}
                value={belowFloorReason}
                onChange={(e) => setBelowFloorReason(e.target.value)}
              />
              <Right>
                <Button
                  variant="primary"
                  disabled={pending}
                  onClick={() =>
                    run(async () => {
                      const result = unwrap(
                        await sendQuote({
                          quoteId: rfq.quote!.id,
                          sentAt: factoryToday(),
                          ...(belowFloorReason.trim()
                            ? { belowFloorReason: belowFloorReason.trim() }
                            : {}),
                        }),
                      )
                      // What was SENT, not what was expected: the server decided whether
                      // this crossed the floor, and it is the answer worth reporting.
                      return result.belowFloor
                        ? t('ui.rfq.sent_below_floor')
                        : t('ui.rfq.sent')
                    })
                  }
                >
                  {t('ui.rfq.send_it')}
                </Button>
              </Right>
            </Section>
          ) : null}

          {/* ── Won or lost ──────────────────────────────────────────────── */}
          {decidable ? (
            <Section title={t('ui.rfq.decide')}>
              <span style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                {t('ui.rfq.decide_body')}
              </span>

              {needsShipDate || needsRatio ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  <span
                    style={{ font: "400 12.5px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}
                  >
                    {t('ui.rfq.winning_terms_body')}
                  </span>
                  {needsShipDate ? (
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                        {t('ui.rfq.won_ship_date')}
                      </span>
                      <DateInput
                        value={wonShipDate}
                        onChange={setWonShipDate}
                        style={dateStyle}
                      />
                    </label>
                  ) : null}
                  {needsRatio ? (
                    <TextInput
                      label={t('ui.rfq.won_size_ratio')}
                      hint={t('ui.rfq.won_size_ratio_hint')}
                      mono
                      placeholder="S:1 M:2 L:2 XL:1"
                      value={wonRatioText}
                      onChange={(e) => setWonRatioText(e.target.value)}
                    />
                  ) : null}
                </div>
              ) : null}

              <select value={lossCode} onChange={(e) => setLossCode(e.target.value)} style={dateStyle}>
                <option value="">{t('ui.rfq.choose_loss_reason')}</option>
                {lossReasons.map((reason) => (
                  <option key={reason.code} value={reason.code}>
                    {reason.label}
                  </option>
                ))}
              </select>
              {lossReasons.length === 0 ? (
                <span style={{ font: "400 12.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
                  {t('ui.rfq.no_loss_reasons')}
                </span>
              ) : null}
              <TextInput
                label={t('ui.rfq.loss_note')}
                value={lossNote}
                onChange={(e) => setLossNote(e.target.value)}
              />

              <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                <Button
                  variant="secondary"
                  disabled={pending || lossCode === ''}
                  onClick={() =>
                    run(async () => {
                      unwrap(
                        await markRfqLost({
                          rfqId: rfq.id,
                          lossReasonCode: lossCode,
                          ...(lossNote.trim() ? { note: lossNote.trim() } : {}),
                        }),
                      )
                      return t('ui.rfq.marked_lost')
                    })
                  }
                >
                  {t('ui.rfq.mark_lost')}
                </Button>
                <Button
                  variant="primary"
                  disabled={pending || !winReady}
                  onClick={() =>
                    run(async () => {
                      unwrap(
                        await markRfqWon({
                          rfqId: rfq.id,
                          ...(needsShipDate && wonShipDate
                            ? { requestedShipDate: wonShipDate }
                            : {}),
                          ...(needsRatio && wonRatio ? { sizeRatio: wonRatio } : {}),
                        }),
                      )
                      return t('ui.rfq.marked_won')
                    })
                  }
                >
                  {t('ui.rfq.mark_won')}
                </Button>
              </div>
            </Section>
          ) : null}

          {/* ── Ask the buyer something ──────────────────────────────────── */}
          {live ? (
            <Section title={t('ui.rfq.ask')}>
              <TextInput
                label=""
                placeholder={t('ui.rfq.ask_placeholder')}
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
              />
              <Right>
                <Button
                  variant="ghost"
                  disabled={pending || question.trim() === ''}
                  onClick={() =>
                    run(async () => {
                      unwrap(
                        await askClarification({
                          rfqId: rfq.id,
                          question: question.trim(),
                          askedAt: factoryToday(),
                        }),
                      )
                      return t('ui.rfq.asked')
                    })
                  }
                >
                  {t('ui.rfq.ask_it')}
                </Button>
              </Right>
            </Section>
          ) : null}

          {!live ? <InlineAlert tone="info">{t('ui.rfq.settled')}</InlineAlert> : null}

          <Trail rfqId={rfq.id} />
        </div>
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', left: 28, bottom: 28, zIndex: 60, maxWidth: 480 }}>
          <Toast message={toast} />
        </div>
      ) : null}
    </>
  )
}

/** "08 Aug 14:22" — the trail is a sequence, and a date without a time hides the order. */
function trailWhen(value: Date | string): string {
  const at = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(at.getTime())) return ''
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  return `${String(at.getDate()).padStart(2, '0')} ${months[at.getMonth()]} ${String(
    at.getHours(),
  ).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
}

/**
 * Whose hands this RFQ passed through, on the record's own screen.
 *
 * The approve inbox shows the trail while the draft is PENDING — and the moment it is
 * signed, the draft leaves the inbox and its provenance was reachable only from Settings,
 * behind owner/admin. This is the other half: after commit, the record itself says who
 * drafted it and who signed it, from the same `pending_changes` chain via
 * `committed_row_id`.
 *
 * Fetched on open, not with the board — most drawer opens are about quoting, and the trail
 * must never make the board slower. Renders nothing at all for a record with no draft
 * behind it (typed straight into a form) and for roles the action refuses — a viewer's
 * drawer looks exactly as it always did.
 */
function Trail({ rfqId }: { rfqId: string }) {
  const t = useT()
  const [trail, setTrail] = useState<RecordTrail | null>(null)

  useEffect(() => {
    let alive = true
    committedTrail({ targetTable: 'rfqs', targetId: rfqId })
      .then((result) => {
        if (alive) setTrail(unwrap(result))
      })
      // A refused role or a transient failure both mean the same thing here: no section.
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [rfqId])

  if (!trail) return null

  // Three honest states: a name, a person who has left, or genuinely nobody (an import).
  const drafter = trail.draftedBy
    ? (trail.draftedBy.name ?? t('ui.rfq.trail_departed'))
    : t('ui.rfq.trail_no_author')

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    font: "400 12px/1.7 var(--fx-font-mono)",
    color: 'var(--fx-text-tertiary)',
  }

  return (
    <Section title={t('ui.rfq.trail')}>
      <ol style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        <li style={rowStyle}>
          <span style={{ color: 'var(--fx-text-secondary)' }}>
            {t('ui.rfq.trail_drafted', { name: drafter })}
          </span>
          <span>{trailWhen(trail.draftedAt)}</span>
        </li>
        {trail.approvals.map((signature, index) => (
          <li key={index} style={rowStyle}>
            <span style={{ color: 'var(--fx-text-secondary)' }}>
              {t('ui.rfq.trail_approved', {
                name: signature.name ?? t('ui.rfq.trail_departed'),
                role: signature.role,
              })}
            </span>
            <span>{trailWhen(signature.at)}</span>
          </li>
        ))}
        {trail.committedAt ? (
          <li style={rowStyle}>
            <span>{t('ui.rfq.trail_committed')}</span>
            <span>{trailWhen(trail.committedAt)}</span>
          </li>
        ) : null}
      </ol>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Eyebrow>{title}</Eyebrow>
      {children}
    </section>
  )
}

function Right({ children }: { children: ReactNode }) {
  return <div style={{ display: 'flex', justifyContent: 'flex-end' }}>{children}</div>
}

const dateStyle: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}
