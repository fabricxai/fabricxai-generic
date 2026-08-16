'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import { createMarker } from './service'

/**
 * Releasing a marker — the door 5.1 never had.
 *
 * A lay is spread under a marker, and `/cutting/lay` refuses without one: *"No marker exists
 * for ST-2815. CAD releases it before cutting can start."* True, and until now nothing in the
 * product could release one. This module had no actions file at all; its two sync handlers
 * cover `create_lay` and `record_cut_report`, `createMarker` sat in the service with no
 * caller, and the only working route was asking MARBIM to draft one in conversation. The one
 * marker on the demo tenant was planted by a seed script (Nordkap §8, F37).
 *
 * **A server action, not the offline batch endpoint.** Rule 7 is about floor writes — cloth
 * moving, pieces counted, work recorded at a rack or a table where the signal is worst.
 * Releasing a marker is a desk act done off a CAD plan with the plan in front of you; it
 * happens once per style, not once per spread, and it does not need to survive a dead
 * network. The lay and the cut report still go through the queue, as they must.
 *
 * The MARBIM draft path stays exactly as it was. A marker plan that arrives as a document is
 * still worth reading into a draft for the cutting in-charge to check — this is the other
 * half, for the ordinary case where somebody has the plan and types six numbers off it.
 */
export async function releaseMarker(input: {
  code: string
  styleCode: string
  sizeRatio: Record<string, number>
  layLengthMeters: string
  efficiencyPct?: string
  fabricWidthInches?: string
}): Promise<{ markerId: string } | ActionFailure> {
  // The same two the sync handlers gate on. A planner reads the floor; it does not release
  // what the floor cuts to.
  const ctx = await requireRole(await headers(), 'cutting', 'production')

  return surfaced(async () => {
    const result = await createMarker(ctx, input)

    revalidatePath('/cutting')
    revalidatePath('/cutting/lay')

    return result
  })
}
