'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal, Toast } from '@/components/fx/feedback'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { DateInput } from '@/components/fx/forms'
import { actionErrorMessage } from '@/lib/action-error'
import { moveAllocation, setAllocationStatus } from '@/modules/planning/actions'
// From `capacity.ts`, which is pure. Importing the SERVICE here would pull the database
// client — and `postgres` — into the browser bundle; the build reports that as a missing
// `fs`, several files away from the cause.
import { allocationMachine, type AllocationStatus } from '@/modules/planning/capacity'
import { unwrap } from '@/lib/action-failure'

/** What the board row already holds. */
export interface RunSummary {
  id: string
  lineCode: string
  styleCode: string | null
  startDate: string
  endDate: string
  plannedDaily: Record<string, number>
  plannedTotal: number
  status: string
}

/**
 * Moving a run, and marking it started or finished (plan 5.4, audit FE-S7).
 *
 * The board rendered committed pieces per line-day and offered no way to commit or move any.
 * `allocate`, `moveAllocation` and `setAllocationStatus` were reachable only from the approve
 * inbox's scenario commit handler, so a planner could see a line was over-committed and could
 * not take the work off it.
 *
 * ## The overload is shown before it is accepted, never after
 *
 * `moveAllocation` with `preview: true` writes nothing and returns the violations. A planner
 * moving work off an overloaded line is deciding by comparing two boards, and the second one
 * has to be visible before they commit to it. Accepting the violations is a separate,
 * explicit click — and it is stored on the row, so the next reader knows the line was
 * over-committed on purpose rather than by accident.
 *
 * ## Buttons, not drag
 *
 * A drag on a fourteen-day grid is a gesture that fails silently on a tablet and cannot be
 * undone. The plan says drag comes after plain buttons, and this is the plain buttons.
 */
export function RunActions({ run, canWrite }: { run: RunSummary; canWrite: boolean }) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [moving, setMoving] = useState(false)
  const [startDate, setStartDate] = useState(run.startDate)
  const [endDate, setEndDate] = useState(run.endDate)
  const [violations, setViolations] = useState<{ messageKey: string; facts: Record<string, string | number> }[] | null>(null)
  const [fits, setFits] = useState<boolean | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  if (!canWrite) return null

  const next = allocationMachine.next(run.status as AllocationStatus)

  function flash(message: string) {
    setToast(message)
    setTimeout(() => setToast(null), 5200)
  }

  /**
   * The days, respread evenly over the new window.
   *
   * Deliberately simple and deliberately visible in the result: the server re-checks every
   * line-day against what is committed there, so an even spread that does not fit comes back
   * as violations rather than as a plan somebody has to discover is wrong later.
   */
  function respread(from: string, to: string): Record<string, number> {
    const start = Date.parse(`${from}T00:00:00Z`)
    const end = Date.parse(`${to}T00:00:00Z`)
    if (Number.isNaN(start) || Number.isNaN(end) || end < start) return {}

    const days = Math.round((end - start) / 86_400_000) + 1
    // eslint-disable-next-line fabricxai/no-float-money -- PIECES, not money; the rule reads the "total" stem and is right to, and integer division is exactly what a piece count wants
    const each = Math.floor(run.plannedTotal / days)
    // The remainder goes on the FIRST day rather than being dropped — a respread that lost
    // pieces would quietly reduce what the line is committed to make.
    // eslint-disable-next-line fabricxai/no-float-money -- the same piece count; whole garments, so the remainder is exact
    const remainder = run.plannedTotal - each * days

    return Object.fromEntries(
      Array.from({ length: days }, (_, i) => [
        new Date(start + i * 86_400_000).toISOString().slice(0, 10),
        i === 0 ? each + remainder : each,
      ]),
    )
  }

  function check() {
    setFailure(null)
    startTransition(async () => {
      try {
        const result = unwrap(
          await moveAllocation({
            allocationId: run.id,
            startDate,
            endDate,
            plannedDaily: respread(startDate, endDate),
            preview: true,
          }),
        )
        setFits(result.fits)
        setViolations(result.violations)
      } catch (error) {
        setViolations(null)
        setFits(null)
        setFailure(actionErrorMessage(error, t('ui.planning.check_failed'), locale))
      }
    })
  }

  function commit(acceptViolations: boolean) {
    setFailure(null)
    startTransition(async () => {
      try {
        const result = unwrap(
          await moveAllocation({
            allocationId: run.id,
            startDate,
            endDate,
            plannedDaily: respread(startDate, endDate),
            acceptViolations,
          }),
        )

        if (!result.allocationId) {
          // Nothing was written — the plan did not fit and the violations were not accepted.
          setFits(false)
          setViolations(result.violations)
          return
        }

        setMoving(false)
        flash(
          acceptViolations
            ? t('ui.planning.moved_over', { count: result.violations.length })
            : t('ui.planning.moved'),
        )
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.planning.move_failed'), locale))
      }
    })
  }

  function advance(status: AllocationStatus) {
    setFailure(null)
    startTransition(async () => {
      try {
        await setAllocationStatus({ allocationId: run.id, status })
        flash(t('ui.planning.status_set', { status: t(`ui.planning.status_${status}`) }))
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.planning.status_failed'), locale))
      }
    })
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
        <Button variant="ghost" size="sm" onClick={() => setMoving(true)} disabled={pending}>
          {t('ui.planning.move')}
        </Button>
        {next.map((status: AllocationStatus) => (
          <Button
            key={status}
            variant="ghost"
            size="sm"
            onClick={() => advance(status)}
            disabled={pending}
          >
            {t(`ui.planning.mark_${status}`)}
          </Button>
        ))}
      </div>

      <Modal
        open={moving}
        onClose={() => setMoving(false)}
        title={t('ui.planning.move_title', { style: run.styleCode ?? run.lineCode })}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <span style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
            {t('ui.planning.move_body', { total: run.plannedTotal })}
          </span>

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {t('ui.planning.from')}
              </span>
              <DateInput
                value={startDate}
                onChange={(next) => {
                  setStartDate(next)
                  setViolations(null)
                  setFits(null)
                }}
                style={dateStyle}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>
                {t('ui.planning.to')}
              </span>
              <DateInput
                value={endDate}
                onChange={(next) => {
                  setEndDate(next)
                  setViolations(null)
                  setFits(null)
                }}
                style={dateStyle}
              />
            </label>
          </div>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          {violations !== null ? (
            fits ? (
              <InlineAlert tone="info">{t('ui.planning.fits')}</InlineAlert>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <InlineAlert tone="warning">
                  {t('ui.planning.does_not_fit', { count: violations.length })}
                </InlineAlert>
                <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflowY: 'auto' }}>
                  {violations.map((v, i) => (
                    <li
                      key={`${v.messageKey}-${i}`}
                      style={{
                        font: "400 12.5px/1.5 var(--fx-font-mono)",
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {/*
                        * The facts, not a translated sentence. Planning violations carry an
                        * i18n key each and the catalogue answers them one at a time —
                        * rendering a key with no copy would put a dotted identifier in front
                        * of a planner, and the numbers are what the decision rests on.
                        */}
                      {Object.entries(v.facts)
                        .map(([name, value]) => `${name} ${value}`)
                        .join(' · ')}
                    </li>
                  ))}
                </ul>
              </div>
            )
          ) : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => setMoving(false)}>
              {t('ui.common.cancel')}
            </Button>
            <Button variant="secondary" onClick={check} disabled={pending}>
              {t('ui.planning.check')}
            </Button>
            {violations !== null && !fits ? (
              // A separate, explicit click. Over-committing a line is a decision, and it is
              // stored on the row so the next reader knows it was one.
              <Button variant="secondary" onClick={() => commit(true)} disabled={pending}>
                {t('ui.planning.move_anyway')}
              </Button>
            ) : null}
            <Button
              variant="primary"
              onClick={() => commit(false)}
              // Only once it has been checked and fits: the whole point of the preview is
              // that nobody moves work onto a line without seeing what it does there.
              disabled={pending || fits !== true}
            >
              {t('ui.planning.move_it')}
            </Button>
          </div>
        </div>
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', left: 28, bottom: 28, zIndex: 60, maxWidth: 460 }}>
          <Toast message={toast} />
        </div>
      ) : null}
    </>
  )
}

const dateStyle: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-mono)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}
