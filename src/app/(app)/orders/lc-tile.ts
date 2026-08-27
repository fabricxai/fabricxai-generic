import type { Locale } from '@/lib/i18n'
import { tui } from '@/lib/i18n-ui'
import type { LcCoverageRow } from '@/modules/commercial/queries'

/**
 * What the LC-conflicts tile says under its number (design canvas, "Your week").
 *
 * Its own module because the decision is not obvious and got made wrong first: a desk
 * where NOT ONE order carried a credit was told "every credit covers its dates". Zero
 * conflicts and zero credits are different facts — one is a clean bill, the other is a
 * check that had nothing to check — and only one of them is reassuring. Found by opening
 * a real tenant, which is the only place it was visible.
 *
 * Pure, so the sentence can be tested rather than re-typed into a test.
 */
export function lcConflictBasis(
  coverage: readonly LcCoverageRow[],
  poFor: (orderId: string) => string | null,
  locale: Locale = 'en',
): string {
  if (coverage.length === 0) return tui(locale, 'ui.orders.tile_lc_none_linked')

  const conflicts = coverage.filter((row) => row.conflict)
  if (conflicts.length === 0) return tui(locale, 'ui.orders.tile_lc_clear')

  // Two names, then a count: a tile is a headline, and the card on each order carries the
  // rest. Naming the PO and the credit is what lets somebody go straight to the right one.
  const named = conflicts
    .slice(0, 2)
    .map((row) => `${poFor(row.orderId) ?? 'order'} vs ${row.number}`)
    .join(' · ')

  return conflicts.length > 2
    ? tui(locale, 'ui.orders.tile_lc_more', { names: named, count: conflicts.length - 2 })
    : named
}
