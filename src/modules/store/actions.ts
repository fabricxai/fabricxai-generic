'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { propose } from '@/modules/core/pending-changes'
import { requireRole } from '@/modules/core/session'

import { createRequisition, upsertItem, upsertLocation } from './service'

/**
 * Put an item on the master list.
 *
 * The missing first link, and a worse one than the requisition's: nothing anywhere in this
 * product created an item, so a factory that signed up this morning could not receive its
 * first delivery — the receive form needs an `itemId` and no `itemId` could exist. Every
 * downstream flow (issue, cutting, production) sat behind that one absence.
 *
 * Store and procurement between them, because the two desks that know an item is real are
 * the one that ordered it and the one that will put it on a shelf. Owner and admin too,
 * for the person setting the factory up on day one.
 */
export async function saveItem(input: {
  code: string
  name: string
  kind: 'fabric' | 'trim' | 'accessory' | 'yarn' | 'greige'
  uom: string
  spec?: Record<string, unknown>
  isActive?: boolean
}): Promise<{ itemId: string; created: boolean } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'store', 'procurement', 'owner', 'admin')
  return surfaced(async () => {
    const result = await upsertItem(ctx, input)
    revalidatePath('/store')
    revalidatePath('/store/receive')
    return result
  })
}

/** Put a store location on the map. Same absence, same day-one consequence. */
export async function saveLocation(input: {
  code: string
  name: string
  kind: 'bonded' | 'general' | 'floor'
  isActive?: boolean
}): Promise<{ locationId: string; created: boolean } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'store', 'owner', 'admin')
  return surfaced(async () => {
    const result = await upsertLocation(ctx, input)
    revalidatePath('/store')
    revalidatePath('/store/receive')
    return result
  })
}

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
