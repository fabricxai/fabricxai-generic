'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import { whatTheLineRan as readWhatTheLineRan } from './queries'
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

/**
 * What a line was running on a given day — asked by the catch-up dialog once it knows the
 * date off the sheet, so it can say what the day will be booked against before it is saved.
 *
 * A read, so it does not go through the offline queue. If the network is down the dialog
 * simply cannot say, and the write still resolves the order correctly on the server; this
 * removes the silence, it is not what makes the attribution right (§9, F44).
 */
export async function whatTheLineRan(input: {
  lineId: string
  planDate: string
}): Promise<{ orderId: string; label: string } | null | ActionFailure> {
  const ctx = await requireRole(await headers(), 'planner', 'production', 'admin', 'owner')
  return surfaced(() => readWhatTheLineRan(ctx, input))
}
