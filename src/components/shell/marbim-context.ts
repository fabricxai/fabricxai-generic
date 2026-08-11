/**
 * What MARBIM should be told about where it was opened from.
 *
 * Two surfaces now ask the same questions — the full page at `/marbim` and the global
 * slide-over in the shell (X.2). Both need the same answer to "which prompts does this
 * person get, and are they read-only", so it lives here rather than in either one. A second
 * copy would drift the first time somebody added a role, and the two surfaces disagreeing
 * about what a viewer may do is the kind of difference nobody notices until it matters.
 *
 * No React and no server imports: a server component picks the prompts, a client component
 * renders them.
 */
import { navItemFor, navLabelKey, type Words } from './nav'

/** Starting points per role. Each one is answerable from what that role can already read. */
const SUGGESTIONS: Record<string, readonly string[]> = {
  merchandiser: [
    'Which milestones slip if fabric lands 3 days late?',
    'Draft the buyer update for PO-88203',
    'Planned vs actual on SH-4471 last 3 orders',
    'Which RFQs am I still waiting on?',
  ],
  production: [
    'Why is line 3 behind today?',
    'Hourly target vs actual · line 3',
    'Which style changes over on Thursday?',
  ],
  planner: [
    'Which lines have spare capacity from 24 Aug?',
    'What happens to the plan if I move PO-88219 forward?',
  ],
  commercial: [
    'How much BTB headroom is left on the master LC?',
    'Which LCs expire before their last shipment date?',
  ],
  owner: [
    'Which orders put money at risk this month?',
    'Buyer exposure as a share of the open book',
    'What needs my signature right now?',
  ],
  viewer: [
    'What is the TNA status on PO-88203?',
    'When is ex-factory for this order?',
    'Which milestones are late?',
  ],
}

/**
 * Screen-scoped chips (adoption plan 1.2), keyed by first path segment.
 *
 * The role sets above answer "who are you"; these answer "where are you standing" — the
 * question a person on the receiving bay actually has is about the shelf in front of them,
 * not about their job title. Every chip is a question a REGISTERED tool can answer
 * (`quality.pre_final_readiness`, `store.outstanding_requisitions`, `commercial.check_ud_draw`…)
 * — a chip that ends in "no tool was run" teaches the floor the assistant is decorative,
 * and the second bad experience ends the habit.
 *
 * Keys, not strings: the floor reads Bangla, and the catalogue is where both languages are
 * enforced to exist. Segments without a set fall back to the role suggestions above.
 */
const SCREEN_CHIP_KEYS: Record<string, readonly [string, string, string]> = Object.fromEntries(
  (
    [
      'orders', 'buyers', 'rfq', 'costing', 'sampling', 'lcs', 'ud', 'finance',
      'procurement', 'planning', 'store', 'cutting', 'lines', 'quality', 'shipment',
      'maintenance', 'workforce', 'compliance',
    ] as const
  ).map((segment) => [
    segment,
    [
      `ui.marbim.chips.${segment}.1`,
      `ui.marbim.chips.${segment}.2`,
      `ui.marbim.chips.${segment}.3`,
    ],
  ]),
)

/** The chips for a screen, translated — or null when the segment has no set. */
export function screenSuggestionsFor(pathname: string, words: Words): readonly string[] | null {
  const segment = pathname.split('/').filter(Boolean)[0]
  const keys = segment ? SCREEN_CHIP_KEYS[segment] : undefined
  return keys ? keys.map((key) => words(key)) : null
}

const READ_ONLY_ROLES = new Set(['viewer', 'member'])

/**
 * The most specific role the caller holds wins the prompt set. Owner is checked first
 * because an owner who is also a merchandiser wants the money view.
 */
const ROLE_PRECEDENCE = [
  'owner',
  'commercial',
  'planner',
  'production',
  'merchandiser',
  'viewer',
] as const

export interface MarbimEntry {
  suggestions: readonly string[]
  packLabel: string
  readOnly: boolean
  /**
   * Product-facing model label for the panel header (`marbim fast` / `marbim large`).
   * Null when none is registered. Vendor ids stay on jobs — see `providerSurfaceLabel`.
   */
  model?: string | null
}

export function marbimEntryFor(
  roles: readonly string[],
  /** Where the panel was opened. With `words`, the screen's own chips win over the role's. */
  screen?: { pathname: string; words: Words },
): MarbimEntry {
  const lead = ROLE_PRECEDENCE.find((r) => roles.includes(r)) ?? 'viewer'
  const readOnly = roles.length > 0 && roles.every((r) => READ_ONLY_ROLES.has(r))

  const scoped = screen ? screenSuggestionsFor(screen.pathname, screen.words) : null

  return {
    suggestions: scoped ?? SUGGESTIONS[lead] ?? SUGGESTIONS.viewer!,
    packLabel: readOnly ? 'answers only · no draft tools' : `${lead} pack`,
    readOnly,
  }
}

/**
 * Which module a path belongs to, for `ask({ fromModule })`.
 *
 * This is what makes the slide-over worth having over the page: asking "why is this late"
 * from the cutting floor should lead with cutting's primer, not with all twenty-one. An
 * unknown path returns undefined, and `ask` then falls back to every registered module —
 * a wrong lead would be worse than none, so anything not listed here stays unmapped.
 *
 * Keyed on the first path segment, which is also how `nav.ts` addresses screens.
 */
const MODULE_BY_SEGMENT: Record<string, string> = {
  // `approve` is deliberately absent, and stays absent now that `approvals` IS a registered
  // module with a primer of its own. Naming a lead NARROWS the scope to that one module, and
  // the inbox holds drafts from every department — somebody standing here asking "is this
  // fabric price right?" needs costing's tools, which a lead of `approvals` would take away.
  // Unmapped means every primer leads, including this one.
  buyers: 'buyers',
  compliance: 'compliance',
  costing: 'costing',
  cutting: 'cutting',
  dashboard: 'analytics',
  finance: 'finance',
  lcs: 'commercial',
  lines: 'production',
  maintenance: 'maintenance',
  memory: 'memory',
  orders: 'orders',
  planning: 'planning',
  procurement: 'procurement',
  quality: 'quality',
  rfq: 'rfq',
  sampling: 'sampling',
  settings: 'settings',
  shipment: 'shipment',
  store: 'store',
  ud: 'commercial',
  workforce: 'workforce',
}

export function moduleForPath(pathname: string): string | undefined {
  const segment = pathname.split('/').filter(Boolean)[0]
  return segment ? MODULE_BY_SEGMENT[segment] : undefined
}

/**
 * What to call the current screen in the panel's scope chip.
 *
 * Read from the nav rather than restated, so a screen renamed in one place is renamed in
 * both — the chip claiming you are on a screen that no longer goes by that name is the kind
 * of small lie that makes somebody stop trusting the rest of the panel.
 */
export function screenLabelForPath(pathname: string, words?: Words): string {
  const say = words ?? ((key: string) => (key === 'ui.nav.this_factory' ? 'this factory' : key))
  const segment = pathname.split('/').filter(Boolean)[0]
  if (!segment) return say('ui.nav.this_factory')

  const item = navItemFor(`/${segment}`)
  if (!item) return say('ui.nav.this_factory')
  return words ? words(navLabelKey(item.id)) : item.label
}
