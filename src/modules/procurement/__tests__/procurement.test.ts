/**
 * Procurement vectors — written before the implementation.
 *
 * The recurring failure this file exists to prevent is picking a quote on its unit price.
 * A mill quoting $2.10 against another's $2.15 is not cheaper if its MOQ forces 2,000
 * extra metres, its freight is higher, or it lands three weeks after the fabric-in-house
 * date. Each of those has sunk a delivery, and each of them is invisible in the column
 * buyers actually sort by.
 *
 * Two rules follow:
 *
 *  1. **Feasibility before price.** A quote that cannot land in time is not a cheap
 *     option; it is not an option.
 *  2. **No implicit currency conversion, ever.** Comparing a USD quote with a BDT one
 *     without a stated rate produces a number that looks like a decision.
 */
import { describe, expect, it } from 'vitest'

import {
  compareQuotes,
  matchReceipt,
  ProcurementError,
  comparablePrices,
  supplierScore,
  type QuoteForComparison,
} from '../procurement'

const REQUIRED = { qty: '5000.00', unit: 'm', neededBy: '2026-09-01' }

const quote = (over: Partial<QuoteForComparison> = {}): QuoteForComparison => ({
  quoteId: 'q-1',
  supplierId: 's-1',
  unitPrice: '2.15',
  currency: 'USD',
  leadTimeDays: 30,
  moq: '0',
  freight: '0',
  dutyPct: '0',
  ...over,
})

describe('compareQuotes · landed cost, not unit price', () => {
  it('1 · ranks on landed cost for the quantity actually required', () => {
    const result = compareQuotes(
      [quote({ quoteId: 'a', unitPrice: '2.15' }), quote({ quoteId: 'b', unitPrice: '2.10' })],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked[0]!.quoteId).toBe('b')
    expect(result.ranked[0]!.landedTotal).toBe('10500.00')
  })

  it('2 · a lower unit price loses to freight', () => {
    // $2.10 × 5,000 = 10,500 plus 600 freight is 11,100 — worse than 10,750 flat.
    const result = compareQuotes(
      [
        quote({ quoteId: 'cheap', unitPrice: '2.10', freight: '600.00' }),
        quote({ quoteId: 'dear', unitPrice: '2.15' }),
      ],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked[0]!.quoteId).toBe('dear')
  })

  it('3 · duty is charged on goods value, not on the freight', () => {
    // 10,500 goods + 5% duty = 11,025, then 600 freight = 11,625.
    const result = compareQuotes(
      [quote({ unitPrice: '2.10', dutyPct: '5', freight: '600.00' })],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )
    expect(result.ranked[0]!.landedTotal).toBe('11625.00')
  })

  it('3b · an unstated duty is reported as unstated, never ranked as zero', () => {
    // The proforma said nothing about duty. The landed total is still the best reading of
    // the quote, but the ranking says out loud that it is missing a figure — otherwise a
    // silent 0% makes an import quote look like it clears customs free.
    const result = compareQuotes(
      [quote({ unitPrice: '2.10', dutyPct: null, freight: '600.00' })],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked[0]!.unstated).toEqual(['duty'])
    expect(result.ranked[0]!.dutyValue).toBe('0.00')
    expect(result.ranked[0]!.landedTotal).toBe('11100.00')
  })

  it('3c · a duty the supplier actually quoted as 0% is NOT unstated', () => {
    // The distinction the nullable column exists for: "we charge no duty" is a fact about
    // the quote; "the paper did not say" is a hole in it. They must not look the same.
    const result = compareQuotes([quote({ unitPrice: '2.10', dutyPct: '0' })], {
      ...REQUIRED,
      quotedOn: '2026-07-01',
    })

    expect(result.ranked[0]!.unstated).toEqual([])
  })

  it('3d · unstated freight is named too, and both can be missing at once', () => {
    const result = compareQuotes(
      [quote({ unitPrice: '2.10', dutyPct: null, freight: null })],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked[0]!.unstated).toEqual(['duty', 'freight'])
    expect(result.ranked[0]!.landedTotal).toBe('10500.00')
  })

  it('3e · no MOQ stated is no minimum — the requirement stands alone', () => {
    const result = compareQuotes([quote({ unitPrice: '2.10', moq: null })], {
      ...REQUIRED,
      quotedOn: '2026-07-01',
    })

    expect(result.ranked[0]!.chargedQty).toBe('5000.00')
    expect(result.ranked[0]!.surplusQty).toBe('0.00')
  })

  it('4 · a MOQ above the requirement is charged in full', () => {
    // The mill will not run 5,000 m. Buying 8,000 at 2.05 costs more than 5,000 at 2.15,
    // and the surplus sits in the store for a year.
    const result = compareQuotes(
      [
        quote({ quoteId: 'moq', unitPrice: '2.05', moq: '8000.00' }),
        quote({ quoteId: 'flex', unitPrice: '2.15' }),
      ],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked[0]!.quoteId).toBe('flex')
    const moqLine = result.ranked.find((r) => r.quoteId === 'moq')!
    expect(moqLine.chargedQty).toBe('8000.00')
    expect(moqLine.surplusQty).toBe('3000.00')
  })

  it('5 · excludes a quote that cannot land in time, at any price', () => {
    // Ordered 1 July, needed 1 September: 90 days does not arrive. Cheapness is not the
    // question once a quote cannot make the date.
    const result = compareQuotes(
      [
        quote({ quoteId: 'late', unitPrice: '1.50', leadTimeDays: 90 }),
        quote({ quoteId: 'ontime', unitPrice: '2.15', leadTimeDays: 30 }),
      ],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked.map((r) => r.quoteId)).toEqual(['ontime'])
    expect(result.infeasible).toEqual([
      { quoteId: 'late', reasonKey: 'procurement.quote.too_late', arrivesOn: '2026-09-29' },
    ])
  })

  it('6 · refuses to compare currencies without a stated rate', () => {
    expect(() =>
      compareQuotes(
        [quote({ quoteId: 'usd' }), quote({ quoteId: 'bdt', currency: 'BDT', unitPrice: '250' })],
        { ...REQUIRED, quotedOn: '2026-07-01' },
      ),
    ).toThrow(/rate/i)
  })

  it('7 · converts at the rate it was given, and says so', () => {
    const result = compareQuotes(
      [
        quote({ quoteId: 'usd', unitPrice: '2.15' }),
        quote({ quoteId: 'bdt', currency: 'BDT', unitPrice: '250.00' }),
      ],
      {
        ...REQUIRED,
        quotedOn: '2026-07-01',
        baseCurrency: 'USD',
        rates: { BDT: '0.0083' },
      },
    )

    // 250 BDT × 0.0083 = 2.075 USD per metre — cheaper than 2.15.
    expect(result.ranked[0]!.quoteId).toBe('bdt')
    expect(result.baseCurrency).toBe('USD')
    expect(result.ratesUsed).toEqual({ BDT: '0.0083' })
  })

  it('8 · refuses an empty comparison rather than returning no winner', () => {
    expect(() => compareQuotes([], { ...REQUIRED, quotedOn: '2026-07-01' })).toThrow(
      ProcurementError,
    )
  })

  it('9 · reports every quote as infeasible rather than picking the least bad', () => {
    const result = compareQuotes(
      [quote({ quoteId: 'a', leadTimeDays: 90 }), quote({ quoteId: 'b', leadTimeDays: 120 })],
      { ...REQUIRED, quotedOn: '2026-07-01' },
    )

    expect(result.ranked).toHaveLength(0)
    expect(result.infeasible).toHaveLength(2)
  })
})

describe('matchReceipt · PO line against what arrived', () => {
  it('10 · closes a line received in full', () => {
    const result = matchReceipt(
      { orderedQty: '1000.00', receivedQty: '0' },
      { qty: '1000.00' },
      { overReceiptTolerancePct: '2' },
    )

    expect(result.receivedQty).toBe('1000.00')
    expect(result.closed).toBe(true)
    expect(result.status).toBe('received')
  })

  it('11 · a partial receipt leaves the line open', () => {
    const result = matchReceipt(
      { orderedQty: '1000.00', receivedQty: '0' },
      { qty: '600.00' },
      { overReceiptTolerancePct: '2' },
    )

    expect(result.status).toBe('received_partial')
    expect(result.closed).toBe(false)
    expect(result.outstandingQty).toBe('400.00')
  })

  it('12 · accumulates across receipts', () => {
    const result = matchReceipt(
      { orderedQty: '1000.00', receivedQty: '600.00' },
      { qty: '400.00' },
      { overReceiptTolerancePct: '2' },
    )
    expect(result.closed).toBe(true)
  })

  it('13 · allows an over-receipt inside tolerance', () => {
    // Mills cut to the roll, not to the metre. 2% over on 1,000 m is normal.
    const result = matchReceipt(
      { orderedQty: '1000.00', receivedQty: '0' },
      { qty: '1015.00' },
      { overReceiptTolerancePct: '2' },
    )
    expect(result.closed).toBe(true)
    expect(result.overReceiptQty).toBe('15.00')
    expect(result.withinTolerance).toBe(true)
  })

  it('14 · flags an over-receipt past tolerance instead of accepting it silently', () => {
    // Beyond the allowance somebody is paying for fabric nobody ordered.
    const result = matchReceipt(
      { orderedQty: '1000.00', receivedQty: '0' },
      { qty: '1200.00' },
      { overReceiptTolerancePct: '2' },
    )

    expect(result.withinTolerance).toBe(false)
    expect(result.overReceiptQty).toBe('200.00')
  })

  it('15 · refuses a receipt against an already-closed line', () => {
    expect(() =>
      matchReceipt(
        { orderedQty: '1000.00', receivedQty: '1000.00', closed: true },
        { qty: '50.00' },
        { overReceiptTolerancePct: '2' },
      ),
    ).toThrow(ProcurementError)
  })

  it('16 · refuses a zero or negative receipt', () => {
    expect(() =>
      matchReceipt(
        { orderedQty: '1000.00', receivedQty: '0' },
        { qty: '0' },
        { overReceiptTolerancePct: '2' },
      ),
    ).toThrow(ProcurementError)
  })
})

describe('supplierScore · from the record, never from an opinion', () => {
  const observations = {
    receipts: [
      { onTime: true, rejectedQty: '0', receivedQty: '1000.00' },
      { onTime: true, rejectedQty: '20.00', receivedQty: '1000.00' },
      { onTime: false, rejectedQty: '0', receivedQty: '500.00' },
      { onTime: true, rejectedQty: '5.00', receivedQty: '500.00' },
    ],
    quotesRequested: 10,
    quotesReturned: 8,
    avgUnitPrice: '2.20',
    basketAvgUnitPrice: '2.00',
  }

  it('17 · computes on-time from the receipts', () => {
    // 3 of 4 landed on time.
    expect(supplierScore(observations).onTimePct).toBe('75.00')
  })

  it('18 · computes rejects on quantity, not on receipt count', () => {
    // 25 rejected out of 3,000 received. Counting "2 of 4 receipts had rejects" would
    // report 50% and condemn a supplier over two bad metres.
    expect(supplierScore(observations).qualityRejectPct).toBe('0.83')
  })

  it('19 · price index is 100 at the basket average', () => {
    // 2.20 against a 2.00 basket = 110: this supplier is 10% dearer than the field.
    expect(supplierScore(observations).priceIndex).toBe('110.00')
  })

  it('20 · responsiveness is quotes returned over quotes asked for', () => {
    expect(supplierScore(observations).responsivenessPct).toBe('80.00')
  })

  it('21 · returns null, not 100, for a supplier with no history', () => {
    // A new supplier is unmeasured, not perfect. Reporting 100% would put them top of a
    // ranking on the strength of never having delivered anything.
    const fresh = supplierScore({
      receipts: [],
      quotesRequested: 0,
      quotesReturned: 0,
      avgUnitPrice: null,
      basketAvgUnitPrice: null,
    })

    expect(fresh.onTimePct).toBeNull()
    expect(fresh.qualityRejectPct).toBeNull()
    expect(fresh.priceIndex).toBeNull()
    expect(fresh.responsivenessPct).toBeNull()
    expect(fresh.observations).toBe(0)
  })

  it('21b · a PO with no promised date does not count as an on-time delivery', () => {
    // This read `expectedDeliveryDate === null || closedAt <= expected`, so every receipt
    // against an undated PO scored as ON TIME — a supplier nobody ever gave a date to came
    // out at 100%, and the more carelessly a PO was raised the better they looked.
    const undated = supplierScore({
      receipts: [
        { onTime: null, rejectedQty: null, receivedQty: '100.00' },
        { onTime: null, rejectedQty: null, receivedQty: '100.00' },
      ],
      quotesRequested: 0,
      quotesReturned: 0,
      avgUnitPrice: null,
      basketAvgUnitPrice: null,
    })

    expect(undated.onTimePct).toBeNull()
    // Still two deliveries on the record — the receipts happened, they just say nothing
    // about timeliness.
    expect(undated.observations).toBe(2)
  })

  it('21c · scores on time over the dated receipts only', () => {
    // One late, one on time, one undated. The answer is 50%, not 33% and not 67%.
    const mixed = supplierScore({
      receipts: [
        { onTime: true, rejectedQty: null, receivedQty: '10.00' },
        { onTime: false, rejectedQty: null, receivedQty: '10.00' },
        { onTime: null, rejectedQty: null, receivedQty: '10.00' },
      ],
      quotesRequested: 0,
      quotesReturned: 0,
      avgUnitPrice: null,
      basketAvgUnitPrice: null,
    })

    expect(mixed.onTimePct).toBe('50.00')
    expect(mixed.observations).toBe(3)
  })

  it('22a · reports no reject rate when the rejects were never measured', () => {
    // The scorer used to be handed '0' for every receipt, because reject quantities live
    // in quality's inspections and the chain back to a PO line does not exist. That put a
    // spotless quality record against every supplier in the factory, on the screen people
    // use to decide who to buy from. Null says "not measured"; 0 says "flawless".
    const unmeasured = supplierScore({
      receipts: [{ onTime: true, rejectedQty: null, receivedQty: '100.00' }],
      quotesRequested: 1,
      quotesReturned: 1,
      avgUnitPrice: null,
      basketAvgUnitPrice: null,
    })

    expect(unmeasured.qualityRejectPct).toBeNull()
    // The metrics that ARE measurable still come through.
    expect(unmeasured.onTimePct).toBe('100.00')
  })

  it('22b · one unmeasured receipt makes the whole reject rate unavailable', () => {
    // A partial count can only understate, and an understated reject rate reads as a good
    // one — the direction that costs money.
    const partial = supplierScore({
      receipts: [
        { onTime: true, rejectedQty: '5.00', receivedQty: '100.00' },
        { onTime: true, rejectedQty: null, receivedQty: '100.00' },
      ],
      quotesRequested: 1,
      quotesReturned: 1,
      avgUnitPrice: null,
      basketAvgUnitPrice: null,
    })

    expect(partial.qualityRejectPct).toBeNull()
  })

  it('22 · carries the observation count so a thin score can be read as thin', () => {
    // One delivery at 100% is not a track record, and the number of observations is the
    // only thing that distinguishes it from one.
    const thin = supplierScore({
      receipts: [{ onTime: true, rejectedQty: '0', receivedQty: '100.00' }],
      quotesRequested: 1,
      quotesReturned: 1,
      avgUnitPrice: null,
      basketAvgUnitPrice: null,
    })

    expect(thin.onTimePct).toBe('100.00')
    expect(thin.observations).toBe(1)
  })
})

describe('comparablePrices · like with like, or not at all', () => {
  const map = (entries: Record<string, Record<string, string[]>>) =>
    new Map(Object.entries(entries).map(([item, byS]) => [item, new Map(Object.entries(byS))]))

  it('23 · compares only the items somebody else also quoted', () => {
    // FAB is contested; TRIM was quoted by this supplier alone. Including TRIM would score
    // it at exactly its own price — 100 — and dilute the one real comparison there is.
    const result = comparablePrices(
      map({
        FAB: { us: ['110.00'], them: ['90.00'] },
        TRIM: { us: ['999.00'] },
      }),
      'us',
    )

    // Ours 110 against a field mean of (110 + 90) / 2 = 100.
    expect(result).toEqual({ avgUnitPrice: '110.00', basketAvgUnitPrice: '100.00' })
    expect(supplierScore({
      receipts: [], quotesRequested: 0, quotesReturned: 0, ...result!,
    }).priceIndex).toBe('110.00')
  })

  it('23b · never compares across currencies', () => {
    // Real seed data: the same fabric quoted at 316 and 330 BDT by two local mills and at
    // 2.42 USD by an import mill. Pooled, the field average came out near 216 and the
    // scorecard read 146, 153 and 1.12 — three numbers that look like data and are not.
    // Keyed by item AND currency, the two BDT mills compare and the USD one has no field.
    const byCurrency = map({
      'FAB|BDT': { dhaka: ['316.00'], square: ['330.00'] },
      'FAB|USD': { ningbo: ['2.42'] },
    })

    const square = comparablePrices(byCurrency, 'square')
    expect(square).toEqual({ avgUnitPrice: '330.00', basketAvgUnitPrice: '323.00' })

    // The import mill quoted alone in its currency, so there is nothing to be dearer than.
    expect(comparablePrices(byCurrency, 'ningbo')).toBeNull()
  })

  it('24 · returns null when nothing overlaps — there is no field to be dearer than', () => {
    const alone = comparablePrices(map({ FAB: { us: ['110.00'] } }), 'us')
    expect(alone).toBeNull()
  })

  it('25 · a supplier splitting one item across lines does not sway the field average', () => {
    // `us` quoted FAB three times cheaply. Each supplier counts ONCE per item, so the
    // field mean stays (100 + 200) / 2 rather than being dragged towards 100.
    const result = comparablePrices(
      map({ FAB: { us: ['100.00', '100.00', '100.00'], them: ['200.00'] } }),
      'us',
    )

    expect(result).toEqual({ avgUnitPrice: '100.00', basketAvgUnitPrice: '150.00' })
  })
})
