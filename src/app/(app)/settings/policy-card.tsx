'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { Card } from '@/components/fx/data'
import { InlineAlert } from '@/components/fx/feedback'
import { Badge, Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { saveModulePolicy } from '@/modules/settings/actions'

/**
 * One module's policy, finally editable where it is shown.
 *
 * `saveModulePolicy` had the role gate, the per-module zod validation and the layout
 * revalidation — and no screen called it, so every policy in the product could be read in
 * Settings and changed only by seeding. A live tester needed `btbLimitPct` at 70 to run a
 * headroom trap and found a card with no controls.
 *
 * Editing is per key: click a value, type, save. The patch is validated server-side
 * against the module's own schema, so a nonsense value comes back as the validator's
 * sentence — the input here only decides the TYPE (a number stays a number).
 */
export function PolicyCard({
  moduleId,
  label,
  effective,
  overrides,
  unresolvable,
  canEdit,
}: {
  moduleId: string
  label: string
  effective: Record<string, unknown>
  overrides: Record<string, unknown>
  unresolvable: string | null
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [failure, setFailure] = useState<string | null>(null)

  const overridden = Object.keys(overrides).length

  function beginEdit(key: string, value: unknown) {
    if (!canEdit) return
    setEditingKey(key)
    setDraft(value === null || value === undefined ? '' : String(value))
    setFailure(null)
  }

  function save(key: string) {
    const current = effective[key]
    // The server validates against the module's zod; this only preserves the TYPE the
    // key already has, so "70" reaches a numeric field as 70 and not as a string.
    let next: unknown = draft.trim()
    if (typeof current === 'number') {
      next = Number(draft)
      if (Number.isNaN(next)) {
        setFailure(`"${draft}" is not a number, and ${key} is one.`)
        return
      }
    } else if (typeof current === 'boolean') {
      next = draft.trim().toLowerCase() === 'true' || draft.trim().toLowerCase() === 'yes'
    }

    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await saveModulePolicy({ moduleId, patch: { [key]: next } }))
        setEditingKey(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The policy was not saved.'))
      }
    })
  }

  function clearOverride(key: string) {
    setFailure(null)
    startTransition(async () => {
      try {
        // null clears the override back to the default — the only way to say "go back
        // to whatever the system recommends" without knowing what that value is.
        unwrap(await saveModulePolicy({ moduleId, patch: { [key]: null } }))
        setEditingKey(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The override was not cleared.'))
      }
    })
  }

  return (
    <Card padding="18px 20px">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ font: "600 15px/1.3 var(--fx-font-sans)" }}>{label}</span>
        <span
          data-mono
          style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
        >
          {moduleId}
        </span>
        {/* Effective and overridden are shown apart, because a deliberate 2% and a
            default 2% are different answers to the question asked when the number turns
            out to be wrong. */}
        <span style={{ marginLeft: 'auto' }}>
          {unresolvable ? (
            <Badge tone="danger">will not resolve</Badge>
          ) : overridden > 0 ? (
            <Badge tone="info">{overridden} overridden</Badge>
          ) : (
            <Badge>all defaults</Badge>
          )}
        </span>
      </div>

      {/* Says which value is wrong and where, because the person reading this is the
          one who has to correct it. */}
      {unresolvable ? (
        <div
          style={{
            marginTop: 12,
            font: "400 13px/1.55 var(--fx-font-sans)",
            color: 'var(--fx-danger)',
            textWrap: 'pretty',
          }}
        >
          {unresolvable}
        </div>
      ) : null}

      {failure ? (
        <div style={{ marginTop: 12 }}>
          <InlineAlert tone="danger">{failure}</InlineAlert>
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 10,
          marginTop: 14,
        }}
      >
        {Object.entries(effective).map(([key, value]) => {
          const isOverride = key in overrides
          const editing = editingKey === key

          return (
            <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span
                style={{
                  font: "400 11.5px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {key}
              </span>

              {editing ? (
                <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') save(key)
                      if (e.key === 'Escape') setEditingKey(null)
                    }}
                    autoFocus
                    style={{
                      font: "500 13px/1.3 var(--fx-font-mono)",
                      padding: '6px 8px',
                      width: 110,
                      border: '1px solid var(--fx-border-default)',
                      borderRadius: 'var(--fx-radius-sm)',
                      background: 'var(--fx-bg-surface)',
                      color: 'var(--fx-text-primary)',
                    }}
                  />
                  <Button variant="secondary" disabled={pending} onClick={() => save(key)}>
                    Save
                  </Button>
                  {isOverride ? (
                    <Button variant="ghost" disabled={pending} onClick={() => clearOverride(key)}>
                      Back to default
                    </Button>
                  ) : (
                    <Button variant="ghost" disabled={pending} onClick={() => setEditingKey(null)}>
                      Cancel
                    </Button>
                  )}
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => beginEdit(key, value)}
                  disabled={!canEdit}
                  title={canEdit ? 'Click to change' : undefined}
                  data-numeric
                  style={{
                    all: 'unset',
                    cursor: canEdit ? 'pointer' : 'default',
                    font: "500 13px/1.3 var(--fx-font-mono)",
                    color: isOverride ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
                    ...(canEdit
                      ? { textDecorationLine: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 3 }
                      : {}),
                  }}
                >
                  {formatValue(value)}
                  {isOverride ? (
                    <span style={{ color: 'var(--fx-text-tertiary)', marginLeft: 6 }}>(set)</span>
                  ) : null}
                </button>
              )}
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}
