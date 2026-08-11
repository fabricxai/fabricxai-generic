/**
 * Which screen each role sees first every morning (adoption plan 1.1).
 *
 * The bug this pins: the root sent office roles to "Your work" and everybody else to the
 * FIRST SCREEN THEIR SIDEBAR ORDERED — which, with the approve inbox near the top, greeted
 * a storekeeper with an empty approval queue instead of the receiving bay. The old code's
 * own comment promised the opposite. A landing is the one screen a person meets every
 * single day, which is why the decision is a tested function rather than sidebar order.
 */
import { describe, expect, it } from 'vitest'

import { landingFor, type FactoryType } from '@/components/shell/nav'
import type { Role } from '@/modules/core/ctx'

const KNIT: FactoryType = 'knit-composite'

describe('every role lands on its own desk', () => {
  const expected: readonly [Role, string][] = [
    ['store', '/store/receive'],
    ['cutting', '/cutting'],
    ['production', '/lines/hourly'],
    ['quality', '/quality/inline'],
    ['shipment', '/shipment'],
    ['maintenance', '/maintenance'],
    ['hr', '/workforce'],
    ['compliance', '/compliance'],
    ['finance', '/finance'],
    ['commercial', '/lcs'],
    ['planner', '/planning'],
    ['procurement', '/procurement'],
  ]

  it.each(expected)('%s → %s', (role, href) => {
    expect(landingFor([role], KNIT)).toBe(href)
  })

  it('sends the office to Your work', () => {
    for (const role of ['owner', 'admin', 'merchandiser'] as const) {
      expect(landingFor([role], KNIT)).toBe('/home')
    }
  })

  it('never lands anybody on the approve inbox', () => {
    // The exact greeting this replaces: an empty inbox as the first thing a floor role
    // sees every day. Approve is a stop on the way, never the front door.
    const everyRole: readonly Role[] = [
      'owner', 'admin', 'merchandiser', 'commercial', 'planner', 'store', 'procurement',
      'cutting', 'production', 'quality', 'shipment', 'maintenance', 'hr', 'compliance',
      'finance', 'member', 'viewer',
    ]
    for (const role of everyRole) {
      expect(landingFor([role], KNIT), role).not.toBe('/approve')
    }
  })
})

describe('multi-role holders', () => {
  it('lets the office feed win when they have one', () => {
    // An admin who also holds store still gets the composed queue — supervision is the
    // job, and the warehouse is one click away.
    expect(landingFor(['admin', 'store'], KNIT)).toBe('/home')
  })

  it('sends a floor+office holder to the floor', () => {
    // store+finance goes to the warehouse first and reads reports second: an office
    // landing mis-set costs a click, a floor landing mis-set is a whole wrong screen on
    // a shared tablet. The precedence is ROLE_LANDINGS order.
    expect(landingFor(['finance', 'store'], KNIT)).toBe('/store/receive')
  })

  it('is stable regardless of the order roles arrive in', () => {
    expect(landingFor(['store', 'finance'], KNIT)).toBe(landingFor(['finance', 'store'], KNIT))
  })
})

describe('the fallbacks still hold', () => {
  it('a viewer gets the first screen their sidebar offers, not a dead end', () => {
    const landing = landingFor(['viewer'], KNIT)
    expect(landing).not.toBe('/settings')
    expect(landing.startsWith('/')).toBe(true)
  })

  it('no roles at all goes to Settings, where they can see who to ask', () => {
    expect(landingFor([], KNIT)).toBe('/settings')
  })
})

describe('the desks reach Your work from the sidebar (adoption plan 2.2)', () => {
  it('offers /home to the four composed desks without changing their landing', async () => {
    const { visibleNav } = await import('@/components/shell/nav')
    for (const role of ['store', 'quality', 'shipment', 'commercial'] as const) {
      expect(
        visibleNav([role], KNIT).some((item) => item.id === 'home'),
        role,
      ).toBe(true)
      // The landing stays the desk itself — Your work is a stop, not the front door.
      expect(landingFor([role], KNIT)).not.toBe('/home')
    }
  })
})
