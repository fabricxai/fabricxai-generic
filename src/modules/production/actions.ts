'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import { planLineDay } from './service'

/**
 * 6.1's one desk decision.
 *
 * Everything else production writes is a floor event and goes through the offline batch
 * (rule 7) — but planning a line's day is decided at a desk before the shift, and it is
 * the record every floor write hangs off: hourly outputs take their orderId from it, the
 * board its targets, the day-close its SMV and manpower. It had no origin outside the
 * seed until the live test reached the floor.
 */
export async function planTheLine(input: {
  lineId: string
  orderId: string
  planDate: string
  targetPerHour: number
  manpowerPlanned: number
  smv?: string
}): Promise<{ planId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'planner', 'production', 'admin', 'owner')
  return surfaced(async () => {
    const result = await planLineDay(ctx, input)
    revalidatePath('/lines')
    return result
  })
}
