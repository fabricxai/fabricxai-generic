/**
 * What the departments have signed (design canvas, order dossier).
 *
 * The panel's whole value is that a reader can trust an unanswered row to LOOK unanswered.
 * So most of these cases are about absence: nothing recorded, a module not switched on, and
 * an artefact FabricXAI does not hold at all are three different facts that an empty result
 * set renders identically, and confusing any two of them tells a merchandiser their order
 * is further along than it is.
 *
 * The same defect shipped once already — the LC tile told a desk holding no credits that
 * every credit covered its dates — which is why it is pinned here rather than trusted.
 */
import { describe, expect, it } from 'vitest'

import { signOffRows, type SignOffInput } from '../[orderId]/sign-off'

const ALL = new Set(['rfq', 'costing', 'commercial', 'procurement', 'sampling'])

const base: SignOffInput = {
  order: { id: 'order-1', styleCode: 'SH-4471', qtyTolerancePct: '5.00' },
  quote: null,
  costSheet: null,
  lcCoverage: [],
  materialPos: [],
  pp: null,
  terms: null,
  activeModules: ALL,
}

const row = (input: Partial<SignOffInput>, key: string) =>
  signOffRows({ ...base, ...input }).find((r) => r.key === key)!

describe('the sign-off panel', () => {
  it('1 · gives seven rows in lifecycle order, always the same seven', () => {
    // The order IS the information: reading down the column is how somebody finds where
    // the order stops. A row appearing only when it has an answer would break that.
    expect(signOffRows(base).map((r) => r.key)).toEqual([
      'quote',
      'costing',
      'confirmation_sheet',
      'sales_contract',
      'credit',
      'materials',
      'pp',
    ])
  })

  it('2 · a module that is switched off says so, and does not say "nothing"', () => {
    const off = row({ activeModules: new Set<string>() }, 'costing')

    expect(off.state).toBe('off')
    expect(off.detail).toMatch(/not switched on/)
    // No link to a screen this factory does not have.
    expect(off.href).toBeNull()
  })

  it('3 · a module that IS on with nothing in it says nothing is in it', () => {
    const none = row({}, 'costing')

    expect(none.state).toBe('none')
    expect(none.detail).toBe('Nothing has been costed for this style.')
  })

  describe('the two the platform does not hold', () => {
    it('4 · the confirmation sheet says it is not recorded, not that it is pending', () => {
      const sheet = row({}, 'confirmation_sheet')

      expect(sheet.state).toBe('unmodelled')
      expect(sheet.detail).toMatch(/no confirmation sheet and no signature chain/)
      expect(sheet.badge).toBeNull()
    })

    it('5 · the sales contract names the terms that ARE on file', () => {
      /*
       * The contract record does not exist; its substance does. Tolerance is on the order,
       * AQL and the nominated lab are in the buyer's terms as at confirmation. Saying "we
       * hold nothing" when the app can already answer what the contract SAYS would send
       * somebody to a filing cabinet for a number on their own screen.
       */
      const contract = row(
        { terms: { tolerancePct: '5.00', aqlLevel: '2.5', nominatedLabs: ['Kismet'] } },
        'sales_contract',
      )

      expect(contract.state).toBe('unmodelled')
      expect(contract.detail).toBe(
        'No contract record — its number and date are not held. On file: the order allows ±5.00% over or under · AQL 2.5 · nominated lab Kismet.',
      )
    })

    it('5b · attributes the tolerance to the ORDER, and names what zero means', () => {
      /*
       * Found on a live tenant, where this row read "On file: tolerance ±0.00%" — the
       * schema default (`qty_tolerance_pct` is NOT NULL DEFAULT 0) dressed as a term
       * somebody had negotiated with the buyer.
       *
       * Zero is NOT rewritten as "unknown", because it is not unknown: it is enforced, and
       * a grid that misses the contracted quantity by one piece is refused under it. So it
       * keeps the number and gains the consequence — a merchandiser skims past "±0.00%"
       * and does not skim past "exact quantity".
       */
      const contract = row(
        { order: { id: 'order-1', styleCode: 'SH-4471', qtyTolerancePct: '0.00' } },
        'sales_contract',
      )

      expect(contract.detail).toMatch(/the order allows ±0.00% over or under — exact quantity/)
      expect(contract.detail).not.toMatch(/tolerance ±0/)
    })

    it('6 · and admits when it cannot answer even that', () => {
      const contract = row(
        { order: { id: 'order-1', styleCode: 'SH-4471', qtyTolerancePct: null }, terms: null },
        'sales_contract',
      )

      expect(contract.detail).toMatch(/no buyer terms on file/)
    })
  })

  describe('the credit', () => {
    const coverage = (over: Partial<SignOffInput['lcCoverage'][number]>) => [
      {
        orderId: 'order-1',
        lcId: 'lc-1',
        number: 'LC-7712',
        status: 'active' as const,
        value: '250000.00',
        currency: 'USD',
        latestShipmentDate: '2026-07-04',
        expiryDate: '2026-07-25',
        floatDays: 12,
        daysToExpiry: 60,
        conflict: false,
        headroom: { limit: '187500.00', used: '152000.00', free: '35500.00', limitPct: 75 },
        ...over,
      },
    ]

    it('7 · no credit linked is its own sentence, never a clean bill', () => {
      const credit = row({ lcCoverage: [] }, 'credit')

      expect(credit.state).toBe('none')
      expect(credit.detail).toBe('No letter of credit is linked to this order.')
      // The bug this repeats: "covered" over an order with nothing to cover it.
      expect(credit.badge).not.toBe('covered')
    })

    it('8 · a covered order reports the headroom left, with what it is left OF', () => {
      const credit = row({ lcCoverage: coverage({}) }, 'credit')

      expect(credit.state).toBe('done')
      expect(credit.detail).toBe(
        'LC-7712 · 35500.00 USD of back-to-back headroom left of 187500.00',
      )
      expect(credit.href).toBe('/lcs/lc-1')
    })

    it('9 · a date conflict outranks the headroom and names the date', () => {
      const credit = row(
        { lcCoverage: coverage({ conflict: true, floatDays: -6 }) },
        'credit',
      )

      expect(credit.state).toBe('attention')
      expect(credit.badge).toBe('date conflict')
      // A bank refuses on the DATE, so the date is what the sentence carries.
      expect(credit.detail).toMatch(/latest shipment 2026-07-04/)
    })

    it('10 · rows for other orders are not this order’s credits', () => {
      const credit = row({ lcCoverage: coverage({ orderId: 'someone-else' }) }, 'credit')

      expect(credit.state).toBe('none')
    })
  })

  describe('the bookings', () => {
    const po = (over: Partial<SignOffInput['materialPos'][number]>) => ({
      id: 'po-1',
      poNumber: 'PO-100',
      supplierName: 'Zhejiang Hongli',
      origin: 'import' as const,
      totalValue: '61500.00',
      currency: 'USD',
      expectedDeliveryDate: '2026-06-09',
      status: 'issued' as const,
      onBtb: true,
      ...over,
    })

    it('11 · counts what has landed, not what was ordered', () => {
      const materials = row(
        { materialPos: [po({}), po({ id: 'po-2', poNumber: 'PO-101', status: 'received' })] },
        'materials',
      )

      expect(materials.badge).toBe('1/2 landed')
      expect(materials.state).toBe('open')
    })

    it('12 · everything landed closes the row', () => {
      const materials = row({ materialPos: [po({ status: 'received' })] }, 'materials')

      expect(materials.state).toBe('done')
      expect(materials.badge).toBe('1/1 landed')
    })

    it('13 · names two and counts the rest — a row is a headline', () => {
      const materials = row(
        {
          materialPos: [
            po({}),
            po({ id: 'po-2', poNumber: 'PO-101' }),
            po({ id: 'po-3', poNumber: 'PO-102' }),
            po({ id: 'po-4', poNumber: 'PO-103' }),
          ],
        },
        'materials',
      )

      expect(materials.detail).toMatch(/PO-100/)
      expect(materials.detail).toMatch(/PO-101/)
      expect(materials.detail).not.toMatch(/PO-102/)
      expect(materials.detail).toMatch(/and 2 more$/)
    })
  })

  describe('the PP sample', () => {
    const pp = (over: Partial<NonNullable<SignOffInput['pp']>>) => ({
      id: 'sample-1',
      requestNo: 'PPS-118',
      status: 'approved' as const,
      dueDate: '2026-08-10',
      rounds: 2,
      latestVerdict: 'approved' as const,
      latestRecordedOn: '2026-08-16',
      latestComments: 0,
      ...over,
    })

    it('14 · none requested names the consequence, not the absence', () => {
      const row_ = row({ pp: null }, 'pp')

      expect(row_.state).toBe('none')
      // "No PP sample" means nothing to a reader who has forgotten it gates cutting.
      expect(row_.detail).toMatch(/cutting cannot start without one/)
    })

    it('15 · approved with comments is not the same as approved', () => {
      /*
       * Both open the gate and they mean very different things on the floor: the comments
       * are corrections the buyer expects to see in bulk, and an order that ships without
       * them is a claim. The gate cannot tell them apart; this row must.
       */
      const row_ = row(
        {
          pp: pp({ latestVerdict: 'approved_with_comments', latestComments: 2 }),
        },
        'pp',
      )

      expect(row_.state).toBe('done')
      expect(row_.detail).toBe(
        'PPS-118 · approved with comments, 2026-08-16 — 2 comments that must be in bulk',
      )
    })

    it('16 · a rejected sample is an alarm, not an open item', () => {
      const row_ = row(
        { pp: pp({ status: 'rejected', latestVerdict: 'rejected' }) },
        'pp',
      )

      expect(row_.state).toBe('attention')
    })

    it('17 · a sample with no verdict yet says where it is, not what it said', () => {
      const row_ = row(
        {
          pp: pp({
            status: 'in_work',
            rounds: 0,
            latestVerdict: null,
            latestRecordedOn: null,
          }),
        },
        'pp',
      )

      expect(row_.state).toBe('open')
      expect(row_.badge).toBe('no verdict yet')
      expect(row_.detail).toBe('PPS-118 · in work, due 2026-08-10')
    })
  })

  describe('the quote', () => {
    it('18 · an unquoted style is explained, not just reported empty', () => {
      // An enquiry becomes an order through a person, not a foreign key — so a missing
      // quote is often correct, and a row that just said "none" would read as a gap.
      const quote = row({ quote: null }, 'quote')

      expect(quote.state).toBe('none')
      expect(quote.detail).toMatch(/a repeat or a direct placement has none/)
    })

    it('19 · a drafted quote is not a returned one', () => {
      const quote = row(
        {
          quote: {
            rfqId: 'rfq-1',
            title: 'AW26 rib crew',
            version: 2,
            fobPrice: '4.8500',
            currency: 'USD',
            status: 'draft',
            sentAt: null,
            validityDate: null,
          },
        },
        'quote',
      )

      expect(quote.state).toBe('open')
      expect(quote.detail).toBe('FOB 4.8500 USD · quote v2 — not sent yet')
    })
  })

  it('20 · the heading counts only the gates that can be answered', () => {
    /*
     * Seven rows, two of which FabricXAI cannot hold and one of whose modules may be off.
     * Counting those as unpassed gates would put a permanently failing score on every
     * order in the factory, which is the fastest way to make a panel meaningless.
     */
    const rows = signOffRows({ ...base, activeModules: new Set(['costing']) })
    const askable = rows.filter((r) => r.state !== 'off' && r.state !== 'unmodelled')

    expect(rows).toHaveLength(7)
    expect(askable.map((r) => r.key)).toEqual(['costing'])
  })
})
