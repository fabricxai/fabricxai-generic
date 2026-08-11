'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition, type CSSProperties } from 'react'

import { Card } from '@/components/fx/data'
import { InlineAlert } from '@/components/fx/feedback'
import { Badge, Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { saveModulePolicy } from '@/modules/settings/actions'

import {
  fieldsForModule,
  moduleBlurb,
  type PolicyFieldCopy,
  type PolicyFieldKind,
} from './policy-copy'

/**
 * One module's policy as a plain-language form.
 *
 * Values still patch through `saveModulePolicy` (zod on the server). Nested
 * objects are replaced wholesale — when a child field saves, the whole parent
 * object is sent with the updated path.
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
  const [failure, setFailure] = useState<string | null>(null)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')

  const fields = useMemo(() => {
    const known = fieldsForModule(moduleId)
    if (known.length > 0) return known
    return Object.keys(effective).map(
      (key): PolicyFieldCopy => ({
        key,
        label: key,
        help: 'Technical key — label not written yet.',
        kind: inferKind(effective[key]),
      }),
    )
  }, [moduleId, effective])

  const overridden = Object.keys(overrides).length
  const blurb = moduleBlurb(moduleId)

  function fieldId(field: PolicyFieldCopy): string {
    return field.path ? `${field.key}.${field.path}` : field.key
  }

  function readValue(field: PolicyFieldCopy): unknown {
    if (!field.path) return effective[field.key]
    return getPath(effective[field.key], field.path)
  }

  function beginEdit(field: PolicyFieldCopy) {
    if (!canEdit) return
    const value = readValue(field)
    setEditing(fieldId(field))
    setDraft(toDraft(value, field.kind))
    setFailure(null)
  }

  function save(field: PolicyFieldCopy) {
    const parsed = parseDraft(draft, field.kind, readValue(field))
    if (!parsed.ok) {
      setFailure(parsed.error)
      return
    }

    let patchValue: unknown = parsed.value
    if (field.path) {
      const parent = structuredCloneSafe(effective[field.key])
      if (parent === null || typeof parent !== 'object' || Array.isArray(parent)) {
        setFailure(`Cannot edit ${field.label} — the parent value is missing.`)
        return
      }
      setPath(parent as Record<string, unknown>, field.path, parsed.value)
      patchValue = parent
    }

    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await saveModulePolicy({ moduleId, patch: { [field.key]: patchValue } }))
        setEditing(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The rule was not saved.'))
      }
    })
  }

  function clearOverride(field: PolicyFieldCopy) {
    const key = field.key
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await saveModulePolicy({ moduleId, patch: { [key]: null } }))
        setEditing(null)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The override was not cleared.'))
      }
    })
  }

  return (
    <Card padding="18px 20px">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
        <span style={{ font: '600 16px/1.3 var(--fx-font-sans)' }}>{label}</span>
        <span style={{ marginLeft: 'auto' }}>
          {unresolvable ? (
            <Badge tone="danger">will not resolve</Badge>
          ) : overridden > 0 ? (
            <Badge tone="info">{overridden} customised</Badge>
          ) : (
            <Badge>recommended defaults</Badge>
          )}
        </span>
      </div>

      {blurb ? (
        <p
          style={{
            margin: '8px 0 0',
            font: '400 13.5px/1.5 var(--fx-font-sans)',
            color: 'var(--fx-text-secondary)',
            textWrap: 'pretty',
            maxWidth: '70ch',
          }}
        >
          {blurb}
        </p>
      ) : null}

      {unresolvable ? (
        <div
          style={{
            marginTop: 12,
            font: '400 13px/1.55 var(--fx-font-sans)',
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

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, marginTop: 16 }}>
        {fields.map((field) => {
          const id = fieldId(field)
          const value = readValue(field)
          const isOverride = field.key in overrides
          const isEditing = editing === id

          return (
            <div
              key={id}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(0, 1.4fr) minmax(0, 1fr)',
                gap: 12,
                alignItems: 'start',
              }}
              className="fx-stack-tablet"
            >
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
                <span style={{ font: '600 13.5px/1.3 var(--fx-font-sans)' }}>{field.label}</span>
                <span
                  style={{
                    font: '400 12.5px/1.45 var(--fx-font-sans)',
                    color: 'var(--fx-text-tertiary)',
                    textWrap: 'pretty',
                  }}
                >
                  {field.help}
                </span>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
                {isEditing ? (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
                    <FieldInput
                      kind={field.kind}
                      unit={field.unit}
                      min={field.min}
                      max={field.max}
                      step={field.step}
                      value={draft}
                      onChange={setDraft}
                      onEnter={() => save(field)}
                      onEscape={() => setEditing(null)}
                    />
                    <Button variant="secondary" disabled={pending} onClick={() => save(field)}>
                      Save
                    </Button>
                    {isOverride ? (
                      <Button variant="ghost" disabled={pending} onClick={() => clearOverride(field)}>
                        Back to default
                      </Button>
                    ) : (
                      <Button variant="ghost" disabled={pending} onClick={() => setEditing(null)}>
                        Cancel
                      </Button>
                    )}
                  </div>
                ) : canEdit ? (
                  <button
                    type="button"
                    onClick={() => beginEdit(field)}
                    title="Click to change"
                    style={{
                      all: 'unset',
                      cursor: 'pointer',
                      font: '500 14px/1.35 var(--fx-font-sans)',
                      color: isOverride ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
                      textDecorationLine: 'underline',
                      textDecorationStyle: 'dotted',
                      textUnderlineOffset: 3,
                    }}
                  >
                    {formatDisplay(value, field)}
                    {isOverride ? (
                      <span style={{ color: 'var(--fx-text-tertiary)', marginLeft: 8 }}>(set)</span>
                    ) : null}
                  </button>
                ) : (
                  /*
                   * A span, not a disabled button (day-one finding D5).
                   *
                   * It looked right either way — the dotted underline was already dropped
                   * when `canEdit` is false — but the ELEMENT was still a button, so a
                   * storekeeper's settings page announced twenty-four disabled buttons to a
                   * screen reader and put twenty-four dead stops in the tab order. A value
                   * somebody may only read is text.
                   */
                  <span
                    style={{
                      font: '500 14px/1.35 var(--fx-font-sans)',
                      color: isOverride ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
                    }}
                  >
                    {formatDisplay(value, field)}
                    {isOverride ? (
                      <span style={{ color: 'var(--fx-text-tertiary)', marginLeft: 8 }}>(set)</span>
                    ) : null}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </Card>
  )
}

function FieldInput({
  kind,
  unit,
  min,
  max,
  step,
  value,
  onChange,
  onEnter,
  onEscape,
}: {
  kind: PolicyFieldKind
  unit?: string
  min?: number
  max?: number
  step?: string
  value: string
  onChange: (v: string) => void
  onEnter: () => void
  onEscape: () => void
}) {
  if (kind === 'boolean') {
    return (
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus
        style={controlStyle}
      >
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    )
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <input
        type="text"
        inputMode={kind === 'text' || kind === 'string-list' ? 'text' : 'decimal'}
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onEnter()
          if (e.key === 'Escape') onEscape()
        }}
        autoFocus
        style={{
          ...controlStyle,
          width: kind === 'string-list' || kind === 'text' ? 220 : 120,
        }}
      />
      {unit ? (
        <span style={{ font: '400 12px/1 var(--fx-font-mono)', color: 'var(--fx-text-tertiary)' }}>
          {unit}
        </span>
      ) : null}
    </span>
  )
}

const controlStyle: CSSProperties = {
  font: '500 13px/1.3 var(--fx-font-sans)',
  padding: '8px 10px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}

function formatDisplay(value: unknown, field: PolicyFieldCopy): string {
  if (value === null || value === undefined || value === '') return 'Not set'
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  if (Array.isArray(value)) return value.join(', ')
  if (typeof value === 'object') return JSON.stringify(value)

  const raw = String(value)
  if (
    field.unit &&
    (field.kind === 'percent' ||
      field.kind === 'number' ||
      field.kind === 'decimal' ||
      field.kind === 'days' ||
      field.kind === 'hours' ||
      field.kind === 'minutes')
  ) {
    return `${raw} ${field.unit}`
  }
  return raw
}

function toDraft(value: unknown, kind: PolicyFieldKind): string {
  if (value === null || value === undefined) return ''
  if (kind === 'boolean') return value ? 'yes' : 'no'
  if (kind === 'string-list' && Array.isArray(value)) return value.join(', ')
  if (kind === 'number-list' && Array.isArray(value)) return value.join(', ')
  return String(value)
}

function parseDraft(
  draft: string,
  kind: PolicyFieldKind,
  current: unknown,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = draft.trim()

  if (kind === 'boolean') {
    return { ok: true, value: trimmed.toLowerCase() === 'yes' || trimmed.toLowerCase() === 'true' }
  }

  if (kind === 'string-list') {
    return {
      ok: true,
      value: trimmed ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : [],
    }
  }

  if (kind === 'number-list') {
    const parts = trimmed ? trimmed.split(',').map((s) => s.trim()).filter(Boolean) : []
    const nums = parts.map(Number)
    if (nums.some((n) => Number.isNaN(n))) {
      return { ok: false, error: 'Use a comma-separated list of numbers.' }
    }
    return { ok: true, value: nums }
  }

  if (kind === 'text') {
    return { ok: true, value: trimmed }
  }

  if (kind === 'percent' || kind === 'decimal') {
    if (!trimmed) return { ok: true, value: undefined }
    if (!/^\d{1,10}(\.\d{1,4})?$/.test(trimmed)) {
      return { ok: false, error: 'Enter a number such as 10 or 2.5.' }
    }
    return { ok: true, value: trimmed }
  }

  if (
    kind === 'number' ||
    kind === 'days' ||
    kind === 'hours' ||
    kind === 'minutes' ||
    kind === 'money'
  ) {
    if (!trimmed) {
      return { ok: true, value: typeof current === 'number' ? current : undefined }
    }
    const n = Number(trimmed)
    if (Number.isNaN(n)) return { ok: false, error: `"${draft}" is not a number.` }
    return { ok: true, value: n }
  }

  return { ok: true, value: trimmed }
}

function inferKind(value: unknown): PolicyFieldKind {
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return 'number'
  if (Array.isArray(value)) return 'string-list'
  return 'text'
}

function getPath(root: unknown, path: string): unknown {
  if (root === null || root === undefined) return undefined
  const parts = path.split('.')
  let cur: unknown = root
  for (const part of parts) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function setPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur: Record<string, unknown> = root
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i]!
    const next = cur[part]
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cur[part] = {}
    }
    cur = cur[part] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]!] = value
}

function structuredCloneSafe(value: unknown): unknown {
  if (value === null || value === undefined) return {}
  try {
    return structuredClone(value)
  } catch {
    return JSON.parse(JSON.stringify(value)) as unknown
  }
}
