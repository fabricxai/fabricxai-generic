/**
 * Day-0 masters for Barakah Fashions Ltd.
 *
 * `pnpm tsx scripts/seed-day0.ts [--company=<uuid>] [--reset-passwords] [--password=<shared>] [--dry-run]`
 *
 * The reference data a factory needs before anybody can do a day's work: who it is, how its
 * floor is laid out, who may sign in, who approves what, and the handful of tables the
 * business modules refuse to run without. It is NOT a demo — it writes no orders, buyers,
 * RFQs or production. Masters only.
 *
 * ## Idempotent, by natural key
 *
 * Every write upserts on the key a human would use to identify the thing — a line's code, a
 * user's email, a defect's code, a template's name. Re-running changes nothing that has not
 * drifted from this file, which is what makes it safe to run against a tenant that is
 * already live and what makes "run it again after the fix" a sentence somebody can say
 * without flinching.
 *
 * Two deliberate exceptions, both about not destroying something a person did:
 *   · a user's PASSWORD is set once, on creation. `--reset-passwords` is the explicit
 *     override, because silently reissuing credentials on a re-run would lock out anybody
 *     who had already changed theirs.
 *
 * ## `--password=<shared>` — for TESTING a tenant, never for running one
 *
 * Gives every seeded account the same password instead of eighteen separate random ones.
 * A role sweep means signing in as eighteen people in an afternoon, and eighteen pasted
 * 18-character secrets is its own source of failure — the tester cannot tell a mistyped
 * password from a genuine refusal, which is exactly the confusion this exists to remove.
 *
 * What it costs is stated plainly because it is not small: one leaked password is then
 * every role in the tenant, including owner-adjacent ones, and the per-account blast radius
 * the separate passwords bought is gone. It is for a tenant holding test data. Before a
 * factory's real people and real orders arrive, re-run WITHOUT this flag.
 *   · `policy_settings.overrides` is merged, not replaced. A factory that retuned a
 *     threshold keeps it.
 *
 * ## What this file could NOT do, and why
 *
 * Three of the six requested approval rules are not expressible as approval rules. That is a
 * property of the system, not an omission here, and each is reported at the end of the run
 * rather than quietly dropped:
 *
 *   1. `approval_rules.condition` is declared in the schema, documented with an example, and
 *      READ BY NOTHING — `pickRule` in core/pending-changes.ts matches on module, target and
 *      operation only. So "margin < 10%" and "after production start" cannot be conditions on
 *      a rule. Writing them would produce a row that looks like a gate and is not one.
 *   2. The margin-floor gate is real, but it lives in `costing/service.ts` and is driven by
 *      the `marginFloorPct` policy — which this script sets. That is the honest way to get
 *      "below 10% needs the owner".
 *   3. A payroll RUN is gated in code to hr+owner at the API boundary (CLAUDE.md rule 9),
 *      not through the approve inbox. The rule written here covers `wage_gazettes`, which is
 *      what the inbox actually routes.
 *
 * ## Role names
 *
 * The kit names roles a factory uses; `role_name` names roles this system has. Seven differ,
 * and the mapping is in ROLE_MAP below with the reasoning. The one worth arguing about is
 * `manager` → `admin`: there is no manager role, and `admin` is the only non-owner role that
 * `requireRole` treats as supervisory, which is what "manager approves by default" means
 * here.
 */
import 'dotenv/config'

import { randomBytes, randomUUID } from 'node:crypto'

import { hashPassword } from 'better-auth/crypto'
import { and, eq, sql } from 'drizzle-orm'

import { createDirectClient, createDirectDb } from '@/db/direct'
import * as schema from '@/db/schema'
import type { Role } from '@/modules/core/ctx'

// ─────────────────────────────────────────────────────────────────────────────
// Source data — transcribed from the live-test kit's structured-data/00-masters
// ─────────────────────────────────────────────────────────────────────────────

const COMPANY = {
  name: 'Barakah Fashions Ltd',
  slug: 'barakah-fashions',
  address: 'Plot 14, BSCIC Industrial Area, Tongi, Gazipur',
  bondLicence: 'BL-2019-4471',
  /** company.json says "knit-composite (with woven unit)"; the enum's value is the prefix. */
  factoryType: 'knit-composite' as const,
}

/** Unit → floor → line, with the machine and manpower counts from company.json. */
const STRUCTURE = [
  {
    unit: { code: 'U1', name: 'Unit 1 — Knit' },
    floors: [
      {
        code: 'U1-F1',
        name: 'Floor 1',
        lines: [
          { code: 'L1', machines: 56, manpower: 62 },
          { code: 'L2', machines: 56, manpower: 60 },
          { code: 'L3', machines: 56, manpower: 64 },
        ],
      },
      {
        code: 'U1-F2',
        name: 'Floor 2',
        lines: [
          { code: 'L4', machines: 54, manpower: 58 },
          { code: 'L5', machines: 54, manpower: 56 },
          { code: 'L6', machines: 54, manpower: 57 },
        ],
      },
    ],
  },
  {
    unit: { code: 'U2', name: 'Unit 2 — Woven' },
    floors: [
      {
        code: 'U2-F3',
        name: 'Floor 3',
        lines: [
          { code: 'L7', machines: 48, manpower: 52 },
          { code: 'L8', machines: 48, manpower: 50 },
        ],
      },
    ],
  },
] as const

/**
 * The knitting section is a UNIT with no sewing lines — its machines are knitting machines,
 * which live in `machines` (maintenance) because that is the table that tracks a machine's
 * type, serial and history. Putting them in `lines` would make them appear on the production
 * board as sewing lines that never produce.
 */
const KNITTING = {
  unit: { code: 'KNIT', name: 'Knitting Section' },
  machines: [
    { serial: 'KM-01', type: 'circular knitting 24G' },
    { serial: 'KM-02', type: 'circular knitting 24G' },
    { serial: 'KM-03', type: 'circular knitting 20G' },
  ],
} as const

/**
 * kit role → this system's `role_name`.
 *
 * Seven of the kit's names are not in the enum. Each mapping below is the role that holds
 * the same permissions, not the one with the closest spelling.
 */
const ROLE_MAP: Record<string, Role> = {
  owner: 'owner',
  admin: 'admin',
  merchandiser: 'merchandiser',
  commercial: 'commercial',
  planner: 'planner',
  hr: 'hr',
  compliance: 'compliance',
  viewer: 'viewer',
  // ── the seven that differ ──
  /** No `manager` exists. `admin` is the only non-owner role `requireRole` treats as
   *  supervisory, which is exactly what "manager approves by default" has to mean. */
  manager: 'admin',
  storekeeper: 'store',
  /** A line chief works the production board; the line narrowing is in `roles.scope`. */
  supervisor: 'production',
  qc: 'quality',
  /** Packing is the shipment module's carton and packing-list surface. */
  packing: 'shipment',
  mechanic: 'maintenance',
  accounts: 'finance',
}

interface KitUser {
  name: string
  email: string
  role: string
  scope?: string
  lines?: readonly string[]
  dept?: string
}

const USERS: readonly KitUser[] = [
  { name: 'Owner (Mr. Rahman)', email: 'owner@barakah.test', role: 'owner' },
  { name: 'Admin', email: 'admin@barakah.test', role: 'admin' },
  { name: 'Rashida Akter', email: 'rashida@barakah.test', role: 'merchandiser', scope: 'Bestseller' },
  { name: 'Imran Hossain', email: 'imran@barakah.test', role: 'merchandiser', scope: 'H&M' },
  { name: 'Merch Manager (Sultana)', email: 'sultana@barakah.test', role: 'manager', dept: 'merchandising' },
  { name: 'Tanvir Ahmed', email: 'tanvir@barakah.test', role: 'commercial' },
  { name: 'Nazmul Karim', email: 'nazmul@barakah.test', role: 'planner' },
  { name: 'Karim Uddin', email: 'karim@barakah.test', role: 'storekeeper' },
  { name: 'Rafiq Islam', email: 'rafiq@barakah.test', role: 'cutting' },
  { name: 'Shilpi Begum', email: 'shilpi@barakah.test', role: 'supervisor', lines: ['L1', 'L2'] },
  { name: 'Rina Das', email: 'rina@barakah.test', role: 'supervisor', lines: ['L7', 'L8'] },
  { name: 'Mitu Rani', email: 'mitu@barakah.test', role: 'qc' },
  { name: 'Jahid Hasan', email: 'jahid@barakah.test', role: 'packing' },
  { name: 'Sabbir Khan', email: 'sabbir@barakah.test', role: 'mechanic' },
  { name: 'Farzana Yasmin', email: 'farzana@barakah.test', role: 'hr' },
  { name: 'Rumi Chowdhury', email: 'rumi@barakah.test', role: 'compliance' },
  { name: 'Salma Khatun', email: 'salma@barakah.test', role: 'accounts' },
  { name: 'Guest Viewer', email: 'viewer@barakah.test', role: 'viewer' },
]

/** `cutting` is already an enum value, so it needs no mapping entry — assert that stays true. */
ROLE_MAP.cutting = 'cutting'

/**
 * Approval rules, in the only form the matcher understands.
 *
 * `priority` decides which rule wins: `pickRule` orders by priority DESC and takes the first
 * match, so a specific rule must outrank the module default or the default swallows it.
 */
const SPECIFIC_RULES = [
  {
    moduleId: 'commercial',
    targetTable: 'uds',
    operation: 'update' as const,
    requiredRoles: ['owner'] as Role[],
    why: 'uds.override → owner. A UD overdraw is legal exposure against the bond licence.',
  },
  {
    moduleId: 'workforce',
    targetTable: 'wage_gazettes',
    operation: null,
    requiredRoles: ['owner'] as Role[],
    why: 'The payroll-adjacent rule the inbox can actually route. The RUN itself is code-gated to hr+owner.',
  },
  {
    moduleId: 'orders',
    targetTable: 'order_breakdowns',
    operation: null,
    requiredRoles: ['owner', 'admin'] as Role[],
    why: 'orders.breakdown → manager. "After production start" is NOT enforceable — see the header.',
  },
  {
    moduleId: 'store',
    targetTable: 'stock_adjustments',
    operation: null,
    requiredRoles: ['owner', 'admin'] as Role[],
    why: 'store.adjust → manager. An adjustment is stock appearing or vanishing without a document.',
  },
]

/** Every module that routes anything to the inbox gets a manager-level catch-all. */
const DEFAULT_RULE_MODULES = [
  'buyers', 'commercial', 'compliance', 'costing', 'cutting', 'finance', 'orders',
  'planning', 'procurement', 'quality', 'rfq', 'sampling', 'shipment', 'store', 'workforce',
]

/** Grades 1–4, exactly as printed in workers_wages.json. Strings: a float here is a wrong payslip. */
const WAGE = {
  version: 'v-2023-12',
  effectiveFrom: '2023-12-01',
  notes:
    'Minimum wage structure v-2023-12, transcribed from the live-test kit. REPLACE with the ' +
    "factory's own gazette sheet before a real payroll run.",
  grades: [
    { grade: '1', basic: '8200.00', houseRent: '4100.00', medical: '750.00', transport: '450.00', food: '1250.00' },
    { grade: '2', basic: '7800.00', houseRent: '3900.00', medical: '750.00', transport: '450.00', food: '1250.00' },
    { grade: '3', basic: '7400.00', houseRent: '3700.00', medical: '750.00', transport: '450.00', food: '1250.00' },
    { grade: '4', basic: '7050.00', houseRent: '3525.00', medical: '750.00', transport: '450.00', food: '1250.00' },
  ],
} as const

/** The two template shapes from tna.json, as milestone offsets a new order can be built from. */
const TNA_TEMPLATES = [
  {
    name: 'Knit basic tee/polo EU',
    productType: 'knit-tee-polo',
    milestones: [
      { name: 'Fabric booking (yarn)', offsetDays: 0 },
      { name: 'Lab dip approval', offsetDays: 8 },
      { name: 'Yarn in-house', offsetDays: 19, bonded: true },
      { name: 'PP sample approval', offsetDays: 37, critical: true },
      { name: 'Knitting complete', offsetDays: 31 },
      { name: 'Dyeing complete', offsetDays: 41 },
      { name: 'Cutting start', offsetDays: 48, critical: true },
      { name: 'Sewing complete', offsetDays: 80, critical: true },
      { name: 'Final inspection', offsetDays: 86 },
      { name: 'Ex-factory', offsetDays: 90, critical: true },
    ],
  },
  {
    name: 'Woven jacket EU (wash)',
    productType: 'woven-jacket-wash',
    milestones: [
      { name: 'Fabric booking (denim import)', offsetDays: 0 },
      { name: 'Fabric in-house', offsetDays: 36, bonded: true },
      { name: 'Shell fabric inspection', offsetDays: 41 },
      { name: 'PP sample approval', offsetDays: 46, critical: true },
      { name: 'Cutting start', offsetDays: 51, critical: true },
      { name: 'Wash approval', offsetDays: 53 },
      { name: 'Sewing complete', offsetDays: 78, critical: true },
      { name: 'Final inspection', offsetDays: 84 },
      { name: 'Ex-factory', offsetDays: 88, critical: true },
    ],
  },
] as const

// ─────────────────────────────────────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
const has = (name: string): boolean => args.includes(`--${name}`)

const RESET_PASSWORDS = has('reset-passwords')
const DRY_RUN = has('dry-run')

/**
 * One password for everybody, when testing. See the header for what this gives up.
 *
 * Better Auth's `minPasswordLength` is 10 and it is checked at SIGN-IN as well as at
 * signup — a shorter one hashes fine here and then refuses every login, which would look
 * like the seed working and the product being broken.
 */
const SHARED_PASSWORD = flag('password')
if (SHARED_PASSWORD !== undefined && SHARED_PASSWORD.length < 10) {
  console.error('[day0] --password must be at least 10 characters, or nobody can sign in.')
  process.exit(1)
}

const tally: { step: string; created: number; updated: number; note?: string }[] = []
const record = (step: string, created: number, updated: number, note?: string): void => {
  tally.push(note === undefined ? { step, created, updated } : { step, created, updated, note })
}

/** Issued credentials, printed once at the end. */
const issued: { email: string; password: string }[] = []

function tempPassword(): string {
  if (SHARED_PASSWORD !== undefined) return SHARED_PASSWORD
  // 18 url-safe chars — comfortably over Better Auth's minPasswordLength of 10.
  return randomBytes(14).toString('base64url')
}

async function main(): Promise<void> {
  const client = createDirectClient()
  const db = createDirectDb(client)

  try {
    // ── 1 · the company ──────────────────────────────────────────────────────
    //
    // Resolved by slug, or by an explicit --company=<uuid> for a tenant that was created
    // through signup and therefore already has a name and an owner. The name is brought in
    // line with company.json; nothing else about an existing tenant is disturbed.
    const pinned = flag('company')
    const [found] = pinned
      ? await db.select().from(schema.companies).where(eq(schema.companies.id, pinned))
      : await db.select().from(schema.companies).where(eq(schema.companies.slug, COMPANY.slug))

    if (pinned && !found) throw new Error(`--company=${pinned} does not exist`)

    const companyId = found?.id ?? randomUUID()
    if (found) {
      await db
        .update(schema.companies)
        .set({
          name: COMPANY.name,
          legalName: COMPANY.name,
          bondedLicenseNo: COMPANY.bondLicence,
          address: { line1: COMPANY.address, city: 'Tongi', district: 'Gazipur', country: 'BD' },
          updatedAt: new Date(),
        })
        .where(eq(schema.companies.id, companyId))
      record('company', 0, 1, `${found.name} → ${COMPANY.name}`)
    } else {
      await db.insert(schema.companies).values({
        id: companyId,
        name: COMPANY.name,
        legalName: COMPANY.name,
        slug: COMPANY.slug,
        bondedLicenseNo: COMPANY.bondLicence,
        address: { line1: COMPANY.address, city: 'Tongi', district: 'Gazipur', country: 'BD' },
      })
      record('company', 1, 0, COMPANY.name)
    }

    // The profile decides which modules EXIST — knit-composite turns on the UD workbench and
    // the dye house. Getting this wrong shows a factory screens for work it does not do.
    await db
      .insert(schema.companyProfiles)
      .values({
        companyId,
        legalName: COMPANY.name,
        addressLines: [COMPANY.address],
        country: 'BD',
        bondLicenceNo: COMPANY.bondLicence,
        factoryType: COMPANY.factoryType,
        timezone: 'Asia/Dhaka',
        locale: 'en',
        baseCurrency: 'USD',
      })
      .onConflictDoUpdate({
        target: schema.companyProfiles.companyId,
        set: {
          legalName: COMPANY.name,
          addressLines: [COMPANY.address],
          bondLicenceNo: COMPANY.bondLicence,
          factoryType: COMPANY.factoryType,
        },
      })
    record('company_profile', 0, 1, `factory_type=${COMPANY.factoryType}`)

    // ── 2 · factory structure ────────────────────────────────────────────────
    let units = 0
    let floorsN = 0
    let linesN = 0

    for (const block of [...STRUCTURE, { unit: KNITTING.unit, floors: [] as const }]) {
      const [unitRow] = await db
        .insert(schema.factoryUnits)
        .values({ companyId, code: block.unit.code, name: block.unit.name })
        .onConflictDoUpdate({
          target: [schema.factoryUnits.companyId, schema.factoryUnits.code],
          set: { name: block.unit.name },
        })
        .returning({ id: schema.factoryUnits.id })
      units += 1

      for (const floor of block.floors) {
        const [floorRow] = await db
          .insert(schema.floors)
          .values({ companyId, factoryUnitId: unitRow!.id, code: floor.code, name: floor.name })
          .onConflictDoUpdate({
            target: [schema.floors.companyId, schema.floors.code],
            set: { name: floor.name, factoryUnitId: unitRow!.id },
          })
          .returning({ id: schema.floors.id })
        floorsN += 1

        for (const line of floor.lines) {
          await db
            .insert(schema.lines)
            .values({
              companyId,
              code: line.code,
              name: `Line ${line.code.slice(1)}`,
              capacityManpower: line.manpower,
              machinesCount: line.machines,
              floorId: floorRow!.id,
            })
            .onConflictDoUpdate({
              target: [schema.lines.companyId, schema.lines.code],
              set: {
                capacityManpower: line.manpower,
                machinesCount: line.machines,
                floorId: floorRow!.id,
                isActive: true,
              },
            })
          linesN += 1
        }
      }
    }
    record('factory_units', 0, units)
    record('floors', 0, floorsN)
    record('lines', 0, linesN, 'L1–L8')

    // Knitting machines. `machines.serial` has no unique index, so this checks first —
    // upserting on a key the database does not enforce is how duplicates arrive.
    let km = 0
    for (const m of KNITTING.machines) {
      const existing = await db
        .select({ id: schema.machines.id })
        .from(schema.machines)
        .where(and(eq(schema.machines.companyId, companyId), eq(schema.machines.serial, m.serial)))
      if (existing.length === 0) {
        await db.insert(schema.machines).values({
          companyId,
          machineType: m.type,
          serial: m.serial,
        })
        km += 1
      }
    }
    record('machines (knitting)', km, KNITTING.machines.length - km, 'KM-01..03')

    // ── 3 · people ───────────────────────────────────────────────────────────
    //
    // `emailVerified: true` on purpose. @barakah.test cannot receive mail and verification
    // gates sign-in, so a false here produces eighteen accounts that exist and cannot be
    // used — the exact state a real signup hit on this deployment.
    let usersCreated = 0
    let usersExisting = 0
    let rolesN = 0

    /*
     * A tenant created through signup already HAS an owner — a real person with a real
     * mailbox who will be the one testing it. The kit's `owner@barakah.test` is a fixture
     * standing in for whoever that is, and creating it alongside gives the factory two
     * owners and two logins for one job.
     *
     * So: if an active owner already exists whose address is not one of the kit's, the kit
     * owner is skipped entirely — no user, no credential, no role. This is not merely a
     * "don't create" — without it, the role upsert below clears `revoked_at`, so a re-run
     * would RESURRECT an owner somebody had deliberately removed.
     */
    const realOwners = await db
      .select({ email: schema.users.email })
      .from(schema.roles)
      .innerJoin(schema.users, eq(schema.users.id, schema.roles.userId))
      .where(
        and(
          eq(schema.roles.companyId, companyId),
          eq(schema.roles.role, 'owner'),
          sql`${schema.roles.revokedAt} is null`,
        ),
      )
    const kitEmails = new Set(USERS.map((u) => u.email))
    const externalOwner = realOwners.find((o) => !kitEmails.has(o.email))

    for (const person of USERS) {
      if (person.role === 'owner' && externalOwner) {
        record('users (owner)', 0, 0, `skipped ${person.email} — ${externalOwner.email} already owns this tenant`)
        continue
      }
      const role = ROLE_MAP[person.role]
      if (!role) throw new Error(`no role mapping for "${person.role}" (${person.email})`)

      const [existing] = await db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.email, person.email))

      const userId = existing?.id ?? `day0-${companyId.slice(0, 8)}-${person.email.split('@')[0]}`

      if (existing) {
        await db
          .update(schema.users)
          .set({ name: person.name, emailVerified: true })
          .where(eq(schema.users.id, userId))
        usersExisting += 1
      } else {
        await db.insert(schema.users).values({
          id: userId,
          email: person.email,
          name: person.name,
          emailVerified: true,
        })
        usersCreated += 1
      }

      // `default_company_id` lives on the profile, not the user — a user can belong to
      // several companies and `users` is Better Auth's table. `department` belongs here too,
      // rather than in `roles.scope`, which narrows PERMISSIONS rather than describing a
      // person: Sultana's department is a fact about her, not a restriction on what she sees.
      await db
        .insert(schema.profiles)
        .values({
          userId,
          fullName: person.name,
          defaultCompanyId: companyId,
          locale: 'en',
          ...(person.dept ? { department: person.dept } : {}),
        })
        .onConflictDoUpdate({
          target: schema.profiles.userId,
          set: {
            fullName: person.name,
            defaultCompanyId: companyId,
            ...(person.dept ? { department: person.dept } : {}),
            updatedAt: new Date(),
          },
        })

      // Credential: written once. See the header on why a re-run does not reissue.
      const [cred] = await db
        .select({ id: schema.accounts.id })
        .from(schema.accounts)
        .where(
          and(eq(schema.accounts.userId, userId), eq(schema.accounts.providerId, 'credential')),
        )

      if (!cred || RESET_PASSWORDS) {
        const password = tempPassword()
        const hashed = await hashPassword(password)
        if (cred) {
          await db
            .update(schema.accounts)
            .set({ password: hashed, updatedAt: new Date() })
            .where(eq(schema.accounts.id, cred.id))
        } else {
          await db.insert(schema.accounts).values({
            id: `day0-cred-${userId}`,
            userId,
            accountId: userId,
            providerId: 'credential',
            password: hashed,
          })
        }
        issued.push({ email: person.email, password })
      }

      // Scope narrows what the role can see. `{lines:[...]}` is the shape roles.scope
      // documents; `{buyers:[...]}` mirrors it for a merchandiser's book.
      const scope: Record<string, unknown> = {}
      if (person.lines) scope.lines = [...person.lines]
      if (person.scope) scope.buyers = [person.scope]

      await db
        .insert(schema.roles)
        .values({ companyId, userId, role, scope })
        .onConflictDoUpdate({
          target: [schema.roles.companyId, schema.roles.userId, schema.roles.role],
          set: { scope, revokedAt: null },
        })
      rolesN += 1
    }
    record('users', usersCreated, usersExisting)
    record('roles', 0, rolesN, '18 assignments')

    // ── 4 · approval rules ───────────────────────────────────────────────────
    let rulesN = 0
    const upsertRule = async (r: {
      moduleId: string
      targetTable: string | null
      operation: 'insert' | 'update' | 'delete' | null
      requiredRoles: Role[]
      priority: number
    }): Promise<void> => {
      // No unique index covers (module, target, operation), so match then write.
      const existing = await db
        .select({ id: schema.approvalRules.id })
        .from(schema.approvalRules)
        .where(
          and(
            eq(schema.approvalRules.companyId, companyId),
            eq(schema.approvalRules.moduleId, r.moduleId),
            r.targetTable === null
              ? sql`${schema.approvalRules.targetTable} is null`
              : eq(schema.approvalRules.targetTable, r.targetTable),
            r.operation === null
              ? sql`${schema.approvalRules.operation} is null`
              : eq(schema.approvalRules.operation, r.operation),
          ),
        )

      if (existing[0]) {
        await db
          .update(schema.approvalRules)
          .set({
            requiredRoles: r.requiredRoles,
            priority: r.priority,
            isActive: true,
            updatedAt: new Date(),
          })
          .where(eq(schema.approvalRules.id, existing[0].id))
      } else {
        await db.insert(schema.approvalRules).values({
          companyId,
          moduleId: r.moduleId,
          targetTable: r.targetTable,
          operation: r.operation,
          requiredRoles: r.requiredRoles,
          approvalsRequired: 1,
          autoApprove: false,
          priority: r.priority,
        })
      }
      rulesN += 1
    }

    for (const r of SPECIFIC_RULES) {
      await upsertRule({ ...r, priority: 200 })
    }
    for (const moduleId of DEFAULT_RULE_MODULES) {
      await upsertRule({
        moduleId,
        targetTable: null,
        operation: null,
        requiredRoles: ['owner', 'admin'],
        priority: 100,
      })
    }
    record('approval_rules', 0, rulesN, `${SPECIFIC_RULES.length} specific + ${DEFAULT_RULE_MODULES.length} default`)

    // ── 5 · master data ──────────────────────────────────────────────────────
    let tnaN = 0
    for (const tpl of TNA_TEMPLATES) {
      await db
        .insert(schema.tnaTemplates)
        .values({
          companyId,
          name: tpl.name,
          productType: tpl.productType,
          milestones: [...tpl.milestones],
        })
        .onConflictDoUpdate({
          target: [schema.tnaTemplates.companyId, schema.tnaTemplates.name],
          set: {
            productType: tpl.productType,
            milestones: [...tpl.milestones],
            isActive: true,
            updatedAt: new Date(),
          },
        })
      tnaN += 1
    }
    record('tna_templates', 0, tnaN, TNA_TEMPLATES.map((t) => t.name).join(' · '))

    /*
     * Defect codes come from the QUALITY module's own seeder, not from a list in this file.
     *
     * This script used to write its own D-01..D-16 set, transcribed from the brief. That was
     * wrong twice over. It duplicated master data the app already provisions at signup —
     * `provisionCompany` calls this same function — so a tenant ended up with thirty-two
     * codes for sixteen defects, and a QC operator was offered two buttons for a broken
     * stitch. The code table exists precisely so "two inspectors cannot classify the same
     * defect differently", and duplicating it defeated that.
     *
     * Worse, the upsert set `isActive: true`. Barakah's D-numbered set was deactivated by a
     * deliberate decision, and a re-run would have turned all sixteen back on and reported
     * it as a routine same-as-before line — the identical failure the owner skip above
     * exists to prevent.
     *
     * `seedDefaultDefectCodes` skips any code already present and never touches `is_active`,
     * so it cannot resurrect something somebody hid. Rule 11: each module seeds its own
     * tables, and this file asks it to.
     */
    const { seedDefaultDefectCodes } = await import('@/modules/quality/service')
    const defects = await seedDefaultDefectCodes({
      companyId,
      userId: null,
      roles: ['owner'],
      system: true,
    })
    record(
      'defect_codes',
      defects.created.length,
      defects.existing.length,
      'quality module default set',
    )

    // Wage gazette + grades. Written directly rather than through `uploadGazette`, which is
    // not idempotent and would stack a new gazette on every run; the shape is the same one
    // its zod accepts.
    const [gazette] = await db
      .insert(schema.wageGazettes)
      .values({
        companyId,
        version: WAGE.version,
        effectiveFrom: WAGE.effectiveFrom,
        status: 'active',
        notes: WAGE.notes,
        activatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [schema.wageGazettes.companyId, schema.wageGazettes.version],
        set: { effectiveFrom: WAGE.effectiveFrom, notes: WAGE.notes, updatedAt: new Date() },
      })
      .returning({ id: schema.wageGazettes.id })

    let gradeN = 0
    for (const g of WAGE.grades) {
      await db
        .insert(schema.wageGrades)
        .values({ companyId, gazetteId: gazette!.id, ...g })
        .onConflictDoUpdate({
          target: [schema.wageGrades.gazetteId, schema.wageGrades.grade],
          set: {
            basic: g.basic,
            houseRent: g.houseRent,
            medical: g.medical,
            transport: g.transport,
            food: g.food,
          },
        })
      gradeN += 1
    }
    record('wage_gazette', 0, 1, `${WAGE.version} (active)`)
    record('wage_grades', 0, gradeN, 'grades 1–4')

    await db
      .insert(schema.consumptionTemplates)
      .values({
        companyId,
        productType: 'polo-180gsm',
        params: { fabricGsm: 180, consumptionGramsPerPc: 255, unit: 'g/pc' },
      })
      .onConflictDoUpdate({
        target: [schema.consumptionTemplates.companyId, schema.consumptionTemplates.productType],
        set: {
          params: { fabricGsm: 180, consumptionGramsPerPc: 255, unit: 'g/pc' },
          updatedAt: new Date(),
        },
      })
    record('consumption_template', 0, 1, 'polo-180gsm · 255 g/pc')

    // Merged, not replaced — a factory that retuned another costing key keeps it.
    const [existingPolicy] = await db
      .select({ overrides: schema.policySettings.overrides })
      .from(schema.policySettings)
      .where(
        and(
          eq(schema.policySettings.companyId, companyId),
          eq(schema.policySettings.moduleId, 'costing'),
        ),
      )
    const merged = { ...(existingPolicy?.overrides ?? {}), marginFloorPct: '10' }
    await db
      .insert(schema.policySettings)
      .values({ companyId, moduleId: 'costing', overrides: merged })
      .onConflictDoUpdate({
        target: [schema.policySettings.companyId, schema.policySettings.moduleId],
        set: { overrides: merged, updatedAt: new Date() },
      })
    record('policy costing', 0, 1, 'marginFloorPct=10')

    // ── report ───────────────────────────────────────────────────────────────
    report(companyId)
  } finally {
    await client.end()
  }
}

function report(companyId: string): void {
  const pad = (s: string, n: number): string => s.padEnd(n)
  console.log(`\n[day0] Barakah Fashions Ltd · ${companyId}\n`)
  console.log(`  ${pad('step', 24)} ${pad('new', 5)} ${pad('same', 5)} detail`)
  console.log(`  ${'─'.repeat(72)}`)
  for (const t of tally) {
    console.log(
      `  ${pad(t.step, 24)} ${pad(String(t.created), 5)} ${pad(String(t.updated), 5)} ${t.note ?? ''}`,
    )
  }

  if (issued.length > 0 && SHARED_PASSWORD !== undefined) {
    // One line, not eighteen identical ones — a wall of the same secret repeated invites
    // somebody to copy the wrong row, and hides how few secrets are actually protecting
    // this tenant now.
    console.log(`\n[day0] CREDENTIALS — ONE SHARED PASSWORD for all ${issued.length} accounts:\n`)
    console.log(`  every @barakah.test account   ${SHARED_PASSWORD}`)
    console.log(`\n  ⚠ TEST TENANT ONLY. One password is every role in this company, owner`)
    console.log(`    included. Re-run WITHOUT --password before any real factory data arrives.`)
  } else if (issued.length > 0) {
    console.log(`\n[day0] CREDENTIALS — shown once, not stored anywhere. Copy them now.\n`)
    for (const c of issued) console.log(`  ${pad(c.email, 30)} ${c.password}`)
    console.log(`\n  Re-running does NOT reissue these. Use --reset-passwords to force new ones.`)
  } else {
    console.log(`\n[day0] No new credentials — every user already had one.`)
  }

  console.log(`\n[day0] NOT DONE, and why — these are not omissions:`)
  console.log(`  · costing margin<10% → owner is NOT an approval rule. approval_rules.condition`)
  console.log(`    is declared in the schema and read by nothing (core/pending-changes.ts`)
  console.log(`    matches module/target/operation only). The gate is real but lives in`)
  console.log(`    costing/service.ts, driven by the marginFloorPct policy this script set.`)
  console.log(`  · orders.breakdown "after production start" — same reason, no condition support.`)
  console.log(`    The rule written routes ALL breakdowns to manager, which is stricter.`)
  console.log(`  · A payroll RUN is gated in code to hr+owner at the API boundary (rule 9), not`)
  console.log(`    through the inbox. The rule written covers wage_gazettes, which the inbox routes.`)
  console.log(`  · "manager" is not a role in this system. Mapped to admin — the only non-owner`)
  console.log(`    role requireRole treats as supervisory. Sultana therefore has broad rights.\n`)
}

if (DRY_RUN) {
  console.log('[day0] --dry-run is not implemented: every write is an upsert, so a dry run')
  console.log('[day0] that told you nothing new would be a false comfort. Run it against a')
  console.log('[day0] scratch database instead.')
  process.exit(1)
}

main().catch((error) => {
  console.error('[day0] failed:', error instanceof Error ? error.message : error)
  process.exitCode = 1
})
