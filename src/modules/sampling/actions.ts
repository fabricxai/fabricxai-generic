'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import {
  addSampleCost,
  advanceStage,
  closeSampleRequest,
  createSampleRequest,
  dispatchSample,
  recordFeedback,
} from './service'

function refresh(id?: string): void {
  revalidatePath('/sampling')
  if (id) revalidatePath(`/sampling/${id}`)
  // A PP verdict opens or shuts the cutting gate, so the floor's view of it is stale.
  revalidatePath('/cutting')
}

/** Raise a sample request. Proto belongs to an RFQ, PP to an order — never both. */
export async function raiseSampleRequest(input: {
  rfqId?: string
  orderId?: string
  type: string
  styleCode: string
  requestNo: string
  dueDate?: string
}): Promise<{ sampleRequestId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'merchandiser')
  // Refusals as values (lib/action-failure): "a PP sample must belong to an order" is a
  // sentence a person needs to read, and production masks anything thrown.
  return surfaced(async () => {
    const result = await createSampleRequest(ctx, input)
    refresh()
    return result
  })
}

/**
 * Move a sample to the next stage.
 *
 * Stages are events, not a column — the board reads the furthest one reached. That is why
 * a sample can be re-advanced without corrupting anything, and why the history is a list
 * rather than a single value somebody overwrote.
 */
export async function moveSampleStage(input: {
  sampleRequestId: string
  stage: string
  occurredAt?: string
}): Promise<{ stage: string }> {
  const ctx = await requireRole(await headers(), 'merchandiser')
  const result = await advanceStage(ctx, input)
  refresh(input.sampleRequestId)
  return { stage: String(result.stage) }
}

/**
 * Record the buyer's verdict on a round.
 *
 * **This is what releases cutting.** An approved PP round is the signal the cutting gate
 * reads through the provider this module registers, so the verdict is never defaulted — the
 * zod refuses a round without one, because a verdict arriving by omission would open the
 * most expensive gate in the factory by omission.
 *
 * Comments are itemised. A rejection with no readable comment is a sample nobody can remake
 * correctly, and "rejected" on its own sends a sampling room guessing for a week.
 *
 * **`offlineKey` is the client's, and it matters here more than anywhere else in this
 * module** (audit BE-M3). This action and the `record_feedback` sync handler call the same
 * service; the handler carried an idempotency key and the action did not. A submit retried
 * by the browser — a dropped response, a double tap on a tablet — wrote a SECOND round with
 * the same words, and the round in force is whichever is latest. One buyer email became a
 * two-round history, and a merchandiser reading "round 2" concluded the buyer had come back.
 *
 * Optional rather than required so a caller that has no key still works; the screen supplies
 * one per composed verdict and rotates it once the round lands.
 */
export async function recordBuyerVerdict(input: {
  sampleRequestId: string
  verdict: 'approved' | 'approved_with_comments' | 'rejected'
  comments: { area: string; comment: string }[]
  recordedOn: string
  offlineKey?: string
}): Promise<{ round: number; releasesCutting: boolean }> {
  const ctx = await requireRole(await headers(), 'merchandiser')
  const result = await recordFeedback(ctx, input)
  refresh(input.sampleRequestId)

  return {
    round: Number((result as { round?: number }).round ?? 0),
    // Approved-with-comments still releases: the buyer accepted the garment and listed
    // things to watch. Treating it as a rejection stops a floor that has permission to run.
    releasesCutting: input.verdict !== 'rejected',
  }
}

/** Mark a sample sent, with the courier and airway bill the buyer will chase it by. */
export async function markSampleDispatched(input: {
  sampleRequestId: string
  courier: string
  awb: string
}): Promise<{ dispatchId: string }> {
  const ctx = await requireRole(await headers(), 'merchandiser')
  const result = await dispatchSample(ctx, input)
  refresh(input.sampleRequestId)
  return result
}

/**
 * Add a cost to the sample.
 *
 * Sampling costs are real money that never appears on an invoice — fabric, trims and a
 * machinist's day, spent to win work that may not come. A room that does not total them
 * cannot tell a merchandiser which buyer is expensive to quote for.
 */
export async function addCostToSample(input: {
  sampleRequestId: string
  kind: string
  amount: string
  currency: string
  note?: string
}): Promise<{ runningTotal: string }> {
  const ctx = await requireRole(await headers(), 'merchandiser')

  // `sample_costs` has no `kind` column and the payload has no such field, so passing one
  // through would be stripped by zod and silently lost — a dropdown that records nothing.
  // Folded into the note, which is the field that exists.
  const note = [input.kind, input.note].filter(Boolean).join(' · ')

  const result = await addSampleCost(ctx, {
    sampleRequestId: input.sampleRequestId,
    amount: input.amount,
    currency: input.currency,
    ...(note ? { note } : {}),
  })
  refresh(input.sampleRequestId)
  return { runningTotal: result.runningTotal }
}

/** Close a request once it has served its purpose. */
export async function closeSample(input: { sampleRequestId: string }): Promise<void> {
  const ctx = await requireRole(await headers(), 'merchandiser')
  await closeSampleRequest(ctx, input)
  refresh(input.sampleRequestId)
}
