'use server'

import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'

import { markRead } from '@/modules/core/notifications'
import { requireRole } from '@/modules/core/session'

const Input = z.object({
  ids: z.array(z.string().uuid()).min(1).max(50),
})

/**
 * Mark in-app alerts read. Thin: auth → zod → core.notifications.
 * Any signed-in role may clear alerts addressed to them (or their roles).
 */
export async function markAlertsRead(input: { ids: string[] }): Promise<{ ok: true; marked: number } | { ok: false }> {
  const parsed = Input.safeParse(input)
  if (!parsed.success) return { ok: false }

  const ctx = await requireRole(
    await headers(),
    'merchandiser',
    'commercial',
    'planner',
    'store',
    'procurement',
    'cutting',
    'production',
    'quality',
    'shipment',
    'maintenance',
    'hr',
    'compliance',
    'finance',
    'member',
    'viewer',
  )

  const marked = await markRead(ctx, parsed.data.ids)
  revalidatePath('/home')
  return { ok: true, marked }
}
