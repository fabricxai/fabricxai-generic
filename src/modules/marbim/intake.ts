/**
 * What MARBIM can be asked to read, and where the draft lands.
 *
 * The canvas promises a drop-zone that works out what a document is before reading it. That
 * classifier does not exist, and guessing would be worse than not offering it: a tech pack
 * filed as a buyer PO puts a wrong draft in somebody's approve inbox, where it looks exactly
 * like a right one.
 *
 * So the person holding the document says what it is. That is not a lesser version of the
 * feature — it is the honest ordering of it. The classifier is a convenience for somebody
 * who already knows the answer; it was never the thing that makes extraction safe. What
 * makes it safe is that every draft goes to `pending_changes` with per-field confidence and
 * a human approves it, and that is true either way.
 *
 * **Every entry is checked against the module registry at load.** A kind naming a target the
 * module never whitelisted would be refused by `propose` at runtime, one upload at a time,
 * long after somebody demoed it. `assertIntakeKinds` turns that into a boot failure.
 *
 * **And every entry must be completable from a document**, which the registry cannot tell
 * you — see the note under the list, and `intake.test.ts`, which asserts it. A schema
 * requiring a UUID is asking the paper for something only this system knows.
 */
import type { Role } from '../core/ctx'
import { AppError } from '../core/errors'
import { listModules } from '../core/registry'

/**
 * A field the PERSON supplies, because the document cannot.
 *
 * `orderFromPoDraft` requires `buyerId`; a buyer's PO names the buyer in words and has never
 * heard of the uuid this system files them under. That is not an undeliverable schema — it
 * is one input the extractor was never going to find, and the person uploading knows it.
 */
export interface IntakeContextField {
  /** The payload field it fills. Must be a required field of the target schema. */
  field: string
  /** What the picker asks, in the words a person would use. */
  label: string
  /** Which list the screen offers. The action resolves it; the id never comes from a form. */
  source: 'buyers' | 'audits'
}

export interface IntakeKind {
  /** Stable id used by the screen and the queued job. */
  id: string
  /** What a person calls this document, in the words they would use. */
  label: string
  /** What the reader should expect to be looking at — shown under the label. */
  hint: string
  moduleId: string
  targetTable: string
  zodSchemaKey: string
  /**
   * Whose document this is.
   *
   * Not decoration and not merely a filter: `readDocument` refuses a kind the caller's role
   * does not hold, so the chips a person sees and the drafts they can queue are the same
   * list. Before this, every role with intake rights could file every kind — a merchandiser
   * could queue a wage gazette into payroll's approve inbox, which is a department's ledger
   * being written by somebody with no standing in it.
   *
   * Owner and admin are added everywhere by `intakeKindsFor` — supervision, not a
   * department. Each entry names its own keyholders, the way a sync handler does.
   */
  roles: readonly Role[]
  /** Ids the schema requires and no document carries. Empty for most kinds. */
  context?: readonly IntakeContextField[]
  /**
   * This kind fills a form and is never queued.
   *
   * Most kinds arrive as a document with nobody standing over it: they are read into a
   * `pending_change` and somebody approves them. A few are the opposite — the person is at
   * the screen, holding the paper, about to save it themselves. A delivery challan is the
   * clearest case: a receipt is not a thing to approve after the fact, because the goods are
   * on the floor or they are not, and the storekeeper next to the truck is the one who knows.
   *
   * Marked, not merely unused, because it changes what is TRUE of the kind. It has no
   * proposable target and therefore no commit handler, so `readDocument` refuses it rather
   * than queueing a job that could only ever die at `propose`, and the intake screen does not
   * offer a chip that leads nowhere.
   */
  fillsFormOnly?: boolean
}

/**
 * The documents a factory actually receives and re-types.
 *
 * Deliberately not every registered target. A `ud_override_v1` or a `pay_payable` is a
 * human decision, not something anybody scans — offering them here would suggest a document
 * exists that does not.
 */
export const INTAKE_KINDS: readonly IntakeKind[] = [
  {
    id: 'buyer_po',
    label: "A buyer's purchase order",
    hint: 'The PO or order sheet a buyer sends. Drafts the order, its quantities and dates.',
    moduleId: 'orders',
    targetTable: 'orders',
    zodSchemaKey: 'order_from_po_v1',
    roles: ['merchandiser'],
    context: [{ field: 'buyerId', label: 'Which buyer sent it?', source: 'buyers' }],
  },
  {
    /*
     * The document Phase 1 of the live test opens with — and the one kind that was never
     * here. The runbook's first instruction is "intake → kind 'buyer enquiry'", the chip did
     * not exist, and the enquiry that starts the whole order-to-cash chain had no door.
     *
     * `rfqs` was already a registered pending target with a schema, so this is the entry and
     * nothing else: the enquiry's buyer is the one id the email cannot carry, and the picker
     * that answers it is the same one a PO uses.
     *
     * It pointed at `rfq` — the MANUAL-ENTRY payload — and no reading against it ever
     * finished: a required `buyerId` uuid and a string-only `targetPrice`, failing every
     * document at the provider call with "buyerId Invalid UUID; targetPrice expected a money
     * amount". `rfq_from_enquiry_v1` is the document-shaped twin, the same way `buyer_po` has
     * `order_from_po_v1` and `lc_swift` has `lc_from_swift_v1`. Naming the strict payload
     * here again is the bug, not a shortcut.
     */
    id: 'buyer_enquiry',
    label: 'A buyer enquiry',
    hint: 'The email or sheet a buyer asks for a price with. Drafts the RFQ, its quantities and target price.',
    moduleId: 'rfq',
    targetTable: 'rfqs',
    zodSchemaKey: 'rfq_from_enquiry_v1',
    roles: ['merchandiser'],
    context: [{ field: 'buyerId', label: 'Which buyer sent it?', source: 'buyers' }],
  },
  {
    /*
     * The highest-volume retype in the building, and the one the screen was already halfway
     * to doing. `/store/receive` has photographed the challan since it was built — uploaded
     * it, filed it against the GRN — and then asked the storekeeper to type what was in the
     * photograph. Every delivery, every day, standing next to a truck.
     *
     * Items are read as text, never as ids: a challan names material the way the supplier
     * writes it, and the screen matches that against the master list.
     */
    id: 'delivery_challan',
    label: 'A delivery challan',
    hint: 'The delivery note that came with the goods. Drafts the receipt, its lines and any rolls.',
    moduleId: 'store',
    targetTable: 'grns',
    zodSchemaKey: 'grn_from_challan_v1',
    roles: ['store', 'procurement'],
    fillsFormOnly: true,
  },
  {
    /*
     * The quote screen did not exist and neither did this. `recordSupplierQuote` has been in
     * the service since 5.5, reachable only from the approve inbox's commit handler — so a
     * procurement officer holding three proformas could compare nothing, because there was
     * nowhere to put any of them.
     */
    id: 'supplier_proforma',
    label: 'A supplier proforma or quotation',
    hint: 'The price a mill or trader sent back. Drafts the quote, its lines and the terms.',
    moduleId: 'procurement',
    targetTable: 'supplier_quotes',
    zodSchemaKey: 'quote_from_proforma_v1',
    roles: ['procurement', 'commercial'],
    fillsFormOnly: true,
  },
  {
    /*
     * The clipboard every sewing line actually keeps. The tablet is meant to replace it and
     * does not — the paper works when the network does not — so what happens instead is
     * somebody typing eleven rows off the sheet at seven in the evening.
     */
    id: 'hourly_sheet',
    label: 'An hourly production sheet',
    hint: "A line's own hourly report for a day. Fills the whole day's hours in one go.",
    moduleId: 'production',
    targetTable: 'hourly_outputs',
    zodSchemaKey: 'hourly_sheet_v1',
    roles: ['production', 'planner'],
    fillsFormOnly: true,
  },
  {
    id: 'cut_sheet',
    label: 'A cutting sheet',
    hint: "The lay's own sheet from the cutting table. Fills what was actually cut, size by size.",
    moduleId: 'cutting',
    targetTable: 'cut_reports',
    zodSchemaKey: 'cut_sheet_v1',
    roles: ['cutting'],
    fillsFormOnly: true,
  },
  {
    id: 'packing_list',
    label: 'A packing list',
    hint: 'The carton list for a shipment. Fills the cartons, their contents and weights.',
    moduleId: 'shipment',
    targetTable: 'cartons',
    zodSchemaKey: 'packing_list_v1',
    roles: ['shipment'],
    fillsFormOnly: true,
  },
  {
    id: 'machine_nameplate',
    label: "A machine's nameplate",
    hint: 'The plate on the machine. Fills its make, model and serial.',
    moduleId: 'maintenance',
    targetTable: 'machines',
    zodSchemaKey: 'machine_nameplate_v1',
    roles: ['maintenance'],
    fillsFormOnly: true,
  },
  {
    id: 'bank_advice',
    label: 'A realization advice',
    hint: "The bank's export-proceeds advice. Fills what landed, when, and what was deducted.",
    moduleId: 'commercial',
    targetTable: 'doc_submissions',
    zodSchemaKey: 'realization_from_advice_v1',
    roles: ['finance', 'commercial'],
    fillsFormOnly: true,
  },
  {
    id: 'ud_scan',
    label: 'A customs Utilization Declaration',
    hint: 'The UD paper for duty-free bonded material. Drafts the authorised items and quantities.',
    moduleId: 'commercial',
    targetTable: 'uds',
    zodSchemaKey: 'ud_from_scan_v1',
    // Commercial holds the customs paper; the store receives against it (runbook #19).
    roles: ['commercial', 'store'],
  },
  {
    /*
     * The credit itself. Runbook #14: "LCs arrive by hand, not by drop — there is no LC
     * intake kind (six kinds, SWIFT is not one)", so both credits in the live test were
     * typed off a bank message, and a transcription typo in one had to be corrected with
     * psql because the register offers no edit.
     *
     * The dates are the reason this is worth reading rather than typing: 44C and 31D are
     * six-digit SWIFT dates, and every shipment crisis in this product is about them.
     */
    id: 'lc_swift',
    label: 'A letter of credit',
    hint: 'The SWIFT MT700 or the bank’s advice of it. Drafts the credit, its two dates and the documents it calls for.',
    moduleId: 'commercial',
    targetTable: 'lcs',
    zodSchemaKey: 'lc_from_swift_v1',
    roles: ['commercial'],
    context: [{ field: 'buyerId', label: 'Whose credit is this?', source: 'buyers' }],
  },
  {
    id: 'tech_pack',
    label: 'A tech pack',
    hint: 'The buyer’s construction sheet. Drafts the bill of materials behind a cost sheet.',
    moduleId: 'costing',
    targetTable: 'boms',
    zodSchemaKey: 'bom_from_tech_pack_v1',
    roles: ['merchandiser'],
  },
  {
    id: 'wage_gazette',
    label: 'A wage gazette notification',
    hint: 'The government grade table. Drafts the grades payroll computes against.',
    moduleId: 'workforce',
    targetTable: 'wage_gazettes',
    zodSchemaKey: 'gazette_from_scan_v1',
    // Wages are hr's ledger. CLAUDE.md rule 9 keeps payroll to hr+owner at the API
    // boundary; the door that drafts into it should not be wider than the door itself.
    roles: ['hr'],
  },
  {
    id: 'audit_report',
    label: 'A compliance audit report',
    hint: 'The auditor’s findings list. Drafts each finding with its severity.',
    moduleId: 'compliance',
    targetTable: 'findings',
    zodSchemaKey: 'findings_batch_v1',
    roles: ['compliance'],
    context: [{ field: 'auditId', label: 'Which audit is this the report for?', source: 'audits' }],
  },
  {
    id: 'measurement_chart',
    label: 'A measurement chart',
    hint: 'The buyer’s points of measure and tolerances. Drafts the chart QC measures against.',
    moduleId: 'quality',
    targetTable: 'measurement_specs',
    zodSchemaKey: 'measurement_spec',
    // It arrives inside the tech pack a merchandiser files, and it is the chart quality
    // measures against — both hands touch it, so both can file it.
    roles: ['merchandiser', 'quality'],
  },
] as const

/*
 * Two kinds were offered here and removed, and the reason is worth keeping.
 *
 * `supplier_quote` and `buyer_terms` both passed every check `assertIntakeKinds` makes —
 * real module, whitelisted target, schema that exists — and were still impossible to
 * complete. `supplierQuotePayload` requires `purchaseRequisitionId`, `supplierId` and a
 * per-line `itemId`; `buyerTermsPayload` requires `buyerId`. All UUIDs, and **no document
 * contains a UUID**. A supplier's quote names "Meghna Knit Composite Ltd"; the id standing
 * for them exists only inside this system. The extraction ran, returned what the paper
 * actually said, and zod rejected it — as it would for every document, forever.
 *
 * Offering a kind that can never produce a draft is worse than not offering it: the person
 * uploads, is told it is queued, and waits for something that is not coming.
 *
 * What would make them offerable is a document-shaped schema that carries the supplier and
 * buyer by NAME, with the resolution to an id happening at commit where a human can confirm
 * "this is the Meghna we already trade with" — which is a real feature, not a schema tweak.
 * `intake.test.ts` fails the moment either is re-added without one.
 */

const BY_ID = new Map(INTAKE_KINDS.map((kind) => [kind.id, kind]))

/**
 * Supervisory roles see every kind.
 *
 * Same two `requireRole` treats as supervisory everywhere else. An owner filing a wage
 * gazette is somebody covering a desk, not a department boundary being crossed.
 */
const SUPERVISORY: readonly Role[] = ['owner', 'admin']

/**
 * The kinds a caller holding these roles may FILE — that is, send to the approve inbox.
 *
 * Form-filling kinds are excluded whoever is asking: they have no proposable target and
 * `readDocument` refuses them, so offering one as a chip on the intake screen would be a
 * door onto a wall. They are reached from their own dialog instead, which is the whole point
 * of them.
 */
export function intakeKindsFor(roles: readonly Role[]): readonly IntakeKind[] {
  const fileable = INTAKE_KINDS.filter((kind) => !kind.fillsFormOnly)
  if (roles.some((role) => SUPERVISORY.includes(role))) return fileable
  return fileable.filter((kind) => kind.roles.some((role) => roles.includes(role)))
}

/**
 * Whether this caller may FILE this kind — the same rule the chips are built from.
 *
 * A form-filling kind cannot be filed by anybody: it has no proposable target, so there is
 * no inbox for it to land in. Answering `false` for everyone keeps this the exact
 * counterpart of `intakeKindsFor` — the wall and the chips are one rule, which is the only
 * way a screen and its submit cannot disagree.
 */
export const mayFileKind = (kind: IntakeKind, roles: readonly Role[]): boolean =>
  !kind.fillsFormOnly && roles.some((role) => SUPERVISORY.includes(role) || kind.roles.includes(role))

/**
 * Whether this caller may READ this kind into their own form.
 *
 * The same desk rule, without the filing question. Reading a challan into the receive screen
 * is the storekeeper's own work — it proposes nothing and needs no inbox — so the only thing
 * that matters is whether this is their department's paper.
 */
export const mayReadKind = (kind: IntakeKind, roles: readonly Role[]): boolean =>
  roles.some((role) => SUPERVISORY.includes(role) || kind.roles.includes(role))

export function intakeKind(id: string): IntakeKind {
  const kind = BY_ID.get(id)
  if (!kind) {
    throw new AppError('validation_failed', 'marbim.errors.unknown_intake_kind', { id })
  }
  return kind
}

/**
 * Prove every kind targets something its module actually registered.
 *
 * Called at module load. `propose` would refuse an unregistered target anyway — but at
 * runtime, on one upload, to one person, after a demo has already promised it works.
 */
export function assertIntakeKinds(): void {
  const modules = new Map(listModules().map((m) => [m.id, m]))

  for (const kind of INTAKE_KINDS) {
    const definition = modules.get(kind.moduleId)
    if (!definition) {
      throw new Error(`intake kind "${kind.id}" names module "${kind.moduleId}", which is not registered`)
    }
    // A form-filling kind proposes nothing, so it needs no proposable target — see
    // `fillsFormOnly`. It still has to name a real schema, checked below.
    if (!kind.fillsFormOnly && !definition.pendingTargets.includes(kind.targetTable)) {
      throw new Error(
        `intake kind "${kind.id}" drafts into "${kind.targetTable}", which ${kind.moduleId} has not registered as a pending target`,
      )
    }
    if (!(kind.zodSchemaKey in definition.zodMap)) {
      throw new Error(
        `intake kind "${kind.id}" names schema "${kind.zodSchemaKey}", which ${kind.moduleId} does not define`,
      )
    }
  }
}
