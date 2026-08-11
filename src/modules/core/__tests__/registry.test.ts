/**
 * The module registry's two refusals, and the one case that is not a refusal.
 *
 * Both guards protect invariants the database cannot: one module per id, and one WRITER
 * module per pending target (CLAUDE.md rule 11 — two modules drafting into the same table is
 * what makes "who wrote this row?" unanswerable). Neither had a test, which is how the
 * duplicate-id guard came to also refuse a dev server that had merely hot-reloaded.
 *
 * These run under `NODE_ENV=test`, which is deliberately on the throwing side of that
 * distinction: the development carve-out must not be able to switch itself on here, or the
 * guard would be tested in the one mode where it does nothing.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerModule, type ModuleDefinition } from '@/modules/core/registry'

/**
 * The smallest REAL module — every required field present, none of the optional ones.
 *
 * Spelled out rather than cast through `unknown`: a cast would let this file keep compiling
 * after somebody adds a required field to `ModuleDefinition`, and these tests would then be
 * registering something the registry could never be handed in production.
 */
function moduleNamed(id: string, pendingTargets: string[] = []): ModuleDefinition {
  return {
    id,
    pendingTargets,
    zodMap: {},
    approvalDefaults: { requiredRoles: ['owner'] },
  }
}

/** Ids are unique per test so one case cannot poison the next through the shared map. */
let n = 0
const uniqueId = (): string => `test_module_${(n += 1)}`

// `process.env` refuses a plain defineProperty; vitest's own stub is the supported way.
afterEach(() => {
  vi.unstubAllEnvs()
})

describe('one module per id', () => {
  it('registers a module and hands it back', () => {
    const id = uniqueId()
    const definition = moduleNamed(id)
    expect(registerModule(definition)).toBe(definition)
  })

  it('accepts the SAME definition object twice', () => {
    // Two import paths reaching one module is ordinary; only a different object is a clash.
    const definition = moduleNamed(uniqueId())
    registerModule(definition)
    expect(() => registerModule(definition)).not.toThrow()
  })

  it('refuses a second, different module claiming the id', () => {
    const id = uniqueId()
    registerModule(moduleNamed(id))
    expect(() => registerModule(moduleNamed(id))).toThrow(/already registered/)
  })

  it('lets a dev server re-register after a hot reload', () => {
    /*
     * The bug this fixes: hot reload replaces a module's evaluated instance while the
     * registry map — in a chunk that did not change — still holds the previous object. Same
     * module, new identity. It threw `module "marbim" is already registered` over the screen
     * after an ordinary edit, and only a full restart cleared it.
     */
    const id = uniqueId()
    registerModule(moduleNamed(id, ['some_table']))

    vi.stubEnv('NODE_ENV', 'development')
    const reloaded = moduleNamed(id, ['some_table'])

    expect(() => registerModule(reloaded)).not.toThrow()
    // And it is the NEW instance that survives — a replace, not a silent no-op, or the
    // edit that triggered the reload would not be the code that is running.
    expect(registerModule(reloaded)).toBe(reloaded)
  })
})

describe('one writer per pending target (rule 11)', () => {
  it('refuses a target another module already owns', () => {
    const table = `shared_table_${(n += 1)}`
    registerModule(moduleNamed(uniqueId(), [table]))

    expect(() => registerModule(moduleNamed(uniqueId(), [table]))).toThrow(
      /already a pending target/,
    )
  })

  it('refuses a target that is not a legal table name', () => {
    // The same shape the pending_changes CHECK enforces in the database. Caught here, the
    // message names the module; caught there, it is a constraint violation at insert time.
    for (const bad of ['Orders', 'order-lines', '1_orders', 'orders;drop']) {
      expect(() => registerModule(moduleNamed(uniqueId(), [bad])), bad).toThrow(
        /not a valid table name/,
      )
    }
  })
})
