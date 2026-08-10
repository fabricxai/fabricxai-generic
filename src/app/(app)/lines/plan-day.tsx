'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { DateInput, TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { factoryToday } from '@/lib/dates'
import { planTheLine } from '@/modules/production/actions'

interface LineChoice {
  id: string
  code: string
}

interface OrderChoice {
  id: string
  label: string
}

/**
 * Planning a line's day (live-test finding, Phase 6).
 *
 * `daily_line_plans` had no origin outside the seed, and it is the record every floor
 * write hangs off — hourly outputs take their orderId from it, the board its targets,
 * the day-close its SMV and manpower. A floor without a plan reports numbers that attach
 * to nothing.
 */
export function PlanDayButton({
  lines,
  orders,
}: {
  lines: readonly LineChoice[]
  orders: readonly OrderChoice[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  const [lineId, setLineId] = useState('')
  const [orderId, setOrderId] = useState('')
  const [planDate, setPlanDate] = useState(factoryToday())
  const [target, setTarget] = useState('')
  const [manpower, setManpower] = useState('')
  const [smv, setSmv] = useState('')

  const ready =
    lineId !== '' && orderId !== '' && planDate !== '' && Number(target) > 0 && Number(manpower) > 0

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        unwrap(
          await planTheLine({
            lineId,
            orderId,
            planDate,
            targetPerHour: Number(target),
            manpowerPlanned: Number(manpower),
            ...(smv.trim() ? { smv: smv.trim() } : {}),
          }),
        )
        setNoted(`${lines.find((l) => l.id === lineId)?.code ?? 'The line'} is planned.`)
        setLineId('')
        setTarget('')
        setManpower('')
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The day was not planned.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Plan the day
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Plan a line's day">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Line</span>
              <select value={lineId} onChange={(e) => setLineId(e.target.value)} style={control}>
                <option value="">Choose the line</option>
                {lines.map((line) => (
                  <option key={line.id} value={line.id}>
                    {line.code}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Runs</span>
              <select value={orderId} onChange={(e) => setOrderId(e.target.value)} style={control}>
                <option value="">Choose the order</option>
                {orders.map((order) => (
                  <option key={order.id} value={order.id}>
                    {order.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Date</span>
              <DateInput
                value={planDate}
                onChange={setPlanDate}
                style={control}
              />
            </label>
            <TextInput
              label="Target /hr"
              mono
              inputMode="numeric"
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <TextInput
              label="Manpower"
              mono
              inputMode="numeric"
              value={manpower}
              onChange={(e) => setManpower(e.target.value)}
            />
            <TextInput
              label="SMV (min)"
              mono
              inputMode="decimal"
              placeholder="18.40"
              value={smv}
              onChange={(e) => setSmv(e.target.value)}
            />
          </div>

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            Everything the floor reports hangs off this: hourly output takes its order from
            the plan, the board its targets, the day&rsquo;s efficiency its SMV and
            manpower. Re-planning the same line and date corrects the plan, it does not
            stack a second one.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Done
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Plan it
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
