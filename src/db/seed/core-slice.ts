/**
 * Core seed slice — the only slice that exists at Phase 0.
 *
 * Everything here is idempotent: deterministic ids derived from the company id, and
 * `onConflictDoUpdate` / `onConflictDoNothing` throughout. Run the seed ten times and you
 * get the same database, which is what makes it usable before a demo or a k6 run.
 */
import { and, eq, sql } from 'drizzle-orm'
import { hashPassword } from 'better-auth/crypto'

import * as schema from '@/db/schema'
import { env } from '@/lib/env'

import { SEED_PASSWORD, seedEmail } from './identity'
import type { SeedContext, SeedSlice } from './types'

/*
 * `SEED_PASSWORD` and `seedEmail` come from ./identity, which the e2e suite imports too.
 *
 * Seeded users existed from the first day with roles, profiles and names — and no way to
 * sign in as any of them, because `pnpm seed` never wrote a credential. So the one thing
 * the role matrix is for, seeing what a storekeeper sees and what a viewer cannot, was
 * impossible without hand-crafting a scrypt hash.
 *
 * Hashed with Better Auth's own hasher rather than a hand-rolled one: the verifier at
 * login is theirs, and a hash it cannot read is a login that fails for reasons nobody
 * enjoys tracing.
 */

/** Roles worth having a real person behind for a demo walkthrough. */
const SEED_PEOPLE = [
  { key: 'owner', role: 'owner' as const, name: 'Rahima Chowdhury', dept: 'Management' },
  { key: 'merch', role: 'merchandiser' as const, name: 'Tanvir Ahmed', dept: 'Merchandising' },
  { key: 'commercial', role: 'commercial' as const, name: 'Farhana Islam', dept: 'Commercial' },
  { key: 'store', role: 'store' as const, name: 'Jashim Uddin', dept: 'Store' },
  { key: 'production', role: 'production' as const, name: 'Nasrin Akter', dept: 'Production' },
  { key: 'quality', role: 'quality' as const, name: 'Shahin Alam', dept: 'Quality' },
  { key: 'hr', role: 'hr' as const, name: 'Mizanur Rahman', dept: 'HR & Compliance' },
  { key: 'viewer', role: 'viewer' as const, name: 'Audit Observer', dept: 'External' },
]

/**
 * A password for a seeded user, so somebody can actually sign in as them.
 *
 * **Never in production.** A known password on every account is exactly the hole it looks
 * like, and a seed run against a live tenant by accident must not open it. The guard is
 * here rather than at the call site so no future slice can forget it.
 *
 * `emailVerified` is already true on these users, which matters because
 * `requireEmailVerification` is on — an unverified seeded account would refuse the login
 * with a message about an inbox that does not exist.
 */
async function seedCredential(ctx: SeedContext, userId: string): Promise<void> {
  if (env.NODE_ENV === 'production') return

  const existing = await ctx.db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'credential')),
    )
  if (existing.length > 0) return

  await ctx.db.insert(schema.accounts).values({
    id: `seed-cred-${userId}`,
    userId,
    accountId: userId,
    providerId: 'credential',
    password: await hashPassword(SEED_PASSWORD),
  })
}

async function seedPeople(ctx: SeedContext): Promise<number> {
  const wanted = SEED_PEOPLE.slice(0, Math.max(2, ctx.volume.users))
  let n = 0

  for (const person of wanted) {
    const short = ctx.companyId.slice(0, 8)
    const userId = `seed-${short}-${person.key}`
    // Scoped to the tenant, like the id already was. `users.email` is unique across the
    // whole install, so a fixed address meant the seed could only ever fill ONE company —
    // filling a second died on a duplicate key halfway through, leaving it half-seeded.
    const email = seedEmail(person.key, ctx.companyId)

    await ctx.db
      .insert(schema.users)
      .values({ id: userId, email, name: person.name, emailVerified: true })
      .onConflictDoUpdate({ target: schema.users.id, set: { name: person.name } })

    await ctx.db
      .insert(schema.profiles)
      .values({
        userId,
        fullName: person.name,
        department: person.dept,
        // The floor runs Bangla; the office runs English. Both against the same rows.
        locale: ['store', 'production', 'quality'].includes(person.key) ? 'bn' : 'en',
        defaultCompanyId: ctx.companyId,
      })
      .onConflictDoUpdate({ target: schema.profiles.userId, set: { fullName: person.name } })

    await ctx.db
      .insert(schema.roles)
      .values({ companyId: ctx.companyId, userId, role: person.role })
      .onConflictDoNothing()

    await seedCredential(ctx, userId)

    n += 1
  }

  return n
}

/**
 * Two rules that between them exercise both branches of the approve path: one that always
 * needs a human, one that may auto-approve but only above a confidence floor.
 */
async function seedApprovalRules(ctx: SeedContext): Promise<number> {
  const rules = [
    {
      moduleId: 'core',
      targetTable: null,
      requiredRoles: ['owner', 'admin'] as const,
      autoApprove: false,
      minConfidence: null,
      priority: 100,
    },
    {
      moduleId: 'core',
      targetTable: null,
      requiredRoles: ['owner'] as const,
      autoApprove: true,
      // Deliberately high: the demo should show most drafts still reaching a human.
      minConfidence: '0.950',
      priority: 500,
    },
  ]

  for (const rule of rules) {
    const existing = await ctx.db
      .select({ id: schema.approvalRules.id })
      .from(schema.approvalRules)
      .where(
        and(
          eq(schema.approvalRules.companyId, ctx.companyId),
          eq(schema.approvalRules.moduleId, rule.moduleId),
          eq(schema.approvalRules.priority, rule.priority),
        ),
      )

    if (existing.length > 0) continue

    await ctx.db.insert(schema.approvalRules).values({
      companyId: ctx.companyId,
      moduleId: rule.moduleId,
      targetTable: rule.targetTable,
      requiredRoles: [...rule.requiredRoles],
      autoApprove: rule.autoApprove,
      minConfidence: rule.minConfidence,
      priority: rule.priority,
    })
  }

  return rules.length
}

const DOCUMENT_KINDS = [
  { kind: 'buyer_po', name: 'buyer-po', mime: 'application/pdf' },
  { kind: 'lc', name: 'master-lc', mime: 'application/pdf' },
  { kind: 'challan', name: 'fabric-challan', mime: 'image/jpeg' },
  { kind: 'wage_sheet', name: 'wage-sheet', mime: 'application/pdf' },
  { kind: 'audit_report', name: 'compliance-audit', mime: 'application/pdf' },
  { kind: 'floor_sheet', name: 'handwritten-hourly', mime: 'image/jpeg' },
]

/**
 * Document ROWS only — no objects are uploaded to MinIO. The rows are what screens and
 * queries need; a seed that pushed megabytes of fake PDFs into storage on every run would
 * make the generator slow for no gain. `status` reflects that honestly.
 */
async function seedDocuments(ctx: SeedContext): Promise<number> {
  const count = Math.min(ctx.volume.documents, DOCUMENT_KINDS.length * 8)
  let n = 0

  for (let i = 0; i < count; i += 1) {
    const spec = DOCUMENT_KINDS[i % DOCUMENT_KINDS.length]!
    // Deterministic key so re-running updates the same row instead of adding one.
    const objectKey = `${ctx.companyId}/seed/${spec.name}-${String(i).padStart(3, '0')}.bin`

    await ctx.db
      .insert(schema.documents)
      .values({
        companyId: ctx.companyId,
        bucket: 'fabricxai-documents',
        objectKey,
        filename: `${spec.name}-${i + 1}.${spec.mime === 'application/pdf' ? 'pdf' : 'jpg'}`,
        mimeType: spec.mime,
        sizeBytes: 40_000 + Math.floor(ctx.rng() * 900_000),
        kind: spec.kind,
        moduleId: 'core',
        // No bytes were uploaded — say so rather than claiming 'ready'.
        status: 'uploaded',
        meta: { seeded: true },
      })
      .onConflictDoNothing()

    n += 1
  }

  return n
}

/**
 * Drafts in each state, so the approve inbox has something to show and every branch of
 * the pending flow is visible in a demo. Confidence values are varied on purpose: a
 * uniform 0.94 across every field is exactly the lie this system exists to avoid.
 */
async function seedPendingChanges(ctx: SeedContext): Promise<number> {
  const ownerId = `seed-${ctx.companyId.slice(0, 8)}-owner`

  const drafts: {
    key: string
    status: 'committed' | 'rejected'
    fieldConfidence: Record<string, number>
    source: 'ai_extraction' | 'user_draft'
  }[] = [
    /*
     * These land TERMINAL, not pending, and that changed after a live run.
     *
     * `core` registers no pending targets, so a `seed_demo_rows` draft can never be
     * approved — approving one throws "That module is not registered", which is correct and
     * useless. Seeded as `pending`, they sat at the TOP of every factory's approve inbox
     * (oldest first) above the real work, and the first thing a new approver did was click
     * Approve on one and get a sentence about module registration.
     *
     * The screen still gets its demo: a committed row and a rejected one show what the two
     * ends of the flow look like, including the reviewer's reason, without putting a
     * permanently broken button in front of somebody's morning.
     */
    {
      key: 'pending-high',
      status: 'committed' as const,
      fieldConfidence: { buyer_po_no: 0.97, quantity: 0.93, unit_price: 0.88 },
      source: 'ai_extraction' as const,
    },
    {
      key: 'rejected',
      status: 'rejected' as const,
      fieldConfidence: { buyer_po_no: 0.61, quantity: 0.34 },
      source: 'ai_extraction' as const,
    },
  ]

  let n = 0
  for (const draft of drafts) {
    const values = Object.values(draft.fieldConfidence)
    const existing = await ctx.db
      .select({ id: schema.pendingChanges.id })
      .from(schema.pendingChanges)
      .where(
        and(
          eq(schema.pendingChanges.companyId, ctx.companyId),
          eq(schema.pendingChanges.zodSchemaKey, `seed_${draft.key}`),
        ),
      )

    if (existing.length > 0) continue

    await ctx.db.insert(schema.pendingChanges).values({
      companyId: ctx.companyId,
      moduleId: 'core',
      // `core` registers no pending targets, so this is demo data for the inbox screen —
      // it is not approvable, and approving it would correctly fail the whitelist check.
      targetTable: 'seed_demo_rows',
      operation: 'insert',
      payload: { buyer_po_no: `PO-${1000 + n}`, quantity: 1200 + n * 50, unit_price: '4.75' },
      zodSchemaKey: `seed_${draft.key}`,
      fieldConfidence: draft.fieldConfidence,
      confidenceMin: values.length ? Math.min(...values).toFixed(3) : null,
      source: draft.source,
      extractorVersion: draft.source === 'ai_extraction' ? 'seed-extractor-v1' : null,
      status: draft.status,
      createdBy: ownerId,
      // Both states are decided, so both carry a reviewer — a committed row with no
      // reviewer means something specific in this system (a rule auto-approved it), and
      // seeding that by accident would misreport the correction telemetry.
      reviewedBy: ownerId,
      reviewedAt: new Date(),
      reviewNote: draft.status === 'rejected' ? 'Quantity does not match the PO scan' : null,
      committedAt: draft.status === 'committed' ? new Date() : null,
    })

    n += 1
  }

  return n
}

async function seedNotifications(ctx: SeedContext): Promise<number> {
  const ownerId = `seed-${ctx.companyId.slice(0, 8)}-owner`

  // The expiry date is derived from the same `daysLeft` the story tells rather than written
  // out, so the two cannot drift — and a date relative to the run keeps a CRITICAL "expires
  // soon" alert from quietly becoming an already-expired one on every demo after the first
  // month, which reads as a bug in the LC register rather than as stale seed data.
  const lcDaysLeft = 6
  const lcExpiresOn = new Date(Date.now() + lcDaysLeft * 86_400_000).toISOString().slice(0, 10)

  const items = [
    {
      dedupeKey: 'seed:lc-expiry',
      kind: 'lc.expiry_near',
      severity: 'critical' as const,
      titleKey: 'notifications.lc.expiry_near.title',
      // Every placeholder the template names must be supplied: `t()` deliberately leaves an
      // unsupplied one visible, so a miss here ships a literal `{date}` to the inbox.
      params: { lcNumber: 'LC-2026-00841', date: lcExpiresOn, daysLeft: lcDaysLeft },
      role: 'commercial' as const,
    },
    {
      dedupeKey: 'seed:approve-waiting',
      kind: 'approve.waiting',
      severity: 'warning' as const,
      titleKey: 'notifications.approve.waiting.title',
      params: { count: 3 },
      userId: ownerId,
    },
    {
      dedupeKey: 'seed:welcome',
      kind: 'system.welcome',
      severity: 'info' as const,
      titleKey: 'notifications.system.welcome.title',
      params: {},
      userId: ownerId,
    },
  ]

  for (const item of items) {
    await ctx.db
      .insert(schema.notifications)
      .values({
        companyId: ctx.companyId,
        userId: 'userId' in item ? item.userId : null,
        role: 'role' in item ? item.role : null,
        kind: item.kind,
        severity: item.severity,
        titleKey: item.titleKey,
        params: item.params,
        moduleId: 'core',
        dedupeKey: item.dedupeKey,
        channels: ['in_app'],
      })
      // The dedupe index makes re-running a no-op — the same property the nightly jobs rely on.
      .onConflictDoNothing()
  }

  return items.length
}

/**
 * Report what is actually in the database for this company, not what this particular run
 * happened to insert. On a second run the "created" numbers are all zero, which reads
 * like the seed did nothing rather than like it was already correct.
 */
async function tally(ctx: SeedContext, tables: readonly string[]): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}

  for (const table of tables) {
    const result = await ctx.db.execute<{ n: string }>(
      sql`select count(*)::text as n from ${sql.identifier(table)} where company_id = ${ctx.companyId}`,
    )
    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])
    counts[table] = Number((rows[0] as { n: string } | undefined)?.n ?? 0)
  }

  return counts
}

export const CORE_SLICE: SeedSlice = {
  id: 'core',
  async run(ctx) {
    await seedPeople(ctx)
    await seedApprovalRules(ctx)
    await seedDocuments(ctx)
    await seedPendingChanges(ctx)
    await seedNotifications(ctx)

    return tally(ctx, [
      'roles',
      'approval_rules',
      'documents',
      'pending_changes',
      'notifications',
    ])
  },
}
