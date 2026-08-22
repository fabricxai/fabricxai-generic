'use client'

import { useState, useTransition } from 'react'

import { InlineAlert, Toast } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { setCompanyModule } from '@/modules/settings/actions'

import { MODULE_COPY } from './module-copy'

/**
 * The switches (specs/order-centric-core.md §1) — which departments this factory runs.
 *
 * Everything shown here is computed server-side from the same two reads the walls use
 * (`activeModuleIds`, the registry's dependency graph) and arrives as props; the page
 * re-renders after every flip because the action revalidates the whole shell. The
 * hints under a switch mirror the service's refusals so the owner reads "needed by
 * Store" BEFORE pressing, but the service is the wall — a hint is never the gate.
 *
 * Off is reversible and deletes nothing: rows keep their data, actions refuse, and
 * switching back on restores the module as it was. The panel says so, because an
 * owner who believes "off" means "erased" will never dare touch a switch.
 */
export interface ModuleRow {
  id: string
  enabled: boolean
  /** `settings` — the breaker box itself. Shown locked rather than hidden. */
  locked: boolean
  /** ACTIVE modules that require this one; switching off is refused while any remain. */
  activeDependents: readonly string[]
  /** Modules this one requires that are currently off; switching on needs them first. */
  missingRequires: readonly string[]
}

const nameOf = (id: string) => MODULE_COPY[id]?.label ?? id

export function ModuleControls({ rows, canEdit }: { rows: ModuleRow[]; canEdit: boolean }) {
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  function flip(row: ModuleRow, enabled: boolean) {
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await setCompanyModule({ moduleId: row.id, enabled }))
        setDone(
          enabled
            ? `${nameOf(row.id)} is on.`
            : `${nameOf(row.id)} is off. Nothing was deleted — switch it back on to restore it.`,
        )
        setTimeout(() => setDone(null), 5000)
      } catch (error) {
        setFailure(actionErrorMessage(error, 'That did not go through.'))
      }
    })
  }

  return (
    <div
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        overflow: 'hidden',
      }}
    >
      {rows.map((row, index) => {
        const copy = MODULE_COPY[row.id]
        // The graph hint that explains a switch the owner cannot press yet.
        const blockedBy = row.enabled
          ? row.activeDependents.map(nameOf)
          : row.missingRequires.map(nameOf)

        return (
          <div
            key={row.id}
            style={{
              display: 'grid',
              gridTemplateColumns: canEdit ? '2fr 3fr auto auto' : '2fr 3fr auto',
              gap: 14,
              padding: '13px 18px',
              borderTop: index === 0 ? 'none' : '1px solid var(--fx-border-subtle)',
              alignItems: 'center',
              minHeight: 'var(--fx-row-height)',
            }}
            className="fx-stack-tablet"
          >
            <span style={{ font: '500 14px/1.3 var(--fx-font-sans)' }}>
              {copy?.label ?? row.id}
            </span>

            <span
              style={{
                font: '400 13px/1.4 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
              }}
            >
              {copy?.blurb ?? ''}
              {blockedBy.length > 0 ? (
                <span style={{ display: 'block', color: 'var(--fx-text-tertiary)' }}>
                  {row.enabled
                    ? `Needed by ${blockedBy.join(', ')} — switch those off first.`
                    : `Needs ${blockedBy.join(', ')} switched on first.`}
                </span>
              ) : null}
            </span>

            <Badge tone={row.enabled ? 'success' : 'neutral'}>
              {row.enabled ? 'On' : 'Off'}
            </Badge>

            {canEdit ? (
              row.locked ? (
                <span
                  style={{
                    font: '500 11px/1 var(--fx-font-mono)',
                    letterSpacing: '.05em',
                    textTransform: 'uppercase',
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  always on
                </span>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending || blockedBy.length > 0}
                  onClick={() => flip(row, !row.enabled)}
                >
                  {row.enabled ? 'Switch off' : 'Switch on'}
                </Button>
              )
            ) : null}
          </div>
        )
      })}

      {failure ? (
        <div style={{ padding: '0 18px 13px' }}>
          <InlineAlert tone="danger">{failure}</InlineAlert>
        </div>
      ) : null}
      {done ? <Toast message={done} /> : null}
    </div>
  )
}
