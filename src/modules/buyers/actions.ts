'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import { getPolicy } from '@/modules/settings/service'

import {
  convertLead,
  createLead,
  detectDuplicates,
  logActivity,
  setLeadStage,
  upsertTerms,
  type BuyerDeskPolicy,
  type DuplicateCandidate,
} from './service'
import { leadPayload } from './zod'

/**
 * 1.1 Buyer & Lead Desk writes.
 *
 * Moving a lead to `lost` requires a reason. A pipeline that lets somebody drop
 * a lead without saying why produces a board full of dead rows and no answer to
 * "why are we losing" — and a 3% price loss and a 22% price loss are different
 * problems that a bare "lost" cannot distinguish.
 */

const stageInput = z
  .object({
    leadId: z.string().uuid(),
    stage: z.enum(['new', 'contacted', 'sampling_talk', 'negotiation', 'won', 'lost']),
    lostReason: z.string().min(1).max(300).optional(),
  })
  .refine((v) => v.stage !== 'lost' || !!v.lostReason, {
    message: 'a lost lead needs a reason',
    path: ['lostReason'],
  })

/**
 * Put a lead on the board.
 *
 * The desk had no way to do this. `createLead` was written with 1.1 and its only callers
 * were the integration tests and `scripts/demo.ts`, so on a real factory's first day the
 * pipeline was empty and stayed empty: there is no `createBuyer` anywhere in this codebase —
 * a buyer is made by converting a lead — so with no way to enter a lead there was no way to
 * enter a BUYER either, and every screen downstream of one (orders, LCs, shipments, every
 * scorecard) had nothing to hang off.
 *
 * That is what "the buyers desk is read-only" cost. It was not a missing convenience on one
 * screen; it was the first step of the chain the rest of the product is built on.
 *
 * Thin, per architecture rule 1: auth, zod, service. `leadPayload` is the module's own
 * schema and `createLead` parses it again on the way in — validated at both ends on purpose,
 * because the service is also called by the demo script and by MARBIM's commit path, and a
 * check that only exists in the action is a check those callers do not get.
 */
export async function addLead(input: z.input<typeof leadPayload>): Promise<{ leadId: string }> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial')
  const parsed = leadPayload.parse(input)

  const result = await createLead(ctx, parsed)
  revalidatePath('/buyers')
  return result
}

export async function moveLeadStage(input: z.input<typeof stageInput>): Promise<void> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial')
  const parsed = stageInput.parse(input)

  await setLeadStage(ctx, parsed)
  revalidatePath('/buyers')
}

export async function logLeadActivity(input: unknown): Promise<{ activityId: string }> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial')
  const result = await logActivity(ctx, input)

  // The quiet-lead clock is driven by activity, so logging one changes the board.
  revalidatePath('/buyers')
  return result
}

const convertInput = z.object({
  leadId: z.string().uuid(),
  /** Buyer code — short, stable, and what every downstream document keys off. */
  code: z.string().min(1).max(20),
})

/**
 * Who this lead might already be (plan 5.2).
 *
 * Step one of the conversion, and a read. `detectDuplicates` has existed since 1.1 and was
 * reachable only from `createLead`, which checks at the other end — so the desk could not
 * ask the one question worth asking before it makes a permanent record: is this company
 * already a buyer under a slightly different name?
 *
 * Two buyers for one company splits the order history and every scorecard built on it, and
 * the split is invisible until somebody asks why a buyer's volume halved. Trigram similarity
 * over the normalised name catches "Ltd" against "Limited"; a shared website beats any name
 * score and sorts first.
 *
 * It does not block. A genuine second entity — a division, a sourcing office — is a real
 * buyer with a real similar name, and a check that refused would be a check people learn to
 * work around by mistyping the name.
 */
export async function findConversionDuplicates(input: {
  leadId: string
  name: string
  website?: string
}): Promise<DuplicateCandidate[]> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial')
  const parsed = z
    .object({
      leadId: z.string().uuid(),
      name: z.string().min(1).max(300),
      website: z.string().max(300).optional(),
    })
    .parse(input)

  const policy = await getPolicy<BuyerDeskPolicy>(ctx, 'buyers')
  const candidates = await detectDuplicates(
    ctx,
    { name: parsed.name, website: parsed.website ?? null },
    policy,
  )

  // The lead being converted matches itself, obviously and unhelpfully.
  return candidates.filter((candidate) => candidate.id !== parsed.leadId)
}

export async function convertLeadToBuyer(input: z.input<typeof convertInput>) {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial')
  const parsed = convertInput.parse(input)

  const result = await convertLead(ctx, parsed)
  revalidatePath('/buyers')
  return result
}

/**
 * Record a new version of a buyer's commercial terms.
 *
 * `upsertTerms` — the versioned rows 7.1's AQL gate and 8.1's tolerance band READ — had a
 * service, a zod and an audit mark, and no action and no screen: the final-inspection
 * desk refused every lot with "no terms on file" and there was nowhere to put terms on
 * file (live-test finding, Phase 7). Always a NEW version; backdating past the newest is
 * refused by the service so "what applied on the day" never moves.
 */
export async function setBuyerTerms(input: {
  buyerId: string
  validFrom: string
  payment: 'lc' | 'tt' | 'dp'
  incoterm: string
  tolerancePct: string
  aqlLevel: string
  minorAqlLevel?: string
}): Promise<{ termsId: string; version: number } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial')
  return surfaced(async () => {
    const result = await upsertTerms(ctx, input)
    revalidatePath('/buyers')
    revalidatePath('/quality/final')
    return result
  })
}
