import 'server-only'

import { and, eq, inArray } from 'drizzle-orm'

import { pushSubscriptions, roles } from '@/db/schema/core'
import { env } from '@/lib/env'
import type { AnyCtx } from '@/modules/core/ctx'
import { withTenantRead, withTenantTx } from '@/modules/core/tenancy'

/**
 * Web-push delivery (mobile contract §2, plan 4.1).
 *
 * A second delivery channel for `notifications` rows — never its own event system. The
 * contract's two operating rules live here:
 *
 *  - **Absence of keys is a disabled feature, not an error.** A factory that has not set
 *    VAPID keys runs exactly as before; `deliverPush` answers `{ delivered: 0, disabled }`
 *    and nothing upstream needs to care.
 *  - **Failure to deliver never blocks the notification.** The in-app row is already
 *    committed by the time this runs; the push is best-effort, and a dead endpoint (the
 *    push service answering 404/410) is pruned rather than retried forever — a person who
 *    reinstalled their browser should not be a permanent error in a log.
 */

export interface PushPayload {
  title: string
  body?: string
  href?: string
  /** Collapse key — two pushes with one tag replace rather than stack. */
  tag?: string
}

const configured = (): boolean =>
  Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT)

/** The public key the browser needs to subscribe. Null when push is not configured. */
export const pushPublicKey = (): string | null => env.VAPID_PUBLIC_KEY ?? null

export async function deliverPush(
  ctx: AnyCtx,
  input: { userId?: string; role?: string; payload: PushPayload },
): Promise<{ delivered: number; pruned: number; disabled?: true }> {
  if (!configured()) return { delivered: 0, pruned: 0, disabled: true }

  const targets = await withTenantRead(ctx, async (tx) => {
    if (input.userId) {
      return tx
        .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, keys: pushSubscriptions.keys })
        .from(pushSubscriptions)
        .where(and(eq(pushSubscriptions.companyId, ctx.companyId), eq(pushSubscriptions.userId, input.userId)))
    }
    // Role-addressed: everyone currently holding the role, same resolution the bell uses.
    const holders = await tx
      .select({ userId: roles.userId })
      .from(roles)
      .where(and(eq(roles.companyId, ctx.companyId), eq(roles.role, input.role as never)))
    if (holders.length === 0) return []
    return tx
      .select({ id: pushSubscriptions.id, endpoint: pushSubscriptions.endpoint, keys: pushSubscriptions.keys })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.companyId, ctx.companyId),
          inArray(pushSubscriptions.userId, holders.map((h) => h.userId)),
        ),
      )
  })

  if (targets.length === 0) return { delivered: 0, pruned: 0 }

  // Imported lazily so the dependency never loads on paths that don't push.
  const webPush = (await import('web-push')).default
  webPush.setVapidDetails(env.VAPID_SUBJECT!, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!)

  const body = JSON.stringify(input.payload)
  let delivered = 0
  const dead: string[] = []

  await Promise.all(
    targets.map(async (sub) => {
      try {
        await webPush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys as { p256dh: string; auth: string } },
          body,
        )
        delivered += 1
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        // Gone is a fact about the device, not a failure of ours.
        if (status === 404 || status === 410) dead.push(sub.id)
      }
    }),
  )

  if (dead.length > 0) {
    await withTenantTx(ctx, (tx) =>
      tx.delete(pushSubscriptions).where(
        and(eq(pushSubscriptions.companyId, ctx.companyId), inArray(pushSubscriptions.id, dead)),
      ),
    )
  }

  return { delivered, pruned: dead.length }
}
