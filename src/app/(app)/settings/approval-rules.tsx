'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/fx/primitives'
import { Checkbox } from '@/components/fx/forms'
import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { removeApprovalRule, setApprovalRule } from '@/modules/approvals/actions'
import type { ApprovalRuleRow } from '@/modules/approvals/queries'

/** The roles a draft can be routed to. Deliberately excludes viewer/member — they approve
 *  nothing, and offering them would build a rule nobody could satisfy. */
const APPROVER_ROLES = [
  'owner', 'admin', 'merchandiser', 'commercial', 'planner', 'store', 'procurement',
  'cutting', 'production', 'quality', 'shipment', 'maintenance', 'hr', 'compliance', 'finance',
] as const

/**
 * Who signs what (adoption plan 3.2).
 *
 * `approval_rules` decided the routing of every draft in the factory and lived only in seeds
 * and psql — the owner could not see it, let alone tune it. This is the surface: the active
 * rules, and a form to add one.
 *
 * **No condition field, anywhere.** `pickRule` matches on module, target and operation and
 * reads `condition` from nothing — a form offering "when margin < 10%" would write a rule
 * that looks like a gate and enforces nothing, which is the exact trap the day-0 seed script
 * records refusing to fall into. Conditional gates live in the services that own them.
 *
 * Owner-only to edit; the page passes `canEdit`. A non-owner sees the rules and no controls.
 */
export function ApprovalRules({
  rules,
  canEdit,
}: {
  rules: readonly ApprovalRuleRow[]
  canEdit: boolean
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)

  function remove(ruleId: string) {
    setError(null)
    startTransition(async () => {
      try {
        unwrap(await removeApprovalRule({ ruleId }))
        router.refresh()
      } catch (e) {
        setError(actionErrorMessage(e, 'The rule could not be retired.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)', margin: 0 }}>
        When a draft is raised, the narrowest matching rule decides who may approve it. A
        module with no rule falls back to its built-in default. Rules route by module, table
        and operation — never by a condition, because the engine does not read one.
      </p>

      {error ? <InlineAlert tone="danger">{error}</InlineAlert> : null}

      <div
        className="fx-scroll-x"
        tabIndex={0}
        style={{
          background: 'var(--fx-bg-surface)',
          border: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-md)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.2fr 1.4fr 2fr .7fr .8fr',
            gap: 12,
            padding: '9px 16px',
            background: 'var(--fx-bg-sunken)',
            font: "500 11px/1 var(--fx-font-mono)",
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            color: 'var(--fx-text-tertiary)',
            minWidth: 640,
          }}
        >
          <div>Module</div>
          <div>Scope</div>
          <div>Approved by</div>
          <div style={{ textAlign: 'right' }}>Signs</div>
          <div />
        </div>

        {rules.length === 0 ? (
          <div style={{ padding: '14px 16px', font: "400 13px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            No custom rules — every module uses its built-in default.
          </div>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.2fr 1.4fr 2fr .7fr .8fr',
                gap: 12,
                padding: '11px 16px',
                borderTop: '1px solid var(--fx-border-subtle)',
                alignItems: 'center',
                font: "400 13px/1.4 var(--fx-font-sans)",
                minWidth: 640,
              }}
            >
              <span data-mono style={{ font: "400 12.5px/1.3 var(--fx-font-mono)" }}>{rule.moduleId}</span>
              <span data-mono style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}>
                {rule.targetTable ?? 'whole module'}
                {rule.operation ? ` · ${rule.operation}` : ''}
              </span>
              <span>{rule.requiredRoles.join(', ')}</span>
              <span data-numeric style={{ textAlign: 'right', font: "400 13px/1.3 var(--fx-font-mono)" }}>
                {rule.approvalsRequired}
              </span>
              <span style={{ textAlign: 'right' }}>
                {canEdit ? (
                  <button
                    type="button"
                    onClick={() => remove(rule.id)}
                    disabled={pending}
                    style={{
                      font: "400 11px/1.2 var(--fx-font-mono)",
                      textTransform: 'uppercase',
                      letterSpacing: '.05em',
                      color: 'var(--fx-danger)',
                      background: 'transparent',
                      border: 'none',
                      cursor: pending ? 'default' : 'pointer',
                      padding: 0,
                    }}
                  >
                    retire
                  </button>
                ) : null}
              </span>
            </div>
          ))
        )}
      </div>

      {canEdit ? (
        adding ? (
          <RuleForm
            pending={pending}
            onCancel={() => setAdding(false)}
            onSubmit={(payload) => {
              setError(null)
              startTransition(async () => {
                try {
                  unwrap(await setApprovalRule(payload))
                  setAdding(false)
                  router.refresh()
                } catch (e) {
                  setError(actionErrorMessage(e, 'The rule could not be saved.'))
                }
              })
            }}
          />
        ) : (
          <Button variant="secondary" onClick={() => setAdding(true)}>
            Add a rule
          </Button>
        )
      ) : null}
    </div>
  )
}

interface RulePayload {
  moduleId: string
  targetTable?: string
  operation?: 'insert' | 'update' | 'delete'
  requiredRoles: string[]
  approvalsRequired: number
}

function RuleForm({
  pending,
  onSubmit,
  onCancel,
}: {
  pending: boolean
  onSubmit: (payload: RulePayload) => void
  onCancel: () => void
}) {
  const [moduleId, setModuleId] = useState('')
  const [targetTable, setTargetTable] = useState('')
  const [roles, setRoles] = useState<string[]>([])
  const [count, setCount] = useState(1)

  const ready = moduleId.trim() !== '' && roles.length > 0

  const field: React.CSSProperties = {
    background: 'var(--fx-bg-surface)',
    color: 'var(--fx-text-primary)',
    border: '1px solid var(--fx-border-default)',
    borderRadius: 'var(--fx-radius-sm)',
    padding: '9px 11px',
    font: "400 13px/1.2 var(--fx-font-mono)",
    minHeight: 'var(--fx-tap-min)',
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        padding: 16,
        border: '1px solid var(--fx-border-default)',
        borderRadius: 'var(--fx-radius-md)',
        background: 'var(--fx-bg-surface)',
      }}
    >
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: "500 12px/1 var(--fx-font-sans)" }}>Module</span>
          <input
            value={moduleId}
            onChange={(e) => setModuleId(e.target.value.trim())}
            placeholder="orders"
            style={field}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: "500 12px/1 var(--fx-font-sans)" }}>Table (optional)</span>
          <input
            value={targetTable}
            onChange={(e) => setTargetTable(e.target.value.trim())}
            placeholder="whole module if blank"
            style={{ ...field, minWidth: 200 }}
          />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={{ font: "500 12px/1 var(--fx-font-sans)" }}>Signatures</span>
          <input
            type="number"
            min={1}
            max={5}
            value={count}
            onChange={(e) => {
              // A signature COUNT, not an amount — 1 to 5 people. The money lint cannot tell
              // the difference from the call alone.
              // eslint-disable-next-line fabricxai/no-float-money
              const n = Number(e.target.value)
              setCount(Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : 1)
            }}
            style={{ ...field, width: 80 }}
          />
        </label>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ font: "500 12px/1 var(--fx-font-sans)" }}>Approved by</span>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px' }}>
          {APPROVER_ROLES.map((role) => (
            <Checkbox
              key={role}
              label={role}
              checked={roles.includes(role)}
              onChange={(on) =>
                setRoles((current) =>
                  on ? [...current, role] : current.filter((r) => r !== role),
                )
              }
            />
          ))}
        </div>
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <Button
          disabled={!ready || pending}
          onClick={() =>
            onSubmit({
              moduleId,
              targetTable: targetTable || undefined,
              requiredRoles: roles,
              approvalsRequired: count,
            })
          }
        >
          Save rule
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
