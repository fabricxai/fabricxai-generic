/**
 * Better Auth configuration (dev-plan §1 auth row, §2.2; PLAYBOOK §1 session 2).
 *
 * Three things are load-bearing here and none of them are defaults:
 *
 * 1. **Email verification actually gates login.** `requireEmailVerification` is on, so an
 *    unverified account cannot sign in. A verification step that does not gate login is
 *    decoration — see docs/runbooks/phase-0-exit.md gate A.
 *
 * 2. **The organization plugin is mapped onto our own tables**, not given its own.
 *    `organization` → `companies`, `member` → `roles`. This is what makes the auth layer
 *    and the tenancy layer agree on what a company is by construction. `ctx.companyId`
 *    comes from `session.activeOrganizationId`, so a client can never assert which
 *    company it is acting in.
 *
 * 3. **Ids are UUIDs.** `companies.id` and `roles.id` are `uuid` columns that predate
 *    Better Auth, so id generation is pinned rather than left to the library's default
 *    string format.
 */
import { randomUUID } from 'node:crypto'

import { betterAuth } from 'better-auth'
import { drizzleAdapter } from 'better-auth/adapters/drizzle'
import { organization } from 'better-auth/plugins'

import { db } from '@/db/client'
import * as schema from '@/db/schema'
import { membershipsForUser, withTenantTx } from '@/modules/core/tenancy'

import { env } from './env'
import { sendPasswordResetEmail, sendVerificationEmail } from './mailer'
import { provisionCompany } from './provisioning'
import { LIMITS, authRateLimitEnabled } from './rate-limit'
import { getRedis } from './redis'

export const auth = betterAuth({
  appName: 'FabricXAI',
  baseURL: env.BETTER_AUTH_URL ?? env.APP_URL,
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],

  database: drizzleAdapter(db, {
    provider: 'pg',
    // Keys are the model names Better Auth resolves AFTER the modelName overrides below.
    schema: {
      users: schema.users,
      sessions: schema.sessions,
      accounts: schema.accounts,
      verifications: schema.verifications,
      companies: schema.companies,
      roles: schema.roles,
      invitations: schema.invitations,
    },
  }),

  advanced: {
    database: {
      // companies.id / roles.id are uuid columns; do not let the library pick a format.
      generateId: () => randomUUID(),
    },
    // Pinned rather than inferred. Better Auth decides secure-cookie behaviour from the
    // baseURL's scheme, so an operator who sets APP_URL=http:// behind a TLS-terminating
    // proxy would silently get non-secure session cookies on a real deployment — the kind
    // of misconfiguration that looks like nothing until somebody is on the factory wifi
    // with a packet capture (audit INFRA-L3).
    useSecureCookies: env.NODE_ENV === 'production',
  },

  /**
   * Brute-force and abuse limits (audit INFRA-H7).
   *
   * Nothing throttled password guessing, and nothing throttled sign-up — where each
   * attempt runs `provisionCompany`, the most expensive unauthenticated write in the
   * product. Better Auth's defaults are in-memory, which for this deployment means not
   * shared between the app and worker processes and reset on every deploy.
   *
   * `secondaryStorage` below puts the counters in Redis, so the limit is one limit across
   * processes and survives a restart. The per-path numbers live in `lib/rate-limit.ts`
   * beside the ones for /api/sync and /api/documents, so all of them can be read together.
   *
   * ## Production only, with an escape hatch
   *
   * Off outside production, which is also Better Auth's own default. The reason is
   * concrete rather than convenience: signup is capped at three per hour per IP because a
   * real factory signs up once, and the integration suite signs up a handful of owners
   * from one address — so an always-on limiter fails `gate A · signup → verify → login`
   * and the role-gate suite with a 429 that has nothing to do with the code under test.
   *
   * `RATE_LIMIT_ENFORCE=1` turns it on anywhere, which is how the limits get exercised
   * locally without leaving CI to discover them.
   *
   * ## And `RATE_LIMIT_DISABLED=1` turns it off anywhere, including production
   *
   * For a test tenant being walked through by several people at once. Eighteen role
   * sign-ins in an afternoon, from one office behind one NAT address, hits ten-per-five-
   * minutes long before the sweep is finished — and the login form reports a 429 in the
   * same words it uses for a wrong password, so the limiter reads as "login is broken".
   *
   * It is a deliberate hole and it is named like one: with this set, nothing at all slows
   * a password-guessing loop against a public host. Set it while testing, unset it before
   * a factory's real people sign in. The precedence lives in `authRateLimitEnabled`.
   */
  rateLimit: {
    enabled: authRateLimitEnabled({
      nodeEnv: env.NODE_ENV,
      disabled: env.RATE_LIMIT_DISABLED,
      enforce: process.env.RATE_LIMIT_ENFORCE,
    }),
    storage: 'secondary-storage',
    window: 60,
    max: 60,
    customRules: {
      '/sign-in/email': { window: LIMITS.signIn.windowSeconds, max: LIMITS.signIn.limit },
      '/sign-up/email': { window: LIMITS.signUp.windowSeconds, max: LIMITS.signUp.limit },
      '/forget-password': {
        window: LIMITS.authRecovery.windowSeconds,
        max: LIMITS.authRecovery.limit,
      },
      '/reset-password': {
        window: LIMITS.authRecovery.windowSeconds,
        max: LIMITS.authRecovery.limit,
      },
      '/send-verification-email': {
        window: LIMITS.authRecovery.windowSeconds,
        max: LIMITS.authRecovery.limit,
      },
    },
  },

  /**
   * Redis for rate-limit counters and the session cache.
   *
   * **Sessions still live in Postgres** — see `storeSessionInDatabase` on `session` below.
   * Configuring `secondaryStorage` alone moves them OUT of the database, which the gate A
   * suite caught immediately: `ctx` is resolved from `sessions.activeOrganizationId`
   * through a `SECURITY DEFINER` lookup, so a session that exists only in Redis has no
   * company, and tenancy resolution returns nothing at all.
   *
   * With that flag set this is a cache and a counter: losing Redis costs a round trip and
   * resets a rate-limit window, never a signed-in user's session.
   */
  secondaryStorage: {
    get: async (key) => (await getRedis().get(`ba:${key}`)) ?? null,
    set: async (key, value, ttl) => {
      if (ttl) await getRedis().set(`ba:${key}`, value, 'EX', ttl)
      else await getRedis().set(`ba:${key}`, value)
    },
    delete: async (key) => {
      await getRedis().del(`ba:${key}`)
    },
  },

  // Map Better Auth's singular model names onto our plural tables.
  user: { modelName: 'users' },
  session: {
    modelName: 'sessions',
    // Floor tablets are shared devices left logged in all shift; a week is plenty and
    // bounds the damage from an unattended one.
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
    // Load-bearing, and NOT the default once `secondaryStorage` is configured: without it
    // Better Auth keeps sessions in Redis only. `ctx.companyId` comes from
    // `sessions.activeOrganizationId` read through a SECURITY DEFINER function, and the
    // session row is what joins a signed-in user to their roles — so a Redis-only session
    // means no tenancy scope at all, and a Redis flush would sign out the whole factory.
    storeSessionInDatabase: true,
  },
  account: { modelName: 'accounts' },
  verification: { modelName: 'verifications' },

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    minPasswordLength: 10,
    autoSignIn: false,

    /**
     * Self-service recovery. Without it, `requireEmailVerification` meant a forgotten
     * password had no path that did not involve database access — a support call per
     * locked-out user, and for the factory owner a support call to the vendor.
     *
     * One hour, not the 24 the verification link gets: a reset link is a live credential
     * for whoever holds it, and the person using one is at their keyboard right now.
     */
    resetPasswordTokenExpiresIn: 60 * 60,
    sendResetPassword: async ({ user, url }) => {
      await sendPasswordResetEmail({ to: user.email, name: user.name, url })
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    expiresIn: 60 * 60 * 24,
    sendVerificationEmail: async ({ user, url }) => {
      await sendVerificationEmail({ to: user.email, name: user.name, url })
    },
  },

  plugins: [
    organization({
      schema: {
        organization: {
          modelName: 'companies',
          // Better Auth field name → the property name on our Drizzle table.
          fields: { createdAt: 'createdAt' },
        },
        member: {
          modelName: 'roles',
          fields: { organizationId: 'companyId' },
        },
        invitation: { modelName: 'invitations' },
      },
      // A factory is created by its owner at signup (see the user-create hook below);
      // nobody self-serve creates a second one through the plugin's endpoint.
      allowUserToCreateOrganization: false,
      creatorRole: 'owner',
      // Roles left at the plugin's defaults (owner/admin/member) — all three exist in our
      // `role_name` enum. The wider 17-value department matrix is granted by module X.3
      // writing `roles` rows directly, not through the auth layer.
    }),
  ],

  databaseHooks: {
    user: {
      create: {
        /**
         * Signup creates the factory. An ERP user with no company has nothing to look at,
         * and every service call downstream requires `ctx.companyId` — so the company and
         * the owner role are created here rather than in a separate onboarding step that
         * could be abandoned half-way.
         */
        after: async (user, context) => {
          const companyName = deriveCompanyName(user, context?.body)

          // Creating the first row of a tenant looks like it must bypass RLS — the row
          // cannot satisfy `id = app.current_company_id()` before it exists. It does not:
          // generate the id first, scope the transaction to it, then insert. The policies
          // pass unmodified and signup needs no privilege the app does not already have.
          const companyId = randomUUID()
          const ctx = { companyId, userId: user.id, roles: ['owner'] as const }

          // Slug collisions are resolved by retrying the insert, not by checking first.
          // A pre-check could not work anyway: reading `companies` outside a tenant scope
          // returns zero rows under RLS, so every slug would look free. Retrying on the
          // unique violation is also the only version that survives two signups racing
          // with the same factory name.
          for (let attempt = 0; ; attempt += 1) {
            try {
              await withTenantTx(ctx, async (tx) => {
                await tx.insert(schema.companies).values({
                  id: companyId,
                  name: companyName,
                  slug: slugCandidate(companyName, attempt),
                })
                await tx.insert(schema.roles).values({ companyId, userId: user.id, role: 'owner' })
                await tx
                  .insert(schema.profiles)
                  .values({ userId: user.id, fullName: user.name, defaultCompanyId: companyId })
                  .onConflictDoNothing()
              })

              // Starting reference data: TNA calendars, the loss taxonomy, the defect
              // taxonomy. AFTER the company commits and deliberately outside its
              // transaction — these are convenience defaults, and failing signup because a
              // default calendar could not be written would leave somebody unable to get in
              // AND unable to retry, since their email and slug are now taken.
              //
              // `provisionCompany` swallows its own step failures and reports them, so this
              // await cannot throw for a seeding problem. It is still guarded, because a
              // signup that dies here would be the worst possible place to discover an
              // unexpected error.
              try {
                const provisioned = await provisionCompany(ctx)
                if (!provisioned.complete) {
                  const failed = provisioned.steps.filter((step) => !step.ok)
                  console.error(
                    `[auth] company ${companyId} provisioned with gaps:`,
                    failed.map((step) => `${step.step}: ${step.error}`).join('; '),
                  )
                }
              } catch (error) {
                console.error(`[auth] company ${companyId} provisioning failed:`, error)
              }

              return
            } catch (error) {
              if (attempt < 5 && isSlugConflict(error)) continue
              throw error
            }
          }
        },
      },
    },
    session: {
      create: {
        /**
         * Bind the session to a company at creation. Doing it here rather than making the
         * client call `setActive` means there is no window in which an authenticated
         * session exists with no tenant scope — `ctx` is either complete or absent.
         */
        before: async (session) => {
          // Cannot be a plain `roles` query: there is no tenant scope yet, so RLS would
          // (correctly) return nothing. Goes through the one SECURITY DEFINER function.
          const memberships = await membershipsForUser(session.userId)
          return {
            data: { ...session, activeOrganizationId: memberships[0]?.companyId ?? null },
          }
        },
      },
    },
  },
})

export type Auth = typeof auth

/**
 * Signup collects a factory name; fall back to the person's name so the account is never
 * created without a company. Renaming later is a Settings (X.3) concern.
 *
 * `companyName` is read off the request body rather than the user row on purpose: it
 * belongs to the company, not the person, so persisting it on `users` would leave two
 * places claiming to hold the factory's name and no rule about which one wins.
 */
function deriveCompanyName(
  user: { name?: string | null; email: string },
  body?: unknown,
): string {
  const raw = (body as { companyName?: unknown } | undefined)?.companyName
  const submitted = typeof raw === 'string' ? raw.trim() : ''
  if (submitted) return submitted

  const name = user.name?.trim()
  if (name) return name
  return user.email.split('@')[0] ?? 'New factory'
}

/** `companies.slug` is unique; later attempts get a suffix, the last a random one. */
function slugCandidate(name: string, attempt: number): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'factory'

  if (attempt === 0) return base
  if (attempt < 5) return `${base}-${attempt + 1}`
  return `${base}-${randomUUID().slice(0, 8)}`
}

/** Postgres unique_violation on the slug index — anything else must not be swallowed. */
function isSlugConflict(error: unknown): boolean {
  const pg = error as { code?: string; constraint_name?: string }
  return pg?.code === '23505' && String(pg.constraint_name ?? '').includes('slug')
}
