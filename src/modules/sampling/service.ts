/**
 * 1.4 Sampling — service layer.
 *
 * This module owns the PP-approval gate (rule 8, `GATES.ppApproval`). Module 5.1 Cutting
 * fails closed against it, so until `register.ts` runs nothing can be cut — and once it
 * runs, `resolvePpApproval` below is the whole answer.
 *
 * The verdict in force is always the LATEST feedback round. A buyer who approves round 1,
 * sees the corrected sample and rejects round 2 has withdrawn the approval, and a gate
 * reading "has ever been approved" would leave a floor cutting against a decision nobody
 * made. Revocation emits its own event, because by then cutting may already have started.
 */
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm'

import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import type { GateResult } from '../core/gates'
import { notify } from '../core/notifications'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { SAMPLING_EVENTS } from './events'
import {
  sampleCosts,
  sampleDispatches,
  sampleFeedbackRounds,
  sampleRequests,
  sampleStageEvents,
} from './schema'
import {
  latestRound,
  ppBlockingUrgency,
  ppGateDecision,
  SamplingError,
  stagePosition,
  totalSampleCost,
  type FeedbackRound,
  type SampleRequestStatus,
  type SampleStage,
} from './sampling'
import {
  dispatchPayload,
  feedbackRoundPayload,
  sampleCostPayload,
  sampleRequestPayload,
  stageAdvancePayload,
} from './zod'

/**
 * requested → in_work → dispatched → feedback → approved | rejected → closed.
 *
 * `rejected` is not terminal: a rejected sample is remade and goes back into the room,
 * which is the normal case rather than the exception. `closed` is the terminal one.
 */
export const sampleRequestMachine = defineStateMachine({
  field: 'status',
  initial: 'requested',
  transitions: {
    requested: ['in_work', 'closed'],
    in_work: ['dispatched', 'closed'],
    dispatched: ['feedback', 'closed'],
    feedback: ['approved', 'rejected', 'closed'],
    approved: ['feedback', 'closed'],
    rejected: ['in_work', 'feedback', 'closed'],
    closed: [],
  },
})

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface SamplingPolicy {
  /** Days before planned cutting at which an unapproved PP escalates. Brief says 5. */
  ppBlockingWindowDays: number
}

function wrapSamplingError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof SamplingError) {
      throw new AppError('validation_failed', 'sampling.errors.invalid', {
        reason: error.message,
      })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The PP gate — what 5.1 Cutting calls
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the PP-approval gate for an order style.
 *
 * Registered as 5.1's provider in `register.ts`. The lookup is by (order, style code,
 * type=pp): a sample request carries a style CODE rather than an `order_style_id` because
 * proto and SMS samples are made before any order exists.
 */
export async function resolvePpApproval(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { orderId: string; orderStyleId: string },
): Promise<GateResult> {
  const { orderStyles } = await import('@/modules/orders/schema')

  const [style] = await tx
    .select({ styleCode: orderStyles.styleCode })
    .from(orderStyles)
    .where(scoped(orderStyles, ctx, eq(orderStyles.id, input.orderStyleId)))

  if (!style) {
    // The gate cannot pass on a style it cannot find. Blocking is the safe direction.
    return {
      passed: false,
      reasonKey: 'gates.pp_approval.style_not_found',
      facts: { orderStyleId: input.orderStyleId },
    }
  }

  const [request] = await tx
    .select()
    .from(sampleRequests)
    .where(scoped(sampleRequests, ctx, 
      and(
        eq(sampleRequests.orderId, input.orderId),
        eq(sampleRequests.styleCode, style.styleCode),
        eq(sampleRequests.type, 'pp'),
      ),
    ))
    .orderBy(desc(sampleRequests.createdAt))
    .limit(1)

  const rounds = request ? await loadRounds(ctx, tx, request.id) : []

  return wrapSamplingError(() =>
    ppGateDecision({
      request: request
        ? {
            requestId: request.id,
            type: request.type,
            styleCode: request.styleCode,
            status: request.status,
          }
        : null,
      rounds,
      styleCode: style.styleCode,
    }),
  )
}

async function loadRounds(
  // `ctx`, because these rounds carry the buyer's VERDICT — the fact that opens cutting.
  ctx: AnyCtx,
  tx: TenantDb,
  sampleRequestId: string,
): Promise<FeedbackRound[]> {
  const rows = await tx
    .select({
      round: sampleFeedbackRounds.round,
      verdict: sampleFeedbackRounds.verdict,
      comments: sampleFeedbackRounds.comments,
      recordedOn: sampleFeedbackRounds.recordedOn,
    })
    .from(sampleFeedbackRounds)
    .where(scoped(sampleFeedbackRounds, ctx, eq(sampleFeedbackRounds.sampleRequestId, sampleRequestId)))
    .orderBy(sampleFeedbackRounds.round)

  return rows.map((row) => ({
    round: row.round,
    verdict: row.verdict,
    commentCount: row.comments.length,
    recordedOn: row.recordedOn,
  }))
}

/** The same rounds, keeping the buyer's itemised notes — see `sampleTimeline`. */
async function loadRoundsWithComments(
  ctx: AnyCtx,
  tx: TenantDb,
  sampleRequestId: string,
): Promise<(FeedbackRound & { comments: { area: string; comment: string; page?: number }[] })[]> {
  const rows = await tx
    .select({
      round: sampleFeedbackRounds.round,
      verdict: sampleFeedbackRounds.verdict,
      comments: sampleFeedbackRounds.comments,
      recordedOn: sampleFeedbackRounds.recordedOn,
    })
    .from(sampleFeedbackRounds)
    .where(scoped(sampleFeedbackRounds, ctx, eq(sampleFeedbackRounds.sampleRequestId, sampleRequestId)))
    .orderBy(sampleFeedbackRounds.round)

  return rows.map((row) => ({
    round: row.round,
    verdict: row.verdict,
    commentCount: row.comments.length,
    recordedOn: row.recordedOn,
    comments: row.comments as { area: string; comment: string; page?: number }[],
  }))
}

/** Read-only preview of the gate — the merchandiser's "can they cut yet?" panel. */
export async function checkPpApprovalFor(
  ctx: AnyCtx,
  input: { orderId: string; orderStyleId: string },
): Promise<GateResult> {
  return withTenantRead(ctx, async (tx) => resolvePpApproval(ctx, tx, input))
}

// ─────────────────────────────────────────────────────────────────────────────
// The sample room
// ─────────────────────────────────────────────────────────────────────────────

export async function createSampleRequest(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ sampleRequestId: string }> {
  return withTenantTx(ctx, (tx) => createSampleRequestIn(ctx, tx, input))
}

/**
 * Commit a sample request drafted through the approve inbox.
 *
 * `sample_requests` was a pending target with no handler, so core's generic write took it
 * and refused `rfqId`, `orderId`, `styleCode`, `requestNo` and `dueDate` as invalid column
 * identifiers. Every drafted request failed at approval.
 *
 * Going through `createSampleRequestIn` keeps the cross-tenant order check — Postgres runs
 * FK checks with RLS bypassed, so a generic insert would happily have pointed a sample at
 * another company's order — and emits `sampling.requested`, which the PP-approval alerts
 * hang off.
 */
export async function commitSampleRequestDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    throw new AppError('validation_failed', 'sampling.errors.request_draft_insert_only', {
      operation: input.operation,
    })
  }
  const result = await createSampleRequestIn(ctx, tx, input.payload)
  return {
    rowId: result.sampleRequestId,
    before: null,
    after: { sampleRequestId: result.sampleRequestId },
  }
}

async function createSampleRequestIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ sampleRequestId: string }> {
  const payload = sampleRequestPayload.parse(input)

  return (async () => {
    if (payload.orderId) {
      // Postgres performs foreign-key checks with RLS bypassed, so the FK on `order_id`
      // would let another tenant reference an order that is not theirs — and the success
      // or failure of that insert tells them whether the id exists. The app layer is the
      // first wall (rule 2); this is it.
      const { orders } = await import('@/modules/orders/schema')
      const [order] = await tx
        .select({ id: orders.id })
        .from(orders)
        .where(scoped(orders, ctx, eq(orders.id, payload.orderId)))

      if (!order) {
        throw notFound('sampling.errors.order_not_found', { orderId: payload.orderId })
      }
    }

    const [row] = await tx
      .insert(sampleRequests)
      .values({
        companyId: ctx.companyId,
        rfqId: payload.rfqId ?? null,
        orderId: payload.orderId ?? null,
        type: payload.type,
        styleCode: payload.styleCode,
        requestNo: payload.requestNo,
        dueDate: payload.dueDate ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: sampleRequests.id })

    if (!row) throw new Error('sample_requests insert returned nothing')

    await emit(ctx, tx, {
      eventName: SAMPLING_EVENTS.requested,
      payload: {
        sampleRequestId: row.id,
        type: payload.type,
        styleCode: payload.styleCode,
        orderId: payload.orderId ?? null,
        dueDate: payload.dueDate ?? null,
      },
      aggregateTable: 'sample_requests',
      aggregateId: row.id,
    })

    return { sampleRequestId: row.id }
  })()
}

/**
 * Advance a sample to a stage (brief: "stage advance (floor, offline-queued)").
 *
 * Stages move forward only. A sample that has reached sewing cannot be recorded as back
 * in pattern — that is a remake, which is a new sample request, not an edit to this one's
 * history.
 */
export async function advanceStage(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ stage: SampleStage; sampleRequestId: string }> {
  const payload = stageAdvancePayload.parse(input)
  return withTenantTx(ctx, async (tx) => advanceStageIn(ctx, tx, payload))
}

async function advanceStageIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof stageAdvancePayload.parse>,
): Promise<{ stage: SampleStage; sampleRequestId: string }> {
  const [request] = await tx
    .select()
    .from(sampleRequests)
    .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, payload.sampleRequestId)))
    .for('update')

  if (!request) {
    throw notFound('sampling.errors.request_not_found', {
      sampleRequestId: payload.sampleRequestId,
    })
  }
  if (request.status === 'closed') {
    throw conflict('sampling.errors.request_closed', { sampleRequestId: request.id })
  }

  const existing = await tx
    .select({ stage: sampleStageEvents.stage })
    .from(sampleStageEvents)
    .where(scoped(sampleStageEvents, ctx, eq(sampleStageEvents.sampleRequestId, request.id)))

  const furthest = existing.reduce(
    (max, row) => Math.max(max, wrapSamplingError(() => stagePosition(row.stage))),
    -1,
  )
  const next = wrapSamplingError(() => stagePosition(payload.stage))

  if (next <= furthest) {
    // Going backwards is a remake, which is a new sample request rather than an edit to
    // this one's history.
    throw conflict('sampling.errors.stage_not_forward', {
      sampleRequestId: request.id,
      stage: payload.stage,
    })
  }

  await tx.insert(sampleStageEvents).values({
    companyId: ctx.companyId,
    sampleRequestId: request.id,
    stage: payload.stage,
    occurredAt: payload.occurredAt ? new Date(payload.occurredAt) : new Date(),
    offlineKey: payload.offlineKey ?? null,
    createdBy: ctx.userId,
  })

  if (request.status === 'requested') {
    await tx
      .update(sampleRequests)
      .set({ status: 'in_work', updatedAt: new Date() })
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, request.id)))
  }

  await emit(ctx, tx, {
    eventName: SAMPLING_EVENTS.stageAdvanced,
    payload: { sampleRequestId: request.id, stage: payload.stage },
    aggregateTable: 'sample_requests',
    aggregateId: request.id,
  })

  return { stage: payload.stage, sampleRequestId: request.id }
}

export async function dispatchSample(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ dispatchId: string }> {
  const payload = dispatchPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [request] = await tx
      .select()
      .from(sampleRequests)
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, payload.sampleRequestId)))
      .for('update')

    if (!request) {
      throw notFound('sampling.errors.request_not_found', {
        sampleRequestId: payload.sampleRequestId,
      })
    }

    sampleRequestMachine.assert(request.status as SampleRequestStatus, 'dispatched')

    const [row] = await tx
      .insert(sampleDispatches)
      .values({
        companyId: ctx.companyId,
        sampleRequestId: request.id,
        courier: payload.courier,
        awb: payload.awb,
        dispatchedAt: payload.dispatchedAt ? new Date(payload.dispatchedAt) : new Date(),
        createdBy: ctx.userId,
      })
      .returning({ id: sampleDispatches.id })

    if (!row) throw new Error('sample_dispatches insert returned nothing')

    await tx
      .update(sampleRequests)
      .set({ status: 'dispatched', updatedAt: new Date() })
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, request.id)))

    await emit(ctx, tx, {
      eventName: SAMPLING_EVENTS.dispatched,
      payload: { sampleRequestId: request.id, courier: payload.courier, awb: payload.awb },
      aggregateTable: 'sample_requests',
      aggregateId: request.id,
    })

    return { dispatchId: row.id }
  })
}

export interface FeedbackResult {
  roundId: string
  round: number
  ppGateOpen: boolean
  requestStatus: SampleRequestStatus
}

/**
 * Record a buyer's verdict.
 *
 * Round numbers are assigned HERE, not by the caller: a client-supplied round number is a
 * client that can overwrite a verdict by reusing one, and the whole gate rests on the
 * latest round being unambiguous.
 *
 * On a PP sample this is the moment the cutting gate opens or closes, so both directions
 * emit — `pp_approved` when it opens, `pp_approval.revoked` when a later round takes it
 * away, because by then cutting may already have started.
 */
export async function recordFeedback(
  ctx: RequestCtx,
  input: unknown,
): Promise<FeedbackResult> {
  const payload = feedbackRoundPayload.parse(input)
  return withTenantTx(ctx, async (tx) => recordFeedbackIn(ctx, tx, payload))
}

/**
 * Commit a buyer's feedback round drafted through the approve inbox — a comment sheet
 * transcribed rather than typed live.
 *
 * Core's generic write refused `sampleRequestId`, `recordedOn` and `documentId` as invalid
 * identifiers. It would also have written the round WITHOUT the two things that make a
 * round mean anything: the request's status move, and the round NUMBER — which
 * `recordFeedbackIn` assigns under a row lock precisely so a caller cannot reuse one and
 * overwrite a verdict. A drafted round carrying its own round number is exactly that
 * caller.
 */
export async function commitFeedbackRoundDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    // A verdict is a record of what the buyer said. Editing one rewrites history that the
    // PP gate — and therefore the cutting floor — already acted on.
    throw new AppError('validation_failed', 'sampling.errors.feedback_draft_insert_only', {
      operation: input.operation,
    })
  }

  const result = await recordFeedbackIn(ctx, tx, feedbackRoundPayload.parse(input.payload))
  return {
    rowId: result.roundId,
    before: null,
    after: {
      roundId: result.roundId,
      round: result.round,
      ppGateOpen: result.ppGateOpen,
      requestStatus: result.requestStatus,
    },
  }
}

async function recordFeedbackIn(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: ReturnType<typeof feedbackRoundPayload.parse>,
): Promise<FeedbackResult> {
  const [request] = await tx
    .select()
    .from(sampleRequests)
    .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, payload.sampleRequestId)))
    .for('update')

  if (!request) {
    throw notFound('sampling.errors.request_not_found', {
      sampleRequestId: payload.sampleRequestId,
    })
  }
  if (request.status === 'closed') {
    throw conflict('sampling.errors.request_closed', { sampleRequestId: request.id })
  }

  /*
   * A resend is not a second round (audit BE-M3).
   *
   * Checked under the request's row lock taken above, so two requests carrying the same key
   * cannot both pass it. The unique index is the wall behind this; this is what turns a
   * duplicate into the ORIGINAL answer rather than an error — a device replaying its queue
   * and a browser retrying a submit both need to be told what actually landed, not that
   * something went wrong.
   *
   * Deliberately returns the existing round unchanged and emits nothing. Re-emitting
   * `feedback.recorded` would re-open the PP gate notification for a verdict already acted
   * on, which is the cutting floor being told twice that it may start.
   */
  if (payload.offlineKey) {
    const [already] = await tx
      .select()
      .from(sampleFeedbackRounds)
      .where(
        and(
          eq(sampleFeedbackRounds.companyId, ctx.companyId),
          eq(sampleFeedbackRounds.offlineKey, payload.offlineKey),
        ),
      )

    if (already) {
      return {
        roundId: already.id,
        round: already.round,
        ppGateOpen: request.type === 'pp' && already.verdict !== 'rejected',
        requestStatus: request.status as SampleRequestStatus,
      }
    }
  }

  const before = await loadRounds(ctx, tx, request.id)
  const wasOpen =
    request.type === 'pp' &&
    wrapSamplingError(() =>
      ppGateDecision({
        request: {
          requestId: request.id,
          type: request.type,
          styleCode: request.styleCode,
          status: request.status,
        },
        rounds: before,
        styleCode: request.styleCode,
      }),
    ).passed

  // Assigned here, under the row lock taken above — a caller-supplied round number is a
  // caller that can overwrite a verdict by reusing one.
  const nextRound = (latestRound(before)?.round ?? 0) + 1

  const [row] = await tx
    .insert(sampleFeedbackRounds)
    .values({
      companyId: ctx.companyId,
      sampleRequestId: request.id,
      round: nextRound,
      verdict: payload.verdict,
      comments: payload.comments,
      recordedOn: payload.recordedOn,
      documentId: payload.documentId ?? null,
      offlineKey: payload.offlineKey ?? null,
      createdBy: ctx.userId,
    })
    .returning({ id: sampleFeedbackRounds.id })

  if (!row) throw new Error('sample_feedback_rounds insert returned nothing')

  const nextStatus: SampleRequestStatus = payload.verdict === 'rejected' ? 'rejected' : 'approved'

  // The machine allows feedback from several states; move through `feedback` first so an
  // approval straight off a dispatched sample is still a legal path.
  if (request.status === 'dispatched' || request.status === 'in_work') {
    await tx
      .update(sampleRequests)
      .set({ status: 'feedback', updatedAt: new Date() })
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, request.id)))
  }

  await tx
    .update(sampleRequests)
    .set({ status: nextStatus, updatedAt: new Date() })
    .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, request.id)))

  const after = [
    ...before,
    {
      round: nextRound,
      verdict: payload.verdict,
      commentCount: payload.comments.length,
      recordedOn: payload.recordedOn,
    },
  ]

  const decision =
    request.type === 'pp'
      ? wrapSamplingError(() =>
          ppGateDecision({
            request: {
              requestId: request.id,
              type: request.type,
              styleCode: request.styleCode,
              status: nextStatus,
            },
            rounds: after,
            styleCode: request.styleCode,
          }),
        )
      : { passed: false }

  await emit(ctx, tx, {
    eventName: SAMPLING_EVENTS.feedbackRecorded,
    payload: {
      sampleRequestId: request.id,
      round: nextRound,
      verdict: payload.verdict,
      comments: payload.comments.length,
    },
    aggregateTable: 'sample_requests',
    aggregateId: request.id,
  })

  if (request.type === 'pp' && decision.passed && !wasOpen) {
    // The event the rest of the factory waits for.
    await emit(ctx, tx, {
      eventName: SAMPLING_EVENTS.ppApproved,
      payload: {
        sampleRequestId: request.id,
        orderId: request.orderId,
        styleCode: request.styleCode,
        verdict: payload.verdict,
        round: nextRound,
        openComments: payload.verdict === 'approved_with_comments' ? payload.comments.length : 0,
      },
      aggregateTable: 'sample_requests',
      aggregateId: request.id,
    })

    /*
     * The Table app's buzz (mobile contract §3): a PP verdict is the gate the cutting
     * floor waits behind, and the cutter learns it today by somebody walking over. An
     * approval says "you can start"; a rejection says "you still cannot" — both are the
     * cutter's news, so both go, worded by verdict.
     */
    if (request.type === 'pp') {
      await notify(ctx, {
        role: 'cutting',
        kind: 'sampling.pp.verdict',
        severity: payload.verdict === 'rejected' ? 'warning' : 'info',
        titleKey:
          payload.verdict === 'rejected'
            ? 'sampling.notifications.pp_rejected.title'
            : 'sampling.notifications.pp_approved.title',
        params: { styleCode: request.styleCode },
        moduleId: 'sampling',
        entityTable: 'sample_requests',
        entityId: request.id,
        href: '/cutting',
        dedupeKey: `pp-verdict:${request.id}:${nextRound}`,
        channels: ['in_app', 'push'],
      })
    }
  }

  if (request.type === 'pp' && !decision.passed && wasOpen) {
    // A later round withdrew an approval the floor may already have cut against.
    await emit(ctx, tx, {
      eventName: SAMPLING_EVENTS.ppApprovalRevoked,
      payload: {
        sampleRequestId: request.id,
        orderId: request.orderId,
        styleCode: request.styleCode,
        round: nextRound,
        reasonKey: decision.reasonKey ?? 'gates.pp_approval.rejected',
      },
      aggregateTable: 'sample_requests',
      aggregateId: request.id,
    })
  }

  return {
    roundId: row.id,
    round: nextRound,
    ppGateOpen: decision.passed,
    requestStatus: nextStatus,
  }
}

export async function closeSampleRequest(
  ctx: RequestCtx,
  input: { sampleRequestId: string },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [request] = await tx
      .select()
      .from(sampleRequests)
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, input.sampleRequestId)))
      .for('update')

    if (!request) {
      throw notFound('sampling.errors.request_not_found', {
        sampleRequestId: input.sampleRequestId,
      })
    }

    sampleRequestMachine.assert(request.status as SampleRequestStatus, 'closed')

    await tx
      .update(sampleRequests)
      .set({ status: 'closed', updatedAt: new Date() })
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, request.id)))
  })
}

export async function addSampleCost(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ costId: string; runningTotal: string; currency: string }> {
  const payload = sampleCostPayload.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(sampleCosts)
      .values({
        companyId: ctx.companyId,
        sampleRequestId: payload.sampleRequestId,
        amount: payload.amount,
        currency: payload.currency,
        note: payload.note ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: sampleCosts.id })

    if (!row) throw new Error('sample_costs insert returned nothing')

    const all = await tx
      .select({ amount: sampleCosts.amount, currency: sampleCosts.currency })
      .from(sampleCosts)
      .where(scoped(sampleCosts, ctx, eq(sampleCosts.sampleRequestId, payload.sampleRequestId)))

    const currencies = new Set(all.map((c) => c.currency))
    if (currencies.size > 1) {
      // Adding taka to dollars needs a rate nobody has stated. Same rule as everywhere
      // else in this system: no ambient conversion.
      throw new AppError('validation_failed', 'sampling.errors.mixed_cost_currencies', {
        currencies: [...currencies],
      })
    }

    return {
      costId: row.id,
      runningTotal: wrapSamplingError(() => totalSampleCost(all.map((c) => c.amount))),
      currency: payload.currency,
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The blocking escalation (brief §Jobs)
// ─────────────────────────────────────────────────────────────────────────────

export interface PpBlockingAlert {
  sampleRequestId: string | null
  orderId: string
  styleCode: string
  cuttingPlannedDate: string
  daysToCutting: number
  overdue: boolean
}

/**
 * Which orders are about to hit a cutting date with no PP approval.
 *
 * Reads the planned cutting date from 1.3's TNA milestones through the orders module's
 * tables (rule 11 — orders owns them). An order with no cutting milestone is skipped
 * rather than assumed urgent: there is no date to be close to.
 */
export async function ppBlockingAlerts(
  ctx: AnyCtx,
  input: { today: string },
  policy: SamplingPolicy,
): Promise<PpBlockingAlert[]> {
  const { orderStyles, tnaMilestones } = await import('@/modules/orders/schema')

  return withTenantRead(ctx, async (tx) => {
    const horizon = addDays(input.today, policy.ppBlockingWindowDays)

    const milestones = await tx
      .select({
        orderId: tnaMilestones.orderId,
        plannedDate: tnaMilestones.plannedDate,
      })
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, 
        and(
          eq(tnaMilestones.name, 'cutting'),
          lte(tnaMilestones.plannedDate, horizon),
          // A milestone already actualised is not blocking anything.
          eq(tnaMilestones.status, 'pending'),
        ),
      ))

    if (milestones.length === 0) return []

    const styles = await tx
      .select({ orderId: orderStyles.orderId, styleCode: orderStyles.styleCode })
      .from(orderStyles)
      .where(scoped(orderStyles, ctx, 
        inArray(
          orderStyles.orderId,
          milestones.map((m) => m.orderId),
        ),
      ))

    const alerts: PpBlockingAlert[] = []

    for (const milestone of milestones) {
      for (const style of styles.filter((s) => s.orderId === milestone.orderId)) {
        const [request] = await tx
          .select()
          .from(sampleRequests)
          .where(scoped(sampleRequests, ctx, 
            and(
              eq(sampleRequests.orderId, milestone.orderId),
              eq(sampleRequests.styleCode, style.styleCode),
              eq(sampleRequests.type, 'pp'),
            ),
          ))
          .orderBy(desc(sampleRequests.createdAt))
          .limit(1)

        const rounds = request ? await loadRounds(ctx, tx, request.id) : []
        const decision = wrapSamplingError(() =>
          ppGateDecision({
            request: request
              ? {
                  requestId: request.id,
                  type: request.type,
                  styleCode: request.styleCode,
                  status: request.status,
                }
              : null,
            rounds,
            styleCode: style.styleCode,
          }),
        )

        const urgency = wrapSamplingError(() =>
          ppBlockingUrgency({
            cuttingPlannedDate: milestone.plannedDate,
            today: input.today,
            ppApproved: decision.passed,
            windowDays: policy.ppBlockingWindowDays,
          }),
        )

        if (!urgency.escalate) continue

        alerts.push({
          sampleRequestId: request?.id ?? null,
          orderId: milestone.orderId,
          styleCode: style.styleCode,
          cuttingPlannedDate: milestone.plannedDate,
          daysToCutting: urgency.daysToCutting,
          overdue: urgency.overdue,
        })
      }
    }

    // Most urgent first — an overdue line beats a reminder.
    return alerts.sort((a, b) => a.daysToCutting - b.daysToCutting)
  })
}

/** Raise the escalation events for today. Idempotent per (order, style, date) by design. */
export async function emitPpBlocking(
  // `AnyCtx`, not `RequestCtx`: this is a nightly job and the scheduler runs it as a system
  // actor. It reads nothing off the caller but the company — nobody authored these alerts.
  ctx: AnyCtx,
  input: { today: string },
  policy: SamplingPolicy,
): Promise<{ raised: number }> {
  const alerts = await ppBlockingAlerts(ctx, input, policy)
  if (alerts.length === 0) return { raised: 0 }

  return withTenantTx(ctx, async (tx) => {
    for (const alert of alerts) {
      await emit(ctx, tx, {
        eventName: SAMPLING_EVENTS.ppBlocking,
        payload: { ...alert, asOf: input.today },
        aggregateTable: 'sample_requests',
        aggregateId: alert.sampleRequestId ?? alert.orderId,
      })
    }
    return { raised: alerts.length }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/** The sample's whole story — what merchandising shows a buyer who asks. */
export async function sampleTimeline(
  ctx: AnyCtx,
  sampleRequestId: string,
): Promise<{
  request: typeof sampleRequests.$inferSelect
  stages: (typeof sampleStageEvents.$inferSelect)[]
  /**
   * Rounds WITH their comments, unlike the board's summary.
   *
   * `FeedbackRound` carries only a count, which is right for a board — a row that lists
   * eleven collar notes is unreadable at a glance. The detail screen is the one place the
   * comments have to be legible, because it is where somebody remakes the sample from them.
   */
  rounds: (FeedbackRound & { comments: { area: string; comment: string; page?: number }[] })[]
  dispatches: (typeof sampleDispatches.$inferSelect)[]
  totalCost: string
}> {
  return withTenantRead(ctx, async (tx) => {
    const [request] = await tx
      .select()
      .from(sampleRequests)
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.id, sampleRequestId)))

    if (!request) {
      throw notFound('sampling.errors.request_not_found', { sampleRequestId })
    }

    const [stages, rounds, dispatches, costs] = await Promise.all([
      tx
        .select()
        .from(sampleStageEvents)
        .where(scoped(sampleStageEvents, ctx, eq(sampleStageEvents.sampleRequestId, request.id)))
        .orderBy(sampleStageEvents.occurredAt),
      loadRoundsWithComments(ctx, tx, request.id),
      tx
        .select()
        .from(sampleDispatches)
        .where(scoped(sampleDispatches, ctx, eq(sampleDispatches.sampleRequestId, request.id)))
        .orderBy(desc(sampleDispatches.dispatchedAt)),
      tx
        .select({ amount: sampleCosts.amount })
        .from(sampleCosts)
        .where(scoped(sampleCosts, ctx, eq(sampleCosts.sampleRequestId, request.id))),
    ])

    return {
      request,
      stages,
      rounds,
      dispatches,
      totalCost: wrapSamplingError(() => totalSampleCost(costs.map((c) => c.amount))),
    }
  })
}

/** Samples past their due date with no verdict yet — the due-reminder job's list. */
export async function overdueSamples(
  ctx: AnyCtx,
  input: { today: string },
): Promise<(typeof sampleRequests.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(sampleRequests)
      .where(scoped(sampleRequests, ctx, 
        and(
          isNotNull(sampleRequests.dueDate),
          lte(sampleRequests.dueDate, input.today),
          inArray(sampleRequests.status, ['requested', 'in_work', 'dispatched', 'feedback']),
        ),
      ))
      .orderBy(sampleRequests.dueDate),
  )
}

function addDays(date: string, days: number): string {
  const parsed = new Date(`${date}T00:00:00Z`)
  parsed.setUTCDate(parsed.getUTCDate() + days)
  return parsed.toISOString().slice(0, 10)
}

/** Offline sync body, shared with the batch endpoint. */
export const offlineAdvanceStage = advanceStageIn
export const offlineRecordFeedback = recordFeedbackIn

export { conflict }
