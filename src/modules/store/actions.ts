'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { propose } from '@/modules/core/pending-changes'
import { requireRole } from '@/modules/core/session'

import { createRequisition } from './service'

/**
 * Size an order's material need, from a screen.
 *
 * `createRequisition` had the whole contract — BOM-sized or explicit lines, wastage,
 * computed totals — and no caller: not an action, not a screen, so the issue desk served
 * requisition lines that could not exist (live-test finding, Phase 4; the same missing
 * first link as procurement's). A server action rather than the offline endpoint because
 * sizing a need is a desk decision, not a floor event — nothing physical happened yet.
 */
export async function raiseMaterialRequisition(input: {
  orderId: string
  orderQty: number
  wastagePct?: string
  bomId?: string
  lines?: { itemId: string; consumptionPerPiece: string; unit: string }[]
}): Promise<{ requisitionId: string; lines: number; source: 'bom' | 'explicit' } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'store', 'planner', 'production')
  return surfaced(async () => {
    const result = await createRequisition(ctx, input)
    revalidatePath('/store')
    return result
  })
}

/**
 * Draft a stock correction.
 *
 * An action rather than the offline batch endpoint, and that is the distinction rule 7 is
 * actually drawing: GRNs and issues are records of a physical event a storekeeper witnessed
 * — cloth arrived, cloth left — and must survive a tablet losing its network mid-shift.
 * An adjustment is not an event. It is somebody asserting the count on the shelf disagrees
 * with the count in the system, and it needs a reviewer before it touches the ledger. There
 * is nothing to replay offline, because nothing is written until somebody signs it.
 *
 * `propose` validates against the module's own zod at insert AND again at approve, and
 * refuses any target `store/register.ts` has not whitelisted (CLAUDE.md rule 3).
 */
export async function draftStockAdjustment(input: unknown): Promise<{ id: string }> {
  const ctx = await requireRole(await headers(), 'store')

  const result = await propose(ctx, {
    moduleId: 'store',
    targetTable: 'stock_adjustments',
    operation: 'insert',
    zodSchemaKey: 'stock_adjustment_v1',
    // A person typed this. No field confidence, because there is no extractor to have one —
    // and a constant would sail past the check the whole pending flow is built around.
    source: 'user_draft',
    payload: input as Record<string, unknown>,
  })

  // The count on screen has not changed — nothing is written until approval — but the
  // draft's absence from the inbox would make somebody submit it twice.
  revalidatePath('/approve')

  return { id: result.id }
}
