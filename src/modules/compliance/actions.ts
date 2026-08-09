'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { getPolicy } from '@/modules/settings/service'

import {
  addCapEvidence,
  advanceCap,
  closeCap,
  openCap,
  recordAuditWithFindings,
  recordTraining,
  upsertCertificate,
  type CompliancePolicy,
} from './service'

function refresh(): void {
  revalidatePath('/compliance')
}

async function policyFor() {
  const ctx = await requireRole(await headers(), 'compliance')
  return { ctx, policy: await getPolicy<CompliancePolicy>(ctx, 'compliance') }
}

/** Record an audit and the findings it raised. */
export async function logAudit(input: {
  regime: string
  auditor: string
  auditedOn: string
  findings: { description: string; severity: string; clause?: string }[]
}): Promise<{ auditId: string } | ActionFailure> {
  // Surfaced with the role gate inside — this desk's refusals must arrive as sentences
  // (live-test finding, Phase 9: the module had complete services and no doors at all).
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'compliance')
    const result = await recordAuditWithFindings(ctx, input)
    refresh()
    return { auditId: result.auditId }
  })
}

/**
 * Open a corrective action plan against a finding.
 *
 * The deadline is computed from the regime's own policy when it is not given, rather than
 * defaulted to something round. A BSCI finding and a Sedex one carry different correction
 * windows, and a factory that treats them alike misses the tighter of the two.
 */
export async function raiseCap(input: {
  findingId: string
  /** Defaults to the caller: the compliance officer owns a CAP until it is handed over. */
  ownerUserId?: string
  deadline?: string
}): Promise<{ capId: string; deadline: string } | ActionFailure> {
  return surfaced(async () => {
    const { ctx, policy } = await policyFor()
    const result = await openCap(
      ctx,
      { ...input, ownerUserId: input.ownerUserId ?? ctx.userId },
      policy,
    )
    refresh()
    return result
  })
}

/** Move a CAP along — work started, evidence submitted. */
export async function progressCap(input: {
  capId: string
  status: 'in_progress' | 'evidence_submitted'
  note?: string
}): Promise<{ status: string }> {
  const ctx = await requireRole(await headers(), 'compliance')
  const result = await advanceCap(ctx, input)
  refresh()
  return { status: String(result.status) }
}

/**
 * Attach evidence to a CAP.
 *
 * A note is evidence for a minor finding. A critical one needs a document, and the service
 * refuses to close without it — an auditor returning in six months does not accept
 * "we told them to stop"; they accept the photograph of the guard that was fitted.
 */
export async function attachCapEvidence(input: {
  capId: string
  documentId?: string
  note?: string
}): Promise<{ evidenceCount: number }> {
  const ctx = await requireRole(await headers(), 'compliance')
  const result = await addCapEvidence(ctx, input)
  refresh()
  return { evidenceCount: result.evidenceCount }
}

/**
 * Close a CAP.
 *
 * Two refusals, both in the service. Only a role the policy names as a closer may do it —
 * the person who caused a finding is rarely the person who should certify it fixed — and a
 * critical finding cannot be closed on a note alone.
 */
export async function closeCorrectiveAction(input: {
  capId: string
  note?: string
}): Promise<{ status: string }> {
  const { ctx, policy } = await policyFor()
  const result = await closeCap(ctx, input, policy)
  refresh()
  return { status: result.status }
}

/**
 * Record or renew a certificate.
 *
 * `expiresOn` is explicitly nullable and there is no "unknown". A certificate whose expiry
 * nobody knows must not be stored as perpetual — that is exactly how one silently never
 * appears on the expiry ladder and lapses without anybody being told.
 */
export async function saveCertificate(input: {
  kind: string
  number: string
  issuedOn?: string
  expiresOn: string | null
  issuer?: string
}): Promise<{ certificateId: string }> {
  const ctx = await requireRole(await headers(), 'compliance')
  const result = await upsertCertificate(ctx, input)
  refresh()
  return result
}

/** Record a drill or training session held. */
export async function logTraining(input: {
  kind: string
  heldOn: string
  attendeesCount: number
}): Promise<{ trainingId: string }> {
  const ctx = await requireRole(await headers(), 'compliance')
  const result = await recordTraining(ctx, input)
  refresh()
  return result
}
