import type { Role } from '@/modules/core/ctx'

/**
 * The navigation registry — one entry per designed screen.
 *
 * This is where two access rules from the screens brief live:
 *
 *  - Roles. A role with no access gets the module HIDDEN (absent from nav),
 *    not a disabled link. A link you can see and cannot use still tells you
 *    the module exists and roughly what it holds.
 *  - Factory type. `[WOVEN]` screens appear only for woven units and
 *    `[KNIT-COMPOSITE]` only for composite units; everything else is shared.
 *
 * The third pattern — redaction — is per-field and lives in the screens.
 */

export type FactoryType = 'woven' | 'knit' | 'knit-composite'

export interface NavItem {
  id: string
  label: string
  href: string
  /** Roles that may see this module at all. Owner and admin always may. */
  roles: readonly Role[]
  /**
   * Roles that may CHANGE anything here. Absent means everyone who can see it can.
   *
   * The gap this closes: a role could open a screen and only discover it could not act by
   * pressing a button and reading a refusal. Declaring it here lets the shell say so before
   * anybody types anything — and keeps the answer next to the visibility rule it belongs
   * with, rather than in twenty-three screens.
   *
   * This is a LABEL, not the enforcement. Every write still goes through an action that
   * checks for itself; a read-only banner nobody honours would be worse than none.
   *
   * **Required, since plan 5.6.** It used to be optional and `canWrite` defaulted to TRUE
   * when it was absent, which meant twenty-two of twenty-five screens claimed a write
   * surface by saying nothing — including four that had none at all. A viewer on the order
   * desk was told they could change the book. Declaring it is the only way to be sure
   * somebody looked: an empty list is a statement, and no list was a shrug.
   */
  writeRoles: readonly Role[]
  /**
   * How the locked card names this module — "you don't have access to {lockedAs}".
   *
   * Separate from `label` because a sidebar entry and a sentence want different words:
   * "Owner dashboard" reads as a heading, "the owner dashboard" reads as English. Absent
   * means the label, lowercased, which is right for most of them.
   *
   * It matters that the refusal names the specific module rather than something generic —
   * `role-gates.integration.test.ts` asserts exactly that, because a card saying only
   * "no access" leaves somebody unsure which of the things they tried was refused.
   */
  lockedAs?: string
  /** Restrict to particular factory types. Absent means shared. */
  factoryTypes?: readonly FactoryType[]
  /**
   * This screen only exists when the copilot does (plan 6.1).
   *
   * `MARBIM_ENABLED` is a server flag and this file is imported by client components, so
   * the answer is passed IN — the same shape `factoryType` already uses. Marked as data
   * here so the set is one list rather than a condition repeated in a layout, three pages
   * and a scheduler.
   */
  requiresMarbim?: boolean
  /**
   * Governed here, but not listed in the sidebar.
   *
   * For screens reached from dedicated chrome rather than the nav — `/factory` opens from
   * the top-bar chip. Without this they had to be left out of the registry altogether, and
   * a route outside the registry is a route with no access policy at all. It stays
   * findable (search reads `NAV` directly) and stays refusable; it just isn't in the list.
   */
  hiddenFromSidebar?: boolean
  section: NavSection
}

export type NavSection = 'work' | 'commercial' | 'floor' | 'oversight' | 'system'

/**
 * Where the chrome's words live (plan 4.2).
 *
 * The labels below stayed English literals long after twelve floor routes read Bangla, so a
 * Bangla-only worker could read their screen and not the link to it. The copy now comes from
 * `ui.nav.*` / `ui.role.*` in `lib/i18n-ui`, keyed on the NAV entry's own id.
 *
 * The English is still HERE as well, and deliberately: it is what `access.test.ts` asserts
 * against, what a non-localised caller falls back to, and — through `nav-copy.test.ts` —
 * what the catalogue's English is checked to agree with. Two copies that must match, with a
 * test that fails when they stop, beats one copy that a screen renders as `ui.nav.orders`
 * the day somebody mistypes an id.
 */
export const navLabelKey = (id: string): string => `ui.nav.${id}`
export const navLockedKey = (id: string): string => `ui.nav.locked_${id}`
export const navSectionKey = (id: NavSection): string => `ui.nav.section_${id}`
export const roleLabelKey = (role: Role): string => `ui.role.${role}`

/** Just enough of a translator for this file to stay free of React and of `next/headers`. */
export type Words = (key: string, params?: Readonly<Record<string, unknown>>) => string

/**
 * What each role is called, in the words the factory uses.
 *
 * The app knew everybody's role and never said it. A storekeeper could tell they were a
 * storekeeper only by noticing their nav was short — which does not distinguish "this is
 * not yours" from "this does not exist", and tells them nothing about what they may change
 * on a screen they CAN open.
 */
export const ROLE_LABEL: Readonly<Record<Role, string>> = {
  owner: 'Owner',
  admin: 'Admin',
  merchandiser: 'Merchandiser',
  commercial: 'Commercial',
  planner: 'Planner',
  store: 'Storekeeper',
  procurement: 'Procurement',
  cutting: 'Cutting',
  production: 'Production',
  quality: 'Quality',
  shipment: 'Shipment',
  maintenance: 'Maintenance',
  hr: 'HR',
  compliance: 'Compliance',
  finance: 'Finance',
  member: 'Member',
  viewer: 'Viewer',
}

/**
 * The roles a person holds, as one readable phrase, in the reader's language.
 *
 * The conjunction is copy, not punctuation — Bangla joins with ও, not with "and" — so the
 * last join comes from the catalogue rather than from a template literal here.
 */
export function describeRoles(roles: readonly Role[], words?: Words): string {
  const say: Words = words ?? englishFallback
  const named = roles.map((role) => say(roleLabelKey(role))).filter(Boolean)

  if (named.length === 0) return say('ui.nav.no_role')
  if (named.length === 1) return named[0]!
  return say('ui.nav.roles_and', {
    list: named.slice(0, -1).join(', '),
    last: named[named.length - 1]!,
  })
}

/**
 * What `describeRoles` says with no translator.
 *
 * Only reached by callers outside a request — a job, a test, a script. Kept minimal on
 * purpose: this is a fallback, not a second catalogue, and anything rendered to a person
 * goes through the real one.
 */
const ENGLISH_FALLBACK: Readonly<Record<string, string>> = {
  'ui.nav.no_role': 'No role',
  'ui.nav.roles_and': '{list} and {last}',
  ...Object.fromEntries(
    Object.entries(ROLE_LABEL).map(([role, label]) => [roleLabelKey(role as Role), label]),
  ),
}

const englishFallback: Words = (key, params = {}) =>
  Object.entries(params).reduce<string>(
    (text, [name, value]) => text.replaceAll(`{${name}}`, String(value)),
    ENGLISH_FALLBACK[key] ?? key,
  )

export const NAV_SECTIONS: readonly { id: NavSection; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'commercial', label: 'Commercial' },
  { id: 'floor', label: 'Floor' },
  { id: 'oversight', label: 'Oversight' },
  { id: 'system', label: 'System' },
]

/** Roles that see everything. Kept separate so each entry lists only its own. */
const ALL_ACCESS: readonly Role[] = ['owner', 'admin']

export const NAV: readonly NavItem[] = [
  // ── Work ────────────────────────────────────────────────
  {
    id: 'approve',
    label: 'Approve inbox',
    href: '/approve',
    section: 'work',
    // Everyone who can approve anything lands here; the inbox itself filters
    // to what this role may actually decide.
    roles: ['merchandiser', 'commercial', 'planner', 'store', 'procurement', 'production', 'quality', 'compliance', 'finance', 'hr'],
    // Approving IS the write, and the per-draft rule narrows it further (`requiredRoles`).
    // This list only says the screen has a write surface at all.
    writeRoles: ['merchandiser', 'commercial', 'planner', 'store', 'procurement', 'production', 'quality', 'compliance', 'finance', 'hr'],
  },
  {
    id: 'marbim',
    label: 'MARBIM',
    href: '/marbim',
    section: 'work',
    requiresMarbim: true,
    roles: ['merchandiser', 'commercial', 'planner', 'store', 'procurement', 'cutting', 'production', 'quality', 'shipment', 'maintenance', 'hr', 'compliance', 'finance', 'member', 'viewer'],
    // MARBIM writes nothing itself — everything it produces is a draft in somebody's
    // approve inbox, so asking it a question is a read however it is phrased.
    writeRoles: [],
  },
  {
    id: 'orders',
    label: 'Order desk & TNA',
    href: '/orders',
    section: 'work',
    roles: ['merchandiser', 'commercial', 'planner', 'production', 'viewer'],
    // A viewer is on the order book to read it. Production is here for dates and the
    // breakdown, not to change what the buyer ordered.
    writeRoles: ['merchandiser', 'commercial', 'planner'],
  },
  {
    id: 'memory',
    label: 'Order memory',
    href: '/memory',
    section: 'work',
    // 1.6 is built ON the copilot: its similarity search, its embeddings and its
    // close-out extraction all need a provider. With MARBIM off the screen would render
    // the parts that are plain SQL and silently lack the rest.
    requiresMarbim: true,
    roles: ['merchandiser', 'commercial', 'planner'],
    // `saveCloseOutNote` — the one write. `findSimilarStyles` is a read with no entry
    // point yet (plan 5.5).
    writeRoles: ['merchandiser', 'commercial', 'planner'],
  },
  {
    id: 'sampling',
    label: 'Sampling room',
    href: '/sampling',
    section: 'work',
    roles: ['merchandiser', 'quality', 'production'],
    // Quality and production read the sample board; the room itself is merchandising's.
    // Every sampling action and both sync handlers gate on this one role.
    writeRoles: ['merchandiser'],
  },

  // ── Commercial ──────────────────────────────────────────
  {
    id: 'buyers',
    label: 'Buyer & lead desk',
    href: '/buyers',
    section: 'commercial',
    roles: ['merchandiser', 'commercial'],
    writeRoles: ['merchandiser', 'commercial'],
  },
  {
    id: 'rfq',
    label: 'RFQ & quotation',
    href: '/rfq',
    section: 'commercial',
    roles: ['merchandiser', 'commercial'],
    writeRoles: ['merchandiser', 'commercial'],
  },
  {
    id: 'costing',
    label: 'Costing studio',
    href: '/costing',
    section: 'commercial',
    roles: ['merchandiser', 'commercial', 'finance'],
    writeRoles: ['merchandiser', 'commercial', 'finance'],
  },
  {
    id: 'lcs',
    label: 'LC register',
    href: '/lcs',
    section: 'commercial',
    roles: ['commercial', 'finance'],
    // Commercial records the credit and its amendments; finance posts the realization.
    writeRoles: ['commercial', 'finance'],
  },
  {
    id: 'finance',
    label: 'Commercial finance',
    href: '/finance',
    section: 'commercial',
    roles: ['commercial', 'finance'],
    writeRoles: ['commercial', 'finance'],
  },
  {
    id: 'procurement',
    label: 'Procurement',
    href: '/procurement',
    section: 'commercial',
    roles: ['procurement', 'commercial', 'store'],
    // Store records a receipt against a PO; commercial owns the BTB the import PO draws on.
    writeRoles: ['procurement', 'commercial', 'store'],
  },

  // ── Floor ───────────────────────────────────────────────
  {
    id: 'planning',
    label: 'Planning board',
    href: '/planning',
    section: 'floor',
    roles: ['planner', 'production', 'merchandiser'],
    // Production reads the board to know what is coming; it does not decide what goes on it.
    writeRoles: ['planner', 'merchandiser'],
  },
  {
    id: 'store',
    label: 'Store',
    href: '/store',
    section: 'floor',
    roles: ['store', 'procurement', 'production'],
    // The floor writes here through the offline batch endpoint, and both its handlers
    // gate on `store`. Procurement and production read the shelf, they do not move it.
    writeRoles: ['store'],
  },
  {
    id: 'ud',
    lockedAs: 'the UD workbench',
    label: 'UD workbench',
    href: '/ud',
    section: 'floor',
    // Bonded fabric is a concern of any unit that IMPORTS shell fabric: pure woven
    // always, and a knit-composite the moment it runs a woven program — its knit fabric
    // comes off its own machines, but the denim for a jacket order arrives duty-free
    // against a UD exactly as it would at a woven unit. Only a pure knit factory,
    // which buys or knits everything locally, has no declaration to work. (Found live:
    // the knit-composite tenant had bonded denim on order and no UD workbench anywhere.)
    factoryTypes: ['woven', 'knit-composite'],
    roles: ['store', 'commercial', 'compliance'],
    // Store requests an overdraw, commercial records the declaration, compliance runs
    // the reconciliation the customs office asks for.
    writeRoles: ['store', 'commercial', 'compliance'],
  },
  {
    id: 'cutting',
    label: 'Cutting',
    href: '/cutting',
    section: 'floor',
    roles: ['cutting', 'production', 'planner'],
    // Both sync handlers gate on these two. A planner reads the floor's progress.
    writeRoles: ['cutting', 'production'],
  },
  {
    id: 'lines',
    label: 'Line tracking',
    href: '/lines',
    section: 'floor',
    roles: ['production', 'planner', 'quality'],
    // Hourly output and downtime, through the offline endpoint. Quality and planning read.
    writeRoles: ['production'],
  },
  {
    id: 'quality',
    label: 'Quality',
    href: '/quality',
    section: 'floor',
    roles: ['quality', 'production'],
    // Production taps an inline check; the verdicts are quality's.
    writeRoles: ['quality', 'production'],
  },
  {
    id: 'shipment',
    label: 'Shipment',
    href: '/shipment',
    section: 'floor',
    roles: ['shipment', 'commercial', 'merchandiser'],
    writeRoles: ['shipment', 'commercial', 'merchandiser'],
  },
  {
    id: 'maintenance',
    label: 'Maintenance',
    href: '/maintenance',
    section: 'floor',
    roles: ['maintenance', 'production'],
    // Production reports a stopped machine; maintenance closes the ticket.
    writeRoles: ['maintenance', 'production'],
  },

  // ── Oversight ───────────────────────────────────────────
  {
    id: 'dashboard',
    lockedAs: 'the owner dashboard',
    label: 'Owner dashboard',
    href: '/dashboard',
    section: 'oversight',
    // Deliberately narrow. This is the whole-factory view.
    roles: [],
    // Read-only by rule 9 — importing a write op into `modules/analytics` is lint-banned.
    writeRoles: [],
  },
  {
    id: 'workforce',
    lockedAs: 'workforce',
    label: 'Workforce & payroll',
    href: '/workforce',
    section: 'oversight',
    // Payroll is hr+owner at API level; anyone else gets a quiet 403 card.
    roles: ['hr'],
    // 🔒 Payroll. The service gates harder still: hr and owner only, with a bodyless 403.
    writeRoles: ['hr'],
  },
  {
    id: 'compliance',
    label: 'Compliance',
    href: '/compliance',
    section: 'oversight',
    roles: ['compliance'],
    writeRoles: ['compliance'],
  },
  {
    id: 'refused',
    lockedAs: 'the refused-writes report',
    label: 'Refused writes',
    href: '/refused',
    section: 'oversight',
    /*
     * Every floor role, and the people who run the floor.
     *
     * Wider than most entries on purpose. This screen exists because a refused write is
     * somebody's work disappearing, and the person best placed to re-enter a challan is
     * the storekeeper who counted it — not only their manager. Read-only for everyone:
     * there is nothing here to change, which is the honest shape of a record.
     */
    roles: ['store', 'cutting', 'production', 'quality', 'shipment', 'maintenance', 'merchandiser'],
    // A record, not a queue. There is nothing here to change — re-entering refused work
    // happens on the screen that owns it.
    writeRoles: [],
  },

  // ── System ──────────────────────────────────────────────
  {
    id: 'factory',
    lockedAs: 'the factory profile',
    label: 'Factory',
    href: '/factory',
    section: 'system',
    // Opens from the top-bar chip, not the sidebar — but it is still a screen with an
    // audience, so it is registered like any other. Same readership as Settings: everybody
    // may read how their unit is configured. Nothing here is editable by anyone; the page
    // sends you to Settings, which is where the permission actually is.
    hiddenFromSidebar: true,
    roles: ['member', 'viewer', 'merchandiser', 'commercial', 'planner', 'store', 'procurement', 'cutting', 'production', 'quality', 'shipment', 'maintenance', 'hr', 'compliance', 'finance'],
    writeRoles: [],
  },
  {
    id: 'settings',
    label: 'Settings',
    href: '/settings',
    section: 'system',
    roles: ['member', 'viewer', 'merchandiser', 'commercial', 'planner', 'store', 'procurement', 'cutting', 'production', 'quality', 'shipment', 'maintenance', 'hr', 'compliance', 'finance'],
    // Everybody may read how their factory is configured — a policy you cannot see is one
    // you cannot question. Changing one is owner and admin only, which `settings.errors
    // .policy_is_admin_only` already enforces; this is the same rule said before the click.
    writeRoles: [],
  },
]

/**
 * May this role change anything on this screen?
 *
 * Takes `factoryType` and re-checks visibility first, so the answer is true only for a
 * screen the caller can actually open. Without that it returned true for screens a role
 * cannot see at all — harmless where the shell calls it, since it only asks about a screen
 * it has already allowed, and a trap for the next caller who asks it on its own.
 *
 * Owner and admin always may. An EMPTY `writeRoles` is a read-only screen, stated rather
 * than implied — the dashboard, the refused-writes record, MARBIM, and the two System pages
 * where reading the configuration is everybody's and changing it is the owner's.
 */
/**
 * The phrase the locked card uses for a module.
 *
 * With no translator this is the English data on the entry, which is what `access.test.ts`
 * and `role-gates.integration.test.ts` assert — a refusal that names the specific module
 * rather than saying only "no access", so somebody who tried three things knows which one
 * was refused.
 *
 * With one it comes from `ui.nav.locked_<id>`, whose English side says exactly the same
 * words. The two exist because a heading and a sentence want different ones: "Owner
 * dashboard" reads as a heading and "the owner dashboard" reads as English — and Bangla
 * takes no article at all, so its side is the plain name.
 */
export function lockedSubject(item: NavItem, words?: Words): string {
  if (words) return words(navLockedKey(item.id))
  return item.lockedAs ?? item.label.toLowerCase()
}

export function canWrite(
  item: NavItem,
  roles: readonly Role[],
  factoryType: FactoryType,
): boolean {
  if (!canSee(item, roles, factoryType)) return false
  if (roles.some((r) => ALL_ACCESS.includes(r))) return true
  // No `if (!item.writeRoles) return true` any more. That default was the lie: an entry
  // that said nothing was read as "everyone may write here", and twenty-two of them said
  // nothing. The field is required now, so an empty list means what it looks like.
  return roles.some((r) => item.writeRoles.includes(r))
}

export function canSee(item: NavItem, roles: readonly Role[], factoryType: FactoryType): boolean {
  if (item.factoryTypes && !item.factoryTypes.includes(factoryType)) return false
  if (roles.some((r) => ALL_ACCESS.includes(r))) return true
  return roles.some((r) => item.roles.includes(r))
}

export function visibleNav(
  roles: readonly Role[],
  factoryType: FactoryType,
  /** Whether the copilot is configured. Server-side truth, passed in — see `requiresMarbim`. */
  marbimEnabled = true,
): NavItem[] {
  return NAV.filter(
    (item) =>
      !item.hiddenFromSidebar &&
      canSee(item, roles, factoryType) &&
      (marbimEnabled || !item.requiresMarbim),
  )
}

/** Screens that disappear when the copilot is off. Read by the pages that must refuse. */
export const marbimScreens = (): readonly string[] =>
  NAV.filter((item) => item.requiresMarbim).map((item) => item.id)

/**
 * The shell's whole access decision for one path, in one place.
 *
 * Extracted from the layout so it can be asserted directly rather than by reading the
 * layout's source: a policy that can only be tested by grepping the file that applies it
 * is a policy nobody can change with confidence.
 *
 * **A path with no entry is refused.** The registry IS the access policy, so a route
 * missing from it has no policy — and "no policy" must never read as "no restriction".
 * `/factory` shipped exactly that way: reachable by URL, absent from `NAV`, and therefore
 * open to every signed-in role whatever its entry would have said.
 *
 * The cost of failing closed is that a forgotten entry locks a screen rather than exposing
 * it. That is the trade worth making — somebody reports a locked screen within the hour,
 * and nobody reports an open one — and `access.test.ts` sweeps every page in the group so
 * the omission fails CI long before anybody meets it.
 */
export interface RouteAccess {
  item: NavItem | undefined
  allowed: boolean
  readOnly: boolean
  /** What the locked card names, when it has to render one. */
  subject: string
}

export function resolveAccess(
  pathname: string,
  roles: readonly Role[],
  factoryType: FactoryType,
  words?: Words,
): RouteAccess {
  const item = navItemFor(pathname)
  if (!item) {
    return {
      item: undefined,
      allowed: false,
      readOnly: false,
      subject: words ? words('ui.nav.this_screen') : 'this screen',
    }
  }

  const allowed = canSee(item, roles, factoryType)

  /*
   * The banner says "YOUR ROLE can read this but not change it. Ask an owner or admin if
   * you need to." That is a statement about the caller, and it is only true when somebody
   * else could write here.
   *
   * On a screen with no write surface at all — MARBIM, the owner dashboard, refused writes,
   * the factory tree — `writeRoles` is empty and nobody can write, so the banner told every
   * merchandiser, planner and storekeeper that their role was deficient and sent them to ask
   * an owner for a permission that does not exist. On MARBIM it was worse than noise: the
   * composer beneath it correctly says "proposes drafts · never writes", so the screen made
   * two claims at once and the wrong one was on top. Owners and admins never saw it, because
   * ALL_ACCESS short-circuits `canWrite` — which is why it survived.
   *
   * An empty `writeRoles` is therefore a property of the SCREEN, not a fact about the
   * caller, and there is nothing to tell them.
   */
  return {
    item,
    allowed,
    // Never both: a "read only" banner on a screen the caller cannot open would be two
    // contradictory statements about the same permission.
    readOnly: allowed && item.writeRoles.length > 0 && !canWrite(item, roles, factoryType),
    subject: lockedSubject(item, words),
  }
}

export function navItemFor(href: string): NavItem | undefined {
  // Longest match wins so /orders/PO-88203 still resolves to the order desk.
  return [...NAV]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => href === item.href || href.startsWith(`${item.href}/`))
}
