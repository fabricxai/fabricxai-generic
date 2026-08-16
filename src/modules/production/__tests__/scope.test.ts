/**
 * Which lines a caller may write to (§9, F45).
 *
 * The wall was UI-only: four `.filter()` calls in page components and nothing on the server,
 * so posting another line's uuid through the queue endpoint came back `applied`. These are the
 * vectors for the decision half of the fix — the half worth reading, since the lookup around
 * it is only a select.
 */
import { describe, expect, it } from 'vitest'

import { refusedLines } from '../scope'

const KNOWN = new Map([
  ['id-1', 'L1'],
  ['id-2', 'L2'],
  ['id-3', 'L3'],
])

describe('refusedLines', () => {
  it('1 · lets through the lines the role covers', () => {
    expect(
      refusedLines({ lineIds: ['id-1', 'id-2'], scope: ['L1', 'L2'], known: KNOWN }).refused,
    ).toEqual([])
  })

  it('2 · refuses one outside the scope, named by its code', () => {
    // "L3", not the uuid. A supervisor knows their floor by the number painted on it, and a
    // uuid in a refusal tells them nothing they can act on.
    expect(refusedLines({ lineIds: ['id-3'], scope: ['L1', 'L2'], known: KNOWN }).refused).toEqual([
      'L3',
    ])
  })

  it('3 · refuses the whole batch that smuggles one line in among allowed ones', () => {
    // Only the offending line is named, but the caller refuses everything: a partial write
    // would leave the supervisor believing every row landed, which is worse than a refusal.
    const { refused } = refusedLines({
      lineIds: ['id-1', 'id-3', 'id-2'],
      scope: ['L1', 'L2'],
      known: KNOWN,
    })
    expect(refused).toEqual(['L3'])
  })

  it('4 · refuses an id that is no line of this company, rather than ignoring it', () => {
    // Letting it through would report a foreign-key error where a permission answer belongs.
    expect(
      refusedLines({ lineIds: ['id-9'], scope: ['L1'], known: KNOWN }).refused,
    ).toEqual(['id-9'])
  })

  it('5 · de-duplicates, so a batch naming a line ten times refuses it once', () => {
    const { refused } = refusedLines({
      lineIds: ['id-3', 'id-3', 'id-3'],
      scope: ['L1'],
      known: KNOWN,
    })
    expect(refused).toEqual(['L3'])
  })

  it('6 · a scope narrowed to nothing covers nothing', () => {
    // An empty ARRAY is not "the whole floor" — undefined is, and it never reaches here. The
    // settings screen removes the key rather than storing [] for exactly this reason.
    expect(refusedLines({ lineIds: ['id-1'], scope: [], known: KNOWN }).refused).toEqual(['L1'])
  })

  it('7 · nothing named is nothing refused', () => {
    expect(refusedLines({ lineIds: [], scope: ['L1'], known: KNOWN }).refused).toEqual([])
  })
})
