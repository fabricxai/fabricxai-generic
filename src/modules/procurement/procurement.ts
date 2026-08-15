/**
 * Procurement arithmetic (brief 3.2 §Operations). Pure — no database, no clock.
 *
 * The mistake this file is built against is choosing a quote on its unit price. A mill at
 * $2.10 is not cheaper than one at $2.15 if its MOQ forces two thousand surplus metres,
 * its freight is higher, or it lands after the fabric-in-house date. Each of those has
 * sunk a delivery, and none of them shows in the column people sort by.
 *
 * Two rules run through everything here:
 *
 *  1. **Feasibility before price.** A quote that cannot arrive in time is not a cheap
 *     option; it is excluded, with the date it would actually land.
 *  2. **No implicit currency conversion.** Comparing USD against BDT without a stated
 *     rate produces a number that looks like a decision. The rate is required and is
 *     reported back with the answer.
 */
export class ProcurementError extends Error {
  override readonly name = 'ProcurementError'
}

const DECIMAL = /^\d+(\.\d+)?$/

// Money and quantity are both carried at 4 minor digits internally so a rate like
// 0.0083 survives the multiplication; results are rounded once, at the end.
const SCALE = 4n
const SCALE_FACTOR = 10_000n

function toMinor(value: string, what = 'amount'): bigint {
  if (!DECIMAL.test(value)) throw new ProcurementError(`"${value}" is not a ${what}`)
  const [whole = '0', fraction = ''] = value.split('.')
  return BigInt(whole + fraction.padEnd(Number(SCALE), '0').slice(0, Number(SCALE)))
}

/** Round half-up to two decimals — the scale money and quantity are stored at. */
function toDecimal(minor: bigint): string {
  const negative = minor < 0n
  const abs = negative ? -minor : minor
  const rounded = (abs + 50n) / 100n
  const digits = rounded.toString().padStart(3, '0')
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/** Multiply two 4-minor-digit values, staying at 4 minor digits. */
const mul = (a: bigint, b: bigint): bigint => (a * b) / SCALE_FACTOR

/**
 * Sum scaled integers. A named helper rather than `a + b + c` at the call site: the
 * `no-float-money` lint rule reads variable NAMES, and `goods + duty + freight` looks
 * exactly like the float arithmetic it exists to stop. Routing the addition through here
 * says "these are scaled integers" in the one place a reader would otherwise have to
 * infer it.
 */
const sumMinor = (...values: readonly bigint[]): bigint => values.reduce((a, b) => a + b, 0n)

/**
 * The sentence a buyer reads when the credit will not cover the order.
 *
 * Pure, exported and tested here rather than composed inside the transaction, for two
 * reasons. The figures ARE the refusal — "short by 88,690.00" is what tells somebody which
 * credit to amend or choose — so getting the wording wrong is a defect about money, and a
 * defect about money deserves a test. And only `details.reason` survives a server action's
 * boundary in production (lib/action-failure.ts), which makes this string the entire message
 * the person will see, not a decoration over a catalogue entry.
 */
export function btbFundingRefusal(facts: {
  btbNumber: string
  creditValue: string
  currency: string
  /** What other purchase orders already ride this credit. '0.00' when none do. */
  committed: string
  poValue: string
  shortfall: string
}): string {
  const alreadyOn =
    facts.committed === '0.00'
      ? 'nothing else is committed to it'
      : `${facts.committed} is already committed to it`

  return (
    `This purchase order is larger than the credit funding it. ${facts.btbNumber} is ` +
    `${facts.creditValue} ${facts.currency}, ${alreadyOn}, and this order is ` +
    `${facts.poValue} — short by ${facts.shortfall}.`
  )
}

/** The same, for an order and a credit denominated differently. */
export function btbCurrencyRefusal(facts: {
  btbNumber: string
  btbCurrency: string
  poCurrency: string
}): string {
  return (
    `This purchase order is in ${facts.poCurrency} and ${facts.btbNumber} is in ` +
    `${facts.btbCurrency}. No rate has been stated to net one against the other.`
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Quote comparison
// ─────────────────────────────────────────────────────────────────────────────

export interface QuoteForComparison {
  quoteId: string
  supplierId: string
  unitPrice: string
  currency: string
  leadTimeDays: number
  /*
   * Null means the quote did not state it. Kept distinct from '0' all the way through the
   * comparison: an unstated duty is a hole in the ranking, a stated 0% is a fact about the
   * quote, and collapsing the two ranks an import quote as though it clears customs free.
   */
  /** Minimum the supplier will run. Above the requirement, the surplus is still bought. */
  moq: string | null
  freight: string | null
  dutyPct: string | null
}

export interface ComparisonRequirement {
  qty: string
  unit: string
  /** Date the material must be in house. */
  neededBy: string
  /** Date lead time is counted from. */
  quotedOn: string
  baseCurrency?: string
  /** currency → units of base per unit of that currency. Required to mix currencies. */
  rates?: Record<string, string>
}

export interface RankedQuote {
  quoteId: string
  supplierId: string
  /** What will actually be bought — the requirement, or the MOQ if it is higher. */
  chargedQty: string
  surplusQty: string
  goodsValue: string
  dutyValue: string
  freightValue: string
  landedTotal: string
  landedUnitCost: string
  /**
   * What the supplier actually asked, in the supplier's own currency.
   *
   * Carried beside the landed figure because the two answer different questions and are NOT
   * interchangeable. Landed cost — converted to the base currency, duty and freight added —
   * is a ranking instrument. A purchase order is a promise to pay THIS supplier, in the
   * currency it invoices, at the price it quoted; duty is owed to customs and freight to a
   * forwarder, and neither is the mill's to collect.
   */
  quotedUnitPrice: string
  quotedCurrency: string
  arrivesOn: string
  currency: string
  /**
   * What this quote never stated, and so is missing from its landed cost.
   *
   * The total is still the best available reading of the quote — it simply cannot include a
   * figure nobody gave. Naming the gap is what stops the cheapest row being read as settled
   * when the row beneath it stated its duty and this one did not.
   */
  unstated: readonly ('duty' | 'freight')[]
}

export interface QuoteComparison {
  baseCurrency: string
  ratesUsed: Record<string, string>
  ranked: RankedQuote[]
  infeasible: { quoteId: string; reasonKey: string; arrivesOn: string }[]
}

/** Calendar-day arithmetic on ISO dates. Lead time is days, not business days. */
function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(parsed.getTime())) throw new ProcurementError(`"${date}" is not a date`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

/**
 * Rank quotes on landed cost, excluding the ones that cannot arrive in time.
 *
 * `infeasible` is returned rather than thrown, and quotes that miss the date are never
 * ranked "last" — a late quote is not a worse option, it is not one, and leaving it in the
 * list is how somebody picks it because the price column looked good.
 */
export function compareQuotes(
  quotes: readonly QuoteForComparison[],
  requirement: ComparisonRequirement,
): QuoteComparison {
  if (quotes.length === 0) {
    throw new ProcurementError('no quotes to compare — refusing to return an empty decision')
  }

  const required = toMinor(requirement.qty, 'quantity')
  if (required <= 0n) throw new ProcurementError('required quantity must be positive')

  const currencies = new Set(quotes.map((q) => q.currency))
  const baseCurrency = requirement.baseCurrency ?? quotes[0]!.currency
  const rates = requirement.rates ?? {}
  const ratesUsed: Record<string, string> = {}

  for (const currency of currencies) {
    if (currency === baseCurrency) continue
    const rate = rates[currency]
    if (!rate) {
      // A comparison across currencies without a stated rate is a number that looks like
      // a decision. Same reason a cost sheet carries its own FX rate.
      throw new ProcurementError(
        `quotes are in ${[...currencies].join(', ')} — a rate to ${baseCurrency} is required for ${currency}`,
      )
    }
    ratesUsed[currency] = rate
  }

  const ranked: RankedQuote[] = []
  const infeasible: { quoteId: string; reasonKey: string; arrivesOn: string }[] = []

  for (const q of quotes) {
    if (!Number.isInteger(q.leadTimeDays) || q.leadTimeDays < 0) {
      throw new ProcurementError(`lead time for quote ${q.quoteId} must be whole days`)
    }

    const arrivesOn = addDays(requirement.quotedOn, q.leadTimeDays)
    if (arrivesOn > requirement.neededBy) {
      infeasible.push({ quoteId: q.quoteId, reasonKey: 'procurement.quote.too_late', arrivesOn })
      continue
    }

    // No MOQ stated is no minimum — the requirement stands on its own.
    const moq = q.moq === null ? 0n : toMinor(q.moq, 'MOQ')
    const chargedQty = moq > required ? moq : required
    const rate = q.currency === baseCurrency ? SCALE_FACTOR : toMinor(ratesUsed[q.currency]!, 'rate')

    const unitPrice = mul(toMinor(q.unitPrice, 'unit price'), rate)
    const goods = mul(unitPrice, chargedQty)
    // Duty is charged on the goods value at the border — freight is not dutiable here.
    // An unstated duty or freight contributes nothing and is REPORTED as unstated, rather
    // than being quietly treated as a quote of zero.
    const unstated: ('duty' | 'freight')[] = []
    if (q.dutyPct === null) unstated.push('duty')
    if (q.freight === null) unstated.push('freight')

    const duty = q.dutyPct === null ? 0n : mul(goods, toMinor(q.dutyPct, 'duty percentage')) / 100n
    const freight = q.freight === null ? 0n : mul(toMinor(q.freight, 'freight'), rate)
    const landed = sumMinor(goods, duty, freight)

    ranked.push({
      quoteId: q.quoteId,
      supplierId: q.supplierId,
      chargedQty: toDecimal(chargedQty),
      surplusQty: toDecimal(chargedQty - required),
      goodsValue: toDecimal(goods),
      dutyValue: toDecimal(duty),
      freightValue: toDecimal(freight),
      landedTotal: toDecimal(landed),
      // Per unit REQUIRED, not per unit charged — the surplus is a cost of this quote,
      // not free stock, and dividing by the charged quantity would hide it.
      landedUnitCost: toDecimal((landed * SCALE_FACTOR) / required),
      quotedUnitPrice: q.unitPrice,
      quotedCurrency: q.currency,
      arrivesOn,
      currency: baseCurrency,
      unstated,
    })
  }

  ranked.sort((a, b) => {
    const diff = toMinor(a.landedTotal) - toMinor(b.landedTotal)
    if (diff !== 0n) return diff < 0n ? -1 : 1
    // Tie on money: the one that lands sooner wins. Nothing else about them differs.
    return a.arrivesOn.localeCompare(b.arrivesOn)
  })

  return { baseCurrency, ratesUsed, ranked, infeasible }
}

// ─────────────────────────────────────────────────────────────────────────────
// PO ↔ GRN line matching
// ─────────────────────────────────────────────────────────────────────────────

export type PoLineStatus = 'open' | 'received_partial' | 'received'

export interface ReceiptMatch {
  receivedQty: string
  outstandingQty: string
  overReceiptQty: string
  withinTolerance: boolean
  closed: boolean
  status: PoLineStatus
}

/**
 * Apply one receipt to a PO line.
 *
 * Over-receipt inside tolerance closes the line: mills cut to the roll, not to the metre,
 * and 2% over on a thousand metres is a normal delivery. Past the allowance the surplus is
 * reported rather than silently accepted — beyond it somebody is paying for fabric nobody
 * ordered.
 */
export function matchReceipt(
  line: { orderedQty: string; receivedQty: string; closed?: boolean },
  receipt: { qty: string },
  options: { overReceiptTolerancePct: string },
): ReceiptMatch {
  if (line.closed) {
    // A closed line is a settled account. Receiving against it silently would reopen a
    // number somebody has already reconciled against an invoice.
    throw new ProcurementError('this PO line is already closed')
  }

  const ordered = toMinor(line.orderedQty, 'ordered quantity')
  const already = toMinor(line.receivedQty, 'received quantity')
  const incoming = toMinor(receipt.qty, 'receipt quantity')

  if (ordered <= 0n) throw new ProcurementError('ordered quantity must be positive')
  if (incoming <= 0n) throw new ProcurementError('a receipt must be a positive quantity')

  const received = already + incoming
  const allowance = mul(ordered, toMinor(options.overReceiptTolerancePct, 'tolerance')) / 100n
  const over = received > ordered ? received - ordered : 0n
  const outstanding = received < ordered ? ordered - received : 0n

  const closed = received >= ordered
  const status: PoLineStatus = closed ? 'received' : 'received_partial'

  return {
    receivedQty: toDecimal(received),
    outstandingQty: toDecimal(outstanding),
    overReceiptQty: toDecimal(over),
    withinTolerance: over <= allowance,
    closed,
    status,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Supplier scoring
// ─────────────────────────────────────────────────────────────────────────────

export interface ScoreObservations {
  /**
   * `onTime` is nullable, and null is not true.
   *
   * A purchase order with no promised delivery date says nothing about whether the supplier
   * was late. This used to read `expectedDeliveryDate === null || closedAt <= expected`, so
   * every receipt against an undated PO counted as a delivery ON TIME — a supplier nobody
   * ever gave a date to scored 100%, and the less carefully a PO was raised the better they
   * looked. Null excludes that receipt from the timeliness question while leaving it in the
   * record as a delivery that happened.
   *
   * `rejectedQty` is nullable for the same reason, and null is not zero.
   *
   * Reject quantities come from quality's inspections, not from the receipt itself, so a
   * caller that cannot reach them must say so. Passing `'0'` instead — which is what the
   * scorer used to be handed for every receipt — reports a spotless quality record for
   * every supplier in the factory, on a screen people use to decide who to buy from.
   */
  receipts: readonly { onTime: boolean | null; rejectedQty: string | null; receivedQty: string }[]
  quotesRequested: number
  quotesReturned: number
  avgUnitPrice: string | null
  basketAvgUnitPrice: string | null
}

export interface SupplierScore {
  onTimePct: string | null
  qualityRejectPct: string | null
  /** 100 is the basket average; 110 means this supplier is 10% dearer than the field. */
  priceIndex: string | null
  responsivenessPct: string | null
  /** How much history the score rests on. A thin score must be readable as thin. */
  observations: number
}

/**
 * A supplier's prices against the field's, over the items both quoted IN THE SAME CURRENCY.
 *
 * Three constraints, each of which this returned a confident wrong number without:
 *
 * **Item by item.** Averaging one supplier's fabric prices against the field's button prices
 * produces a number that moves with what each was asked to quote, not with how dear they are.
 *
 * **Currency by currency.** A local mill quoting 330 BDT/m and an import mill quoting
 * 2.42 USD/m for the same fabric are the same order of price. Pooled, the field average came
 * out around 216 and scored the two BDT suppliers at 146 and 153 while the USD one scored
 * 1.12 — three numbers that look like data. This module never converts at a rate nobody
 * stated (see the domain primer), so the comparison stays inside a currency instead. The key
 * of the outer map is therefore `item|currency`, not `item`.
 *
 * **Two suppliers minimum.** A quote nobody competed with is not cheap or dear; scoring it
 * against itself puts it at exactly 100 and hides that nothing else was offered.
 *
 * Returns null when nothing overlaps — there is no field to be above or below.
 */
export function comparablePrices(
  pricesByItem: ReadonlyMap<string, ReadonlyMap<string, readonly string[]>>,
  supplierId: string,
): { avgUnitPrice: string; basketAvgUnitPrice: string } | null {
  const mean = (values: readonly string[]): bigint =>
    values.reduce((sum, v) => sum + toMinor(v, 'price'), 0n) / BigInt(values.length)

  let theirs = 0n
  let basket = 0n
  let comparable = 0

  for (const bySupplier of pricesByItem.values()) {
    const mine = bySupplier.get(supplierId)
    // Two or more suppliers, or there is nothing to compare against.
    if (!mine || mine.length === 0 || bySupplier.size < 2) continue

    theirs += mean(mine)
    // Each supplier counts once for the item, however many lines they quoted on it —
    // otherwise a supplier who split one item across three lines drags the field average
    // towards their own price and flatters their index.
    basket += mean([...bySupplier.values()].map((prices) => toDecimal(mean(prices))))
    comparable += 1
  }

  if (comparable === 0) return null
  return { avgUnitPrice: toDecimal(theirs), basketAvgUnitPrice: toDecimal(basket) }
}

/**
 * Score a supplier from the record (brief: "never manual vibes").
 *
 * Every metric returns `null` rather than a flattering default when there is nothing to
 * measure. A new supplier is unmeasured, not perfect — reporting 100% on-time would put
 * them top of a ranking on the strength of never having delivered anything.
 */
export function supplierScore(input: ScoreObservations): SupplierScore {
  const receipts = input.receipts

  let onTime: string | null = null
  let rejectPct: string | null = null

  if (receipts.length > 0) {
    // Only receipts whose PO carried a date. Counting the rest as the denominator would
    // understate lateness; counting them as on time overstates the supplier outright.
    const timed = receipts.filter((r) => r.onTime !== null)
    if (timed.length > 0) {
      const onTimeCount = timed.filter((r) => r.onTime === true).length
      onTime = percentage(BigInt(onTimeCount) * SCALE_FACTOR, BigInt(timed.length) * SCALE_FACTOR)
    }

    // Rejects are measured on QUANTITY. "2 of 4 receipts had a reject" would report 50%
    // and condemn a supplier over two bad metres.
    //
    // All or nothing: one receipt with no reject figure makes the whole percentage an
    // understatement, and an understated reject rate is read as a good one. Better to
    // report nothing than a number that is wrong in the flattering direction.
    const measured = receipts.every((r) => r.rejectedQty !== null)

    if (measured) {
      const totalReceived = receipts.reduce((sum, r) => sum + toMinor(r.receivedQty, 'quantity'), 0n)
      const totalRejected = receipts.reduce(
        (sum, r) => sum + toMinor(r.rejectedQty as string, 'quantity'),
        0n,
      )
      rejectPct = totalReceived > 0n ? percentage(totalRejected, totalReceived) : null
    }
  }

  const priceIndex =
    input.avgUnitPrice && input.basketAvgUnitPrice
      ? percentage(toMinor(input.avgUnitPrice, 'price'), toMinor(input.basketAvgUnitPrice, 'price'))
      : null

  const responsiveness =
    input.quotesRequested > 0
      ? percentage(
          BigInt(input.quotesReturned) * SCALE_FACTOR,
          BigInt(input.quotesRequested) * SCALE_FACTOR,
        )
      : null

  return {
    onTimePct: onTime,
    qualityRejectPct: rejectPct,
    priceIndex,
    responsivenessPct: responsiveness,
    observations: receipts.length,
  }
}

/** `part / whole` as a percentage. Both arguments carry 4 minor digits; so does the result. */
function percentage(part: bigint, whole: bigint): string {
  if (whole === 0n) throw new ProcurementError('percentage of zero is undefined')
  return toDecimal((part * 100n * SCALE_FACTOR) / whole)
}
