'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { getPolicy } from '@/modules/settings/service'

import {
  answerClarification as answerClarificationIn,
  askClarification as askClarificationIn,
  createRfq as createRfqIn,
  draftQuote as draftQuoteIn,
  markLost as markLostIn,
  markWon as markWonIn,
  sendQuote as sendQuoteIn,
  type DraftQuoteResult,
  type RfqPolicy,
} from './service'

/**
 * 1.2 RFQ & Quotation — the write surface (plan 5.3, audit FE-S2).
 *
 * This module had **no `actions.ts` at all** over a complete service. Every enquiry on the
 * board arrived from MARBIM's extraction path or the seed; nothing could be quoted, won or
 * lost from a screen. So the desk could watch its own pipeline and not work it — and with no
 * MARBIM provider registered, could not even receive an enquiry.
 *
 * Thin by contract (CLAUDE.md rule 1): auth → zod → service. The zod lives in the services;
 * what these add is the role gate, the policy the service needs, and the revalidation.
 *
 * ## Why the policy is fetched here
 *
 * `draftQuote` and `sendQuote` both take a `RfqPolicy` because a service never reaches for
 * Settings — the margin floor is the number that decides whether a quote may leave without
 * an owner, and a service that read it itself could not be tested without a database. The
 * action is the layer that knows about the request, so it is the layer that fetches it.
 */

/** Quoting is merchandising's job; commercial owns the terms behind it. */
const WRITERS = ['merchandiser', 'commercial'] as const

function refresh(): void {
  revalidatePath('/rfq')
}

/*
 * Every write below returns its refusals as VALUES via `surfaced` (lib/action-failure):
 * production masks anything a server action throws, and every gate in this module — the
 * margin floor, "no live quote", "an order needs a requested ship date" — reached the
 * screen as "Minified React error #441" until it did.
 */

/** Record an enquiry that arrived by email or on a call. */
export async function createRfq(input: {
  buyerId: string
  title: string
  productType: string
  quantity: number
  description?: string
  styleCode?: string
  unit?: string
  targetPrice?: string
  targetCurrency?: string
  currency?: string
  deadline?: string
  requestedShipDate?: string
}): Promise<{ rfqId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  return surfaced(async () => {
    const result = await createRfqIn(ctx, { ...input, source: 'manual' })
    refresh()
    return result
  })
}

/**
 * Draft a quote from the approved cost sheet.
 *
 * The sheet is read through 1.5's own surface and FROZEN onto the quote: a quote pointing at
 * a live sheet would reprice itself every time somebody edited the sheet, and the buyer holds
 * the number that was sent. `getApprovedSheet` throws when there is no approved sheet, which
 * is the refusal that matters — a quote built from a draft is a price nobody signed off.
 *
 * A new version SUPERSEDES the previous one rather than replacing it, so the count comes back
 * and the screen can say what happened to the quote the buyer is already holding.
 */
export async function draftQuote(input: {
  rfqId: string
  styleCode: string
  validityDate?: string
}): Promise<DraftQuoteResult | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const policy = await getPolicy<RfqPolicy>(ctx, 'rfq')

  return surfaced(async () => {
    const result = await draftQuoteIn(ctx, input, policy)
    refresh()
    return result
  })
}

/**
 * Send it to the buyer.
 *
 * **The margin floor is enforced here and only here.** A quote below the floor needs an owner
 * or an admin — `sendQuote` throws `below_floor_needs_manager` for anybody else — and the
 * reason travels with it, because a floor that can be crossed silently is not a floor. The
 * result reports whether it WAS below, so the screen says what was actually sent rather than
 * what the merchandiser expected to send.
 */
export async function sendQuote(input: {
  quoteId: string
  sentAt?: string
  belowFloorReason?: string
}): Promise<{ quoteId: string; belowFloor: boolean } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  const policy = await getPolicy<RfqPolicy>(ctx, 'rfq')

  return surfaced(async () => {
    const result = await sendQuoteIn(ctx, input, policy)
    refresh()
    return result
  })
}

/**
 * The buyer accepted.
 *
 * This is the handover: `rfq.won` carries the payload 1.3 turns into an order, its styles and
 * its TNA. The quote it wins on is the latest non-superseded one, resolved server-side — a
 * caller naming a quote id could win on a version the buyer never saw.
 */
export async function markRfqWon(input: {
  rfqId: string
  /** Winning terms — what the acceptance fixed that the enquiry never stated. */
  requestedShipDate?: string
  sizeRatio?: Record<string, number>
}): Promise<{ rfqId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  return surfaced(async () => {
    const result = await markWonIn(ctx, input)

    refresh()
    // The order desk is where this lands moments later, through the `rfq.won` consumer.
    revalidatePath('/orders')
    return { rfqId: result.rfqId }
  })
}

/**
 * The buyer went elsewhere.
 *
 * The reason code must exist in `loss_reasons` — the service refuses one that does not, and
 * that refusal is the module's whole value. A free-text reason cannot be counted, and "why
 * are we losing" is a question answered by counting.
 */
export async function markRfqLost(input: {
  rfqId: string
  lossReasonCode: string
  note?: string
}): Promise<{ done: true } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  return surfaced(async () => {
    await markLostIn(ctx, input)
    refresh()
    return { done: true as const }
  })
}

/** A question put to the buyer. The clock on it drives the stale-clarification alert. */
export async function askClarification(input: {
  rfqId: string
  question: string
  askedAt: string
}): Promise<{ clarificationId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  return surfaced(async () => {
    const result = await askClarificationIn(ctx, input)
    refresh()
    return result
  })
}

/** What they said. Answering once is the rule — a rewritten answer is a different question. */
export async function answerClarification(input: {
  clarificationId: string
  answer: string
  answeredAt: string
}): Promise<{ done: true } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...WRITERS)
  return surfaced(async () => {
    await answerClarificationIn(ctx, input)
    refresh()
    return { done: true as const }
  })
}
