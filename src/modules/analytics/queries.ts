/**
 * 11.2 — the read layer. There is no `service.ts` in this module, and that is the point.
 *
 * CLAUDE.md rule 9: `modules/analytics` never writes, enforced by the `analytics-no-writes`
 * lint rule. It reads across every other module's tables because that is what an owner's
 * dashboard is, and that breadth is exactly why it must not be able to mutate anything — a
 * reporting layer that quietly fixed a row would be the last place anybody looked when the
 * numbers stopped reconciling.
 *
 * Every figure here comes back with two things attached that a dashboard usually omits:
 *
 *  - **its denominator**, so a percentage can be judged. "94% on-time" over eighty shipments
 *    and over three are different claims, and the second is not one at all.
 *  - **`asOf`**, so nothing is presented as "now" that was computed five minutes ago.
 *
 * And where a figure cannot honestly be produced — a period the factory was shut, a buyer
 * with two orders — the shape returned says so rather than carrying a zero.
 */
import { and, count, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'
import { z } from 'zod'

import { money, type Money } from '@/lib/money'

import type { AnyCtx } from '../core/ctx'
import { readJsonbObject } from '../core/jsonb'
import { type TenantDb, withTenantRead } from '../core/tenancy'

import {
  AnalyticsError,
  asOf,
  buyerScorecard,
  cashPosition,
  dhuForPeriod,
  efficiencyForPeriod,
  exceptionSeverity,
  otdPct,
  trendDirection,
  type AsOf,
  type CashPosition,
  type ExceptionKind,
  type Scorecard,
  type ScorecardPolicy,
  type Trend,
} from './analytics'
import { exceptionsFeed, savedReports, scheduledExports } from './schema'

/**
 * Which exception kinds the refresher actually scans.
 *
 * Returned with every read of the feed. Two of the six kinds have no source wired yet, and
 * an owner looking at a feed with no `payroll_anomaly` rows must be able to tell whether
 * that means there were none or that nobody looked — the same distinction 1.6 draws with
 * `compiledSources`, and for the same reason.
 */
export const FEED_COVERAGE: Readonly<Record<ExceptionKind, boolean>> = {
  lc_conflict: true,
  tna_risk: true,
  cap_critical: true,
  approval_waiting: true,
  runrate_miss: false,
  payroll_anomaly: false,
}

export interface AnalyticsPolicy {
  /** Cache TTL the brief sets at five minutes. */
  ttlSeconds: number
  /** Shipments below which no on-time percentage is stated. */
  minShipmentsForOtd: number
  scorecard: ScorecardPolicy
  trend: { minPoints: number; thresholdPct: string }
}

function wrapAnalyticsError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof AnalyticsError) {
      // Deliberately NOT a 500. "This period has no efficiency to report" is an answer the
      // dashboard should render, not an error somebody has to go and investigate.
      return { unavailable: error.message } as never
    }
    throw error
  }
}

/** A figure, or an honest account of why there isn't one. */
export type Figure<T> = { value: T; unavailable?: never } | { value?: never; unavailable: string }

const figure = <T>(run: () => T): Figure<T> => {
  try {
    return { value: run() }
  } catch (error) {
    if (error instanceof AnalyticsError) return { unavailable: error.message }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The exceptions feed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the feed carries alongside an exception — an LC number, a milestone name,
 * a deadline. Scalars only: this is rendered as a single line of prose on the
 * dashboard, and a nested value would arrive there as `[object Object]`.
 */
const exceptionDetail = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
)

export interface ExceptionRow {
  id: string
  kind: ExceptionKind
  ref: string
  /** Null when the stored detail would not parse — the row still shows, unexplained. */
  detail: Record<string, string | number | boolean | null> | null
  /**
   * What this exception is ABOUT, in the words the factory uses for it — "PO-BF-2044",
   * "LC-4471". Resolved here because the feed stores ids and only ids: a `tna_risk` row
   * carries the milestone's uuid as `ref` and the order's uuid in its detail, and neither is
   * something a person can act on. The owner's screen showed nine late milestones without
   * naming one order between them.
   *
   * Null when the subject cannot be resolved — a row whose order has since been deleted is
   * still a real exception, and dropping it would hide the problem to tidy the screen.
   */
  subject: string | null
  since: Date
  severity: 'low' | 'medium' | 'high'
  ageDays: number
}

export interface ExceptionsFeed {
  exceptions: ExceptionRow[]
  /** Which kinds were actually scanned. An absent kind is not an absence of problems. */
  coverage: Readonly<Record<ExceptionKind, boolean>>
  asOf: AsOf | { unavailable: string }
}

/** What is wrong right now, loudest and oldest first. */
export async function exceptions(
  ctx: AnyCtx,
  now: Date,
  policy: AnalyticsPolicy,
): Promise<ExceptionsFeed> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(exceptionsFeed)
      .where(isNull(exceptionsFeed.resolvedAt))
      .orderBy(sql`${exceptionsFeed.severity} desc`, exceptionsFeed.since)

    const parsed = rows.map((row) => ({
      id: row.id,
      kind: row.kind as ExceptionKind,
      ref: row.ref,
      // An exception whose detail will not parse is still an exception — losing
      // the row because its explanation is malformed hides the problem itself.
      detail: readJsonbObject(exceptionDetail, row.detail, 'exceptions_feed.detail'),
      since: row.since,
      severity: row.severity as 'low' | 'medium' | 'high',
      ageDays: Math.floor((now.getTime() - row.since.getTime()) / 86_400_000),
    }))

    const subjects = await resolveSubjects(tx, parsed)
    const mapped = parsed.map((row) => ({ ...row, subject: subjects.get(row.id) ?? null }))

    // The newest `last_seen_at` is when the feed was last refreshed. With no rows at all
    // there is nothing to date it from, which is itself worth saying.
    const lastSeen = rows.reduce<Date | null>(
      (latest, row) => (!latest || row.lastSeenAt > latest ? row.lastSeenAt : latest),
      null,
    )

    return {
      exceptions: mapped,
      coverage: FEED_COVERAGE,
      asOf: lastSeen
        ? (figure(() => asOf(lastSeen, now, policy.ttlSeconds)).value ?? {
            unavailable: 'the feed has never been refreshed',
          })
        : { unavailable: 'the feed has never been refreshed' },
    }
  })
}

/**
 * Turn the ids the feed stores into the names the factory uses.
 *
 * One batched read per kind rather than one per row: the feed is capped at what fits a
 * screen, but it is read on every dashboard load by every owner, and a query per exception
 * is the shape that looks fine with nine rows and falls over at ninety.
 *
 * Reads only — `modules/analytics` is read-only by rule 9, and this stays a lookup.
 */
async function resolveSubjects(
  tx: TenantDb,
  rows: readonly { id: string; kind: ExceptionKind; ref: string; detail: Record<string, unknown> | null }[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()

  const orderIds = new Set<string>()
  for (const row of rows) {
    const id = row.detail?.orderId
    if (typeof id === 'string' && id) orderIds.add(id)
  }

  if (orderIds.size > 0) {
    const { orders } = await import('@/modules/orders/schema')
    const found = await tx
      .select({ id: orders.id, poNumbers: orders.poNumbers })
      .from(orders)
      .where(inArray(orders.id, [...orderIds]))

    // The FIRST po number, not all of them. An order carrying both the buyer's number and a
    // supplier reference would otherwise print two, and the first is the one the desk says
    // out loud.
    const byId = new Map(found.map((o) => [o.id, (o.poNumbers as string[])[0] ?? null]))
    for (const row of rows) {
      const id = row.detail?.orderId
      if (typeof id === 'string') {
        const po = byId.get(id)
        if (po) out.set(row.id, po)
      }
    }
  }

  // The rest name themselves in their own detail — a credit carries its number, and there is
  // nothing to look up.
  for (const row of rows) {
    if (out.has(row.id)) continue
    const named = row.detail?.lcNumber ?? row.detail?.number ?? row.detail?.moduleId
    if (typeof named === 'string' && named) out.set(row.id, named)
  }

  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregations
// ─────────────────────────────────────────────────────────────────────────────

export interface OrderBook {
  byStatus: { status: string; orders: number; pieces: number }[]
  totalOrders: number
}

export async function orderBook(ctx: AnyCtx): Promise<OrderBook> {
  const { orderStyles, orders } = await import('@/modules/orders/schema')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        status: orders.status,
        orders: count(orders.id),
        pieces: sql<string>`coalesce(sum(${orderStyles.contractedQty}), 0)`,
      })
      .from(orders)
      .leftJoin(orderStyles, eq(orderStyles.orderId, orders.id))
      .groupBy(orders.status)

    return {
      byStatus: rows.map((row) => ({
        status: row.status,
        orders: Number(row.orders),
        pieces: Number(row.pieces),
      })),
      totalOrders: rows.reduce((running, row) => running + Number(row.orders), 0),
    }
  })
}

export interface OtdResult {
  shipments: number
  onTime: number
  /** Absent when there were too few shipments to state one — the counts stand alone. */
  pct: Figure<string>
}

/**
 * On-time delivery over a window.
 *
 * A shipment counts as on time when it actually left on or before its planned ex-factory
 * date. Shipments with no actual date are excluded from BOTH sides — they have not shipped,
 * and counting them as late would report a future commitment as a failure.
 */
export async function otd(
  ctx: AnyCtx,
  window: { from: string; to: string },
  policy: AnalyticsPolicy,
): Promise<OtdResult> {
  const { shipments } = await import('@/modules/shipment/schema')

  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        shipped: count(shipments.id),
        onTime: sql<string>`count(*) filter (where ${shipments.actualExFactory} <= ${shipments.plannedExFactory})`,
      })
      .from(shipments)
      .where(
        and(
          sql`${shipments.actualExFactory} is not null`,
          gte(shipments.actualExFactory, window.from),
          lte(shipments.actualExFactory, window.to),
        ),
      )

    const shipped = Number(row?.shipped ?? 0)
    const onTime = Number(row?.onTime ?? 0)

    return {
      shipments: shipped,
      onTime,
      pct: figure(() => otdPct({ shipped, onTime, minShipments: policy.minShipmentsForOtd })),
    }
  })
}

export interface TrendResult {
  points: { date: string; pct: string }[]
  /** The period figure, computed as one ratio — never the mean of the points. */
  period: Figure<string>
  direction: Trend
}

export async function efficiencyTrend(
  ctx: AnyCtx,
  window: { from: string; to: string },
  policy: AnalyticsPolicy,
): Promise<TrendResult> {
  const { efficiencyDaily } = await import('@/modules/production/schema')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        forDate: efficiencyDaily.forDate,
        earned: sql<string>`sum(${efficiencyDaily.earnedMinutes})`,
        available: sql<string>`sum(${efficiencyDaily.availableMinutes})`,
      })
      .from(efficiencyDaily)
      .where(and(gte(efficiencyDaily.forDate, window.from), lte(efficiencyDaily.forDate, window.to)))
      .groupBy(efficiencyDaily.forDate)
      .orderBy(efficiencyDaily.forDate)

    const points = rows.map((row) => ({
      date: row.forDate,
      // Per-day, each day's own ratio — for the chart. The PERIOD figure below is not
      // derived from these.
      pct: figure(() =>
        efficiencyForPeriod([{ earnedMinutes: row.earned, availableMinutes: row.available }]),
      ).value ?? '0.00',
    }))

    return {
      points,
      period: figure(() =>
        efficiencyForPeriod(
          rows.map((row) => ({ earnedMinutes: row.earned, availableMinutes: row.available })),
        ),
      ),
      direction: trendDirection(
        points.map((point) => Number(point.pct)),
        policy.trend,
      ),
    }
  })
}

export async function dhuTrend(
  ctx: AnyCtx,
  window: { from: string; to: string },
  policy: AnalyticsPolicy,
): Promise<TrendResult> {
  const { dhuDaily } = await import('@/modules/quality/schema')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        dhuDate: dhuDaily.dhuDate,
        defects: sql<string>`sum(${dhuDaily.defects})`,
        checked: sql<string>`sum(${dhuDaily.checked})`,
      })
      .from(dhuDaily)
      .where(and(gte(dhuDaily.dhuDate, window.from), lte(dhuDaily.dhuDate, window.to)))
      .groupBy(dhuDaily.dhuDate)
      .orderBy(dhuDaily.dhuDate)

    const points = rows.map((row) => ({
      date: row.dhuDate,
      pct:
        figure(() => dhuForPeriod([{ defects: Number(row.defects), checked: Number(row.checked) }]))
          .value ?? '0.00',
    }))

    return {
      points,
      period: figure(() =>
        dhuForPeriod(
          rows.map((row) => ({ defects: Number(row.defects), checked: Number(row.checked) })),
        ),
      ),
      // Falling DHU is an improvement, so the sense is inverted against efficiency.
      direction: invert(
        trendDirection(
          points.map((point) => Number(point.pct)),
          policy.trend,
        ),
      ),
    }
  })
}

/** Lower is better for DHU: a downward series is `improving`, not `worsening`. */
const invert = (trend: Trend): Trend =>
  trend === 'improving' ? 'worsening' : trend === 'worsening' ? 'improving' : trend

export async function cash(ctx: AnyCtx, currency: string): Promise<CashPosition> {
  const { payables, receivables } = await import('@/modules/finance/schema')

  return withTenantRead(ctx, async (tx) => {
    const due = await tx
      .select({ amount: receivables.amount, currency: receivables.currency })
      .from(receivables)
      // Still owed: fully realized and written-off receivables are no longer cash coming in.
      .where(and(eq(receivables.currency, currency), inArray(receivables.status, ['open', 'part_realized'])))

    const owed = await tx
      .select({ amount: payables.amount, currency: payables.currency })
      .from(payables)
      .where(and(eq(payables.currency, currency), inArray(payables.status, ['open', 'part_paid'])))

    return cashPosition({
      receivables: due.map((row) => money(row.amount, row.currency)),
      payables: owed.map((row) => money(row.amount, row.currency)),
      currency,
    })
  })
}

/**
 * Buyer scorecards, including the unrated ones.
 *
 * A buyer without enough history comes back `rated: false` with the reason, rather than
 * being dropped. Dropping them makes the list look like the factory's whole book, and the
 * newest buyers — the ones an owner is most likely to be deciding about — are exactly the
 * ones that would disappear from it.
 */
export async function buyerScorecards(
  ctx: AnyCtx,
  window: { from: string; to: string },
  policy: AnalyticsPolicy,
): Promise<Scorecard[]> {
  const { buyers } = await import('@/modules/buyers/schema')
  const { orders } = await import('@/modules/orders/schema')
  const { orderProfitabilityRows } = await import('@/modules/finance/schema')
  const { shipments } = await import('@/modules/shipment/schema')

  return withTenantRead(ctx, async (tx) => {
    const book = await tx
      .select({
        buyerId: buyers.id,
        orders: count(orders.id),
      })
      .from(buyers)
      .leftJoin(orders, eq(orders.buyerId, buyers.id))
      .groupBy(buyers.id)

    const delivery = await tx
      .select({
        buyerId: orders.buyerId,
        shipped: count(shipments.id),
        onTime: sql<string>`count(*) filter (where ${shipments.actualExFactory} <= ${shipments.plannedExFactory})`,
      })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .where(
        and(
          sql`${shipments.actualExFactory} is not null`,
          gte(shipments.actualExFactory, window.from),
          lte(shipments.actualExFactory, window.to),
        ),
      )
      .groupBy(orders.buyerId)

    const margins = await tx
      .select({
        buyerId: orders.buyerId,
        avgMargin: sql<string>`avg(${orderProfitabilityRows.actualMarginPct})`,
      })
      .from(orderProfitabilityRows)
      .innerJoin(orders, eq(orders.id, orderProfitabilityRows.orderId))
      .groupBy(orders.buyerId)

    const otdBy = new Map(delivery.map((row) => [row.buyerId, row]))
    const marginBy = new Map(margins.map((row) => [row.buyerId, row.avgMargin]))

    return book.map((row) => {
      const shipping = otdBy.get(row.buyerId)
      const otdValue =
        shipping && Number(shipping.shipped) >= policy.minShipmentsForOtd
          ? figure(() =>
              otdPct({
                shipped: Number(shipping.shipped),
                onTime: Number(shipping.onTime),
                minShipments: policy.minShipmentsForOtd,
              }),
            ).value ?? null
          : null

      return buyerScorecard(
        {
          buyerId: row.buyerId,
          orders: Number(row.orders),
          otdPct: otdValue,
          // No quality figure is wired per buyer yet; an absent component is refused rather
          // than scored as zero, which is what makes that honest.
          dhu: null,
          avgMarginPct: marginBy.get(row.buyerId) ?? null,
        },
        policy.scorecard,
      )
    })
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Saved reports
// ─────────────────────────────────────────────────────────────────────────────

export async function listSavedReports(
  ctx: AnyCtx,
): Promise<(typeof savedReports.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) => tx.select().from(savedReports).orderBy(savedReports.name))
}

export async function listScheduledExports(
  ctx: AnyCtx,
): Promise<(typeof scheduledExports.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx.select().from(scheduledExports).orderBy(scheduledExports.nextRunAt),
  )
}

export { exceptionSeverity, inArray, wrapAnalyticsError, type Money }
