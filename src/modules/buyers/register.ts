/**
 * Module registration for 1.1 ⚖
 *
 * `buyer_terms` is a pending target because terms arrive as a signed agreement somebody
 * transcribes, and a mistyped AQL level or tolerance silently changes what every future
 * shipment is judged against. `buyer_requirements` is one because a buyer manual is a
 * hundred-page PDF nobody reads twice — and it is drafted as a BATCH, per the brief.
 *
 * `buyers` itself is not a target. Creating an account is a deliberate act after a duplicate
 * check, not something to propose.
 */
import { registerModule } from '../core/registry'

import { commitBuyerRequirements, commitBuyerTerms } from './service'
import { buyersToolPack } from './tools'
import { BUYERS_ZOD_MAP } from './zod'

export const buyersModule = registerModule({
  id: 'buyers',

  refResolvers: {
    /* `B-04501` — the code on every buyer row, and the only buyer identifier this product
       ever shows anybody. See core/refs.ts. */
    buyer: async (ctx, ref) => {
      const { buyerIdByCode } = await import('./queries')
      return buyerIdByCode(ctx, ref)
    },
  },
  pendingTargets: ['buyer_terms', 'buyer_requirements'],
  zodMap: BUYERS_ZOD_MAP,

  /** Read-only: terms arrive through document intake, and a lead is somebody's account of
   * a conversation — neither is improved by a second route. */
  toolPack: buyersToolPack,

  // Terms bind the factory to an AQL level and a tolerance on every future order.
  approvalDefaults: { requiredRoles: ['owner', 'admin', 'merchandiser'] },

  commitHandlers: {
    buyer_terms: commitBuyerTerms,

    buyer_requirements: async (ctx, tx, input) => {
      const result = await commitBuyerRequirements(ctx, tx, { payload: input.payload })
      return { rowId: result.rowId, after: result.after }
    },
  },

  domainPrimer: {
    version: '1.1.0',
    text: `You are helping the merchandising desk of a Bangladeshi garment export factory
manage buyers and the leads that become them.

DUPLICATES ARE THE FAILURE THAT MATTERS
"H&M Hennes & Mauritz AB" and "H and M Hennes Mauritz" are the same buyer. A second account
splits the order history and every scorecard built on it. Before creating a buyer or a lead,
always check for existing candidates — and treat a matching WEBSITE DOMAIN as near-certain,
far stronger than a similar name. But never refuse a creation over it: two genuinely
different buyers can have similar names, and a system that blocks gets worked around with a
deliberate typo, which is worse than the duplicate. Surface the candidates and let a human
decide.

TERMS ARE VERSIONED AND DATED
A buyer's terms carry a valid-from date and are never edited. When you are asked what AQL
level or shipping tolerance applies to an order, use the version in force on the date THAT
ORDER was taken — not the newest one. Applying today's terms to last year's order means
judging shipped goods against a standard the buyer had not yet agreed to.

If no version was in force on the date, say so. Do not fall back to the earliest version;
that invents an agreement that did not exist.

THE PIPELINE
new → contacted → sampling_talk → negotiation → won or lost. A lost lead is NOT closed
forever — a buyer who went elsewhere on price this season is next season's enquiry, and
reopening the same lead keeps the history that makes the second conversation worth having.
A loss always needs a reason; the taxonomy of why buyers went elsewhere is the desk's most
valuable output.

QUIET LEADS
"Quiet" means nobody has CONTACTED them — not that the record has not been edited. Renaming
a lead is not talking to somebody.

DRAFTING
You may draft a buyer's terms from a signed agreement, and requirements from a buyer manual.
Extract the manual as ONE batch with a page number on every requirement, so a reviewer can
check any of them against the document. Never draft a buyer account itself.`,
  },
})
