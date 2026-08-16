/**
 * Letters of Credit ⚖ — owned by `commercial` (architecture §2.3, CLAUDE.md rule 11).
 *
 * Created during Phase 3 with module 2.1's schema, because Orders cannot detect an LC
 * conflict against a table that does not exist. Orders links through `order_lcs` and
 * reads through this module — it never writes here.
 *
 * Why the dates carry so much weight: ship after `latest_shipment_date`, or present
 * documents after `expiry_date`, and the bank can refuse. A refused document turns a
 * shipped order into an unpaid one, which is why conflicts on these two columns are red
 * alerts in every screen that touches an order.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { companies, documents, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'

export const lcStatusEnum = pgEnum('lc_status', ['draft', 'active', 'expired', 'closed'])

export const lcs = pgTable(
  'lcs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id, { onDelete: 'restrict' }),

    /** The LC number as the bank issued it. Unique per company. */
    number: text('number').notNull(),

    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    /** Permitted over/under shipment, e.g. 5.00 for ±5%. Straight from the credit. */
    tolerancePct: numeric('tolerance_pct', { precision: 5, scale: 2 }).notNull().default('0'),

    issueDate: date('issue_date'),
    /** Goods must be shipped on or before this date. */
    latestShipmentDate: date('latest_shipment_date'),
    /** Documents must be presented on or before this date. */
    expiryDate: date('expiry_date'),

    /** Clause-derived list of documents the bank will require at presentation. */
    docsRequired: jsonb('docs_required').$type<Record<string, unknown>>().notNull().default({}),

    status: lcStatusEnum('status').notNull().default('draft'),
    /** The scanned credit itself — every figure above should be checkable against it. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lcs_company_number_key').on(t.companyId, t.number),
    index('lcs_company_buyer_idx').on(t.companyId, t.buyerId),
    // The nightly countdown scan: live credits by the date that bites first.
    index('lcs_company_latest_shipment_idx').on(t.companyId, t.latestShipmentDate),
    index('lcs_company_expiry_idx').on(t.companyId, t.expiryDate),
    check('lcs_currency_iso', sql`char_length(${t.currency}) = 3`),
    check('lcs_value_positive', sql`${t.value} > 0`),
    // Presenting documents before the goods may ship is not a thing; a credit whose
    // expiry precedes its latest shipment date was mis-keyed.
    check(
      'lcs_expiry_after_latest_shipment',
      sql`${t.expiryDate} IS NULL OR ${t.latestShipmentDate} IS NULL
        OR ${t.expiryDate} >= ${t.latestShipmentDate}`,
    ),
  ],
).enableRLS()

/**
 * Back-to-back LCs ⚖ — the credits the factory opens against the master to buy fabric and
 * trims. Σ(btb values) must stay within `master.value × btb_limit_pct` (Settings), or the
 * factory owes its suppliers more than the buyer will ever pay it. Enforced as a gate in
 * the service layer, never in the UI.
 */
export const btbLcs = pgTable(
  'btb_lcs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    masterLcId: uuid('master_lc_id')
      .notNull()
      .references(() => lcs.id, { onDelete: 'restrict' }),

    number: text('number').notNull(),
    /**
     * The FK exists in the database (migration 0030) but is deliberately NOT expressed
     * here: `suppliers` is owned by 3.2 Procurement, whose schema already imports
     * `btb_lcs` for the import-PO gate, so declaring it would make the two module schemas
     * import each other. Drizzle diffs against its own snapshot rather than the live
     * database, so an unmodelled constraint is invisible to `db:generate` and safe —
     * but the next reader needs to know it is enforced.
     */
    supplierId: uuid('supplier_id'),

    value: numeric('value', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    openedAt: date('opened_at'),
    expiryDate: date('expiry_date'),

    status: lcStatusEnum('status').notNull().default('draft'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('btb_lcs_company_number_key').on(t.companyId, t.number),
    // The headroom query: every BTB opened against one master.
    index('btb_lcs_master_idx').on(t.companyId, t.masterLcId),
    check('btb_lcs_currency_iso', sql`char_length(${t.currency}) = 3`),
    check('btb_lcs_value_positive', sql`${t.value} > 0`),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Bonded warehouse — Utilization Declarations ⚖ (brief 2.2)
// ─────────────────────────────────────────────────────────────────────────────

export const bankStatusEnum = pgEnum('bank_status', [
  'preparing',
  'submitted',
  'accepted',
  'discrepant',
  'realized',
])
export const bankChargeKindEnum = pgEnum('bank_charge_kind', [
  'lc_opening',
  'amendment',
  'negotiation',
  'discrepancy',
  'courier',
  'swift',
  'acceptance',
  'other',
])

export const udStatusEnum = pgEnum('ud_status', ['active', 'exhausted', 'expired', 'closed'])

/**
 * The customs document authorising duty-free import of specific items in specific
 * quantities, against a promise they leave again as exported garments.
 *
 * `authorized_items` is jsonb rather than a child table on purpose: it is a transcription
 * of what the declaration says, amended only by customs, and it is read as a whole every
 * time the gate runs. Splitting it into rows would invite the application to "correct" a
 * line, and the one thing this data must not be is editable piecemeal.
 */
export const uds = pgTable(
  'uds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    number: text('number').notNull(),
    issueDate: date('issue_date'),
    /** Inclusive — a draw on this date is still valid. */
    validUntil: date('valid_until'),

    /** `UdAuthorizedItem[]` — validated by zod on write, read whole by the gate. */
    authorizedItems: jsonb('authorized_items').$type<unknown[]>().notNull().default([]),

    status: udStatusEnum('status').notNull().default('active'),
    /** The scanned declaration; every figure above should be checkable against it. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('uds_company_number_key').on(t.companyId, t.number),
    // The nightly expiry alert: live declarations by the date that bites.
    index('uds_company_valid_until_idx').on(t.companyId, t.status, t.validUntil),
  ],
).enableRLS()

/**
 * Every draw against a UD ⚖. Written automatically by a bonded store issue, never by
 * hand — the ledger is what a customs reconciliation is built from, so a row here always
 * corresponds to material that actually left the bonded warehouse.
 */
export const udConsumptions = pgTable(
  'ud_consumptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    udId: uuid('ud_id')
      .notNull()
      .references(() => uds.id, { onDelete: 'restrict' }),

    /**
     * No FK yet: `store_issues` belongs to module 3.1 and does not exist. The constraint
     * lands with that module — see docs/STUBS.md.
     */
    storeIssueId: uuid('store_issue_id'),

    /**
     * The issue LINE the draw belongs to, not merely the issue.
     *
     * A draw is made per line, and two lines of one issue routinely carry the same quantity
     * — this factory has two fleece rolls weighing 25.40 kg. Matching a draw back to its
     * material by amount would reverse whichever row the database returned first, which is
     * a customs ledger corrected by coincidence. The line id is the identity.
     *
     * Null on draws recorded before this column; `returnRolls` refuses rather than guesses
     * when it cannot tell those apart.
     */
    storeIssueLineId: uuid('store_issue_line_id'),

    itemRef: text('item_ref').notNull(),
    /** numeric(12,2) per the brief; metres, kilograms or pieces. Never a float. */
    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),

    /**
     * When the draw was given back, and why.
     *
     * A consumption is never deleted and never negated — the check constraint below forbids a
     * negative quantity, and rightly: a customs ledger that can be written downwards is not a
     * ledger. Material that comes back to the bonded store is recorded as a reversal of the
     * draw that took it out, so the paper trail reads "drawn on the 12th, returned on the
     * 16th, because the cloth failed inspection" — which is exactly what an auditor asks.
     *
     * The balance ignores a reversed row. Everything else still sees it.
     */
    reversedAt: timestamp('reversed_at', { withTimezone: true }),
    reversedReason: text('reversed_reason'),

    /** Set when an owner approved a deliberate overdraw through pending_changes. */
    overrideOf: uuid('override_of').references(() => uds.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The gate's own query: every draw against one UD, read under a row lock.
    index('ud_consumptions_ud_idx').on(t.companyId, t.udId, t.itemRef),
    index('ud_consumptions_store_issue_idx').on(t.storeIssueId),
    check('ud_consumptions_qty_positive', sql`${t.qty} > 0`),
  ],
).enableRLS()

/** A period snapshot plus the customs-format PDF generated from it. */
export const udReconciliations = pgTable(
  'ud_reconciliations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    udId: uuid('ud_id')
      .notNull()
      .references(() => uds.id, { onDelete: 'cascade' }),

    /** `YYYY-MM` — reconciliation is monthly. */
    period: text('period').notNull(),
    /** Frozen balances as at generation; the PDF must stay reproducible. */
    snapshot: jsonb('snapshot').$type<Record<string, unknown>>().notNull(),
    generatedDocumentId: uuid('generated_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('ud_reconciliations_ud_period_key').on(t.udId, t.period),
    index('ud_reconciliations_company_period_idx').on(t.companyId, t.period),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// LC amendments and bank submissions ⚖ (brief 2.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every amendment the bank issued, as a versioned DIFF rather than a new set of terms.
 *
 * The diff is what makes the register defensible: "the shipping date was 30 September until
 * amendment 2 moved it to 31 October" is a sentence somebody can check against a SWIFT
 * message. A table of successive full snapshots cannot answer which field the bank actually
 * changed, and that is the question asked when a shipment is refused.
 */
export const lcAmendments = pgTable(
  'lc_amendments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lcId: uuid('lc_id')
      .notNull()
      .references(() => lcs.id, { onDelete: 'cascade' }),

    /** The bank's own amendment number, 1, 2, 3 … unique per LC. */
    number: integer('number').notNull(),
    /** `[{ field, from, to }]` — only what moved. */
    diff: jsonb('diff').$type<unknown[]>().notNull().default([]),
    /** True when the amendment makes the credit harder to draw on. */
    tightened: boolean('tightened').notNull().default(false),
    /** Conflicts the detector found against the AMENDED terms, at the moment it applied. */
    conflictsAfter: jsonb('conflicts_after').$type<unknown[]>().notNull().default([]),

    receivedAt: date('received_at').notNull(),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('lc_amendments_lc_number_key').on(t.lcId, t.number),
    index('lc_amendments_company_lc_idx').on(t.companyId, t.lcId, t.number),
    check('lc_amendments_number_positive', sql`${t.number} >= 1`),
  ],
).enableRLS()

/**
 * A presentation to the bank ⚖. This is the row the factory's cash flow hangs off.
 *
 * `realizedAmount` is stored separately from the invoice value because the bank almost never
 * credits the full amount — charges and any discrepancy fee come off first. Deriving the
 * receivable from the invoice alone would leave every settled account short by the
 * deduction, forever.
 */
export const docSubmissions = pgTable(
  'doc_submissions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lcId: uuid('lc_id')
      .notNull()
      .references(() => lcs.id, { onDelete: 'restrict' }),
    /** No FK: `shipments` belongs to 8.1 and imports this module — see docs/STUBS.md. */
    shipmentId: uuid('shipment_id'),

    /** `[{ kind, documentId, status }]` — copied from the shipment's checklist at handoff. */
    docs: jsonb('docs').$type<unknown[]>().notNull().default([]),
    invoicedAmount: numeric('invoiced_amount', { precision: 14, scale: 2 }),
    currency: text('currency').notNull(),

    bankStatus: bankStatusEnum('bank_status').notNull().default('preparing'),
    submittedAt: date('submitted_at'),

    /** What the bank objected to. Required by the service when status is `discrepant`. */
    discrepancyNotes: text('discrepancy_notes'),
    discrepantSince: date('discrepant_since'),

    realizedAmount: numeric('realized_amount', { precision: 14, scale: 2 }),
    realizedAt: date('realized_at'),
    /** Why the credit fell short by more than bank charges would explain. */
    shortfallReason: text('shortfall_reason'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // One live submission per shipment. A re-presentation reuses the row — its history is
    // the audit log, because the bank treats it as the same presentation.
    uniqueIndex('doc_submissions_shipment_key')
      .on(t.shipmentId)
      .where(sql`shipment_id IS NOT NULL`),
    index('doc_submissions_company_lc_idx').on(t.companyId, t.lcId),
    index('doc_submissions_company_status_idx').on(t.companyId, t.bankStatus),
    // The discrepancy-aging scan.
    index('doc_submissions_discrepant_idx').on(t.companyId, t.discrepantSince),
    // The realization-lag model reads submitted → realized pairs.
    index('doc_submissions_company_realized_idx').on(t.companyId, t.realizedAt),
    check('doc_submissions_currency_iso', sql`char_length(${t.currency}) = 3`),
    // A submitted presentation has a date; the aging clock depends on it.
    check(
      'doc_submissions_submitted_has_date',
      sql`${t.bankStatus} IN ('preparing') OR ${t.submittedAt} IS NOT NULL`,
    ),
    check(
      'doc_submissions_discrepant_has_notes',
      sql`${t.bankStatus} <> 'discrepant'
        OR (${t.discrepancyNotes} IS NOT NULL AND ${t.discrepantSince} IS NOT NULL)`,
    ),
    check(
      'doc_submissions_realized_has_amount',
      sql`${t.bankStatus} <> 'realized'
        OR (${t.realizedAmount} IS NOT NULL AND ${t.realizedAt} IS NOT NULL)`,
    ),
  ],
).enableRLS()

/**
 * What the bank charged ⚖. Attached to an LC or to a specific submission — opening
 * commission belongs to the credit, negotiation and discrepancy fees to the presentation.
 * Both feed 11.1's commercial cost component, so neither can be a note in a comment field.
 */
export const bankCharges = pgTable(
  'bank_charges',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lcId: uuid('lc_id').references(() => lcs.id, { onDelete: 'cascade' }),
    submissionId: uuid('submission_id').references(() => docSubmissions.id, {
      onDelete: 'cascade',
    }),

    kind: bankChargeKindEnum('kind').notNull(),
    amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
    currency: text('currency').notNull(),
    chargedOn: date('charged_on').notNull(),
    note: text('note'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('bank_charges_company_lc_idx').on(t.companyId, t.lcId),
    index('bank_charges_submission_idx').on(t.submissionId),
    index('bank_charges_company_charged_idx').on(t.companyId, t.chargedOn),
    check('bank_charges_currency_iso', sql`char_length(${t.currency}) = 3`),
    check('bank_charges_amount_positive', sql`${t.amount} > 0`),
    // A charge belongs to a credit or to a presentation. One with neither cannot be
    // attributed to an order, which is the only reason it is recorded.
    check(
      'bank_charges_has_parent',
      sql`${t.lcId} IS NOT NULL OR ${t.submissionId} IS NOT NULL`,
    ),
  ],
).enableRLS()
