/**
 * What the store's zod accepts off a real challan.
 *
 * The arithmetic lives in `stock.test.ts`; this file is about the shape of paper. A challan
 * book is not a clean table — it restates, it abbreviates, it writes a roll count on its own
 * row — and a schema that assumes otherwise refuses documents the kit ships as the expected
 * case.
 */
import { describe, expect, it } from 'vitest'

import { challanMaterials } from '../stock'
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

    // The schema accepts the paper as read — including the junk row, because a read schema
    // is handed to the model as JSON Schema and cannot filter (a `.transform()` here cost a
    // second live failure: "Transforms cannot be represented in JSON Schema").
    expect(result.success).toBe(true)
    expect(result.data?.lines).toHaveLength(2)

    // Judging the rows is the next layer's job, and it keeps the material.
    const kept = challanMaterials(result.data!.lines)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.itemCode).toBe('FAB-FLC-280')
    expect(kept[0]?.qty).toBe('1567.0')
  })

  it('keeps a genuine second material', () => {
    // The filter is about identity, not about count — a trims challan really does list four.
    const result = read([
      { itemName: 'YKK zipper 65cm', qty: '42840', unit: 'pcs' },
      { itemName: 'drawcord 8mm', qty: '43260', unit: 'pcs' },
    ])

    expect(result.success).toBe(true)
    expect(challanMaterials(result.data!.lines)).toHaveLength(2)
  })

  it('leaves nothing behind when no row names a material', () => {
    // The screen's own guard: no material, no pre-fill — the form stays for typing.
    const result = read([{ itemName: '', qty: '60', unit: 'rolls' }])
    expect(result.success).toBe(true)
    expect(challanMaterials(result.data!.lines)).toHaveLength(0)
  })
})
