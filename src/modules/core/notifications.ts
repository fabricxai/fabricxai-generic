/**
 * Notification service.
 *
 * Addressed to a user OR to a role within the company — a role-addressed notification is
 * how "someone in commercial needs to look at this LC" works without guessing who is on
 * shift.
 *
 * Titles and bodies are i18n KEYS, never display strings: the floor reads Bangla and the
 * office reads English against the same row.
 *
 * `dedupeKey` is what makes notification-producing jobs safely re-runnable. The nightly
 * TNA scan re-emits "milestone at risk" every night for as long as it stays at risk; the
 * unique index turns the repeats into no-ops instead of a bell with 40 identical entries.
 */
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm'

import { notifications } from '@/db/schema/core'

import type { AnyCtx, Role } from './ctx'
import { scoped } from './scoped'
import { withTenantRead, withTenantTx } from './tenancy'

export interface NotifyInput {
  userId?: string
  role?: Role
  /** Notification type, e.g. 'lc.expiry_near' — the i18n key stem, not display text. */
  kind: string
  severity?: 'info' | 'warning' | 'critical'
  titleKey: string
  bodyKey?: string
  params?: Record<string, unknown>
  moduleId?: string
  entityTable?: string
  entityId?: string
  href?: string
  /** Idempotency for job-generated notifications. */
  dedupeKey?: string
  channels?: readonly ('in_app' | 'email' | 'push')[]
}

/**
 * Create a notification. Returns null when `dedupeKey` matched an existing one — the
 * caller is a job that has run before, and that is a success, not an error.
 */
export async function notify(ctx: AnyCtx, input: NotifyInput): Promise<{ id: string } | null> {
  if (!input.userId && !input.role) {
    // The DB has a CHECK for this too; failing here gives the caller a usable message
    // instead of a constraint name. A notification addressed to nobody is silent failure.
    throw new Error('notify() needs either a userId or a role — addressed to nobody otherwise')
  }

  return withTenantTx(ctx, async (tx) => {
    const inserted = await tx
      .insert(notifications)
      .values({
        companyId: ctx.companyId,
        userId: input.userId ?? null,
        role: input.role ?? null,
        kind: input.kind,
        severity: input.severity ?? 'info',
        titleKey: input.titleKey,
        bodyKey: input.bodyKey ?? null,
        params: input.params ?? {},
        moduleId: input.moduleId ?? null,
        entityTable: input.entityTable ?? null,
        entityId: input.entityId ?? null,
        href: input.href ?? null,
        dedupeKey: input.dedupeKey ?? null,
        channels: [...(input.channels ?? ['in_app'])],
      })
      // Only fires when dedupeKey is set — the partial unique index ignores NULLs, so
      // ad-hoc notifications are never accidentally collapsed together.
      .onConflictDoNothing()
      .returning({ id: notifications.id })

    return inserted[0] ?? null
  }).then(async (row) => {
    /*
     * The push bridge (mobile contract §2). AFTER the transaction, best-effort, and only
     * when the caller asked for the channel — the in-app row is already committed, so a
     * vendor outage, missing VAPID keys or a dead device can delay a buzz but never lose a
     * notification. The payload is built from the same key+params the bell renders, in
     * English: push has no per-device locale, and en is the catalogue every key must have.
     */
    if (row && input.channels?.includes('push')) {
      try {
        const { deliverPush } = await import('@/lib/push')
        const { t } = await import('@/lib/i18n')
        await deliverPush(ctx, {
          ...(input.userId ? { userId: input.userId } : { role: input.role! }),
          payload: {
            title: t('en', input.titleKey, input.params ?? {}),
            ...(input.bodyKey ? { body: t('en', input.bodyKey, input.params ?? {}) } : {}),
            ...(input.href ? { href: input.href } : {}),
            tag: input.dedupeKey ?? row.id,
          },
        })
      } catch {
        // Best-effort by contract. The in-app row is the record; the buzz is a courtesy.
      }
    }
    return row
  })
}

/**
 * Addressed to this caller: to them by name, or to a role they hold.
 *
 * Extracted so the READ and the two WRITES cannot disagree. They did: `listUnread` scoped to
 * the recipient and `markRead`/`dismiss` scoped only to the company, so any signed-in person
 * could mark any alert in the factory read — including one addressed to somebody else by
 * name, or to a role they do not hold. `markAlertsRead`'s own comment said "alerts addressed
 * to them (or their roles)", which is what it meant to do and not what it did.
 *
 * Hard to reach on purpose rather than by luck: ids are uuids and you only ever receive your
 * own, so this was a latent scoping gap rather than a live exploit. It still defeats the
 * channel it protects — an alert somebody else silently cleared is an alert the person it
 * was for never sees, and the LC countdown and the UD expiry both ride on it.
 */
function addressedTo(ctx: AnyCtx) {
  return ctx.userId
    ? or(
        eq(notifications.userId, ctx.userId),
        ctx.roles.length ? inArray(notifications.role, [...ctx.roles]) : undefined,
      )
    : undefined
}

/**
 * The bell: unread notifications for this user, including ones addressed to any role
 * they hold. Newest first.
 */
export async function listUnread(
  ctx: AnyCtx,
  limit = 50,
): Promise<(typeof notifications.$inferSelect)[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select()
      .from(notifications)
      .where(scoped(notifications, ctx, 
        and(
          isNull(notifications.readAt),
          isNull(notifications.dismissedAt),
          addressedTo(ctx),
        ),
      ))
      .orderBy(desc(notifications.createdAt))
      .limit(limit),
  )
}

/**
 * Mark alerts read — only ones addressed to this caller.
 *
 * Returns how many actually moved, which is the honest answer when some of the ids were
 * somebody else's: the caller is told what happened rather than refused outright, because a
 * stale browser tab holding an id that has since been re-addressed is an ordinary event and
 * not an attack.
 */
export async function markRead(ctx: AnyCtx, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0

  const updated = await withTenantTx(ctx, (tx) =>
    tx
      .update(notifications)
      .set({ readAt: new Date() })
      // RLS bounds this to the company; `addressedTo` bounds it to the person; the isNull
      // keeps the first read time.
      .where(
        scoped(
          notifications,
          ctx,
          and(inArray(notifications.id, [...ids]), isNull(notifications.readAt), addressedTo(ctx)),
        ),
      )
      .returning({ id: notifications.id }),
  )

  return updated.length
}

export async function dismiss(ctx: AnyCtx, ids: readonly string[]): Promise<number> {
  if (ids.length === 0) return 0

  const updated = await withTenantTx(ctx, (tx) =>
    tx
      .update(notifications)
      .set({ dismissedAt: new Date() })
      // Same wall as `markRead` — dismissing another person's alert hides it from them for
      // good, which is the more destructive half of the pair.
      .where(
        scoped(
          notifications,
          ctx,
          and(
            inArray(notifications.id, [...ids]),
            isNull(notifications.dismissedAt),
            addressedTo(ctx),
          ),
        ),
      )
      .returning({ id: notifications.id }),
  )

  return updated.length
}
