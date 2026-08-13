/**
 * RFQ & quotation vectors — written before the implementation.
 *
 * This is the module that decides what the factory charges, so the failures are all about
 * quoting a number nobody can stand behind:
 *
 *  1. **A quote is a SNAPSHOT of a cost sheet, not a pointer to one.** The sheet gets
 *     repriced; the quote the buyer holds does not change. A breakdown that recomputes from
 *     today's sheet is a quote nobody can reproduce when the buyer asks why the price moved.
 *  2. **The breakdown must reconcile to the price.** If the components do not sum to the
 *     FOB, the breakdown is decoration — and it is the thing a buyer negotiates against
 *     line by line.
 *  3. **Won means an order, so the payload has to be complete.** A `rfq.won` missing the
 *     size ratio produces an order nobody can cut.
 */
import { describe, expect, it } from 'vitest'

import {
  buildFobBreakdown,
  isQuoteExpired,
  parseSizeRatio,
  RfqError,
  rfqStatusMachine,
  wonPayload,
  type CostSheetSnapshot,
} from '../rfq'
import { rfqFromEnquiryDraft, rfqPayload } from '../zod'

const SHEET: CostSheetSnapshot = {
  costSheetId: 'cs-1',
  version: 3,
  currency: 'USD',
  fobPrice: '4.98',
  totalCost: '4.38',
  marginPct: '12',
  marginBasis: 'price',
  components: {
    fabric: '3.20',
    trims: '0.42',
    embellishment: '0.10',
    cm: '0.43',
    commercial: '0.23',
  },
  cmLocalPerPiece: '51.81',
  localCurrency: 'BDT',
}

describe('buildFobBreakdown · a snapshot that reconciles', () => {
  it('1 · carries every component and the price they add up to', () => {
    const result = buildFobBreakdown(SHEET)

    expect(result.components).toEqual(SHEET.components)
    expect(result.totalCost).toBe('4.38')
    expect(result.fobPrice).toBe('4.98')
  })

  it('2 · the components sum to the total cost', () => {
    // The invariant a buyer negotiates against line by line. If they do not reconcile the
    // breakdown is decoration.
    const result = buildFobBreakdown(SHEET)
    expect(result.componentsTotal).toBe('4.38')
    expect(result.reconciles).toBe(true)
  })

  it('3 · reports a breakdown that does NOT reconcile rather than hiding it', () => {
    // A sheet whose stored total disagrees with its own components has been tampered with
    // or was written by older code. Quoting from it would put a number in front of a buyer
    // that the factory cannot rebuild.
    const result = buildFobBreakdown({ ...SHEET, totalCost: '4.90' })

    expect(result.reconciles).toBe(false)
    expect(result.componentsTotal).toBe('4.38')
  })

  it('4 · carries the margin and its BASIS', () => {
    // 12% on price and 12% on cost are different prices. A quote that does not say which
    // cannot be checked.
    const result = buildFobBreakdown(SHEET)
    expect(result.marginPct).toBe('12')
    expect(result.marginBasis).toBe('price')
  })

  it('5 · carries the CM in local currency alongside the converted one', () => {
    // The factory argues about CM in taka; the buyer sees it in dollars. Both belong on
    // the quote, or the two sides are discussing different numbers.
    const result = buildFobBreakdown(SHEET)
    expect(result.cmLocalPerPiece).toBe('51.81')
    expect(result.localCurrency).toBe('BDT')
  })

  it('6 · refuses a sheet with no components', () => {
    expect(() => buildFobBreakdown({ ...SHEET, components: {} })).toThrow(RfqError)
  })

  it('7 · refuses a zero FOB price', () => {
    expect(() => buildFobBreakdown({ ...SHEET, fobPrice: '0.00' })).toThrow(RfqError)
  })

  it('8 · computes the achieved margin from the snapshot, not from the sheet’s claim', () => {
    // (4.98 − 4.38) / 4.98 = 12.05%. The sheet says 12; the small difference is rounding
    // in the sheet's own price, and the quote reports what the numbers actually give.
    const result = buildFobBreakdown(SHEET)
    expect(result.achievedMarginPct).toBe('12.05')
  })
})

describe('isQuoteExpired', () => {
  it('9 · a quote past its validity date is expired', () => {
    expect(isQuoteExpired({ validityDate: '2026-07-29', today: '2026-07-30' })).toBe(true)
  })

  it('10 · the validity date itself is still valid', () => {
    // A quote valid "until 30 July" is valid on 30 July. Expiring a day early loses orders.
    expect(isQuoteExpired({ validityDate: '2026-07-30', today: '2026-07-30' })).toBe(false)
  })

  it('11 · a quote with no validity date never expires on its own', () => {
    // Absent a stated date, expiry is a commercial decision rather than an arithmetic one.
    expect(isQuoteExpired({ validityDate: null, today: '2026-07-30' })).toBe(false)
  })
})

describe('wonPayload · what becomes an order', () => {
  const base = {
    rfqId: 'r-1',
    buyerId: 'b-1',
    styleCode: 'ST-100',
    quantity: 12000,
    unit: 'pcs',
    sizeRatio: { S: 1, M: 2, L: 2, XL: 1 },
    fobPrice: '4.98',
    currency: 'USD',
    requestedShipDate: '2026-11-15',
  }

  it('12 · assembles everything an order needs', () => {
    const payload = wonPayload(base)

    expect(payload.buyerId).toBe('b-1')
    expect(payload.quantity).toBe(12000)
    expect(payload.sizeRatio).toEqual(base.sizeRatio)
    expect(payload.fobPrice).toBe('4.98')
  })

  it('13 · refuses a win with no size ratio', () => {
    // An order without a ratio cannot be cut — 5.1 needs pieces per size, and "12,000
    // pieces" is not a cutting instruction.
    expect(() => wonPayload({ ...base, sizeRatio: {} })).toThrow(RfqError)
  })

  it('14 · refuses a size ratio that is all zeroes', () => {
    expect(() => wonPayload({ ...base, sizeRatio: { S: 0, M: 0 } })).toThrow(RfqError)
  })

  it('15 · refuses a win with no requested ship date', () => {
    // The TNA is generated backwards from the ship date. Without one there is no plan.
    expect(() => wonPayload({ ...base, requestedShipDate: null })).toThrow(/ship date/i)
  })

  it('16 · refuses a non-positive quantity', () => {
    expect(() => wonPayload({ ...base, quantity: 0 })).toThrow(RfqError)
  })

  it('17 · breaks the quantity down by the ratio, so the numbers reach the floor', () => {
    // 12,000 over a 1:2:2:1 ratio = 2,000 / 4,000 / 4,000 / 2,000.
    const payload = wonPayload(base)
    expect(payload.sizeBreakdown).toEqual({ S: 2000, M: 4000, L: 4000, XL: 2000 })
  })

  it('18 · puts the remainder on the largest size rather than losing it', () => {
    // 10,001 over 1:2:2:1 does not divide. The breakdown must still add up to the order —
    // a piece dropped here is a piece short at final inspection.
    const payload = wonPayload({ ...base, quantity: 10001 })
    const total = Object.values(payload.sizeBreakdown).reduce((a, b) => a + b, 0)

    expect(total).toBe(10001)
    expect(payload.sizeBreakdown.M!).toBeGreaterThan(payload.sizeBreakdown.S!)
  })
})

describe('parseSizeRatio · how the ratio is typed at the moment of winning', () => {
  it('22 · reads "S:1 M:2 L:2 XL:1" into parts per size', () => {
    expect(parseSizeRatio('S:1 M:2 L:2 XL:1')).toEqual({ S: 1, M: 2, L: 2, XL: 1 })
  })

  it('23 · commas, equals signs and lowercase sizes all mean the same thing', () => {
    expect(parseSizeRatio('s=1, m=2, l=2, xl=1')).toEqual({ S: 1, M: 2, L: 2, XL: 1 })
  })

  it('24 · refuses rather than guesses on anything unparseable', () => {
    expect(parseSizeRatio('')).toBeNull()
    expect(parseSizeRatio('S M L')).toBeNull()
    expect(parseSizeRatio('S:0')).toBeNull() // zero parts is not a size in the order
    expect(parseSizeRatio('S:one')).toBeNull()
  })

  it('25 · numeric and slashed size names survive — kids sizes are "6/7"', () => {
    expect(parseSizeRatio('6/7:1 8/9:2')).toEqual({ '6/7': 1, '8/9': 2 })
  })
})

describe('rfqStatusMachine', () => {
  it('19 · walks open → quoted → won', () => {
    expect(() => rfqStatusMachine.assert('open', 'quoted')).not.toThrow()
    expect(() => rfqStatusMachine.assert('quoted', 'won')).not.toThrow()
  })

  it('20 · can go back to clarifying after quoting, because buyers ask questions', () => {
    expect(() => rfqStatusMachine.assert('quoted', 'clarifying')).not.toThrow()
  })

  it('20b · re-quoting an already-quoted RFQ is legal', () => {
    // The buyer pushed back on price. Forbidding this would force a merchandiser to move
    // the RFQ backwards just to re-price it.
    expect(() => rfqStatusMachine.assert('quoted', 'quoted')).not.toThrow()
  })

  it('21 · cannot win an RFQ that was never quoted', () => {
    // Winning without a quote means there is no price, and the order it creates has none.
    expect(() => rfqStatusMachine.assert('open', 'won')).toThrow()
  })

  it('22 · won is terminal — it is an order now', () => {
    expect(() => rfqStatusMachine.assert('won', 'quoted')).toThrow()
  })
})

/**
 * What a model actually hands back when it reads an enquiry.
 *
 * The kit-fixture suite in `docs/__tests__` proves the schema accepts a PERFECT reading —
 * every value already a normalised string. That is a real check and it is not this one: it
 * would not have caught `targetPrice`, because a hand-written fixture naturally says
 * `"8.40"`, and the provider says `8.40`.
 *
 * A structured-output model given a field called `targetPrice` and a page reading
 * "USD 8.40 per piece, FOB Chattogram" returns a JSON number, or the string with the
 * currency still on it. `money()` is `z.string().regex(...)` and rejected both — the second
 * half of the production failure "buyerId Invalid UUID; targetPrice expected a money amount".
 *
 * So these vectors are the shapes the wire actually carries, not the shapes a schema author
 * would think to write down.
 */
describe('rfqFromEnquiryDraft · what a provider actually returns', () => {
  const base = {
    title: "ladies' brushed-fleece full-zip hoodie — AW-27 core",
    productType: "ladies' knitted hooded sweatshirt, full zip",
    quantity: 42000,
  }

  it('23 · parses with no buyerId at all — the moment the provider is judged in', () => {
    // contextValues are merged AFTER the provider validates (marbim/service.ts). A required
    // buyerId here is a door that never opens, however good the reading.
    const result = rfqFromEnquiryDraft.safeParse(base)
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
    expect(result.data?.buyerId).toBeUndefined()
  })

  it.each([
    ['a JSON number', 8.4, '8.4'],
    ['a decimal string', '8.40', '8.40'],
    ['the currency still attached', 'USD 8.40', '8.40'],
    ['a price phrase', 'USD 8.40 per piece FOB', '8.40'],
    ['thousands grouped', '12,500.00', '12500.00'],
  ])('24 · targetPrice survives %s', (_label, input, expected) => {
    const result = rfqFromEnquiryDraft.safeParse({ ...base, targetPrice: input })
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
    expect(result.data?.targetPrice).toBe(expected)
  })

  it.each([
    ['a JSON number', 42000],
    ['a grouped string', '42,000'],
    ['a string with its unit', '42,000 pcs'],
  ])('25 · quantity survives %s', (_label, input) => {
    const result = rfqFromEnquiryDraft.safeParse({ ...base, quantity: input })
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
    expect(result.data?.quantity).toBe(42000)
  })

  it('26 · a ship date stated in prose is dropped, not fatal', () => {
    // The enquiry says "last week of January 2027". That is not a date, and losing the whole
    // reading over one unparseable field is how an extractor earns its reputation.
    const result = rfqFromEnquiryDraft.safeParse({
      ...base,
      requestedShipDate: 'last week of January 2027',
      deadline: '2026-08-27',
    })
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
    expect(result.data?.requestedShipDate).toBeUndefined()
    expect(result.data?.deadline).toBe('2026-08-27')
  })

  it('27 · a reading is marked ai_extracted without being told to', () => {
    expect(rfqFromEnquiryDraft.parse(base).source).toBe('ai_extracted')
  })

  it('28 · the strict payload still refuses what the draft tolerated', () => {
    // The whole point of two schemas. `commitRfq` re-parses with `rfqPayload`, so a draft
    // with no buyer cannot become an RFQ no matter what the approve screen does.
    const draft = rfqFromEnquiryDraft.parse(base)
    expect(rfqPayload.safeParse(draft).success).toBe(false)
    expect(rfqPayload.safeParse({ ...draft, buyerId: crypto.randomUUID() }).success).toBe(true)
  })

  /**
   * The first LIVE reading, verbatim from the production log — the payload that validated,
   * rode through approve, and died in Postgres as `rfqs_owner_user_id_users_id_fk` with
   * `owner_user_id = ''`. Vectors 23–28 above are the shapes a provider was imagined to
   * return; this is the one it actually did.
   */
  const LIVE_READING = {
    title: 'REQUEST FOR QUOTATION',
    productType: "ladies' knitted hooded sweatshirt, full zip",
    description:
      "Ladies' full-zip hooded sweatshirt, brushed back fleece 280 g/m², two-panel lined " +
      'hood, kangaroo pocket, 1×1 rib cuff and hem, Our article NK-90455',
    styleCode: '',
    quantity: 42000,
    unit: 'pcs',
    sizeRatio: { XS: 1, S: 2, M: 3, L: 2, XL: 1 },
    targetPrice: '8.40',
    targetCurrency: 'USD',
    currency: 'USD',
    deadline: '2026-08-27',
    source: 'manual',
    ownerUserId: '',
  }

  it('29 · a model-invented ownerUserId is stripped, never stored', () => {
    // `""` passed `z.string()`, defeated `?? ctx.userId` (not nullish), and reached the FK.
    // A user id is the buyerId lesson one field over: no document carries one, so the draft
    // schema must not even offer it.
    const draft = rfqFromEnquiryDraft.parse(LIVE_READING)
    expect('ownerUserId' in draft).toBe(false)
  })

  it('30 · the model cannot declare its own reading manual', () => {
    // Provenance on the field audits read. The model, shown the enum, picked 'manual'.
    expect(rfqFromEnquiryDraft.parse(LIVE_READING).source).toBe('ai_extracted')
  })

  it('31 · an empty-string styleCode becomes absence, not a style named ""', () => {
    const draft = rfqFromEnquiryDraft.parse(LIVE_READING)
    expect(draft.styleCode).toBeUndefined()
    expect(draft.description).toContain('NK-90455')
  })

  it('32 · the live reading commits: draft + picked buyer satisfies the strict payload', () => {
    // End to end through both schemas, exactly as approve does it: parse the stored payload
    // with the draft schema, merge nothing but the picker's buyer, re-parse strict.
    const draft = rfqFromEnquiryDraft.parse(LIVE_READING)
    const committed = rfqPayload.safeParse({ ...draft, buyerId: crypto.randomUUID() })
    expect(committed.success, JSON.stringify(committed.error?.issues)).toBe(true)
    expect(committed.data?.ownerUserId).toBeUndefined() // commitRfq falls back to ctx.userId
  })

  it('33 · the strict payload now refuses "" as an owner outright', () => {
    // If any other path ever produces it again, the refusal happens in zod with a typed
    // error — not in ri_triggers.c with a toast.
    const result = rfqPayload.safeParse({ ...LIVE_READING, buyerId: crypto.randomUUID() })
    expect(result.success).toBe(false)
    expect(result.error?.issues.some((issue) => issue.path[0] === 'ownerUserId')).toBe(true)
  })
})
