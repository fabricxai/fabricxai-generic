/**
 * Session → `ctx` (dev-plan §2.2.1, PLAYBOOK §1 session 2).
 *
 * This is where authentication becomes tenancy. Every action and route handler starts
 * here, and nothing below it ever reads the session again — a service must be callable
 * from a BullMQ job, where there is no session at all.
 *
 * `companyId` comes from `session.activeOrganizationId` and roles are read from the
 * database on each request. Neither is ever taken from the client: a request that could
 * name its own company or its own role is not multi-tenant, it is multi-tenant-shaped.
 */
/**
 * Registration, in the graph that actually serves requests.
 *
 * `instrumentation.ts` already imports the registry, and that is NOT enough: Next bundles
 * the instrumentation hook separately from app-router code, so the module singletons it
 * populates are a different set of objects from the ones a server action reads. The result
 * was every registry-dependent path failing at runtime while booting cleanly — approve
 * returning `errors.unknown_module` for a target that IS registered, and MARBIM refusing
 * with "no provider is registered" while `MARBIM_MOCK=true`. Exactly the three failures
 * `modules/registry.ts` was written to prevent, from the one direction it did not cover.
 * `app/api/sync/route.ts` had already hit this and imported the registry itself.
 *
 * Here rather than in each `actions.ts`: every server entry point in the app authenticates
 * through this file, so registration cannot be forgotten by a module added later. The
 * registry graph does not import this file, so there is no cycle.
 */
import '@/modules/registry'

import { and, eq, isNull } from 'drizzle-orm'

import { roles as rolesTable } from '@/db/schema/core'
import { auth } from '@/lib/auth'

import type { RequestCtx, Role, SystemCtx } from './ctx'
import { AppError, forbidden } from './errors'
import { withTenantRead } from './tenancy'

/**
 * Build a ctx from request headers, or return null when unauthenticated.
 * Returns null rather than throwing so callers can distinguish "no session" (401) from
 * "session but wrong role" (403) without exception juggling.
 */
export async function getCtx(headers: Headers): Promise<RequestCtx | null> {
  const result = await auth.api.getSession({ headers })
  if (!result?.session || !result.user) return null

  const companyId = result.session.activeOrganizationId
  // Authenticated but with no company bound. Every downstream service requires a scope,
  // so this is treated as no context at all rather than a half-usable one.
  if (!companyId) return null

  // Scoped: the session already names the company, so this is an ordinary tenant read
  // and RLS confirms the membership belongs to that company. Only the pre-session
  // lookup in `membershipsForUser` needs the SECURITY DEFINER path.
  const memberships = await withTenantRead({ companyId, userId: result.user.id, roles: [] }, (tx) =>
    tx
      .select({ role: rolesTable.role, scope: rolesTable.scope })
      .from(rolesTable)
      .where(
        and(
          eq(rolesTable.companyId, companyId),
          eq(rolesTable.userId, result.user.id),
          isNull(rolesTable.revokedAt),
        ),
      ),
  )

  // A session pointing at a company the user has been removed from. Revocation has to
  // take effect on the next request, not on the next login.
  if (memberships.length === 0) return null

  /*
   * Line narrowing, honoured at last. Each role may carry {"lines": [...]} — the union
   * across scoped roles is what the caller may see, and ONE unscoped role widens them to
   * the whole floor (an admin who also supervises a line is not narrowed by the narrower
   * grant). Stored since the schema shipped; read by nothing until a live line chief
   * scoped to L1/L2 saw all eight lines.
   */
  let lineScope: string[] | undefined = []
  for (const m of memberships) {
    const scopedLines = (m.scope as { lines?: unknown }).lines
    if (
      Array.isArray(scopedLines) &&
      scopedLines.length > 0 &&
      scopedLines.every((code) => typeof code === 'string')
    ) {
      lineScope = [...new Set([...(lineScope ?? []), ...(scopedLines as string[])])]
    } else {
      lineScope = undefined
      break
    }
  }

  return {
    companyId,
    userId: result.user.id,
    roles: memberships.map((m) => m.role),
    ...(lineScope !== undefined ? { lineScope } : {}),
    requestId: headers.get('x-request-id') ?? undefined,
    ipAddress: headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? undefined,
    userAgent: headers.get('user-agent') ?? undefined,
    locale: headers.get('accept-language')?.split(',')[0]?.trim() ?? undefined,
  }
}

/** Same, but throws the typed 401 an action boundary should return. */
export async function requireCtx(headers: Headers): Promise<RequestCtx> {
  const ctx = await getCtx(headers)
  if (!ctx) throw new AppError('unauthenticated', 'errors.unauthenticated')
  return ctx
}

/**
 * Roles that may perform any action — supervision, not a department.
 *
 * The same pair `offline-sync.ts` grants on every floor handler, for the same reason: an
 * owner covering a shift must not be locked out of the operation they are covering.
 */
const SUPERVISORY_ROLES: readonly Role[] = ['owner', 'admin']

/**
 * Role gate for the action boundary. **Every `'use server'` export goes through this.**
 *
 * It existed before this and had zero callers (audit N1). All sixteen `actions.ts` files
 * authenticated with `requireCtx` and stopped there, so any authenticated member of the
 * company could record the buyer verdict that opens the PP gate for cutting, issue a
 * purchase order, open a BTB credit, confirm ex-factory, or open an LC bank submission.
 * `/api/sync` had already been hardened to require roles per handler (BE-H4); this is the
 * second and much larger door into the same services.
 *
 * The shell's `canSee`/`canWrite` is not this check and cannot be: it decides what to
 * render, and a Server Action is a POST addressed by action id that renders nothing. By
 * the time a layout computes `readOnly`, the write has already committed.
 *
 * Owner and admin are added to every call. Passing no roles at all is a programming error
 * rather than "everyone" — an action open to the whole company must say so by listing the
 * roles, exactly as a sync handler does.
 *
 * Payroll (🔒) is stricter than anything expressible here — `hr` and `owner` only, admin
 * included in the refusal — and returns a bodyless 403. That stays in module 10.1, because
 * the shape of that refusal is part of its contract.
 */
export async function requireRole(
  headers: Headers,
  ...allowed: readonly Role[]
): Promise<RequestCtx> {
  if (allowed.length === 0) {
    throw new Error('requireRole called with no roles — every door needs a keyholder')
  }

  const ctx = await requireCtx(headers)
  if (![...allowed, ...SUPERVISORY_ROLES].some((role) => ctx.roles.includes(role))) {
    throw forbidden('errors.forbidden', { required: allowed })
  }
  return ctx
}

/**
 * Context for work with no human caller: outbox relay, scheduled derivations, seeds.
 * Still company-scoped — a job runs inside exactly one tenant at a time, so RLS binds it
 * the same way it binds a request.
 */
export function systemCtx(companyId: string, jobId?: string): SystemCtx {
  return { companyId, userId: null, roles: ['owner'], system: true, jobId }
}

/**
 * Who is signed in, for the shell to say so out loud.
 *
 * Deliberately NOT on `RequestCtx`. A service has no business with a display name — it
 * needs a company, a user id and roles, and adding a name would mean every BullMQ job had
 * to invent one. This is a separate read for the one caller that renders a person.
 *
 * The shell had no way to answer "who am I". Its avatar showed `userId.slice(0, 2)`, so
 * every seeded account rendered the same two letters and identified nobody — on a shared
 * store or cutting terminal, which is how a floor actually works, you could not tell whose
 * session you were about to approve something in.
 */
export interface SignedInUser {
  userId: string
  name: string | null
  email: string
  roles: readonly Role[]
}

export async function signedInUser(headers: Headers): Promise<SignedInUser | null> {
  const result = await auth.api.getSession({ headers })
  if (!result?.session || !result.user) return null

  const ctx = await getCtx(headers)
  if (!ctx) return null

  return {
    userId: result.user.id,
    // Better Auth allows a nameless account. The shell falls back to the email rather than
    // inventing initials from an id, which is what produced "SE" for everybody.
    name: result.user.name?.trim() || null,
    email: result.user.email,
    roles: ctx.roles,
  }
}
