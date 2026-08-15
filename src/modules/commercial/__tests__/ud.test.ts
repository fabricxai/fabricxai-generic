/**
 * UD balance vectors — written before the implementation.
 *
 * A Utilization Declaration is the customs document that lets a factory import fabric and
 * trims duty-free, on the promise that they leave again as exported garments. It
 * authorises specific items in specific quantities. Issuing more bonded material than the
 * UD authorises is not an inventory discrepancy — it is a customs violation, and the
 * exposure is duty plus penalty on goods the factory has already cut.
 *
 * That is why this is a hard server-side block rather than a warning, and why the
 * arithmetic is exact. Quantities are `numeric(12,2)` decimal strings (metres, kilograms,
 * pieces); a float here is the same class of bug as a float on money, with a customs
 * inspector at the end of it instead of an accountant.
 */
import { describe, expect, it } from 'vitest'

import {
  computeUdBalance,
  checkUdDraw,
  UdError,
  type UdAuthorizedItem,
  type UdConsumption,
} from '../ud'

const AUTHORIZED: UdAuthorizedItem[] = [
  { itemRef: 'FAB-COTTON-160GSM', qty: '12000.00', unit: 'M' },
  { itemRef: 'FAB-RIB-2X1', qty: '850.500', unit: 'KG' },
  { itemRef: 'TRM-BUTTON-18L', qty: '48000', unit: 'PCS' },
]

const UD = {
  id: 'ud-1',
  number: 'UD/DHK/2026/0417',
  status: 'active' as const,
  validUntil: '2026-12-31',
  authorizedItems: AUTHORIZED,
}

const TODAY = '2026-06-15'

describe('computeUdBalance', () => {
  it('1 · reports the full authorisation when nothing has been drawn', () => {
    const balance = computeUdBalance({ authorizedItems: AUTHORIZED, consumptions: [] })

    expect(balance.get('FAB-COTTON-160GSM')).toMatchObject({
      authorized: '12000.00',
      consumed: '0.00',
      free: '12000.00',
      unit: 'M',
    })
  })

  it('2 · accumulates every consumption against its item', () => {
    const consumptions: UdConsumption[] = [
      { itemRef: 'FAB-COTTON-160GSM', qty: '3000.00', unit: 'M' },
      { itemRef: 'FAB-COTTON-160GSM', qty: '1500.50', unit: 'M' },
      { itemRef: 'TRM-BUTTON-18L', qty: '12000', unit: 'PCS' },
    ]

    const balance = computeUdBalance({ authorizedItems: AUTHORIZED, consumptions })

    expect(balance.get('FAB-COTTON-160GSM')).toMatchObject({
      consumed: '4500.50',
      free: '7499.50',
    })
    expect(balance.get('TRM-BUTTON-18L')).toMatchObject({ consumed: '12000.00', free: '36000.00' })
    // Untouched items still report their full authorisation.
    expect(balance.get('FAB-RIB-2X1')).toMatchObject({ consumed: '0.00', free: '850.50' })
  })

  it('3 · is exact — the arithmetic never goes through a float', () => {
    // 0.1 + 0.2 = 0.30000000000000004 in float. Three draws of a tenth of a metre must
    // leave exactly 0.70 of a metre, not 0.7000000000000001.
    const balance = computeUdBalance({
      authorizedItems: [{ itemRef: 'FAB-X', qty: '1.00', unit: 'M' }],
      consumptions: [
        { itemRef: 'FAB-X', qty: '0.10', unit: 'M' },
        { itemRef: 'FAB-X', qty: '0.10', unit: 'M' },
        { itemRef: 'FAB-X', qty: '0.10', unit: 'M' },
      ],
    })

    expect(balance.get('FAB-X')?.consumed).toBe('0.30')
    expect(balance.get('FAB-X')?.free).toBe('0.70')
  })

  it('4 · refuses a consumption in a different unit rather than converting it', () => {
    // 500 kg of a fabric authorised in metres is not 500 metres, and guessing a
    // conversion factor is how a factory ends up over-drawn on paper and short on cloth.
    expect(() =>
      computeUdBalance({
        authorizedItems: AUTHORIZED,
        consumptions: [{ itemRef: 'FAB-COTTON-160GSM', qty: '500.00', unit: 'KG' }],
      }),
    ).toThrow(/unit/i)
  })
})

describe('checkUdDraw · the gate', () => {
  const draw = (over: Partial<Parameters<typeof checkUdDraw>[0]> = {}) =>
    checkUdDraw({
      ud: UD,
      consumptions: [],
      itemRef: 'FAB-COTTON-160GSM',
      qty: '1000.00',
      unit: 'M',
      today: TODAY,
      ...over,
    })

  it('5 · allows a draw inside the free balance', () => {
    const result = draw()
    expect(result.allowed).toBe(true)
    expect(result.free).toBe('12000.00')
    expect(result.remainingAfter).toBe('11000.00')
  })

  it('6 · allows drawing the balance down to exactly zero', () => {
    // The boundary matters: refusing the last legitimate metre is as wrong as allowing
    // one too many, and it strands material the factory has already paid duty-free for.
    const result = draw({ qty: '12000.00' })
    expect(result.allowed).toBe(true)
    expect(result.remainingAfter).toBe('0.00')
  })

  it('7 · blocks an overdraw by even the smallest unit, and says by how much', () => {
    const result = draw({ qty: '12000.01' })

    expect(result.allowed).toBe(false)
    expect(result.reasonKey).toBe('commercial.ud.insufficient_balance')
    expect(result.shortfall).toBe('0.01')
  })

  it('7b · the refusal carries the balance, the ask and the shortfall in words', () => {
    /*
     * A bonded overdraw is the hardest block in the building, and until this it reached the
     * storekeeper as a generic sentence with no numbers: none of the five UD reason keys had
     * catalogue copy, and the copy written for this one sat under `gates.ud_balance.
     * insufficient`, which nothing throws. Only `reason` survives a server action's boundary,
     * so the sentence is composed here — and the figures are how somebody decides whether to
     * split the issue or fetch an owner.
     */
    const result = draw({ qty: '12000.01' })
    const reason = String(result.facts?.reason ?? '')

    expect(reason).toContain('UD/DHK/2026/0417')
    expect(reason).toContain('12000.00 M')      // free
    expect(reason).toContain('12000.01')        // asked for
    expect(reason).toContain('0.01')            // over by
    expect(reason).toMatch(/owner can approve/i)
    // The failure this replaces: braces reaching the floor.
    expect(reason).not.toMatch(/[{}]/)
  })

  it('7c · every UD refusal says something, never just a key', () => {
    const refusals = [
      draw({ qty: '99999.00' }),
      draw({ itemRef: 'FAB-NOT-ON-UD' }),
      draw({ unit: 'KG' }),
      draw({ ud: { ...UD, status: 'closed' } }),
      draw({ ud: { ...UD, validUntil: '2020-01-01' } }),
    ]

    for (const refusal of refusals) {
      expect(refusal.allowed).toBe(false)
      const reason = String(refusal.facts?.reason ?? '')
      expect(reason.length).toBeGreaterThan(20)
      expect(reason).not.toMatch(/[{}]/)
    }
  })

  it('8 · blocks a draw against an item the UD never authorised', () => {
    // Unknown is not the same as unlimited. A bonded issue of something not on the UD is
    // exactly what customs looks for.
    const result = draw({ itemRef: 'FAB-NOT-ON-UD' })

    expect(result.allowed).toBe(false)
    expect(result.reasonKey).toBe('commercial.ud.item_not_authorized')
  })

  it('9 · blocks a draw in the wrong unit', () => {
    const result = draw({ unit: 'KG' })

    expect(result.allowed).toBe(false)
    expect(result.reasonKey).toBe('commercial.ud.unit_mismatch')
  })

  it('10 · blocks against an expired UD', () => {
    const result = draw({ today: '2027-01-01' })

    expect(result.allowed).toBe(false)
    expect(result.reasonKey).toBe('commercial.ud.expired')
  })

  it('11 · allows a draw on the last valid day', () => {
    // "Valid until" includes the day itself; an off-by-one here shuts a bonded store
    // down a day early.
    expect(draw({ today: '2026-12-31' }).allowed).toBe(true)
  })

  it('12 · blocks against a UD that is not active', () => {
    for (const status of ['exhausted', 'expired', 'closed'] as const) {
      const result = draw({ ud: { ...UD, status } })
      expect(result.allowed).toBe(false)
      expect(result.reasonKey).toBe('commercial.ud.not_active')
    }
  })

  it('13 · accounts for what has already been drawn', () => {
    const result = draw({
      consumptions: [{ itemRef: 'FAB-COTTON-160GSM', qty: '11500.00', unit: 'M' }],
      qty: '600.00',
    })

    expect(result.allowed).toBe(false)
    expect(result.free).toBe('500.00')
    expect(result.shortfall).toBe('100.00')
  })

  it('14 · refuses a zero or negative draw instead of treating it as free', () => {
    expect(() => draw({ qty: '0.00' })).toThrow(UdError)
    expect(() => draw({ qty: '-5.00' })).toThrow(UdError)
  })

  it('15 · refuses a quantity that is not a decimal', () => {
    expect(() => draw({ qty: '1,000.00' })).toThrow(UdError)
  })
})
