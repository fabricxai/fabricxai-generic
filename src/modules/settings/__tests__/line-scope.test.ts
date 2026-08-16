/**
 * What a role's scope becomes when its lines change (§9, F46).
 *
 * Both rules here are the kind that look like nothing in a diff and are unfindable afterwards:
 * an empty list must remove the key rather than store `[]`, and the other keys in a scope must
 * survive somebody editing the lines.
 */
import { describe, expect, it } from 'vitest'

import { cleanLineCodes, nextLineScope } from '../line-scope'

describe('nextLineScope', () => {
  it('1 · narrows to the lines given', () => {
    expect(nextLineScope({}, ['L1', 'L2'])).toEqual({ lines: ['L1', 'L2'] })
  })

  it('2 · an empty list REMOVES the key rather than storing an empty array', () => {
    // `session.ts` reads a role with no `lines` array as covering the whole floor. Storing []
    // would leave "everywhere" and "nowhere" resting on how one reader treats [].every().
    const next = nextLineScope({ lines: ['L1'] }, [])
    expect('lines' in next).toBe(false)
  })

  it('3 · leaves every other key in the scope alone', () => {
    // The lines picker owns one key. A scope carrying anything else must survive it.
    expect(nextLineScope({ lines: ['L1'], floor: 'F2', shift: 'A' }, ['L3'])).toEqual({
      lines: ['L3'],
      floor: 'F2',
      shift: 'A',
    })
    expect(nextLineScope({ floor: 'F2' }, [])).toEqual({ floor: 'F2' })
  })

  it('4 · treats a missing scope as an empty one', () => {
    expect(nextLineScope(null, ['L1'])).toEqual({ lines: ['L1'] })
    expect(nextLineScope(undefined, [])).toEqual({})
  })

  it('5 · does not alias the caller’s array', () => {
    // The stored scope must not change underneath us if the caller reuses its list.
    const codes = ['L1']
    const next = nextLineScope({}, codes)
    codes.push('L2')
    expect(next.lines).toEqual(['L1'])
  })
})

describe('cleanLineCodes', () => {
  it('6 · trims, drops blanks and de-duplicates', () => {
    expect(cleanLineCodes([' L1 ', 'L1', '', '   ', 'L2'])).toEqual(['L1', 'L2'])
  })

  it('7 · keeps the order it was given', () => {
    // The screen sends board order, so two admins picking the same three lines store the same
    // thing rather than two scopes differing only by the order somebody clicked.
    expect(cleanLineCodes(['L3', 'L1', 'L2'])).toEqual(['L3', 'L1', 'L2'])
  })
})
