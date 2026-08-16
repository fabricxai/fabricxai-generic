/**
 * 6.1 Line Tracking ⚡ — the hot path.
 *
 * `hourly_outputs` is the highest-volume table in the system: 50 lines × ~10 entries a
 * day × 2 years is well past a million rows for one factory, and the seed generator
 * targets exactly that. It is **partitioned by month from the first migration**
 * (architecture §4, dev-plan Phase 4) — retrofitting partitioning onto a live table means
 * a maintenance window nobody will schedule.
 *
 * Partitioning is not something Drizzle can express, so the generated migration is
 * hand-edited before it is ever applied to add `PARTITION BY RANGE`. Two consequences the
 * next reader needs:
 *
 *  1. **The primary key must include the partition key.** Postgres requires it, so the PK
 *     is `(id, produced_on)` rather than `id` alone.
 *  2. **A unique index cannot span partitions unless it includes the key**, which is why
 *     the natural key here is `(line_id, produced_on, hour_slot)` — it happens to contain
 *     the partition column, so it works and is the upsert key the brief asks for.
 */
import { sql } from 'drizzle-orm'
import {
  check,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core'

import { companies, users } from '@/db/schema/core'
import { orders } from '@/modules/orders/schema'
// `lines` is master data owned by module 4.1 Planning (rule 11). Production records
// output against lines; it does not create them.
import { lines } from '@/modules/planning/schema'

export const downtimeReasonEnum = pgEnum('downtime_reason', [
  'machine',
  'feeding',
  'absent',
  'power',
  'other',
])


export const dailyLinePlans = pgTable(
  'daily_line_plans',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => lines.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'restrict' }),

    planDate: date('plan_date').notNull(),
    targetPerHour: integer('target_per_hour').notNull(),
    manpowerPlanned: integer('manpower_planned').notNull(),
    /** Standard minute value for what this line is running. Drives efficiency. */
    smv: numeric('smv', { precision: 8, scale: 2 }),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('daily_line_plans_line_date_key').on(t.lineId, t.planDate),
    index('daily_line_plans_company_date_idx').on(t.companyId, t.planDate),
    check('daily_line_plans_target_positive', sql`${t.targetPerHour} > 0`),
  ],
).enableRLS()

/**
 * The burst-write table ⚡. PARTITIONED BY RANGE (produced_on) — see the file header.
 *
 * Upsert-idempotent on `(line_id, produced_on, hour_slot)`: a supervisor correcting the
 * 14:00 count re-sends the same key and it replaces, rather than adding a second row for
 * the same hour. That natural key is what makes a replayed offline batch safe even before
 * the `offline_keys` ledger is consulted.
 */
export const hourlyOutputs = pgTable(
  'hourly_outputs',
  {
    id: uuid('id').notNull().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => lines.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id').references(() => orders.id, { onDelete: 'set null' }),

    /** The partition key. A calendar date, in the factory's timezone. */
    producedOn: date('produced_on').notNull(),
    /** Hour of the shift, 0–23. The board is a grid of these. */
    hourSlot: integer('hour_slot').notNull(),

    target: integer('target').notNull().default(0),
    actual: integer('actual').notNull().default(0),

    /**
     * Why the hour went the way it did — "needle change SN-3-014", "6 operators short".
     *
     * Every paper hourly sheet in Bangladesh has this column, and the reading has always
     * pulled it off the photograph; it was shown to the supervisor to check and then thrown
     * away at the save button, because there was nowhere to put it (§9, F43). An hour of 118
     * against a target of 145 then sat there as an unexplained miss, and the one line that
     * would have told maintenance a needle broke lived only on the paper.
     *
     * Nullable, and stays null for the ordinary hour: most hours have nothing to say, and a
     * column of empty strings is worse than a column of blanks.
     */
    remark: text('remark'),

    /** Device idempotency key, kept on the row for reconciliation against a tablet. */
    offlineKey: text('offline_key'),
    enteredBy: text('entered_by').references(() => users.id, { onDelete: 'set null' }),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Postgres requires the partition key in the primary key.
    primaryKey({ columns: [t.id, t.producedOn] }),
    // The upsert key from the brief. Contains the partition column, so it can be unique
    // across the whole partitioned table.
    uniqueIndex('hourly_outputs_line_date_hour_key').on(t.lineId, t.producedOn, t.hourSlot),
    // The board read: one company's day, all lines.
    index('hourly_outputs_company_date_idx').on(t.companyId, t.producedOn),
    index('hourly_outputs_order_date_idx').on(t.companyId, t.orderId, t.producedOn),
    check('hourly_outputs_hour_slot_range', sql`${t.hourSlot} >= 0 AND ${t.hourSlot} <= 23`),
    check('hourly_outputs_actual_not_negative', sql`${t.actual} >= 0`),
  ],
).enableRLS()

export const downtimes = pgTable(
  'downtimes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => lines.id, { onDelete: 'cascade' }),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    reason: downtimeReasonEnum('reason').notNull(),
    note: text('note'),

    /** No FKs yet: `machines` and `tickets` belong to 9.1 — see docs/STUBS.md. */
    machineId: uuid('machine_id'),
    ticketId: uuid('ticket_id'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The open-downtime query the board polls: one partial index, always tiny.
    index('downtimes_company_open_idx')
      .on(t.companyId, t.lineId, t.startedAt)
      .where(sql`ended_at IS NULL`),
    index('downtimes_company_started_idx').on(t.companyId, t.startedAt.desc()),
    check('downtimes_range_ordered', sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`),
  ],
).enableRLS()

/**
 * Shared table: production writes it, quality co-writes through this module's service
 * (architecture §2.3, CLAUDE.md rule 11). One writer module, always.
 */
export const endlineCounts = pgTable(
  'endline_counts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => lines.id, { onDelete: 'cascade' }),

    countedOn: date('counted_on').notNull(),
    checked: integer('checked').notNull().default(0),
    passed: integer('passed').notNull().default(0),
    /** Garments with at least one defect. `defects` counts the defects themselves. */
    defective: integer('defective').notNull().default(0),
    defects: integer('defects').notNull().default(0),
    rework: integer('rework').notNull().default(0),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('endline_counts_line_date_key').on(t.lineId, t.countedOn),
    index('endline_counts_company_date_idx').on(t.companyId, t.countedOn),
    check('endline_counts_passed_within_checked', sql`${t.passed} <= ${t.checked}`),
  ],
).enableRLS()

/**
 * Derived by the day-close job, never by a request path (architecture §4). Safe to
 * rebuild from `hourly_outputs` at any time — the rebuild script lives with the job.
 */
export const efficiencyDaily = pgTable(
  'efficiency_daily',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    lineId: uuid('line_id')
      .notNull()
      .references(() => lines.id, { onDelete: 'cascade' }),

    forDate: date('for_date').notNull(),
    earnedMinutes: numeric('earned_minutes', { precision: 12, scale: 2 }).notNull(),
    availableMinutes: numeric('available_minutes', { precision: 12, scale: 2 }).notNull(),
    efficiencyPct: numeric('efficiency_pct', { precision: 6, scale: 2 }).notNull(),
    outputTotal: integer('output_total').notNull().default(0),

    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('efficiency_daily_line_date_key').on(t.lineId, t.forDate),
    index('efficiency_daily_company_date_idx').on(t.companyId, t.forDate.desc()),
  ],
).enableRLS()

/** Derived hourly. Cut / sewn / finished per order — the WIP the owner dashboard shows. */
export const wipSnapshots = pgTable(
  'wip_snapshots',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    orderId: uuid('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),

    takenAt: timestamp('taken_at', { withTimezone: true }).notNull().defaultNow(),
    cut: integer('cut').notNull().default(0),
    sewn: integer('sewn').notNull().default(0),
    finished: integer('finished').notNull().default(0),
  },
  (t) => [index('wip_snapshots_company_order_idx').on(t.companyId, t.orderId, t.takenAt.desc())],
).enableRLS()
