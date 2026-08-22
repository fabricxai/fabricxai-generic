/**
 * Per-tenant module activation (specs/order-centric-core.md §1).
 *
 * "The factory chooses its modules" becomes a table and three choke points: the action
 * boundary (`assertModuleActive`, called the way auth and zod are), the MARBIM surface
 * (intake kinds and tool packs filter through `activeModuleIds`), and navigation (the UI
 * renders from the same query — it reflects the gate, it never is the gate).
 *
 * The `company_modules` table is sparse: no row means the module's registered
 * `defaultEnabled` applies (undefined = true, so everything that predates activation
 * keeps working everywhere without a backfill). Disabling deletes nothing — rows stay,
 * actions refuse, re-enabling restores.
 *
 * The dependency rules exist for the gates: store enforcing `GATES.udBalance` against a
 * disabled commercial module would be a gate answered by nobody. So a module cannot go
 * dark while an ACTIVE module `requires` it, and cannot light up while something it
 * requires is off. The graph lives in each module's `register.ts`, not a hand-kept list.
 */
import { companyModules } from '@/db/schema/core'

import type { AnyCtx } from './ctx'
import { hasRole } from './ctx'
import { AppError } from './errors'
import { emit } from './outbox'
import { dependentsOf, getModule, listModules } from './registry'
import { scoped } from './scoped'
import { withTenantRead, withTenantTx } from './tenancy'

/**
 * Modules a tenant can never switch off. Settings is where the switches live — a factory
 * that disabled it would have locked the breaker box from the inside.
 */
export const NON_DISABLEABLE = ['settings'] as const

/**
 * Every module id active for this company: registered defaults overlaid with the
 * company's explicit rows, in one indexed read. Callers that check several modules in
 * one request (nav, tool-pack assembly) should call this once and share the set.
 */
export async function activeModuleIds(ctx: AnyCtx): Promise<ReadonlySet<string>> {
  const overrides = await withTenantRead(ctx, (tx) =>
    tx
      .select({ moduleId: companyModules.moduleId, enabled: companyModules.enabled })
      .from(companyModules)
      .where(scoped(companyModules, ctx)),
  )
  const byId = new Map(overrides.map((row) => [row.moduleId, row.enabled]))

  const active = new Set<string>()
  for (const definition of listModules()) {
    if (byId.get(definition.id) ?? definition.defaultEnabled ?? true) {
      active.add(definition.id)
    }
  }
  return active
}

export async function isModuleActive(ctx: AnyCtx, moduleId: string): Promise<boolean> {
  return (await activeModuleIds(ctx)).has(moduleId)
}

/**
 * The action-boundary check. Thin actions call it beside auth and zod; a disabled
 * module's operations refuse with a typed 403 whatever any screen shows.
 */
export async function assertModuleActive(ctx: AnyCtx, moduleId: string): Promise<void> {
  if (await isModuleActive(ctx, moduleId)) return
  throw new AppError('forbidden', 'errors.module_inactive', { moduleId })
}

/**
 * Flip one module for the caller's company. Owner only — buying and shelving capability
 * is an ownership act, not administration.
 *
 * History is the `core.module_toggled` outbox event emitted in the same transaction; the
 * row holds only the latest decision and who made it.
 */
export async function setModuleEnabled(
  ctx: AnyCtx,
  moduleId: string,
  enabled: boolean,
): Promise<{ moduleId: string; enabled: boolean }> {
  if (!hasRole(ctx, 'owner')) {
    throw new AppError('forbidden', 'errors.owner_only', { moduleId })
  }
  if (!getModule(moduleId)) {
    throw new AppError('not_found', 'errors.unknown_module', { moduleId })
  }
  if (!enabled && (NON_DISABLEABLE as readonly string[]).includes(moduleId)) {
    throw new AppError('conflict', 'errors.module_not_disableable', { moduleId })
  }

  const active = await activeModuleIds(ctx)

  if (!enabled) {
    // A gate must never be left querying a dark module (spec §1) — refuse, and name the
    // dependents so the owner sees what would have to go dark first.
    const blockers = dependentsOf(moduleId)
      .filter((m) => active.has(m.id))
      .map((m) => m.id)
    if (blockers.length > 0) {
      throw new AppError('conflict', 'errors.module_required_by', { moduleId, blockers })
    }
  } else {
    // Symmetric: lighting a module whose own dependencies are dark would enable actions
    // whose gates cannot be answered.
    const missing = (getModule(moduleId)?.requires ?? []).filter((id) => !active.has(id))
    if (missing.length > 0) {
      throw new AppError('conflict', 'errors.module_requires', { moduleId, missing })
    }
  }

  return withTenantTx(ctx, async (tx) => {
    await tx
      .insert(companyModules)
      .values({
        companyId: ctx.companyId,
        moduleId,
        enabled,
        enabledBy: ctx.userId,
      })
      // The conflict target is (company_id, module_id) and company_id comes from ctx, so
      // the update leg can only ever land on the caller's own row — RLS agrees.
      .onConflictDoUpdate({
        target: [companyModules.companyId, companyModules.moduleId],
        set: { enabled, enabledBy: ctx.userId, updatedAt: new Date() },
      })

    await emit(ctx, tx, {
      eventName: 'core.module_toggled',
      payload: { moduleId, enabled },
      aggregateTable: 'company_modules',
    })

    return { moduleId, enabled }
  })
}
