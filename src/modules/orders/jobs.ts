/**
 * Scheduled derivations for 1.3 (brief §Events / jobs).
 *
 * Both jobs are read-compute-write with idempotent upserts, so a re-run produces the same
 * database — which is what makes them safe to retry and safe to rebuild from source
 * (architecture §4, derived tables).
 *
 * They are company-scoped: a job runs inside exactly one tenant at a time, so RLS binds
 * it the same way it binds a request. The scheduler fans out per company rather than
 * running one query across all of them.
 */
import { and, eq, isNull, sql } from 'drizzle-orm'

import { scoped } from '../core/scoped'
import { notify } from '../core/notifications'
import type { SystemCtx } from '../core/ctx'
import { emit } from '../core/outbox'
import { withTenantTx } from '../core/tenancy'
import { detectLcConflicts } from '../commercial/lc-conflicts'
import { lcs } from '../commercial/schema'

import { ORDER_EVENTS } from './events'
import { orderLcs, orders, tnaMilestones } from './schema'
import { deriveMilestoneStatus, diffDays } from './tna'
import { factoryToday } from '@/lib/dates'

/**
 * Nightly TNA scan: recompute every open milestone's status and raise the ones that
 * changed for the worse.
 *
 * Only *transitions* are announced. Re-emitting "at risk" every night for the same
 * milestone is how an exceptions feed becomes wallpaper — the notification dedupe key
 * carries the milestone and the status, so the second night is a no-op.
 */
export async function runTnaScan(
  ctx: SystemCtx,
  input: { today?: string; riskWindowDays?: number } = {},
): Promise<{ scanned: number; atRisk: number; late: number }> {
  const today = input.today ?? factoryToday()

  return withTenantTx(ctx, async (tx) => {
    const open = await tx
      .select({
        id: tnaMilestones.id,
        orderId: tnaMilestones.orderId,
        name: tnaMilestones.name,
        plannedDate: tnaMilestones.plannedDate,
        status: tnaMilestones.status,
        critical: tnaMilestones.critical,
        ownerRole: tnaMilestones.ownerRole,
        ownerUserId: tnaMilestones.ownerUserId,
      })
      .from(tnaMilestones)
      .where(scoped(tnaMilestones, ctx, isNull(tnaMilestones.actualDate)))

    let atRisk = 0
    let late = 0

    for (const milestone of open) {
      const status = deriveMilestoneStatus({
        plannedDate: milestone.plannedDate,
        today,
        ...(input.riskWindowDays === undefined ? {} : { riskWindowDays: input.riskWindowDays }),
      })

      if (status === milestone.status) continue

      await tx
        .update(tnaMilestones)
        .set({ status: status as never, updatedAt: new Date() })
        .where(scoped(tnaMilestones, ctx, eq(tnaMilestones.id, milestone.id)))

      if (status !== 'at_risk' && status !== 'late') continue

      if (status === 'at_risk') atRisk += 1
      else late += 1

      const payload = {
        orderId: milestone.orderId,
        milestoneId: milestone.id,
        name: milestone.name,
        plannedDate: milestone.plannedDate,
        ownerUserId: milestone.ownerUserId,
        ownerRole: milestone.ownerRole,
        daysRemaining: diffDays(today, milestone.plannedDate),
      }

      await emit(ctx, tx, {
        eventName: status === 'at_risk' ? ORDER_EVENTS.milestoneAtRisk : ORDER_EVENTS.milestoneLate,
        payload,
        aggregateTable: 'orders',
        aggregateId: milestone.orderId,
      })

      await notify(ctx, {
        ...(milestone.ownerUserId ? { userId: milestone.ownerUserId } : {}),
        ...(milestone.ownerRole ? { role: milestone.ownerRole } : { role: 'merchandiser' }),
        kind: `orders.tna.${status}`,
        severity: status === 'late' ? 'critical' : 'warning',
        titleKey: `orders.notifications.milestone_${status}.title`,
        bodyKey: `orders.notifications.milestone_${status}.body`,
        params: { milestone: milestone.name, plannedDate: milestone.plannedDate },
        moduleId: 'orders',
        entityTable: 'orders',
        entityId: milestone.orderId,
        // Same milestone, same status, one notification — however many nights it runs.
        dedupeKey: `orders.tna:${milestone.id}:${status}`,
      })
    }

    return { scanned: open.length, atRisk, late }
  })
}

/** Days before an LC date at which the countdown starts shouting (brief §Events). */
const COUNTDOWN_DAYS = [21, 14, 7] as const

/**
 * LC countdown: warn at 21/14/7 days on expiry and latest shipment while an order linked
 * to the credit is still unshipped.
 *
 * The threshold is part of the dedupe key, so each of the three fires exactly once — and
 * crossing from 14 to 7 raises a NEW notification rather than being swallowed as a
 * duplicate of the previous one.
 */
export async function runLcCountdown(
  ctx: SystemCtx,
  input: { today?: string } = {},
): Promise<{ checked: number; raised: number; conflicts: number }> {
  const today = input.today ?? factoryToday()

  return withTenantTx(ctx, async (tx) => {
    const live = await tx
      .select()
      .from(lcs)
      .where(scoped(lcs, ctx, sql`${lcs.status} IN ('draft','active')`))

    let raised = 0
    let conflicts = 0

    for (const lc of live) {
      const linked = await tx
        .select({
          id: orders.id,
          poNumbers: orders.poNumbers,
          plannedExFactoryDate: orders.plannedExFactoryDate,
          status: orders.status,
        })
        .from(orders)
        .innerJoin(orderLcs, eq(orderLcs.orderId, orders.id))
        .where(scoped(orders, ctx, and(eq(orderLcs.lcId, lc.id), sql`${orders.status} NOT IN ('shipped_full','closed','cancelled')`)))

      if (linked.length === 0) continue

      // The same pure detector the interactive API uses — one implementation, so a
      // conflict cannot be visible on screen and invisible to the nightly job.
      const found = detectLcConflicts({
        lc: {
          id: lc.id,
          number: lc.number,
          latestShipmentDate: lc.latestShipmentDate,
          expiryDate: lc.expiryDate,
          status: lc.status,
        },
        orders: linked.map((order) => ({
          id: order.id,
          poNumbers: order.poNumbers,
          plannedExFactoryDate: order.plannedExFactoryDate,
          status: order.status,
        })),
      })

      for (const conflictFound of found) {
        conflicts += 1
        await notify(ctx, {
          role: 'commercial',
          kind: `commercial.lc.${conflictFound.kind}`,
          severity: conflictFound.severity,
          titleKey: conflictFound.messageKey,
          params: { ...conflictFound.facts, lcNumber: lc.number },
          moduleId: 'orders',
          entityTable: 'lcs',
          entityId: lc.id,
          dedupeKey: `lc.conflict:${lc.id}:${conflictFound.orderId}:${conflictFound.kind}`,
        })
      }

      for (const [label, date] of [
        ['latest_shipment', lc.latestShipmentDate],
        ['expiry', lc.expiryDate],
      ] as const) {
        if (!date) continue
        const daysLeft = diffDays(today, date)
        // Only the first threshold still ahead — three simultaneous warnings for one date
        // is noise, and the tightest one is the actionable number.
        const threshold = COUNTDOWN_DAYS.find((d) => daysLeft <= d && daysLeft >= 0)
        if (threshold === undefined) continue

        raised += 1
        await notify(ctx, {
          role: 'commercial',
          kind: `commercial.lc.countdown.${label}`,
          severity: threshold <= 7 ? 'critical' : 'warning',
          titleKey: `commercial.notifications.lc_countdown_${label}.title`,
          params: { lcNumber: lc.number, date, daysLeft, orders: linked.length },
          moduleId: 'orders',
          entityTable: 'lcs',
          entityId: lc.id,
          // Threshold in the key: crossing 14 → 7 is a new alert, not a duplicate.
          dedupeKey: `lc.countdown:${lc.id}:${label}:${threshold}`,
          // The Pulse/Desk buzz (mobile contract §3): an LC date is the one deadline a
          // commercial officer wants in their pocket, and the dedupe above already keeps
          // it to one buzz per threshold.
          channels: ['in_app', 'push'],
        })
      }
    }

    return { checked: live.length, raised, conflicts }
  })
}
