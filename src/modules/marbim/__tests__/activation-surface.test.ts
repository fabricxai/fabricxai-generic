/**
 * The assistant surface honours per-tenant module activation (spec §1).
 *
 * `company_modules` shipped with three named choke points, and MARBIM is the one a
 * screen cannot cover for: the sidebar hides a switched-off module, but the composer
 * and the intake dialog are reachable from everywhere, so a factory that shelved
 * compliance would still see its chips and could still ask its tools to run. The
 * activation row would be a preference, not a wall.
 *
 * The pure half — kinds filtered through the active set — is behaviour-tested in
 * `intake.test.ts`, and `assertModuleActive` itself against a real database in core's
 * activation suite. What is asserted HERE is that the action layer actually consults
 * them: these are server actions behind `headers()`, so the check is on the source,
 * with comments stripped the same way `marbim-off.test.ts` does and for the same
 * red-test reason — a comment that mentions the gate is not a consumer of it.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

const stripped = (path: string) =>
  readFileSync(join(process.cwd(), path), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')

const actions = stripped('src/modules/marbim/actions.ts')

/** The body of one exported server action, comments already gone. */
function body(name: string): string {
  const functions = actions.split(/export async function /)
  const match = functions.find((segment) => segment.startsWith(`${name}(`))
  if (!match) throw new Error(`no exported action named "${name}" in marbim/actions.ts`)
  return match
}

describe('chat scope is the ACTIVE modules, not the registry', () => {
  it('ask() filters listModules() through activeModuleIds before anything derives from it', () => {
    // Primers, packs and tools all flow from `registered`; one filter covers all three,
    // so the one line to protect is the filter itself.
    expect(body('ask')).toMatch(/activeModuleIds\(ctx\)/)
    expect(body('ask')).toMatch(/listModules\(\)\.filter\(\(m\) => active\.has\(m\.id\)\)/)
  })
})

describe('every intake door checks the tenant wall beside the desk wall', () => {
  // `listIntakeKinds` draws the chips; the other three are the submits behind them.
  // A door that skipped the check would accept what the chips no longer offer.
  it.each(['intakeContext', 'readDocument', 'readIntoForm'])(
    '%s calls assertModuleActive for the kind’s module',
    (name) => {
      expect(body(name)).toMatch(/assertModuleActive\(ctx, kind\.moduleId\)/)
    },
  )

  it('listIntakeKinds passes the active set into intakeKindsFor', () => {
    // The signature makes forgetting a compile error; this pins WHICH set is passed.
    expect(body('listIntakeKinds')).toMatch(
      /intakeKindsFor\(ctx\.roles, await activeModuleIds\(ctx\)\)/,
    )
  })
})
