/**
 * Read models for the Sampling Room.
 *
 * This module owns the answer to the PP-approval gate that blocks cutting, so
 * the board's real job is to surface the sample whose absence is about to stop
 * a cutting table — not merely to list what is in the room.
 *
 * A PP sample is the buyer signing off one garment before the factory makes
 * eighty thousand. Everything else here is context for that one verdict.
 */
import { and, asc, desc, eq, ilike, inArray, or } from 'drizzle-orm'

import { likePattern } from '@/lib/search-text'
import type { AnyCtx } from '@/modules/core/ctx'
import { readJsonbArray } from '@/modules/core/jsonb'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { orders } from '@/modules/orders/schema'

import {
  sampleFeedbackRounds,
  samplePhotos,
  sampleRequests,
  sampleStageEvents,
} from './schema'
import { buyerComment } from './zod'

export type SampleType = 'proto' | 'fit' | 'sms' | 'pp' | 'top' | 'shipment'
export type SampleStatus =
  | 'requested'
  | 'in_work'
  | 'dispatched'
  | 'feedback'
  | 'approved'
  | 'rejected'
  | 'closed'

export interface SampleRow {
  id: string
  requestNo: string
  type: SampleType
  styleCode: string
  status: SampleStatus
  dueDate: string | null
  /** Negative once the due date has passed. Null when no date was set. */
  daysToDue: number | null
  poNumber: string | null
  /** Furthest stage reached, from the stage events — not a stored column. */
  stage: string | null
  /**
   * Latest buyer verdict and which round it was. `comments` are the buyer's
   * itemised notes — a rejection with no readable comment is a sample nobody
   * can remake correctly, so unreadable ones are counted rather than dropped.
   */
  latestVerdict: {
    round: number
    verdict: string
    comments: { area: string; comment: string; page?: number }[]
    unreadableComments: number
  } | null
  roundCount: number
}

const STAGE_ORDER = ['pattern', 'cutting', 'sewing', 'finishing', 'qc', 'dispatched'] as const

function daysUntil(dateIso: string, now: Date): number {
  const target = new Date(`${dateIso}T00:00:00Z`).getTime()
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.round((target - today) / 86_400_000)
}

export async function sampleBoard(ctx: AnyCtx, input: { now: Date }): Promise<SampleRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: sampleRequests.id,
        requestNo: sampleRequests.requestNo,
        type: sampleRequests.type,
        styleCode: sampleRequests.styleCode,
        status: sampleRequests.status,
        dueDate: sampleRequests.dueDate,
        orderId: sampleRequests.orderId,
      })
      .from(sampleRequests)
      .orderBy(desc(sampleRequests.createdAt))
      .limit(150)

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)
    const orderIds = rows.map((r) => r.orderId).filter((id): id is string => !!id)

    const [stages, rounds, orderRows] = await Promise.all([
      tx
        .select({
          sampleRequestId: sampleStageEvents.sampleRequestId,
          stage: sampleStageEvents.stage,
        })
        .from(sampleStageEvents)
        .where(scoped(sampleStageEvents, ctx, inArray(sampleStageEvents.sampleRequestId, ids))),
      tx
        .select({
          sampleRequestId: sampleFeedbackRounds.sampleRequestId,
          round: sampleFeedbackRounds.round,
          verdict: sampleFeedbackRounds.verdict,
          comments: sampleFeedbackRounds.comments,
        })
        .from(sampleFeedbackRounds)
        .where(scoped(sampleFeedbackRounds, ctx, inArray(sampleFeedbackRounds.sampleRequestId, ids)))
        .orderBy(desc(sampleFeedbackRounds.round)),
      orderIds.length > 0
        ? tx
            .select({ id: orders.id, poNumbers: orders.poNumbers })
            .from(orders)
            .where(scoped(orders, ctx, inArray(orders.id, orderIds)))
        : Promise.resolve([] as { id: string; poNumbers: string[] | null }[]),
    ])

    return rows.map((r): SampleRow => {
      const mine = stages.filter((s) => s.sampleRequestId === r.id)
      // Furthest reached, not most recent: stages can be logged out of order
      // from a tablet that reconnected late.
      const furthest = mine
        .map((s) => STAGE_ORDER.indexOf(s.stage as (typeof STAGE_ORDER)[number]))
        .filter((i) => i >= 0)
        .sort((a, b) => b - a)[0]

      const myRounds = rounds.filter((x) => x.sampleRequestId === r.id)
      const latest = myRounds[0] ?? null
      const latestComments = readJsonbArray(
        buyerComment,
        latest?.comments,
        'sample_feedback_rounds.comments',
      )

      return {
        id: r.id,
        requestNo: r.requestNo,
        type: r.type as SampleType,
        styleCode: r.styleCode,
        status: r.status as SampleStatus,
        dueDate: r.dueDate,
        daysToDue: r.dueDate ? daysUntil(r.dueDate, input.now) : null,
        poNumber: orderRows.find((o) => o.id === r.orderId)?.poNumbers?.[0] ?? null,
        stage: furthest !== undefined ? STAGE_ORDER[furthest]! : null,
        latestVerdict: latest
          ? {
              round: latest.round,
              verdict: latest.verdict,
              comments: latestComments.items,
              unreadableComments: latestComments.unreadable,
            }
          : null,
        roundCount: myRounds.length,
      }
    })
  })
}

/**
 * Style codes whose PP sample is approved — the styles cutting may start on.
 *
 * Matches `resolvePpApproval`'s lookup: type `pp` AND status `approved`. A
 * proto or fit sample being approved says nothing about whether cutting may
 * begin, so both conditions have to hold.
 */
export async function ppApprovedStyles(ctx: AnyCtx): Promise<string[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ styleCode: sampleRequests.styleCode })
      .from(sampleRequests)
      .where(scoped(sampleRequests, ctx, and(eq(sampleRequests.type, 'pp'), eq(sampleRequests.status, 'approved'))))
      .orderBy(asc(sampleRequests.styleCode))

    return [...new Set(rows.map((r) => r.styleCode))]
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The library
// ─────────────────────────────────────────────────────────────────────────────

export interface LibraryHit {
  id: string
  requestNo: string
  type: SampleType
  styleCode: string
  status: SampleStatus
  poNumber: string | null
  buyerName: string | null
  requestedOn: string
  /** The last word the buyer said on it, and how many attempts it took. */
  finalVerdict: string | null
  rounds: number
  /**
   * How many rounds the buyer rejected — not whether the last one did.
   *
   * A sample rejected twice and approved on the third is an approved sample AND a style with
   * a history, and the history is the reason somebody opened the library. Reading only the
   * final verdict reports it as clean.
   */
  rejectedRounds: number
  /** Every comment across every round, newest round first. The reusable part. */
  comments: { round: number; area: string; comment: string; recordedOn: string }[]
  /** Comments that failed to parse — counted, never silently dropped. */
  unreadableComments: number
  photos: number
}

export interface LibraryFilter {
  /** Matched against style code, request number, and the text of buyer comments. */
  query?: string
  type?: SampleType
  /** `approved` folds in approved-with-comments — both mean the buyer accepted it. */
  outcome?: 'approved' | 'rejected' | 'undecided'
  limit?: number
}

/**
 * Past samples, searched by what somebody actually remembers about them.
 *
 * The board answers "what is in the room now". This answers the question asked before a new
 * sample is made: **have we made this before, and what did the buyer say?** A factory that
 * cannot answer it remakes the same collar three seasons running and is corrected on it
 * three times.
 *
 * **The comments are searchable, not just the style code.** The reusable knowledge is not
 * "we made SHRT-4410" — it is "the buyer rejected the collar stand on it twice". Somebody
 * looking for a fabric problem searches `puckering`, not a style they have never heard of,
 * and a search over identifiers alone would return nothing for the query most worth asking.
 *
 * **Matching is literal, and that is deliberate.** `modules/memory` owns semantic similarity
 * over styles; a second, weaker notion of "similar" living here would disagree with it, and
 * the one people would trust is whichever they happened to open. This finds what contains
 * the words. Anything cleverer belongs behind 1.6.
 */
export async function sampleLibrary(
  ctx: AnyCtx,
  filter: LibraryFilter = {},
): Promise<LibraryHit[]> {
  const limit = filter.limit ?? 60
  const needle = filter.query?.trim().toLowerCase() ?? ''

  return withTenantRead(ctx, async (tx) => {
    const { buyers } = await import('@/modules/buyers/schema')

    const rows = await tx
      .select({
        id: sampleRequests.id,
        requestNo: sampleRequests.requestNo,
        type: sampleRequests.type,
        styleCode: sampleRequests.styleCode,
        status: sampleRequests.status,
        createdAt: sampleRequests.createdAt,
        poNumbers: orders.poNumbers,
        buyerName: buyers.name,
      })
      .from(sampleRequests)
      .leftJoin(orders, eq(orders.id, sampleRequests.orderId))
      .leftJoin(buyers, eq(buyers.id, orders.buyerId))
      .where(scoped(sampleRequests, ctx, filter.type ? eq(sampleRequests.type, filter.type) : undefined))
      .orderBy(desc(sampleRequests.createdAt))

    if (rows.length === 0) return []

    const roundRows = await tx
      .select()
      .from(sampleFeedbackRounds)
      .where(scoped(sampleFeedbackRounds, ctx, 
        inArray(
          sampleFeedbackRounds.sampleRequestId,
          rows.map((r) => r.id),
        ),
      ))
      .orderBy(desc(sampleFeedbackRounds.round))

    const photoRows = await tx
      .select({ sampleRequestId: samplePhotos.sampleRequestId })
      .from(samplePhotos)
      .where(scoped(samplePhotos, ctx, 
        inArray(
          samplePhotos.sampleRequestId,
          rows.map((r) => r.id),
        ),
      ))

    const photoCount = new Map<string, number>()
    for (const photo of photoRows) {
      photoCount.set(photo.sampleRequestId, (photoCount.get(photo.sampleRequestId) ?? 0) + 1)
    }

    const hits: LibraryHit[] = rows.map((row) => {
      const mine = roundRows.filter((r) => r.sampleRequestId === row.id)

      const comments: LibraryHit['comments'] = []
      let unreadable = 0

      for (const round of mine) {
        // Parsed with the schema the write side validated against — a comment that no
        // longer fits is counted rather than dropped, because a rejection nobody can read
        // is a sample nobody can remake correctly.
        const parsed = readJsonbArray(
          buyerComment,
          round.comments,
          'sample_feedback_rounds.comments',
        )
        unreadable += parsed.unreadable
        for (const comment of parsed.items) {
          comments.push({
            round: round.round,
            area: comment.area,
            comment: comment.comment,
            recordedOn: round.recordedOn,
          })
        }
      }

      return {
        id: row.id,
        requestNo: row.requestNo,
        type: row.type as SampleType,
        styleCode: row.styleCode,
        status: row.status as SampleStatus,
        poNumber: row.poNumbers?.[0] ?? null,
        buyerName: row.buyerName,
        requestedOn: row.createdAt.toISOString().slice(0, 10),
        // The HIGHEST round is the last word — `mine` is ordered by round descending.
        finalVerdict: mine[0]?.verdict ?? null,
        rounds: mine.length,
        rejectedRounds: mine.filter((r) => r.verdict === 'rejected').length,
        comments,
        unreadableComments: unreadable,
        photos: photoCount.get(row.id) ?? 0,
      }
    })

    const outcomeMatches = (hit: LibraryHit): boolean => {
      if (!filter.outcome) return true
      if (filter.outcome === 'undecided') return hit.finalVerdict === null
      if (filter.outcome === 'rejected') return hit.finalVerdict === 'rejected'
      // "Approved with comments" is still the buyer accepting it — a search for what was
      // approved that hid them would send somebody to remake a sample that passed.
      return hit.finalVerdict === 'approved' || hit.finalVerdict === 'approved_with_comments'
    }

    const textMatches = (hit: LibraryHit): boolean => {
      if (needle === '') return true
      return (
        hit.styleCode.toLowerCase().includes(needle) ||
        hit.requestNo.toLowerCase().includes(needle) ||
        (hit.buyerName?.toLowerCase().includes(needle) ?? false) ||
        hit.comments.some(
          (c) =>
            c.comment.toLowerCase().includes(needle) || c.area.toLowerCase().includes(needle),
        )
      )
    }

    return hits.filter((hit) => outcomeMatches(hit) && textMatches(hit)).slice(0, limit)
  })
}


/** A sample request, as the command bar shows it. */
export interface SampleSearchRow {
  id: string
  requestNo: string
  styleCode: string
  type: string
  status: string
}

/** Sample requests matching a request number or style code. */
export async function searchSampleRequests(
  ctx: AnyCtx,
  input: { term: string; limit: number },
): Promise<SampleSearchRow[]> {
  const like = likePattern(input.term)

  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: sampleRequests.id,
        requestNo: sampleRequests.requestNo,
        styleCode: sampleRequests.styleCode,
        type: sampleRequests.type,
        status: sampleRequests.status,
      })
      .from(sampleRequests)
      .where(
        scoped(
          sampleRequests,
          ctx,
          or(ilike(sampleRequests.requestNo, like), ilike(sampleRequests.styleCode, like)),
        ),
      )
      .limit(input.limit),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Where this order's PP sample has got to
// ─────────────────────────────────────────────────────────────────────────────

export interface PpStatus {
  id: string
  requestNo: string
  status: SampleStatus
  dueDate: string | null
  /** How many times the buyer has come back. Round 3 on a PP is a story in itself. */
  rounds: number
  latestVerdict: 'approved' | 'approved_with_comments' | 'rejected' | null
  latestRecordedOn: string | null
  /** Comments on the latest round — "approved with comments" means both must be in bulk. */
  latestComments: number
}

/**
 * The PP sample standing between this order and its cutting table.
 *
 * `ppApprovedStyles` answers the GATE's question — may cutting start — as a flat list of
 * codes, which is all a gate needs. A merchandiser's sign-off panel needs the other half:
 * which round it is on, what the buyer said, and when. "Approved" and "approved with
 * comments" open the gate identically and mean very different things on the floor, and
 * only the second of those is visible here.
 *
 * Matched on order AND style, the same pair `resolvePpApproval` uses — an order carrying
 * two styles has two PP samples and one of them can be approved while the other is not.
 */
export async function ppStatusForOrder(
  ctx: AnyCtx,
  input: { orderId: string; styleCode: string },
): Promise<PpStatus | null> {
  return withTenantRead(ctx, async (tx) => {
    const [request] = await tx
      .select({
        id: sampleRequests.id,
        requestNo: sampleRequests.requestNo,
        status: sampleRequests.status,
        dueDate: sampleRequests.dueDate,
      })
      .from(sampleRequests)
      .where(
        scoped(
          sampleRequests,
          ctx,
          and(
            eq(sampleRequests.orderId, input.orderId),
            eq(sampleRequests.styleCode, input.styleCode),
            eq(sampleRequests.type, 'pp'),
          ),
        ),
      )
      .orderBy(desc(sampleRequests.createdAt))
      .limit(1)

    if (!request) return null

    const rounds = await tx
      .select({
        round: sampleFeedbackRounds.round,
        verdict: sampleFeedbackRounds.verdict,
        recordedOn: sampleFeedbackRounds.recordedOn,
        comments: sampleFeedbackRounds.comments,
      })
      .from(sampleFeedbackRounds)
      .where(scoped(sampleFeedbackRounds, ctx, eq(sampleFeedbackRounds.sampleRequestId, request.id)))
      .orderBy(desc(sampleFeedbackRounds.round))

    const latest = rounds[0]

    return {
      ...request,
      // The count of rounds, not the highest round number: a gap in the numbering would be
      // a data fault, and reporting "round 4" over three rows would hide it.
      rounds: rounds.length,
      latestVerdict: latest?.verdict ?? null,
      latestRecordedOn: latest?.recordedOn ?? null,
      // Parsed rather than counted raw: a malformed comment is not a comment, and the
      // sign-off panel would otherwise promise a reader notes it cannot show them.
      latestComments: readJsonbArray(
        buyerComment,
        latest?.comments,
        'sample_feedback_rounds.comments',
      ).items.length,
    }
  })
}
