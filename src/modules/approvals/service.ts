/**
 * X.1 Approve Inbox.
 *
 * The trust layer's front door. Every AI- or junior-drafted write in this system lands in
 * `pending_changes` (CLAUDE.md rule 3), and this module is what a human uses to see it,
 * correct it and sign it off.
 *
 * It owns almost no data of its own. `pending_changes`, `pending_change_approvals` and
 * `approval_rules` all belong to core — the mechanism is core's, the *review workflow* is
 * this module's. What lives here is: who should be looking at what, how long it has been
 * waiting, and the chain from a draft to the row it became.
 */
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm'

import {
  approvalRules,
  auditLog,
  pendingChangeApprovals,
  pendingChanges,
  users,
} from '@/db/schema/core'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx, Role } from '../core/ctx'
import { AppError, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { getModule } from '../core/registry'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { APPROVALS_EVENTS } from './events'

/**
 * ⚖ — and arguably the most ⚖ table in the system.
 *
 * `approval_rules` decides who may approve what, so a change here is a change to every other
 * control: four modules already carry a comment saying "a floor that lives only in
 * `approval_rules` is a floor somebody can edit their way past". It was the one such table
 * writing no `audit_log` row at all, which meant the edit that widened a control left less
 * trace than the change it then let through.
 */
registerAuditedTables('approval_rules')

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface ApprovalsPolicy {
  /** Hours a draft may wait before it escalates. Brief says 48. */
  agingEscalateAfterHours: number
}

export interface InboxItem {
  id: string
  moduleId: string
  targetTable: string
  operation: string
  source: string
  createdAt: Date
  ageHours: number
  /** Lowest per-field confidence. The field the extractor was least sure about. */
  weakestConfidence: number | null
  requiredRoles: readonly Role[]
  approvalsRequired: number
  approvals: number
  /** True when THIS user has already approved and is waiting on somebody else. */
  approvedByMe: boolean
}

/**
 * What this reviewer should be looking at.
 *
 * Filtered by the roles they actually hold — an inbox showing drafts somebody cannot act on
 * is an inbox they stop opening. Drafts they have already approved stay VISIBLE but marked,
 * because on a two-approver rule the useful thing to know is that it is waiting on a
 * colleague, not that it has vanished.
 *
 * Ordered oldest first: the one closest to escalating is the one to do next.
 */
export async function inbox(
  ctx: AnyCtx,
  input: { now: Date; moduleId?: string; limit?: number },
  policy: ApprovalsPolicy,
): Promise<InboxItem[]> {
  return withTenantRead(ctx, async (tx) => {
    const drafts = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, 
        and(
          eq(pendingChanges.status, 'pending'),
          input.moduleId ? eq(pendingChanges.moduleId, input.moduleId) : undefined,
        ),
      ))
      .orderBy(asc(pendingChanges.createdAt))
      .limit(input.limit ?? 200)

    if (drafts.length === 0) return []

    const approvals = await tx
      .select({
        pendingChangeId: pendingChangeApprovals.pendingChangeId,
        approverUserId: pendingChangeApprovals.approverUserId,
      })
      .from(pendingChangeApprovals)
      .where(scoped(pendingChangeApprovals, ctx, 
        inArray(
          pendingChangeApprovals.pendingChangeId,
          drafts.map((d) => d.id),
        ),
      ))

    const rules = await loadRules(tx, ctx)
    const out: InboxItem[] = []

    for (const draft of drafts) {
      const rule = matchRule(rules, draft)
      // Only what this reviewer can actually act on.
      if (!rule.requiredRoles.some((role) => ctx.roles.includes(role))) continue

      const mine = approvals.filter((a) => a.pendingChangeId === draft.id)
      const confidences = Object.values(
        (draft.fieldConfidence ?? {}) as Record<string, number>,
      )

      out.push({
        id: draft.id,
        moduleId: draft.moduleId,
        targetTable: draft.targetTable,
        operation: draft.operation,
        source: draft.source,
        createdAt: draft.createdAt,
        ageHours: hoursBetween(draft.createdAt, input.now),
        // The MINIMUM, not the average — an average hides the one field the extractor was
        // unsure about, which is the field a reviewer needs to look at.
        weakestConfidence: confidences.length > 0 ? Math.min(...confidences) : null,
        requiredRoles: rule.requiredRoles,
        approvalsRequired: rule.approvalsRequired,
        approvals: mine.length,
        approvedByMe: mine.some((a) => a.approverUserId === ctx.userId),
      })
    }

    void policy
    return out
  })
}

/** Pending counts per module — the badge on a navigation item. */
export async function inboxCounts(
  ctx: AnyCtx,
): Promise<{ moduleId: string; pending: number }[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select({ moduleId: pendingChanges.moduleId, pending: count() })
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.status, 'pending')))
      .groupBy(pendingChanges.moduleId)
      .orderBy(desc(count())),
  )
}

async function loadRules(tx: TenantDb, ctx: AnyCtx) {
  return tx
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.companyId, ctx.companyId), eq(approvalRules.isActive, true)))
    .orderBy(desc(approvalRules.priority))
}

/** Just enough of an `approval_rules` row to decide a match. */
export interface MatchableRule {
  moduleId: string
  targetTable: string | null
  operation: string | null
  requiredRoles: readonly Role[]
  approvalsRequired: number
}

/**
 * Which rule governs a draft.
 *
 * Deliberately the same matching order as core's `resolveRule`: highest priority first, and
 * a null `target_table` or `operation` means "every one". If the inbox and the approve path
 * disagreed about who may approve, a reviewer would see a draft they are then refused on.
 *
 * Note what this does NOT do: it does not prefer a specific rule to a wildcard. The list
 * arrives ordered by priority, and the FIRST match wins — so a `target_table: null` rule at
 * priority 200 beats an exact-table rule at 100. Surprising, and correct only because core
 * does exactly the same thing; the pair are tested against each other rather than each
 * against its own reading of the intent.
 *
 * Exported for that test. It is the one piece of routing logic in this module that exists
 * twice in the codebase, which makes it the one piece that can silently drift.
 */
export function matchRule(
  rules: readonly MatchableRule[],
  draft: { moduleId: string; targetTable: string; operation: string },
): { requiredRoles: readonly Role[]; approvalsRequired: number } {
  const match = rules.find(
    (rule) =>
      rule.moduleId === draft.moduleId &&
      (rule.targetTable === null || rule.targetTable === draft.targetTable) &&
      (rule.operation === null || rule.operation === draft.operation),
  )

  if (match) {
    return { requiredRoles: match.requiredRoles, approvalsRequired: match.approvalsRequired }
  }

  const definition = getModule(draft.moduleId)
  return {
    requiredRoles: definition?.approvalDefaults.requiredRoles ?? ['owner'],
    approvalsRequired: definition?.approvalDefaults.approvalsRequired ?? 1,
  }
}

/** Read-only preview of who may approve a draft — the "who can sign this?" panel. */
export async function approversFor(
  ctx: AnyCtx,
  input: { pendingChangeId: string },
): Promise<{ requiredRoles: readonly Role[]; approvalsRequired: number; approvals: number }> {
  return withTenantRead(ctx, async (tx) => {
    const [draft] = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, input.pendingChangeId)))

    if (!draft) {
      throw notFound('approvals.errors.draft_not_found', {
        pendingChangeId: input.pendingChangeId,
      })
    }

    const rule = matchRule(await loadRules(tx, ctx), draft)
    const [tally] = await tx
      .select({ n: count() })
      .from(pendingChangeApprovals)
      .where(scoped(pendingChangeApprovals, ctx, eq(pendingChangeApprovals.pendingChangeId, draft.id)))

    return { ...rule, approvals: tally?.n ?? 0 }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Aging (brief §Jobs: ">48h pending → escalation")
// ─────────────────────────────────────────────────────────────────────────────

export interface AgingDraft {
  id: string
  moduleId: string
  targetTable: string
  ageHours: number
  requiredRoles: readonly Role[]
  approvals: number
  approvalsRequired: number
}

/**
 * Drafts that have waited too long.
 *
 * A draft blocks whatever proposed it — an unapproved BOM is an unquoted style, an
 * unapproved scenario is an unplanned line. The escalation exists because the cost of a
 * draft sitting is invisible until somebody asks why nothing happened.
 */
export async function agingDrafts(
  ctx: AnyCtx,
  input: { now: Date },
  policy: ApprovalsPolicy,
): Promise<AgingDraft[]> {
  return withTenantRead(ctx, async (tx) => {
    const cutoff = new Date(input.now.getTime() - policy.agingEscalateAfterHours * 3_600_000)

    const drafts = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, and(eq(pendingChanges.status, 'pending'), lte(pendingChanges.createdAt, cutoff))))
      .orderBy(asc(pendingChanges.createdAt))

    if (drafts.length === 0) return []

    const tallies = await tx
      .select({
        pendingChangeId: pendingChangeApprovals.pendingChangeId,
        n: count(),
      })
      .from(pendingChangeApprovals)
      .where(scoped(pendingChangeApprovals, ctx, 
        inArray(
          pendingChangeApprovals.pendingChangeId,
          drafts.map((d) => d.id),
        ),
      ))
      .groupBy(pendingChangeApprovals.pendingChangeId)

    const rules = await loadRules(tx, ctx)

    return drafts.map((draft) => {
      const rule = matchRule(rules, draft)
      return {
        id: draft.id,
        moduleId: draft.moduleId,
        targetTable: draft.targetTable,
        ageHours: hoursBetween(draft.createdAt, input.now),
        requiredRoles: rule.requiredRoles,
        approvals: tallies.find((t) => t.pendingChangeId === draft.id)?.n ?? 0,
        approvalsRequired: rule.approvalsRequired,
      }
    })
  })
}

/**
 * Raise the aging escalations.
 *
 * **Not idempotent, and this used to claim it was.** The comment here said "idempotent per
 * run by the outbox's own dedupe"; `emit` is a plain INSERT with no dedupe key, and the
 * dedupe that does exist is consumer-side (`markProcessed`) keyed on the outbox row's own
 * id — which is new on every insert. So two runs produce two events for the same draft and
 * both get delivered.
 *
 * That matters because the scheduler runs this daily and a draft stays aging until somebody
 * acts on it: a draft ignored for a week raises seven escalations. A daily nudge is arguably
 * the intended behaviour for something that is, by definition, being ignored — but it was
 * never decided, only assumed away by a comment. Recorded in docs/STUBS.md.
 */
export async function emitAgingEscalations(
  // `AnyCtx`, not `RequestCtx`: this is a nightly job and the scheduler runs it as a system
  // actor. It reads nothing off the caller but the company — nobody authored these alerts.
  ctx: AnyCtx,
  input: { now: Date },
  policy: ApprovalsPolicy,
): Promise<{ raised: number }> {
  const aging = await agingDrafts(ctx, input, policy)
  if (aging.length === 0) return { raised: 0 }

  return withTenantTx(ctx, async (tx) => {
    for (const draft of aging) {
      await emit(ctx, tx, {
        eventName: APPROVALS_EVENTS.draftAging,
        payload: { ...draft, thresholdHours: policy.agingEscalateAfterHours },
        aggregateTable: 'pending_changes',
        aggregateId: draft.id,
      })
    }
    return { raised: aging.length }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit chain (brief: "full audit chain query — drafted → reviewed → committed row FK")
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditChain {
  draft: typeof pendingChanges.$inferSelect
  approvals: {
    approverUserId: string
    approverName: string | null
    approvedAsRole: string
    corrections: Record<string, unknown>
    at: Date
  }[]
  /** The audit_log rows written against the row this draft became. */
  committedAudit: (typeof auditLog.$inferSelect)[]
}

/**
 * Drafted → reviewed → committed, in one read.
 *
 * The question this answers is "where did this row come from, and who let it in?" — asked
 * when a figure is disputed months later. It joins the draft to its approvals and to the
 * audit rows written against the row it became, which is why `committed_row_id` exists.
 */
export async function auditChain(
  ctx: AnyCtx,
  input: { pendingChangeId: string },
): Promise<AuditChain> {
  return withTenantRead(ctx, async (tx) => {
    const [draft] = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, input.pendingChangeId)))

    if (!draft) {
      throw notFound('approvals.errors.draft_not_found', {
        pendingChangeId: input.pendingChangeId,
      })
    }

    const approvals = await tx
      .select({
        approverUserId: pendingChangeApprovals.approverUserId,
        approverName: users.name,
        approvedAsRole: pendingChangeApprovals.approvedAsRole,
        corrections: pendingChangeApprovals.corrections,
        at: pendingChangeApprovals.createdAt,
      })
      .from(pendingChangeApprovals)
      .leftJoin(users, eq(pendingChangeApprovals.approverUserId, users.id))
      .where(scoped(pendingChangeApprovals, ctx, eq(pendingChangeApprovals.pendingChangeId, draft.id)))
      .orderBy(asc(pendingChangeApprovals.createdAt))

    const committedAudit = draft.committedRowId
      ? await tx
          .select()
          .from(auditLog)
          .where(scoped(auditLog, ctx, 
            and(
              eq(auditLog.targetTable, draft.targetTable),
              eq(auditLog.targetId, draft.committedRowId),
            ),
          ))
          .orderBy(asc(auditLog.occurredAt))
      : []

    return { draft, approvals, committedAudit }
  })
}

/**
 * Correction telemetry: how often each module's drafts are edited before approval.
 *
 * The number that says whether an extractor is worth trusting. A module whose drafts are
 * always corrected is a module whose drafts should not be auto-approved, whatever its
 * confidence scores claim.
 */
export async function correctionRates(
  ctx: AnyCtx,
): Promise<{ moduleId: string; reviewed: number; corrected: number; correctionRate: string }[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        moduleId: pendingChanges.moduleId,
        reviewed: count(),
        corrected: sql<string>`sum(case when ${pendingChanges.corrections}::text <> '{}' then 1 else 0 end)::text`,
      })
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, 
        and(
          ne(pendingChanges.status, 'pending'),
          // Auto-approved drafts never met a reviewer, so they say nothing about whether a
          // human would have corrected them. `reviewed_by` is the marker: only a human
          // review sets it.
          isNotNull(pendingChanges.reviewedBy),
        ),
      ))
      .groupBy(pendingChanges.moduleId)

    return rows.map((row) => {
      const corrected = Number(row.corrected ?? '0')
      return {
        moduleId: row.moduleId,
        reviewed: row.reviewed,
        corrected,
        correctionRate: correctionRate(row.reviewed, corrected),
      }
    })
  })
}

/**
 * Corrected drafts as a percentage of reviewed ones, to two places.
 *
 * A percentage with no denominator is the lie this guards against: zero of zero is not a
 * perfect record, and reporting it as `0.00` alongside a real 0.00 would make a module
 * nobody has reviewed look like a module nobody has ever had to correct. The caller gets
 * `reviewed` back beside the rate for exactly that reason — quote both or neither.
 */
export function correctionRate(reviewed: number, corrected: number): string {
  return reviewed === 0 ? '0.00' : ((corrected / reviewed) * 100).toFixed(2)
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Create or replace an approval rule.
 *
 * Owner-only, and deliberately so: a rule decides who may approve what, so somebody who can
 * edit rules can approve anything. That is the one privilege that cannot be delegated to the
 * role it governs.
 *
 * ## It used to only ever insert
 *
 * The name said upsert and the body was a bare INSERT, so calling it twice for the same
 * (module, target, operation) left TWO active rules. `matchRule` takes the first by priority
 * — on equal priority, whichever Postgres returned first. An owner tightening a rule from
 * one approver to two could therefore get the old rule back on the next draft, with nothing
 * anywhere saying which one applied. A control that silently fails open is worse than one
 * that is missing, because the screen shows it as set.
 *
 * So the prior rule for the same scope is superseded — `is_active = false`, never deleted.
 * "Who was allowed to approve this in March" is a question a deleted row cannot answer, and
 * it is the question this table exists for.
 *
 * Scope is (module, target, operation) exactly. A rule for one target and a rule for the
 * whole module are different rules and both stay live; the priority ordering already decides
 * between them, deterministically, because their scopes differ.
 */
export async function upsertApprovalRule(
  ctx: RequestCtx,
  input: {
    moduleId: string
    targetTable?: string
    operation?: 'insert' | 'update' | 'delete'
    requiredRoles: Role[]
    approvalsRequired?: number
    autoApprove?: boolean
    minConfidence?: string
    priority?: number
  },
): Promise<{ ruleId: string; supersededRuleIds: string[] }> {
  if (!ctx.roles.includes('owner')) {
    throw new AppError('forbidden', 'approvals.errors.rules_are_owner_only', { roles: ctx.roles })
  }
  if (input.requiredRoles.length === 0) {
    // A rule nobody can satisfy is a permanently blocked queue.
    throw new AppError('validation_failed', 'approvals.errors.no_required_roles', {})
  }
  if (input.autoApprove && !input.minConfidence) {
    // Auto-approval without a confidence floor is not a rule, it is switching the trust
    // layer off for that target.
    throw new AppError('validation_failed', 'approvals.errors.auto_approve_needs_floor', {})
  }

  const targetTable = input.targetTable ?? null
  const operation = input.operation ?? null

  return withTenantTx(ctx, async (tx) => {
    // The exact scope this rule governs. `is null` rather than `= null`, because a rule for
    // the whole module and a rule for one table are different rules — and `= null` is never
    // true, so an equality comparison would supersede nothing and leave the duplicate.
    const sameScope = and(
      eq(approvalRules.companyId, ctx.companyId),
      eq(approvalRules.moduleId, input.moduleId),
      targetTable === null
        ? isNull(approvalRules.targetTable)
        : eq(approvalRules.targetTable, targetTable),
      operation === null
        ? isNull(approvalRules.operation)
        : eq(approvalRules.operation, operation),
      eq(approvalRules.isActive, true),
    )

    const superseded = await tx
      .update(approvalRules)
      .set({ isActive: false, updatedAt: new Date() })
      .where(scoped(approvalRules, ctx, sameScope))
      .returning({
        id: approvalRules.id,
        requiredRoles: approvalRules.requiredRoles,
        approvalsRequired: approvalRules.approvalsRequired,
        autoApprove: approvalRules.autoApprove,
        minConfidence: approvalRules.minConfidence,
        priority: approvalRules.priority,
      })

    const [row] = await tx
      .insert(approvalRules)
      .values({
        companyId: ctx.companyId,
        moduleId: input.moduleId,
        targetTable,
        operation,
        requiredRoles: input.requiredRoles,
        approvalsRequired: input.approvalsRequired ?? 1,
        autoApprove: input.autoApprove ?? false,
        minConfidence: input.minConfidence ?? null,
        priority: input.priority ?? 100,
      })
      .returning({ id: approvalRules.id })

    if (!row) throw new Error('approval_rules insert returned nothing')

    // ⚖ — in the same transaction, so the trail and the change share a fate. `before` is the
    // rule that was in force, which is the whole point: "who widened this, and from what".
    // Recorded as an update when it replaced something, so the trail reads as one edit
    // rather than as an unexplained new rule beside a silently retired one.
    await recordChange(ctx, tx, {
      action: superseded.length > 0 ? 'update' : 'insert',
      targetTable: 'approval_rules',
      targetId: row.id,
      before: superseded[0] ? { ...superseded[0] } : null,
      after: {
        id: row.id,
        moduleId: input.moduleId,
        targetTable,
        operation,
        requiredRoles: input.requiredRoles,
        approvalsRequired: input.approvalsRequired ?? 1,
        autoApprove: input.autoApprove ?? false,
        minConfidence: input.minConfidence ?? null,
        priority: input.priority ?? 100,
        supersededRuleIds: superseded.map((r) => r.id),
      },
    })

    return { ruleId: row.id, supersededRuleIds: superseded.map((r) => r.id) }
  })
}

/**
 * Whole hours waited, rounded DOWN.
 *
 * Down, so a draft never reports an hour it has not actually waited — the number sits next
 * to an escalation threshold, and rounding up would escalate things forty minutes early and
 * teach people the threshold is approximate. `aging` itself is decided on the same floored
 * number, so what the row says and what escalates cannot disagree.
 */
export function hoursBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 3_600_000)
}

/**
 * Retire a rule, falling back to whatever governs beneath it — a narrower rule, or the
 * module's registered defaults. Owner-only and audited for the same reason the upsert is:
 * `approval_rules` decides who may approve what, and a silent change here rewrites every
 * other module's controls (adoption plan 3.2 — the door the upsert never had).
 */
export async function deactivateApprovalRule(
  ctx: RequestCtx,
  input: { ruleId: string },
): Promise<{ ruleId: string }> {
  if (!ctx.roles.includes('owner')) {
    throw new AppError('forbidden', 'approvals.errors.rules_are_owner_only', { roles: ctx.roles })
  }

  return withTenantTx(ctx, async (tx) => {
    const [rule] = await tx
      .select()
      .from(approvalRules)
      .where(scoped(approvalRules, ctx, eq(approvalRules.id, input.ruleId)))
      .for('update')
    if (!rule || !rule.isActive) {
      throw notFound('approvals.errors.rule_not_found', { ruleId: input.ruleId })
    }

    await tx
      .update(approvalRules)
      .set({ isActive: false, updatedAt: new Date() })
      .where(scoped(approvalRules, ctx, eq(approvalRules.id, rule.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'approval_rules',
      targetId: rule.id,
      before: { moduleId: rule.moduleId, targetTable: rule.targetTable, operation: rule.operation, isActive: true },
      after: { isActive: false },
    })

    return { ruleId: rule.id }
  })
}
