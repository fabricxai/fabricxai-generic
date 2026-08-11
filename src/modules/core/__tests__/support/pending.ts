/**
 * The propose → approve → commit round trip, as one call (plan 3.3).
 *
 * A registered pending target can look completely healthy and still fail at the last step.
 * Propose validates the payload, the inbox renders the draft, a reviewer reads it — and the
 * commit is a separate piece of code that has never run. `commit-handlers.test.ts` catches
 * the crudest version of that (a camelCase payload against core's generic write) by reading
 * the source; it cannot tell whether a module's own handler actually writes a row, writes
 * the RIGHT row, or throws on a foreign key nobody wired.
 *
 * This is the shared harness that answers those, so a target test is a payload and an
 * assertion rather than thirty lines of ceremony. Everything invariant about the trip is
 * asserted here, once:
 *
 *  - the draft is created `pending` (an unexpected auto-approve would otherwise be invisible)
 *  - approve reports `committed`, not `awaiting_approvals`
 *  - `committed_row_id` is set, and the draft's own status closed with it
 *
 * That last pair is the one worth having in a shared place. `ApproveResult.committedRowId`
 * is null while a draft is short of its approvals, and a caller that treats null as success
 * reports a two-approver change as done on the first click.
 */
import { eq } from 'drizzle-orm'
import { expect } from 'vitest'

import { pendingChanges } from '@/db/schema/core'
import type { AnyCtx } from '@/modules/core/ctx'
import { approve, propose } from '@/modules/core/pending-changes'
import { withTenantRead } from '@/modules/core/tenancy'

export interface PendingTargetTrip {
  moduleId: string
  targetTable: string
  zodSchemaKey: string
  payload: Record<string, unknown>
  operation?: 'insert' | 'update' | 'delete'
  /** Required for update and delete, refused for insert — `propose` checks the pairing. */
  targetId?: string
  /**
   * Defaults to `user_draft`, which carries no confidence and is the honest source for a
   * fixture. An `ai_*` source is refused without per-field confidence, so a test that wants
   * to exercise that path has to supply it.
   */
  source?: 'ai_extraction' | 'ai_chat' | 'user_draft' | 'import' | 'integration'
  fieldConfidence?: Record<string, number>
}

export interface TripResult {
  pendingChangeId: string
  /** The primary key of the row that was actually written. */
  rowId: string
}

/**
 * Draft it, approve it, and hand back the row it became.
 *
 * `ctx` must hold a role the target's rule accepts — with no `approval_rules` row that is
 * the module's registered `approvalDefaults`, so an owner ctx works for every module in this
 * repo except where a module narrowed it deliberately.
 */
export async function proposeApproveCommit(
  ctx: AnyCtx,
  trip: PendingTargetTrip,
  /**
   * Who signs. Defaults to the proposer — which the ⚖ tables now REFUSE (adoption plan
   * 3.1), so any case touching an audited target must hand in a second person, exactly as
   * the product demands of a real reviewer. The default stays for the non-⚖ targets whose
   * review-your-own-upload flow is the designed path.
   */
  approveAs: AnyCtx = ctx,
): Promise<TripResult> {
  const label = `${trip.moduleId}/${trip.targetTable}`

  const draft = await propose(ctx, {
    moduleId: trip.moduleId,
    targetTable: trip.targetTable,
    targetId: trip.targetId,
    operation: trip.operation ?? 'insert',
    payload: trip.payload,
    zodSchemaKey: trip.zodSchemaKey,
    source: trip.source ?? 'user_draft',
    fieldConfidence: trip.fieldConfidence,
  })

  // A target that auto-approved here would mean an `approval_rules` row leaked in from
  // another case — and the rest of this trip would then be asserting nothing.
  expect(draft.status, `${label} was auto-approved at propose`).toBe('pending')

  const result = await approve(approveAs, { pendingChangeId: draft.id })

  expect(result.status, `${label} did not commit`).toBe('committed')
  expect(result.committedRowId, `${label} committed with no row id`).toBeTruthy()

  // The draft has to close WITH the row. A commit that writes the target and leaves the
  // draft pending puts the same change back in somebody's inbox to be applied twice.
  const [closed] = await withTenantRead(ctx, (tx) =>
    tx.select().from(pendingChanges).where(eq(pendingChanges.id, draft.id)),
  )

  expect(closed?.status, `${label} left its draft open`).toBe('committed')
  expect(closed?.committedRowId).toBe(result.committedRowId)
  expect(closed?.committedAt).toBeInstanceOf(Date)

  return { pendingChangeId: draft.id, rowId: result.committedRowId! }
}
