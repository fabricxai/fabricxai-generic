'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import {
  approve,
  confirmDraft,
  currentRow,
  discardDraft,
  reject,
  type ApproveResult,
} from '@/modules/core/pending-changes'
import { surfaced, type ActionFailure } from '@/lib/action-failure'
import type { Role } from '@/modules/core/ctx'
import { requireRole } from '@/modules/core/session'
import { deactivateApprovalRule, upsertApprovalRule } from './service'

import { draftDetail, draftTarget, recordTrail, type DraftDetail, type RecordTrail } from './queries'

/**
 * The Approve Inbox's two write paths.
 *
 * Thin by contract (CLAUDE.md rule 1): auth → zod → service. Neither of these
 * touches `db`; the transaction, the audit row and the outbox event all belong
 * to `core/pending-changes`, which is what keeps a commit atomic with its trail.
 */

/**
 * Roles the inbox is offered to — the same list `nav.ts` uses for `/approve`.
 *
 * Deliberately broad, and deliberately not the real decision. Which drafts a person may
 * actually sign is settled per draft by the approval rules in `core/pending-changes`:
 * `requiredRoles`, and `approvalsRequired` counted over DISTINCT approvers. This gate only
 * keeps out the roles with nothing to approve at all — a viewer, a plain member — so that
 * the rule engine is never the first thing standing between them and a commit.
 *
 * This comment used to claim the rules also refuse somebody approving their own draft. They
 * do not, and never did. Whether they should is a real question with two sides — the intended
 * flow for a document intake is that the person who uploaded the PO reviews the extraction
 * and signs it, so a blanket ban would break the main path — but a comment asserting a
 * control that does not exist is worse than either answer. What IS enforced is that a rule
 * demanding two approvals gets two different people. Recorded in docs/STUBS.md.
 */
const APPROVER_ROLES = [
  'merchandiser',
  'commercial',
  'planner',
  'store',
  'procurement',
  'production',
  'quality',
  'compliance',
  'finance',
  'hr',
] as const

const approveInput = z.object({
  pendingChangeId: z.string().uuid(),
  /**
   * Field edits the reviewer made before signing. This is the correction
   * telemetry the extractor is scored on, so it is captured at the moment of
   * approval rather than inferred later from a row diff.
   */
  corrections: z.record(z.string().min(1), z.unknown()).optional(),
  note: z.string().max(2000).optional(),
})

const rejectInput = z.object({
  pendingChangeId: z.string().uuid(),
  /** A rejection without a reason is a dead end for whoever drafted it. */
  reason: z.string().min(1).max(200),
  note: z.string().max(2000).optional(),
})

export async function approveDraft(
  input: z.input<typeof approveInput>,
): Promise<ApproveResult | ActionFailure> {
  // Surfaced above all for the race: two managers approving the same draft is exactly
  // what the typed 409 exists for, and its sentence — "already decided" — was reaching
  // the loser as React #441 (live-test finding, Phase 9, caught in the two-browser race).
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), ...APPROVER_ROLES)
    const parsed = approveInput.parse(input)

    const result = await approve(ctx, parsed)

    revalidatePath('/approve')
    return result
  })
}

export async function rejectDraft(input: z.input<typeof rejectInput>): Promise<void | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), ...APPROVER_ROLES)
    const { pendingChangeId, reason, note } = rejectInput.parse(input)

    // The reason is the first line of the note so it survives into `review_note`,
    // which is what the drafter actually reads when the item comes back to them.
    await reject(ctx, pendingChangeId, note ? `${reason}\n\n${note}` : reason)

    revalidatePath('/approve')
  })
}

/**
 * The fields a draft would write — what the reviewer is actually deciding on.
 *
 * The inbox listed a draft's module, target table, source, confidence and age, and never
 * the payload. So "insert on buyer requirements · confidence 0.62" was the whole of what
 * somebody approved: they could see the extractor was unsure and not what it was unsure
 * about. Per-field confidence only means something next to the field it belongs to.
 *
 * Fetched per row on expand rather than with the list. A fifty-draft inbox would otherwise
 * ship fifty payloads to the browser to render two, and payloads carry buyer prices and
 * wage rates — sending them to a screen nobody opened is a wider read than the reviewer
 * asked for.
 *
 * **The before comes from the row itself.** An insert has none — which is most of this
 * inbox — but an update showed only the incoming value, so a breakdown revision read as
 * "cells: Navy/L 2000" with no sign of the grid it replaces. `currentRow` is the same read
 * `approve` uses to capture `before` for the audit log, so what a reviewer signs is what
 * the trail records.
 */
export async function draftFields(
  input: { pendingChangeId: string },
): Promise<DraftDetail | null | ActionFailure> {
  const ctx = await requireRole(await headers(), ...APPROVER_ROLES)

  return surfaced(async () => {
    const { pendingChangeId } = z.object({ pendingChangeId: z.string().uuid() }).parse(input)

    const draft = await draftTarget(ctx, pendingChangeId)
    if (!draft) return null

    const before = await currentRow(ctx, draft.targetTable, draft.targetId)

    return draftDetail(ctx, pendingChangeId, before)
  })
}

const trailInput = z.object({
  /** An identifier, not free text — the same character set the audit interceptor enforces. */
  targetTable: z.string().regex(/^[a-z][a-z0-9_]{0,62}$/),
  targetId: z.string().uuid(),
})

/**
 * The trail behind a committed record, for the record's own screen.
 *
 * Same audience as the inbox: anyone whose role can approve could always have watched the
 * draft pass through, so showing them afterwards who drafted and who signed discloses
 * nothing new. Roles outside that set get the usual 403 and the screen simply shows no
 * trail — a viewer's drawer looks exactly as it did before this existed.
 */
export async function committedTrail(
  input: z.input<typeof trailInput>,
): Promise<RecordTrail | null | ActionFailure> {
  const ctx = await requireRole(await headers(), ...APPROVER_ROLES)

  return surfaced(async () => {
    const { targetTable, targetId } = trailInput.parse(input)

    return recordTrail(ctx, { targetTable, targetId })
  })
}

/**
 * The routing rules an owner may tune (adoption plan 3.2).
 *
 * Owner-only, and surfaced: the service refuses a non-owner with a sentence, and
 * `approval_rules` deciding who signs what means a refusal here has to be readable rather
 * than a masked #441. NO `condition` field anywhere — `pickRule` matches on module, target
 * and operation only, and a form offering a condition the engine ignores is the day-0
 * script's own recorded trap (a rule that looks like a gate and is not one).
 */
const ruleInput = z.object({
  moduleId: z.string().min(1),
  targetTable: z.string().min(1).optional(),
  operation: z.enum(['insert', 'update', 'delete']).optional(),
  requiredRoles: z.array(z.string().min(1)).min(1),
  approvalsRequired: z.number().int().min(1).max(5).optional(),
  priority: z.number().int().optional(),
})

export async function setApprovalRule(
  input: z.input<typeof ruleInput>,
): Promise<{ ruleId: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'owner')
    const parsed = ruleInput.parse(input)
    const { ruleId } = await upsertApprovalRule(ctx, {
      ...parsed,
      requiredRoles: parsed.requiredRoles as Role[],
    })
    revalidatePath('/settings')
    return { ruleId }
  })
}

export async function removeApprovalRule(
  input: { ruleId: string },
): Promise<{ ruleId: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'owner')
    const parsed = z.object({ ruleId: z.string().uuid() }).parse(input)
    const result = await deactivateApprovalRule(ctx, parsed)
    revalidatePath('/settings')
    return result
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The raiser's own check, before anybody else is asked
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Roles that may confirm their own reading.
 *
 * Wider than `INBOX_ROLES` on purpose, and it is not a weakening: `confirmDraft` refuses
 * anybody who is not the row's own `created_by`, so this list only has to admit the roles
 * that can queue a document at all. A storekeeper who photographs a UD is entitled to check
 * what was read off it — and is still not entitled to approve it.
 */
const RAISER_ROLES: readonly Role[] = [
  'owner',
  'admin',
  'merchandiser',
  'commercial',
  'store',
  'procurement',
  'planner',
  'quality',
  'hr',
  'compliance',
  'production',
  'cutting',
  'shipment',
  'maintenance',
  'finance',
]

const confirmInput = z.object({
  pendingChangeId: z.uuid(),
  /** Field → the value the raiser corrected it to. Absent means "as read". */
  corrections: z.record(z.string(), z.unknown()).optional(),
})

/**
 * "Yes, that is what the paper says" — and only then does an approver see it.
 *
 * The corrections here are the most reliable signal this product collects about its own
 * extractor: made by the one person holding the document, before anyone else's opinion is
 * in the room. They are stored apart from the reviewer's for that reason.
 */
export async function confirmMyDraft(
  input: unknown,
): Promise<{ id: string; status: 'pending' | 'committed' } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...RAISER_ROLES)
  return surfaced(async () => {
    const parsed = confirmInput.parse(input)
    const result = await confirmDraft(ctx, {
      pendingChangeId: parsed.pendingChangeId,
      ...(parsed.corrections ? { corrections: parsed.corrections } : {}),
    })
    revalidatePath('/home')
    revalidatePath('/approve')
    return result
  })
}

/** "No, that is not what it says" — thrown away by its own author, and counted. */
export async function discardMyDraft(input: unknown): Promise<void | ActionFailure> {
  const ctx = await requireRole(await headers(), ...RAISER_ROLES)
  return surfaced(async () => {
    const parsed = z
      .object({ pendingChangeId: z.uuid(), reason: z.string().max(500).optional() })
      .parse(input)
    await discardDraft(ctx, {
      pendingChangeId: parsed.pendingChangeId,
      ...(parsed.reason ? { reason: parsed.reason } : {}),
    })
    revalidatePath('/home')
  })
}
