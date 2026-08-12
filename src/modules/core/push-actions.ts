'use server'

import { headers } from 'next/headers'

import { and, eq } from 'drizzle-orm'

import { pushSubscriptions } from '@/db/schema/core'
import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { pushPublicKey } from '@/lib/push'
import { requireCtx } from '@/modules/core/session'
import { withTenantTx } from '@/modules/core/tenancy'

/**
 * Push subscription actions (mobile contract §2, plan 4.1).
 *
 * `requireCtx`, not `requireRole`: subscribing YOUR OWN device to YOUR OWN notifications is
 * not a departmental capability — every signed-in person may. The rows are addressing, and
 * everything ever sent through them is a notification already addressed to this person by
 * the bell's own rules.
 */

export async function getPushConfig(): Promise<{ publicKey: string | null }> {
  await requireCtx(await headers())
  return { publicKey: pushPublicKey() }
}

export async function savePushSubscription(input: {
  endpoint: string
  keys: { p256dh: string; auth: string }
  userAgent?: string
}): Promise<{ subscribed: true } | ActionFailure> {
  const ctx = await requireCtx(await headers())
  return surfaced(async () => {
    await withTenantTx(ctx, (tx) =>
      tx
        .insert(pushSubscriptions)
        .values({
          companyId: ctx.companyId,
          userId: ctx.userId,
          endpoint: input.endpoint,
          keys: input.keys,
          userAgent: input.userAgent ?? null,
        })
        /*
         * Re-subscribing the same device is the browser refreshing its keys, and the row
         * follows the CURRENT signer: a shared floor tablet where somebody else signs in
         * must start buzzing for the new person and stop for the old one.
         */
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            companyId: ctx.companyId,
            userId: ctx.userId,
            keys: input.keys,
            userAgent: input.userAgent ?? null,
          },
        }),
    )
    return { subscribed: true as const }
  })
}

export async function removePushSubscription(input: {
  endpoint: string
}): Promise<{ removed: boolean } | ActionFailure> {
  const ctx = await requireCtx(await headers())
  return surfaced(async () => {
    const gone = await withTenantTx(ctx, (tx) =>
      tx
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.companyId, ctx.companyId),
            // Their own device only — an endpoint is unguessable, but the scope costs nothing.
            eq(pushSubscriptions.userId, ctx.userId),
            eq(pushSubscriptions.endpoint, input.endpoint),
          ),
        )
        .returning({ id: pushSubscriptions.id }),
    )
    return { removed: gone.length > 0 }
  })
}
