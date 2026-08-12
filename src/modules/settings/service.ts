/**
 * X.3 Settings & Admin — service layer ⚖
 *
 * The authoritative home for everything a factory configures. Its most consequential job is
 * `getPolicy`: twelve modules take a `Policy` argument, and until this existed whoever
 * happened to be calling supplied it, so two screens could judge the same thing by different
 * numbers.
 *
 * Service signatures elsewhere are unchanged on purpose. A module never imports Settings —
 * that would invert the dependency the registry keeps pointing one way — so the pattern is:
 * the ACTION or JOB reads the policy here and passes it in, exactly as rule 1 already has
 * actions doing auth → zod → service. What changed is only where the value comes from.
 *
 * Policy writes are ⚖ and owner-only. Somebody who can lower the margin floor can approve
 * anything under it, which makes editing policy the same privilege as the controls it
 * governs — and that is the one privilege that cannot be delegated to the role it governs.
 */
import { and, asc, desc, eq, getTableColumns, gte, inArray, isNull, lte, sql } from 'drizzle-orm'

import { auditLog, companies, roles, users } from '@/db/schema/core'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx, Role } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { SETTINGS_EVENTS } from './events'
import {
  POLICY_MODULE_IDS,
  POLICY_REGISTRY,
  resolvePolicyValue,
  SettingsError,
  validatePolicyPatch,
} from './policies'
import { companyProfiles, moduleToggles, policySettings } from './schema'
import { companyProfilePayload } from './zod'

/** ⚖ — a policy row decides what every gate in the system compares against. */
registerAuditedTables('policy_settings', 'company_profiles')

function wrapSettingsError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof SettingsError) {
      throw new AppError('validation_failed', 'settings.errors.invalid_policy', {
        reason: error.message,
      })
    }
    throw error
  }
}

/** Editing policy is the same privilege as the controls it governs. */
function assertPolicyAdmin(ctx: RequestCtx): void {
  if (!ctx.roles.includes('owner') && !ctx.roles.includes('admin')) {
    throw new AppError('forbidden', 'settings.errors.policy_is_admin_only', { roles: ctx.roles })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Policy
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The company's policy for a module.
 *
 * Defaults merged with the stored overrides, validated. The caller passes the result into
 * the module's service, which is why the return type is the module's own `Policy` — an
 * action reads it here and hands it on without knowing anything about the registry.
 *
 * Invalid stored JSON throws HERE rather than reaching a service. A tolerance of "abc"
 * inside the cutting checker is a crash on the floor; the same value hitting this function
 * is an error somebody can fix in a settings screen.
 */
export async function getPolicy<T>(ctx: AnyCtx, moduleId: string): Promise<T> {
  return withTenantRead(ctx, (tx) => getPolicyIn<T>(tx, moduleId))
}

/**
 * The same policy, on a transaction the caller already holds.
 *
 * For callers that are already inside one — an offline sync handler is the case this exists
 * for. `getPolicy` opens its own read transaction, which means taking a SECOND pooled
 * connection while the first is still held; PgBouncer pools 25 for the whole factory, and a
 * pattern that doubles connection use per write is not one to let spread from a floor
 * endpoint. Reading on the caller's transaction also means the policy and the write it
 * governs see the same snapshot.
 */
export async function getPolicyIn<T>(tx: TenantDb, moduleId: string): Promise<T> {
  const [row] = await tx
    .select({ overrides: policySettings.overrides })
    .from(policySettings)
    .where(eq(policySettings.moduleId, moduleId))

  return wrapSettingsError(() => resolvePolicyValue<T>(moduleId, row?.overrides ?? null))
}

export interface PolicyView {
  moduleId: string
  label: string
  /** What is in force: defaults with overrides applied. Empty when it will not resolve. */
  effective: Record<string, unknown>
  /** Only what somebody set. Empty means "entirely defaults". */
  overrides: Record<string, unknown>
  defaults: Record<string, unknown>
  updatedAt: Date | null
  updatedByName: string | null
  /**
   * Why this module's policy could not be resolved, if it could not.
   *
   * Degraded per row on purpose. Throwing for the whole list would take down the
   * settings screen — the one place the bad override can be corrected — over a
   * single stored value in one unrelated module.
   */
  unresolvable: string | null
}

/**
 * Every module's policy, for the settings screen.
 *
 * Returns effective, overrides AND defaults separately, so a screen can show what is in
 * force and whether it was chosen or inherited. A view that only showed the effective value
 * would leave nobody able to tell a deliberate 2% from a default 2%, which is exactly the
 * question asked when a number turns out to be wrong.
 */
export async function listPolicies(ctx: AnyCtx): Promise<PolicyView[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        moduleId: policySettings.moduleId,
        overrides: policySettings.overrides,
        updatedAt: policySettings.updatedAt,
        updatedByName: users.name,
      })
      .from(policySettings)
      .leftJoin(users, eq(policySettings.updatedBy, users.id))

    const stored = new Map(rows.map((row) => [row.moduleId, row]))

    return POLICY_MODULE_IDS.map((moduleId) => {
      const definition = POLICY_REGISTRY[moduleId]!
      const row = stored.get(moduleId)

      let effective: Record<string, unknown> = {}
      let unresolvable: string | null = null
      try {
        effective = resolvePolicyValue<Record<string, unknown>>(moduleId, row?.overrides ?? null)
      } catch (error) {
        // `getPolicy` still throws for the module that would actually USE this —
        // a bad tolerance must not reach the cutting checker. Here it only means
        // one card renders its reason instead of its values.
        unresolvable = error instanceof SettingsError ? error.message : 'policy could not be read'
      }

      return {
        moduleId,
        label: definition.label,
        effective,
        overrides: row?.overrides ?? {},
        defaults: definition.defaults as unknown as Record<string, unknown>,
        updatedAt: row?.updatedAt ?? null,
        updatedByName: row?.updatedByName ?? null,
        unresolvable,
      }
    })
  })
}

export interface SetPolicyResult {
  moduleId: string
  overrides: Record<string, unknown>
  effective: Record<string, unknown>
}

/**
 * Change a module's policy ⚖.
 *
 * The patch is validated against the module's schema BEFORE it is stored, and the resolved
 * result is validated too — a value that is individually plausible but invalid in
 * combination fails here rather than at the next gate that reads it.
 *
 * An unknown key is REFUSED rather than dropped. Silently discarding `marginFloorPercent`
 * would leave somebody believing a floor is in force that is not, which is worse than having
 * no floor at all because it stops them looking.
 *
 * `null` for a key clears the override back to the default — the only way to say "go back to
 * whatever the system recommends" without knowing what that value is.
 */
export async function setPolicy(
  ctx: RequestCtx,
  input: { moduleId: string; patch: Record<string, unknown> },
): Promise<SetPolicyResult> {
  assertPolicyAdmin(ctx)

  return withTenantTx(ctx, async (tx) => {
    // Scoped, not just RLS-protected. CLAUDE.md rule 2: the session variable is the second
    // wall and never the only one — and this is the row a factory's gate thresholds live in,
    // selected `FOR UPDATE` and then written. An unscoped match here is the shape of bug
    // that changes another tenant's margin floor.
    const [existing] = await tx
      .select()
      .from(policySettings)
      .where(scoped(policySettings, ctx, eq(policySettings.moduleId, input.moduleId)))
      .for('update')

    const { next, resolved } = wrapSettingsError(() =>
      validatePolicyPatch<Record<string, unknown>>(
        input.moduleId,
        existing?.overrides ?? null,
        input.patch,
      ),
    )

    if (existing) {
      await tx
        .update(policySettings)
        .set({ overrides: next, updatedBy: ctx.userId, updatedAt: new Date() })
        .where(scoped(policySettings, ctx, eq(policySettings.id, existing.id)))
    } else {
      await tx.insert(policySettings).values({
        companyId: ctx.companyId,
        moduleId: input.moduleId,
        overrides: next,
        updatedBy: ctx.userId,
      })
    }

    await recordChange(ctx, tx, {
      action: existing ? 'update' : 'insert',
      targetTable: 'policy_settings',
      targetId: existing?.id ?? input.moduleId,
      before: existing ? { overrides: existing.overrides } : null,
      // The effective value is recorded alongside the overrides: an auditor reading this a
      // year later needs to know what the system was actually using, not just what somebody
      // typed into two of six fields.
      after: { overrides: next, effective: resolved },
    })

    await emit(ctx, tx, {
      eventName: SETTINGS_EVENTS.policyChanged,
      payload: {
        moduleId: input.moduleId,
        changed: Object.keys(input.patch),
        effective: resolved,
        changedBy: ctx.userId,
      },
      aggregateTable: 'policy_settings',
      aggregateId: existing?.id ?? input.moduleId,
    })

    return { moduleId: input.moduleId, overrides: next, effective: resolved }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Company profile
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The legal identity that goes on documents ⚖.
 *
 * Upserted rather than versioned: unlike buyer terms, this is who the factory IS, not an
 * agreement that governed a period. A factory that changes its address has one address; the
 * audit trail is what answers "what did the invoice say in March".
 */
export async function upsertCompanyProfile(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ companyId: string }> {
  assertPolicyAdmin(ctx)
  const payload = companyProfilePayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, ctx.companyId))
      .for('update')

    const values = {
      legalName: payload.legalName,
      addressLines: payload.addressLines,
      country: payload.country,
      binNumber: payload.binNumber ?? null,
      tinNumber: payload.tinNumber ?? null,
      bondLicenceNo: payload.bondLicenceNo ?? null,
      factoryType: payload.factoryType,
      timezone: payload.timezone,
      locale: payload.locale,
      baseCurrency: payload.baseCurrency,
      localCurrency: payload.localCurrency,
      logoDocumentId: payload.logoDocumentId ?? null,
      updatedBy: ctx.userId,
      updatedAt: new Date(),
    }

    if (existing) {
      await tx
        .update(companyProfiles)
        .set(values)
        .where(eq(companyProfiles.companyId, ctx.companyId))
    } else {
      await tx.insert(companyProfiles).values({ companyId: ctx.companyId, ...values })
    }

    await recordChange(ctx, tx, {
      action: existing ? 'update' : 'insert',
      targetTable: 'company_profiles',
      targetId: ctx.companyId,
      // factoryType is audited because changing it adds or removes whole modules
      // from the factory's nav — that is a control change, not a display preference.
      before: existing
        ? {
            legalName: existing.legalName,
            binNumber: existing.binNumber,
            factoryType: existing.factoryType,
          }
        : null,
      after: {
        legalName: payload.legalName,
        binNumber: payload.binNumber ?? null,
        factoryType: payload.factoryType,
      },
    })

    return { companyId: ctx.companyId }
  })
}

export async function companyProfile(
  ctx: AnyCtx,
): Promise<typeof companyProfiles.$inferSelect | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, ctx.companyId))
    return row ?? null
  })
}

/**
 * What to call this factory on screen.
 *
 * The legal name is what belongs on a document, but it is only set once somebody opens the
 * settings screen — and until then the shell was falling back to the literal string
 * "FabricXAI", printing the product's own name beside the product's own logo as though the
 * factory were called that. `companies.name` is captured at signup and is always there, so
 * it sits between the two.
 */
export async function companyDisplayName(ctx: AnyCtx): Promise<string | null> {
  return withTenantRead(ctx, async (tx) => {
    const [profile] = await tx
      .select({ legalName: companyProfiles.legalName })
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, ctx.companyId))

    if (profile?.legalName) return profile.legalName

    const [company] = await tx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, ctx.companyId))

    return company?.name ?? null
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Module toggles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is a module switched on?
 *
 * Absence means ENABLED. A factory that never opens the settings screen must not discover
 * half its ERP disabled, so the table records the exception rather than the state.
 */
export async function isModuleEnabled(ctx: AnyCtx, moduleId: string): Promise<boolean> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ enabled: moduleToggles.enabled })
      .from(moduleToggles)
      .where(eq(moduleToggles.moduleId, moduleId))
    return row?.enabled ?? true
  })
}

export async function setModuleEnabled(
  ctx: RequestCtx,
  input: { moduleId: string; enabled: boolean; note?: string },
): Promise<void> {
  assertPolicyAdmin(ctx)

  if (!input.enabled && !input.note) {
    // A module switched off with no reason gets switched back on by the next person who
    // finds a screen missing.
    throw new AppError('validation_failed', 'settings.errors.disable_needs_note', {
      moduleId: input.moduleId,
    })
  }

  await withTenantTx(ctx, async (tx) => {
    await tx
      .insert(moduleToggles)
      .values({
        companyId: ctx.companyId,
        moduleId: input.moduleId,
        enabled: input.enabled,
        note: input.note ?? null,
        updatedBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [moduleToggles.companyId, moduleToggles.moduleId],
        set: {
          enabled: input.enabled,
          note: input.note ?? null,
          updatedBy: ctx.userId,
          updatedAt: new Date(),
        },
      })
  })
}

/** Only the modules a factory has switched OFF — the table's whole content. */
export async function disabledModules(ctx: AnyCtx): Promise<string[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ moduleId: moduleToggles.moduleId })
      .from(moduleToggles)
      .where(eq(moduleToggles.enabled, false))
    return rows.map((row) => row.moduleId)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The role matrix
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Grant a department role ⚖.
 *
 * The auth layer's organization plugin only knows owner/admin/member; the seventeen-value
 * department matrix is granted here by writing `roles` directly, which is what the brief
 * describes.
 *
 * Re-granting a revoked role UN-revokes it rather than inserting a second row: the unique
 * index is on (company, user, role), and a second grant of the same role is the same fact.
 */
export async function grantRole(
  ctx: RequestCtx,
  input: { userId: string; role: Role; scope?: Record<string, unknown> },
): Promise<void> {
  assertPolicyAdmin(ctx)

  await withTenantTx(ctx, async (tx) => {
    // The user must already be a member of this company. Granting a role to somebody who
    // is not would make them one, silently, from a screen about permissions.
    const [membership] = await tx
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.userId, input.userId))
      .limit(1)

    if (!membership) {
      throw notFound('settings.errors.not_a_member', { userId: input.userId })
    }

    await tx
      .insert(roles)
      .values({
        companyId: ctx.companyId,
        userId: input.userId,
        role: input.role,
        scope: input.scope ?? {},
        grantedBy: ctx.userId,
      })
      .onConflictDoUpdate({
        target: [roles.companyId, roles.userId, roles.role],
        set: { revokedAt: null, scope: input.scope ?? {}, grantedBy: ctx.userId },
      })

    await emit(ctx, tx, {
      eventName: SETTINGS_EVENTS.roleGranted,
      payload: { userId: input.userId, role: input.role, grantedBy: ctx.userId },
      aggregateTable: 'roles',
      aggregateId: input.userId,
    })
  })
}

/**
 * Revoke a role ⚖.
 *
 * Soft: `revoked_at` is set and the row stays. "Who had permission to do that in March" is a
 * question a deleted row cannot answer.
 *
 * The last owner cannot be revoked. A company with no owner is a company nobody can
 * administer, and the only way out would be a support ticket.
 */
export async function revokeRole(
  ctx: RequestCtx,
  input: { userId: string; role: Role },
): Promise<void> {
  assertPolicyAdmin(ctx)

  await withTenantTx(ctx, async (tx) => {
    if (input.role === 'owner') {
      const owners = await tx
        .select({ userId: roles.userId })
        .from(roles)
        .where(and(eq(roles.role, 'owner'), isNull(roles.revokedAt)))

      if (owners.length <= 1) {
        throw conflict('settings.errors.last_owner', { userId: input.userId })
      }
    }

    const [row] = await tx
      .select()
      .from(roles)
      .where(and(eq(roles.userId, input.userId), eq(roles.role, input.role)))
      .for('update')

    if (!row) {
      throw notFound('settings.errors.role_not_held', { userId: input.userId, role: input.role })
    }
    if (row.revokedAt) return

    await tx.update(roles).set({ revokedAt: new Date() }).where(eq(roles.id, row.id))

    await emit(ctx, tx, {
      eventName: SETTINGS_EVENTS.roleRevoked,
      payload: { userId: input.userId, role: input.role, revokedBy: ctx.userId },
      aggregateTable: 'roles',
      aggregateId: input.userId,
    })
  })
}

export interface MatrixRow {
  userId: string
  name: string | null
  email: string | null
  roles: { role: string; scope: Record<string, unknown>; revokedAt: Date | null }[]
}

/** Who can do what — the role matrix screen. Revoked roles included, marked. */
export async function roleMatrix(ctx: AnyCtx): Promise<MatrixRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        userId: roles.userId,
        name: users.name,
        email: users.email,
        role: roles.role,
        scope: roles.scope,
        revokedAt: roles.revokedAt,
      })
      .from(roles)
      .leftJoin(users, eq(roles.userId, users.id))
      .orderBy(asc(users.name), asc(roles.role))

    const byUser = new Map<string, MatrixRow>()
    for (const row of rows) {
      const entry = byUser.get(row.userId) ?? {
        userId: row.userId,
        name: row.name,
        email: row.email,
        roles: [],
      }
      entry.roles.push({ role: row.role, scope: row.scope, revokedAt: row.revokedAt })
      byUser.set(row.userId, entry)
    }

    return [...byUser.values()]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The audit log viewer
// ─────────────────────────────────────────────────────────────────────────────

export interface AuditQuery {
  targetTable?: string
  targetId?: string
  actorUserId?: string
  action?: string
  from?: string
  to?: string
  limit?: number
}

/**
 * Read the audit trail.
 *
 * Append-only and readable by admins — this is the screen that answers "who changed that".
 * Ordered newest first and hard-capped: an unbounded audit query on a factory with two years
 * of history is a screen that never loads, and a page nobody can open is a trail nobody
 * reads.
 */
export async function auditTrail(
  ctx: AnyCtx,
  query: AuditQuery = {},
): Promise<(typeof auditLog.$inferSelect & { actorName: string | null })[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      /*
       * The actor's NAME rides along. The screen's whole reason to exist is "who changed
       * that", and until now it answered with a role and a dash — `actor_user_id` was on
       * every row and rendered nowhere, so the trail showed that AN admin did it while
       * withholding which one. A left join because the id can outlive the person: a
       * departed user's actions still happened.
       */
      .select({ ...getTableColumns(auditLog), actorName: users.name })
      .from(auditLog)
      .leftJoin(users, eq(auditLog.actorUserId, users.id))
      .where(
        and(
          query.targetTable ? eq(auditLog.targetTable, query.targetTable) : undefined,
          query.targetId ? eq(auditLog.targetId, query.targetId) : undefined,
          query.actorUserId ? eq(auditLog.actorUserId, query.actorUserId) : undefined,
          query.action ? sql`${auditLog.action}::text = ${query.action}` : undefined,
          query.from ? gte(auditLog.occurredAt, new Date(`${query.from}T00:00:00Z`)) : undefined,
          query.to ? lte(auditLog.occurredAt, new Date(`${query.to}T23:59:59Z`)) : undefined,
        ),
      )
      .orderBy(desc(auditLog.occurredAt))
      .limit(Math.min(query.limit ?? 200, 1000)),
  )
}

/** Which ⚖ tables have an audit trail at all — the viewer's filter list. */
export async function auditedTables(ctx: AnyCtx): Promise<string[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ targetTable: auditLog.targetTable })
      .from(auditLog)
      .orderBy(asc(auditLog.targetTable))
    return rows.map((row) => row.targetTable)
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Repair
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-run a company's provisioning.
 *
 * The admin action behind the idempotent seeding: a tenant created before provisioning
 * existed, or one whose seeding partly failed at signup, is repaired by calling this rather
 * than by somebody running a script against production.
 *
 * Safe by construction — every step leaves a customised value alone.
 */
export async function repairProvisioning(
  ctx: RequestCtx,
): Promise<{ complete: boolean; steps: { step: string; ok: boolean; created: number }[] }> {
  assertPolicyAdmin(ctx)

  const { provisionCompany } = await import('@/lib/provisioning')
  const result = await provisionCompany(ctx)

  return {
    complete: result.complete,
    steps: result.steps.map((step) => ({
      step: step.step,
      ok: step.ok,
      created: step.created,
    })),
  }
}

export { conflict, inArray }
