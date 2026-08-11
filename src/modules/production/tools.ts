/**
 * MARBIM tools for 6.1 Production — the sewing floor, hour by hour.
 *
 * Read-only, and it registers no pending targets to be otherwise. Everything this module
 * writes is somebody on the floor saying what happened in the last hour: an output count, a
 * downtime start, an endline tally. There is nothing here a model should propose — a
 * drafted hourly output is a claim that work was done, and it would arrive in an approve
 * inbox looking exactly like a count somebody took.
 *
 * **The board's shapes are carried through, not flattened.** `hoursNotEntered` is not zero
 * output; `achievedPct` is null until an hour has a target rather than 0%; an open downtime
 * is a line standing idle right now. A model handed "actual 640, target 800" and nothing
 * else would report a line as 80% when four of its hours have simply not been entered.
 *
 * **The run rate is a forecast and says so.** It projects from trailing days of real output,
 * and it carries how many of those days actually reported — a rate from one day is arithmetic
 * with a denominator of one, and quoting it as a completion date is how a factory promises
 * a ship date it cannot make.
 */
import { z } from 'zod'

import type { AnyCtx } from '../core/ctx'
import { ENTITY_REF_MAX, resolveRef } from '../core/refs'
import type { ReadTool, ToolPack } from '../marbim/tools'

import { activeLines, board, orderRunRate, sewnAgainstOrder, trailingOutput } from './queries'
import type { ProductionPolicy } from './service'

/** The tenant's own behind-target threshold — every factory draws that line differently. */
async function policyFor(ctx: AnyCtx): Promise<ProductionPolicy> {
  const { getPolicy } = await import('@/modules/settings/service')
  return getPolicy<ProductionPolicy>(ctx, 'production')
}

const noArgs = z.object({}).passthrough()

const dayInput = z.object({
  producedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date, YYYY-MM-DD'),
  shiftHours: z.number().int().min(1).max(24).default(10),
})

/**
 * An order, named the way a person can name one: its PO number as the buyer wrote it
 * (`PO-BF-2044`), or its id when a screen already has one. See core/refs.ts.
 */
const orderRef = z.string().min(1).max(ENTITY_REF_MAX)

const orderInput = z.object({
  order: orderRef,
})

const runRateInput = z.object({
  order: orderRef,
  contractedQty: z.number().int().positive(),
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  trailingDays: z.number().int().min(1).max(30).default(3),
})

const trailingInput = z.object({
  order: orderRef,
  asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  days: z.number().int().min(1).max(30).default(7),
})

const dayBoard: ReadTool = {
  kind: 'read',
  name: 'production.board',
  description:
    'Every line for one day, hour by hour: target, actual, variance, achievement, how many ' +
    'hours have NOT been entered, and any downtime open right now. Hours not entered are ' +
    'not zeros — nobody has said what happened in them — so never read a line as behind ' +
    'when its afternoon is simply unrecorded, and say how many hours are missing.',
  input: dayInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const input = dayInput.parse(args)
    // The policy decides what counts as behind; it is not a universal number.
    void (await policyFor(ctx))
    return board(ctx, input)
  },
}

const lines: ReadTool = {
  kind: 'read',
  name: 'production.lines',
  description: 'The active sewing lines with their codes — how the floor is named.',
  input: noArgs,
  execute: async (ctx: AnyCtx) => activeLines(ctx),
}

const sewn: ReadTool = {
  kind: 'read',
  name: 'production.sewn_against_order',
  description:
    'Total pieces sewn against an order to date. This is output, not shipped and not packed ' +
    '— do not use it to answer whether an order is complete.',
  input: orderInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { order } = orderInput.parse(args)
    return sewnAgainstOrder(ctx, await resolveRef(ctx, 'order', order))
  },
}

const trailing: ReadTool = {
  kind: 'read',
  name: 'production.trailing_output',
  description:
    'Daily output on an order over a window, one row per day that reported. A day missing ' +
    'from the list produced nothing OR was never entered, and the two are different — say ' +
    'which days are present rather than averaging over the window as though it were full.',
  input: trailingInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { order, ...rest } = trailingInput.parse(args)
    return trailingOutput(ctx, { ...rest, orderId: await resolveRef(ctx, 'order', order) })
  },
}

const rate: ReadTool = {
  kind: 'read',
  name: 'production.run_rate',
  description:
    'Pieces still to sew on an order, the recent daily rate, and the date that rate would ' +
    'finish it. A FORECAST, not a plan: it assumes the last few days repeat. Always quote ' +
    'how many days it rests on — a rate from one reporting day is not a trend — and never ' +
    'give the completion date on its own.',
  input: runRateInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { order, ...rest } = runRateInput.parse(args)
    return orderRunRate(ctx, { ...rest, orderId: await resolveRef(ctx, 'order', order) })
  },
}

export const productionToolPack: ToolPack = {
  moduleId: 'production',
  tools: [dayBoard, lines, sewn, trailing, rate],
}
