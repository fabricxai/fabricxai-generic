/**
 * The nav is the access policy, so nothing may contradict it.
 *
 * Hiding a link is not access control. Eighteen of the twenty-three destinations rendered
 * in full for any signed-in role that typed the address — a storekeeper could read the LC
 * register, every credit and the factory's open exposure, by knowing the word "lcs". Five
 * pages called `canSee` themselves and the rest never had it added, which is what happens
 * to a check that has to be remembered once per screen.
 *
 * It is enforced in `src/app/(app)/layout.tsx` now, in one place, from the same `NAV` the
 * sidebar is built from. These vectors are what keep those two the same thing.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import type { Role } from '@/modules/core/ctx'
import {
  canSee,
  canWrite,
  describeRoles,
  lockedSubject,
  navItemFor,
  NAV,
  resolveAccess,
  ROLE_LABEL,
  visibleNav,
} from '@/components/shell/nav'

const ALL_ROLES = Object.keys(ROLE_LABEL) as Role[]

const APP_GROUP = 'src/app/(app)'

/**
 * Every route the authenticated shell renders, as a URL.
 *
 * Read off the filesystem rather than listed here, because a list would have to be kept in
 * step by the same person who forgot the nav entry.
 */
function appRoutes(dir = APP_GROUP, prefix = ''): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      // Parenthesised directories are route groups and contribute no URL segment.
      const segment = entry.name.startsWith('(') ? '' : `/${entry.name}`
      found.push(...appRoutes(join(dir, entry.name), prefix + segment))
    } else if (entry.name === 'page.tsx') {
      found.push(prefix || '/')
    }
  }
  return found
}

/** `/lcs/[lcId]` is not a URL anybody visits; `/lcs/9f3c` is. */
const withSampleParams = (route: string) => route.replace(/\[[^\]]+\]/g, '9f3c')

describe('the shell enforces the nav', () => {
  it('checks the route in the layout, not in each page', () => {
    /*
     * Asserted against the source because the alternative is asserting it twenty-three
     * times and trusting whoever adds the twenty-fourth. If this moves, it must stay one
     * place that reads the pathname and consults the same registry.
     */
    const layout = readFileSync(`${APP_GROUP}/layout.tsx`, 'utf8')

    expect(layout).toContain('x-pathname')
    expect(layout).toContain('resolveAccess')
    expect(layout).toContain('LockedState')
  })

  it('registers every screen it renders, so none is governed by nothing', () => {
    /*
     * The sweep that makes failing closed safe. `/factory` shipped reachable by URL and
     * absent from NAV, so `navItemFor` returned undefined and the layout — which then
     * treated "no entry" as "no restriction" — showed the factory's identity, licences and
     * configuration to every signed-in role. The gate is closed now; this keeps the other
     * half of the bargain by making a missing entry a red build rather than a locked screen
     * somebody finds in production.
     */
    const unregistered = appRoutes()
      .map(withSampleParams)
      .filter((route) => !navItemFor(route))

    expect(unregistered).toEqual([])
  })

  it('has a proxy supplying the pathname the layout reads', () => {
    // Without it `x-pathname` is always absent, every route resolves to no nav item, and
    // the check silently permits everything — passing tests and an open door.
    const proxy = readFileSync('src/proxy.ts', 'utf8')

    expect(proxy).toContain('x-pathname')
    expect(proxy).toMatch(/export function proxy/)
  })
})

describe('canSee', () => {
  it('lets owner and admin everywhere', () => {
    for (const item of NAV) {
      expect(canSee(item, ['owner'], 'woven'), item.id).toBe(true)
      expect(canSee(item, ['admin'], 'woven'), item.id).toBe(true)
    }
  })

  it('refuses a role its entry does not list', () => {
    const lcs = NAV.find((i) => i.href === '/lcs')!
    // The case that was open: a storekeeper reading the factory's credit exposure.
    expect(lcs.roles).not.toContain('store')
    expect(canSee(lcs, ['store'], 'woven')).toBe(false)
  })

  it('governs nested routes through their module', () => {
    // `/lcs/{id}` was reachable even where `/lcs` was not, because per-page checks would
    // each have had to repeat themselves onto every dynamic segment.
    expect(navItemFor('/lcs/9f3c')?.href).toBe('/lcs')
    expect(navItemFor('/orders/PO-88203')?.href).toBe('/orders')
    expect(navItemFor('/costing/bom/abc')?.href).toBe('/costing')
  })

  it('governs a screen that is deliberately not in the sidebar', () => {
    // `/factory` opens from the top-bar chip. Not being in the list must not mean not being
    // governed — that gap is exactly how it was readable by every role.
    const factory = NAV.find((i) => i.href === '/factory')!

    expect(factory.hiddenFromSidebar).toBe(true)
    expect(visibleNav(['owner'], 'woven').map((i) => i.href)).not.toContain('/factory')
    expect(navItemFor('/factory')?.id).toBe('factory')
  })

  it('never shows a role a screen it cannot open', () => {
    for (const role of ALL_ROLES) {
      for (const item of visibleNav([role], 'woven')) {
        expect(canSee(item, [role], 'woven'), `${role} → ${item.id}`).toBe(true)
      }
    }
  })
})

describe('canWrite', () => {
  it('has no default left to lean on — every screen declares its writers (plan 5.6)', () => {
    /*
     * This case used to assert the opposite, and asserting it is what kept it alive:
     * `writeRoles` was optional and `canWrite` returned TRUE when it was absent, so
     * twenty-two of twenty-five screens claimed a write surface by saying nothing. A
     * viewer on the order desk was told they could change the book, and the read-only
     * banner never appeared on a screen that had no writes at all.
     *
     * The field is required now. An empty list is a statement — the dashboard, the
     * refused-writes record, MARBIM — and no list is a compile error.
     */
    const undeclared = NAV.filter((item) => item.writeRoles === undefined).map((i) => i.id)
    expect(undeclared, `these say nothing about who may write: ${undeclared.join(', ')}`).toEqual([])
  })

  it('lets the storekeeper write on the store screen and nobody else who can see it', () => {
    const store = NAV.find((i) => i.href === '/store')!

    expect(canWrite(store, ['store'], 'woven')).toBe(true)
    // Procurement and production read the shelf; the floor's writes go through the offline
    // endpoint, and both its handlers gate on `store`.
    expect(canSee(store, ['procurement'], 'woven')).toBe(true)
    expect(canWrite(store, ['procurement'], 'woven')).toBe(false)
  })

  it('never lets a role write on a screen it cannot even see', () => {
    // The trap `canWrite` re-checks visibility for. Asserted across the whole registry
    // rather than one entry, because the next entry added is the one that gets it wrong.
    for (const item of NAV) {
      for (const role of item.writeRoles) {
        expect(
          canSee(item, [role], 'woven') || canSee(item, [role], 'knit'),
          `${item.id} lets ${role} write a screen it cannot open`,
        ).toBe(true)
      }
    }
  })

  it('marks a viewer read-only on the order book', () => {
    const orders = NAV.find((i) => i.href === '/orders')!
    expect(canSee(orders, ['viewer'], 'woven')).toBe(true)
    expect(canWrite(orders, ['viewer'], 'woven')).toBe(false)
  })

  it('lets everyone read settings and nobody but owner or admin change them', () => {
    const settings = NAV.find((i) => i.href === '/settings')!
    expect(canSee(settings, ['store'], 'woven')).toBe(true)
    expect(canWrite(settings, ['store'], 'woven')).toBe(false)
    expect(canWrite(settings, ['owner'], 'woven')).toBe(true)
  })

  it('never marks a role read-only on a screen it cannot see', () => {
    // A "read only" banner on a locked screen would be two contradictory statements about
    // the same permission.
    for (const role of ALL_ROLES) {
      for (const item of NAV) {
        if (canSee(item, [role], 'woven')) continue
        expect(canWrite(item, [role], 'woven'), `${role} → ${item.id}`).toBe(false)
      }
    }
  })
})

describe('resolveAccess — the decision the shell applies', () => {
  it('refuses a path with no entry instead of waving it through', () => {
    const unknown = resolveAccess('/not-a-module', ['owner'], 'woven')

    // Owner, the role that can see everything there is, still cannot open a screen the
    // registry says nothing about. "Unregistered" is not a permission level.
    expect(unknown.item).toBeUndefined()
    expect(unknown.allowed).toBe(false)
    expect(unknown.subject.trim()).toBeTruthy()
  })

  it('refuses when the pathname header is missing', () => {
    // If the proxy ever stops stamping `x-pathname` the layout resolves '' for every route.
    // That used to permit everything silently; now it locks everything loudly, which is the
    // failure somebody notices in the first minute rather than never.
    expect(resolveAccess('', ['owner'], 'woven').allowed).toBe(false)
  })

  it('opens a registered screen for a role its entry lists, nested routes included', () => {
    expect(resolveAccess('/lcs', ['commercial'], 'woven').allowed).toBe(true)
    expect(resolveAccess('/lcs/9f3c', ['commercial'], 'woven').allowed).toBe(true)
    expect(resolveAccess('/lcs/9f3c', ['store'], 'woven').allowed).toBe(false)
  })

  it('names the module it refused, so the card is not a shrug', () => {
    expect(resolveAccess('/ud', ['cutting'], 'woven').subject).toBe('the UD workbench')
  })

  it('marks read-only without contradicting itself', () => {
    // Allowed and read-only for a viewer on the order book; never read-only where refused.
    expect(resolveAccess('/orders', ['viewer'], 'woven')).toMatchObject({
      allowed: true,
      readOnly: true,
    })
    expect(resolveAccess('/workforce', ['store'], 'woven')).toMatchObject({
      allowed: false,
      readOnly: false,
    })
  })

  it('agrees with canSee on every route and role', () => {
    // The layout no longer calls canSee itself, so this is what keeps the extracted
    // decision and the registry from drifting apart.
    for (const role of ALL_ROLES) {
      for (const item of NAV) {
        expect(resolveAccess(item.href, [role], 'woven').allowed, `${role} → ${item.id}`).toBe(
          canSee(item, [role], 'woven'),
        )
      }
    }
  })
})

describe('the locked card names its module', () => {
  it('reads as English for the modules with a phrase', () => {
    // `role-gates.integration.test.ts` asserts the exact sentence, and a card saying only
    // "no access" leaves somebody unsure which of the things they tried was refused.
    const subject = (href: string) => lockedSubject(NAV.find((i) => i.href === href)!)

    expect(subject('/dashboard')).toBe('the owner dashboard')
    expect(subject('/ud')).toBe('the UD workbench')
    expect(subject('/workforce')).toBe('workforce')
  })

  it('falls back to the label for the rest', () => {
    expect(lockedSubject(NAV.find((i) => i.href === '/compliance')!)).toBe('compliance')
  })

  it('never produces an empty subject', () => {
    // An empty one renders "You don't have access to ." — punctuation where the answer
    // should be.
    for (const item of NAV) {
      expect(lockedSubject(item).trim(), item.id).toBeTruthy()
    }
  })
})

describe('roles are named', () => {
  it('labels every role in the enum', () => {
    // A role with no label renders as nothing in the account menu, which is worse than the
    // raw value — the person is told they have no role rather than an unfamiliar word.
    for (const role of ALL_ROLES) {
      expect(ROLE_LABEL[role]?.trim(), role).toBeTruthy()
    }
  })

  it('reads as a phrase when somebody holds several', () => {
    expect(describeRoles(['store'])).toBe('Storekeeper')
    expect(describeRoles(['store', 'quality'])).toBe('Storekeeper and Quality')
    expect(describeRoles(['owner', 'hr', 'finance'])).toBe('Owner, HR and Finance')
    expect(describeRoles([])).toBe('No role')
  })
})

/**
 * The read-only banner, and the screens it must stay off.
 *
 * It says "YOUR ROLE can read this but not change it. Ask an owner or admin if you need to."
 * — a statement about the caller, true only when somebody else could write here.
 *
 * Five screens have no write surface at all (`writeRoles: []`): MARBIM, the owner dashboard,
 * refused writes, the factory tree, settings. On those, nobody can write, so the banner told
 * every merchandiser and planner their role was deficient and sent them to ask an owner for
 * a permission that does not exist. On MARBIM it contradicted the composer directly beneath
 * it, which says "proposes drafts · never writes" — the screen made two claims at once and
 * the wrong one was on top. Owners and admins never saw it, because ALL_ACCESS
 * short-circuits `canWrite`, which is how it survived to a live test.
 */
describe('the read-only banner distinguishes "you may not" from "nobody does"', () => {
  it('stays off MARBIM for every role, including the ones that draft through it', () => {
    for (const roles of [['owner'], ['admin'], ['merchandiser'], ['commercial'], ['viewer']] as const) {
      expect(
        resolveAccess('/marbim', roles as never, 'knit-composite').readOnly,
        `${roles[0]} should not be told their role cannot change MARBIM`,
      ).toBe(false)
    }
  })

  it('stays off every other screen with no write surface', () => {
    for (const href of ['/dashboard', '/refused', '/factory']) {
      const seen = resolveAccess(href, ['owner'], 'knit-composite')
      if (!seen.allowed) continue
      expect(resolveAccess(href, ['merchandiser'], 'knit-composite').readOnly, href).toBe(false)
    }
  })

  it('STILL fires where a role genuinely lacks a write others have', () => {
    // The regression that would make this change a silent removal of a real signal. Orders
    // is writable by merchandisers and not by viewers, so the banner is exactly right there.
    expect(resolveAccess('/orders', ['viewer'], 'knit-composite').readOnly).toBe(true)
    expect(resolveAccess('/orders', ['production'], 'knit-composite').readOnly).toBe(true)
    expect(resolveAccess('/orders', ['merchandiser'], 'knit-composite').readOnly).toBe(false)
  })

  it('never claims read-only on a screen the caller cannot open at all', () => {
    // Two contradictory statements about one permission. `allowed` false must win.
    const hidden = resolveAccess('/hr/payroll', ['viewer'], 'knit-composite')
    expect(hidden.allowed).toBe(false)
    expect(hidden.readOnly).toBe(false)
  })
})

describe('rail trimming never touches access (plan 2.5)', () => {
  const trimmed = NAV.filter((item) => item.railHiddenFor?.length)

  it('exists for the production rail', () => {
    // Six doors off the daily scan. The list shrinking to zero would mean the mechanism
    // lost its only user and should go; growing is fine.
    expect(trimmed.map((item) => item.id).sort()).toEqual([
      'orders', 'planning', 'quality', 'sampling', 'setup', 'store',
    ])
  })

  it('hides the entry from the rail and nothing else', () => {
    for (const item of trimmed) {
      for (const role of item.railHiddenFor!) {
        // The trim is presentation: the same role that cannot SEE the entry can still
        // OPEN the route, or the trim would be an access change wearing a layout hat.
        expect(canSee(item, [role], 'knit-composite'), `${item.id} access for ${role}`).toBe(true)
        const rail = visibleNav([role], 'knit-composite')
        expect(rail.some((entry) => entry.id === item.id), `${item.id} on ${role}'s rail`).toBe(false)
      }
    }
  })

  it('an owner covering the desk still sees everything', () => {
    const rail = visibleNav(['owner'], 'knit-composite')
    for (const item of trimmed) {
      expect(rail.some((entry) => entry.id === item.id), `${item.id} on the owner's rail`).toBe(true)
    }
  })

  it('a person holding a second role keeps the union of their rails', () => {
    // Hidden only when EVERY role agrees: a production supervisor who is also the planner
    // must not lose the planning board to the trim.
    const rail = visibleNav(['production', 'planner'], 'knit-composite')
    expect(rail.some((entry) => entry.id === 'planning')).toBe(true)
  })
})
