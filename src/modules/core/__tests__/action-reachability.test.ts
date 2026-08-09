/**
 * Every server action is reachable from a screen (plan 5.5, audit FE-B2/B4/S2/S7 fallout).
 *
 * The systematic finding behind Phase 5: a module can be complete, tested, role-gated and
 * entirely unusable, because the last hop — a screen that calls it — was never built. Nothing
 * catches that. Typecheck is happy with an exported function nobody calls; lint is happy;
 * every unit and integration test passes, because they call the service directly.
 *
 * What it costs is not theoretical. `createLc` had no caller, so the credit every shipment
 * date is checked against could only arrive by seeding. `createUd` had none either, and the
 * UD gate FAILS CLOSED — so a factory running bonded fabric would find the store refusing
 * every issue against a gate it had no way to satisfy from the product.
 *
 * So this is the ratchet. An action that nothing references is either wired to a screen or
 * named below with the reason. The list can only shrink.
 *
 * ## Why a source scan
 *
 * A server action is invoked by identity, not by route — there is no registry to walk and no
 * runtime to ask. The same reason `action-role-gates`, `audited-tables` and `commit-handlers`
 * are source scans: the question is about the whole repo, and the whole repo is only visible
 * from here.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * Actions with no screen behind them yet, and why.
 *
 * **This is a defect list, not a design.** Each entry is a record the product cannot
 * originate — plan 5.5 works through them one module per session. Delete an entry the moment
 * its screen lands; a name left here after it is wired makes the list a lie, and 5.5's own
 * progress unreadable.
 */
const NO_SCREEN_YET: Record<string, string> = {
  'compliance/logAudit': 'an audit visit cannot be recorded — 10.2 has no write surface',
  'compliance/logTraining': 'same module, same gap',
  'compliance/raiseCap': 'a corrective action plan cannot be opened against a finding',
  'compliance/saveCertificate': 'a certificate cannot be filed or renewed',
  'maintenance/reportMachine': 'a broken machine cannot be reported from the floor',
  'memory/findSimilarStyles': 'the similar-style lookup has no entry point on any screen',
  'procurement/updatePoStatus': 'a PO cannot be moved through its own lifecycle',
  'workforce/recordGazette': 'a wage gazette cannot be entered without a document to extract',
  'workforce/makeGazetteActive': 'and one that is entered cannot be put into force',

  // Reachable services, unreachable actions: their screens moved to the offline queue in
  // plan 4.1, so these two are correct, gated, tested and unused HTTP surface.
  'quality/recordMeasuredPieces': 'superseded by the offline path (plan 4.1); delete or wire',
  'quality/submitFinalInspection': 'superseded by the offline path (plan 4.1); delete or wire',

  // Written in 5.8 for the policy editor, which is the one piece of that item still owed.
  // The action and its service gate are done; the screen renders policies read-only.

  // `orders/generateOrderTna` lived here from 5.1 until the live test: the TNA tab's
  // generate control (template picker + ship date) now calls it, so the entry is gone —
  // exactly the shrink this list exists to force.
}

const MODULES_ROOT = 'src/modules'

/** `export async function name` — the only shape a server action takes in this repo. */
const EXPORTED_ACTION = /^export async function ([A-Za-z0-9_]+)/gm

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sourceFiles(path, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(path)
    }
  }
  return out
}

/** `module/action` → the exported name, for every module's `actions.ts`. */
function exportedActions(): Map<string, string> {
  const found = new Map<string, string>()

  for (const moduleId of readdirSync(MODULES_ROOT)) {
    const path = join(MODULES_ROOT, moduleId, 'actions.ts')
    if (!existsSync(path)) continue

    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(EXPORTED_ACTION)) {
      const name = match[1]!
      found.set(`${moduleId}/${name}`, name)
    }
  }
  return found
}

const ACTIONS = exportedActions()

/**
 * Strip comments before scanning.
 *
 * A comment that MENTIONS an action is not a caller, and treating it as one is worse than
 * missing a real call: it makes the ratchet quietly report an orphan as wired. Found the
 * honest way — a note on the nav entry saying "`findSimilarStyles` has no entry point yet"
 * made this test declare that it had one.
 *
 * Regex, not a parser. A `//` inside a string literal would be stripped too, which can only
 * ever cause a false ORPHAN — somebody looking at a screen that does call the action — and
 * never a false pass. That is the safe direction for a list that must only shrink.
 */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')
}

/** Everything that could reference an action, minus the files that declare them. */
const CALLERS = [...sourceFiles('src/app'), ...sourceFiles('src/components'), ...sourceFiles('src/modules')]
  // `endsWith`, not a regex: an unescaped `/` inside a character class is legal and some
  // lexers still end the literal there, which makes the parser fail on an innocent line
  // forty rows below with a message about a missing semicolon.
  .filter((path) => !path.split(/[\\/]/).slice(-2).join('/').endsWith('/actions.ts'))
  .map((path) => withoutComments(readFileSync(path, 'utf8')))
  .join('\n')

const unreferenced = [...ACTIONS]
  .filter(([, name]) => !new RegExp(`\\b${name}\\b`).test(CALLERS))
  .map(([key]) => key)
  .sort()

describe('a module that cannot be used is not finished', () => {
  it('has a screen behind every server action', () => {
    const unlisted = unreferenced.filter((key) => !(key in NO_SCREEN_YET))

    expect(
      unlisted,
      `these actions exist and nothing calls them, so the record they write cannot be created from the product. Wire a screen, or add them to NO_SCREEN_YET with the reason:\n${unlisted.join('\n')}`,
    ).toEqual([])
  })

  it('carries no stale entry — the list only shrinks', () => {
    // A wired action still listed makes the list a lie, and 5.5's remaining work unreadable.
    const stale = Object.keys(NO_SCREEN_YET).filter((key) => !unreferenced.includes(key))

    expect(
      stale,
      `these are wired now — remove them from NO_SCREEN_YET:\n${stale.join('\n')}`,
    ).toEqual([])
  })

  it('lists nothing that is not an action at all', () => {
    // An entry for a renamed or deleted export keeps the list from reaching zero and looks
    // like remaining work nobody can do.
    const phantom = Object.keys(NO_SCREEN_YET).filter((key) => !ACTIONS.has(key))

    expect(phantom, `not exported from any actions.ts:\n${phantom.join('\n')}`).toEqual([])
  })

  it('found the actions at all', () => {
    // Guards the guard: a scanner that matched nothing would pass this file forever while
    // reporting that every module is reachable.
    expect(ACTIONS.size).toBeGreaterThan(50)
  })
})
