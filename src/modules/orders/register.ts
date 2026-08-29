/**
 * Module registration for 1.3 (brief step 8).
 *
 * The `pendingTargets` list is a security boundary, not configuration: it is the
 * whitelist `pending_changes` checks at insert AND at approve, so a table missing from it
 * is a table no AI draft can ever reach (CLAUDE.md rule 3). Keep it minimal — orders and
 * breakdowns are the only things MARBIM has any business drafting.
 */
import { registerModule } from '../core/registry'

import { applyOrderFromPo, applyRevision } from './service'
import { ordersToolPack } from './tools'
import { ORDERS_ZOD_MAP } from './zod'

export const ordersModule = registerModule({
  id: 'orders',

  // Deliberately NOT here: order_lcs (linking a credit is a commercial decision),
  // tna_milestones (dates are computed by the engine, never drafted), order_revisions
  // (written by the service as evidence, so a draft could forge a paper trail).
  pendingTargets: ['orders', 'order_breakdowns'],
  refResolvers: {
    /* `PO-BF-2044` — the buyer's own number, or the supplier reference beside it. */
    order: async (ctx, ref) => {
      const { orderIdByPoNumber } = await import('./queries')
      return orderIdByPoNumber(ctx, ref)
    },
  },

  /**
   * The order peek (spec §3) — what a PO chip on any screen opens. Same audience as the
   * order desk's nav entry: the roles that may open `/orders` may peek one, and the
   * shipment clerk mid-packing reads the order without losing their place.
   */
  drawers: {
    order: {
      roles: ['merchandiser', 'commercial', 'planner', 'production', 'viewer', 'shipment'],
      peek: async (ctx, id) => {
        const { orderDetail, orderFileRefs } = await import('./queries')
        const detail = await orderDetail(ctx, id)
        if (!detail) return null

        const files = await orderFileRefs(ctx, id)
        const primaryPo = detail.poNumbers[0] ?? detail.id.slice(0, 8)

        return {
          kind: 'order',
          id: detail.id,
          // The buyer's own number is the identity; extra POs ride as a count, the way
          // the desk's list shows them.
          title:
            detail.poNumbers.length > 1
              ? `${primaryPo} +${detail.poNumbers.length - 1}`
              : primaryPo,
          subtitle: [detail.buyerName, detail.style?.styleCode].filter(Boolean).join(' · '),
          // The status VALUE with the health TONE: the same words the desk's badges use,
          // coloured by the worst thing true about the order.
          status: {
            label: detail.status,
            tone: (
              { ok: 'success', risk: 'warning', late: 'danger', done: 'neutral' } as const
            )[detail.health],
          },
          facts: [
            ...(detail.style?.contractedQty != null
              ? [
                  {
                    labelKey: 'ui.peek.order_qty',
                    value: detail.style.contractedQty.toLocaleString('en-US'),
                    mono: true,
                  },
                ]
              : []),
            ...(detail.totalValue
              ? [
                  {
                    labelKey: 'ui.peek.order_value',
                    value: `${detail.currency} ${detail.totalValue}`,
                    mono: true,
                  },
                ]
              : []),
            ...(detail.plannedExFactoryDate
              ? [
                  {
                    labelKey: 'ui.peek.order_ship',
                    value: detail.plannedExFactoryDate,
                    mono: true,
                  },
                ]
              : []),
          ],
          href: `/orders/${detail.id}`,
          // Filed papers peek onward — the drawer's one-level stack in its natural use.
          related: files.map((file) => ({
            kind: 'document',
            reference: file.documentId,
            label: file.label ?? file.filename,
          })),
        }
      },
    },
  },

  zodMap: ORDERS_ZOD_MAP,

  /**
   * The ripple, chiefly. The primer already told MARBIM never to compute a date and to call
   * previewRipple instead — against a tool that did not exist until now.
   */
  toolPack: ordersToolPack,

  /**
   * Committing a breakdown revision is not an INSERT: it replaces the grid, bumps the
   * revision pointer and writes the evidence row. Core's generic write would produce one
   * orphan `order_breakdowns` row and leave the floor cutting to the old ratio.
   *
   * `orders` needs one for a blunter reason: core's generic write treats payload keys as
   * literal column names, so a PO draft's `poNumbers` was refused as an invalid identifier
   * and no order drafted from a document could ever be approved. It also has styles to
   * insert and an `orders.created` event the TNA engine waits on.
   */
  commitHandlers: { order_breakdowns: applyRevision, orders: applyOrderFromPo },

  // Breakdown edits after production start route to a manager (brief §Roles). Merchandisers
  // own their buyers' orders but cannot approve a change that costs the factory money.
  approvalDefaults: {
    requiredRoles: ['owner', 'admin', 'merchandiser'],
    /*
     * A merchandiser may sign the reading of a document they are holding.
     *
     * Every ⚖ table this module owns — `orders`, `order_breakdowns`, `order_revisions` —
     * is written from a buyer's paper: the PO that opens the order, the amendment mail
     * that moves quantities between colours. The person who received that mail is the only
     * one who can say the grid matches it; an approver two desks away is being asked to
     * confirm a document they do not have, which is a signature that means nothing.
     *
     * Narrower than it looks: core still refuses this for anything the person typed
     * themselves, whatever this says. And a factory whose buyer audit demands separated
     * duties turns it off in Settings → Approval routing without a deploy.
     */
    selfApprovalAllowed: true,
  },

  /**
   * The department's craft, versioned. This teaches MARBIM WHEN to call a computation and
   * how to narrate the answer; it never contains the computation itself, which lives in
   * service.ts and tna.ts where it can be tested (CLAUDE.md, module folder contract).
   */
  domainPrimer: {
    version: '1.3.0',
    text: `You are helping a merchandiser run the order desk of a Bangladeshi garment
export factory.

WHAT THE NUMBERS MEAN
- Ex-factory date is when goods leave the factory, not when they reach the buyer. Every
  TNA milestone is scheduled backward from it.
- A milestone that is "at risk" is the only one anyone can still act on. "Late" is a
  report about the past. Lead with at-risk items.
- A breakdown is the colour x size grid the cutting floor works to. Quantities are
  pieces, always whole numbers.

WHAT YOU MUST NOT DO
- Never compute or guess a date. Call previewRipple and quote what it returns. Slip
  arithmetic depends on per-edge lead times you cannot see.
- Never state a money figure you have not read from a tool result.
- Never say an order is safe against an LC. Call the conflict detector; latest-shipment
  and expiry breaches mean the bank can refuse the documents and the factory does not
  get paid.

HOW TO NARRATE A SLIP
Say what moved, by how many days, and whether the ship date moved. "Fabric landed six
days late; cutting moves to 22 May and ex-factory to 6 July" is useful. "There may be
some delay" is not. If the ship date did not move, say the slack absorbed it — that is
the reassuring answer and it is worth giving explicitly.

DRAFTS
You may draft a new order from a buyer PO, and a breakdown revision from a buyer's
amendment email. Both go to a human. Attach the per-field confidence your extraction
produced; never invent one, and never present a low-confidence figure as settled.`,
  },
})
