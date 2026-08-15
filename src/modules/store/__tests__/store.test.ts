/**
 * What the store's zod accepts off a real challan.
 *
 * The arithmetic lives in `stock.test.ts`; this file is about the shape of paper. A challan
 * book is not a clean table — it restates, it abbreviates, it writes a roll count on its own
 * row — and a schema that assumes otherwise refuses documents the kit ships as the expected
 * case.
 */
import { describe, expect, it } from 'vitest'

import { grnFromChallanDraft } from '../zod'

describe('grnFromChallanDraft · a challan book is not a clean table', () => {
  const read = (lines: unknown[]) =>
    grnFromChallanDraft.safeParse({ challanNo: 'ZJH-DC-8842', receivedAt: '2026-11-12', lines })

  it('keeps the material when a second row only restates it as a roll count', () => {
    /*
     * The live failure (Nordkap §6a): row 2 of the challan restates row 1 as "60 rolls",
     * the model returned it with an empty name, and `itemName: z.string().min(1)` threw the
     * whole reading away. A storekeeper next to a truck got "that document could not be
     * read" and a blank form — for a document the kit ships as the expected case.
     */
    const result = read([
      { itemCode: 'FAB-FLC-280', itemName: 'Brushed fleece 280 gsm', qty: '1567.0', unit: 'kg' },
      { itemName: '', qty: '60', unit: 'rolls' },
    ])

    expect(result.success).toBe(true)
    expect(result.data?.lines).toHaveLength(1)
    expect(result.data?.lines[0]?.itemCode).toBe('FAB-FLC-280')
    expect(result.data?.lines[0]?.qty).toBe('1567.0')
  })

  it('keeps a genuine second material', () => {
    // The filter is about identity, not about count — a trims challan really does list four.
    const result = read([
      { itemName: 'YKK zipper 65cm', qty: '42840', unit: 'pcs' },
      { itemName: 'drawcord 8mm', qty: '43260', unit: 'pcs' },
    ])

    expect(result.success).toBe(true)
    expect(result.data?.lines).toHaveLength(2)
  })

  it('refuses only when nothing on the paper names a material', () => {
    const result = read([{ itemName: '', qty: '60', unit: 'rolls' }])
    expect(result.success).toBe(false)
  })
})
