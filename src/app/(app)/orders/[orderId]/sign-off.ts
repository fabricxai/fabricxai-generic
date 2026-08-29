import type { LcCoverageRow } from '@/modules/commercial/queries'
import type { StyleCostSheet } from '@/modules/costing/queries'
import type { OrderMaterialPo } from '@/modules/procurement/queries'
import type { StyleQuote } from '@/modules/rfq/queries'
import type { PpStatus } from '@/modules/sampling/queries'

/**
 * "What the departments have signed" (design canvas, order dossier).
 *
 * The order's gates in lifecycle order, each answered by the module that owns it. A
 * merchandiser asked "where is this order actually stuck" has to open six screens to find
 * out, and the answer is usually one row of this panel.
 *
 * **Six states, and the last two are the point.** A row that cannot distinguish "nothing
 * recorded" from "nothing to record" tells a comfortable lie — the same defect the LC tile
 * shipped with, where a desk holding no credits at all was told every credit covered its
 * dates. So:
 *
 *   done       the gate is passed
 *   open       it exists and is not finished
 *   attention  it exists and is a problem
 *   none       nothing is recorded, and something should be
 *   off        this factory does not run that module, so the question does not apply
 *   unmodelled FabricXAI has no such artefact at all — see below
 *
 * `unmodelled` covers two of the canvas's seven rows: the order confirmation sheet with
 * its signature chain, and the sales contract. Neither exists as a record here and neither
 * was in the test kit, so they are shown as absent rather than faked — with what IS on
 * file named beneath them, because the sales contract's substance (tolerance, AQL, the
 * nominated lab) is already in the database even though the contract is not.
 *
 * Pure and I/O-free, like `orderPulse`: callers assemble the inputs through each owner's
 * `queries.ts` (rule 11) and this decides only what the row says.
 */
export type SignOffState = 'done' | 'open' | 'attention' | 'none' | 'off' | 'unmodelled'

export interface SignOffRow {
  key: string
  /** The gate, named as the factory names it. */
  label: string
  /** One sentence. Never a number without the thing it is a number of. */
  detail: string
  /** The short state a reader scans down the column. Null where a badge would be noise. */
  badge: string | null
  state: SignOffState
  /** Where to go and see it, when the owning module has a screen. */
  href: string | null
}

export interface SignOffInput {
  order: {
    id: string
    styleCode: string | null
    /** Over/under shipment the buyer accepts. The sales contract's headline term. */
    qtyTolerancePct: string | null
  }
  quote: StyleQuote | null
  costSheet: StyleCostSheet | null
  /** Only this order's rows, from `lcCoverageForOrders`. */
  lcCoverage: readonly LcCoverageRow[]
  materialPos: readonly OrderMaterialPo[]
  pp: PpStatus | null
  /** The buyer's terms in force when the order was taken, from `buyers.termsFor`. */
  terms: { tolerancePct: string; aqlLevel: string; nominatedLabs: readonly string[] } | null
  /** Modules switched on for this factory. An absent one answers "off", never "none". */
  activeModules: ReadonlySet<string>
}

const VERDICT: Record<string, string> = {
  approved: 'approved',
  approved_with_comments: 'approved with comments',
  rejected: 'rejected',
}

export function signOffRows(input: SignOffInput): SignOffRow[] {
  return [
    quoteRow(input),
    costingRow(input),
    confirmationSheetRow(),
    salesContractRow(input),
    creditRow(input),
    materialsRow(input),
    ppRow(input),
  ]
}

function quoteRow({ quote, activeModules }: SignOffInput): SignOffRow {
  const base = { key: 'quote', label: 'Price quote returned', href: '/rfq' as string | null }

  if (!activeModules.has('rfq')) {
    return { ...base, badge: null, state: 'off', href: null, detail: 'The RFQ desk is not switched on here.' }
  }
  if (!quote) {
    /*
     * Not necessarily a gap. An enquiry becomes an order through a person, not a foreign
     * key, so `quoteForStyle` matches on the style code — and a repeat order or a direct
     * placement was never quoted at all. Saying "no quote" flatly would read as a missing
     * step; saying why it might legitimately be missing is the difference between a panel
     * somebody trusts and one they learn to ignore.
     */
    return {
      ...base,
      badge: null,
      state: 'none',
      detail: 'No enquiry for this style was quoted here — a repeat or a direct placement has none.',
    }
  }

  const sent = quote.sentAt ? `, sent ${quote.sentAt.toISOString().slice(0, 10)}` : ' — not sent yet'
  return {
    ...base,
    badge: `v${quote.version}`,
    state: quote.status === 'sent' ? 'done' : 'open',
    href: `/rfq?rfq=${quote.rfqId}`,
    detail: `FOB ${quote.fobPrice} ${quote.currency} · quote v${quote.version}${sent}`,
  }
}

function costingRow({ costSheet, activeModules }: SignOffInput): SignOffRow {
  const base = { key: 'costing', label: 'Costing signed off', href: '/costing' as string | null }

  if (!activeModules.has('costing')) {
    return { ...base, badge: null, state: 'off', href: null, detail: 'The costing studio is not switched on here.' }
  }
  if (!costSheet) {
    return { ...base, badge: null, state: 'none', detail: 'Nothing has been costed for this style.' }
  }

  const money = `FOB ${costSheet.fobPrice} ${costSheet.currency} · CM ${costSheet.cmLocalPerPiece} ${costSheet.localCurrency}/pc · margin ${costSheet.achievedMarginPct}%`

  // A sheet that was costed and never approved is the state worth seeing: the order is
  // being made against a price nobody signed.
  return {
    ...base,
    badge: `v${costSheet.version}`,
    state: costSheet.status === 'approved' ? 'done' : 'open',
    detail:
      costSheet.status === 'approved'
        ? money
        : `${money} — costed but not approved`,
  }
}

function confirmationSheetRow(): SignOffRow {
  /*
   * The canvas draws a signature chain here: Merchandiser → Manager MM → COO → Director →
   * Chairman, each with a date. FabricXAI has no such record, and inventing one from a
   * picture would be inventing product — so the row says so, in the place a reader would
   * otherwise assume the chain was empty.
   *
   * It is not a missing document so much as a missing SEQUENCE. `pending_change_approvals`
   * already stores who signed, as what role and when; what the approvals engine does not
   * do is require the fourth signature to come after the third.
   */
  return {
    key: 'confirmation_sheet',
    label: 'Order confirmation sheet',
    badge: null,
    state: 'unmodelled',
    href: null,
    detail:
      'Not recorded here. FabricXAI has no confirmation sheet and no signature chain — the order’s own approvals are on its timeline instead.',
  }
}

function salesContractRow({ order, terms }: SignOffInput): SignOffRow {
  /*
   * Also unmodelled — but unlike the sheet above, its SUBSTANCE is already in the database.
   * The tolerance is on the order; the AQL level and the nominated lab are in the buyer's
   * terms as at confirmation. What is missing is the contract's identity: its number, its
   * date, the paper itself. Naming the terms that ARE on file is the difference between
   * "we know nothing about your contract" and "we know what it says, not which one it is".
   */
  const known: string[] = []
  if (order.qtyTolerancePct !== null) {
    /*
     * Attributed to the ORDER, not to a contract nobody has filed. Found on a live tenant,
     * where the row read "On file: tolerance ±0.00%" — a schema default (`qty_tolerance_pct`
     * is NOT NULL DEFAULT 0) rendered as a term somebody had negotiated.
     *
     * Zero is not treated as "unknown", because it is not: it is enforced, and a breakdown
     * that misses the contracted quantity by one piece is refused under it. So it is named
     * with its consequence instead — a merchandiser skims past "±0.00%" and does not skim
     * past "exact quantity", which is the thing that will surprise them at shipment.
     */
    // Matched as a string, not parsed. `no-float-money` bans the arithmetic and is right
    // to: "0.00" is a decimal the database wrote, and a regex answers "is it zero" exactly
    // without turning it into a float first.
    const exact = /^0(\.0+)?$/.test(order.qtyTolerancePct) ? ' — exact quantity' : ''
    known.push(`the order allows ±${order.qtyTolerancePct}% over or under${exact}`)
  }
  if (terms?.aqlLevel) known.push(`AQL ${terms.aqlLevel}`)
  if (terms?.nominatedLabs.length) known.push(`nominated lab ${terms.nominatedLabs.join(', ')}`)

  return {
    key: 'sales_contract',
    label: 'Sales contract',
    badge: null,
    state: 'unmodelled',
    href: null,
    detail: known.length
      ? `No contract record — its number and date are not held. On file: ${known.join(' · ')}.`
      : 'No contract record, and no buyer terms on file for this order either.',
  }
}

function creditRow({ order, lcCoverage, activeModules }: SignOffInput): SignOffRow {
  const base = { key: 'credit', label: 'Credit and back-to-back headroom', href: '/lcs' as string | null }

  if (!activeModules.has('commercial')) {
    return { ...base, badge: null, state: 'off', href: null, detail: 'The commercial desk is not switched on here.' }
  }

  const rows = lcCoverage.filter((row) => row.orderId === order.id)
  if (rows.length === 0) {
    // The LC-tile lesson: no credits and no conflicts are different facts, and only one of
    // them is reassuring.
    return { ...base, badge: null, state: 'none', detail: 'No letter of credit is linked to this order.' }
  }

  const conflicted = rows.filter((row) => row.conflict)
  const first = rows[0]!

  if (conflicted.length > 0) {
    const one = conflicted[0]!
    return {
      ...base,
      badge: 'date conflict',
      state: 'attention',
      href: `/lcs/${one.lcId}`,
      detail: `${one.number} will not accept the plan: latest shipment ${one.latestShipmentDate ?? 'unstated'} falls before the order ships.`,
    }
  }

  return {
    ...base,
    badge: rows.length > 1 ? `${rows.length} credits` : 'covered',
    state: 'done',
    href: `/lcs/${first.lcId}`,
    detail: `${first.number} · ${first.headroom.free} ${first.currency} of back-to-back headroom left of ${first.headroom.limit}`,
  }
}

function materialsRow({ materialPos, activeModules }: SignOffInput): SignOffRow {
  const base = { key: 'materials', label: 'Fabric and trims booked', href: '/procurement' as string | null }

  if (!activeModules.has('procurement')) {
    return { ...base, badge: null, state: 'off', href: null, detail: 'Procurement is not switched on here.' }
  }
  if (materialPos.length === 0) {
    return { ...base, badge: null, state: 'none', detail: 'No supplier PO is booked against this order.' }
  }

  // Two named, then a count — a panel row is a headline, and the procurement desk carries
  // the rest. Same rule the LC tile holds to.
  const named = materialPos
    .slice(0, 2)
    .map((po) => {
      const due = po.expectedDeliveryDate ? `, due ${po.expectedDeliveryDate}` : ''
      return `${po.poNumber} ${po.supplierName} · ${po.totalValue} ${po.currency}${due}`
    })
    .join(' · ')
  const rest = materialPos.length > 2 ? ` · and ${materialPos.length - 2} more` : ''

  const landed = materialPos.filter((po) => po.status === 'received').length

  return {
    ...base,
    badge: `${landed}/${materialPos.length} landed`,
    state: landed === materialPos.length ? 'done' : 'open',
    detail: `${named}${rest}`,
  }
}

function ppRow({ pp, activeModules }: SignOffInput): SignOffRow {
  const base = { key: 'pp', label: 'PP sample approved', href: '/sampling' as string | null }

  if (!activeModules.has('sampling')) {
    return { ...base, badge: null, state: 'off', href: null, detail: 'The sampling room is not switched on here.' }
  }
  if (!pp) {
    // Worth naming the consequence rather than the absence: the PP gate is what stops the
    // cutting floor, and "no PP sample" is a sentence a merchandiser can act on only if
    // they are reminded why it matters.
    return {
      ...base,
      badge: null,
      state: 'none',
      detail: 'No PP sample has been requested for this style — cutting cannot start without one.',
    }
  }

  const verdict = pp.latestVerdict ? VERDICT[pp.latestVerdict] ?? pp.latestVerdict : null
  const comments =
    pp.latestVerdict === 'approved_with_comments' && pp.latestComments > 0
      ? ` — ${pp.latestComments} comment${pp.latestComments === 1 ? '' : 's'} that must be in bulk`
      : ''
  const round = pp.rounds > 0 ? `round ${pp.rounds}` : 'no verdict yet'
  const on = pp.latestRecordedOn ? `, ${pp.latestRecordedOn}` : ''

  if (pp.status === 'approved') {
    return {
      ...base,
      badge: round,
      state: 'done',
      href: `/sampling?sample=${pp.id}`,
      detail: `${pp.requestNo} · ${verdict ?? 'approved'}${on}${comments}`,
    }
  }

  return {
    ...base,
    badge: round,
    state: pp.status === 'rejected' ? 'attention' : 'open',
    href: `/sampling?sample=${pp.id}`,
    detail: verdict
      ? `${pp.requestNo} · ${verdict}${on}${comments}`
      : `${pp.requestNo} · ${pp.status.replace(/_/g, ' ')}${pp.dueDate ? `, due ${pp.dueDate}` : ''}`,
  }
}
