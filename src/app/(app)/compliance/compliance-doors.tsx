'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { factoryToday } from '@/lib/dates'
import { logAudit, raiseCap } from '@/modules/compliance/actions'

/**
 * The compliance desk's missing doors (live-test finding, Phase 9).
 *
 * Six complete service operations and not one write surface: an audit visit could not be
 * recorded, so a finding could not exist, so a CAP could never be opened — the whole
 * corrective-action machinery hung off records the product could not create.
 */

interface FindingDraft {
  key: string
  severity: 'critical' | 'major' | 'minor' | 'observation'
  clause: string
  description: string
}

export function LogAuditButton() {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  const [regime, setRegime] = useState('bsci')
  const [auditor, setAuditor] = useState('')
  const [auditedOn, setAuditedOn] = useState(factoryToday())
  const [findings, setFindings] = useState<FindingDraft[]>([blankFinding()])

  const filled = findings.filter((f) => f.description.trim())
  const ready = auditor.trim() !== '' && auditedOn !== '' && filled.length > 0

  function patch(key: string, p: Partial<FindingDraft>) {
    setFindings((c) => c.map((f) => (f.key === key ? { ...f, ...p } : f)))
  }

  function submit() {
    if (!ready) return
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(
          await logAudit({
            regime,
            auditor: auditor.trim(),
            auditedOn,
            findings: filled.map((f) => ({
              description: f.description.trim(),
              severity: f.severity,
              ...(f.clause.trim() ? { clause: f.clause.trim() } : {}),
            })),
          }),
        )
        setNoted(
          `Audit recorded with ${filled.length} finding${filled.length === 1 ? '' : 's'}. Open a CAP against each one below.`,
        )
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The audit was not recorded.'))
      }
    })
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Log an audit
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Log an audit and its findings">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}

          <div
            className="fx-stack-tablet"
            style={{ display: 'grid', gridTemplateColumns: '150px 1fr 160px', gap: 12 }}
          >
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={fieldLabel}>Regime</span>
              <select value={regime} onChange={(e) => setRegime(e.target.value)} style={control}>
                <option value="bsci">BSCI</option>
                <option value="sedex">Sedex</option>
                <option value="rsc">RSC</option>
                <option value="buyer">Buyer audit</option>
                <option value="government">Government</option>
              </select>
            </label>
            <TextInput
              label="Auditor"
              placeholder="Amfori BSCI · TÜV Rheinland"
              value={auditor}
              onChange={(e) => setAuditor(e.target.value)}
            />
            <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={fieldLabel}>Audited on</span>
              <input
                type="date"
                value={auditedOn}
                onChange={(e) => setAuditedOn(e.target.value)}
                style={control}
              />
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {findings.map((f) => (
              <div
                key={f.key}
                style={{ display: 'grid', gridTemplateColumns: '130px 110px 1fr', gap: 8 }}
              >
                <select
                  value={f.severity}
                  onChange={(e) => patch(f.key, { severity: e.target.value as FindingDraft['severity'] })}
                  style={control}
                >
                  <option value="critical">critical</option>
                  <option value="major">major</option>
                  <option value="minor">minor</option>
                  <option value="observation">observation</option>
                </select>
                <input
                  placeholder="clause"
                  value={f.clause}
                  onChange={(e) => patch(f.key, { clause: e.target.value })}
                  style={control}
                />
                <input
                  placeholder="What the auditor found, as written"
                  value={f.description}
                  onChange={(e) => patch(f.key, { description: e.target.value })}
                  style={control}
                />
              </div>
            ))}
            <Button variant="ghost" onClick={() => setFindings((c) => [...c, blankFinding()])}>
              ＋ finding
            </Button>
          </div>

          <p style={{ margin: 0, font: "400 12.5px/1.6 var(--fx-font-sans)", color: 'var(--fx-text-tertiary)' }}>
            The findings land open, each with the regime&rsquo;s own correction window. A CAP
            is opened against a finding, never typed free-floating — the deadline comes from
            the regime and the audit date unless you set one.
          </p>

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Done
            </Button>
            <Button variant="primary" disabled={pending || !ready} onClick={submit}>
              Record the audit
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const blankFinding = (): FindingDraft => ({
  key: crypto.randomUUID(),
  severity: 'major',
  clause: '',
  description: '',
})

/** One tap on a bare finding: the CAP exists, owned by the person who opened it. */
export function RaiseCapButton({ findingId }: { findingId: string }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)

  function raise() {
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await raiseCap({ findingId }))
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The CAP was not opened.'))
      }
    })
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      <Button variant="secondary" disabled={pending} onClick={raise}>
        Open a CAP
      </Button>
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
    </span>
  )
}

const fieldLabel: React.CSSProperties = { font: "500 13px/1.3 var(--fx-font-sans)" }

const control: React.CSSProperties = {
  font: "400 14px/1.2 var(--fx-font-sans)",
  padding: '10px 12px',
  minHeight: 'var(--fx-tap-min)',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-md)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
}
