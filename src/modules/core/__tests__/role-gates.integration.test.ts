/**
 * Every screen's access gate, against the real HTTP surface.
 *
 * The screens brief defines three access patterns, and each fails differently
 * when it is wrong:
 *
 *  - **Hidden** — the module is absent from nav AND a deep link lands on the
 *    locked card. If only the nav honours it, "hidden" means "not linked", and
 *    the data leaks to anyone who guesses a URL. That exact bug shipped in the
 *    first version of the workforce screen and is why this file exists.
 *  - **Locked** — a quiet 403 card that leaks no data shape: no counts, no
 *    column headers, no skeleton rows.
 *  - **Redacted** — the page renders, individual sensitive fields do not.
 *
 * Asserted at the HTTP layer rather than by calling the page function, because
 * what matters is what reaches the browser. A field can be filtered in the
 * markup and still sit in the RSC payload; only reading the response body
 * catches that.
 *
 * This is deliberately a test and not a shell script. A manual curl check of
 * these same gates reported two screens as locked that were not, because of a
 * quoting mistake — a verification that can be wrong in the reassuring
 * direction is worse than none.
 */
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, roles, users } from '@/db/schema/core'
import type { Role } from '@/modules/core/ctx'
import { requireRole } from '@/modules/core/session'

const BASE_URL = process.env.APP_URL ?? `http://localhost:${process.env.INTEGRATION_PORT ?? 3100}`
const RUN = Math.random().toString(36).slice(2, 10)
const PASSWORD = 'correct-horse-battery-staple'

const client = createDirectClient()
const db = createDirectDb(client)

/**
 * The locked card names its subject: "You don't have access to workforce".
 *
 * Matching the SUBJECT rather than a generic marker matters. The workforce
 * screen can show a payroll-specific locked card while still rendering the
 * roster, so a substring like "have access to" is satisfied by the wrong lock —
 * a mutation test proved exactly that hole before this was tightened.
 */
const lockedFor = (subject: string) => `have access to ${subject}`

interface Actor {
  role: Role
  email: string
  cookie: string
}

let companyId: string
const actors = new Map<Role, Actor>()

/**
 * Every company signup created, including the throwaway one each actor gets and
 * then leaves.
 *
 * Signing up provisions a full tenant — TNA templates, defect codes, loss
 * reasons — so an uncollected company is not an empty row, it is a seeded
 * factory that other suites can see. This suite left six of them per run until a
 * neighbouring test that counted templates across all tenants started failing.
 */
const provisioned = new Set<string>()

/**
 * Sign a user up, verify them directly, and re-point them at the shared company
 * with exactly one role.
 *
 * Verification is done with an UPDATE rather than through Mailpit on purpose:
 * this suite is about authorisation, and going through the mail flow would make
 * every case depend on SMTP being healthy.
 */
async function makeActor(role: Role): Promise<Actor> {
  const email = `gate-${role}-${RUN}@fabricxai.test`

  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD, name: `Gate ${role}`, companyName: `tmp-${role}-${RUN}` }),
  })

  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
  if (!user) throw new Error(`signup did not create ${email}`)

  await db.update(users).set({ emailVerified: true }).where(eq(users.id, user.id))

  // Signup makes its own company; move the user onto the shared one so every
  // actor sees the same data and only the ROLE differs. The abandoned company is
  // remembered so afterAll can drop it.
  const own = await db.select({ companyId: roles.companyId }).from(roles).where(eq(roles.userId, user.id))
  for (const row of own) provisioned.add(row.companyId)

  await db.delete(roles).where(eq(roles.userId, user.id))
  await db.insert(roles).values({ companyId, userId: user.id, role })

  const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })

  const cookie = signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ')
  if (!cookie) throw new Error(`no session cookie for ${role}`)

  return { role, email, cookie }
}

async function visit(actor: Actor, path: string): Promise<{ status: number; body: string }> {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: { cookie: actor.cookie },
    redirect: 'manual',
  })

  // React SSR writes `<!-- -->` between a literal and an interpolated value, so
  // the markup for `have access to {what}` is `have access to <!-- -->payroll`.
  // Stripping the separators is what lets an assertion name the subject rather
  // than settling for a generic substring that any lock would satisfy.
  const raw = await response.text()
  return { status: response.status, body: raw.replaceAll('<!-- -->', '') }
}

beforeAll(async () => {
  // The owner's signup creates the company every other actor is moved onto.
  const ownerEmail = `gate-owner-${RUN}@fabricxai.test`
  await fetch(`${BASE_URL}/api/auth/sign-up/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: ownerEmail,
      password: PASSWORD,
      name: 'Gate owner',
      companyName: `Gate Apparels ${RUN}`,
    }),
  })

  const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.email, ownerEmail))
  if (!owner) throw new Error('owner signup failed')
  await db.update(users).set({ emailVerified: true }).where(eq(users.id, owner.id))

  const [ownerRole] = await db
    .select({ companyId: roles.companyId })
    .from(roles)
    .where(and(eq(roles.userId, owner.id), eq(roles.role, 'owner')))
  if (!ownerRole) throw new Error('owner role missing')
  companyId = ownerRole.companyId
  provisioned.add(companyId)

  const signIn = await fetch(`${BASE_URL}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: ownerEmail, password: PASSWORD }),
  })
  actors.set('owner', {
    role: 'owner',
    email: ownerEmail,
    cookie: signIn.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '),
  })

  for (const role of ['merchandiser', 'store', 'quality', 'hr', 'viewer'] as const) {
    actors.set(role, await makeActor(role))
  }
}, 180_000)

afterAll(async () => {
  const emails = [...actors.values()].map((a) => a.email)
  for (const email of emails) {
    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email))
    if (!user) continue
    await db.delete(roles).where(eq(roles.userId, user.id))
    await db.delete(users).where(eq(users.id, user.id))
  }
  for (const id of provisioned) await db.delete(companies).where(eq(companies.id, id))
  await client.end()
})

describe('hidden modules refuse deep links, not just nav entries', () => {
  /** [path, locked-card subject, roles that may open it]. */
  const RESTRICTED: [string, string, Role[]][] = [
    ['/workforce', 'workforce', ['owner', 'hr']],
    ['/compliance', 'compliance', ['owner', 'compliance']],
    ['/ud', 'the UD workbench', ['owner', 'store', 'commercial', 'compliance']],
  ]

  for (const [path, subject, allowed] of RESTRICTED) {
    it(`${path} is locked for roles without it`, async () => {
      for (const actor of actors.values()) {
        const { status, body } = await visit(actor, path)
        expect(status, `${path} as ${actor.role}`).toBe(200)

        // Asserts the MODULE's own lock, not merely that some lock is present.
        const locked = body.includes(lockedFor(subject))
        expect(locked, `${path} as ${actor.role}: expected locked=${!allowed.includes(actor.role)}`).toBe(
          !allowed.includes(actor.role),
        )
      }
    })
  }
})

describe('payroll leaks nothing to a role that cannot see it', () => {
  it('no wage figure, worker name or gazette reference reaches the browser', async () => {
    const denied = [...actors.values()].filter((a) => a.role !== 'owner' && a.role !== 'hr')
    expect(denied.length).toBeGreaterThan(0)

    for (const actor of denied) {
      const { body } = await visit(actor, '/workforce')

      // Not "filtered out of the markup" — absent from the payload entirely.
      // Anything fetched then hidden would still appear in the RSC stream.
      for (const probe of ['Wage gazette', 'gazetteId', 'payroll_lines', 'festivalBonus', 'houseRent']) {
        expect(body, `${probe} leaked to ${actor.role}`).not.toContain(probe)
      }
    }
  })

  it('the locked card states no counts', async () => {
    const viewer = actors.get('viewer')!
    const { body } = await visit(viewer, '/workforce')

    expect(body).toContain(lockedFor('workforce'))
    // A count would tell a denied role how many people the factory employs.
    expect(body).not.toContain('on the floor')
    expect(body).not.toContain('Headcount')
    expect(body).not.toContain('Roster')
  })
})

describe('the dashboard is one morning now (plan 2.1)', () => {
  /*
   * `/dashboard` folded into `/home`. The route survives as a redirect (bookmarks and
   * muscle memory keep working) but the two halves of the old contract changed shape:
   * an owner gets a 307 to home instead of a page, and everyone else still meets the
   * layout's lock BEFORE the redirect can run, because access is decided by the shell,
   * not by the page a path happens to render.
   */
  it('redirects an owner to /home', async () => {
    const owner = actors.get('owner')
    if (!owner) throw new Error('no owner actor')
    const response = await fetch(`${BASE_URL}/dashboard`, {
      headers: { cookie: owner.cookie },
      redirect: 'manual',
    })

    if (response.status === 200) {
      // The layout's auth work flushes headers before the page runs, so Next delivers the
      // redirect inside the stream (a meta refresh) rather than as a 3xx. Same contract,
      // different transport — assert the destination either way.
      const body = await response.text()
      expect(body).toContain('/home')
      expect(body).toMatch(/http-equiv="refresh"|NEXT_REDIRECT/)
    } else {
      expect([302, 307]).toContain(response.status)
      expect(response.headers.get('location')).toContain('/home')
    }
  })

  it('still locks before it redirects, for a role without it', async () => {
    const store = actors.get('store')
    if (!store) throw new Error('no store actor')
    const { status, body } = await visit(store, '/dashboard')
    expect(status).toBe(200)
    expect(body).toContain(lockedFor('the owner dashboard'))
  })
})

describe('permitted screens still render for the roles that own them', () => {
  const ALLOWED: [string, Role][] = [
    ['/orders', 'merchandiser'],
    ['/approve', 'merchandiser'],
    ['/store', 'store'],
    ['/quality', 'quality'],
    ['/workforce', 'hr'],
    // Reached from the top-bar chip, so it carries `hiddenFromSidebar` and is absent from
    // the nav a storekeeper is sent. It is still registered, and must still open: the shell
    // now refuses any path the registry does not name, and the way to get that wrong is to
    // lock a screen that was only ever missing from a list.
    ['/factory', 'store'],
  ]

  for (const [path, role] of ALLOWED) {
    it(`${path} renders for ${role}`, async () => {
      const actor = actors.get(role)
      if (!actor) throw new Error(`no actor for ${role}`)

      const { status, body } = await visit(actor, path)
      expect(status).toBe(200)
      // The inverse assertion matters as much as the lock: a gate that refuses
      // everybody passes every "is it locked" test and is still broken.
      expect(body, `${path} wrongly locked for ${role}`).not.toContain('have access to')
    })
  }
})

describe('the action boundary refuses a wrong role, against a real session', () => {
  /**
   * The gate every `'use server'` export now runs (audit N1), exercised with real cookies
   * rather than a constructed ctx — the roles come back from the database on each call, so
   * a test that hand-built a ctx would be asserting its own fixture.
   *
   * The screens above are the LAST wall. This is the one that matters for a write: a
   * Server Action is a POST addressed by an action id and renders nothing, so no amount of
   * `canSee` in a layout is between a member and the operation.
   */
  const headersFor = (actor: Actor) => new Headers({ cookie: actor.cookie })

  it('refuses the role that does not own the operation', async () => {
    const store = actors.get('store')!

    // A storekeeper recording the buyer's verdict would open the PP-approval gate and
    // release cutting. This is the exact call that was open to every member.
    await expect(requireRole(headersFor(store), 'merchandiser')).rejects.toMatchObject({
      status: 403,
      messageKey: 'errors.forbidden',
    })
  })

  it('admits the role that does own it', async () => {
    const quality = actors.get('quality')!
    const ctx = await requireRole(headersFor(quality), 'quality')

    expect(ctx.roles).toContain('quality')
    expect(ctx.companyId).toBe(companyId)
  })

  it('admits an owner to any operation, as supervision', async () => {
    // The same pair /api/sync grants on every floor handler: an owner covering a shift
    // must not be locked out of the operation they are covering.
    const owner = actors.get('owner')!
    const ctx = await requireRole(headersFor(owner), 'quality')

    expect(ctx.roles).toContain('owner')
  })

  it('names what was required, so the refusal can be acted on', async () => {
    const viewer = actors.get('viewer')!

    await expect(requireRole(headersFor(viewer), 'commercial', 'finance')).rejects.toMatchObject({
      details: { required: ['commercial', 'finance'] },
    })
  })

  it('refuses an unauthenticated caller before it considers roles', async () => {
    await expect(requireRole(new Headers(), 'quality')).rejects.toMatchObject({
      messageKey: 'errors.unauthenticated',
    })
  })

  it('treats an empty role list as a programming error, not as "everyone"', async () => {
    const viewer = actors.get('viewer')!

    // A door with no keyholder is a door standing open. `registerSyncHandler` refuses the
    // same way, and this is what makes the source sweep's "no empty gate" check reachable.
    await expect(requireRole(headersFor(viewer))).rejects.toThrow(/every door needs a keyholder/)
  })
})

describe('an unauthenticated request never reaches a screen', () => {
  it('redirects to login rather than rendering', async () => {
    for (const path of ['/workforce', '/dashboard', '/orders']) {
      const response = await fetch(`${BASE_URL}${path}`, { redirect: 'manual' })
      expect([302, 307], `${path} unauthenticated`).toContain(response.status)
      expect(response.headers.get('location')).toContain('/login')
    }
  })
})
