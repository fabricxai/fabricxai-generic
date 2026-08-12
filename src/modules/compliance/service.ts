/**
 * 10.2 Compliance & Audit — service layer ⚖
 *
 * The module that decides whether a factory can say it is compliant. Everything it does is
 * shaped by one asymmetry: an unfixed finding that LOOKS open costs somebody an afternoon,
 * and an unfixed finding that looks CLOSED costs the factory its buyer.
 *
 * So the closing of a corrective action is the guarded operation here, in three ways:
 *
 *  1. It cannot close without evidence — enforced in the service, in the zod payload and by
 *     a check constraint, because this is the one write that must not have a back door.
 *  2. A critical finding needs a DOCUMENT, not a note. That rule lives in `compliance.ts`
 *     where it can be tested against every severity.
 *  3. It cannot be closed by the person who submitted the evidence. Somebody submits and
 *     somebody else accepts — an auditor's whole objection to self-certification.
 *
 * `findings` is a pending target; `caps` deliberately is not. Transcribing thirty findings
 * out of a fifty-page RSC report is exactly the work a model should draft. Naming who is
 * responsible for fixing one, and by when, is not.
 */
import { and, eq, inArray, sql } from 'drizzle-orm'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, forbidden, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import {
  assertCapClosure,
  auditPackGaps,
  capDeadline,
  capEscalation,
  ComplianceError,
  expiryLadder,
  type CapDeadlinePolicy,
  type Escalation,
  type LadderRow,
  type PackGap,
  type Severity,
} from './compliance'
import { COMPLIANCE_EVENTS } from './events'
import { audits, caps, certificates, findings, trainings } from './schema'
import {
  auditInput,
  capCloseInput,
  capEvidenceInput,
  capInput,
  capProgressInput,
  certificateInput,
  findingsBatchDraft,
  trainingInput,
} from './zod'

/** ⚖ — every one of these is what a buyer's compliance team reads. */
registerAuditedTables('audits', 'findings', 'caps', 'certificates')

/**
 * open → in_progress → evidence_submitted → closed.
 *
 * Backwards from `evidence_submitted` is allowed on purpose: an auditor rejecting the
 * evidence sends it back to `in_progress`, and modelling that as a new CAP would lose the
 * fact that the first attempt was not accepted — which is exactly what a repeat audit looks
 * for.
 */
export const capMachine = defineStateMachine({
  field: 'status',
  initial: 'open',
  transitions: {
    open: ['in_progress', 'evidence_submitted', 'closed'],
    in_progress: ['evidence_submitted', 'closed'],
    evidence_submitted: ['closed', 'in_progress'],
    closed: [],
  },
})

export type CapStatus = (typeof capMachine.states)[number]

/** Company policy. Owned by X.3 Settings; passed in until every caller reads it from there. */
export interface CompliancePolicy {
  /** Days to fix, by severity, per regime. No defaults — see `capDeadline`. */
  capDeadlineDays: CapDeadlinePolicy
  /** Certificate alert rungs. The brief says 90/60/30. */
  expiryRungs: readonly number[]
  /** Certificate kinds a pack for this regime must contain. */
  requiredCertificates: Readonly<Record<string, readonly string[]>>
  /** Roles that may ACCEPT evidence and close a CAP. */
  closerRoles: readonly string[]
}

function wrapComplianceError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof ComplianceError) {
      throw new AppError('validation_failed', 'compliance.errors.invalid', {
        reason: error.message,
      })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Audits and findings
// ─────────────────────────────────────────────────────────────────────────────

export async function recordAudit(ctx: RequestCtx, input: unknown): Promise<{ auditId: string }> {
  const payload = auditInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(audits)
      .values({
        companyId: ctx.companyId,
        regime: payload.regime,
        auditor: payload.auditor,
        auditedOn: payload.auditedOn,
        reportDocumentId: payload.reportDocumentId ?? null,
        // Absent stays absent. A regime that does not score has no score, and zero would be
        // the worst possible one.
        score: payload.score ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: audits.id })

    if (!row) throw new Error('audits insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'audits',
      targetId: row.id,
      before: null,
      after: { regime: payload.regime, auditor: payload.auditor, auditedOn: payload.auditedOn },
    })

    return { auditId: row.id }
  })
}

/**
 * Record an audit AND its findings, as the desk types them (live-test finding, Phase 9).
 *
 * The action had always accepted a `findings` array and `recordAudit`'s zod silently
 * stripped it — the success banner counted findings the server never kept, and the desk
 * recorded audits that could never grow a CAP. One transaction: an audit that exists
 * while its findings failed would be the same lie in a different order.
 */
export async function recordAuditWithFindings(
  ctx: RequestCtx,
  input: {
    regime: string
    auditor: string
    auditedOn: string
    findings: { description: string; severity: string; clause?: string }[]
  },
): Promise<{ auditId: string; findings: number }> {
  const { auditId } = await recordAudit(ctx, {
    regime: input.regime,
    auditor: input.auditor,
    auditedOn: input.auditedOn,
  })

  if (input.findings.length === 0) return { auditId, findings: 0 }

  await withTenantTx(ctx, (tx) =>
    commitFindingsBatch(ctx, tx, {
      payload: {
        auditId,
        findings: input.findings.map((f) => ({
          severity: f.severity,
          // The schema has no clause column; the clause is part of what the auditor wrote.
          text: f.clause?.trim() ? `${f.clause.trim()} — ${f.description}` : f.description,
          evidence: [],
        })),
      },
    }),
  )

  return { auditId, findings: input.findings.length }
}

/**
 * Commit an approved findings batch — the module's own write for its pending target.
 *
 * An audit is a parent and its findings are children, which core's generic single-row write
 * cannot express. It also emits per-CRITICAL-finding, because a critical finding sitting in
 * an approved batch that nobody was told about is the failure this module exists to prevent.
 */
export async function commitFindingsBatch(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const payload = findingsBatchDraft.parse(input.payload)

  /*
   * The audit is optional while a model is reading and required to write — the same shape as
   * `commitLcFromDraft`. A batch of findings belonging to no audit is a list of complaints
   * with nothing to attach them to, and no report carries this system's id for one.
   */
  if (!payload.auditId) {
    throw new AppError('validation_failed', 'compliance.errors.findings_no_audit', {
      findings: payload.findings.length,
    })
  }

  // Read the parent under tenant scope. Postgres runs FK checks with RLS bypassed, so the
  // foreign key alone would happily attach these findings to another factory's audit.
  const [audit] = await tx.select().from(audits).where(scoped(audits, ctx, eq(audits.id, payload.auditId)))
  if (!audit) throw notFound('compliance.errors.audit_not_found', { auditId: payload.auditId })

  const inserted: string[] = []

  for (const finding of payload.findings) {
    const [row] = await tx
      .insert(findings)
      .values({
        companyId: ctx.companyId,
        auditId: payload.auditId,
        severity: finding.severity,
        text: finding.text,
        evidence: finding.evidence,
        sourcePage: finding.sourcePage ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: findings.id })

    if (!row) throw new Error('findings insert returned nothing')
    inserted.push(row.id)

    if (finding.severity === 'critical') {
      await emit(ctx, tx, {
        eventName: COMPLIANCE_EVENTS.criticalFinding,
        payload: { auditId: payload.auditId, findingId: row.id, text: finding.text },
        aggregateTable: 'findings',
        aggregateId: row.id,
      })
    }
  }

  return {
    rowId: inserted[0] ?? payload.auditId,
    after: { auditId: payload.auditId, findingCount: inserted.length },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Corrective actions
// ─────────────────────────────────────────────────────────────────────────────

export async function openCap(
  ctx: RequestCtx,
  input: unknown,
  policy: CompliancePolicy,
): Promise<{ capId: string; deadline: string }> {
  const payload = capInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [finding] = await tx.select().from(findings).where(scoped(findings, ctx, eq(findings.id, payload.findingId)))
    if (!finding) {
      throw notFound('compliance.errors.finding_not_found', { findingId: payload.findingId })
    }

    const [audit] = await tx.select().from(audits).where(scoped(audits, ctx, eq(audits.id, finding.auditId)))
    if (!audit) throw notFound('compliance.errors.audit_not_found', { auditId: finding.auditId })

    // Computed from the regime's policy unless somebody supplied one. `capDeadline` refuses
    // a policy with a gap or with the severities inverted rather than picking a window.
    const deadline =
      payload.deadline ??
      wrapComplianceError(() =>
        capDeadline({
          severity: finding.severity as Severity,
          auditDate: audit.auditedOn,
          policy: policy.capDeadlineDays,
        }),
      )

    const [row] = await tx
      .insert(caps)
      .values({
        companyId: ctx.companyId,
        findingId: payload.findingId,
        ownerUserId: payload.ownerUserId,
        deadline,
        status: 'open',
        milestones: payload.milestones ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: caps.id })

    if (!row) throw new Error('caps insert returned nothing')

    await emit(ctx, tx, {
      eventName: COMPLIANCE_EVENTS.capOpened,
      payload: {
        capId: row.id,
        findingId: payload.findingId,
        severity: finding.severity,
        ownerUserId: payload.ownerUserId,
        deadline,
      },
      aggregateTable: 'caps',
      aggregateId: row.id,
    })

    return { capId: row.id, deadline }
  })
}

export async function advanceCap(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ capId: string; status: CapStatus }> {
  const payload = capProgressInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [cap] = await tx.select().from(caps).where(scoped(caps, ctx, eq(caps.id, payload.capId))).for('update')
    if (!cap) throw notFound('compliance.errors.cap_not_found', { capId: payload.capId })

    capMachine.assert(cap.status as CapStatus, payload.status)

    await tx
      .update(caps)
      .set({ status: payload.status, updatedAt: new Date() })
      .where(scoped(caps, ctx, eq(caps.id, cap.id)))

    return { capId: cap.id, status: payload.status }
  })
}

/** Attach evidence as it is produced. Appended, never replaced. */
export async function addCapEvidence(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ capId: string; evidenceCount: number }> {
  const payload = capEvidenceInput.parse(input)

  if (!payload.documentId && !payload.note?.trim()) {
    throw new AppError('validation_failed', 'compliance.errors.empty_evidence', {
      capId: payload.capId,
    })
  }

  return withTenantTx(ctx, async (tx) => {
    const [cap] = await tx.select().from(caps).where(scoped(caps, ctx, eq(caps.id, payload.capId))).for('update')
    if (!cap) throw notFound('compliance.errors.cap_not_found', { capId: payload.capId })

    if (cap.status === 'closed') {
      // Evidence added after closure would change what a closed CAP claims, without anyone
      // re-accepting it. Reopen it first.
      throw new AppError('conflict', 'compliance.errors.cap_closed', { capId: cap.id })
    }

    const evidence = [
      ...(cap.closureEvidence as unknown[]),
      {
        documentId: payload.documentId ?? null,
        note: payload.note ?? null,
        at: new Date().toISOString(),
        by: ctx.userId,
      },
    ]

    await tx
      .update(caps)
      .set({ closureEvidence: evidence, updatedAt: new Date() })
      .where(scoped(caps, ctx, eq(caps.id, cap.id)))

    return { capId: cap.id, evidenceCount: evidence.length }
  })
}

/**
 * Accept the evidence and close the corrective action.
 *
 * Two gates that are not about the data.
 *
 * **The submitter cannot be the closer.** Somebody produces the evidence and somebody else
 * accepts it. Self-certification is the first thing an auditor tests, and a system that
 * permits it makes every closure in the pack arguable.
 *
 * **The closer needs a role that may close.** A CAP owner fixing their own finding and
 * marking it done is the same problem wearing a different hat.
 */
export async function closeCap(
  ctx: RequestCtx,
  input: unknown,
  policy: CompliancePolicy,
): Promise<{ capId: string; status: 'closed' }> {
  const payload = capCloseInput.parse(input)

  if (!ctx.roles.some((role) => policy.closerRoles.includes(role))) {
    throw forbidden('compliance.errors.not_a_closer', { required: policy.closerRoles })
  }

  return withTenantTx(ctx, async (tx) => {
    const [cap] = await tx.select().from(caps).where(scoped(caps, ctx, eq(caps.id, payload.capId))).for('update')
    if (!cap) throw notFound('compliance.errors.cap_not_found', { capId: payload.capId })

    capMachine.assert(cap.status as CapStatus, 'closed')

    const [finding] = await tx.select().from(findings).where(scoped(findings, ctx, eq(findings.id, cap.findingId)))
    if (!finding) {
      throw notFound('compliance.errors.finding_not_found', { findingId: cap.findingId })
    }

    const evidence = cap.closureEvidence as { by?: string; documentId?: string; note?: string }[]

    // A critical finding needs a document, not a note. Tested against every severity in
    // `compliance.ts`.
    wrapComplianceError(() =>
      assertCapClosure({ severity: finding.severity as Severity, closureEvidence: evidence }),
    )

    const submitters = new Set(evidence.map((item) => item.by).filter(Boolean))
    if (submitters.size === 1 && submitters.has(ctx.userId)) {
      throw forbidden('compliance.errors.self_certification', { capId: cap.id })
    }

    await tx
      .update(caps)
      .set({
        status: 'closed',
        closedAt: new Date(),
        closedBy: ctx.userId,
        updatedAt: new Date(),
      })
      .where(scoped(caps, ctx, eq(caps.id, cap.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'caps',
      targetId: cap.id,
      before: { status: cap.status },
      after: { status: 'closed', evidenceCount: evidence.length, note: payload.note ?? null },
    })

    await emit(ctx, tx, {
      eventName: COMPLIANCE_EVENTS.capClosed,
      payload: { capId: cap.id, findingId: cap.findingId, severity: finding.severity },
      aggregateTable: 'caps',
      aggregateId: cap.id,
    })

    return { capId: cap.id, status: 'closed' as const }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Certificates and trainings
// ─────────────────────────────────────────────────────────────────────────────

export async function upsertCertificate(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ certificateId: string }> {
  const payload = certificateInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const values = {
      companyId: ctx.companyId,
      kind: payload.kind,
      number: payload.number,
      issuedOn: payload.issuedOn ?? null,
      expiresOn: payload.expiresOn,
      documentId: payload.documentId ?? null,
      updatedAt: new Date(),
    }

    const [row] = await tx
      .insert(certificates)
      .values({ ...values, createdBy: ctx.userId })
      .onConflictDoUpdate({
        target: [certificates.companyId, certificates.kind, certificates.number],
        set: values,
      })
      .returning({ id: certificates.id })

    if (!row) throw new Error('certificates upsert returned nothing')

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'certificates',
      targetId: row.id,
      before: null,
      after: { kind: payload.kind, number: payload.number, expiresOn: payload.expiresOn },
    })

    return { certificateId: row.id }
  })
}

export async function recordTraining(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ trainingId: string }> {
  const payload = trainingInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(trainings)
      .values({
        companyId: ctx.companyId,
        kind: payload.kind,
        heldOn: payload.heldOn,
        attendeesCount: payload.attendeesCount,
        documentId: payload.documentId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: trainings.id })

    if (!row) throw new Error('trainings insert returned nothing')
    return { trainingId: row.id }
  })
}

/** Every certificate, lapsed first. The query the nightly alert job runs. */
export async function certificateLadder(
  ctx: AnyCtx,
  today: string,
  policy: CompliancePolicy,
): Promise<LadderRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx.select().from(certificates)
    return wrapComplianceError(() =>
      expiryLadder(
        rows.map((row) => ({
          certificateId: row.id,
          kind: row.kind,
          expiresOn: row.expiresOn,
        })),
        today,
        policy.expiryRungs,
      ),
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Escalations and the pack
// ─────────────────────────────────────────────────────────────────────────────

export interface CapException {
  capId: string
  findingId: string
  severity: Severity
  deadline: string
  status: CapStatus
  ownerUserId: string | null
  escalateTo: Escalation
}

/**
 * Corrective actions somebody needs to hear about.
 *
 * Includes OPEN critical findings that are not yet overdue. That is the rule most likely to
 * be questioned, and it is the point of the feed: the deadline is when a locked fire exit
 * must be fixed by, not when the owner may first be told about it.
 */
export async function capExceptions(ctx: AnyCtx, today: string): Promise<CapException[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        capId: caps.id,
        findingId: caps.findingId,
        severity: findings.severity,
        deadline: caps.deadline,
        status: caps.status,
        ownerUserId: caps.ownerUserId,
      })
      .from(caps)
      .innerJoin(findings, eq(findings.id, caps.findingId))
      .where(scoped(caps, ctx, inArray(caps.status, ['open', 'in_progress', 'evidence_submitted'])))

    return rows
      .map((row) => ({
        ...row,
        severity: row.severity as Severity,
        status: row.status as CapStatus,
        escalateTo: wrapComplianceError(() =>
          capEscalation({
            severity: row.severity as Severity,
            deadline: row.deadline,
            today,
            status: row.status as CapStatus,
          }),
        ),
      }))
      .filter((row) => row.escalateTo !== 'none')
      // Owner-level first, then by deadline — the order somebody should read them in.
      .sort(
        (a, b) =>
          Number(b.escalateTo === 'owner') - Number(a.escalateTo === 'owner') ||
          a.deadline.localeCompare(b.deadline),
      )
  })
}

export interface AuditPack {
  audit: typeof audits.$inferSelect
  findings: (typeof findings.$inferSelect)[]
  caps: (typeof caps.$inferSelect)[]
  certificates: (typeof certificates.$inferSelect)[]
  trainings: (typeof trainings.$inferSelect)[]
  /**
   * What the pack does NOT have. Returned WITH the pack and never separately — there is no
   * way to obtain the contents without also being told what is missing from them.
   */
  gaps: PackGap[]
}

export async function auditPack(
  ctx: AnyCtx,
  input: { auditId: string; today: string },
  policy: CompliancePolicy,
): Promise<AuditPack> {
  return withTenantRead(ctx, async (tx) => {
    const [audit] = await tx.select().from(audits).where(scoped(audits, ctx, eq(audits.id, input.auditId)))
    if (!audit) throw notFound('compliance.errors.audit_not_found', { auditId: input.auditId })

    const auditFindings = await tx
      .select()
      .from(findings)
      .where(scoped(findings, ctx, eq(findings.auditId, input.auditId)))

    const auditCaps =
      auditFindings.length === 0
        ? []
        : await tx
            .select()
            .from(caps)
            .where(scoped(caps, ctx, 
              inArray(
                caps.findingId,
                auditFindings.map((finding) => finding.id),
              ),
            ))

    const allCertificates = await tx.select().from(certificates)
    const allTrainings = await tx.select().from(trainings)

    const required = policy.requiredCertificates[audit.regime] ?? []

    const gaps = wrapComplianceError(() =>
      auditPackGaps(
        {
          audit: {
            auditId: audit.id,
            regime: audit.regime,
            reportDocumentId: audit.reportDocumentId,
          },
          findings: auditFindings.map((finding) => ({
            findingId: finding.id,
            severity: finding.severity as Severity,
          })),
          caps: auditCaps.map((cap) => ({
            capId: cap.id,
            findingId: cap.findingId,
            status: cap.status as CapStatus,
            closureEvidenceCount: (cap.closureEvidence as unknown[]).length,
          })),
          certificates: allCertificates.map((certificate) => ({
            kind: certificate.kind,
            expiresOn: certificate.expiresOn,
          })),
          requiredCertificates: required,
        },
        input.today,
      ),
    )

    return {
      audit,
      findings: auditFindings,
      caps: auditCaps,
      certificates: allCertificates,
      trainings: allTrainings,
      gaps,
    }
  })
}

export async function openFindings(
  ctx: AnyCtx,
): Promise<{ finding: typeof findings.$inferSelect; cap: typeof caps.$inferSelect | null }[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ finding: findings, cap: caps })
      .from(findings)
      .leftJoin(caps, eq(caps.findingId, findings.id))
      .where(scoped(findings, ctx, sql`${caps.status} is null or ${caps.status} <> 'closed'`))
      .orderBy(findings.severity, findings.createdAt)

    return rows.map((row) => ({ finding: row.finding, cap: row.cap }))
  })
}

export { and }
