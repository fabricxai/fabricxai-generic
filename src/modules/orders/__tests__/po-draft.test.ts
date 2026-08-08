/**
 * The PO intake reads a PAPER document (live-test finding, Phase 2).
 *
 * The first live buyer_po extraction failed on every field a real PO writes in its own
 * dialect: "Ship date: 15 NOV 2026", "USD 244,800.00", "36,000", and a buyer the model
 * can only name in words while the schema demanded our uuid. These vectors pin the
 * transcription layer with the shapes the live PO actually produced. The strict twins
 * (`createOrderPayload`, `orderStylePayload`) stay strict — the commit path re-validates.
 */
import { describe, expect, it } from 'vitest'

import { orderFromPoDraft } from '../zod'

const BUYER = 'c0ffee00-0000-4000-8000-000000000001'

const draft = (over: Record<string, unknown> = {}) =>
  orderFromPoDraft.parse({
    poNumbers: ['4711-88-2044', 'PO-BF-2044'],
    styles: [{ styleCode: 'JJ-CORE-PL-26' }],
    ...over,
  })

describe('order_from_po_v1 · transcription tolerance', () => {
  it('drops whatever id-shaped string the model transcribed for the buyer', () => {
    // The PO names the buyer in words; the uuid is ours. The intake picker merges the
    // real id in AFTER the provider validates the model's output, so the model's guess
    // must be dropped here, not refused.
    expect(draft({ buyerId: 'BESTSELLER A/S' }).buyerId).toBeUndefined()
    expect(draft({ buyerId: 'CVR 88216512' }).buyerId).toBeUndefined()
    expect(draft({ buyerId: BUYER }).buyerId).toBe(BUYER)
  })

  it('reads money the way a PO writes it', () => {
    expect(draft({ totalValue: 'USD 244,800.00' }).totalValue).toBe('244800.00')
    expect(draft({ styles: [{ styleCode: 'X', unitPrice: 'USD 6.80' }] }).styles[0]!.unitPrice).toBe('6.80')
    // Four-decimal quote formatting: trailing zeros trimmed, never rounded.
    expect(draft({ styles: [{ styleCode: 'X', unitPrice: '6.9500' }] }).styles[0]!.unitPrice).toBe('6.95')
    // A genuine third decimal is NOT quietly rounded — the named refusal survives.
    expect(() => draft({ styles: [{ styleCode: 'X', unitPrice: '6.955' }] })).toThrow()
  })

  it('reads dates the way a PO writes them', () => {
    expect(draft({ plannedExFactoryDate: '15 NOV 2026' }).plannedExFactoryDate).toBe('2026-11-15')
    expect(draft({ plannedExFactoryDate: 'Nov 15, 2026' }).plannedExFactoryDate).toBe('2026-11-15')
    expect(draft({ plannedExFactoryDate: '15.11.2026' }).plannedExFactoryDate).toBe('2026-11-15')
    // Numeric dates read day-first (European buyers); an impossible day-first reading
    // falls back to US order.
    expect(draft({ plannedExFactoryDate: '15/11/2026' }).plannedExFactoryDate).toBe('2026-11-15')
    expect(draft({ plannedExFactoryDate: '11/15/2026' }).plannedExFactoryDate).toBe('2026-11-15')
    expect(draft({ plannedExFactoryDate: '2026-11-15' }).plannedExFactoryDate).toBe('2026-11-15')
  })

  it('an unreadable or impossible date still refuses, with the field named', () => {
    expect(orderFromPoDraft.safeParse({
      poNumbers: ['X'], styles: [{ styleCode: 'X' }], plannedExFactoryDate: 'mid-November',
    }).success).toBe(false)
    expect(orderFromPoDraft.safeParse({
      poNumbers: ['X'], styles: [{ styleCode: 'X' }], plannedExFactoryDate: '0000-00-00',
    }).success).toBe(false)
  })

  it('reads quantities with thousands separators', () => {
    expect(draft({ styles: [{ styleCode: 'X', contractedQty: '36,000' }] }).styles[0]!.contractedQty).toBe(36_000)
    expect(draft({ styles: [{ styleCode: 'X', contractedQty: 36_000 }] }).styles[0]!.contractedQty).toBe(36_000)
  })
})
