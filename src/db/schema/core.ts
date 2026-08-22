/**
 * modules/core — the cross-cutting tables every module depends on.
 *
 * Sources: architecture §4 (data architecture), dev-plan §2.2 (core invariants),
 * PLAYBOOK §1 (this session's scope).
 *
 * Rules encoded here:
 *  - Every tenant table carries `company_id` and is RLS-enabled; the policies and the
 *    non-owner application role are created in migration 0002_rls.sql, because the
 *    second wall is a database object, not a Drizzle concept.
 *  - `pending_changes` is the ONLY path by which AI or junior writes reach business
 *    tables (dev-plan §2.2.2). Per-field confidence is stored, never a constant.
 *  - `outbox` rows are written in the same transaction as the data change; the relay
 *    is the only bridge from transactions to BullMQ (architecture §5).
 *  - `audit_log` is append-only; the service-layer interceptor writes it for ⚖ tables.
 *
 * Better Auth arrives next session and will own `users` plus its own session/account/
 * verification tables. `users` is shaped to Better Auth's core user table already
 * (text id, email, email_verified, image) so that lands as an additive migration.
 */
import { sql } from 'drizzle-orm'
import {
  bigserial,
  boolean,
  check,
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

// ─────────────────────────────────────────────────────────────────────────────
// Enums
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Phase-0 baseline role matrix. The final matrix is owned by module X.3 (Settings &
 * Admin) — extend forward with `ALTER TYPE ... ADD VALUE`, never by editing this list
 * in place (applied migrations are immutable, PLAYBOOK §5).
 *
 * `owner` and `hr` are load-bearing beyond convenience: payroll endpoints are hard-gated
 * to those two with bodyless 403s, and their reads are audited (CLAUDE.md rule 9).
 */
export const roleNameEnum = pgEnum('role_name', [
  'owner',
  'admin',
  'merchandiser',
  'commercial',
  'planner',
  'store',
  'procurement',
  'cutting',
  'production',
  'quality',
  'shipment',
  'maintenance',
  'hr',
  'compliance',
  'finance',
  'member',
  'viewer',
])

export const documentStatusEnum = pgEnum('document_status', [
  'uploaded',
  'processing',
  'ready',
  'quarantined',
  'failed',
])

export const auditActionEnum = pgEnum('audit_action', [
  'insert',
  'update',
  'delete',
  'read', // payroll 🔒 reads are audited too (dev-plan §2.2.7)
  'approve',
  'reject',
  'login',
  'export',
])

export const pendingOperationEnum = pgEnum('pending_operation', ['insert', 'update', 'delete'])

export const pendingStatusEnum = pgEnum('pending_status', [
  /**
   * Read from a document, and not yet submitted by the person who asked for the reading.
   *
   * The step this adds is the raiser's own check. Before it, a merchandiser dropped a PO
   * and the model's output went straight into somebody else's approve inbox — so the
   * person holding the actual paper, the only one who could say "no, that says 12,000 not
   * 1,200", never saw it, and the approver was asked to verify a document they did not
   * have. Confidence numbers do not fix that; they tell you where to look, not what the
   * page said.
   *
   * A `drafted` row is invisible to the approval inbox (which filters on `pending`), never
   * auto-approves, and belongs to exactly one person: `created_by`.
   */
  'drafted',
  'pending',
  'approved', // approved, commit in flight
  'committed', // target row written, audit trail closed
  'rejected',
  'failed', // re-validation or commit failed; error captured, nothing written
  'superseded', // a newer draft replaced this one before review
])

/** Where a draft came from. Drives correction telemetry per extractor version. */
export const pendingSourceEnum = pgEnum('pending_source', [
  'ai_extraction',
  'ai_chat',
  'user_draft',
  'import',
  'integration',
])

export const notificationSeverityEnum = pgEnum('notification_severity', [
  'info',
  'warning',
  'critical',
])

// ─────────────────────────────────────────────────────────────────────────────
// Tenancy root
// ─────────────────────────────────────────────────────────────────────────────

export const companies = pgTable(
  'companies',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    legalName: text('legal_name'),
    slug: text('slug').notNull(),

    // Bangladesh registration identifiers — they appear on export documents, so they
    // live on the tenant root rather than in a settings blob.
    bin: text('bin'), // Business Identification Number
    bondedLicenseNo: text('bonded_license_no'), // customs bonded warehouse licence
    factoryLicenseNo: text('factory_license_no'),

    address: jsonb('address').$type<Record<string, unknown>>().notNull().default({}),

    /** Buyer-facing currency. USD in practice; every amount still carries its own. */
    baseCurrency: text('base_currency').notNull().default('USD'),
    /** Local currency for wages, local purchases, utilities. */
    localCurrency: text('local_currency').notNull().default('BDT'),

    locale: text('locale').notNull().default('en'),
    timezone: text('timezone').notNull().default('Asia/Dhaka'),

    /** Module toggles + company preferences (X.3 owns the shape). */
    settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),

    // Required by Better Auth's `organization` model, which is mapped onto this table
    // (src/lib/auth.ts). `metadata` is the plugin's own scratch space — application
    // preferences belong in `settings` above, not here.
    logo: text('logo'),
    metadata: text('metadata'),

    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('companies_slug_key').on(t.slug),
    check('companies_base_currency_iso', sql`char_length(${t.baseCurrency}) = 3`),
    check('companies_local_currency_iso', sql`char_length(${t.localCurrency}) = 3`),
  ],
).enableRLS()

/**
 * Identity. Better Auth (next session) becomes the writer of this table; the columns
 * below are exactly its core user fields so the integration is additive.
 *
 * Deliberately NOT tenant-scoped and deliberately NOT RLS-enabled: membership lives in
 * `roles`, so one person can belong to more than one company later without duplicating
 * the identity — and login has to read this table before any company context exists.
 * Cross-company user enumeration is therefore prevented at the service layer, not by
 * RLS; see docs/STUBS.md.
 */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').notNull().default(false),
    name: text('name'),
    image: text('image'),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('users_email_key').on(sql`lower(${t.email})`)],
)

/** Per-user application profile. One row per user, independent of company membership. */
export const profiles = pgTable(
  'profiles',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    fullName: text('full_name'),
    phone: text('phone'),
    avatarUrl: text('avatar_url'),
    /** UI language. Floor staff run Bangla; the type system does not care, i18n does. */
    locale: text('locale').notNull().default('en'),
    department: text('department'),
    /** Which company this user lands in after login when they belong to several. */
    defaultCompanyId: uuid('default_company_id').references(() => companies.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('profiles_default_company_idx').on(t.defaultCompanyId)],
)

/**
 * Membership + authorisation. This is what `ctx {companyId, userId, role}` is built
 * from at the action boundary. A user may hold several roles in one company.
 */
export const roles = pgTable(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleNameEnum('role').notNull(),
    /** Optional scope narrowing, e.g. {"lines": ["L1","L2"]} for a line chief. */
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull().default({}),
    grantedBy: text('granted_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('roles_company_user_role_key').on(t.companyId, t.userId, t.role),
    index('roles_user_idx').on(t.userId),
    index('roles_company_role_idx').on(t.companyId, t.role),
  ],
).enableRLS()

/**
 * Per-tenant module activation (specs/order-centric-core.md §1) — the table that makes
 * "the factory chooses its modules" true rather than a sentence.
 *
 * Sparse by design: no row means the module's registered default applies, so a new module
 * can ship dark (or lit) without a backfill migration. `enabled` is therefore an explicit
 * override in BOTH directions, and history lives in the outbox event the flip emits, not
 * in this row — it holds only the latest decision and who made it.
 */
export const companyModules = pgTable(
  'company_modules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    /** The `registerModule` id ('orders', 'procurement', …) — validated against the registry, not an enum, so a new module needs no migration here. */
    moduleId: text('module_id').notNull(),
    enabled: boolean('enabled').notNull(),
    enabledBy: text('enabled_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('company_modules_company_module_key').on(t.companyId, t.moduleId)],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Documents (MinIO / S3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every uploaded file: buyer POs, LC copies, challans, wage sheets, audit reports,
 * photos of handwritten floor sheets. Object keys are unguessable and buckets are
 * private — access is always via signed URL (dev-plan §6).
 */
export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    bucket: text('bucket').notNull(),
    objectKey: text('object_key').notNull(),

    filename: text('filename').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    checksumSha256: text('checksum_sha256'),

    /** Domain kind: 'buyer_po' | 'lc' | 'challan' | 'wage_sheet' | … Modules own the vocabulary. */
    kind: text('kind'),
    /** Which module claimed this file — set by the classifier before extraction. */
    moduleId: text('module_id'),

    /** Loose link to the business row this file belongs to. Not an FK: the target
     *  table varies by module and the file may arrive before the row exists. */
    entityTable: text('entity_table'),
    entityId: text('entity_id'),

    status: documentStatusEnum('status').notNull().default('uploaded'),
    meta: jsonb('meta').$type<Record<string, unknown>>().notNull().default({}),

    uploadedBy: text('uploaded_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('documents_bucket_object_key').on(t.bucket, t.objectKey),
    index('documents_company_created_idx').on(t.companyId, t.createdAt.desc()),
    index('documents_company_entity_idx').on(t.companyId, t.entityTable, t.entityId),
    index('documents_company_kind_idx').on(t.companyId, t.kind),
    check('documents_size_positive', sql`${t.sizeBytes} > 0`),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Propose → approve → commit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * pending_changes v2 — the trust layer (architecture §1.1, dev-plan §2.2.2).
 *
 * Nothing AI-authored and nothing drafted by a junior operator reaches a business
 * table directly. A draft names its target table (which MUST be registered in the
 * owning module's `register.ts` whitelist), carries a payload validated by that
 * module's Zod schema at insert AND again at approve, and carries confidence PER
 * FIELD supplied by the extractor. Constant confidences are forbidden — a number a
 * skeptical owner is shown has to have come from somewhere.
 *
 * The `target_table` check below is defence in depth only: it constrains the value to
 * a plain identifier so it can never be a SQL fragment. The real whitelist is the
 * module registry, enforced in the service layer at insert and at approve.
 */
export const pendingChanges = pgTable(
  'pending_changes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Registry key of the owning module, e.g. 'orders'. */
    moduleId: text('module_id').notNull(),
    /** Whitelisted in `modules/<moduleId>/register.ts` → pendingTargets. */
    targetTable: text('target_table').notNull(),
    /** null for inserts; the existing row id for updates and deletes. */
    targetId: text('target_id'),
    operation: pendingOperationEnum('operation').notNull(),

    /** The proposed row, validated by the module Zod schema at insert and at approve. */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    /** Registry key into the module's zodMap — the hook that resolves payload → schema. */
    zodSchemaKey: text('zod_schema_key').notNull(),

    /**
     * Per-field confidence from the extractor: {"buyer_po_no": 0.98, "qty": 0.71}.
     * Empty object for human drafts — absence of a value, not a fake 1.0.
     */
    fieldConfidence: jsonb('field_confidence')
      .$type<Record<string, number>>()
      .notNull()
      .default({}),
    /** Lowest per-field confidence; denormalised so the approve inbox can sort on it. */
    confidenceMin: numeric('confidence_min', { precision: 4, scale: 3 }),

    source: pendingSourceEnum('source').notNull(),
    sourceDocumentId: uuid('source_document_id').references(() => documents.id, {
      onDelete: 'set null',
    }),
    /** Extractor build that produced this draft — correction telemetry is grouped by it. */
    extractorVersion: text('extractor_version'),
    /** Resolved model id, for cost/latency attribution. Modules never choose this. */
    model: text('model'),

    status: pendingStatusEnum('status').notNull().default('pending'),

    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),

    reviewedBy: text('reviewed_by').references(() => users.id, { onDelete: 'set null' }),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),

    /**
     * Field-level edits the reviewer made before approving: {"qty": {"from": 1200,
     * "to": 1250}}. This is the feedback loop that earns the right to show a
     * confidence number to a user at all.
     */
    corrections: jsonb('corrections').$type<Record<string, unknown>>().notNull().default({}),

    /**
     * Field-level edits the RAISER made before submitting, same shape as `corrections`.
     *
     * Kept apart from the reviewer's because they are different measurements of different
     * things. The reviewer is checking a colleague's judgement; the raiser is checking a
     * machine's reading against the paper in their hand — which makes this the better
     * signal about the extractor, and conflating the two would blur both.
     */
    draftCorrections: jsonb('draft_corrections')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),

    /** When the raiser submitted it for approval — `drafted` → `pending`. */
    submittedAt: timestamp('submitted_at', { withTimezone: true }),

    committedAt: timestamp('committed_at', { withTimezone: true }),
    /** Primary key of the row actually written — closes the draft→reviewer→row chain. */
    committedRowId: text('committed_row_id'),

    /** Structured failure (Zod issues, gate rejection) when status = 'failed'. */
    error: jsonb('error').$type<Record<string, unknown>>(),
  },
  (t) => [
    // The approve inbox: open drafts for a company, newest first.
    index('pending_changes_company_status_idx').on(t.companyId, t.status, t.createdAt.desc()),
    // Inbox filtered by department.
    index('pending_changes_company_module_idx').on(t.companyId, t.moduleId, t.status),
    // "What is pending against this order?" from a module's detail screen.
    index('pending_changes_target_idx').on(t.companyId, t.targetTable, t.targetId),
    index('pending_changes_document_idx').on(t.sourceDocumentId),
    // Sort the inbox by riskiest draft first.
    index('pending_changes_confidence_idx').on(t.companyId, t.confidenceMin),
    check(
      'pending_changes_target_table_is_identifier',
      sql`${t.targetTable} ~ '^[a-z_][a-z0-9_]*$'`,
    ),
    check('pending_changes_confidence_range', sql`${t.confidenceMin} IS NULL
      OR (${t.confidenceMin} >= 0 AND ${t.confidenceMin} <= 1)`),
    // An update or delete must say what it targets; an insert must not.
    check(
      'pending_changes_target_id_matches_operation',
      sql`(${t.operation} = 'insert' AND ${t.targetId} IS NULL)
        OR (${t.operation} <> 'insert' AND ${t.targetId} IS NOT NULL)`,
    ),
  ],
).enableRLS()

/**
 * approval_rules — who may approve what, and when a draft may skip a human.
 *
 * Evaluated highest `priority` first; the first matching active rule wins. A rule with
 * `auto_approve` still requires `min_confidence` to be met by EVERY field in the draft,
 * which is why confidence is stored per field rather than as one number.
 */
/**
 * One reviewer's approval of one draft.
 *
 * Exists so `approval_rules.approvals_required` can mean something. A rule demanding two
 * approvers is a rule about two DIFFERENT people, so the unique index is on
 * (pending_change, approver) — the same person clicking twice is one approval, and letting
 * it count twice would turn a two-approver control into a one-approver control with extra
 * steps.
 *
 * Append-only. A withdrawn approval is not deleted; the draft is rejected and re-raised,
 * because "who signed off on this and when" must survive somebody changing their mind.
 */
export const pendingChangeApprovals = pgTable(
  'pending_change_approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    pendingChangeId: uuid('pending_change_id')
      .notNull()
      .references(() => pendingChanges.id, { onDelete: 'cascade' }),

    approverUserId: text('approver_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The role that qualified them, recorded because roles change. */
    approvedAsRole: roleNameEnum('approved_as_role').notNull(),
    /** What this reviewer edited. The correction telemetry, per approver. */
    corrections: jsonb('corrections').$type<Record<string, unknown>>().notNull().default({}),
    note: text('note'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pending_change_approvals_unique').on(t.pendingChangeId, t.approverUserId),
    index('pending_change_approvals_company_idx').on(t.companyId, t.pendingChangeId),
  ],
).enableRLS()

export const approvalRules = pgTable(
  'approval_rules',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    moduleId: text('module_id').notNull(),
    /** null = every registered target in the module. */
    targetTable: text('target_table'),
    /** null = every operation. */
    operation: pendingOperationEnum('operation'),

    /** Extra predicate over the payload, e.g. {"field":"amount","op":">","value":"10000"}. */
    condition: jsonb('condition').$type<Record<string, unknown>>(),

    /** Any one of these roles may approve. */
    requiredRoles: roleNameEnum('required_roles').array().notNull(),
    approvalsRequired: integer('approvals_required').notNull().default(1),

    autoApprove: boolean('auto_approve').notNull().default(false),
    /** Floor every field must clear before auto-approve is even considered. */
    minConfidence: numeric('min_confidence', { precision: 4, scale: 3 }),

    priority: integer('priority').notNull().default(100),
    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('approval_rules_lookup_idx').on(
      t.companyId,
      t.moduleId,
      t.isActive,
      t.priority.desc(),
    ),
    check('approval_rules_approvals_positive', sql`${t.approvalsRequired} >= 1`),
    check('approval_rules_min_confidence_range', sql`${t.minConfidence} IS NULL
      OR (${t.minConfidence} >= 0 AND ${t.minConfidence} <= 1)`),
    // Auto-approval without a confidence floor is how silent bad data gets in.
    check(
      'approval_rules_auto_requires_floor',
      sql`${t.autoApprove} = false OR ${t.minConfidence} IS NOT NULL`,
    ),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Audit (⚖)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Append-only. Written by the core service-layer interceptor for tables registered as
 * ⚖ (orders, lcs, pending commits, payroll, adjustments, compliance, shipments,
 * finance) and for audited reads on payroll. Never updated, never deleted from the
 * application — retention is an ops decision, executed by ops.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigserial('id', { mode: 'bigint' }).primaryKey(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),

    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Role the actor was acting under at the time — roles change, the record should not. */
    actorRole: roleNameEnum('actor_role'),

    action: auditActionEnum('action').notNull(),
    targetTable: text('target_table').notNull(),
    targetId: text('target_id'),

    /** Full row images. `before` is null on insert, `after` is null on delete/read. */
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    /** Changed field names only — cheap to index and enough for most audit screens. */
    changedFields: text('changed_fields').array(),

    /** Set when this change came out of the approve loop. */
    pendingChangeId: uuid('pending_change_id').references(() => pendingChanges.id, {
      onDelete: 'set null',
    }),

    requestId: text('request_id'),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // "Everything that ever happened to this row."
    index('audit_log_target_idx').on(t.companyId, t.targetTable, t.targetId, t.occurredAt.desc()),
    // The audit viewer (X.3), and the payroll-read report.
    index('audit_log_company_time_idx').on(t.companyId, t.occurredAt.desc()),
    index('audit_log_actor_idx').on(t.companyId, t.actorUserId, t.occurredAt.desc()),
    index('audit_log_pending_idx').on(t.pendingChangeId),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Outbox
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transactional outbox (architecture §1.4). The event row is inserted in the SAME
 * transaction as the data change, so an event can never exist without its change and
 * a change can never silently fail to emit. The relay job is the only bridge to BullMQ.
 *
 * Delivery is at-least-once by design — handlers dedupe on `id` via `processed_events`.
 */
export const outbox = pgTable(
  'outbox',
  {
    /** Also the idempotency key consumers dedupe on. */
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Dotted event name from the owning module's events.ts, e.g. 'orders.milestone.slipped'. */
    eventName: text('event_name').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

    aggregateTable: text('aggregate_table'),
    aggregateId: text('aggregate_id'),

    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
  },
  (t) => [
    // The relay's only query: unpublished, oldest first. Partial index keeps it tiny
    // however large the table grows.
    index('outbox_unpublished_idx')
      .on(t.occurredAt)
      .where(sql`published_at IS NULL`),
    index('outbox_company_event_idx').on(t.companyId, t.eventName, t.occurredAt.desc()),
  ],
).enableRLS()

/**
 * Consumer-side idempotency ledger. A handler records (event, queue) here inside its
 * own transaction; a redelivered event finds the row and returns without re-applying.
 * Not tenant-scoped: it is worker infrastructure, keyed by the globally unique event id.
 */
export const processedEvents = pgTable(
  'processed_events',
  {
    eventId: uuid('event_id').notNull(),
    /** Same event fans out to several queues; each consumer dedupes independently. */
    queue: text('queue').notNull(),
    processedAt: timestamp('processed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('processed_events_pk').on(t.eventId, t.queue),
    index('processed_events_time_idx').on(t.processedAt),
  ],
)

// ─────────────────────────────────────────────────────────────────────────────
// Notifications
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-app notifications and the queue-side record of what was emailed/pushed.
 * Either `user_id` (one person) or `role` (everyone holding that role in the company)
 * must be set — enforced by check constraint, because a notification addressed to
 * nobody is a silent failure.
 *
 * `dedupe_key` makes notification-producing jobs safely re-runnable: the nightly TNA
 * scan can emit "milestone X at risk" every night without stacking duplicates.
 */
/**
 * A device that asked to be pushed to (mobile contract §2, plan 4.1).
 *
 * Addressing, not money — no audit registration. One row per browser/device endpoint; the
 * unique index on the endpoint means re-subscribing the same device updates rather than
 * duplicates, and the delivery helper prunes rows the push service reports gone (404/410).
 * Push is a second delivery channel for `notifications` rows, never its own event system.
 */
export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The push service URL — unique per device+browser profile. */
    endpoint: text('endpoint').notNull(),
    /** The browser's p256dh/auth key pair, exactly as PushSubscription.toJSON() gives it. */
    keys: jsonb('keys').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('push_subscriptions_endpoint_key').on(t.endpoint),
    index('push_subscriptions_company_user_idx').on(t.companyId, t.userId),
  ],
)

export const notifications = pgTable(
  'notifications',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    role: roleNameEnum('role'),

    /** Notification type, e.g. 'lc.expiry_near' — the i18n key stem, not display text. */
    kind: text('kind').notNull(),
    severity: notificationSeverityEnum('severity').notNull().default('info'),
    /** i18n keys; no hardcoded UI strings (CLAUDE.md, definition of done). */
    titleKey: text('title_key').notNull(),
    bodyKey: text('body_key'),
    /** Interpolation values for the keys above. */
    params: jsonb('params').$type<Record<string, unknown>>().notNull().default({}),

    moduleId: text('module_id'),
    entityTable: text('entity_table'),
    entityId: text('entity_id'),
    /** Deep link into the app. */
    href: text('href'),

    /** Idempotency for job-generated notifications. */
    dedupeKey: text('dedupe_key'),

    /** Delivery channels requested: ['in_app','email','push']. */
    channels: text('channels').array().notNull().default(sql`ARRAY['in_app']::text[]`),
    emailedAt: timestamp('emailed_at', { withTimezone: true }),

    readAt: timestamp('read_at', { withTimezone: true }),
    dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The bell: this user's unread notifications, newest first.
    index('notifications_user_unread_idx')
      .on(t.companyId, t.userId, t.createdAt.desc())
      .where(sql`read_at IS NULL`),
    index('notifications_role_idx').on(t.companyId, t.role, t.createdAt.desc()),
    uniqueIndex('notifications_dedupe_key')
      .on(t.companyId, t.dedupeKey)
      .where(sql`dedupe_key IS NOT NULL`),
    check(
      'notifications_has_recipient',
      sql`${t.userId} IS NOT NULL OR ${t.role} IS NOT NULL`,
    ),
  ],
).enableRLS()


/**
 * One row per scheduled task execution — the record that makes a silent scheduler visible.
 *
 * Without it, a cron that stops firing produces nothing at all: no error, no failed job, no
 * trace. The TNA scan simply never runs again and every milestone stays "on track". This
 * table is what `core.job_health` reads to notice, and what `/api/health` reads to notice
 * the case the in-worker check cannot — the whole worker being dead.
 *
 * A row is written when the task STARTS and updated when it ends, so a run that was killed
 * mid-flight stays `running` rather than vanishing. That is a signal too: a job stuck for
 * hours looks different from one that never began.
 *
 * Append-only and pruned; `core.prune_job_runs` keeps the recent window. The five-minute
 * tasks alone are 288 rows a day per company, and unbounded history would make the very
 * query that watches them slow.
 */
/**
 * `skipped` is not a success and not a failure (plan 6.1).
 *
 * A task that declines to do anything — the extraction runner with no provider registered —
 * used to close as `succeeded`, because `recordRun` recorded whatever the function returned.
 * So job health reported green while documents piled up unread. It is also not a failure:
 * nothing broke, the work is still queued, and paging somebody would be a false alarm.
 * `lastSuccessByTask` counts only `succeeded`, so a run of skips ages exactly like silence.
 */
export const jobRunStatusEnum = pgEnum('job_run_status', [
  'running',
  'succeeded',
  'failed',
  'skipped',
])

export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** The scheduled task id, e.g. `orders.tna_scan`. */
    task: text('task').notNull(),
    status: jobRunStatusEnum('status').notNull().default('running'),

    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    durationMs: integer('duration_ms'),

    /** Whatever the task returned — counts, skips, reasons. Read when diagnosing. */
    result: jsonb('result').$type<Record<string, unknown> | null>(),
    error: text('error'),
    /** BullMQ job id, for tying a row back to a queue entry. */
    jobId: text('job_id'),
  },
  (t) => [
    // The staleness query: last success per (company, task).
    index('job_runs_company_task_idx').on(t.companyId, t.task, t.startedAt.desc()),
    // The prune scan.
    index('job_runs_started_idx').on(t.startedAt),
    check(
      'job_runs_finished_has_status',
      sql`${t.finishedAt} IS NULL OR ${t.status} <> 'running'`,
    ),
  ],
).enableRLS()

// ─────────────────────────────────────────────────────────────────────────────
// Offline sync
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Idempotency ledger for floor-facing writes (dev-plan §2.2.6, architecture §3).
 *
 * A tablet on an unreliable network queues writes locally and replays the whole batch
 * when it reconnects — sometimes more than once. Each logical write carries a device
 * generated `offline_key`; the unique index below is what turns a replay into a no-op
 * instead of a duplicate cutting entry or a double-counted hour of production.
 *
 * The recorded result is returned on replay, so the device reconciles against what
 * actually landed rather than assuming its second attempt did nothing.
 */
export const offlineKeys = pgTable(
  'offline_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    companyId: uuid('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'cascade' }),

    /** Device-generated, stable across replays of the same logical write. */
    offlineKey: text('offline_key').notNull(),
    moduleId: text('module_id').notNull(),
    operation: text('operation').notNull(),

    /** 'applied' or 'rejected' — a rejected row must not be retried into a duplicate. */
    status: text('status').notNull(),
    /** Primary key of the row the write produced, so a replay can return it verbatim. */
    resultRowId: text('result_row_id'),
    error: jsonb('error').$type<Record<string, unknown>>(),

    /**
     * What the device was trying to write — kept ONLY when the row was refused.
     *
     * A refusal is somebody's work disappearing: a challan counted at the delivery bay, a
     * cut report taken off the table. The reason alone tells a supervisor that a GRN was
     * lost and nothing about what was on it, so nobody can re-enter it. The payload is what
     * makes the reconciliation report actionable rather than a list of regrets.
     *
     * Not stored on the applied path. That row already exists in its own table, and copying
     * every floor write into a second place would double the write cost of the busiest
     * endpoint in the product to record something already recorded.
     */
    payload: jsonb('payload').$type<Record<string, unknown>>(),

    /** Device clock at capture. The server keeps its own timestamps; this aids conflicts. */
    clientRecordedAt: timestamp('client_recorded_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The whole mechanism. Replay hits this and returns the recorded result.
    uniqueIndex('offline_keys_company_key').on(t.companyId, t.offlineKey),
    index('offline_keys_company_created_idx').on(t.companyId, t.createdAt.desc()),
  ],
).enableRLS()
