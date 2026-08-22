/**
 * The shell honours per-tenant module activation (spec §1) — third choke point.
 *
 * The sidebar and the route wall read one active set: a switched-off module's screens
 * leave the rail AND refuse by URL, because hiding a link was never access control
 * (this file's own history: eighteen destinations once rendered for any role that
 * typed the address). The refusal is labelled as what it is — the factory's switch,
 * not the caller's role — so the locked card does not send an owner to ask themselves
 * for permission.
 */
// Before the registry import — loading every register.ts pulls in the db client,
// which validates the environment at import (same note as intake.test.ts).
import 'dotenv/config'

import { describe, expect, it } from 'vitest'

import '@/modules/registry'
import { NAV, landingFor, resolveAccess, visibleNav } from '@/components/shell/nav'
import { listModules } from '@/modules/core/registry'

const ALL_ON: ReadonlySet<string> = new Set(listModules().map((m) => m.id))
const without = (id: string): ReadonlySet<string> =>
  new Set([...ALL_ON].filter((moduleId) => moduleId !== id))

describe('every moduleId on a NAV entry is a registered module', () => {
  it('names nothing the registry has never heard of', () => {
    // A typo here would filter by a name no active set ever contains — the screen
    // would vanish for every tenant the moment ANY set is passed, silently.
    const phantom = NAV.filter((item) => item.moduleId && !ALL_ON.has(item.moduleId))
    expect(phantom.map((item) => `${item.id} → ${item.moduleId}`)).toEqual([])
  })

  it('only shell-level screens go without one', () => {
    // The list is a decision, not an accident: these compose across modules and are
    // always available. A new entry landing here unlabelled fails until somebody
    // either maps it or adds it to this list on purpose.
    const unmapped = NAV.filter((item) => !item.moduleId).map((item) => item.id)
    expect(unmapped.sort()).toEqual(['factory', 'home', 'refused', 'setup'])
  })
})

describe('the sidebar subtracts inactive modules', () => {
  it('drops a switched-off module for everyone, owner included', () => {
    const on = visibleNav(['owner'], 'woven', true, ALL_ON).map((i) => i.id)
    const off = visibleNav(['owner'], 'woven', true, without('store')).map((i) => i.id)

    expect(on).toContain('store')
    expect(off).not.toContain('store')
    // And nothing else went with it.
    expect(on.filter((id) => !off.includes(id))).toEqual(['store'])
  })

  it('takes every door of a module, not just the one named like it', () => {
    // lcs and ud are two screens into commercial — a filter keyed on nav ids would
    // have caught one and left the other open.
    const off = visibleNav(['owner'], 'woven', true, without('commercial')).map((i) => i.id)
    expect(off).not.toContain('lcs')
    expect(off).not.toContain('ud')
  })

  it('leaves shell-level screens and the pure-function callers untouched', () => {
    const off = visibleNav(['store'], 'woven', true, without('orders'))
    expect(off.map((i) => i.id)).toContain('refused')
    // No set passed — the unfiltered answer the existing tests and landing
    // precedence rely on.
    expect(visibleNav(['owner'], 'woven', true).map((i) => i.id)).toContain('store')
  })
})

describe('the route wall refuses a switched-off module by URL', () => {
  it('refuses for everyone and says it is the switch, not the role', () => {
    const access = resolveAccess('/store/receive', ['owner'], 'woven', undefined, without('store'))
    expect(access.allowed).toBe(false)
    expect(access.inactive).toBe(true)

    // With the module on, the same owner walks straight in.
    const open = resolveAccess('/store/receive', ['owner'], 'woven', undefined, ALL_ON)
    expect(open.allowed).toBe(true)
    expect(open.inactive).toBe(false)
  })

  it('a role refusal is NOT labelled as a switch-off', () => {
    // The wrong label would tell a storekeeper that payroll is off when it is merely
    // not theirs — the two sentences send a person to different doors.
    const access = resolveAccess('/workforce', ['store'], 'woven', undefined, ALL_ON)
    expect(access.allowed).toBe(false)
    expect(access.inactive).toBe(false)
  })
})

describe('a landing is a screen that exists at THIS factory', () => {
  it('a storekeeper whose store is off does not start the morning on a locked card', () => {
    expect(landingFor(['store'], 'woven', true, ALL_ON)).toBe('/store/receive')
    const fallback = landingFor(['store'], 'woven', true, without('store'))
    expect(fallback).not.toBe('/store/receive')
    // Wherever it falls, it falls to something their sidebar actually offers.
    const visible = visibleNav(['store'], 'woven', true, without('store')).map((i) => i.href)
    expect(visible).toContain(fallback)
  })
})
