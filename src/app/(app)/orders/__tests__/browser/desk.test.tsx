/**
 * The desk's new pieces, rendered (design canvas, "Your week" and the order page).
 *
 * The data behind them is integration-tested; what is asserted here is that a person
 * reading the screen is told the thing the query found — which day a milestone falls on
 * and who owes it, and whether the credit behind a PO covers its dates. The LC card in
 * particular exists to stop a conflict being discovered at a bank, so the test that
 * matters most is that a conflicted credit says so in words rather than in a colour.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { LcCoverageRow } from '@/modules/commercial/queries'
import type { WeekMilestone } from '@/modules/orders/queries'

import { LcCard } from '../../[orderId]/lc-card'
import { lcConflictBasis } from '../../lc-tile'
import { WeekStrip, weekDays } from '../../week-strip'

const milestone = (over: Partial<WeekMilestone> = {}): WeekMilestone => ({
  id: 'm-1',
  orderId: 'ord-1',
  poNumber: 'PO-88203',
  buyerName: 'H&M',
  name: 'cutting_start',
  plannedDate: '2026-08-25',
  actualDate: null,
  status: 'late',
  critical: true,
  ownerRole: 'cutting',
  ...over,
})

const lc = (over: Partial<LcCoverageRow> = {}): LcCoverageRow => ({
  orderId: 'ord-1',
  lcId: 'lc-1',
  number: 'LC-DHK-0142',
  status: 'active',
  value: '400000.00',
  currency: 'USD',
  latestShipmentDate: '2026-10-08',
  expiryDate: '2026-11-02',
  floatDays: 4,
  daysToExpiry: 69,
  conflict: false,
  headroom: { limit: '300000.00', used: '120000.00', free: '180000.00', limitPct: 75 },
  ...over,
})

describe('weekDays', () => {
  it('walks forward from the day it is given, across a month boundary', () => {
    expect(weekDays('2026-08-30', 5)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
    ])
  })
})

describe('the week strip', () => {
  const days = weekDays('2026-08-24', 5)

  it('files each milestone under its own day, naming the PO, buyer and department', () => {
    render(
      <WeekStrip
        days={days}
        milestones={[milestone(), milestone({ id: 'm-2', name: 'trims_in_house', plannedDate: '2026-08-26', status: 'on_track', ownerRole: 'store' })]}
        today="2026-08-25"
        locale="en"
      />,
    )

    const cutting = screen.getByText('PO-88203 · H&M · cutting').closest('a')!
    expect(within(cutting).getByText(/late/)).toBeInTheDocument()
    expect(cutting).toHaveAttribute('href', '/orders/ord-1')
  })

  it('marks today, so the week is read from the right column', () => {
    render(<WeekStrip days={days} milestones={[milestone()]} today="2026-08-25" locale="en" />)
    expect(screen.getByText(/Tue 25 · today/)).toBeInTheDocument()
  })

  it('says a quiet day is quiet rather than leaving a blank column', () => {
    render(<WeekStrip days={days} milestones={[milestone()]} today="2026-08-25" locale="en" />)
    // Four of the five days have nothing on them.
    expect(screen.getAllByText('nothing due')).toHaveLength(4)
  })

  it('says so when the whole week is empty', () => {
    render(<WeekStrip days={days} milestones={[]} today="2026-08-25" locale="en" />)
    expect(screen.getByText(/Nothing is due on any order this week/)).toBeInTheDocument()
  })
})

describe('the LC card', () => {
  it('says the float against this order’s own ex-factory, in words', () => {
    render(<LcCard rows={[lc()]} plannedExFactoryDate="2026-10-12" seesPrices />)
    expect(screen.getByText(/4 d before your ex-factory/)).toBeInTheDocument()
    expect(screen.getByText('LC-DHK-0142')).toBeInTheDocument()
  })

  it('a conflict is a sentence naming both dates and what to do, not a red border', () => {
    render(<LcCard rows={[lc({ floatDays: -4, conflict: true })]} plannedExFactoryDate="2026-10-12" seesPrices />)

    const alert = screen.getByText(/Ex-factory 2026-10-12 is after/)
    expect(alert).toHaveTextContent('latest shipment of 2026-10-08')
    expect(alert).toHaveTextContent(/Move the date or have commercial amend the credit/)
  })

  it('shows the back-to-back headroom and the limit it is measured against', () => {
    render(<LcCard rows={[lc()]} plannedExFactoryDate="2026-10-12" seesPrices />)
    expect(screen.getByText(/drawn 120000.00 of 300000.00 · the limit is 75% of the master/)).toBeInTheDocument()
  })

  it('hides the money from a role that may not see commercial terms', () => {
    render(<LcCard rows={[lc()]} plannedExFactoryDate="2026-10-12" seesPrices={false} />)
    expect(screen.queryByText(/BTB headroom/)).not.toBeInTheDocument()
    // The dates are operational, not commercial — they stay.
    expect(screen.getByText('2026-10-08')).toBeInTheDocument()
  })

  it('an order with no credit says why rather than showing an empty card', () => {
    render(<LcCard rows={[]} plannedExFactoryDate="2026-10-12" seesPrices />)
    expect(screen.getByText(/No credit is linked to this order yet/)).toBeInTheDocument()
  })

  it('links to the register, where the credit is actually amended', () => {
    render(<LcCard rows={[lc()]} plannedExFactoryDate="2026-10-12" seesPrices />)
    expect(screen.getByText('LC-DHK-0142').closest('a')).toHaveAttribute('href', '/lcs/lc-1')
  })
})

/*
 * The tile's own wording, pinned after a real tenant showed the defect: a desk where no
 * order carried a credit was told "every credit covers its dates".
 */
describe('the LC conflicts tile’s sentence', () => {
  const po = (orderId: string) => (orderId === 'ord-1' ? 'PO-88203' : 'PO-88214')

  it('does not reassure about a check that had nothing to check', () => {
    expect(lcConflictBasis([], po)).toBe('no credit is linked to any order yet')
  })

  it('gives a clean bill only when there is something to clear', () => {
    expect(lcConflictBasis([lc()], po)).toBe('every credit covers its dates')
  })

  it('names the PO and the credit, so somebody can go straight to it', () => {
    expect(lcConflictBasis([lc({ conflict: true })], po)).toBe('PO-88203 vs LC-DHK-0142')
  })

  it('names two and counts the rest — a tile is a headline', () => {
    const rows = [
      lc({ conflict: true }),
      lc({ orderId: 'ord-2', lcId: 'lc-2', number: 'LC-DHK-0139', conflict: true }),
      lc({ orderId: 'ord-3', lcId: 'lc-3', number: 'LC-DHK-0133', conflict: true }),
    ]
    expect(lcConflictBasis(rows, po)).toBe('PO-88203 vs LC-DHK-0142 · PO-88214 vs LC-DHK-0139 · and 1 more')
  })
})
