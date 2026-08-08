'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import {
  auditTrail,
  auditedTables,
  grantRole,
  revokeRole,
  setPolicy,
  upsertCompanyProfile,
  type AuditQuery,
} from './service'
import type { Role } from '@/modules/core/ctx'

/**
 * X.3 Settings write paths.
 *
 * The role gate lives in the service (`assertPolicyAdmin`), not here — editing
 * policy is the same privilege as the controls it governs, and a check that
 * only existed at the action boundary would be missed by every other caller.
 */

export async function saveCompanyProfile(input: unknown): Promise<{ companyId: string }> {
  const ctx = await requireRole(await headers(), 'owner', 'admin')
  const result = await upsertCompanyProfile(ctx, input)

  // factoryType decides which modules appear in the nav, so the whole shell has
  // to re-render, not just this screen.
  revalidatePath('/', 'layout')
  return result
}

/**
 * The audit trail, read (plan 5.8, audit FE-S14).
 *
 * Ten modules write `audit_log` under rule 10 and **nothing read it**. So the answer to "who
 * changed that", which is the reason those writes exist and the reason a factory owner is
 * asked to trust this product with their order book, was a table reachable only from psql.
 *
 * Owner and admin, deliberately. The trail names who did what, and a screen that showed
 * everybody every action would turn an accountability record into a surveillance one — the
 * payroll reads it carries are exactly the rows that must not be browsable by the floor.
 */
export async function readAuditTrail(
  query: AuditQuery = {},
): Promise<{ rows: Awaited<ReturnType<typeof auditTrail>>; tables: string[] }> {
  const ctx = await requireRole(await headers(), 'owner', 'admin')

  const [rows, tables] = await Promise.all([auditTrail(ctx, query), auditedTables(ctx)])
  return { rows, tables }
}

/**
 * Grant somebody a role.
 *
 * `grantRole` has existed since X.3 with no action over it, so the seventeen departments a
 * person can belong to could only be assigned by seeding — a factory could sign up and then
 * had no way to give its storekeeper the store.
 */
export async function grantUserRole(input: {
  userId: string
  role: Role
}): Promise<void> {
  const ctx = await requireRole(await headers(), 'owner', 'admin')
  await grantRole(ctx, input)

  // A role decides which screens exist for that person, so the shell has to re-render.
  revalidatePath('/', 'layout')
}

/**
 * Take one away.
 *
 * Soft: the row stays with `revoked_at` set, because "who had permission to do that in
 * March" is a question a deleted row cannot answer. The service refuses to revoke the last
 * owner — a company with no owner is a company nobody can administer.
 */
export async function revokeUserRole(input: {
  userId: string
  role: Role
}): Promise<void> {
  const ctx = await requireRole(await headers(), 'owner', 'admin')
  await revokeRole(ctx, input)

  revalidatePath('/', 'layout')
}

/**
 * Override a module's policy.
 *
 * The role gate stays in the service (`assertPolicyAdmin`), for the reason this file's
 * header gives: editing policy is the same privilege as the controls it governs, and a check
 * that only existed here would be missed by every other caller. The one on this action is
 * the outer door, not the lock.
 */
export async function saveModulePolicy(input: {
  moduleId: string
  patch: Record<string, unknown>
}): Promise<Awaited<ReturnType<typeof setPolicy>> | ActionFailure> {
  const ctx = await requireRole(await headers(), 'owner', 'admin')
  // Refusal as a value (lib/action-failure): a rejected patch must reach the screen as
  // the validator's sentence, not as production's masked React #441.
  return surfaced(async () => {
    const result = await setPolicy(ctx, input)

    // A policy is read by whichever module owns it, on screens all over the product.
    revalidatePath('/', 'layout')
    return result
  })
}
