/**
 * Read models for the Approve Inbox screens.
 *
 * `service.inbox()` already returns the routing decision — which drafts this
 * reviewer may sign, and how close each is to escalating. This file adds only
 * what the SCREEN needs on top of that: a human title, the order the draft
 * belongs to, and the field-level diff a reviewer reads before signing.
 *
 * Nothing here writes. The screen's two write paths are in `actions.ts`.
 */
import { and, desc, eq, gte, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { approvalRules, pendingChangeApprovals, pendingChanges, users } from '@/db/schema/core'
import type { AnyCtx, RequestCtx } from '@/modules/core/ctx'
import { buyerAccounts } from '@/modules/buyers/queries'
import { readJsonbObject } from '@/modules/core/jsonb'
import { selfApprovableDrafts } from '@/modules/core/pending-changes'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'

/**
 * `pending_changes.field_confidence`: field name → the extractor's confidence.
 *
 * Empty is meaningful and legal — it means a human wrote the draft. Confidence
 * outside 0–1 is not: it would sort a draft to the top or bottom of the inbox
 * on a number that means nothing, so the map is rejected rather than trusted.
 */
const fieldConfidenceSchema = z.record(z.string().min(1), z.number().min(0).max(1))

import { inbox, type ApprovalsPolicy, type InboxItem } from './service'

/** A uuid-shaped value is an id this system assigned, never something a document carried. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** A draft as the inbox list renders it. */
export interface InboxRow extends InboxItem {
  /** Human sentence for the row — "Breakdown edit · +2,000 pcs Navy/L". */
  title: string
  /** The order or document this draft hangs off, when the payload names one. */
  reference: string | null
  /**
   * Whether a human or a model produced this. The screen filters on it because
   * the two get read differently: a model draft is checked against its sources,
   * a human draft against its author's authority.
   */
  fromModel: boolean
  /** Past the policy's escalation window and still waiting. */
  aging: boolean
}

/**
 * Titles are derived, not stored.
 *
 * A stored title would be written once at propose time and then drift from the
 * payload it describes — and the payload is the thing being approved. Deriving
 * means the row always describes what is actually about to be committed.
 */
function titleFor(draft: {
  operation: string
  targetTable: string
  payload: Record<string, unknown>
}): string {
  const table = draft.targetTable.replace(/_/g, ' ')
  const verb =
    draft.operation === 'insert' ? 'New' : draft.operation === 'delete' ? 'Remove' : 'Edit'
  return `${verb} · ${table}`
}

/**
 * What a draft calls itself, in the words printed on the paper behind it.
 *
 * The list used to hold six keys, none of which a real module uses. A genuine order drafted
 * from a buyer's PO therefore reached the approver as "New · orders" with no reference at
 * all — while the SEEDED demo rows, which are unapprovable fixtures, showed `PO-1000`
 * because they happened to use `buyer_po_no`. The demo data read better than the real thing,
 * which is how nobody noticed.
 *
 * Ordered most-specific first: an order names itself by PO, a GRN by the challan it came in
 * on, an inspection by its own number. The first one present wins, and nothing invents a
 * reference from an id — a uuid in this column would be worse than the blank it replaced.
 */
const REFERENCE_KEYS = [
  'poNumbers', 'poNumber', 'po_number', 'buyer_po_no', 'buyerPoNo',
  'challanNo', 'challan_no',
  'inspectionNo', 'requestNo', 'layNo', 'cartonNo', 'code', 'number',
  'styleCode', 'employeeNo',
]

/**
 * The first identifier the payload carries, as a person would read it.
 *
 * Arrays are unwrapped: `orders.poNumbers` is `["PO-BF-2044"]` and a check for `typeof v ===
 * 'string'` silently skipped every order ever drafted. A multi-PO order shows the first and
 * says how many more, because the row has one line and the detail panel has the rest.
 */
function referenceFor(payload: Record<string, unknown>): string | null {
  for (const key of REFERENCE_KEYS) {
    const v = payload[key]
    if (typeof v === 'string' && v.length > 0) return v
    if (Array.isArray(v)) {
      const first = v.find((entry) => typeof entry === 'string' && entry.length > 0)
      if (typeof first === 'string') {
        return v.length > 1 ? `${first} +${v.length - 1}` : first
      }
    }
  }
  return null
}

export async function inboxRows(
  ctx: AnyCtx,
  input: { now: Date; moduleId?: string; limit?: number },
  policy: ApprovalsPolicy,
): Promise<InboxRow[]> {
  const items = await inbox(ctx, input, policy)
  if (items.length === 0) return []

  // One extra read for the payloads the list needs to describe itself.
  const drafts = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: pendingChanges.id,
        payload: pendingChanges.payload,
        operation: pendingChanges.operation,
        targetTable: pendingChanges.targetTable,
      })
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, 
        inArray(
          pendingChanges.id,
          items.map((i) => i.id),
        ),
      )),
  )

  const byId = new Map(drafts.map((d) => [d.id, d]))

  return items.map((item) => {
    const draft = byId.get(item.id)
    const payload = draft?.payload ?? {}
    return {
      ...item,
      title: draft ? titleFor(draft) : item.targetTable,
      reference: referenceFor(payload),
      // Only the two ai_* sources carry per-field confidence. `import` and
      // `integration` are machine-made but have no extractor behind them, so
      // grouping them with model drafts would promise a confidence the screen
      // then has nothing to show for.
      fromModel: item.source === 'ai_extraction' || item.source === 'ai_chat',
      aging: item.ageHours >= policy.agingEscalateAfterHours,
    }
  })
}

/** One changed field, as the diff panel renders it. */
export interface FieldDiff {
  field: string
  before: unknown
  after: unknown
  /** Straight from the extractor. Null for human drafts — absence, not a fake 1.0. */
  confidence: number | null
  changed: boolean
}

export interface DraftDetail {
  id: string
  moduleId: string
  targetTable: string
  targetId: string | null
  operation: string
  source: string
  sourceDocumentId: string | null
  extractorVersion: string | null
  model: string | null
  createdAt: Date
  payload: Record<string, unknown>
  fields: FieldDiff[]
  /** Who put this draft here, and who has signed it so far. */
  provenance: DraftProvenance
}

/**
 * The chain of hands a draft has passed through.
 *
 * `pending_changes.created_by` and `pending_change_approvals` have carried this since the
 * table was written, and `auditChain()` has assembled it since the module landed — but the
 * only caller was MARBIM's own `approvals.provenance` tool, so the one screen where a
 * reviewer signs their name to somebody else's work could not show whose work it was.
 * A signature nobody can trace is a countersignature in name only.
 *
 * `name` is nullable because the users join can miss: a person removed from the company
 * still has drafts in the inbox, and "someone who has left" is the honest rendering of that
 * — an id in their place would read as a system actor.
 */
export interface DraftProvenance {
  draftedBy: { id: string; name: string | null } | null
  approvals: { name: string | null; role: string; at: Date }[]
}

/**
 * The draft, field by field.
 *
 * `before` is supplied by the caller rather than read here, because only the
 * owning module knows how to fetch the current row for its own target table —
 * reading it generically would mean this file naming every table in the system.
 */
export async function draftDetail(
  ctx: AnyCtx,
  pendingChangeId: string,
  before: Record<string, unknown> | null,
): Promise<DraftDetail | null> {
  const row = await withTenantRead(ctx, async (tx) => {
    const [d] = await tx
      .select()
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, and(eq(pendingChanges.id, pendingChangeId), eq(pendingChanges.status, 'pending'))))
    return d ?? null
  })

  if (!row) return null

  /*
   * Same read, same tenant scope: who drafted it, and who has countersigned.
   *
   * A left join on both sides — a draft whose author has since left the company must still
   * render, and a first reviewer looking at an unsigned draft must not be told the query
   * failed. Ordered by signing time so the panel reads as a sequence of events.
   */
  const provenance = await withTenantRead(ctx, async (tx): Promise<DraftProvenance> => {
    /*
     * The drafter's name is reached THROUGH the draft, not looked up beside it.
     *
     * `users` is global — it has no company_id to name — so selecting from it by id would be
     * a query with no tenant predicate, and the lint rule that says so is right to. Joining
     * from the already-scoped pending_changes row means the only name this can return is the
     * one belonging to a draft this caller may already read.
     */
    const drafter = await tx
      .select({ name: users.name })
      .from(pendingChanges)
      .leftJoin(users, eq(pendingChanges.createdBy, users.id))
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.id, pendingChangeId)))

    const signed = await tx
      .select({
        name: users.name,
        role: pendingChangeApprovals.approvedAsRole,
        at: pendingChangeApprovals.createdAt,
      })
      .from(pendingChangeApprovals)
      .leftJoin(users, eq(pendingChangeApprovals.approverUserId, users.id))
      .where(
        scoped(
          pendingChangeApprovals,
          ctx,
          eq(pendingChangeApprovals.pendingChangeId, pendingChangeId),
        ),
      )
      .orderBy(pendingChangeApprovals.createdAt)

    return {
      draftedBy: row.createdBy ? { id: row.createdBy, name: drafter[0]?.name ?? null } : null,
      approvals: signed.map((s) => ({ name: s.name, role: String(s.role), at: s.at })),
    }
  })

  // null here means the stored map was malformed, which is NOT the same as a
  // human draft's empty map — so every field reports "no confidence" rather
  // than borrowing a number from a map we could not read.
  const confidence = readJsonbObject(
    fieldConfidenceSchema,
    row.fieldConfidence,
    'pending_changes.field_confidence',
  )

  const fields: FieldDiff[] = Object.entries(row.payload).map(([field, after]) => {
    const prior = before ? before[field] : undefined
    return {
      field,
      before: prior,
      after,
      confidence: confidence?.[field] ?? null,
      // An unchanged field still renders, greyed — a reviewer needs to see what
      // the draft leaves alone as much as what it moves.
      changed: before === null || JSON.stringify(prior) !== JSON.stringify(after),
    }
  })

  return {
    id: row.id,
    moduleId: row.moduleId,
    targetTable: row.targetTable,
    targetId: row.targetId,
    operation: row.operation,
    source: row.source,
    sourceDocumentId: row.sourceDocumentId,
    extractorVersion: row.extractorVersion,
    model: row.model,
    createdAt: row.createdAt,
    payload: row.payload,
    fields,
    provenance,
  }
}

/**
 * The trust footer's three numbers (X.2 canvas, P4).
 *
 * The point of publishing these is that the correction rate is the honest one — a
 * merchandiser who knows MARBIM gets the size ratio wrong one time in five checks that
 * field and trusts the other eight. Hiding it buys a trust that the first bad draft spends.
 *
 * Counted from `pending_changes`, so it is what actually happened in this tenant rather
 * than a figure typed into a design. `corrected` counts FIELDS a reviewer changed before
 * approving, not drafts — one draft corrected in three places is three corrections, which
 * is what a per-field rate needs.
 *
 * A new factory sees zeroes. That is the correct answer and the panel says so, rather than
 * borrowing somebody else's numbers to look established.
 */
export interface MarbimTrust {
  drafted: number
  approved: number
  correctedFields: number
  /** Still waiting — what the FAB's count badge shows. */
  pending: number
  /** How far back the numbers reach. */
  windowDays: number
}

export async function marbimTrust(ctx: AnyCtx, windowDays = 90): Promise<MarbimTrust> {
  const since = new Date(Date.now() - windowDays * 86_400_000)

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        status: pendingChanges.status,
        corrections: pendingChanges.corrections,
      })
      .from(pendingChanges)
      .where(
        and(
          eq(pendingChanges.companyId, ctx.companyId),
          gte(pendingChanges.createdAt, since),
          // Only what a model drafted. A row a person typed is not evidence about MARBIM.
          inArray(pendingChanges.source, ['ai_extraction', 'ai_chat']),
        ),
      )

    let approved = 0
    let pending = 0
    let correctedFields = 0

    for (const row of rows) {
      if (row.status === 'committed') approved += 1
      if (row.status === 'pending') pending += 1
      // Shape only — the values are whatever the reviewer typed, and this counts keys.
      const corrections = readJsonbObject(
        z.record(z.string().min(1), z.unknown()),
        row.corrections,
        'approvals.marbimTrust.corrections',
      )
      correctedFields += corrections ? Object.keys(corrections).length : 0
    }

    return { drafted: rows.length, approved, pending, correctedFields, windowDays }
  })
}

/**
 * How many drafts are waiting on THIS reviewer — the FAB's count badge.
 *
 * Deliberately routed through `inbox()`, the same call the approve screen renders from,
 * rather than a cheaper `count(*)` over pending rows. A count that is not role-routed says
 * "4 waiting" to a storekeeper whose inbox reads "Nothing routed to you" — a badge that
 * can never be cleared, on every screen, which is how people learn to stop reading badges.
 *
 * Two queries per page render buys the badge and the inbox agreeing by construction, and
 * they cannot drift because there is only one routing rule.
 */
export async function routedPendingCount(
  ctx: AnyCtx,
  policy: ApprovalsPolicy,
  now = new Date(),
): Promise<number> {
  const items = await inbox(ctx, { now }, policy)
  return items.length
}

/**
 * Which row a draft points at, so its prior state can be read.
 *
 * Separate from `draftDetail` because the caller has to fetch the before BETWEEN knowing
 * the target and building the diff, and `draftDetail` takes the before as an argument by
 * design — it does not read tables it does not own.
 */
export async function draftTarget(
  ctx: AnyCtx,
  pendingChangeId: string,
): Promise<{ targetTable: string; targetId: string | null } | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        targetTable: pendingChanges.targetTable,
        targetId: pendingChanges.targetId,
      })
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, and(eq(pendingChanges.id, pendingChangeId), eq(pendingChanges.status, 'pending'))))

    return row ?? null
  })
}

/**
 * The trail behind a COMMITTED record, keyed the way its own screen knows it.
 *
 * The approve inbox shows provenance while a draft is pending; the moment it is approved it
 * leaves the inbox, and the record's own screen — the RFQ drawer, an order page — is the
 * only place a reader would think to look. `pending_changes.committed_row_id` is the link:
 * written at commit, indexed since day one, and until now followed by nothing a screen
 * could reach.
 *
 * Returns null for a record with no draft behind it — one typed straight into a form is a
 * legitimate shape, and the drawer simply shows no trail rather than an empty ceremony.
 */
export interface RecordTrail {
  /** Null: no person behind the draft at all. `{name: null}`: a person who has since left. */
  draftedBy: { name: string | null } | null
  source: string
  draftedAt: Date
  approvals: { name: string | null; role: string; at: Date }[]
  committedAt: Date | null
}

export async function recordTrail(
  ctx: AnyCtx,
  input: { targetTable: string; targetId: string },
): Promise<RecordTrail | null> {
  return withTenantRead(ctx, async (tx) => {
    // Newest first: a record re-drafted after a rejection has several chains behind it, and
    // the one that produced the row as it stands is the one the reader is asking about.
    const [draft] = await tx
      .select({
        id: pendingChanges.id,
        source: pendingChanges.source,
        createdAt: pendingChanges.createdAt,
        committedAt: pendingChanges.committedAt,
        drafterName: users.name,
        drafterId: pendingChanges.createdBy,
      })
      .from(pendingChanges)
      .leftJoin(users, eq(pendingChanges.createdBy, users.id))
      .where(
        scoped(
          pendingChanges,
          ctx,
          and(
            eq(pendingChanges.targetTable, input.targetTable),
            eq(pendingChanges.committedRowId, input.targetId),
            eq(pendingChanges.status, 'committed'),
          ),
        ),
      )
      .orderBy(desc(pendingChanges.committedAt))
      .limit(1)

    if (!draft) return null

    const signed = await tx
      .select({
        name: users.name,
        role: pendingChangeApprovals.approvedAsRole,
        at: pendingChangeApprovals.createdAt,
      })
      .from(pendingChangeApprovals)
      .leftJoin(users, eq(pendingChangeApprovals.approverUserId, users.id))
      .where(scoped(pendingChangeApprovals, ctx, eq(pendingChangeApprovals.pendingChangeId, draft.id)))
      .orderBy(pendingChangeApprovals.createdAt)

    return {
      draftedBy: draft.drafterId ? { name: draft.drafterName ?? null } : null,
      source: draft.source,
      draftedAt: draft.createdAt,
      approvals: signed.map((s) => ({ name: s.name, role: String(s.role), at: s.at })),
      committedAt: draft.committedAt,
    }
  })
}

export interface RaisedDraft {
  id: string
  targetTable: string
  status: string
  createdAt: Date
  /** The reviewer's note — for a rejection, the reason they gave. */
  reviewNote: string | null
  /** Set when status is `failed`: what the commit refused with. */
  error: unknown
}

/**
 * The drafts THIS person raised, newest first (adoption plan 2.1).
 *
 * Cutting, maintenance and the store can raise drafts but hold no approve nav — their
 * corrections and overrides vanished into a queue they cannot see, and the only signal
 * back was the change silently appearing (or never appearing). Runbook #21 recorded the
 * shape: a double-click on a refusal masked as React #441, with no way to check what
 * became of the first click.
 *
 * Scoped to `created_by` and NOT to the caller's approver roles — that is the point: this
 * is the raiser's view, not the reviewer's. Terminal states stay visible for a bounded
 * window so "it was rejected, and here is the reviewer's reason" is an answer the floor
 * can read the next morning, not only in the minute it happened.
 */
export async function myRaisedDrafts(ctx: RequestCtx, limit = 8): Promise<RaisedDraft[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: pendingChanges.id,
        targetTable: pendingChanges.targetTable,
        status: pendingChanges.status,
        createdAt: pendingChanges.createdAt,
        reviewNote: pendingChanges.reviewNote,
        error: pendingChanges.error,
      })
      .from(pendingChanges)
      .where(scoped(pendingChanges, ctx, eq(pendingChanges.createdBy, ctx.userId)))
      .orderBy(desc(pendingChanges.createdAt))
      .limit(limit),
  )
}

export interface ApprovalRuleRow {
  id: string
  moduleId: string
  targetTable: string | null
  operation: string | null
  requiredRoles: string[]
  approvalsRequired: number
  autoApprove: boolean
  minConfidence: string | null
  /** null = the module's own answer. See `approval_rules.self_approval_allowed`. */
  selfApprovalAllowed: boolean | null
  priority: number
}

/**
 * The active routing rules, for the Settings surface (adoption plan 3.2).
 *
 * Active only: a superseded rule is history, and the audit trail is where history lives.
 * Ordered the way an owner reads the question — by module, then the narrower scope first,
 * so "orders / order_breakdowns" sits under "orders / whole module" rather than shuffled.
 */
export async function listApprovalRules(ctx: RequestCtx): Promise<ApprovalRuleRow[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: approvalRules.id,
        moduleId: approvalRules.moduleId,
        targetTable: approvalRules.targetTable,
        operation: approvalRules.operation,
        requiredRoles: approvalRules.requiredRoles,
        approvalsRequired: approvalRules.approvalsRequired,
        autoApprove: approvalRules.autoApprove,
        minConfidence: approvalRules.minConfidence,
        selfApprovalAllowed: approvalRules.selfApprovalAllowed,
        priority: approvalRules.priority,
      })
      .from(approvalRules)
      .where(scoped(approvalRules, ctx, eq(approvalRules.isActive, true)))
      .orderBy(approvalRules.moduleId, approvalRules.targetTable, approvalRules.operation),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// What MARBIM read, waiting on the person who asked for it
// ─────────────────────────────────────────────────────────────────────────────

export interface UnconfirmedDraft {
  id: string
  moduleId: string
  targetTable: string
  createdAt: Date
  /** Every field the extractor produced, with what it read and how sure it was. */
  fields: {
    name: string
    value: unknown
    /** Null for a field the extractor did not score — a person supplied it. */
    confidence: number | null
    /**
     * A value this person chose from a picker, not one the document carried. Shown as the
     * name they picked and NOT editable: it arrived as an id, and a person cannot usefully
     * check or retype a uuid — but they can be shown that the reading is filed against
     * "Bestseller A/S", which is the thing they would actually notice was wrong.
     */
    supplied?: { label: string }
  }[]
  /** The document it was read from, when one was attached. */
  sourceDocumentId: string | null
  model: string | null
  /**
   * May this person sign it themselves rather than send it on — the "Verify & apply" door.
   *
   * False for most drafts and that is the normal case: on a ⚖ table the ban stands unless
   * the module (or the factory's own rule) opened it, and even then only for a machine
   * reading. Resolved by core, which is also the wall, so the button and the server cannot
   * drift apart.
   */
  canApply: boolean
}

/**
 * Readings this person asked for that they have not yet checked.
 *
 * The queue between "MARBIM read your document" and "an approver is looking at it", which
 * did not exist: an extraction went straight into somebody else's inbox, so the approver
 * was asked to verify quantities against a purchase order sitting on another desk, and the
 * one person who could actually compare the two never saw the draft at all.
 *
 * Scoped to `created_by` AND to `drafted`, so it is exactly the raiser's own unsent work.
 * Nobody else can see a `drafted` row — not because it is secret, but because there is
 * nothing anyone else can do with it yet.
 *
 * Fields come back flat and in a stable order rather than as the raw payload: the dialog
 * shows a value beside its confidence, and a nested object has no single number to show.
 * A nested value is rendered as JSON and edited as a whole — honest about the fact that
 * `styles[]` is not a text box.
 */
export async function myUnconfirmedDrafts(
  ctx: RequestCtx,
  limit = 5,
): Promise<UnconfirmedDraft[]> {
  const rows = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: pendingChanges.id,
        moduleId: pendingChanges.moduleId,
        targetTable: pendingChanges.targetTable,
        payload: pendingChanges.payload,
        fieldConfidence: pendingChanges.fieldConfidence,
        sourceDocumentId: pendingChanges.sourceDocumentId,
        model: pendingChanges.model,
        createdAt: pendingChanges.createdAt,
      })
      .from(pendingChanges)
      .where(
        scoped(
          pendingChanges,
          ctx,
          and(eq(pendingChanges.status, 'drafted'), eq(pendingChanges.createdBy, ctx.userId)),
        ),
      )
      .orderBy(desc(pendingChanges.createdAt))
      .limit(limit),
  )

  /*
   * The names behind the ids, for the fields a person picked rather than the document
   * carried.
   *
   * Without this the dialog showed a merchandiser `7a42b4ed-bf78-4a06-970f-5d8351c796b9`
   * beside "100%" — a number they cannot check, wearing a confidence that is not the
   * extractor's, on a field they themselves chose from a dropdown. Resolving it costs one
   * query and turns a meaningless row into the one line most worth glancing at: the buyer
   * this whole order is about.
   */
  const uuidFields = new Set(
    rows.flatMap((row) =>
      Object.entries((row.payload ?? {}) as Record<string, unknown>)
        .filter(([, v]) => typeof v === 'string' && UUID_RE.test(v))
        .map(([k]) => k),
    ),
  )
  const names = uuidFields.has('buyerId')
    ? new Map((await buyerAccounts(ctx)).map((b) => [b.id, b.name]))
    : new Map<string, string>()

  const selfApprovable = await selfApprovableDrafts(ctx, rows.map((row) => row.id))

  return rows.map((row) => {
    const payload = (row.payload ?? {}) as Record<string, unknown>
    const confidence = (row.fieldConfidence ?? {}) as Record<string, number>
    return {
      id: row.id,
      moduleId: row.moduleId,
      targetTable: row.targetTable,
      createdAt: row.createdAt,
      sourceDocumentId: row.sourceDocumentId,
      model: row.model,
      canApply: selfApprovable.has(row.id),
      fields: Object.keys(payload)
        .sort()
        .map((name) => {
          const value = payload[name]
          const isId = typeof value === 'string' && UUID_RE.test(value)
          return {
            name,
            value,
            confidence: typeof confidence[name] === 'number' ? confidence[name] : null,
            ...(isId
              ? { supplied: { label: names.get(value) ?? 'chosen when you sent it' } }
              : {}),
          }
        }),
    }
  })
}
