/**
 * LC conflict vectors — written before the implementation.
 *
 * A Letter of Credit is the instrument that actually pays the factory. Two dates on it
 * end the conversation if they are missed: the **latest shipment date** (ship after it
 * and the bank can refuse the documents) and the **expiry date** (present documents after
 * it and the same). A conflict is therefore a red alert everywhere it appears — order
 * book, order detail, shipment, owner exceptions — not a warning badge.
 *
 * Pure by design: the same function serves the interactive API and the nightly scan
 * (brief 1.3, Operations), so it takes plain data and returns findings.
 */
import { describe, expect, it } from 'vitest'

import { detectLcConflicts, type LcForConflictCheck, type OrderForConflictCheck } from '../lc-conflicts'

const LC: LcForConflictCheck = {
  id: 'lc-1',
  number: 'LC-2026-00841',
  latestShipmentDate: '2026-07-05',
  expiryDate: '2026-07-20',
  status: 'active',
}

const order = (over: Partial<OrderForConflictCheck> = {}): OrderForConflictCheck => ({
  id: 'ord-1',
  poNumbers: ['PO-9931'],
  plannedExFactoryDate: '2026-06-30',
  status: 'in_production',
  ...over,
})

describe('detectLcConflicts', () => {
  it('1 · is quiet when the order ships comfortably inside both dates', () => {
    expect(detectLcConflicts({ lc: LC, orders: [order()] })).toEqual([])
  })

  it('2 · flags an ex-factory date after the latest shipment date', () => {
    const conflicts = detectLcConflicts({
      lc: LC,
      orders: [order({ plannedExFactoryDate: '2026-07-09' })],
    })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({
      kind: 'latest_shipment',
      lcId: 'lc-1',
      orderId: 'ord-1',
      severity: 'critical',
      daysOver: 4,
    })
  })

  it('3 · treats shipping exactly ON the latest shipment date as fine', () => {
    // The clause is "not later than", so the date itself is still good. An off-by-one
    // here either cries wolf on a valid shipment or misses a real breach.
    expect(
      detectLcConflicts({ lc: LC, orders: [order({ plannedExFactoryDate: '2026-07-05' })] }),
    ).toEqual([])
  })

  it('4 · flags an expiry that lands before the goods can even ship', () => {
    const conflicts = detectLcConflicts({
      lc: { ...LC, expiryDate: '2026-06-25' },
      orders: [order({ plannedExFactoryDate: '2026-06-30' })],
    })

    expect(conflicts.map((c) => c.kind)).toContain('expiry')
  })

  it('5 · flags expiry when there is no room left to present documents', () => {
    // Shipping on the 4th with expiry on the 6th leaves two days to present documents.
    // Banks in practice need more; the presentation window is a real constraint.
    const conflicts = detectLcConflicts({
      lc: { ...LC, latestShipmentDate: '2026-07-05', expiryDate: '2026-07-06' },
      orders: [order({ plannedExFactoryDate: '2026-07-04' })],
      presentationDays: 7,
    })

    expect(conflicts.map((c) => c.kind)).toContain('presentation_window')
  })

  it('6 · reports every conflicting order, since one LC covers several POs', () => {
    const conflicts = detectLcConflicts({
      lc: LC,
      orders: [
        order({ id: 'ord-1', plannedExFactoryDate: '2026-06-30' }),
        order({ id: 'ord-2', plannedExFactoryDate: '2026-07-11' }),
        order({ id: 'ord-3', plannedExFactoryDate: '2026-07-20' }),
      ],
    })

    expect(conflicts.map((c) => c.orderId).sort()).toEqual(['ord-2', 'ord-3'])
  })

  it('7 · ignores orders that are already shipped or cancelled', () => {
    // A shipped order cannot breach a future shipment date, and a cancelled one is noise
    // in an exceptions feed that has to stay worth reading.
    const conflicts = detectLcConflicts({
      lc: LC,
      orders: [
        order({ id: 'ord-shipped', plannedExFactoryDate: '2026-07-11', status: 'shipped_full' }),
        order({ id: 'ord-cancelled', plannedExFactoryDate: '2026-07-11', status: 'cancelled' }),
      ],
    })

    expect(conflicts).toEqual([])
  })

  it('8 · ignores an LC that is not live', () => {
    expect(
      detectLcConflicts({
        lc: { ...LC, status: 'closed' },
        orders: [order({ plannedExFactoryDate: '2026-07-11' })],
      }),
    ).toEqual([])
  })

  it('9 · says so when an order has no planned ex-factory date yet', () => {
    // Unknown is not the same as safe. An order with no date cannot be cleared, and
    // silently returning "no conflict" is how one slips through the net.
    const conflicts = detectLcConflicts({
      lc: LC,
      orders: [order({ plannedExFactoryDate: null })],
    })

    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]).toMatchObject({ kind: 'unknown_ex_factory', severity: 'warning' })
  })
})

describe('the conflict says its dates, not its field names', () => {
  /*
   * Only `reason` survives a server action's boundary, and the shipment gate spreads these
   * facts straight into the AppError it throws. The catalogue copy carried
   * {plannedExFactoryDate} and reached a merchandiser as a literal brace.
   *
   * This is also the refusal that most needs its figures: "four days past" is a countdown
   * somebody can still act on, where "the credit cannot accept this shipment" only says the
   * truck is stuck.
   */
  const LC = {
    id: 'lc-1',
    number: 'LC-7712',
    latestShipmentDate: '2027-02-10',
    expiryDate: '2027-02-25',
    status: 'active' as const,
  }

  const order = (over: Record<string, unknown> = {}) => ({
    id: 'order-1',
    poNumbers: ['NKA-PO-70318'],
    plannedExFactoryDate: '2027-02-14',
    status: 'in_production',
    ...over,
  })

  it('names the credit, both dates and the days over, on a late shipment', () => {
    const [conflict] = detectLcConflicts({ lc: LC, orders: [order()], presentationDays: 21 })
    const reason = String(conflict?.facts?.reason ?? '')

    expect(reason).toContain('LC-7712')
    expect(reason).toContain('2027-02-14')   // when it leaves
    expect(reason).toContain('2027-02-10')   // latest the credit allows
    expect(reason).toContain('4 day(s)')     // the countdown that matters
    expect(reason).not.toMatch(/[{}]/)
  })

  it('every conflict it can raise carries a sentence with no braces in it', () => {
    const cases = [
      detectLcConflicts({ lc: LC, orders: [order()], presentationDays: 21 }),
      detectLcConflicts({ lc: LC, orders: [order({ plannedExFactoryDate: null })], presentationDays: 21 }),
      detectLcConflicts({
        lc: { ...LC, latestShipmentDate: null },
        orders: [order({ plannedExFactoryDate: '2027-03-01' })],
        presentationDays: 21,
      }),
      detectLcConflicts({
        lc: { ...LC, latestShipmentDate: '2027-02-20' },
        orders: [order({ plannedExFactoryDate: '2027-02-19' })],
        presentationDays: 21,
      }),
    ].flat()

    expect(cases.length).toBeGreaterThan(3)
    for (const conflict of cases) {
      const reason = String(conflict.facts?.reason ?? '')
      expect(reason.length).toBeGreaterThan(20)
      expect(reason).not.toMatch(/[{}]/)
    }
  })
})
