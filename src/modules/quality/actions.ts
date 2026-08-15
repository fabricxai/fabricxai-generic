'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { getPolicy } from '@/modules/settings/service'

import {
  aqlPlanFor,
  inspectFabric,
  recordMeasuredSet,
  runFinalInspection,
  type QualityPolicy,
} from './service'
import type { AqlPlan } from './quality'

/**
 * Record a 4-point fabric inspection.
 *
 * A server action rather than the offline batch endpoint (rule 7), and the distinction is
 * the same one the store draws: an inline check is captured by somebody walking a line with
 * a tablet and has to survive losing the network, whereas fabric is graded at a fixed
 * inspection frame in the store with a mains-powered terminal a few metres from the router.
 * Queuing it offline would buy nothing and would let two inspectors grade the same roll on
 * two devices with no way to reconcile which sheet is real.
 *
 * The verdict is NOT taken from the caller. Points, the rate per hundred square yards and
 * pass/fail are all computed in the service from the band counts and the factory's
 * threshold, because an inspector who can type "pass" is an inspector who can be leaned on
 * to type "pass".
 */
export async function recordFabricInspection(
  input: unknown,
): Promise<
  { fabricInspectionId: string; pointsPer100SqYd: string; result: 'pass' | 'fail' } | ActionFailure
> {
  const ctx = await requireRole(await headers(), 'quality')
  return surfaced(async () => {
    const policy = await getPolicy<QualityPolicy>(ctx, 'quality')

    const result = await inspectFabric(ctx, input, policy)

    revalidatePath('/quality/fabric')
    // The store's issue screen reads the gate this result feeds, and its GRN list reads the
    // status this write rolls up. Both are stale the moment a roll is graded.
    revalidatePath('/store')
    revalidatePath('/store/issue')

    return result
  })
}

/**
 * The sampling plan for a lot, before anybody counts anything.
 *
 * Read-only and deliberately separate from the verdict: the inspector needs the sample size
 * and the accept numbers on screen while they work through the cartons, and calling the
 * write path to find out how many pieces to pull would file an inspection with no defects
 * in it.
 */
export async function previewAqlPlan(input: {
  lotQty: number
  inspectionLevel: string
  majorAql: string
  minorAql: string
}): Promise<AqlPlan | ActionFailure> {
  const ctx = await requireRole(await headers(), 'quality', 'production')
  return surfaced(async () => {
    const policy = await getPolicy<QualityPolicy>(ctx, 'quality')
    return aqlPlanFor(ctx, input, policy)
  })
}

/**
 * File a final inspection.
 *
 * The verdict is computed server-side from the versioned AQL table, the plan snapshotted
 * onto the row, and severities resolved from `defect_codes` — nothing about pass or fail
 * comes from this call. That is what stops an inspector making a lot pass by relabelling a
 * major defect as minor on the way in, and it is why the screen shows the arithmetic rather
 * than asking anyone to trust it.
 *
 * A pass emits `quality.final.passed`, which 1.3 consumes to actualise the `final_inspection`
 * TNA milestone (and ripple the dates downstream of it). A fail does not: a failed lot has
 * not reached the milestone, it is going back for rework.
 */
export async function submitFinalInspection(
  input: unknown,
): Promise<
  { finalInspectionId: string; verdict: 'pass' | 'fail'; reasons: unknown[] } | ActionFailure
> {
  const ctx = await requireRole(await headers(), 'quality')
  return surfaced(async () => {
    const policy = await getPolicy<QualityPolicy>(ctx, 'quality')

    const result = await runFinalInspection(ctx, input, policy)

    revalidatePath('/quality')
    revalidatePath('/quality/final')
    // The shipment gate reads this verdict, and the order's TNA moves on a pass.
    revalidatePath('/orders')

    return {
      finalInspectionId: result.finalInspectionId,
      verdict: result.outcome.verdict,
      reasons: result.outcome.reasons,
    }
  })
}

/**
 * Record a measured size — one check per PIECE.
 *
 * The canvas asks for three pieces side by side, and the temptation is to store the grid as
 * one row. It is filed as one check per garment instead, because that is what a check IS:
 * piece 2 can be out of tolerance at the chest while pieces 1 and 3 are fine, and a single
 * row would have to choose between recording that as a pass or a fail. Three rows say
 * "two of three passed", which is the sentence a buyer report needs.
 *
 * Nothing partial survives a bad piece — **which this comment claimed and the code did not
 * do** (plan 4.1). It looped over `recordMeasurementCheck`, and each call opened its OWN
 * transaction: a throw on piece 2 left piece 1 committed and piece 3 never attempted. A
 * half-measured size reads as a completed check on a buyer report, with no sign that two of
 * the three garments are missing. It survived because the intent was written down here and
 * the behaviour was somewhere else.
 *
 * It now goes through `recordMeasuredSet`, which validates every piece before writing any
 * and puts the whole size in one transaction.
 *
 * The two ways a check fails are reported SEPARATELY. A garment measuring 0.9cm short is out
 * of tolerance; a garment where six of eight points were never measured is incomplete. Both
 * store as `fail` — correctly, since an unmeasured point is not a good one — but telling a QC
 * who has filled in two rows that "3 pieces are out of tolerance" says the garments are bad
 * when what actually happened is that nobody finished measuring them.
 */
export async function recordMeasuredPieces(input: {
  measurementSpecId: string
  orderId: string
  sampledSize: string
  pieces: Record<string, string>[]
  /** The device's key for this size, so a retried submit does not file it twice. */
  offlineKey?: string
}): Promise<
  { pieces: number; failed: number; outOfTolerance: number; incomplete: number } | ActionFailure
> {
  const ctx = await requireRole(await headers(), 'quality')
  return surfaced(async () => {
    const { pieces } = await recordMeasuredSet(ctx, input)

    revalidatePath('/quality/measurements')
    revalidatePath('/quality')

    return {
      pieces: pieces.length,
      failed: pieces.filter((r) => r.result === 'fail').length,
      outOfTolerance: pieces.filter((r) => r.outOfTolerance.length > 0).length,
      incomplete: pieces.filter((r) => r.missing.length > 0).length,
    }
  })
}
