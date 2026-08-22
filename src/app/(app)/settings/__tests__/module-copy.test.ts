/**
 * Every registered module has a name an owner can read on the activation panel.
 *
 * The panel renders `listModules()` — the registry is the truth about what can be
 * flipped — and falls back to the raw module id when copy is missing. A switch
 * labelled `rfq` with no sentence under it is a breaker marked only with its wiring,
 * on the one screen where an owner decides what their factory runs. So: a module
 * that registers without a `MODULE_COPY` row fails here, at merge time, rather than
 * shipping an unlabeled toggle.
 */
// Before the registry import — loading every register.ts pulls in the db client,
// which validates the environment at import (same note as intake.test.ts).
import 'dotenv/config'

import { describe, expect, it } from 'vitest'

import '@/modules/registry'
import { MODULE_COPY } from '@/app/(app)/settings/module-copy'
import { listModules } from '@/modules/core/registry'

describe('the activation panel’s copy', () => {
  it('covers every registered module', () => {
    const missing = listModules()
      .map((m) => m.id)
      .filter((id) => !(id in MODULE_COPY))
    expect(missing, 'add these modules to settings/module-copy.ts').toEqual([])
  })

  it('names nothing that is not registered', () => {
    // Copy for a module that no longer exists is a phantom switch waiting to be
    // rendered by a refactor — stale the moment a module is renamed.
    const registered = new Set(listModules().map((m) => m.id))
    const phantom = Object.keys(MODULE_COPY).filter((id) => !registered.has(id))
    expect(phantom, 'these module-copy entries name unregistered modules').toEqual([])
  })

  it('every entry has a label and a sentence', () => {
    for (const [id, copy] of Object.entries(MODULE_COPY)) {
      expect(copy.label.trim(), `${id} has no label`).not.toBe('')
      expect(copy.blurb.trim(), `${id} has no blurb`).not.toBe('')
    }
  })
})
