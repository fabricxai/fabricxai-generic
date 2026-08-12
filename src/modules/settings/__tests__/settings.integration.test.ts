/**
 * X.3 integration.
 *
 * The merge logic is covered by `policies.test.ts`. What is asserted here is what only a
 * database can be wrong about — and the headline is the last block: **a policy configured in
 * Settings actually changes what a module's gate does.** That is the whole reason X.3 exists;
 * without it, `getPolicy` is a well-tested function nobody's decisions flow through.
 *
 *  - overrides are stored sparsely, so improving a default still reaches a factory that
 *    never touched it;
 *  - policy writes are admin-only and audited with the EFFECTIVE value;
 *  - a module a factory never configured is enabled;
 *  - the last owner cannot be revoked, and revoking is soft;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { auditLog, companies, roles, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import { approveCostSheet, createCostSheet } from '@/modules/costing/service'
import type { RequestCtx } from '@/modules/core/ctx'
import { withTenantRead } from '@/modules/core/tenancy'
import { POLICY_MODULE_IDS } from '@/modules/settings/policies'
import '@/modules/rfq/register'
import { rfqs } from '@/modules/rfq/schema'
import { createRfq, draftQuote, sendQuote } from '@/modules/rfq/service'
import '@/modules/settings/register'
import { companyProfiles, moduleToggles, policySettings } from '@/modules/settings/schema'
import {
  auditTrail,
  companyProfile,
  disabledModules,
  getPolicy,
  grantRole,
  isModuleEnabled,
  listPolicies,
  revokeRole,
  roleMatrix,
  setModuleEnabled,
  setPolicy,
  upsertCompanyProfile,
} from '@/modules/settings/service'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const OWNER = `set-owner-${randomUUID().slice(0, 8)}`
const SECOND_OWNER = `set-own2-${randomUUID().slice(0, 8)}`
const STAFF = `set-staff-${randomUUID().slice(0, 8)}`

const ownerCtx: RequestCtx = { companyId: COMPANY, userId: OWNER, roles: ['owner'] }
const staffCtx: RequestCtx = { companyId: COMPANY, userId: STAFF, roles: ['merchandiser'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: OWNER, roles: ['owner'] }

let buyerId: string

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'Set Co', slug: `set-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values([
    { id: OWNER, email: `${OWNER}@fabricxai.test`, name: 'Owner One' },
    { id: SECOND_OWNER, email: `${SECOND_OWNER}@fabricxai.test`, name: 'Owner Two' },
    { id: STAFF, email: `${STAFF}@fabricxai.test`, name: 'Staff' },
  ])
  await db.insert(roles).values([
    { companyId: COMPANY, userId: OWNER, role: 'owner' },
    { companyId: COMPANY, userId: STAFF, role: 'merchandiser' },
  ])

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  buyerId = buyer!.id
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  for (const id of [OWNER, SECOND_OWNER, STAFF]) {
    await db.delete(users).where(eq(users.id, id))
  }
  await client.end()
})

const clearPolicies = async () => {
  await db.delete(policySettings).where(eq(policySettings.companyId, COMPANY))
}

describe('X.3 · policy storage', () => {
  it('returns defaults for a company that has configured nothing', async () => {
    await clearPolicies()
    const policy = await getPolicy<{ tolerancePct: string }>(ownerCtx, 'cutting')
    expect(policy.tolerancePct).toBe('2')
  })

  it('stores only the OVERRIDE, not a resolved snapshot', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'cutting', patch: { tolerancePct: '3' } })

    const [row] = await db
      .select()
      .from(policySettings)
      .where(and(eq(policySettings.companyId, COMPANY), eq(policySettings.moduleId, 'cutting')))

    // Only what somebody set. A full snapshot would freeze every default at whatever it was
    // the day they signed up, and improving a default would then never reach anybody.
    expect(row!.overrides).toEqual({ tolerancePct: '3' })

    const policy = await getPolicy<{ tolerancePct: string; defaultBundleSize?: number }>(
      ownerCtx,
      'cutting',
    )
    expect(policy.tolerancePct).toBe('3')
    // Still inherited.
    expect(policy.defaultBundleSize).toBe(20)
  })

  it('clearing an override falls back to the default', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'cutting', patch: { tolerancePct: '3' } })
    await setPolicy(ownerCtx, { moduleId: 'cutting', patch: { tolerancePct: null } })

    const policy = await getPolicy<{ tolerancePct: string }>(ownerCtx, 'cutting')
    expect(policy.tolerancePct).toBe('2')
  })

  it('refuses an unknown setting rather than dropping it', async () => {
    await clearPolicies()
    // Silently discarding it would leave somebody believing a floor is in force that is not.
    // The typed error carries the offending key in its details — the messageKey is what the
    // UI translates, the details are what it shows next to it.
    await expect(
      setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPercent: '12' } }),
    ).rejects.toMatchObject({
      messageKey: 'settings.errors.invalid_policy',
      details: { reason: expect.stringMatching(/marginFloorPercent/) },
    })
  })

  it('refuses a value that would make the policy invalid', async () => {
    await clearPolicies()
    await expect(
      setPolicy(ownerCtx, { moduleId: 'planning', patch: { defaultShiftMinutes: 5000 } }),
    ).rejects.toThrow()
  })

  it('a merchandiser cannot change policy', async () => {
    await clearPolicies()
    // Somebody who can lower the margin floor can approve anything under it.
    await expect(
      setPolicy(staffCtx, { moduleId: 'costing', patch: { marginFloorPct: '1' } }),
    ).rejects.toThrow(/policy_is_admin_only/)
  })

  it('audits the change with the EFFECTIVE value, not just the patch', async () => {
    await clearPolicies()
    await db.execute(sql`delete from audit_log where company_id = ${COMPANY}`)

    await setPolicy(ownerCtx, { moduleId: 'quality', patch: { dhuAlertThreshold: '3' } })

    // Scoped to THIS company. Unscoped, this read the first policy audit row in the whole
    // table and passed only for as long as no other tenant in the development database had
    // ever changed a policy — a green that depended on the neighbours being empty.
    const [entry] = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.companyId, COMPANY), eq(auditLog.targetTable, 'policy_settings')))

    const after = entry!.after as { overrides: Record<string, unknown>; effective: Record<string, unknown> }
    expect(after.overrides).toEqual({ dhuAlertThreshold: '3' })
    // An auditor a year later needs what the system was USING, not two of six fields.
    expect(after.effective.repeatDefectDays).toBe(3)
    expect(after.effective.fabricMaxPointsPer100SqYd).toBe('20')
  })

  it('lists every module with effective, overrides and defaults kept apart', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPct: '15' } })

    const views = await listPolicies(ownerCtx)
    // Against the registry rather than a literal: the exact list is pinned by the pure
    // vectors, and what matters here is that every registered module reaches the screen.
    expect(views).toHaveLength(POLICY_MODULE_IDS.length)

    const costing = views.find((v) => v.moduleId === 'costing')!
    // A screen showing only the effective value could not tell a deliberate 15 from a
    // default 15 — which is the question asked when a number turns out to be wrong.
    expect(costing.effective.marginFloorPct).toBe('15')
    expect(costing.overrides).toEqual({ marginFloorPct: '15' })
    expect(costing.defaults.marginFloorPct).toBe('10')
    expect(costing.updatedByName).toBe('Owner One')

    const untouched = views.find((v) => v.moduleId === 'sampling')!
    expect(untouched.overrides).toEqual({})
    expect(untouched.updatedAt).toBeNull()
    expect(costing.unresolvable).toBeNull()
  })

  it('one unreadable override degrades its own row, not the whole screen', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPct: '15' } })

    // `setPolicy` validates, so this can only arrive by a migration, a seed or a
    // hand-run UPDATE — which is exactly when somebody opens Settings to fix it.
    await db.insert(policySettings).values({
      companyId: COMPANY,
      moduleId: 'cutting',
      overrides: { tolerancePct: 'abc' },
      updatedBy: OWNER,
    })

    const views = await listPolicies(ownerCtx)

    const cutting = views.find((v) => v.moduleId === 'cutting')!
    expect(cutting.unresolvable).toBeTruthy()
    // The stored value is still shown — it is what has to be corrected.
    expect(cutting.overrides).toEqual({ tolerancePct: 'abc' })

    // Every other module renders normally. Throwing here would take down the one
    // screen able to repair the bad row.
    expect(views).toHaveLength(POLICY_MODULE_IDS.length)
    expect(views.find((v) => v.moduleId === 'costing')!.effective.marginFloorPct).toBe('15')
    expect(views.filter((v) => v.unresolvable !== null)).toHaveLength(1)

    // The module that would USE it still refuses: a tolerance of "abc" must never
    // reach the cutting checker just because a screen tolerated it.
    await expect(getPolicy(ownerCtx, 'cutting')).rejects.toThrow()

    await clearPolicies()
  })
})

describe('X.3 · company profile and toggles', () => {
  it('upserts the profile rather than versioning it', async () => {
    await upsertCompanyProfile(ownerCtx, {
      legalName: 'Set Co Apparels Ltd.',
      addressLines: ['Plot 42, DEPZ', 'Savar, Dhaka'],
      binNumber: 'BIN-001',
      bondLicenceNo: 'BOND-77',
    })
    await upsertCompanyProfile(ownerCtx, {
      legalName: 'Set Co Apparels Limited',
      addressLines: ['Plot 42, DEPZ'],
      binNumber: 'BIN-001',
    })

    const rows = await db
      .select()
      .from(companyProfiles)
      .where(eq(companyProfiles.companyId, COMPANY))

    // One profile. A factory has one legal identity; the audit trail answers "what did the
    // invoice say in March".
    expect(rows).toHaveLength(1)
    expect(rows[0]!.legalName).toBe('Set Co Apparels Limited')

    const profile = await companyProfile(ownerCtx)
    expect(profile!.timezone).toBe('Asia/Dhaka')
    expect(profile!.localCurrency).toBe('BDT')
  })

  it('a module nobody configured is ENABLED', async () => {
    // A factory that never opens this screen must not find half its ERP switched off.
    expect(await isModuleEnabled(ownerCtx, 'maintenance')).toBe(true)
    expect(await disabledModules(ownerCtx)).toEqual([])
  })

  it('switching a module off needs a reason', async () => {
    // A module disabled with no note gets switched back on by the next person who finds a
    // screen missing.
    await expect(
      setModuleEnabled(ownerCtx, { moduleId: 'maintenance', enabled: false }),
    ).rejects.toThrow(/disable_needs_note/)

    await setModuleEnabled(ownerCtx, {
      moduleId: 'maintenance',
      enabled: false,
      note: 'No in-house maintenance team; machines are serviced by the supplier.',
    })

    expect(await isModuleEnabled(ownerCtx, 'maintenance')).toBe(false)
    expect(await disabledModules(ownerCtx)).toEqual(['maintenance'])

    await setModuleEnabled(ownerCtx, { moduleId: 'maintenance', enabled: true })
    await db.delete(moduleToggles).where(eq(moduleToggles.companyId, COMPANY))
  })
})

describe('X.3 · the role matrix', () => {
  it('grants a department role and shows it in the matrix', async () => {
    await grantRole(ownerCtx, { userId: STAFF, role: 'quality' })

    const matrix = await roleMatrix(ownerCtx)
    const staff = matrix.find((row) => row.userId === STAFF)!
    expect(staff.roles.map((r) => r.role).sort()).toEqual(['merchandiser', 'quality'])
  })

  it('re-granting a revoked role un-revokes it rather than duplicating', async () => {
    await grantRole(ownerCtx, { userId: STAFF, role: 'store' })
    await revokeRole(ownerCtx, { userId: STAFF, role: 'store' })
    await grantRole(ownerCtx, { userId: STAFF, role: 'store' })

    const rows = await db
      .select()
      .from(roles)
      .where(eq(roles.userId, STAFF))

    const store = rows.filter((row) => row.role === 'store')
    expect(store).toHaveLength(1)
    expect(store[0]!.revokedAt).toBeNull()
  })

  it('revoking is SOFT — the row stays', async () => {
    await grantRole(ownerCtx, { userId: STAFF, role: 'compliance' })
    await revokeRole(ownerCtx, { userId: STAFF, role: 'compliance' })

    const [row] = await db
      .select()
      .from(roles)
      .where(eq(roles.userId, STAFF))
      .then((rows) => rows.filter((r) => r.role === 'compliance'))

    // "Who had permission to do that in March" is a question a deleted row cannot answer.
    expect(row).toBeDefined()
    expect(row!.revokedAt).not.toBeNull()
  })

  it('refuses to revoke the LAST owner', async () => {
    // A company with no owner is a company nobody can administer, and the only way out
    // would be a support ticket.
    await expect(revokeRole(ownerCtx, { userId: OWNER, role: 'owner' })).rejects.toThrow(
      /last_owner/,
    )
  })

  it('allows revoking an owner once there are two', async () => {
    await db.insert(roles).values({ companyId: COMPANY, userId: SECOND_OWNER, role: 'owner' })
    await revokeRole(ownerCtx, { userId: SECOND_OWNER, role: 'owner' })

    const rows = await db.select().from(roles).where(eq(roles.userId, SECOND_OWNER))
    expect(rows[0]!.revokedAt).not.toBeNull()
  })

  it('cannot grant a role to somebody who is not a member', async () => {
    // Granting a role to a stranger would make them a member, silently, from a screen about
    // permissions.
    await expect(
      grantRole(ownerCtx, { userId: 'not-a-member', role: 'quality' }),
    ).rejects.toThrow(/not_a_member/)
  })

  it('a merchandiser cannot grant roles', async () => {
    await expect(grantRole(staffCtx, { userId: STAFF, role: 'owner' })).rejects.toThrow(
      /policy_is_admin_only/,
    )
  })
})

describe('X.3 · the audit viewer', () => {
  it('reads the trail newest first and caps the page', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPct: '11' } })
    await setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPct: '12' } })

    const entries = await auditTrail(ownerCtx, { targetTable: 'policy_settings', limit: 5 })
    expect(entries.length).toBeGreaterThanOrEqual(2)
    expect(entries[0]!.occurredAt >= entries[1]!.occurredAt).toBe(true)
  })

  it('never returns more than the hard cap', async () => {
    // An unbounded audit query on two years of history is a screen that never loads, and a
    // page nobody can open is a trail nobody reads.
    const entries = await auditTrail(ownerCtx, { limit: 99999 })
    expect(entries.length).toBeLessThanOrEqual(1000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The headline: configured policy changes what a gate does
// ─────────────────────────────────────────────────────────────────────────────

describe('X.3 → 1.2 · a configured floor actually governs a quote', () => {
  const quoteAt = async (marginPct: string) => {
    const styleCode = `ST-${randomUUID().slice(0, 6)}`
    const created = await createCostSheet(ownerCtx, {
      styleCode,
      sections: {
        currency: 'USD',
        localCurrency: 'BDT',
        fxRateLocalToBase: '0.0083',
        fabric: [
          { ref: 'FAB-1', consumption: '1.60', uom: 'm', ratePerUom: '2.00', wastagePct: '0' },
        ],
        trims: [],
        embellishment: [],
        cm: { method: 'per_dozen', perDozenRateLocal: '600.00' },
        commercial: [],
        marginPct,
        marginBasis: 'price',
      },
    })
    await approveCostSheet(ownerCtx, { sheetId: created.sheetId })

    const { rfqId } = await createRfq(ownerCtx, {
      buyerId,
      title: 'Floor test',
      productType: 'tshirt',
      styleCode,
      quantity: 5000,
      currency: 'USD',
    })

    // The whole point: the policy comes from Settings rather than from this call site.
    const policy = await getPolicy<Parameters<typeof draftQuote>[2]>(ownerCtx, 'rfq')
    const drafted = await draftQuote(ownerCtx, { rfqId, styleCode }, policy)
    return { drafted, policy }
  }

  it('an 8% quote passes under the shipped 10% floor after the floor is lowered to 5', async () => {
    await clearPolicies()
    await db.delete(rfqs).where(eq(rfqs.companyId, COMPANY))

    // At the shipped default of 10, an 8% quote is below the floor.
    const before = await quoteAt('8')
    expect(before.policy.marginFloorPct).toBe('10')
    expect(before.drafted.belowFloor).toBe(true)

    // An owner lowers the company floor.
    await setPolicy(ownerCtx, { moduleId: 'rfq', patch: { marginFloorPct: '5' } })

    const after = await quoteAt('8')
    expect(after.policy.marginFloorPct).toBe('5')
    // Same quote, different verdict — because Settings decided, not the call site.
    expect(after.drafted.belowFloor).toBe(false)

    // And it is genuinely sendable by a merchandiser now, which it was not before.
    await sendQuote(staffCtx, { quoteId: after.drafted.quoteId }, after.policy)
  })

  it('raising the floor makes a previously fine quote need a manager', async () => {
    await clearPolicies()
    await db.delete(rfqs).where(eq(rfqs.companyId, COMPANY))
    await setPolicy(ownerCtx, { moduleId: 'rfq', patch: { marginFloorPct: '20' } })

    const { drafted, policy } = await quoteAt('12')
    expect(drafted.belowFloor).toBe(true)

    await expect(
      sendQuote(staffCtx, { quoteId: drafted.quoteId, belowFloorReason: 'x' }, policy),
    ).rejects.toThrow(/below_floor_needs_manager/)
  })
})

describe('X.3 · tenancy', () => {
  it('another company sees none of this company’s settings', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPct: '15' } })

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      policies: await tx.select().from(policySettings),
      profiles: await tx.select().from(companyProfiles),
    }))

    expect(seen.policies).toHaveLength(0)
    expect(seen.profiles).toHaveLength(0)
  })

  it('another company gets the DEFAULTS, not this company’s overrides', async () => {
    await clearPolicies()
    await setPolicy(ownerCtx, { moduleId: 'costing', patch: { marginFloorPct: '1' } })

    // A competitor's margin floor is about as sensitive as a number gets.
    const policy = await getPolicy<{ marginFloorPct?: string }>(otherCtx, 'costing')
    expect(policy.marginFloorPct).toBe('10')
  })

  it('another company cannot see this one’s role matrix', async () => {
    const matrix = await roleMatrix(otherCtx)
    expect(matrix).toHaveLength(0)
  })
})
