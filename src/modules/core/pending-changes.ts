/**
 * pending_changes v2 — propose → approve → commit (architecture §1.1, dev-plan §2.2.2).
 *
 * The only path by which AI or junior writes reach business tables. Nothing here is a
 * feature; it is the architectural layer a skeptical factory owner is being asked to
 * trust, so the refusals matter more than the happy path:
 *
 *  - The target table must be registered in the owning module's `register.ts`. An
 *    unregistered table is rejected outright (CLAUDE.md rule 3).
 *  - The payload is validated by the module's Zod schema at insert AND AGAIN at approve.
 *    Schemas tighten over time; a draft written under a looser one must not commit under
 *    the newer one (PLAYBOOK §3, the X.1 re-validation test).
 *  - Confidence is per field and comes from a measurement. A constant is a bug, and a
 *    source with nothing to measure carries none at all rather than a plausible number.
 *  - Approve is idempotent under contention: the row is locked, and a second approve gets
 *    a typed 409 while exactly one commit happens (architecture §9).
 *
 * Commit, audit row and outbox event all happen in ONE transaction. That is what makes
 * the chain draft → reviewer → committed row auditable end to end.
 */
import { and, eq, sql } from 'drizzle-orm'
import type { ZodType } from 'zod'

import { approvalRules, pendingChangeApprovals, pendingChanges } from '@/db/schema/core'

import { isAudited, recordChange } from './audit'
import { isSystemCtx, type AnyCtx, type RequestCtx, type Role } from './ctx'
import { AppError, conflict, notFound } from './errors'
import { emit } from './outbox'
import { getCommitHandler, getModule, resolvePendingSchema } from './registry'
import { scoped } from './scoped'
import { type TenantDb, withTenantRead, withTenantTx } from './tenancy'

type Operation = 'insert' | 'update' | 'delete'
type Source = 'ai_extraction' | 'ai_chat' | 'user_draft' | 'import' | 'integration'

export interface ProposeInput {
  moduleId: string
  targetTable: string
  targetId?: string
  operation: Operation
  payload: Record<string, unknown>
  zodSchemaKey: string
  /**
   * Per field, straight from the extractor. Required for `ai_extraction` and REFUSED for
   * `ai_chat`, which has no extractor to ask — see `validateConfidence`.
   */
  fieldConfidence?: Record<string, number>
  source: Source
  sourceDocumentId?: string
  extractorVersion?: string
  model?: string
}

export interface ApproveInput {
  pendingChangeId: string
  /** Field-level edits the reviewer made — this is the correction telemetry. */
  corrections?: Record<string, unknown>
  note?: string
  /**
   * Set only by the auto-approve rule below. It leaves `reviewed_by` NULL, so
   * `status = 'committed' and reviewed_by is null` means exactly one thing: this row went in
   * on a rule and no person ever looked at it.
   *
   * The alternative — recording the proposer as the reviewer, which is what happened before —
   * makes every auto-approved AI draft count as a clean human review in X.2's correction
   * telemetry. An extractor's score would then improve precisely as fewer people checked it,
   * which is backwards from what that number is for.
   */
  autoApproved?: boolean
}

const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

/**
 * Confidence must come from a measurement, and only one source has one.
 *
 * `ai_extraction` read a document. There is an extractor, it reports per field, and a draft
 * arriving without those numbers is exactly what the approve inbox exists to make visible —
 * so it is refused at the door rather than displayed as though the absence meant nothing.
 *
 * `ai_chat` did not. A model composed tool arguments from a conversation: no document, no
 * extractor, no second pass, nothing that could produce a number. Requiring one here for a
 * year produced precisely what a requirement with no source of truth always produces —
 * eight modules that typed plausible numbers into their draft tools and shipped them
 * (plan 6.3, audit AI-B2). So the requirement is inverted for this source: a chat draft
 * carries NO confidence, and offering one is refused.
 *
 * That is stricter than it sounds, not looser. An empty map gives `confidenceMin = null`,
 * which can never clear an auto-approve floor and shows the reviewer "no confidence" on
 * every field. The drafts this changes were auto-approvable on a fabricated 0.95; now they
 * always get a human.
 *
 * If a real score for chat drafts ever exists — a pass that reads the payload back against
 * the conversation, not a developer's estimate — it arrives here with the thing that
 * computes it, and this branch changes with it.
 */
function validateConfidence(source: Source, fieldConfidence: Record<string, number>): void {
  const entries = Object.entries(fieldConfidence)

  if (source === 'ai_extraction' && entries.length === 0) {
    throw new AppError(
      'validation_failed',
      'errors.confidence_required',
      { source },
      'an extraction must carry per-field confidence from the extractor',
    )
  }

  if (source === 'ai_chat' && entries.length > 0) {
    throw new AppError(
      'validation_failed',
      'errors.confidence_not_measured',
      { source, fields: entries.length },
      'a chat-composed draft has no extractor behind it — a per-field score here is invented',
    )
  }

  for (const [field, value] of entries) {
    if (typeof value !== 'number' || Number.isNaN(value) || value < 0 || value > 1) {
      throw new AppError('validation_failed', 'errors.confidence_out_of_range', { field, value })
    }
  }
}

function lowestConfidence(fieldConfidence: Record<string, number>): string | null {
  const values = Object.values(fieldConfidence)
  if (values.length === 0) return null
  return Math.min(...values).toFixed(3)
}

function parseOrThrow(schema: ZodType, payload: unknown): Record<string, unknown> {
  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new AppError('validation_failed', 'errors.payload_invalid', {
      issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    })
  }
  // Zod strips unknown keys, so the output is exactly what the module declared — which is
  // also what makes it safe to turn into column names below.
  return parsed.data as Record<string, unknown>
}

/**
 * The rule governing a draft: the highest-priority active rule whose module, table and
 * operation match, else the module's registered defaults.
 */
async function resolveRule(
  tx: TenantDb,
  ctx: AnyCtx,
  draft: { moduleId: string; targetTable: string; operation: Operation },
): Promise<{
  requiredRoles: readonly Role[]
  autoApprove: boolean
  minConfidence: string | null
  approvalsRequired: number
}> {
  const rules = await tx
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.companyId, ctx.companyId), eq(approvalRules.isActive, true)))
    .orderBy(sql`${approvalRules.priority} desc`)

  const match = rules.find(
    (rule) =>
      rule.moduleId === draft.moduleId &&
      (rule.targetTable === null || rule.targetTable === draft.targetTable) &&
      (rule.operation === null || rule.operation === draft.operation),
  )

  if (match) {
    return {
      requiredRoles: match.requiredRoles,
      autoApprove: match.autoApprove,
      minConfidence: match.minConfidence,
      approvalsRequired: match.approvalsRequired,
    }
  }

  const definition = getModule(draft.moduleId)
  return {
    requiredRoles: definition?.approvalDefaults.requiredRoles ?? ['owner'],
    autoApprove: false,
    minConfidence: null,
    // A module may declare its own default; absent both, one approver.
    approvalsRequired: definition?.approvalDefaults.approvalsRequired ?? 1,
  }
}

/**
 * Propose a change. Validates the target against the registry whitelist and the payload
 * against the module's Zod schema before anything is written.
 *
 * Auto-approval is decided here and only here: a rule may skip the human, but only if it
 * declares a confidence floor AND *every* field clears it. That is why confidence is
 * stored per field — an average hides the one field the extractor was unsure about.
 */
export async function propose(
  ctx: AnyCtx,
  input: ProposeInput,
): Promise<{ id: string; status: 'pending' | 'committed' }> {
  const schema = resolvePendingSchema(input.moduleId, input.targetTable, input.zodSchemaKey)
  const fieldConfidence = input.fieldConfidence ?? {}

  validateConfidence(input.source, fieldConfidence)
  const payload = parseOrThrow(schema, input.payload)

  if ((input.operation === 'insert') !== (input.targetId === undefined)) {
    throw new AppError('validation_failed', 'errors.target_id_mismatch', {
      operation: input.operation,
    })
  }

  const confidenceMin = lowestConfidence(fieldConfidence)

  const { id, rule } = await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(pendingChanges)
      .values({
        companyId: ctx.companyId,
        moduleId: input.moduleId,
        targetTable: input.targetTable,
        targetId: input.targetId ?? null,
        operation: input.operation,
        payload,
        zodSchemaKey: input.zodSchemaKey,
        fieldConfidence,
        confidenceMin,
        source: input.source,
        sourceDocumentId: input.sourceDocumentId ?? null,
        extractorVersion: input.extractorVersion ?? null,
        model: input.model ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: pendingChanges.id })

    if (!row) throw new Error('pending_changes insert returned nothing')

    return {
      id: row.id,
      rule: await resolveRule(tx, ctx, {
        moduleId: input.moduleId,
        targetTable: input.targetTable,
        operation: input.operation,
      }),
    }
  })

  const clearsFloor =
    rule.autoApprove &&
    rule.minConfidence !== null &&
    confidenceMin !== null &&
    Number(confidenceMin) >= Number(rule.minConfidence)

  if (clearsFloor) {
    // Not unconditionally 'committed': a rule that both auto-approves and demands two
    // humans resolves in favour of the humans, and approve() reports awaiting_approvals.
    const result = await approve(ctx, { pendingChangeId: id, autoApproved: true })
    return { id, status: result.status === 'committed' ? 'committed' : 'pending' }
  }

  return { id, status: 'pending' }
}

/**
 * Approve and commit a draft.
 *
 * One transaction: lock the draft, re-validate, write the target row, write the audit
 * row, emit the outbox event, close the draft. A crash anywhere rolls the whole thing
 * back and the draft stays reviewable.
 */
export interface ApproveResult {
  /**
   * Null while the draft is still short of `approvals_required`. A caller that treats a
   * null as success would report a two-approver change as done on the first click.
   */
  committedRowId: string | null
  status: 'committed' | 'awaiting_approvals'
  approvals: number
  approvalsRequired: number
}

// AnyCtx, not RequestCtx: the auto-approve floor runs under SystemCtx (extraction jobs
// have no user). A system approval records no row in the approvals ledger — there is no
// approver — and can never stand in for a rule that demands more than one human.
export async function approve(ctx: AnyCtx, input: ApproveInput): Promise<ApproveResult> {
  type Failure = { schemaError: AppError }
  type Awaiting = { awaiting: { approvals: number; required: number } }
  type Committed = { rowId: string; approvals: number; required: number }

  const outcome = await withTenantTx(
    ctx,
    async (tx): Promise<Committed | Failure | Awaiting> => {
    // FOR UPDATE: a concurrent second approve blocks here, then finds the status already
    // moved on and gets a 409. Exactly one commit ever happens.
    const [draft] = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, input.pendingChangeId)))
      .for('update')

    // Scoped by RLS — a draft belonging to another company is simply not visible.
    if (!draft) throw notFound('errors.pending_change_not_found', { id: input.pendingChangeId })

    if (draft.status !== 'pending') {
      throw conflict('errors.pending_change_not_pending', { id: draft.id, status: draft.status })
    }

    const rule = await resolveRule(tx, ctx, {
      moduleId: draft.moduleId,
      targetTable: draft.targetTable,
      operation: draft.operation,
    })

    // A system caller is only ever the auto-approve floor: the rule itself is the
    // authorization, and only when it demands a single approval — software cannot be
    // two different people.
    if (isSystemCtx(ctx)) {
      if (!input.autoApproved) {
        throw new AppError('forbidden', 'errors.not_an_approver', { required: rule.requiredRoles })
      }
      if (rule.approvalsRequired > 1) {
        return { awaiting: { approvals: 0, required: rule.approvalsRequired } }
      }
    } else if (!rule.requiredRoles.some((role) => ctx.roles.includes(role))) {
      throw new AppError('forbidden', 'errors.not_an_approver', { required: rule.requiredRoles })
    }

    /*
     * Dual control on the ⚖ tables (adoption plan 3.1, HANDOVER DL-8).
     *
     * One person could draft and sign the same single-approval change. For most targets
     * that is the designed intake flow — whoever uploaded the tech pack reviews the
     * extraction and signs it, and banning that would break the door it walked in through.
     * For the tables a bank, customs or an auditor will ask about, it is the control the
     * audit trail exists to prove: a credit, a customs draw, an invoice or a wage table
     * signed into existence by its own author has one name where the ⚖ mark promises two.
     *
     * The line is each module's own `registerAuditedTables` declaration rather than a list
     * here — the module that marked its table compliance-bearing has already made this
     * decision, and a second list would drift from the first.
     *
     * Sits after the role gate on purpose: "not an approver" is the more fundamental
     * refusal, and this one should only ever name people who could otherwise sign.
     * Rejection stays open to the proposer — withdrawing your own draft is not approval.
     */
    if (!isSystemCtx(ctx) && draft.createdBy === ctx.userId && isAudited(draft.targetTable)) {
      throw new AppError('forbidden', 'errors.self_approval', { targetTable: draft.targetTable })
    }

    // ── Multi-approver ──
    //
    // `approvals_required` was stored and ignored until now. A rule demanding two approvers
    // is a rule about two DIFFERENT people, so this records the approval per (draft,
    // approver) and only commits once the threshold is met. The unique index means the same
    // person clicking twice is one approval — otherwise a two-approver control is a
    // one-approver control with extra steps.
    // No ledger row for a system auto-approve: `approver_user_id` is NOT NULL on
    // purpose (an approval is a person), and the draft itself records the commit with
    // `reviewed_by` NULL, which is what keeps auto-commits out of correction telemetry.
    if (!isSystemCtx(ctx)) {
      const approvedAsRole = rule.requiredRoles.find((role) => ctx.roles.includes(role))!

      const [existingApproval] = await tx
        .select({ id: pendingChangeApprovals.id })
        .from(pendingChangeApprovals)
        .where(scoped(pendingChangeApprovals, ctx, 
          and(
            eq(pendingChangeApprovals.pendingChangeId, draft.id),
            eq(pendingChangeApprovals.approverUserId, ctx.userId),
          ),
        ))

      if (!existingApproval) {
        await tx.insert(pendingChangeApprovals).values({
          companyId: ctx.companyId,
          pendingChangeId: draft.id,
          approverUserId: ctx.userId,
          approvedAsRole,
          corrections: input.corrections ?? {},
          note: input.note ?? null,
        })
      }
    }

    const approvals = await tx
      .select({ approverUserId: pendingChangeApprovals.approverUserId })
      .from(pendingChangeApprovals)
      .where(scoped(pendingChangeApprovals, ctx, eq(pendingChangeApprovals.pendingChangeId, draft.id)))

    const required = rule.approvalsRequired

    // The system caller passed the single-approval check above; a human still needs the
    // ledger to reach the threshold.
    if (!isSystemCtx(ctx) && approvals.length < required) {
      // Recorded, not committed. The draft stays `pending` so it remains in every other
      // approver's inbox, and this reviewer's corrections are kept against their name.
      return {
        awaiting: { approvals: approvals.length, required },
      }
    }

    // The reviewer's edits join the payload BEFORE re-validation — a correction must not
    // be able to smuggle past the schema.
    const merged = { ...(draft.payload as Record<string, unknown>), ...(input.corrections ?? {}) }

    let payload: Record<string, unknown>
    try {
      const schema = resolvePendingSchema(draft.moduleId, draft.targetTable, draft.zodSchemaKey)
      payload = parseOrThrow(schema, merged)
    } catch (error) {
      if (!(error instanceof AppError)) throw error
      // Re-validation failed: the schema tightened, or the correction is invalid. Record
      // WHY on the draft and let that record commit, then throw. Rolling back here would
      // discard the only explanation the reviewer is going to get.
      await tx
        .update(pendingChanges)
        .set({
          status: 'failed',
          error: error.toJSON(),
          reviewedBy: input.autoApproved ? null : ctx.userId,
          reviewedAt: new Date(),
          corrections: input.corrections ?? {},
          updatedAt: new Date(),
        })
        .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, draft.id)))
      return { schemaError: error }
    }

    // A module may own how its target is committed — see PendingCommitHandler. When it
    // does, core does not touch the table itself: the module's invariant (a revision
    // pointer, a balance draw-down) is not expressible as a row write.
    const handler = getCommitHandler(draft.moduleId, draft.targetTable)

    let rowId: string
    let before: Record<string, unknown> | null
    let after: Record<string, unknown> | null

    if (handler) {
      const result = await handler(ctx, tx, {
        operation: draft.operation,
        targetId: draft.targetId,
        payload,
      })
      rowId = result.rowId
      before = result.before ?? null
      after = result.after ?? null
    } else {
      before =
        draft.operation === 'insert'
          ? null
          : await readRow(tx, draft.targetTable, draft.targetId as string)

      if (draft.operation !== 'insert' && !before) {
        throw notFound('errors.target_row_not_found', {
          targetTable: draft.targetTable,
          targetId: draft.targetId,
        })
      }

      rowId = await applyChange(tx, ctx, {
        operation: draft.operation,
        targetTable: draft.targetTable,
        targetId: draft.targetId,
        payload,
      })

      after = draft.operation === 'delete' ? null : await readRow(tx, draft.targetTable, rowId)
    }

    await recordChange(ctx, tx, {
      action: draft.operation,
      targetTable: draft.targetTable,
      targetId: rowId,
      before,
      after,
      pendingChangeId: draft.id,
    })

    await emit(ctx, tx, {
      eventName: 'core.pending_change.committed',
      payload: {
        pendingChangeId: draft.id,
        moduleId: draft.moduleId,
        targetTable: draft.targetTable,
        targetId: rowId,
        operation: draft.operation,
        approvedBy: ctx.userId,
      },
      aggregateTable: draft.targetTable,
      aggregateId: rowId,
    })

    await tx
      .update(pendingChanges)
      .set({
        status: 'committed',
        reviewedBy: input.autoApproved ? null : ctx.userId,
        reviewedAt: new Date(),
        reviewNote: input.note ?? null,
        corrections: input.corrections ?? {},
        committedAt: new Date(),
        committedRowId: rowId,
        updatedAt: new Date(),
      })
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, draft.id)))

    return { rowId, approvals: approvals.length, required }
  },
  )

  if ('schemaError' in outcome) throw outcome.schemaError

  if ('awaiting' in outcome) {
    return {
      committedRowId: null,
      status: 'awaiting_approvals',
      approvals: outcome.awaiting.approvals,
      approvalsRequired: outcome.awaiting.required,
    }
  }

  return {
    committedRowId: outcome.rowId,
    status: 'committed',
    approvals: outcome.approvals,
    approvalsRequired: outcome.required,
  }
}

/** Reject a draft. No target row is touched; the decision is still audited. */
export async function reject(ctx: RequestCtx, id: string, note?: string): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [draft] = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, id)))
      .for('update')

    if (!draft) throw notFound('errors.pending_change_not_found', { id })
    if (draft.status !== 'pending') {
      throw conflict('errors.pending_change_not_pending', { id, status: draft.status })
    }

    await tx
      .update(pendingChanges)
      .set({
        status: 'rejected',
        reviewedBy: ctx.userId,
        reviewedAt: new Date(),
        reviewNote: note ?? null,
        updatedAt: new Date(),
      })
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, id)))

    await recordChange(ctx, tx, {
      action: 'reject',
      targetTable: draft.targetTable,
      targetId: draft.targetId ?? undefined,
      pendingChangeId: draft.id,
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Dynamic writes to the target table
//
// A table name held in a string is exactly the shape that invites SQL injection. Four
// independent things stop it here: the module registry whitelist (enforced by
// `resolvePendingSchema` before we ever get here), the CHECK constraint on
// `pending_changes.target_table`, the identifier assertion below, and `sql.identifier`
// quoting. Column names come only from Zod's parsed output, so a payload cannot
// introduce a key the module never declared. Values are always bound parameters.
// ─────────────────────────────────────────────────────────────────────────────

function assertIdentifier(name: string): string {
  if (!IDENTIFIER_RE.test(name)) {
    throw new AppError('validation_failed', 'errors.invalid_identifier', { name })
  }
  return name
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
  return rows as Record<string, unknown>[]
}

/**
 * The row a draft would change, as the reviewer needs to see it.
 *
 * The approve inbox showed only the incoming value, so an UPDATE was approved without its
 * before — a breakdown revision read as "cells: Navy/L 2000" with no sign of the grid it
 * overwrites, which is exactly where the decision lives.
 *
 * Deliberately the SAME read `approve` uses to capture `before` for the audit log, so the
 * diff a person signs is the diff the trail will record. A second, cleverer reader would
 * eventually disagree with the first, and the one people trust is whichever they saw.
 *
 * Keys come back camelCased. Postgres returns `paid_amount` and payloads say `paidAmount`;
 * matching them raw would leave every field with no before and render an update as though
 * it were all new — a confident, wrong diff, which is worse than none.
 */
export async function currentRow(
  ctx: AnyCtx,
  targetTable: string,
  targetId: string | null,
): Promise<Record<string, unknown> | null> {
  // An insert has nothing before it. Not an error — most drafts are inserts.
  if (!targetId) return null

  return withTenantRead(ctx, async (tx) => {
    const row = await readRow(tx, targetTable, targetId)
    if (!row) return null

    return Object.fromEntries(
      Object.entries(row).map(([column, value]) => [
        column.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase()),
        value,
      ]),
    )
  })
}

async function readRow(
  tx: TenantDb,
  table: string,
  id: string,
): Promise<Record<string, unknown> | null> {
  const result = await tx.execute(
    sql`select * from ${sql.identifier(assertIdentifier(table))} where id = ${id}`,
  )
  return rowsOf(result)[0] ?? null
}

async function applyChange(
  tx: TenantDb,
  ctx: AnyCtx,
  change: {
    operation: Operation
    targetTable: string
    targetId: string | null
    payload: Record<string, unknown>
  },
): Promise<string> {
  const table = sql.identifier(assertIdentifier(change.targetTable))

  if (change.operation === 'delete') {
    const result = await tx.execute(
      sql`delete from ${table} where id = ${change.targetId} returning id`,
    )
    return firstId(result, 'delete')
  }

  if (change.operation === 'update') {
    const assignments = Object.entries(change.payload).map(
      ([column, value]) => sql`${sql.identifier(assertIdentifier(column))} = ${value}`,
    )
    if (assignments.length === 0) {
      throw new AppError('validation_failed', 'errors.empty_update', {})
    }
    const result = await tx.execute(
      sql`update ${table} set ${sql.join(assignments, sql`, `)} where id = ${change.targetId} returning id`,
    )
    return firstId(result, 'update')
  }

  // Insert. company_id comes from ctx, never from the payload — a draft must not be able
  // to name the tenant it lands in, and RLS would reject it anyway.
  const columns = Object.keys(change.payload).map((c) => assertIdentifier(c))
  const result = await tx.execute(sql`
    insert into ${table} (${sql.join(
      [...columns.map((c) => sql.identifier(c)), sql.identifier('company_id')],
      sql`, `,
    )})
    values (${sql.join(
      [...columns.map((c) => sql`${change.payload[c]}`), sql`${ctx.companyId}`],
      sql`, `,
    )})
    returning id
  `)
  return firstId(result, 'insert')
}

function firstId(result: unknown, operation: string): string {
  const row = rowsOf(result)[0]
  if (!row?.id) throw new AppError('internal', 'errors.commit_failed', { operation })
  return String(row.id)
}
