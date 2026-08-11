/**
 * Module registration for module 2 (commercial): LC register and bonded warehouse.
 *
 * `pendingTargets` is a security boundary, not configuration (CLAUDE.md rule 3).
 * `ud_consumptions` accepts exactly ONE kind of draft: an owner-approved overdraw.
 *
 * It used to be absent altogether, on the grounds that a draw belongs to the store issue
 * that caused it and an AI-written consumption would be a reconciliation nobody can trace
 * to material leaving the warehouse. That reasoning still holds, and it is why the gate has
 * no "proceed anyway": the ONLY route to an overdraw is `proposeUdOverride`, a human asking
 * an owner to accept a stated quantity of legal exposure.
 *
 * **No draft tool may ever target this table.** `assertToolPack` checks a tool's
 * `targetTable` against `pendingTargets` at load, so registering the table here is what
 * makes the human path work — and registering a MARBIM draft tool against it is what would
 * undo the whole argument. Commercial deliberately registers none.
 */
import { registerModule } from '../core/registry'

import { commercialToolPack } from './tools'
import { COMMERCIAL_ZOD_MAP } from './zod'

export const commercialModule = registerModule({
  id: 'commercial',

  // `uds`: transcribing a scanned declaration is exactly the kind of tedious, error-prone
  // typing MARBIM should draft and a human should check.
  // `ud_consumptions`: the owner-approved overdraw, and nothing else — see the file note.
  /*
   * `lcs` joins the list so a credit can arrive by being READ rather than only by being
   * typed. It is the module's own table (rule 11), and it is the one root record the live
   * test had to hand-enter twice — runbook #14 records LCs as register-only, and #17
   * records that a transcription typo in one has no door at all afterwards. A drafted
   * credit at least meets a second pair of eyes before it exists.
   */
  pendingTargets: ['uds', 'ud_consumptions', 'lcs'],

  commitHandlers: {
    /**
     * A credit signed into existence from a draft.
     *
     * Routed through the module rather than core's generic single-row write because
     * everything that makes an LC valid is a rule, not a column: the number must be unique
     * in this company, and the expiry cannot fall before the latest shipment date — a
     * combination the schema forbids with a CHECK, which as a raw driver error would reach
     * the approver as an unreadable failure at the moment they signed.
     *
     * Lazily imported for the same reason as the UD handler below.
     */
    lcs: async (ctx, tx, input) => {
      const { commitLcFromDraft } = await import('./service')
      return commitLcFromDraft(ctx, tx, { payload: input.payload })
    },

    ud_consumptions: async (ctx, tx, input) => {
      // Resolved lazily. A static `import … from './service'` here makes this file part of
      // the service's evaluation graph, and commercial's service is reached from the store
      // (the UD draw) as well as from the registry barrel — which evaluated this module
      // twice and tripped `module "commercial" is already registered`.
      const { commitUdOverride } = await import('./service')
      const result = await commitUdOverride(ctx, tx, { payload: input.payload })
      return { rowId: result.rowId, after: result.after }
    },

    /**
     * A UD transcribed from the customs paper, via MARBIM's intake.
     *
     * Core's generic write cannot do it: `authorizedItems` and `validUntil` are not column
     * names, so it refused them as invalid identifiers at approve time — the draft looked
     * fine right until somebody signed it. The handler also gets the duplicate-number
     * check, and two UD rows sharing a customs number is a bonded balance that
     * double-counts the same authorisation.
     */
    uds: async (ctx, tx, input) => {
      const { commitUdFromScan } = await import('./service')
      return commitUdFromScan(ctx, tx, input)
    },
  },

  zodMap: COMMERCIAL_ZOD_MAP,

  /**
   * Read-only. Everything drafted into this module is a legal document transcription and
   * goes through MARBIM's document intake, where the person holding the paper says what it
   * is — a second route would be a way to propose a customs declaration from a chat.
   */
  toolPack: commercialToolPack,

  // A UD is a customs document and an overdraw is legal exposure. Only the owner or a
  // commercial lead signs one off — never the storekeeper who wants the fabric.
  approvalDefaults: { requiredRoles: ['owner', 'commercial'] },

  domainPrimer: {
    version: '2.2.0',
    text: `You are helping the commercial team of a Bangladeshi garment export factory
with letters of credit and the bonded warehouse.

WHAT THE DOCUMENTS DO
- A Letter of Credit is how the factory gets paid. Two dates end the conversation if
  missed: latest shipment (ship after it and the bank can refuse the documents) and
  expiry (present documents after it, same result).
- A UD (Utilization Declaration) is what allows duty-free import of fabric and trims,
  on the promise they leave again as exported garments. It authorises named items in
  named quantities.

WHAT YOU MUST NOT DO
- Never say an order is safe against an LC without calling the conflict detector.
- Never compute a UD balance yourself. Call the balance tool. Quantities are exact
  decimals and the arithmetic is not something to do in prose.
- Never convert units. 500 kg of a fabric authorised in metres is not 500 metres. If
  the unit does not match, say so and stop.
- Never suggest issuing more than a UD authorises. Overdrawing is a customs violation,
  not a paperwork inconvenience — duty plus penalty on goods already cut. If a
  storekeeper is short, the answer is an owner-approved override with a stated reason,
  or an amended declaration. Say that plainly.

HOW TO NARRATE A BLOCK
Give the numbers: what was asked for, what is free, and the shortfall. "You asked for
600m of FAB-RIB-2X1; 500m is free on UD/DHK/2026/0418, so you are 100m short" is
useful. "Insufficient balance" is not.`,
  },
})
