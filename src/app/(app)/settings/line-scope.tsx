'use client'

import { useState, useTransition } from 'react'

import { InlineAlert, Toast } from '@/components/fx/feedback'
import { Button } from '@/components/fx/primitives'
import { ROLE_LABEL } from '@/components/shell/nav'
import { actionErrorMessage } from '@/lib/action-error'
import type { Role } from '@/modules/core/ctx'
import { setUserLineScope } from '@/modules/settings/actions'

/**
 * Which lines a person's role covers (§9, F46).
 *
 * `roles.scope.lines` has narrowed the line screens since a line chief scoped to L1/L2 saw
 * all eight, and the production service now refuses a write outside it — and until this
 * screen there was no way to set it but a database console. On the live tenant that left
 * L3–L6 belonging to no supervisor at all, and moving a chief from one line to another
 * needed a developer.
 *
 * ## Empty means the whole floor
 *
 * Not "no lines". That is how `session.ts` has always read a role with no `lines` array, and
 * it is the only reading that makes an ungranted scope harmless. The screen says it in words
 * rather than leaving an empty row of buttons to be interpreted.
 *
 * ## One unscoped role widens all the others
 *
 * A person who supervises L1/L2 and also holds `admin` sees the whole floor, because the
 * union across their roles is what they may see and an unscoped role contributes everything.
 * That is deliberate — an administrator who also runs a line should not be narrowed by the
 * narrower grant — but it means narrowing `production` here can change nothing at all, which
 * is unexplainable from the outside. So the screen says so, on the row where it is true.
 */

/**
 * The roles a line scope means anything for.
 *
 * The mechanism applies to any role, but a picker on `finance` is seventeen rows of noise for
 * a setting that changes nothing anybody would notice. These four are the ones that read the
 * line screens or write through the floor handlers.
 */
const LINE_ROLES: readonly string[] = ['production', 'quality', 'planner', 'maintenance']

export interface HeldRole {
  role: string
  /** Line codes this role is narrowed to. Empty means the whole floor. */
  lines: string[]
}

export function LineScopeControls({
  userId,
  held,
  lines,
}: {
  userId: string
  held: readonly HeldRole[]
  /** Every line code in the company, in board order. */
  lines: readonly string[]
}) {
  const scopable = held.filter((h) => LINE_ROLES.includes(h.role))
  if (scopable.length === 0 || lines.length === 0) return null

  // An unscoped role the person also holds. Narrowing anything below it changes nothing.
  const widening = held.find((h) => !LINE_ROLES.includes(h.role) && h.lines.length === 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {scopable.map((h) => (
        <RoleLines key={h.role} userId={userId} held={h} lines={lines} widenedBy={widening?.role} />
      ))}
    </div>
  )
}

function RoleLines({
  userId,
  held,
  lines,
  widenedBy,
}: {
  userId: string
  held: HeldRole
  lines: readonly string[]
  widenedBy: string | undefined
}) {
  const [pending, startTransition] = useTransition()
  const [picked, setPicked] = useState<string[]>(held.lines)
  const [failure, setFailure] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const dirty =
    picked.length !== held.lines.length || picked.some((code) => !held.lines.includes(code))

  function toggle(code: string) {
    setPicked((now) => (now.includes(code) ? now.filter((c) => c !== code) : [...now, code]))
  }

  function save() {
    setFailure(null)
    startTransition(async () => {
      try {
        // Sent in board order rather than click order, so the stored scope reads the way the
        // floor is numbered and two admins picking the same lines store the same thing.
        await setUserLineScope({
          userId,
          role: held.role as Role,
          lineCodes: lines.filter((code) => picked.includes(code)),
        })
        setDone(
          picked.length === 0
            ? `${ROLE_LABEL[held.role as Role] ?? held.role} covers the whole floor.`
            : `${ROLE_LABEL[held.role as Role] ?? held.role} covers ${lines
                .filter((code) => picked.includes(code))
                .join(', ')}.`,
        )
        setTimeout(() => setDone(null), 4000)
      } catch (error) {
        setFailure(actionErrorMessage(error, 'Those lines were not saved.'))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span
        style={{
          font: "500 11px/1 var(--fx-font-mono)",
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
        }}
      >
        Lines · {ROLE_LABEL[held.role as Role] ?? held.role}
      </span>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        {lines.map((code) => {
          const on = picked.includes(code)
          return (
            <button
              key={code}
              type="button"
              onClick={() => toggle(code)}
              aria-pressed={on}
              disabled={pending}
              style={{
                minHeight: 'var(--fx-tap-min)',
                minWidth: 46,
                padding: '6px 10px',
                borderRadius: 'var(--fx-radius-sm)',
                border: `1px solid ${on ? 'var(--fx-accent)' : 'var(--fx-border-default)'}`,
                background: on ? 'var(--fx-accent-subtle)' : 'var(--fx-bg-surface)',
                color: on ? 'var(--fx-accent)' : 'var(--fx-text-secondary)',
                font: "500 13px/1 var(--fx-font-mono)",
                cursor: pending ? 'default' : 'pointer',
              }}
            >
              {code}
            </button>
          )
        })}

        {dirty ? (
          <Button variant="ghost" size="sm" disabled={pending} onClick={save}>
            {pending ? 'Saving…' : 'Save lines'}
          </Button>
        ) : null}
      </div>

      <span style={{ font: "400 12px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
        {picked.length === 0
          ? 'None picked — this role covers the whole floor. Pick lines to narrow it.'
          : `Sees and enters ${picked.length === 1 ? 'this line' : 'these lines'} only.`}
      </span>

      {widenedBy && picked.length > 0 ? (
        <InlineAlert tone="warning">
          This person also holds {ROLE_LABEL[widenedBy as Role] ?? widenedBy}, which is not
          narrowed to any line — so they will still see the whole floor. Narrow that role too,
          or take it away, if these lines are meant to be the limit.
        </InlineAlert>
      ) : null}

      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
      {done ? <Toast message={done} /> : null}
    </div>
  )
}
