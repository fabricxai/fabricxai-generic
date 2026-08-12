'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { allocate, recordSmv } from '@/modules/planning/actions'

/**
 * Putting an order on a line (found by walking the order journey as a planner).
 *
 * The board drew eight lines and fourteen days and offered no way to commit anything to any
 * of them. `allocate` had existed since 5.2 — service, action, gate, overload arithmetic and
 * all — reachable only from the approve inbox's scenario commit handler. So the planner, whose
 * entire job is deciding which line makes which order and when, could look at the board and
 * could not use it. `RunActions` had already added moving and starting runs; what was missing
 * was the one that creates them.
 *
 * ## Why this asks for a daily rate and not fourteen numbers
 *
 * `allocate` takes `plannedDaily` — a quantity per calendar date — because that is what the
 * load check needs, and the board reads per date rather than smearing a total across a range.
 * That is the right shape for the service and a terrible one for a form: nobody is going to
 * type fourteen boxes to book one style.
 *
 * So the form asks the way a planner actually thinks — this line, from this date, at about
 * this many a day, until the order is done — and derives the map. The derived days are shown
 * before anything is written, because a planner who meant 1,200 a day for ten days and typed
 * a rate that produces nineteen days needs to see nineteen.
 *
 * ## The overload is a question, not an error
 *
 * `allocate` returns `fits: false` with the numbers rather than throwing, precisely so this
 * can show them and ask. A line over-committed on purpose is a different thing from one
 * over-committed by accident, and the board already distinguishes them — this is where that
 * distinction is actually made.
 */

export interface AllocatableOrder {
  orderId: string
  /** Which style this books the line for — the board names the run by it. */
  orderStyleId: string | null
  label: string
  /** What is left to plan, so the form can propose a sensible run. */
  qty: number
  /** The code an SMV is recorded against — how long one garment takes to sew. */
  styleCode: string | null
  /** Null when nobody has timed this style yet, which is what blocks planning it. */
  smv: string | null
}

export interface AllocatableLine {
  id: string
  code: string
  name: string
}

export function NewAllocationButton({
  orders,
  lines,
  today,
}: {
  orders: readonly AllocatableOrder[]
  lines: readonly AllocatableLine[]
  today: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [violations, setViolations] = useState<string[] | null>(null)

  const [orderKey, setOrderKey] = useState('')
  const [lineId, setLineId] = useState('')
  const [start, setStart] = useState(today)
  const [daily, setDaily] = useState('')
  const [total, setTotal] = useState('')
  const [smv, setSmv] = useState('')

  const order = orders.find((o) => o.orderId === orderKey) ?? null

  // eslint-disable-next-line fabricxai/no-float-money -- pieces, not money
  const perDay = Number.parseInt(daily, 10) || 0
  // eslint-disable-next-line fabricxai/no-float-money -- pieces, not money
  const want = Number.parseInt(total, 10) || order?.qty || 0

  /**
   * The run this rate implies — shown before it is committed to.
   *
   * Not memoised: it is at most 120 iterations of integer arithmetic, run on a keystroke in a
   * dialog. Wrapping it cost a dependency on a value derived from the selected order, which
   * the hooks rule correctly flags as one that changes underneath the memo.
   */
  const run = (() => {
    if (!start || perDay <= 0 || want <= 0) return null
    const days: { date: string; qty: number }[] = []
    let left = want
    const cursor = new Date(`${start}T00:00:00Z`)
    // 120 is a guard, not a rule: a rate of 1 against 18,000 pieces is a typo, and looping
    // to eighteen thousand days to discover that would hang the browser rather than say so.
    while (left > 0 && days.length < 120) {
      const qty = Math.min(perDay, left)
      days.push({ date: cursor.toISOString().slice(0, 10), qty })
      left -= qty
      cursor.setUTCDate(cursor.getUTCDate() + 1)
    }
    return { days, overflowed: left > 0 }
  })()

  /*
   * A style nobody has timed cannot be planned, and until now there was nowhere in the
   * product to time one.
   *
   * `allocate` refuses without an SMV, correctly — an invented minute-value is how a factory
   * commits to a date it cannot make. But `recordSmv` had no caller anywhere in the UI, so the
   * refusal was a dead end: every style in a fresh tenant has no SMV, so NO order could be put
   * on a line at all, and the planner was told why in a sentence they could do nothing about.
   *
   * Asked for here rather than on a settings screen because this is the moment somebody knows
   * the answer and needs it. Marked `estimate`, never `ie_study` — a number typed next to a
   * planning decision is a planner's judgement, and only an industrial engineer's stopwatch
   * earns the other label.
   */
  const needsSmv = order !== null && !order.smv && Boolean(order.styleCode)
  // eslint-disable-next-line fabricxai/no-float-money -- minutes per garment, not money
  const smvReady = !needsSmv || Number.parseFloat(smv) > 0

  const ready = order !== null && lineId !== '' && run !== null && !run.overflowed && smvReady

  function submit(acceptViolations: boolean) {
    if (!ready || !run || !order) return
    setFailure(null)

    startTransition(async () => {
      try {
        if (needsSmv && order.styleCode) {
          await recordSmv({ styleCode: order.styleCode, smv: smv.trim(), source: 'estimate' })
        }

        const result = await allocate({
          orderId: order.orderId,
          ...(order.orderStyleId ? { orderStyleId: order.orderStyleId } : {}),
          lineId,
          startDate: run.days[0]!.date,
          endDate: run.days[run.days.length - 1]!.date,
          plannedDaily: Object.fromEntries(run.days.map((d) => [d.date, d.qty])),
          ...(acceptViolations ? { acceptViolations: true } : {}),
        })

        if (!result.allocationId) {
          // Not a failure — the answer to "does this fit". Shown so the planner can shorten
          // the run, pick another line, or say yes on purpose.
          setViolations(
            result.violations.map((v) =>
              v.code === 'line_day_overloaded'
                ? `${v.facts.date ?? 'one day'} is over what this line can make`
                : `${v.facts.date ?? 'the run'}: ${v.code.replace(/_/g, ' ')}`,
            ),
          )
          return
        }

        setOpen(false)
        setViolations(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The order was not put on the line.'))
      }
    })
  }

  if (lines.length === 0) return null

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Put an order on a line
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          setViolations(null)
        }}
        width={640}
        title="Put an order on a line"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {orders.length === 0 ? (
            <InlineAlert tone="info">
              Nothing is waiting to be planned. An order appears here once it is confirmed and
              has a style with a quantity.
            </InlineAlert>
          ) : null}

          <Field label="Order">
            <select
              value={orderKey}
              onChange={(e) => {
                setOrderKey(e.target.value)
                setTotal('')
              }}
              style={SELECT}
            >
              <option value="">Choose the order</option>
              {orders.map((o) => (
                <option key={o.orderId} value={o.orderId}>
                  {o.label}
                </option>
              ))}
            </select>
          </Field>

          <Field label="Line">
            <select value={lineId} onChange={(e) => setLineId(e.target.value)} style={SELECT}>
              <option value="">Choose the line</option>
              {lines.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.code} · {l.name}
                </option>
              ))}
            </select>
          </Field>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 14 }}>
            <Field label="Starts">
              <DateInput value={start} onChange={setStart} style={SELECT} />
            </Field>
            <TextInput
              label="Pieces a day"
              inputMode="numeric"
              value={daily}
              onChange={(e) => setDaily(e.target.value)}
              hint="What this line can finish in a shift."
            />
            <TextInput
              label="Pieces in total"
              inputMode="numeric"
              value={total}
              onChange={(e) => setTotal(e.target.value)}
              hint={order ? `${order.qty.toLocaleString()} contracted` : 'The whole order by default.'}
            />
          </div>

          {needsSmv ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <InlineAlert tone="warning">
                Nobody has timed {order?.styleCode} yet. Planning needs to know how many
                minutes one garment takes to sew, or it cannot say what a line can finish in a
                day.
              </InlineAlert>
              <TextInput
                label="Minutes per garment (SMV)"
                inputMode="decimal"
                value={smv}
                onChange={(e) => setSmv(e.target.value)}
                hint="Your best estimate. It is saved against the style as an estimate, and an industrial engineer's study replaces it later."
              />
            </div>
          ) : null}

          {run ? (
            run.overflowed ? (
              <InlineAlert tone="warning">
                At {perDay.toLocaleString()} a day this run would take more than four months.
                Check the daily figure.
              </InlineAlert>
            ) : (
              <div
                style={{
                  font: "400 13px/1.6 var(--fx-font-sans)",
                  color: 'var(--fx-text-secondary)',
                  background: 'var(--fx-bg-sunken)',
                  border: '1px solid var(--fx-border-subtle)',
                  borderRadius: 'var(--fx-radius-sm)',
                  padding: '10px 12px',
                }}
              >
                {want.toLocaleString()} pieces over <strong>{run.days.length} days</strong> —{' '}
                {run.days[0]!.date} to {run.days[run.days.length - 1]!.date}. The last day makes{' '}
                {run.days[run.days.length - 1]!.qty.toLocaleString()}.
              </div>
            )
          ) : null}

          {violations ? (
            <InlineAlert tone="warning">
              This does not fit the line as planned: {violations.slice(0, 3).join('; ')}
              {violations.length > 3 ? ` and ${violations.length - 3} more` : ''}. Shorten the
              run, pick another line, or book it anyway and the board will show it as a
              decision rather than a mistake.
            </InlineAlert>
          ) : null}

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            {violations ? (
              <Button variant="secondary" disabled={pending} onClick={() => submit(true)}>
                {pending ? 'Booking…' : 'Book it anyway'}
              </Button>
            ) : null}
            <Button variant="primary" disabled={pending || !ready} onClick={() => submit(false)}>
              {pending ? 'Booking…' : 'Put it on the line'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const SELECT: React.CSSProperties = {
  font: "400 15px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  width: '100%',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>{label}</span>
      {children}
    </label>
  )
}
