/**
 * Matching a supplier's words to the factory's own item list.
 *
 * Every case here came off a real document in the live-test kit. The failure mode this
 * guards is not "no match" — that is said on screen and a person picks — it is a WRONG
 * match, which writes a receipt or a price against a material nobody meant.
 */
import { describe, expect, it } from 'vitest'

import { itemTokens, matchItem } from '@/lib/match-item'

const ITEMS = [
  { id: 'yarn', code: 'YRN-30-1', name: '30/1 combed cotton yarn' },
  { id: 'denim', code: 'FAB-DEN-12', name: '12oz stretch denim' },
  { id: 'pique', code: 'FAB-PIQ-180', name: 'dyed piqué 180gsm' },
  { id: 'placket', code: 'TRM-PLK', name: '3-button placket set' },
]

describe('what a document calls a material', () => {
  it('takes the code when the paper prints one', () => {
    expect(matchItem(ITEMS, 'FAB-DEN-12', 'something else entirely')?.id).toBe('denim')
    // Case is the supplier's business, not a reason to fail.
    expect(matchItem(ITEMS, 'fab-den-12', '')?.id).toBe('denim')
  })

  it('matches the same words in a different order', () => {
    // The kit's challan, handwritten: "Cotton Yarn 30/1 Combed" for "30/1 combed cotton yarn".
    expect(matchItem(ITEMS, '', 'Cotton Yarn 30/1 Combed')?.id).toBe('yarn')
  })

  it('finds the item inside a mill’s much longer description', () => {
    // The kit's proforma, verbatim.
    expect(
      matchItem(ITEMS, '', '12 OZ STRETCH DENIM, 98% COTTON 2% SPANDEX, CUTTABLE WIDTH 58", INDIGO')
        ?.id,
    ).toBe('denim')
  })

  it('reads 12oz and 12 OZ as the same words', () => {
    // The reason the tokeniser splits digit/letter boundaries at all: one person writes
    // `12oz`, the next writes `12 OZ`, and a naive split makes those different words.
    expect([...itemTokens('12oz stretch denim')]).toEqual(['12', 'oz', 'stretch', 'denim'])
    expect([...itemTokens('180gsm')]).toEqual(['180', 'gsm'])
  })

  it('refuses a partial overlap rather than guessing', () => {
    // "cotton" alone fits the yarn AND nothing else here — but it is not the yarn's whole
    // name, so it is not a match. A near-miss silently resolved is stock against the wrong
    // material, discovered weeks later.
    expect(matchItem(ITEMS, '', 'cotton')).toBeNull()
    expect(matchItem(ITEMS, '', 'yarn')).toBeNull()
  })

  it('refuses when two items would both fit', () => {
    const ambiguous = [
      { id: 'a', code: 'D1', name: 'denim' },
      { id: 'b', code: 'D2', name: '12oz stretch denim' },
    ]
    // Both names fit inside the sentence. Picking either is a coin toss with somebody's
    // stock, so the answer is a question rather than a guess.
    expect(matchItem(ambiguous, '', '12 OZ STRETCH DENIM INDIGO')).toBeNull()
  })

  it('answers nothing for nothing', () => {
    expect(matchItem(ITEMS, '', '')).toBeNull()
    expect(matchItem(ITEMS, undefined, undefined)).toBeNull()
    expect(matchItem([], 'YRN-30-1', 'anything')).toBeNull()
  })
})
