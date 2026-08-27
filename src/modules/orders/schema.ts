/**
 * 1.3 Order Desk & TNA ⚖ — entities from the brief.
 *
 * The flagship module. An order carries the buyer's commitment, the money, the breakdown
 * the floor cuts to, and the calendar every other department schedules against.
 *
 * Two things here are less obvious than they look:
 *
 * **Breakdowns are revisioned, not edited.** A buyer changing a size ratio after cutting
 * has started is a different fact from a typo being fixed before production — one costs
 * money and the other does not. `order_breakdowns` is keyed by revision and
 * `order_styles.active_revision` points at the live one, so "what were we cutting to in
 * March" stays answerable.
 *
 * **`tna_milestones.depends_on` carries a gap, not just a name.** The brief lists
 * `depends_on[]`; storing `{name, gapDays}` is a deliberate extension, because the gap
 * between two dependent milestones is a required lead time and the ripple engine cannot
 * compute a slip without it. See `tna.ts` for why that had to be explicit.
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

import { companies, documents, roleNameEnum, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import { lcs } from '@/modules/commercial/schema'

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

export const orderStatusEnum = pgEnum('order_status', [
  'confirmed',
  'in_production',
  'shipped_partial',
  'shipped_full',
  'closed',
  'cancelled',
])

/** Derived from planned vs actual dates by the nightly scan, never set by hand. */
export const milestoneStatusEnum = pgEnum('milestone_status', [
  'pending',
  'on_track',
  'at_risk',
  'late',
  'done',
])

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

export const orders = pgTable(
  'orders',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    buyerId: uuid('buyer_id')
      .notNull()
      .references(() => buyers.id, { onDelete: 'restrict' }),

    /** One order can cover several buyer POs; the buyer thinks in PO numbers. */
    poNumbers: text('po_numbers').array().notNull().default(sql`ARRAY[]::text[]`),

    totalValue: numeric('total_value', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('USD'),

    /**
     * Over/under shipment the buyer accepts, e.g. 3.00 for ±3%. A breakdown outside it is
     * refused: shipping 5% short against a buyer who allows 2% is a claim, not a rounding
     * difference. Usually mirrors the LC's own tolerance but is negotiated separately.
     */
    qtyTolerancePct: numeric('qty_tolerance_pct', { precision: 5, scale: 2 })
      .notNull()
      .default('0'),

    /**
     * The buying agent's terms AS AT confirmation. A snapshot, not a reference: agents
     * renegotiate, and an order's commission must not silently change afterwards.
     */
    agentSnapshot: jsonb('agent_snapshot').$type<Record<string, unknown>>(),

    status: orderStatusEnum('status').notNull().default('confirmed'),

    /** Denormalised from `tna_milestones.ex_factory` so the order book can sort on it. */
    plannedExFactoryDate: date('planned_ex_factory_date'),

    /** The merchandiser who owns this order — roles gate on it (brief §Roles). */
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

    /**
     * The RFQ this order was won from. No FK: `rfqs` is 1.2's and 1.2 already imports this
     * module for nothing — but more to the point, an order outlives the enquiry that
     * produced it and must not be deleted with it.
     *
     * Unique, and that is the point: it is what makes the `rfq.won` consumer idempotent.
     * Two orders for one win would double the factory's committed capacity against a single
     * buyer commitment.
     */
    sourceRfqId: uuid('source_rfq_id'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The order book: a company's live orders by ship date.
    index('orders_company_exfactory_idx').on(t.companyId, t.plannedExFactoryDate),
    uniqueIndex('orders_source_rfq_key').on(t.sourceRfqId).where(sql`source_rfq_id IS NOT NULL`),
    index('orders_company_status_idx').on(t.companyId, t.status, t.plannedExFactoryDate),
    index('orders_company_buyer_idx').on(t.companyId, t.buyerId),
    index('orders_company_owner_idx').on(t.companyId, t.ownerUserId),
    // "Which order is PO-9931?" — merchandisers search by the buyer's number, not ours.
    index('orders_po_numbers_idx').using('gin', t.poNumbers),
    check('orders_currency_iso', sql`char_length(${t.currency}) = 3`),
    check(
      'orders_qty_tolerance_range',
      sql`${t.qtyTolerancePct} >= 0 AND ${t.qtyTolerancePct} <= 100`,
    ),
  ],
).enableRLS()

export const orderStyles = pgTable(
  'order_styles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    styleCode: text('style_code').notNull(),
    description: text('description'),
    /** Pieces the buyer ordered for this style — what the breakdown must add up to. */
    contractedQty: integer('contracted_qty'),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
    currency: text('currency').notNull().default('USD'),

    /** Which breakdown revision the floor is currently cutting to. */
    activeRevision: integer('active_revision').notNull().default(1),

    /*
     * The style's identity as the buyer states it (design canvas, "Style & documents").
     *
     * Every one of these is on the tech pack and on the buyer's own order sheet, and none
     * of them had anywhere to go — so a merchandiser answering "which season is this" or
     * "how does it pack" went back to the spreadsheet the app was meant to replace. All
     * nullable: a style entered by hand in thirty seconds carries a code and nothing else,
     * and the screen prints what it has rather than demanding the rest.
     */
    /** AW-26, SS-27 — the buyer's season code, verbatim. */
    season: text('season'),
    /** The buyer's own label for the style, when it differs from the factory's code. */
    customerLabel: text('customer_label'),
    /** Pattern number, and the pattern it was cut from — repeat orders are the norm. */
    patternNo: text('pattern_no'),
    basedOnStyle: text('based_on_style'),
    /** Flat pack, hanger, poly bag — decides carton sizing and the packing list. */
    packingMethod: text('packing_method'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_styles_order_code_key').on(t.orderId, t.styleCode),
    index('order_styles_company_order_idx').on(t.companyId, t.orderId),
    check('order_styles_currency_iso', sql`char_length(${t.currency}) = 3`),
    check('order_styles_active_revision_positive', sql`${t.activeRevision} >= 1`),
    check(
      'order_styles_contracted_qty_positive',
      sql`${t.contractedQty} IS NULL OR ${t.contractedQty} > 0`,
    ),
  ],
).enableRLS()

/**
 * The colour × size grid. Pieces are integers — half a garment does not exist, and using
 * a decimal here invites a rounding argument on a cutting floor.
 */
export const orderBreakdowns = pgTable(
  'order_breakdowns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderStyleId: uuid('order_style_id')
      .notNull()
      .references(() => orderStyles.id, { onDelete: 'cascade' }),

    revision: integer('revision').notNull(),
    color: text('color').notNull(),
    size: text('size').notNull(),
    qty: integer('qty').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_breakdowns_style_revision_cell_key').on(
      t.orderStyleId,
      t.revision,
      t.color,
      t.size,
    ),
    index('order_breakdowns_company_style_idx').on(t.companyId, t.orderStyleId, t.revision),
    check('order_breakdowns_qty_positive', sql`${t.qty} > 0`),
  ],
).enableRLS()

/**
 * Why the breakdown changed, who confirmed it, and against which buyer document. This is
 * the row that answers "the buyer says they never asked for that".
 */
export const orderRevisions = pgTable(
  'order_revisions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    revision: integer('revision').notNull(),
    /** Cell-level before/after, produced by the service, not by the client. */
    diff: jsonb('diff').$type<Record<string, unknown>>().notNull(),
    reason: text('reason'),

    buyerConfirmedAt: timestamp('buyer_confirmed_at', { withTimezone: true }),
    /** The buyer's email or amended PO backing the change. */
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_revisions_order_revision_key').on(t.orderId, t.revision),
    index('order_revisions_company_order_idx').on(t.companyId, t.orderId),
    check('order_revisions_revision_positive', sql`${t.revision} >= 1`),
  ],
).enableRLS()

/** m:n — one LC can cover several POs, and one order can draw on more than one credit. */
export const orderLcs = pgTable(
  'order_lcs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    lcId: uuid('lc_id')
      .notNull()
      .references(() => lcs.id, { onDelete: 'restrict' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_lcs_order_lc_key').on(t.orderId, t.lcId),
    index('order_lcs_company_lc_idx').on(t.companyId, t.lcId),
  ],
).enableRLS()

export const orderFiles = pgTable(
  'order_files',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    label: text('label'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('order_files_order_document_key').on(t.orderId, t.documentId),
    index('order_files_company_order_idx').on(t.companyId, t.orderId),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// TNA
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The factory's reusable calendars, one per product type. Hand-maintained in Settings,
 * which is exactly why `generateSchedule` repairs offsets that contradict a dependency
 * rather than trusting them.
 */
export const tnaTemplates = pgTable(
  'tna_templates',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    productType: text('product_type').notNull(),
    /** `TnaTemplateMilestone[]` — shape validated by zod.ts on write. */
    milestones: jsonb('milestones').$type<unknown[]>().notNull(),

    isActive: boolean('is_active').notNull().default(true),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tna_templates_company_name_key').on(t.companyId, t.name),
    index('tna_templates_company_product_idx').on(t.companyId, t.productType, t.isActive),
  ],
).enableRLS()

export const tnaMilestones = pgTable(
  'tna_milestones',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    name: text('name').notNull(),
    /** Calendar dates, not timestamps — a milestone is a day (see tna.ts). */
    plannedDate: date('planned_date').notNull(),
    actualDate: date('actual_date'),

    /** `ResolvedDependency[]` — carries the required gap, not just the name. */
    dependsOn: jsonb('depends_on').$type<unknown[]>().notNull().default([]),
    critical: boolean('critical').notNull().default(false),

    ownerRole: roleNameEnum('owner_role'),
    ownerUserId: text('owner_user_id').references(() => users.id, { onDelete: 'set null' }),

    status: milestoneStatusEnum('status').notNull().default('pending'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('tna_milestones_order_name_key').on(t.orderId, t.name),
    // The nightly TNA scan: everything not yet done, oldest planned date first.
    index('tna_milestones_company_planned_idx').on(t.companyId, t.plannedDate),
    index('tna_milestones_company_status_idx').on(t.companyId, t.status, t.plannedDate),
    // "What is this person supposed to be doing this week?"
    index('tna_milestones_company_owner_idx').on(t.companyId, t.ownerUserId, t.plannedDate),
    index('tna_milestones_order_idx').on(t.orderId),
  ],
).enableRLS()
