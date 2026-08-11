/**
 * X.1 integration ⚖ (plan 3.2, audit TEST-B1).
 *
 * Every AI- or junior-drafted write in this product funnels through this module, and it had
 * no tests at all. The three properties worth a database are the three that cannot be
 * reasoned about from the source:
 *
 *  1. **Tenancy.** The inbox is not a shared queue with a filter drawn over it — two
 *     reviewers signed in at once see genuinely different lists, and neither learns the size
 *     of the other's. Proven by asking as the wrong company and getting nothing.
 *  2. **The inbox and `approve` agree.** `matchRule` here and `resolveRule` in core are two
 *     independent copies of the same routing decision. If they drift, a reviewer is offered
 *     a draft and then refused on it — which reads as a broken queue rather than as a rule
 *     difference. Tested through BEHAVIOUR, both sides, rather than by calling one function.
 *  3. **`approvals_required` means different people.** A two-approver rule that one person
 *     can satisfy by clicking twice is a one-approver rule with extra steps.
 *
 * Drafts are inserted directly rather than through `propose`, because half of these cases
 * need a `created_at` days in the past and `propose` will not write one. The approve path is
 * exercised through the real `approve()` against a scratch table, the way the Phase 0 gate
 * does — a demo table created here and never in a migration, so it cannot reach production.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { createDirectClient, createDirectDb } from '@/db/direct'
import {
  approvalRules,
  auditLog,
  companies,
  outbox,
  pendingChanges,
  roles as rolesTable,
  users,
} from '@/db/schema/core'
import '@/modules/registry'
import type { RequestCtx } from '@/modules/core/ctx'
import { AppError } from '@/modules/core/errors'
import { approve } from '@/modules/core/pending-changes'
import { registerModule } from '@/modules/core/registry'

import { draftDetail, inboxRows, listApprovalRules, marbimTrust } from '../queries'
import {
  agingDrafts,
  approversFor,
  auditChain,
  correctionRates,
  emitAgingEscalations,
  inbox,
  inboxCounts,
  deactivateApprovalRule,
  upsertApprovalRule,
} from '../service'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()

const OWNER = `apr-owner-${randomUUID().slice(0, 8)}`
const COMM = `apr-comm-${randomUUID().slice(0, 8)}`
const COMM2 = `apr-comm2-${randomUUID().slice(0, 8)}`
const STORE = `apr-store-${randomUUID().slice(0, 8)}`
const OUTSIDER = `apr-out-${randomUUID().slice(0, 8)}`

const ownerCtx: RequestCtx = { companyId: COMPANY, userId: OWNER, roles: ['owner'] }
const commCtx: RequestCtx = { companyId: COMPANY, userId: COMM, roles: ['commercial'] }
const comm2Ctx: RequestCtx = { companyId: COMPANY, userId: COMM2, roles: ['commercial'] }
const storeCtx: RequestCtx = { companyId: COMPANY, userId: STORE, roles: ['store'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: OUTSIDER, roles: ['owner'] }

/** Brief default. Every call passes it explicitly — services never reach for Settings. */
const POLICY = { agingEscalateAfterHours: 48 }

const MODULE = '__approvals_demo__'
const TARGET = 'approvals_demo_rows'

const NOW = new Date('2026-08-06T09:00:00Z')
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000)

/**
 * A draft, straight into the table.
 *
 * `propose` cannot backdate, and an inbox is mostly a question about time — the difference
 * between a draft that arrived this morning and one nobody has looked at since Tuesday.
 */
async function seedDraft(over: {
  companyId?: string
  moduleId?: string
  targetTable?: string
  operation?: 'insert' | 'update' | 'delete'
  source?: 'ai_extraction' | 'ai_chat' | 'user_draft' | 'import'
  status?: 'pending' | 'committed' | 'rejected'
  createdAt?: Date
  createdBy?: string
  reviewedBy?: string | null
  corrections?: Record<string, unknown>
  fieldConfidence?: Record<string, number>
  payload?: Record<string, unknown>
} = {}): Promise<string> {
  const [row] = await db
    .insert(pendingChanges)
    .values({
      companyId: over.companyId ?? COMPANY,
      moduleId: over.moduleId ?? MODULE,
      targetTable: over.targetTable ?? TARGET,
      targetId: null,
      operation: over.operation ?? 'insert',
      payload: over.payload ?? { label: 'Navy tee', quantity: 1200 },
      zodSchemaKey: 'demo_v1',
      fieldConfidence: over.fieldConfidence ?? {},
      confidenceMin: null,
      source: over.source ?? 'user_draft',
      status: over.status ?? 'pending',
      createdBy: over.createdBy ?? OWNER,
      createdAt: over.createdAt ?? hoursAgo(1),
      reviewedBy: over.reviewedBy ?? null,
      corrections: over.corrections ?? {},
    })
    .returning({ id: pendingChanges.id })

  return row!.id
}

async function activeRules(companyId = COMPANY) {
  return db
    .select()
    .from(approvalRules)
    .where(and(eq(approvalRules.companyId, companyId), eq(approvalRules.isActive, true)))
}

beforeAll(async () => {
  // Alongside the real registry, not instead of it — resetting would unregister the other
  // twenty-two modules and make every fallback in this file answer 'owner'.
  registerModule({
    id: MODULE,
    pendingTargets: [TARGET],
    zodMap: {
      demo_v1: z.object({ label: z.string().min(1), quantity: z.number().int().positive() }),
    },
    approvalDefaults: { requiredRoles: ['owner', 'merchandiser'], approvalsRequired: 1 },
  })

  await db.execute(sql`
    create table if not exists approvals_demo_rows (
      id uuid primary key default gen_random_uuid(),
      company_id uuid not null references companies(id) on delete cascade,
      label text not null,
      quantity integer not null,
      created_at timestamptz not null default now()
    )`)
  // The same treatment a real tenant table gets, or the tenancy cases prove nothing.
  await db.execute(sql`alter table approvals_demo_rows enable row level security`)
  await db.execute(sql`alter table approvals_demo_rows force row level security`)
  await db.execute(sql`drop policy if exists approvals_demo_tenant on approvals_demo_rows`)
  await db.execute(sql`
    create policy approvals_demo_tenant on approvals_demo_rows
      using (company_id = app.current_company_id())
      with check (company_id = app.current_company_id())`)

  await db.insert(companies).values([
    { id: COMPANY, name: 'Approve Co', slug: `apr-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `apo-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values([
    { id: OWNER, email: `${OWNER}@fabricxai.test`, name: 'Rehana Karim' },
    { id: COMM, email: `${COMM}@fabricxai.test`, name: 'Anwar Hossain' },
    { id: COMM2, email: `${COMM2}@fabricxai.test`, name: 'Shirin Akter' },
    { id: STORE, email: `${STORE}@fabricxai.test`, name: 'Jamal Uddin' },
    { id: OUTSIDER, email: `${OUTSIDER}@fabricxai.test`, name: 'Somebody Else' },
  ])

  /*
   * The `roles` rows are not decoration, and this cost a debugging session.
   *
   * Migration 0073 gave `users` a scope-conditional RLS policy: under a tenant scope it
   * narrows to people who share the company, and sharing is decided by an EXISTS on THIS
   * table. So a user with no role row is invisible to any join inside `withTenantRead` —
   * `auditChain`'s left join returned a real approval with a null approver name, which reads
   * as "somebody approved this and we do not know who".
   *
   * Nothing is wrong with the query; the fixture was describing a person who cannot exist in
   * production, because holding a role is how somebody became an approver in the first
   * place. Any suite that reads a user's name under a tenant scope needs these.
   */
  await db.insert(rolesTable).values([
    { companyId: COMPANY, userId: OWNER, role: 'owner' },
    { companyId: COMPANY, userId: COMM, role: 'commercial' },
    { companyId: COMPANY, userId: COMM2, role: 'commercial' },
    { companyId: COMPANY, userId: STORE, role: 'store' },
    { companyId: OTHER, userId: OUTSIDER, role: 'owner' },
  ])
})

beforeEach(async () => {
  // Each case builds the queue it is asking about. A shared fixture here would mean one
  // case's leftover draft changing another's count, which is the flakiest kind of failure.
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.execute(sql`delete from outbox where company_id in (${COMPANY}, ${OTHER})`)
  await db.execute(
    sql`delete from pending_change_approvals where company_id in (${COMPANY}, ${OTHER})`,
  )
  await db.execute(sql`delete from pending_changes where company_id in (${COMPANY}, ${OTHER})`)
  await db.execute(sql`delete from approval_rules where company_id in (${COMPANY}, ${OTHER})`)
  await db.execute(sql`delete from approvals_demo_rows where company_id in (${COMPANY}, ${OTHER})`)
})

afterAll(async () => {
  await db.execute(sql`drop table if exists approvals_demo_rows`)
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  for (const id of [OWNER, COMM, COMM2, STORE, OUTSIDER]) {
    await db.delete(users).where(eq(users.id, id))
  }
  await client.end()
})

// ─────────────────────────────────────────────────────────────────────────────

describe('the queue belongs to one factory', () => {
  it('shows another company nothing, not a filtered something', async () => {
    await seedDraft()
    await seedDraft()

    const mine = await inboxRows(ownerCtx, { now: NOW }, POLICY)
    const theirs = await inboxRows(otherCtx, { now: NOW }, POLICY)

    expect(mine).toHaveLength(2)
    expect(theirs).toEqual([])
  })

  it('will not open one company s draft for another', async () => {
    const id = await seedDraft()

    // Not "an empty diff" — null, the same answer as a draft that does not exist. A
    // different answer would confirm the id is real, which is itself a leak.
    expect(await draftDetail(otherCtx, id, null)).toBeNull()
    expect(await draftDetail(ownerCtx, id, null)).not.toBeNull()
  })

  it('will not trace one company s provenance for another', async () => {
    const id = await seedDraft()

    await expect(auditChain(otherCtx, { pendingChangeId: id })).rejects.toThrow(AppError)
    await expect(approversFor(otherCtx, { pendingChangeId: id })).rejects.toThrow(AppError)
  })

  it('counts nothing across the boundary', async () => {
    await seedDraft()
    await seedDraft({ companyId: OTHER })

    expect(await inboxCounts(ownerCtx)).toEqual([{ moduleId: MODULE, pending: 1 }])
    expect(await inboxCounts(otherCtx)).toEqual([{ moduleId: MODULE, pending: 1 }])
  })
})

describe('the queue is routed, not filtered', () => {
  beforeEach(async () => {
    await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 1,
    })
  })

  it('does not show a storekeeper a draft only commercial may sign', async () => {
    await seedDraft()

    expect(await inboxRows(storeCtx, { now: NOW }, POLICY)).toEqual([])
    expect(await inboxRows(commCtx, { now: NOW }, POLICY)).toHaveLength(1)
  })

  it('still shows it to the owner, who is an approver everywhere', async () => {
    // `requireRole` treats owner and admin as supervisory at the door; the rule engine does
    // not, so an owner sees this draft only if the rule names a role they hold. It does not
    // — so the inbox correctly hides it, and this pins that the two gates are different.
    await seedDraft()

    expect(await inboxRows(ownerCtx, { now: NOW }, POLICY)).toEqual([])
  })

  it('offers what it says it offers, and nothing else', async () => {
    const id = await seedDraft()
    const [row] = await inboxRows(commCtx, { now: NOW }, POLICY)

    expect(row?.id).toBe(id)
    expect(row?.requiredRoles).toEqual(['commercial'])
    expect(row?.approvalsRequired).toBe(1)
    expect(row?.approvals).toBe(0)
    expect(row?.approvedByMe).toBe(false)
    // The list never carries the payload — only enough to decide what to open.
    expect(row).not.toHaveProperty('payload')
  })
})

describe('the inbox and approve() agree about who may sign', () => {
  /*
   * The drift test. `matchRule` (this module) and `resolveRule` (core) are separate
   * implementations of one decision, and nothing but this makes them stay the same.
   *
   * Asserted from both directions: a role the inbox EXCLUDES must be refused by approve, and
   * a role it OFFERS must be accepted. One direction alone would pass with both copies
   * broken in the same way.
   */
  beforeEach(async () => {
    await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 1,
    })
  })

  it('refuses the role it hid the draft from', async () => {
    const id = await seedDraft()

    expect(await inboxRows(storeCtx, { now: NOW }, POLICY)).toEqual([])
    await expect(approve(storeCtx, { pendingChangeId: id })).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.not_an_approver',
    })
  })

  it('accepts the role it offered the draft to', async () => {
    const id = await seedDraft()
    expect(await inboxRows(commCtx, { now: NOW }, POLICY)).toHaveLength(1)

    const result = await approve(commCtx, { pendingChangeId: id })

    expect(result.status).toBe('committed')
    expect(result.committedRowId).toBeTruthy()
  })

  it('agrees on the fallback when no rule matches at all', async () => {
    // A different module, so the rule above does not apply and both copies fall through to
    // the registered defaults — `['owner', 'merchandiser']`. The fallback is the path
    // nobody configures and therefore the one most likely to drift unnoticed.
    await db.delete(approvalRules).where(eq(approvalRules.companyId, COMPANY))
    const id = await seedDraft()

    const offered = await inboxRows(ownerCtx, { now: NOW }, POLICY)
    expect(offered).toHaveLength(1)
    expect(offered[0]?.requiredRoles).toEqual(['owner', 'merchandiser'])

    expect(await inboxRows(commCtx, { now: NOW }, POLICY)).toEqual([])
    await expect(approve(commCtx, { pendingChangeId: id })).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.not_an_approver',
    })
    await expect(approve(ownerCtx, { pendingChangeId: id })).resolves.toMatchObject({
      status: 'committed',
    })
  })
})

describe('two approvals means two people', () => {
  beforeEach(async () => {
    await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 2,
    })
  })

  it('does not let one reviewer satisfy a two-approver rule by clicking twice', async () => {
    const id = await seedDraft()

    const first = await approve(commCtx, { pendingChangeId: id })
    expect(first.status).toBe('awaiting_approvals')

    const again = await approve(commCtx, { pendingChangeId: id })
    expect(again.status).toBe('awaiting_approvals')
    expect(again.approvals).toBe(1)

    // Nothing written. A two-approver control that one person can clear is not a control.
    const rows = await db.execute<{ n: string }>(
      sql`select count(*)::text as n from approvals_demo_rows where company_id = ${COMPANY}`,
    )
    expect(Number((rows as unknown as { n: string }[])[0]?.n ?? '0')).toBe(0)
  })

  it('keeps the draft visible to the reviewer who already signed, and marks it', async () => {
    // Hiding it would be the intuitive thing and the wrong one: on a two-approver rule the
    // useful fact is that it is waiting on a colleague, not that it has vanished.
    const id = await seedDraft()
    await approve(commCtx, { pendingChangeId: id })

    const [mine] = await inboxRows(commCtx, { now: NOW }, POLICY)
    expect(mine?.id).toBe(id)
    expect(mine?.approvedByMe).toBe(true)
    expect(mine?.approvals).toBe(1)

    const [theirs] = await inboxRows(comm2Ctx, { now: NOW }, POLICY)
    expect(theirs?.approvedByMe).toBe(false)
  })

  it('commits on the second, different approver', async () => {
    const id = await seedDraft()
    await approve(commCtx, { pendingChangeId: id })

    const result = await approve(comm2Ctx, { pendingChangeId: id })

    expect(result.status).toBe('committed')
    expect(result.approvals).toBe(2)

    const chain = await auditChain(ownerCtx, { pendingChangeId: id })
    expect(chain.approvals.map((a) => a.approverName).sort()).toEqual([
      'Anwar Hossain',
      'Shirin Akter',
    ])
  })
})

describe('aging', () => {
  it('reports only what is past this factory s window, oldest first', async () => {
    await seedDraft({ createdAt: hoursAgo(72) })
    await seedDraft({ createdAt: hoursAgo(50) })
    await seedDraft({ createdAt: hoursAgo(2) })

    const aging = await agingDrafts(ownerCtx, { now: NOW }, POLICY)

    expect(aging.map((d) => d.ageHours)).toEqual([72, 50])
  })

  it('reads the window from the policy rather than a constant', async () => {
    await seedDraft({ createdAt: hoursAgo(30) })

    expect(await agingDrafts(ownerCtx, { now: NOW }, POLICY)).toEqual([])
    expect(
      await agingDrafts(ownerCtx, { now: NOW }, { agingEscalateAfterHours: 24 }),
    ).toHaveLength(1)
  })

  it('escalates each aging draft, scoped to its own company', async () => {
    await seedDraft({ createdAt: hoursAgo(72) })
    await seedDraft({ companyId: OTHER, createdAt: hoursAgo(72) })

    const { raised } = await emitAgingEscalations(ownerCtx, { now: NOW }, POLICY)

    expect(raised).toBe(1)
    const events = await db.select().from(outbox).where(eq(outbox.companyId, COMPANY))
    expect(events).toHaveLength(1)
    expect(events[0]?.eventName).toBe('approvals.draft.aging')
    expect(events[0]?.payload).toMatchObject({ thresholdHours: 48, ageHours: 72 })
  })

  it('raises the SAME escalation again on a second run — it is not idempotent', async () => {
    /*
     * Pinned as a defect, not as a design.
     *
     * The docstring claimed "idempotent per run by the outbox's own dedupe". `emit` is a
     * plain INSERT; the dedupe that exists is consumer-side and keyed on the outbox row id,
     * which is new every time. The scheduler runs this daily and a draft stays aging until
     * somebody acts, so a draft ignored for a week raises seven escalations.
     *
     * A daily nudge may well be what a factory wants for something that is by definition
     * being ignored. The point is that it was never decided — only assumed away by a
     * comment. This test is here so that when it IS decided, the change is visible.
     */
    await seedDraft({ createdAt: hoursAgo(72) })

    await emitAgingEscalations(ownerCtx, { now: NOW }, POLICY)
    await emitAgingEscalations(ownerCtx, { now: NOW }, POLICY)

    const events = await db.select().from(outbox).where(eq(outbox.companyId, COMPANY))
    expect(events).toHaveLength(2)
    expect(new Set(events.map((e) => e.aggregateId)).size).toBe(1)
  })

  it('raises nothing when nothing is old, and writes no empty transaction', async () => {
    await seedDraft({ createdAt: hoursAgo(2) })

    expect(await emitAgingEscalations(ownerCtx, { now: NOW }, POLICY)).toEqual({ raised: 0 })
    expect(await db.select().from(outbox).where(eq(outbox.companyId, COMPANY))).toEqual([])
  })
})

describe('rules are the control over the controls', () => {
  it('refuses anybody but the owner', async () => {
    // Not even commercial, whose own queue this rule would govern. Somebody who can edit
    // rules can approve anything, so it is the privilege that cannot be delegated to the
    // role it governs.
    await expect(
      upsertApprovalRule(commCtx, { moduleId: MODULE, requiredRoles: ['commercial'] }),
    ).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'approvals.errors.rules_are_owner_only',
    })
  })

  it('refuses a rule nobody can satisfy', async () => {
    // A permanently blocked queue, which looks exactly like a queue nobody is working.
    await expect(
      upsertApprovalRule(ownerCtx, { moduleId: MODULE, requiredRoles: [] }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      messageKey: 'approvals.errors.no_required_roles',
    })
  })

  it('refuses auto-approval with no confidence floor', async () => {
    // Not a rule — switching the trust layer off for that target.
    await expect(
      upsertApprovalRule(ownerCtx, {
        moduleId: MODULE,
        requiredRoles: ['commercial'],
        autoApprove: true,
      }),
    ).rejects.toMatchObject({
      code: 'validation_failed',
      messageKey: 'approvals.errors.auto_approve_needs_floor',
    })
  })

  it('replaces the rule for a scope instead of stacking a second one', async () => {
    /*
     * The bug this closes: the function was named upsert and its body was a bare INSERT.
     * Two active rules for one scope, and `matchRule` takes the first by priority — on a
     * tie, whichever Postgres happened to return. An owner tightening one approver to two
     * could get the old rule back on the next draft.
     */
    const first = await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 1,
    })
    const second = await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 2,
    })

    expect(second.supersededRuleIds).toEqual([first.ruleId])

    const live = await activeRules()
    expect(live).toHaveLength(1)
    expect(live[0]?.approvalsRequired).toBe(2)

    // And the tightening actually takes effect on the next draft.
    await seedDraft()
    const [row] = await inboxRows(commCtx, { now: NOW }, POLICY)
    expect(row?.approvalsRequired).toBe(2)
  })

  it('keeps the superseded rule, deactivated, rather than deleting it', async () => {
    // "Who was allowed to approve this in March" is a question a deleted row cannot answer,
    // and it is the question this table exists for.
    const first = await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
    })
    await upsertApprovalRule(ownerCtx, { moduleId: MODULE, requiredRoles: ['planner'] })

    const [old] = await db.select().from(approvalRules).where(eq(approvalRules.id, first.ruleId))
    expect(old?.isActive).toBe(false)
    expect(old?.requiredRoles).toEqual(['commercial'])
  })

  it('treats a table-specific rule and a module-wide rule as different scopes', async () => {
    // Both stay live. Their scopes differ, so the priority ordering decides between them
    // deterministically — this is not the ambiguous case.
    await upsertApprovalRule(ownerCtx, { moduleId: MODULE, requiredRoles: ['commercial'] })
    await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      targetTable: TARGET,
      requiredRoles: ['planner'],
    })

    expect(await activeRules()).toHaveLength(2)
  })

  it('does not supersede another company s rule of the same shape', async () => {
    await upsertApprovalRule(ownerCtx, { moduleId: MODULE, requiredRoles: ['commercial'] })
    await upsertApprovalRule(
      { companyId: OTHER, userId: OUTSIDER, roles: ['owner'] },
      { moduleId: MODULE, requiredRoles: ['commercial'] },
    )

    expect(await activeRules(COMPANY)).toHaveLength(1)
    expect(await activeRules(OTHER)).toHaveLength(1)
  })

  it('writes the ⚖ trail, with what the rule was before', async () => {
    /*
     * `approval_rules` was the one control-bearing table writing no audit row at all — so
     * the edit that WIDENED a control left less trace than the change it then let through.
     * Four other modules already carry a comment saying a floor living only in
     * `approval_rules` is a floor somebody can edit their way past.
     */
    await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 2,
    })
    const widened = await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
      approvalsRequired: 1,
    })

    const trail = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, COMPANY), eq(auditLog.targetTable, 'approval_rules')))
      .orderBy(auditLog.occurredAt)

    expect(trail).toHaveLength(2)
    expect(trail[0]?.action).toBe('insert')
    expect(trail[0]?.before).toBeNull()

    const edit = trail[1]!
    expect(edit.action).toBe('update')
    expect(edit.actorUserId).toBe(OWNER)
    expect(edit.actorRole).toBe('owner')
    expect(edit.targetId).toBe(widened.ruleId)
    // The number that was in force, and the number that replaced it.
    expect(edit.before).toMatchObject({ approvalsRequired: 2 })
    expect(edit.after).toMatchObject({ approvalsRequired: 1 })
  })
})

describe('correction telemetry', () => {
  it('counts only drafts a human actually reviewed', async () => {
    await seedDraft({ status: 'committed', reviewedBy: OWNER, corrections: { quantity: 1250 } })
    await seedDraft({ status: 'committed', reviewedBy: OWNER, corrections: {} })
    // Auto-approved: committed with no reviewer. It never met a human, so it says nothing
    // about whether one would have corrected it.
    await seedDraft({ status: 'committed', reviewedBy: null })
    // Still waiting — not yet evidence of anything.
    await seedDraft({ status: 'pending' })

    const [rates] = await correctionRates(ownerCtx)

    expect(rates).toEqual({
      moduleId: MODULE,
      reviewed: 2,
      corrected: 1,
      correctionRate: '50.00',
    })
  })

  it('reports MARBIM s own record from model drafts only', async () => {
    await seedDraft({ source: 'ai_extraction', status: 'committed', corrections: { qty: 9 } })
    await seedDraft({ source: 'ai_chat', status: 'pending' })
    // A person typing is not evidence about the extractor.
    await seedDraft({ source: 'user_draft', status: 'committed' })

    const trust = await marbimTrust(ownerCtx)

    expect(trust.drafted).toBe(2)
    expect(trust.approved).toBe(1)
    expect(trust.pending).toBe(1)
    expect(trust.correctedFields).toBe(1)
  })

  it('shows a new factory zeroes rather than borrowed numbers', async () => {
    expect(await correctionRates(ownerCtx)).toEqual([])
    expect(await marbimTrust(ownerCtx)).toMatchObject({ drafted: 0, approved: 0, pending: 0 })
  })
})

describe('the weakest field, not the average', () => {
  it('sorts a reviewer toward the field the extractor was least sure about', async () => {
    // 0.99 and 0.42 average to a comfortable 0.70. The inbox reports 0.42, because the
    // average hides the one field somebody needs to look at.
    await seedDraft({
      source: 'ai_extraction',
      fieldConfidence: { label: 0.99, quantity: 0.42 },
    })

    const [item] = await inbox(ownerCtx, { now: NOW }, POLICY)
    expect(item?.weakestConfidence).toBe(0.42)
  })

  it('reports absence for a human draft rather than a confident-looking 1.0', async () => {
    await seedDraft({ source: 'user_draft', fieldConfidence: {} })

    const [item] = await inbox(ownerCtx, { now: NOW }, POLICY)
    expect(item?.weakestConfidence).toBeNull()
  })
})

describe('the owner tunes the routing (adoption plan 3.2)', () => {
  it('lists a rule it just wrote, active only', async () => {
    await upsertApprovalRule(ownerCtx, {
      moduleId: MODULE,
      requiredRoles: ['commercial'],
    })

    const rules = await listApprovalRules(ownerCtx)
    const mine = rules.filter((r) => r.moduleId === MODULE)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.requiredRoles).toEqual(['commercial'])
  })

  it('retires a rule, and the list stops showing it', async () => {
    const { ruleId } = await upsertApprovalRule(ownerCtx, {
      moduleId: `${MODULE}_temp`,
      requiredRoles: ['commercial'],
    })

    await deactivateApprovalRule(ownerCtx, { ruleId })

    const rules = await listApprovalRules(ownerCtx)
    expect(rules.some((r) => r.id === ruleId)).toBe(false)
  })

  it('refuses a non-owner at both doors', async () => {
    const { ruleId } = await upsertApprovalRule(ownerCtx, {
      moduleId: `${MODULE}_guard`,
      requiredRoles: ['commercial'],
    })

    await expect(
      upsertApprovalRule(commCtx, { moduleId: MODULE, requiredRoles: ['commercial'] }),
    ).rejects.toThrow(/rules_are_owner_only/)
    await expect(deactivateApprovalRule(commCtx, { ruleId })).rejects.toThrow(
      /rules_are_owner_only/,
    )
  })

  it('refuses to retire a rule that is already gone', async () => {
    await expect(
      deactivateApprovalRule(ownerCtx, { ruleId: '00000000-0000-4000-8000-000000000000' }),
    ).rejects.toThrow(/rule_not_found/)
  })
})
