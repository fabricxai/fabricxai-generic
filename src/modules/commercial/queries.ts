/**
 * Read models for the LC Register.
 *
 * A letter of credit has two dates that both matter and are easy to confuse:
 * the LATEST SHIPMENT date, after which the bank will not accept documents for
 * goods that left later, and the EXPIRY, after which it will not accept them at
 * all. Shipping inside expiry but past latest shipment produces a discrepancy
 * the buyer has to waive, which is the single most common way a factory's money
 * gets stuck at a bank.
 *
 * So this file computes both clocks and, more importantly, the CONFLICT between
 * them — an LC whose latest shipment falls after its own expiry is structurally
 * unworkable and needs an amendment before anything ships against it.
 */
import { desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'

import { compareDecimalStrings, ratioAsPercent } from '@/lib/quantity'
import { buyers } from '@/modules/buyers/schema'
import { likePattern } from '@/lib/search-text'
import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'

import { btbLcs, docSubmissions, lcs } from './schema'

export type LcStatus = 'draft' | 'active' | 'expired' | 'closed'

/**
 * Why an LC needs somebody's attention, worst first.
 *
 * Deliberately absent: "latest shipment falls after expiry". That combination
 * is structurally unworkable, and the schema already makes it unrepresentable
 * via the `lcs_expiry_after_latest_shipment` CHECK — so a screen handling it
 * would be unreachable code implying a state the database forbids.
 */
export type LcAlert =
  | { kind: 'latest_shipment_passed'; days: number }
  | { kind: 'expiring'; days: number }
  | { kind: 'expired'; days: number }
  | { kind: 'discrepant'; count: number; oldestDays: number | null }
  | { kind: 'btb_over_limit'; usedPct: string; limitPct: number }

export interface LcRow {
  id: string
  number: string
  buyerName: string | null
  value: string
  currency: string
  tolerancePct: string | null
  issueDate: string | null
  latestShipmentDate: string | null
  expiryDate: string | null
  status: LcStatus
  daysToExpiry: number | null
  daysToLatestShipment: number | null
  /** Sum of BTBs opened against this master, and what share of the limit that is. */
  btbCount: number
  btbValue: string
  btbUsedPct: string | null
  /** Documents presented to the bank, by where they got to. */
  submissions: { total: number; discrepant: number; realized: number }
  realizedAmount: string
  alerts: LcAlert[]
}

function daysUntil(dateIso: string, now: Date): number {
  const target = new Date(`${dateIso}T00:00:00Z`).getTime()
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.round((target - today) / 86_400_000)
}

/** Decimal strings added as scaled integers — these are money. */
function sumMoney(amounts: readonly (string | null)[]): string {
  const total = amounts.reduce((acc, a) => {
    if (!a) return acc
    const [whole = '0', frac = ''] = a.split('.')
    return acc + BigInt(whole + frac.padEnd(2, '0').slice(0, 2))
  }, 0n)
  const s = total.toString().padStart(3, '0')
  return `${s.slice(0, -2)}.${s.slice(-2)}`
}

// Exact, not a float division: the number this produces is compared against the BTB
// limit below, and "over the back-to-back ceiling" is a decision a bank can dispute.
const pctOf = (part: string, whole: string): string | null => ratioAsPercent(part, whole, 1)

export async function register(
  ctx: AnyCtx,
  input: { now: Date; expiringWithinDays: number; btbLimitPct: number },
): Promise<LcRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: lcs.id,
        number: lcs.number,
        value: lcs.value,
        currency: lcs.currency,
        tolerancePct: lcs.tolerancePct,
        issueDate: lcs.issueDate,
        latestShipmentDate: lcs.latestShipmentDate,
        expiryDate: lcs.expiryDate,
        status: lcs.status,
        buyerName: buyers.name,
      })
      .from(lcs)
      .leftJoin(buyers, eq(buyers.id, lcs.buyerId))
      .orderBy(desc(lcs.issueDate))
      .limit(200)

    if (rows.length === 0) return []

    const ids = rows.map((r) => r.id)

    const [btbRows, subRows] = await Promise.all([
      tx
        .select({ masterLcId: btbLcs.masterLcId, value: btbLcs.value, status: btbLcs.status })
        .from(btbLcs)
        .where(scoped(btbLcs, ctx, inArray(btbLcs.masterLcId, ids))),
      tx
        .select({
          lcId: docSubmissions.lcId,
          bankStatus: docSubmissions.bankStatus,
          realizedAmount: docSubmissions.realizedAmount,
          discrepantSince: docSubmissions.discrepantSince,
        })
        .from(docSubmissions)
        .where(scoped(docSubmissions, ctx, inArray(docSubmissions.lcId, ids))),
    ])

    return rows.map((r): LcRow => {
      const status = r.status as LcStatus

      // Matches `checkBtbHeadroom` exactly: everything except a closed BTB still
      // consumes the master. If this filter and the gate ever disagree, the
      // register would show room the gate then refuses.
      const btbs = btbRows.filter((b) => b.masterLcId === r.id && b.status !== 'closed')
      const btbValue = sumMoney(btbs.map((b) => b.value))
      const btbUsedPct = pctOf(btbValue, r.value)

      const subs = subRows.filter((s) => s.lcId === r.id)
      const discrepant = subs.filter((s) => s.bankStatus === 'discrepant')
      const realized = subs.filter((s) => s.bankStatus === 'realized')

      const daysToExpiry = r.expiryDate ? daysUntil(r.expiryDate, input.now) : null
      const daysToLatestShipment = r.latestShipmentDate
        ? daysUntil(r.latestShipmentDate, input.now)
        : null

      const alerts: LcAlert[] = []

      if (status === 'active') {
        if (daysToExpiry !== null && daysToExpiry < 0) {
          alerts.push({ kind: 'expired', days: -daysToExpiry })
        } else if (daysToExpiry !== null && daysToExpiry <= input.expiringWithinDays) {
          alerts.push({ kind: 'expiring', days: daysToExpiry })
        }

        if (daysToLatestShipment !== null && daysToLatestShipment < 0) {
          alerts.push({ kind: 'latest_shipment_passed', days: -daysToLatestShipment })
        }
      }

      if (discrepant.length > 0) {
        const oldest = discrepant
          .map((d) => (d.discrepantSince ? -daysUntil(d.discrepantSince, input.now) : null))
          .filter((n): n is number => n !== null)
          .sort((a, b) => b - a)[0]
        alerts.push({ kind: 'discrepant', count: discrepant.length, oldestDays: oldest ?? null })
      }

      if (btbUsedPct !== null && compareDecimalStrings(btbUsedPct, String(input.btbLimitPct)) > 0) {
        alerts.push({ kind: 'btb_over_limit', usedPct: btbUsedPct, limitPct: input.btbLimitPct })
      }

      return {
        ...r,
        status,
        daysToExpiry,
        daysToLatestShipment,
        btbCount: btbs.length,
        btbValue,
        btbUsedPct,
        submissions: {
          total: subs.length,
          discrepant: discrepant.length,
          realized: realized.length,
        },
        realizedAmount: sumMoney(subs.map((s) => s.realizedAmount)),
        alerts,
      }
    })
  })
}

/** Total exposure by currency — never netted across, because there is no ambient rate. */
export async function exposureByCurrency(
  ctx: AnyCtx,
): Promise<{ currency: string; openValue: string; count: number }[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select({
        currency: lcs.currency,
        openValue: sql<string>`coalesce(sum(${lcs.value}), 0)::text`,
        count: sql<number>`count(*)`.mapWith(Number),
      })
      .from(lcs)
      .where(scoped(lcs, ctx, eq(lcs.status, 'active')))
      .groupBy(lcs.currency),
  )
}

export interface LcAmendmentRow {
  id: string
  number: number
  /** `{ field, from, to }[]` — what the amendment replaced, kept rather than overwritten. */
  changed: { field: string; from: string | null; to: string | null }[]
  tightened: boolean
  receivedAt: string
  createdAt: Date
}

export interface BtbRow {
  id: string
  number: string
  value: string
  currency: string
  status: string
  openedAt: string | null
  expiryDate: string | null
}

export interface SubmissionRow {
  id: string
  bankStatus: string
  invoicedAmount: string | null
  realizedAmount: string | null
  currency: string
  submittedAt: string | null
  discrepantSince: string | null
  discrepancyNotes: string | null
  realizedAt: string | null
}

export interface LcDetail {
  id: string
  number: string
  buyerId: string
  buyerName: string | null
  value: string
  currency: string
  tolerancePct: string
  status: string
  issueDate: string | null
  latestShipmentDate: string | null
  expiryDate: string | null
  docsRequired: Record<string, unknown>
  amendments: LcAmendmentRow[]
  btbs: BtbRow[]
  submissions: SubmissionRow[]
  /** Back-to-back headroom against this master, at the factory's configured limit. */
  headroom: { limit: string; used: string; free: string; limitPct: number }
  /**
   * The orders this credit covers, with their shipping float. The join every conflict
   * check runs through — shown so a commercial officer sees what the detector sees.
   */
  linkedOrders: LinkedOrderRow[]
}

export interface LinkedOrderRow {
  orderId: string
  poNumbers: string[]
  plannedExFactoryDate: string | null
  status: string
  /** latest shipment − planned ex-factory, in days. Negative means already in conflict. */
  floatDays: number | null
}

/**
 * One letter of credit, with everything drawn against it (canvas P2).
 *
 * The amendments carry their own diffs rather than being folded into the LC row, because
 * `recordAmendment` "keeps the replaced value, never overwrites". An LC that shows only its
 * current terms cannot answer the question a bank actually asks — what did the credit say
 * on the day we shipped — and that question decides whether a presentation is paid.
 */
export async function lcDetail(
  ctx: AnyCtx,
  lcId: string,
  limitPct: number,
): Promise<LcDetail | null> {
  const { buyers } = await import('@/modules/buyers/schema')
  const { btbHeadroom } = await import('./lc-conflicts')
  const { btbLcs, docSubmissions, lcAmendments } = await import('./schema')

  return withTenantRead(ctx, async (tx) => {
    const [lc] = await tx
      .select({
        id: lcs.id,
        number: lcs.number,
        buyerId: lcs.buyerId,
        buyerName: buyers.name,
        value: lcs.value,
        currency: lcs.currency,
        tolerancePct: lcs.tolerancePct,
        status: lcs.status,
        issueDate: lcs.issueDate,
        latestShipmentDate: lcs.latestShipmentDate,
        expiryDate: lcs.expiryDate,
        docsRequired: lcs.docsRequired,
      })
      .from(lcs)
      .leftJoin(buyers, eq(buyers.id, lcs.buyerId))
      .where(scoped(lcs, ctx, eq(lcs.id, lcId)))

    if (!lc) return null

    const [amendments, btbs, submissions] = await Promise.all([
      tx
        .select()
        .from(lcAmendments)
        .where(scoped(lcAmendments, ctx, eq(lcAmendments.lcId, lcId)))
        .orderBy(desc(lcAmendments.number)),
      tx.select().from(btbLcs).where(scoped(btbLcs, ctx, eq(btbLcs.masterLcId, lcId))).orderBy(desc(btbLcs.createdAt)),
      tx
        .select()
        .from(docSubmissions)
        .where(scoped(docSubmissions, ctx, eq(docSubmissions.lcId, lcId)))
        .orderBy(desc(docSubmissions.createdAt)),
    ])

    // The orders this credit covers — the exact join the conflict detector and the
    // countdown job run through, so the screen shows what the machinery sees.
    const { orderLcs, orders } = await import('@/modules/orders/schema')
    const linkedRows = await tx
      .select({
        orderId: orders.id,
        poNumbers: orders.poNumbers,
        plannedExFactoryDate: orders.plannedExFactoryDate,
        status: orders.status,
      })
      .from(orderLcs)
      .innerJoin(orders, eq(orders.id, orderLcs.orderId))
      .where(scoped(orderLcs, ctx, eq(orderLcs.lcId, lcId)))

    const linkedOrders: LinkedOrderRow[] = linkedRows.map((row) => ({
      orderId: row.orderId,
      poNumbers: row.poNumbers ?? [],
      plannedExFactoryDate: row.plannedExFactoryDate,
      status: row.status,
      floatDays:
        lc.latestShipmentDate && row.plannedExFactoryDate
          ? Math.round(
              (Date.parse(`${lc.latestShipmentDate}T00:00:00Z`) -
                Date.parse(`${row.plannedExFactoryDate}T00:00:00Z`)) /
                86_400_000,
            )
          : null,
    }))

    // Draft and active BTBs hold headroom; expired and closed ones have stopped being
    // outstanding commitments against the master. The question a commercial officer is
    // actually asking is "can I open another one", and a settled BTB does not stand in the
    // way of that — while a draft absolutely does, because somebody is about to sign it.
    const live = btbs.filter((b) => b.status === 'draft' || b.status === 'active')
    const headroom = btbHeadroom({
      masterValue: lc.value,
      existingBtbValues: live.map((b) => b.value),
      limitPct,
    })

    return {
      ...lc,
      docsRequired: (lc.docsRequired ?? {}) as Record<string, unknown>,
      amendments: amendments.map((a) => ({
        id: a.id,
        number: a.number,
        changed: (a.diff ?? []) as { field: string; from: string | null; to: string | null }[],
        tightened: a.tightened,
        receivedAt: a.receivedAt,
        createdAt: a.createdAt,
      })),
      btbs: btbs.map((b) => ({
        id: b.id,
        number: b.number,
        value: b.value,
        currency: b.currency,
        status: b.status,
        openedAt: b.openedAt,
        expiryDate: b.expiryDate,
      })),
      submissions: submissions.map((s) => ({
        id: s.id,
        bankStatus: s.bankStatus,
        invoicedAmount: s.invoicedAmount,
        realizedAmount: s.realizedAmount,
        currency: s.currency,
        submittedAt: s.submittedAt,
        discrepantSince: s.discrepantSince,
        discrepancyNotes: s.discrepancyNotes,
        realizedAt: s.realizedAt,
      })),
      headroom: { ...headroom, limitPct },
      linkedOrders,
    }
  })
}


/** A credit, as the command bar shows it. */
export interface LcSearchRow {
  id: string
  number: string
  status: string
  buyerName: string | null
}

/** Letters of credit matching an LC number or buyer name. */
export async function searchLcs(
  ctx: AnyCtx,
  input: { term: string; limit: number },
): Promise<LcSearchRow[]> {
  const like = likePattern(input.term)

  return withTenantRead(ctx, (tx) =>
    tx
      .select({ id: lcs.id, number: lcs.number, status: lcs.status, buyerName: buyers.name })
      .from(lcs)
      .leftJoin(buyers, eq(buyers.id, lcs.buyerId))
      .where(scoped(lcs, ctx, or(ilike(lcs.number, like), ilike(buyers.name, like))))
      .limit(input.limit),
  )
}
