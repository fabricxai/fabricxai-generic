/**
 * Per-tenant module activation against a real database (specs/order-centric-core.md §1).
 *
 * The things a typecheck cannot see: that a sparse table really does fall back to the
 * registered default in both directions, that one company's flip is invisible to the
 * next (the whole point of the feature is per-tenant), that the dependency graph refuses
 * in BOTH directions, and that the flip leaves its outbox trace.
 */
import { randomUUID } from 'node:crypto'

import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, companyModules, outbox, users } from '@/db/schema/core'
import {
  activeModuleIds,
  assertModuleActive,
  isModuleActive,
  setModuleEnabled,
} from '@/modules/core/activation'
import type { RequestCtx } from '@/modules/core/ctx'
import { AppError } from '@/modules/core/errors'
import { getModule, registerModule, type ModuleDefinition } from '@/modules/core/registry'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
/** A second tenant, so "per-tenant" is asked rather than assumed. */
const OTHER = randomUUID()
const USER = `act-user-${randomUUID().slice(0, 8)}`

const owner: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['owner'] }
const merch: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['merchandiser'] }
const otherOwner: RequestCtx = { companyId: OTHER, userId: USER, roles: ['owner'] }

/**
 * Registered fresh here rather than importing the real registrations: this file tests
 * the MECHANISM, and real modules gaining `requires` edges later must not rewrite these
 * cases. Ids are unique per run so a shared registry cannot poison anything.
 */
const suffix = randomUUID().slice(0, 8)
const LIT = `act_lit_${suffix}` // defaultEnabled undefined → on everywhere
const DARK = `act_dark_${suffix}` // ships dark, lights up per company
const DEPENDENT = `act_dep_${suffix}` // requires LIT
const SOLO = `act_solo_${suffix}` // lit by default, nothing depends on it

function moduleNamed(id: string, extra: Partial<ModuleDefinition> = {}): ModuleDefinition {
  return {
    id,
    pendingTargets: [],
    zodMap: {},
    approvalDefaults: { requiredRoles: ['owner'] },
    ...extra,
  }
}

beforeAll(async () => {
  await db
    .insert(companies)
    .values([
      { id: COMPANY, name: 'Activation Co', slug: `act-${COMPANY.slice(0, 8)}` },
      { id: OTHER, name: 'Bystander Co', slug: `bys-${OTHER.slice(0, 8)}` },
    ])
    .onConflictDoNothing()
  await db
    .insert(users)
    .values([{ id: USER, email: `${USER}@fabricxai.test`, name: 'Activation Tester' }])
    .onConflictDoNothing()

  registerModule(moduleNamed(LIT))
  registerModule(moduleNamed(DARK, { defaultEnabled: false }))
  registerModule(moduleNamed(DEPENDENT, { requires: [LIT] }))
  registerModule(moduleNamed(SOLO))
  // The non-disableable check is by id, so the id must exist in the registry whether or
  // not this worker imported the real settings module.
  if (!getModule('settings')) registerModule(moduleNamed('settings'))
})

afterAll(async () => {
  await db.delete(companyModules).where(eq(companyModules.companyId, COMPANY))
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await client.end()
})

describe('defaults, with no row anywhere', () => {
  it('a module that predates activation is on; one shipping dark is off', async () => {
    const active = await activeModuleIds(owner)
    expect(active.has(LIT)).toBe(true)
    expect(active.has(DARK)).toBe(false)
  })

  it('assertModuleActive refuses the dark one with the typed 403', async () => {
    await expect(assertModuleActive(owner, DARK)).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.module_inactive',
    })
    await expect(assertModuleActive(owner, LIT)).resolves.toBeUndefined()
  })
})

describe('flipping', () => {
  it('is owner-only', async () => {
    await expect(setModuleEnabled(merch, DARK, true)).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.owner_only',
    })
  })

  it('refuses a module the registry has never heard of', async () => {
    await expect(setModuleEnabled(owner, `act_ghost_${suffix}`, true)).rejects.toMatchObject({
      code: 'not_found',
      messageKey: 'errors.unknown_module',
    })
  })

  it('lights a dark module for ONE company, leaves the outbox trace, and flips back', async () => {
    await setModuleEnabled(owner, DARK, true)
    expect(await isModuleActive(owner, DARK)).toBe(true)
    // The bystander company still sees the registered default — per-tenant is the feature.
    expect(await isModuleActive(otherOwner, DARK)).toBe(false)

    const events = await db
      .select({ payload: outbox.payload })
      .from(outbox)
      .where(and(eq(outbox.companyId, COMPANY), eq(outbox.eventName, 'core.module_toggled')))
    expect(events.map((e) => e.payload)).toContainEqual({ moduleId: DARK, enabled: true })

    // Back off — exercising the upsert's update leg, not just the insert.
    await setModuleEnabled(owner, DARK, false)
    expect(await isModuleActive(owner, DARK)).toBe(false)
  })

  it('an explicit off overrides a lit default, and deletes nothing', async () => {
    // SOLO, not LIT: LIT has a dependent, and disabling it here is the graph's job to
    // refuse — which the dependency describe below asserts on purpose.
    await setModuleEnabled(owner, SOLO, false)
    expect(await isModuleActive(owner, SOLO)).toBe(false)
    await setModuleEnabled(owner, SOLO, true)
    expect(await isModuleActive(owner, SOLO)).toBe(true)
  })
})

describe('the dependency graph', () => {
  it('refuses to darken a module an active module requires, naming the blocker', async () => {
    // DEPENDENT is on by default and requires LIT.
    let refusal: AppError | undefined
    await setModuleEnabled(owner, LIT, false).catch((error: AppError) => (refusal = error))
    expect(refusal).toMatchObject({ code: 'conflict', messageKey: 'errors.module_required_by' })
    expect(refusal?.details.blockers).toEqual([DEPENDENT])
  })

  it('lets it go dark once the dependent is off first — and then refuses the re-light in reverse', async () => {
    await setModuleEnabled(owner, DEPENDENT, false)
    await setModuleEnabled(owner, LIT, false)
    expect(await isModuleActive(owner, LIT)).toBe(false)

    // Symmetric refusal: DEPENDENT cannot come back while what it requires is dark.
    await expect(setModuleEnabled(owner, DEPENDENT, true)).rejects.toMatchObject({
      code: 'conflict',
      messageKey: 'errors.module_requires',
    })

    await setModuleEnabled(owner, LIT, true)
    await setModuleEnabled(owner, DEPENDENT, true)
    expect(await isModuleActive(owner, DEPENDENT)).toBe(true)
  })

  it('settings cannot be switched off at all', async () => {
    await expect(setModuleEnabled(owner, 'settings', false)).rejects.toMatchObject({
      code: 'conflict',
      messageKey: 'errors.module_not_disableable',
    })
  })
})
