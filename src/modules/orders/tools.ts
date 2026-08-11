/**
 * MARBIM tools for 1.3 Order Desk & TNA.
 *
 * The ripple is the whole point of this pack. A merchandiser asked "fabric landed six days
 * late — does the ship date move?" gets an answer that depends on per-edge lead times and
 * the slack sitting between milestones, and the module's own primer forbids working it out
 * in prose for exactly that reason: *"Never compute or guess a date. Call previewRipple and
 * quote what it returns."* That instruction existed against a tool that did not.
 *
 * **`orders.preview_ripple` computes nothing and commits nothing.** It reads the schedule
 * and asks the same pure function `actualizeMilestone` uses, so the dates it quotes are the
 * dates that will actually be written if somebody records the milestone. A preview that
 * disagreed with the write would be worse than no preview.
 *
 * **The revision draft is the expensive one, and it says so.** A buyer amending the colour
 * and size grid mid-production changes what the cutting floor is cutting to; the draft
 * carries the cells and a reason, and `applyRevision` forces `buyerRevision` true whatever
 * the payload claims. Creating a whole ORDER is not a tool here — that arrives as a PO
 * through document intake, where the person holding the paper says which buyer it is from.
 */
import { z } from 'zod'

import type { AnyCtx } from '../core/ctx'
import { ENTITY_REF_MAX, resolveRef } from '../core/refs'
import type { DraftTool, ReadTool, ToolPack } from '../marbim/tools'

import { orderDetail, orderList, ordersInProduction } from './queries'
import { previewRipple } from './service'

const noArgs = z.object({}).passthrough()

/**
 * An order, named the way a person can name one: its PO number as the buyer wrote it
 * (`PO-BF-2044`), or its id when a screen already has one. See core/refs.ts.
 */
const orderRef = z.string().min(1).max(ENTITY_REF_MAX)

const orderInput = z.object({
  order: orderRef,
})

const rippleInput = z.object({
  milestoneId: z.string().uuid(),
  actualDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date, YYYY-MM-DD'),
})

const book: ReadTool = {
  kind: 'read',
  name: 'orders.order_book',
  description:
    'Every order with its buyer, PO numbers, contracted quantity, status and planned ' +
    'ex-factory date. Use it to find an order id before reaching for anything else.',
  input: noArgs,
  execute: async (ctx: AnyCtx) => orderList(ctx, { now: new Date() }),
}

const detail: ReadTool = {
  kind: 'read',
  name: 'orders.order_detail',
  description:
    'One order in full: its styles, the colour and size breakdown the floor works to, and ' +
    'its TNA milestones with planned and actual dates. A milestone that is AT RISK is the ' +
    'only one anybody can still act on — "late" is a report about the past, so lead with ' +
    'the at-risk ones.',
  input: orderInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { order } = orderInput.parse(args)
    const orderId = await resolveRef(ctx, 'order', order)
    return orderDetail(ctx, orderId)
  },
}

const running: ReadTool = {
  kind: 'read',
  name: 'orders.in_production',
  description:
    'Orders currently on the floor with their quantities and ex-factory dates — what the ' +
    'factory is actually committed to this month.',
  input: noArgs,
  execute: async (ctx: AnyCtx) => ordersInProduction(ctx),
}

const ripple: ReadTool = {
  kind: 'read',
  name: 'orders.preview_ripple',
  description:
    'If this milestone actually happened on this date, what moves? Returns every downstream ' +
    'milestone that shifts, by how many days, and whether the ex-factory date moves with ' +
    'them. Nothing is written. Never work a slip out yourself — the arithmetic depends on ' +
    'per-edge lead times you cannot see, and if the ship date does NOT move say the slack ' +
    'absorbed it, because that is the reassuring answer and it is worth giving out loud.',
  input: rippleInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const input = rippleInput.parse(args)
    return previewRipple(ctx, input)
  },
}

/**
 * The breakdown revision draft.
 *
 * The CELLS score lowest, and they are the reason this needs a person. A buyer's amendment
 * email says "add 2,000 navy L" in prose, and the grid it becomes is what the cutting floor
 * spreads against — a cell read into the wrong colour is fabric cut for a garment nobody
 * ordered. The reason scores low too: it is what a later reader has to judge the change by.
 */
const proposeRevisionInput = z.object({
  orderStyleId: z.string().uuid(),
  cells: z
    .array(
      z.object({
        color: z.string().min(1),
        size: z.string().min(1),
        qty: z.number().int().min(0),
      }),
    )
    .min(1),
  reason: z.string().min(1),
  documentId: z.string().uuid().optional(),
})

const proposeRevision: DraftTool = {
  kind: 'draft',
  name: 'orders.propose_breakdown_revision',
  targetTable: 'order_breakdowns',
  description:
    'Propose a revised colour and size grid from a buyer’s amendment — the full grid as it ' +
    'should now stand, not the difference. This replaces what the floor is cutting to, so it ' +
    'goes to a merchandiser or manager to approve; it is recorded as a buyer revision ' +
    'whatever else is said about it.',
  input: proposeRevisionInput,
  execute: async (_ctx: AnyCtx, args: unknown) => {
    const revision = proposeRevisionInput.parse(args)

    return {
      targetTable: 'order_breakdowns',
      operation: 'insert' as const,
      zodSchemaKey: 'order_revision_v1',
      payload: revision,
      // Read every cell back. The grid is prose turned into numbers by a machine, and a
      // colour-size cell nobody re-read is a quantity the factory will cut to.
      method:
        'read from a buyer amendment · cells transcribed from prose into a grid, cell by cell',
    }
  },
}

export const ordersToolPack: ToolPack = {
  moduleId: 'orders',
  tools: [book, detail, running, ripple, proposeRevision],
}
