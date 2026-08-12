'use client'

import { factoryToday } from '@/lib/dates'
import { useRouter } from 'next/navigation'
import { useRef, useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { uploadDocument } from '@/lib/upload-document'
import { Badge, Button } from '@/components/fx/primitives'
import { DateInput } from '@/components/fx/forms'
import {
  acceptLcDateBreach,
  buildShipmentDocChecklist,
  confirmShipmentLeft,
  loadOrderCartons,
  lockPackingList,
  markShipmentDoc,
  recordExpNumber,
  regeneratePackingList,
  requestToleranceException,
  sendDocsToBank,
} from '@/modules/shipment/actions'

export interface ShipmentActionState {
  shipmentId: string
  orderId: string
  expNumber: string | null
  actualExFactory: string | null
  packingList: { id: string | null; version: number; status: string } | null
  blockers: readonly string[]
  docs: readonly { kind: string; status: string; hasFile: boolean }[]
  cartonCount: number
  /** Packed against the order but not yet assigned to any shipment. */
  unloadedCartons: number
}

/**
 * The desk actions on one shipment (canvas P2).
 *
 * Ordered the way the work actually happens — pack, list, lock, leave, EXP, bank — because
 * the blockers list is only useful if the next thing to fix is the next thing on screen.
 *
 * **Nothing here bypasses a gate.** The bank handoff button is offered whatever the state,
 * and the server refuses it when the EXP is missing or the final inspection failed. Hiding
 * the button instead would leave somebody staring at a screen with no explanation of what
 * is wrong; letting them press it produces the reason.
 */
export function ShipmentActions({ state }: { state: ShipmentActionState }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [exp, setExp] = useState(state.expNumber ?? '')
  const [leftOn, setLeftOn] = useState(factoryToday())
  const [reason, setReason] = useState('')
  const [showException, setShowException] = useState(false)
  const [lcReason, setLcReason] = useState('')
  const [showLcWaiver, setShowLcWaiver] = useState(false)
  const [noted, setNoted] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  function run(work: () => Promise<string>) {
    setFailure(null)
    startTransition(async () => {
      try {
        setNoted(await work())
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'That did not go through.'))
      }
    })
  }

  const locked = state.packingList?.status === 'approved'

  return (
    <div
      style={{
        borderTop: '1px solid var(--fx-border-subtle)',
        padding: '14px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

      {state.blockers.length > 0 ? (
        <span
          style={{ font: "400 12px/1.6 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
        >
          blocking the bank — {state.blockers.join(' · ')}
        </span>
      ) : null}

      {/*
        The pipeline, named (plan 2.2, the audit's shipment finding). The ten operations
        used to render as one flat wall of doors with no sequence, and the sequence is the
        whole shape of the job: pack, leave, EXP, documents, bank. The rail says where this
        shipment stands and the buttons below remain exactly the operations they were —
        each already appears and disappears by the shipment's own state, which is what
        makes the wall readable once the order is visible.
      */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        {(
          [
            ['Pack', state.unloadedCartons === 0 && Boolean(state.packingList)],
            ['Ex-factory', Boolean(state.actualExFactory)],
            ['EXP', Boolean(state.expNumber)],
            ['Documents', state.docs.length > 0 && state.docs.every((d) => d.status !== 'missing')],
            ['Bank', state.blockers.length === 0 && Boolean(state.expNumber)],
          ] as const
        ).map(([label, done], i, stages) => {
          const firstOpen = stages.findIndex(([, d]) => !d)
          const current = i === (firstOpen === -1 ? stages.length - 1 : firstOpen)
          return (
            <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              {i > 0 ? (
                <span style={{ color: 'var(--fx-border-strong)', font: '400 11px/1 var(--fx-font-mono)' }}>
                  →
                </span>
              ) : null}
              <span
                style={{
                  font: `${current ? 600 : 400} 11.5px/1 var(--fx-font-mono)`,
                  letterSpacing: '.05em',
                  textTransform: 'uppercase',
                  padding: '5px 8px',
                  borderRadius: 'var(--fx-radius-sm)',
                  color: done
                    ? 'var(--fx-success)'
                    : current
                      ? 'var(--fx-text-primary)'
                      : 'var(--fx-text-tertiary)',
                  background: current ? 'var(--fx-accent-subtle)' : 'transparent',
                }}
              >
                {done ? '✓ ' : ''}
                {label}
              </span>
            </span>
          )
        })}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {/* ── Loading ──────────────────────────────────────────────────── */}
        {state.unloadedCartons > 0 ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = unwrap(
                  await loadOrderCartons({
                    shipmentId: state.shipmentId,
                    orderId: state.orderId,
                  }),
                )
                return `${r.loaded} cartons loaded onto this shipment.`
              })
            }
          >
            Load {state.unloadedCartons} packed cartons
          </Button>
        ) : null}

        {/* ── Packing list ─────────────────────────────────────────────── */}
        <Button
          variant="ghost"
          disabled={pending || state.cartonCount === 0}
          onClick={() =>
            run(async () => {
              const r = unwrap(
                await regeneratePackingList({
                  orderId: state.orderId,
                  shipmentId: state.shipmentId,
                }),
              )
              return `Packing list v${r.version} generated from ${state.cartonCount} cartons.`
            })
          }
        >
          {state.packingList ? 'Regenerate the list' : 'Generate the packing list'}
        </Button>

        {state.packingList?.id && !locked ? (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() =>
              run(async () => {
                const r = unwrap(
                  await lockPackingList({
                    packingListId: state.packingList!.id!,
                    // Mismatches against the breakdown are accepted deliberately, with the
                    // record that says who did it — never silently on the way past.
                    acceptMismatches: true,
                  }),
                )
                return `Packing list v${r.version} approved and locked.`
              })
            }
          >
            Approve and lock v{state.packingList.version}
          </Button>
        ) : null}

        {locked ? <Badge tone="success">list v{state.packingList!.version} locked</Badge> : null}
      </div>

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        {/* ── Ex-factory ───────────────────────────────────────────────── */}
        {state.actualExFactory ? (
          <Badge tone="neutral">left {state.actualExFactory}</Badge>
        ) : (
          <>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              <span style={smallLabel}>Left the factory on</span>
              <DateInput
                value={leftOn}
                onChange={setLeftOn}
                style={control}
              />
            </label>
            <Button
              variant="ghost"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  const r = unwrap(
                    await confirmShipmentLeft({
                      shipmentId: state.shipmentId,
                      actualExFactory: leftOn,
                    }),
                  )
                  return r.lateAgainstLc
                    ? 'Ex-factory confirmed — AFTER the LC latest-shipment date. The bank will raise this.'
                    : 'Ex-factory confirmed. The TNA milestone moves with it.'
                })
              }
            >
              Confirm ex-factory
            </Button>
          </>
        )}

        {/* ── EXP ──────────────────────────────────────────────────────── */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          <span style={smallLabel}>EXP number · issued by the AD bank</span>
          <input
            value={exp}
            onChange={(e) => setExp(e.target.value)}
            placeholder="not filled"
            style={{ ...control, minWidth: 190 }}
          />
        </label>
        <Button
          variant="ghost"
          disabled={pending || !exp.trim() || exp.trim() === state.expNumber}
          onClick={() =>
            run(async () => {
              unwrap(await recordExpNumber({ shipmentId: state.shipmentId, expNumber: exp.trim() }))
              return `EXP ${exp.trim()} recorded.`
            })
          }
        >
          Record the EXP
        </Button>
      </div>

      {/* ── The checklist, one document at a time ────────────────────── */}
      {state.docs.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {state.docs.map((doc) => (
            <DocRow
              key={doc.kind}
              shipmentId={state.shipmentId}
              doc={doc}
              busy={pending}
              onDone={(message: string) => run(async () => message)}
              onFailure={setFailure}
            />
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <Button
          variant="ghost"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const r = unwrap(await buildShipmentDocChecklist({ shipmentId: state.shipmentId }))
              return r.kinds.length === 0
                ? 'The LC lists no required documents, so there is nothing to check off.'
                : `Checklist built from the LC — ${r.kinds.join(', ')}.`
            })
          }
        >
          Build the document checklist
        </Button>

        <Button
          variant="primary"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const r = unwrap(await sendDocsToBank({ shipmentId: state.shipmentId }))
              return `Sent to the bank under EXP ${r.expNumber} — ${r.submitted.join(', ')}.`
            })
          }
        >
          Send documents to the bank
        </Button>

        <Button variant="ghost" onClick={() => setShowException((v) => !v)}>
          Request a tolerance exception
        </Button>

        {/* The escape hatch for the LC date gate. Confirming departure refuses when the
            credit cannot accept the date, and the refusal names the days over — this is
            what the person reading that refusal needs next. Offered like every other
            button here: the server decides, and refuses anyone but commercial. */}
        <Button variant="ghost" onClick={() => setShowLcWaiver((v) => !v)}>
          Accept a late shipment against the LC
        </Button>
      </div>

      {showException ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 320px' }}>
            <span style={smallLabel}>Why the quantity discrepancy should be accepted</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Buyer agreed the short ship by email; the balance goes on the next partial."
              style={control}
            />
          </label>
          <Button
            variant="secondary"
            disabled={pending || reason.trim().length < 10}
            onClick={() =>
              run(async () => {
                unwrap(
                  await requestToleranceException({
                    shipmentId: state.shipmentId,
                    reason: reason.trim(),
                  }),
                )
                setShowException(false)
                setReason('')
                return 'The exception is in the approve inbox. Nothing is accepted until a manager signs it.'
              })
            }
          >
            Send for approval
          </Button>
        </div>
      ) : null}

      {showLcWaiver ? (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 320px' }}>
            <span style={smallLabel}>
              Why this ships against a credit that cannot take the date
            </span>
            <input
              value={lcReason}
              onChange={(e) => setLcReason(e.target.value)}
              placeholder="Buyer confirmed by email they will amend the credit to 15 August."
              style={control}
            />
          </label>
          <Button
            variant="secondary"
            disabled={pending || lcReason.trim().length < 10}
            onClick={() =>
              run(async () => {
                unwrap(
                  await acceptLcDateBreach({
                    shipmentId: state.shipmentId,
                    reason: lcReason.trim(),
                  }),
                )
                setShowLcWaiver(false)
                setLcReason('')
                // Said plainly: this does not make the shipment compliant, it records who
                // decided to send it anyway. The bank can still refuse the presentation.
                return 'Recorded against this shipment. The departure can now be confirmed; the credit is still breached.'
              })
            }
          >
            Accept and record
          </Button>
        </div>
      ) : null}
    </div>
  )
}

const smallLabel: React.CSSProperties = {
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

/**
 * One document on the bank checklist: attach it, or take it back to pending.
 *
 * **Attaching IS marking it ready, in one gesture.** `setDocStatus` refuses any status but
 * `pending` without a file, and a file attached while left pending is invisible to the
 * handoff — indistinguishable from no file at all. Two separate steps would produce a state
 * that looks done to the person and empty to the gate.
 *
 * **Taking it back to pending keeps the file.** The service writes `documentId ?? existing`,
 * so somebody who un-readies a document to re-check it does not have to find the PDF again.
 * The old file is still what will be submitted unless a new one replaces it — which is why
 * the row keeps saying a file is attached rather than looking empty.
 *
 * **The upload happens before the status change, and a failed upload changes nothing.** A
 * document marked ready against a file that never reached storage is exactly the
 * presentation that arrives at a bank counter incomplete.
 */
function DocRow({
  shipmentId,
  doc,
  busy,
  onDone,
  onFailure,
}: {
  shipmentId: string
  doc: { kind: string; status: string; hasFile: boolean }
  busy: boolean
  onDone: (message: string) => void
  onFailure: (message: string) => void
}) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)

  const label = doc.kind.replace(/_/g, ' ')
  const ready = doc.status !== 'pending'
  const submitted = doc.status === 'submitted'

  async function attach(file: File) {
    setUploading(true)
    try {
      const uploaded = await uploadDocument(file, { kind: doc.kind, moduleId: 'shipment' })
      unwrap(
        await markShipmentDoc({ shipmentId, kind: doc.kind, status: 'ready', documentId: uploaded.documentId }),
      )
      onDone(`${label} attached and marked ready.`)
    } catch (error) {
      onFailure(actionErrorMessage(error, `${label} was not attached.`))
    } finally {
      setUploading(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        padding: '9px 12px',
        borderRadius: 'var(--fx-radius-md)',
        border: `1px solid ${ready ? 'var(--fx-success)' : 'var(--fx-border-default)'}`,
        background: ready
          ? 'color-mix(in srgb, var(--fx-success) 10%, transparent)'
          : 'transparent',
      }}
    >
      <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", minWidth: 150 }}>
        {ready ? '✓ ' : ''}
        {label}
      </span>

      <Badge tone={submitted ? 'success' : ready ? 'info' : 'neutral'}>{doc.status}</Badge>

      {/* Says which of the two blanks this is: no file at all, or a file already held. */}
      <span
        style={{ font: "400 12px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
      >
        {doc.hasFile ? 'file attached' : 'no file yet'}
      </span>

      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/*"
        style={{ display: 'none' }}
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) void attach(file)
          e.target.value = ''
        }}
      />

      <span style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
        {/* Once submitted the set is with the bank; replacing a document then is an
            amendment, not an upload. */}
        {submitted ? null : (
          <button
            onClick={() => fileRef.current?.click()}
            disabled={busy || uploading}
            style={linkAction}
          >
            {uploading ? 'Uploading…' : doc.hasFile ? 'Replace the file' : 'Attach the file'}
          </button>
        )}

        {ready && !submitted ? (
          <button
            onClick={() =>
              void markShipmentDoc({ shipmentId, kind: doc.kind, status: 'pending' })
                .then((r) => {
                  unwrap(r)
                  onDone(`${label} back to pending — the file is kept.`)
                })
                .catch((error: unknown) =>
                  onFailure(actionErrorMessage(error, `${label} was not changed.`)),
                )
            }
            disabled={busy || uploading}
            style={linkAction}
          >
            Back to pending
          </button>
        ) : null}
      </span>
    </div>
  )
}

const linkAction: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  padding: 0,
  font: "400 13px/1.4 var(--fx-font-sans)",
  color: 'var(--fx-text-tertiary)',
  textDecoration: 'underline',
  cursor: 'pointer',
}
