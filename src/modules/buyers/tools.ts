/**
 * MARBIM tools for 1.2 Buyer & Lead Desk.
 *
 * The lead pipeline's whole job is to make a QUIET lead impossible to miss, and days-since-
 * last-activity is computed from real activity rather than a row's `updated_at` — so a lead
 * touched by a stage rename is not a lead somebody worked. The tools carry that number
 * through rather than flattening the pipeline to stages and counts.
 *
 * **Terms are read BY DATE, never "current".** 7.1's AQL gate and 8.1's tolerance band both
 * ask what governed an order, and the answer for an order taken in March is March's terms.
 * Asking for today's would quietly re-govern a shipment already made.
 *
 * **No draft tool.** Terms arrive through document intake as a buyer's terms sheet, and a
 * lead is somebody's account of a conversation — neither is improved by a second route.
 */
import { z } from 'zod'

import type { AnyCtx } from '../core/ctx'
import { ENTITY_REF_MAX, resolveRef } from '../core/refs'
import type { ReadTool, ToolPack } from '../marbim/tools'

import { buyerAccounts, pipeline } from './queries'
import {
  listAgents,
  primaryContact,
  quietLeads,
  termsFor,
  type BuyerDeskPolicy,
} from './service'

/** The factory's own quiet-lead window and duplicate threshold. */
async function policyFor(ctx: AnyCtx): Promise<BuyerDeskPolicy> {
  const { getPolicy } = await import('@/modules/settings/service')
  return getPolicy<BuyerDeskPolicy>(ctx, 'buyers')
}

const noArgs = z.object({}).passthrough()

const quietInput = z.object({
  today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date, YYYY-MM-DD'),
})

/**
 * A buyer, named the way a person can name one.
 *
 * `B-04501` — the code on the row — or the uuid, when a screen already has it. It was a uuid
 * only, which is an identifier this product prints nowhere: asked about the code beside the
 * chat panel, the model could see the question, hold the tool, and still have no way to run
 * it. `resolveRef` turns one into the other, exactly, refusing rather than guessing.
 */
const buyerRef = z.string().min(1).max(ENTITY_REF_MAX)

const termsInput = z.object({
  buyer: buyerRef,
  /** The date to ask about. For an existing order this is the date it was TAKEN. */
  on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a calendar date, YYYY-MM-DD'),
})

const buyerInput = z.object({ buyer: buyerRef })

const accounts: ReadTool = {
  kind: 'read',
  name: 'buyers.accounts',
  description: 'Buyer accounts with code, country, status and how many orders are open with each.',
  input: noArgs,
  execute: async (ctx: AnyCtx) => buyerAccounts(ctx),
}

const leads: ReadTool = {
  kind: 'read',
  name: 'buyers.pipeline',
  description:
    'The lead pipeline by stage, with days since each lead was last actually worked. That ' +
    'number comes from recorded activity, not from when the row was edited — a lead nobody ' +
    'has spoken to in three weeks is the point of this list.',
  input: noArgs,
  execute: async (ctx: AnyCtx) => {
    const policy = await policyFor(ctx)
    return pipeline(ctx, { now: new Date(), quietAfterDays: policy.quietAfterDays })
  },
}

const quiet: ReadTool = {
  kind: 'read',
  name: 'buyers.quiet_leads',
  description: 'Leads with no activity for longer than the window — the ones going cold.',
  input: quietInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { today } = quietInput.parse(args)
    return quietLeads(ctx, { today }, await policyFor(ctx))
  },
}

const terms: ReadTool = {
  kind: 'read',
  name: 'buyers.terms_on_date',
  description:
    'The terms that governed a buyer on a given date: payment, incoterm, quantity tolerance, ' +
    'AQL levels and any nominated banks, forwarders or labs. Ask with the date the ORDER was ' +
    'taken, not today — terms are versioned precisely so the answer does not move. ' +
    'The buyer is their code as printed (B-04501) or their id.',
  input: termsInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { buyer, on } = termsInput.parse(args)
    return termsFor(ctx, { buyerId: await resolveRef(ctx, 'buyer', buyer), onDate: on })
  },
}

const contact: ReadTool = {
  kind: 'read',
  name: 'buyers.primary_contact',
  description:
    'The named contact at a buyer, with their role and email — who a clarification, a ' +
    'shipping document or a short-shipment conversation should actually go to. ' +
    'The buyer is their code as printed (B-04501) or their id.',
  input: buyerInput,
  execute: async (ctx: AnyCtx, args: unknown) => {
    const { buyer } = buyerInput.parse(args)
    return primaryContact(ctx, { buyerId: await resolveRef(ctx, 'buyer', buyer) })
  },
}

const agents: ReadTool = {
  kind: 'read',
  name: 'buyers.agents',
  description:
    'Buying agents and their commission terms. An order snapshots the terms as at ' +
    'confirmation, so what an agent is owed on an old order is not necessarily this.',
  input: noArgs,
  execute: async (ctx: AnyCtx) => listAgents(ctx),
}

export const buyersToolPack: ToolPack = {
  moduleId: 'buyers',
  tools: [accounts, leads, quiet, terms, contact, agents],
}
