/**
 * 3.2 Procurement & Suppliers ⚖
 *
 * A supplier PO is the factory committing its own money, which is what makes it the ⚖
 * table here. Two things in this schema are load-bearing beyond the obvious:
 *
 *  1. **Every money column carries its currency.** A mill quotes in USD, a local trims
 *     house in BDT, and a PO total with no currency on it is a number that will be added
 *     to another one at some point.
 *  2. **`supplier_scores` is derived and versioned by period.** Scores are recomputed from
 *     GRN and inspection records monthly, never edited — the brief's "never manual vibes".
 *     A score somebody can type is a score somebody will type.
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
import { btbLcs } from '@/modules/commercial/schema'
import { orders } from '@/modules/orders/schema'
import { items, requisitions } from '@/modules/store/schema'

export const supplierTypeEnum = pgEnum('supplier_type', [
  'fabric_mill',
  'trims',
  'embellishment',
  'subcontract',
  // A knit factory's PRIMARY input, and the enum could not name it — the vocabulary was
  // built with a woven mindset (live-test finding, Phase 4: Square Yarns Ltd had no kind).
  'yarn',
])
export const supplierOriginEnum = pgEnum('supplier_origin', ['local', 'import'])
export const prStatusEnum = pgEnum('pr_status', ['open', 'quoted', 'ordered', 'cancelled'])
export const supplierPoStatusEnum = pgEnum('supplier_po_status', [
  'issued',
  'confirmed',
  'in_production',
  'shipped',
  'received_partial',
  'received',
  'cancelled',
])
export const poLineStatusEnum = pgEnum('po_line_status', [
  'open',
  'received_partial',
  'received',
  'short_closed',
])

export const suppliers = pgTable(
  'suppliers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    type: supplierTypeEnum('type').notNull(),
    /** Import suppliers need a BTB LC before a PO may be issued — see the gate in 5. */
    origin: supplierOriginEnum('origin').notNull(),

    paymentTerms: text('payment_terms'),
    /** [{ name, role, email, phone }] — a mill is a person, not an address. */
    contacts: jsonb('contacts').$type<unknown[]>().notNull().default([]),
    defaultCurrency: text('default_currency').notNull().default('USD'),

    isActive: boolean('is_active').notNull().default(true),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('suppliers_company_code_key').on(t.companyId, t.code),
    index('suppliers_company_type_idx').on(t.companyId, t.type, t.isActive),
    check('suppliers_currency_iso', sql`char_length(${t.defaultCurrency}) = 3`),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Purchase requisition → quotes → PO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the factory needs to buy. Generated from a store requisition (3.1) that could not
 * be met from stock, so `requisition_id` traces a purchase back to the order that caused
 * it — without it, nobody can answer "why did we buy this".
 */
export const purchaseRequisitions = pgTable(
  'purchase_requisitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),
    requisitionId: uuid('requisition_id').references(() => requisitions.id, {
      onDelete: 'set null',
    }),

    prNo: text('pr_no').notNull(),
    /** When the material must be in house. The feasibility bar every quote is judged on. */
    neededBy: date('needed_by').notNull(),
    status: prStatusEnum('status').notNull().default('open'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('purchase_requisitions_company_no_key').on(t.companyId, t.prNo),
    index('purchase_requisitions_company_status_idx').on(t.companyId, t.status, t.neededBy),
    index('purchase_requisitions_company_order_idx').on(t.companyId, t.orderId),
  ],
).enableRLS()

export const purchaseRequisitionLines = pgTable(
  'purchase_requisition_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    purchaseRequisitionId: uuid('purchase_requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('pr_lines_company_pr_idx').on(t.companyId, t.purchaseRequisitionId),
    check('pr_lines_qty_positive', sql`${t.qty} > 0`),
  ],
).enableRLS()

export const supplierQuotes = pgTable(
  'supplier_quotes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    purchaseRequisitionId: uuid('purchase_requisition_id')
      .notNull()
      .references(() => purchaseRequisitions.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),

    currency: text('currency').notNull(),
    quotedOn: date('quoted_on').notNull(),
    validUntil: date('valid_until'),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_quotes_pr_supplier_key').on(t.purchaseRequisitionId, t.supplierId),
    index('supplier_quotes_company_supplier_idx').on(t.companyId, t.supplierId),
    check('supplier_quotes_currency_iso', sql`char_length(${t.currency}) = 3`),
  ],
).enableRLS()

export const supplierQuoteLines = pgTable(
  'supplier_quote_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    supplierQuoteId: uuid('supplier_quote_id')
      .notNull()
      .references(() => supplierQuotes.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),
    leadTimeDays: integer('lead_time_days').notNull(),
    /*
     * Null means the paper did not say — which is NOT the same as a stated zero, and storing
     * it as one is how an unstated duty became "0.00 duty" on the comparison screen and made
     * an import quote look cheaper than it is. The read schema has always modelled absence
     * ("a missing freight figure must stay missing, because a zero would be ranked as free
     * shipping"); the write path defaulted it to '0' and undid that.
     */
    /** Minimum the supplier will run. Above the requirement, the surplus is still bought. */
    moq: numeric('moq', { precision: 12, scale: 2 }),
    freight: numeric('freight', { precision: 14, scale: 2 }),
    dutyPct: numeric('duty_pct', { precision: 5, scale: 2 }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('supplier_quote_lines_company_quote_idx').on(t.companyId, t.supplierQuoteId),
    check('supplier_quote_lines_price_positive', sql`${t.unitPrice} > 0`),
    check('supplier_quote_lines_lead_time_nonneg', sql`${t.leadTimeDays} >= 0`),
  ],
).enableRLS()

/**
 * The factory committing its own money ⚖.
 *
 * `btbLcId` is required before an IMPORT PO may be issued — enforced in the service
 * against commercial's headroom check, not by a constraint here, because the rule is
 * "Σ(btb values) ≤ master × limit%" and a column cannot see the other rows.
 */
export const supplierPos = pgTable(
  'supplier_pos',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'restrict' }),
    purchaseRequisitionId: uuid('purchase_requisition_id').references(
      () => purchaseRequisitions.id,
      { onDelete: 'set null' },
    ),
    /** Which quote was accepted. The comparison that chose it is on the audit row. */
    supplierQuoteId: uuid('supplier_quote_id').references(() => supplierQuotes.id, {
      onDelete: 'set null',
    }),

    poNumber: text('po_number').notNull(),
    currency: text('currency').notNull(),
    totalValue: numeric('total_value', { precision: 14, scale: 2 }).notNull(),

    btbLcId: uuid('btb_lc_id').references(() => btbLcs.id, { onDelete: 'restrict' }),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    expectedDeliveryDate: date('expected_delivery_date'),
    status: supplierPoStatusEnum('status').notNull().default('issued'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_pos_company_number_key').on(t.companyId, t.poNumber),
    index('supplier_pos_company_supplier_idx').on(t.companyId, t.supplierId, t.createdAt.desc()),
    index('supplier_pos_company_status_idx').on(t.companyId, t.status),
    // The overdue-PO scan: everything not yet fully received, oldest expected date first.
    index('supplier_pos_company_expected_idx').on(t.companyId, t.expectedDeliveryDate),
    index('supplier_pos_btb_idx').on(t.btbLcId),
    check('supplier_pos_currency_iso', sql`char_length(${t.currency}) = 3`),
    check('supplier_pos_total_nonneg', sql`${t.totalValue} >= 0`),
  ],
).enableRLS()

export const supplierPoLines = pgTable(
  'supplier_po_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    supplierPoId: uuid('supplier_po_id')
      .notNull()
      .references(() => supplierPos.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 4 }).notNull(),

    /** Accumulated from GRN matching. Never set directly. */
    receivedQty: numeric('received_qty', { precision: 12, scale: 2 }).notNull().default('0'),
    status: poLineStatusEnum('status').notNull().default('open'),
    closedAt: timestamp('closed_at', { withTimezone: true }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('supplier_po_lines_company_po_idx').on(t.companyId, t.supplierPoId),
    index('supplier_po_lines_company_item_idx').on(t.companyId, t.itemId),
    index('supplier_po_lines_open_idx').on(t.companyId, t.status),
    check('supplier_po_lines_qty_positive', sql`${t.qty} > 0`),
    check('supplier_po_lines_received_nonneg', sql`${t.receivedQty} >= 0`),
  ],
).enableRLS()

/**
 * Derived monthly from GRN and inspection records — the brief's "never manual vibes".
 *
 * Every metric is nullable. A supplier with no history is unmeasured, not perfect;
 * defaulting a new mill to 100% on-time would put it top of a ranking on the strength of
 * never having delivered anything. `observations` is stored so a thin score reads as thin.
 */
export const supplierScores = pgTable(
  'supplier_scores',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    supplierId: uuid('supplier_id')
      .notNull()
      .references(() => suppliers.id, { onDelete: 'cascade' }),

    /** First day of the month scored. Calendar month, per the brief. */
    period: date('period').notNull(),

    onTimePct: numeric('on_time_pct', { precision: 5, scale: 2 }),
    qualityRejectPct: numeric('quality_reject_pct', { precision: 5, scale: 2 }),
    priceIndex: numeric('price_index', { precision: 7, scale: 2 }),
    responsivenessPct: numeric('responsiveness_pct', { precision: 5, scale: 2 }),
    observations: integer('observations').notNull().default(0),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('supplier_scores_supplier_period_key').on(t.supplierId, t.period),
    index('supplier_scores_company_period_idx').on(t.companyId, t.period.desc()),
  ],
).enableRLS()
