'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { getPolicy } from '@/modules/settings/service'

import {
  approveCostSheet,
  createBom,
  createCostSheet,
  previewCostSheet,
  type CostingPolicy,
} from './service'
import type { CostSheetResult } from './cost-sheet'

/**
 * Live preview for the Costing Studio.
 *
 * The whole computation runs on the SERVER even though it is pure arithmetic,
 * for one reason: the margin floor. A floor evaluated in the browser is a floor
 * a merchandiser can edit, and the gate that stops an order being quoted below
 * cost has to be the same one the approve path enforces (CLAUDE.md rule 8).
 */
export async function previewSheet(sections: unknown): Promise<CostSheetResult | ActionFailure> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial', 'finance')
  return surfaced(async () => {
    const policy = await getPolicy<CostingPolicy>(ctx, 'costing')

    return previewCostSheet(ctx, { sections }, policy)
  })
}

/**
 * Save the studio's working sheet as the next version.
 *
 * Versioned, never edited. A cost sheet is what a price was quoted from, and rewriting one
 * in place makes "why did we quote 5.35" unanswerable a season later — which is exactly the
 * question a merchandiser asks when the margin comes in short.
 *
 * The service recomputes from the sections rather than trusting anything this call sends.
 * The studio's preview and the saved figure come from the same function, so they cannot
 * disagree; if they ever did, the stored one would be the lie.
 */
export async function saveCostSheet(input: {
  styleCode: string
  bomId?: string
  sections: unknown
}): Promise<{ sheetId: string; version: number; computed: CostSheetResult } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial', 'finance')
  return surfaced(async () => {
    const policy = await getPolicy<CostingPolicy>(ctx, 'costing')

    const result = await createCostSheet(ctx, input, policy)

    revalidatePath('/costing')
    return result
  })
}

/**
 * Approve a sheet — the margin-floor gate.
 *
 * Two refusals live in the service and both matter. It re-derives the totals from the
 * stored sections and refuses if they disagree with the stored outputs, because approving a
 * figure that cannot be reproduced is approving a number nobody can defend. And it reports
 * `belowFloor` rather than silently allowing it: quoting under the floor is sometimes a
 * deliberate decision to buy a buyer, but it is never an accident somebody should be able
 * to make by clicking through.
 */
export async function approveSheet(input: {
  sheetId: string
}): Promise<{ version: number; belowFloor: boolean }> {
  // The same roles as drafting, deliberately. The dangerous case here is a sheet priced
  // below the margin floor, and the service already refuses that to anyone but an owner —
  // inventing a second, stricter rule at this boundary would contradict what the nav tells
  // a merchandiser they may do in costing, with a bare "your role does not allow this".
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial', 'finance')
  const policy = await getPolicy<CostingPolicy>(ctx, 'costing')

  const result = await approveCostSheet(ctx, input, policy)

  revalidatePath('/costing')
  // The order desk quotes from the approved sheet.
  revalidatePath('/orders')

  return { version: result.version, belowFloor: result.belowFloor }
}

/**
 * Save a hand-built bill of materials.
 *
 * Thin, like every action: auth, then the service (CLAUDE.md rule 1). The consumption basis
 * is NOT taken from the client — `createBom` writes every manual line as `planned`, because
 * a typed consumption is an estimate and `actual` is a claim about a real order.
 */
export async function saveBom(input: unknown): Promise<{ bomId: string; lineCount: number }> {
  const ctx = await requireRole(await headers(), 'merchandiser', 'commercial', 'finance')
  const result = await createBom(ctx, input)

  revalidatePath('/costing/bom')
  revalidatePath('/costing')

  return result
}
