/**
 * Which order an hour belongs to (§9, F44).
 *
 * The catch-up screen sent TODAY's order while writing a sheet from a past day. On the live
 * tenant that booked 1,295 pieces against no order at all — invisible to the order they were
 * sewn for and to the WIP snapshot, which counts only rows carrying one. With a different
 * order planned that day it would have attached the whole day to the wrong one, silently.
 */
import { describe, expect, it } from 'vitest'

import { lineDayKey, orderForEntry, orderLabel } from '../attribution'

const PLANNED = new Map([
  ['line-a|2026-12-08', 'order-december'],
  ['line-a|2026-08-16', 'order-august'],
])

describe('orderForEntry', () => {
  it('1 · takes the order planned for the day being written', () => {
    expect(
      orderForEntry(PLANNED, { lineId: 'line-a', producedOn: '2026-12-08' }),
    ).toBe('order-december')
  })

  it('2 · the day decides, not the caller — the old bug exactly', () => {
    // A sheet for 8 December, sent with the order the line is running in August.
    expect(
      orderForEntry(PLANNED, {
        lineId: 'line-a',
        producedOn: '2026-12-08',
        orderId: 'order-august',
      }),
    ).toBe('order-december')
  })

  it('3 · falls back to the caller only where no plan exists', () => {
    // Seeds and /api/production/outputs name an order directly, and a day with no plan has
    // nothing better to go on.
    expect(
      orderForEntry(PLANNED, {
        lineId: 'line-a',
        producedOn: '2026-01-01',
        orderId: 'order-named',
      }),
    ).toBe('order-named')
  })

  it('4 · attributes a day nobody planned to nothing, rather than guessing', () => {
    // A blank is recoverable; a wrong attribution is believed.
    expect(orderForEntry(PLANNED, { lineId: 'line-a', producedOn: '2026-01-01' })).toBeNull()
    expect(
      orderForEntry(PLANNED, { lineId: 'line-a', producedOn: '2026-01-01', orderId: undefined }),
    ).toBeNull()
  })

  it('5 · does not carry one line’s plan onto another line', () => {
    expect(orderForEntry(PLANNED, { lineId: 'line-b', producedOn: '2026-12-08' })).toBeNull()
  })
})

describe('lineDayKey', () => {
  it('6 · keys on the line and the day together', () => {
    expect(lineDayKey({ lineId: 'line-a', producedOn: '2026-12-08' })).toBe('line-a|2026-12-08')
    expect(lineDayKey({ lineId: 'line-a', producedOn: '2026-12-09' })).not.toBe(
      lineDayKey({ lineId: 'line-a', producedOn: '2026-12-08' }),
    )
  })
})

describe('orderLabel', () => {
  it('7 · names an order the way the floor says it — PO and style', () => {
    expect(
      orderLabel({ orderId: 'a1b2c3d4-…', poNumbers: ['NKA-PO-70318'], styleCode: 'ST-2815' }),
    ).toBe('NKA-PO-70318 · ST-2815')
  })

  it('8 · drops the separator rather than trailing it when there is no style', () => {
    expect(
      orderLabel({ orderId: 'a1b2c3d4-…', poNumbers: ['NKA-PO-70318'], styleCode: null }),
    ).toBe('NKA-PO-70318')
  })

  it('9 · falls back to a stub of the id when no PO was recorded', () => {
    // Ugly but findable. A blank would leave the confirmation sentence missing the very
    // thing it exists to state.
    expect(orderLabel({ orderId: 'a1b2c3d4-e5f6', poNumbers: [], styleCode: 'ST-2815' })).toBe(
      'a1b2c3d4 · ST-2815',
    )
  })
})
