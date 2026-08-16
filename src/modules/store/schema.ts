/**
 * 3.1 Fabric & Trims Store — floor-facing.
 *
 * Two things shape this schema:
 *
 * **Bonded and general stock are not interchangeable.** A bonded roll came in duty-free
 * against a Utilization Declaration and may only leave against it. `grns.bonded` +
 * `ud_id` is enforced in the service (module 2.2 owns the gate), and locations carry a
 * kind so a bonded roll cannot quietly be counted as general stock.
 *
 * **Everything here is written from a tablet on a bad network.** Issues and GRNs carry an
 * `offline_key`, and replaying a batch must be a no-op — the storekeeper has gone home
 * and the data is on a device that may not come back.
 */
import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  date,
  index,
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
import { uds } from '@/modules/commercial/schema'
import { orders } from '@/modules/orders/schema'

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `yarn` and `greige` are here because this is Bangladesh.
 *
 * A knit composite factory's single largest purchase is yarn — 30/1 combed cotton by the
 * tonne — which it knits into greige and then dyes into the cloth it cuts. Three materials,
 * three prices, three suppliers, three UD lines at customs. The original three kinds forced
 * a storekeeper receiving ten tonnes of yarn to file it as "fabric", which made every stock
 * report and every consumption figure for actual cloth wrong by the weight of the yarn
 * behind it.
 *
 * The 4-point gate still reads `fabric` alone and that stays correct: the system grades
 * cloth by faults per hundred square yards and has nothing to say about a cone of yarn.
 * Greige is graded on the knitting machine, not on an inspection table.
 */
export const itemKindEnum = pgEnum('item_kind', [
  'fabric',
  'trim',
  'accessory',
  'yarn',
  'greige',
])
export const locationKindEnum = pgEnum('location_kind', ['bonded', 'general', 'floor'])
export const rollStatusEnum = pgEnum('roll_status', [
  'in_stock',
  'issued',
  'returned',
  'adjusted_out',
])
/**
 * Where a delivery came from, asked at the door.
 *
 * Not cosmetic, and not derivable. The 4-point gate exempts cloth the factory MADE — a knit
 * house grades its own greige on the machine and no 4-point sheet exists for it — while
 * gating anything a mill sold it, because the mill's own sheet came in the packet. That
 * distinction used to be inferred from the absence of a purchase order link, and absence is
 * not evidence: the receive screen never captured a PO, so every bought delivery looked like
 * own production and the gate waved failed cloth onto the cutting table (Nordkap §6e, and
 * before it the denim rolls R-D-19..21 in the Barakah kit).
 *
 * A storekeeper knows which it is without being asked twice. Now they are asked once.
 */
export const grnSourceEnum = pgEnum('grn_source', ['supplier', 'own_production'])

export const inspectionStatusEnum = pgEnum('inspection_status', [
  'pending',
  'passed',
  'failed_partial',
  'failed',
])
export const requisitionStatusEnum = pgEnum('requisition_status', [
  'open',
  'partial',
  'fulfilled',
  'cancelled',
])

// ─────────────────────────────────────────────────────────────────────────────
// Reference data
// ─────────────────────────────────────────────────────────────────────────────

export const items = pgTable(
  'items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    code: text('code').notNull(),
    kind: itemKindEnum('kind').notNull(),
    name: text('name').notNull(),
    /** fabric: construction, composition, gsm, width · trim: its own spec. */
    spec: jsonb('spec').$type<Record<string, unknown>>().notNull().default({}),
    /** Unit of measure. Never converted implicitly anywhere in this module. */
    uom: text('uom').notNull(),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('items_company_code_key').on(t.companyId, t.code),
    index('items_company_kind_idx').on(t.companyId, t.kind, t.isActive),
  ],
).enableRLS()

export const locations = pgTable(
  'locations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    code: text('code').notNull(),
    name: text('name').notNull(),
    /** A bonded location holds duty-free material and is not general stock. */
    kind: locationKindEnum('kind').notNull(),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('locations_company_code_key').on(t.companyId, t.code),
    index('locations_company_kind_idx').on(t.companyId, t.kind),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Goods in
// ─────────────────────────────────────────────────────────────────────────────

export const grns = pgTable(
  'grns',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    challanNo: text('challan_no').notNull(),
    receivedAt: date('received_at').notNull(),
    /** No FK yet: `supplier_pos` belongs to module 3.2 — see docs/STUBS.md. */
    supplierPoId: uuid('supplier_po_id'),

    /**
     * Supplier delivery or the factory's own production. Defaults to `supplier`, which is
     * the safe direction: an unanswered question means the cloth is gated, not exempted.
     */
    source: grnSourceEnum('source').notNull().default('supplier'),

    /**
     * Duty-free material received against a customs declaration. When true, `ud_id` is
     * required — enforced in the service AND by the check constraint below, because a
     * bonded receipt with no UD is a customs problem, not a data-entry preference.
     */
    bonded: boolean('bonded').notNull().default(false),
    udId: uuid('ud_id').references(() => uds.id, { onDelete: 'restrict' }),

    inspectionStatus: inspectionStatusEnum('inspection_status').notNull().default('pending'),
    documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),

    /** Device-generated idempotency key; a replayed batch must not create a second GRN. */
    offlineKey: text('offline_key'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('grns_company_challan_key').on(t.companyId, t.challanNo),
    uniqueIndex('grns_offline_key').on(t.companyId, t.offlineKey).where(sql`offline_key IS NOT NULL`),
    index('grns_company_received_idx').on(t.companyId, t.receivedAt.desc()),
    index('grns_company_inspection_idx').on(t.companyId, t.inspectionStatus),
    // The invariant, in the database as well as the service.
    check('grns_bonded_requires_ud', sql`${t.bonded} = false OR ${t.udId} IS NOT NULL`),
  ],
).enableRLS()

export const grnLines = pgTable(
  'grn_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    grnId: uuid('grn_id')
      .notNull()
      .references(() => grns.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),
    unitPrice: numeric('unit_price', { precision: 14, scale: 2 }),
    currency: text('currency'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('grn_lines_company_grn_idx').on(t.companyId, t.grnId),
    index('grn_lines_company_item_idx').on(t.companyId, t.itemId),
    check('grn_lines_qty_positive', sql`${t.qty} > 0`),
  ],
).enableRLS()

/**
 * A physical roll or carton. The stock ledger is roll-level because a fabric store is:
 * you do not issue "80 metres of navy", you issue roll R-4471 which happens to hold 80.
 */
export const rolls = pgTable(
  'rolls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    grnLineId: uuid('grn_line_id')
      .notNull()
      .references(() => grnLines.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    rollNo: text('roll_no').notNull(),
    lot: text('lot'),
    dyeLot: text('dye_lot'),
    /** Rolls in the same shade group may be cut together without a lightbox surprise. */
    shadeGroup: text('shade_group'),

    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),

    locationId: uuid('location_id')
      .notNull()
      .references(() => locations.id, { onDelete: 'restrict' }),
    status: rollStatusEnum('status').notNull().default('in_stock'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('rolls_company_roll_no_key').on(t.companyId, t.rollNo),
    // Covering index for the stock query the brief calls out: must stay fast at 10^5 rolls.
    index('rolls_company_item_status_idx').on(t.companyId, t.itemId, t.status),
    index('rolls_company_location_idx').on(t.companyId, t.locationId, t.status),
    index('rolls_company_shade_idx').on(t.companyId, t.itemId, t.shadeGroup),
    check('rolls_qty_positive', sql`${t.qty} > 0`),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Goods out
// ─────────────────────────────────────────────────────────────────────────────

export const requisitions = pgTable(
  'requisitions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    status: requisitionStatusEnum('status').notNull().default('open'),
    /** The sizing inputs, kept so a requisition can be explained months later. */
    basis: jsonb('basis').$type<Record<string, unknown>>().notNull().default({}),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('requisitions_company_order_idx').on(t.companyId, t.orderId),
    // The reservation query: open requisitions are what makes stock "reserved".
    index('requisitions_company_status_idx').on(t.companyId, t.status),
  ],
).enableRLS()

export const requisitionLines = pgTable(
  'requisition_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    requisitionId: uuid('requisition_id')
      .notNull()
      .references(() => requisitions.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),

    requiredQty: numeric('required_qty', { precision: 12, scale: 2 }).notNull(),
    issuedQty: numeric('issued_qty', { precision: 12, scale: 2 }).notNull().default('0'),
    unit: text('unit').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('requisition_lines_req_item_key').on(t.requisitionId, t.itemId),
    index('requisition_lines_company_item_idx').on(t.companyId, t.itemId),
    check('requisition_lines_required_positive', sql`${t.requiredQty} > 0`),
    // Issuing more than was requisitioned is how an order eats another order's cloth.
    check('requisition_lines_not_over_issued', sql`${t.issuedQty} <= ${t.requiredQty}`),
  ],
).enableRLS()

export const issues = pgTable(
  'issues',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    requisitionId: uuid('requisition_id').references(() => requisitions.id, {
      onDelete: 'restrict',
    }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * Device-generated idempotency key. The core `offline_keys` ledger is the mechanism;
     * this column keeps the link visible on the row itself, which is what a storekeeper
     * reconciling a device against the system actually looks at.
     */
    offlineKey: text('offline_key'),
    /** Shade-mix and similar advisories recorded at issue time, for the audit trail. */
    warnings: jsonb('warnings').$type<unknown[]>().notNull().default([]),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('issues_offline_key').on(t.companyId, t.offlineKey).where(sql`offline_key IS NOT NULL`),
    index('issues_company_order_idx').on(t.companyId, t.orderId, t.issuedAt.desc()),
    index('issues_company_issued_idx').on(t.companyId, t.issuedAt.desc()),
  ],
).enableRLS()

export const issueLines = pgTable(
  'issue_lines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    issueId: uuid('issue_id')
      .notNull()
      .references(() => issues.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    rollId: uuid('roll_id').references(() => rolls.id, { onDelete: 'restrict' }),

    qty: numeric('qty', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('issue_lines_company_issue_idx').on(t.companyId, t.issueId),
    index('issue_lines_company_item_idx').on(t.companyId, t.itemId),
    index('issue_lines_roll_idx').on(t.rollId),
    check('issue_lines_qty_positive', sql`${t.qty} > 0`),
  ],
).enableRLS()

/**
 * Stock corrections ⚖. Always via `pending_changes` — an adjustment is somebody saying
 * the count is wrong, and the whole point of the trust layer is that such a claim reaches
 * a human before it reaches the ledger.
 */
export const stockAdjustments = pgTable(
  'stock_adjustments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    itemId: uuid('item_id')
      .notNull()
      .references(() => items.id, { onDelete: 'restrict' }),
    rollId: uuid('roll_id').references(() => rolls.id, { onDelete: 'set null' }),

    /** Signed: negative writes stock off, positive corrects an under-count. */
    qtyDelta: numeric('qty_delta', { precision: 12, scale: 2 }).notNull(),
    unit: text('unit').notNull(),
    reasonCode: text('reason_code').notNull(),
    note: text('note'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('stock_adjustments_company_item_idx').on(t.companyId, t.itemId, t.createdAt.desc()),
    index('stock_adjustments_company_reason_idx').on(t.companyId, t.reasonCode),
    check('stock_adjustments_delta_nonzero', sql`${t.qtyDelta} <> 0`),
  ],
).enableRLS()
