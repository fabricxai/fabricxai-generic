/**
 * Screen-scoped prompt chips (adoption plan 1.2).
 *
 * The role sets answer "who are you"; the screen sets answer "where are you standing".
 * A storekeeper on the receiving bay was offered generic viewer prompts about TNA status —
 * questions about a desk they do not sit at, which is how a chip row teaches people to
 * ignore it. These pin the two properties the ticket names: chips differ by screen for one
 * person, and the floor's chips exist in Bangla.
 */
import { describe, expect, it } from 'vitest'

import { marbimEntryFor, screenSuggestionsFor } from '@/components/shell/marbim-context'
import { tui } from '@/lib/i18n-ui'

const en = (key: string, params?: Record<string, unknown>) => tui('en', key, params)
const bn = (key: string, params?: Record<string, unknown>) => tui('bn', key, params)

describe('chips follow the screen, not only the role', () => {
  it('gives one person different chips on different screens', () => {
    const onStore = marbimEntryFor(['store'], { pathname: '/store/receive', words: en })
    const onUd = marbimEntryFor(['store'], { pathname: '/ud', words: en })

    expect(onStore.suggestions).not.toEqual(onUd.suggestions)
    expect(onStore.suggestions).toHaveLength(3)
  })

  it('scopes by the first segment, so subpages get their module’s chips', () => {
    expect(screenSuggestionsFor('/quality/inline', en)).toEqual(
      screenSuggestionsFor('/quality', en),
    )
  })

  it('falls back to the role set on screens with no set of their own', () => {
    // /approve holds every department's drafts; a scoped set would be wrong for the same
    // reason its module lead is deliberately unmapped.
    const entry = marbimEntryFor(['merchandiser'], { pathname: '/approve', words: en })
    expect(entry.suggestions).toEqual(marbimEntryFor(['merchandiser']).suggestions)
  })

  it('keeps the old behaviour when no screen is given', () => {
    expect(marbimEntryFor(['production']).suggestions.length).toBeGreaterThan(0)
  })
})

describe('the floor reads Bangla', () => {
  it('renders floor chips in Bangla under the bn locale', () => {
    for (const path of ['/store', '/lines', '/quality', '/cutting']) {
      const chips = screenSuggestionsFor(path, bn)!
      for (const chip of chips) {
        // Bengali script, not a fallen-back English string.
        expect(chip, `${path}: ${chip}`).toMatch(/[ঀ-৿]/)
      }
    }
  })

  it('renders the same chips in English under en', () => {
    for (const chip of screenSuggestionsFor('/store', en)!) {
      expect(chip).not.toMatch(/[ঀ-৿]/)
      expect(chip).not.toMatch(/^ui\./) // a dotted key leaking is the failure tui hides
    }
  })
})

describe('every chip is a real question, not a leaked key', () => {
  it('no screen set renders its own key name', () => {
    for (const path of [
      '/orders', '/buyers', '/rfq', '/costing', '/sampling', '/lcs', '/ud', '/finance',
      '/procurement', '/planning', '/store', '/cutting', '/lines', '/quality', '/shipment',
      '/maintenance', '/workforce', '/compliance',
    ]) {
      for (const locale of [en, bn]) {
        for (const chip of screenSuggestionsFor(path, locale)!) {
          expect(chip, path).not.toMatch(/^ui\.marbim/)
        }
      }
    }
  })
})
