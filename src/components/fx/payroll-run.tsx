'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { Badge, Button } from '@/components/fx/primitives'
import { approveRun, runPayroll } from '@/modules/workforce/actions'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'

/** The two festivals a Bangladeshi factory pays a bonus for. */
const FESTIVALS = [
  { key: '', label: 'no festival this month' },
  { key: 'eid_ul_fitr', label: 'Eid ul-Fitr' },
  { key: 'eid_ul_adha', label: 'Eid ul-Adha' },
] as const

interface OpenRun {
  id: string
  period: string
  status: string
  totalNet: string | null
  lineCount: number | null
}

/**
 * Computing and approving a payroll period.
 *
 * **Compute and approve are deliberately separate people.** HR computes; the owner signs
 * off what two thousand people are paid, and the service enforces that as its own check
 * rather than folding it into payroll access. A single button doing both would collapse the
 * one control that matters here.
 *
 * **A run is recomputable until it is approved.** Attendance corrections arrive late — a
 * device missed a punch, a supervisor filed a leave a day after the fact — and a payroll
 * that had to be deleted and rebuilt would lose the record of what was computed before.
 * After approval the figures are fixed: a change is a fresh period adjustment, because a
 * payslip already in somebody's hand cannot be quietly rewritten.
 */
export function PayrollRunControl({
  defaultPeriod,
  openRun,
  canApprove,
}: {
  defaultPeriod: string
  openRun: OpenRun | null
  canApprove: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [period, setPeriod] = useState(defaultPeriod)
  const [festival, setFestival] = useState<string>('')
  const [noted, setNoted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  function run(work: () => Promise<string>) {
    setFailure(null)
    startTransition(async () => {
      try {
        setNoted(await work())
        router.refresh()
      } catch (error) {
        // `assertPayrollAccess` throws with an EMPTY message on purpose — naming the role
        // it wanted would confirm the endpoint exists and name the role worth phishing for.
        // So the UI supplies that wording. `actionErrorMessage` keeps the behaviour (an
        // empty message falls through to the fallback) while giving every OTHER payroll
        // refusal — a run that cannot be recomputed, a superseded gazette — its own sentence
        // instead of a dotted key.
        setFailure(actionErrorMessage(error, 'You do not have access to payroll.'))
      }
    })
  }

  const approvable = openRun !== null && openRun.status === 'computed'

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        padding: '16px 20px',
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        marginBottom: 14,
      }}
    >
      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '0 1 170px' }}>
          <span style={label}>Period</span>
          <input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value)}
            style={control}
          />
        </label>

        <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '0 1 220px' }}>
          <span style={label}>Festival bonus</span>
          <select value={festival} onChange={(e) => setFestival(e.target.value)} style={control}>
            {FESTIVALS.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
        </label>

        <Button
          variant="secondary"
          disabled={pending || !period}
          onClick={() =>
            run(async () => {
              const r = unwrap(
                await runPayroll({
                  period,
                  ...(festival ? { festival } : {}),
                }),
              )
              return `${r.lines} workers computed · ${r.totalNet} net${
                r.flagged > 0 ? ` · ${r.flagged} flagged for a look` : ''
              }.`
            })
          }
        >
          {openRun ? 'Recompute the run' : 'Compute the run'}
        </Button>

        <Button
          variant="primary"
          disabled={pending || !approvable || !canApprove}
          onClick={() =>
            run(async () => {
              const r = unwrap(await approveRun({ runId: openRun!.id }))
              return `Run approved (${r.from} → ${r.to}). The figures are fixed from here.`
            })
          }
        >
          Approve the run
        </Button>

        {openRun ? (
          <Badge tone={openRun.status === 'approved' ? 'success' : 'neutral'}>
            {openRun.period} · {openRun.status}
          </Badge>
        ) : null}
      </div>

      <span style={{ font: "400 12px/1.6 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
        {!canApprove
          ? 'HR computes; only an owner can approve what the factory pays — the server enforces that separately from payroll access.'
          : approvable
            ? 'recomputable until approved, because attendance corrections arrive late; fixed afterwards, because a payslip in somebody’s hand cannot be rewritten'
            : 'compute the period first — a run is built from the gazette in force and the attendance on file'}
      </span>
    </div>
  )
}

const label: React.CSSProperties = {
  font: "400 10.5px/1 var(--fx-font-mono)",
  letterSpacing: '.05em',
  textTransform: 'uppercase',
  color: 'var(--fx-text-tertiary)',
}

const control: React.CSSProperties = {
  minHeight: 40,
  minWidth: 0,
  padding: '8px 11px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 13.5px/1.4 var(--fx-font-sans)",
}
