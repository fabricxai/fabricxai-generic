/**
 * Read models for the RFQ & Quotation desk.
 *
 * The board is organised by what is BLOCKING each enquiry, not just by status.
 * "Clarifying" is two different situations — waiting on the buyer, or the buyer
 * waiting on us — and only the second one is our problem to fix. A board that
 * renders them the same way lets our own unanswered questions sit past the
 * deadline looking like somebody else's delay.
 */
import { asc, desc, eq, inArray } from 'drizzle-orm'

import { buyers } from '@/modules/buyers/schema'
import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'

import { lossReasons, quotes, rfqClarifications, rfqs } from './schema'

export type RfqStatus = 'open' | 'clarifying' | 'quoted' | 'won' | 'lost' | 'cancelled'

export const RFQ_GROUPS: readonly { id: RfqStatus; label: string }[] = [
  { id: 'open', label: 'Open' },
  { id: 'clarifying', label: 'Clarifying' },
  { id: 'quoted', label: 'Quoted' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
]

export interface RfqRow {
  id: string
  title: string
  styleCode: string | null
  description: string | null
  buyerName: string | null
  productType: string
  quantity: number
  unit: string
  targetPrice: string | null
  targetCurrency: string | null
  currency: string
  deadline: string | null
  /** Negative means the deadline has passed. Null when there is no deadline. */
  daysToDeadline: number | null
  /**
   * What a win still needs. The drawer asks for whichever of these is missing at the
   * moment of marking won — an enquiry genuinely arrives without them, and `markWon`
   * refuses an order it cannot schedule or cut.
   */
  requestedShipDate: string | null
  sizeRatio: Record<string, number>
  status: RfqStatus
  source: string
  lossReasonCode: string | null
  /**
   * Latest non-superseded quote, if one has been drafted.
   *
   * Carries its `id` because sending it is an operation ON the quote, not on the RFQ — the
   * board is where somebody sends from, and without the id the screen would have to re-read
   * the quote to find out which one it is already showing.
   */
  quote: { id: string; version: number; fobPrice: string; currency: string; status: string } | null
  /** Open questions, and which side owes the answer. */
  openClarifications: number
  /** True when the oldest open question is one WE asked and nobody has chased. */
  waitingOnBuyer: boolean
  oldestQuestionDays: number | null
}

function daysBetween(fromIso: string, to: Date): number {
  const from = new Date(`${fromIso}T00:00:00Z`).getTime()
  const today = new Date(to.toISOString().slice(0, 10) + 'T00:00:00Z').getTime()
  return Math.round((from - today) / 86_400_000)
}

export async function board(
  ctx: AnyCtx,
  input: { now: Date },
): Promise<{ groups: { status: RfqStatus; label: string; rfqs: RfqRow[] }[]; overdue: RfqRow[] }> {
  const rows = await withTenantRead(ctx, async (tx) => {
    const base = await tx
      .select({
        id: rfqs.id,
        title: rfqs.title,
        styleCode: rfqs.styleCode,
        description: rfqs.description,
        productType: rfqs.productType,
        quantity: rfqs.quantity,
        unit: rfqs.unit,
        targetPrice: rfqs.targetPrice,
        targetCurrency: rfqs.targetCurrency,
        currency: rfqs.currency,
        deadline: rfqs.deadline,
        requestedShipDate: rfqs.requestedShipDate,
        sizeRatio: rfqs.sizeRatio,
        status: rfqs.status,
        source: rfqs.source,
        lossReasonCode: rfqs.lossReasonCode,
        buyerName: buyers.name,
      })
      .from(rfqs)
      .leftJoin(buyers, eq(buyers.id, rfqs.buyerId))
      .orderBy(desc(rfqs.createdAt))
      .limit(200)

    if (base.length === 0) return []

    const ids = base.map((r) => r.id)

    const [quoteRows, clarRows] = await Promise.all([
      tx
        .select({
          id: quotes.id,
          rfqId: quotes.rfqId,
          version: quotes.version,
          fobPrice: quotes.fobPrice,
          currency: quotes.currency,
          status: quotes.status,
        })
        .from(quotes)
        .where(scoped(quotes, ctx, inArray(quotes.rfqId, ids)))
        .orderBy(desc(quotes.version)),
      tx
        .select({
          rfqId: rfqClarifications.rfqId,
          askedAt: rfqClarifications.askedAt,
          answeredAt: rfqClarifications.answeredAt,
        })
        .from(rfqClarifications)
        .where(scoped(rfqClarifications, ctx, inArray(rfqClarifications.rfqId, ids)))
        .orderBy(asc(rfqClarifications.askedAt)),
    ])

    return base.map((r): RfqRow => {
      // Highest version wins; a superseded quote is history, not the current price.
      const quote = quoteRows.find((q) => q.rfqId === r.id && q.status !== 'superseded') ?? null
      const open = clarRows.filter((c) => c.rfqId === r.id && c.answeredAt === null)
      const oldest = open[0] ?? null

      return {
        ...r,
        status: r.status as RfqStatus,
        daysToDeadline: r.deadline ? daysBetween(r.deadline, input.now) : null,
        quote: quote
          ? {
              id: quote.id,
              version: quote.version,
              fobPrice: quote.fobPrice,
              currency: quote.currency,
              status: quote.status,
            }
          : null,
        openClarifications: open.length,
        // We ask, the buyer answers — so an unanswered question is one they owe us.
        waitingOnBuyer: open.length > 0,
        oldestQuestionDays: oldest ? -daysBetween(oldest.askedAt, input.now) : null,
      }
    })
  })

  const groups = RFQ_GROUPS.map((g) => ({
    status: g.id,
    label: g.label,
    rfqs: rows.filter((r) => r.status === g.id),
  }))

  // Only live enquiries can be overdue — a won or lost RFQ's deadline is history.
  const overdue = rows
    .filter((r) => r.status === 'open' || r.status === 'clarifying' || r.status === 'quoted')
    .filter((r) => r.daysToDeadline !== null && r.daysToDeadline < 0)
    .sort((a, b) => (a.daysToDeadline ?? 0) - (b.daysToDeadline ?? 0))

  return { groups, overdue }
}

/**
 * The taxonomy a loss is recorded against (plan 5.3).
 *
 * `markLost` refuses a code that is not in this table, and deliberately: a free-text reason
 * cannot be counted, and counting is the entire point of asking. Nothing read the list, so
 * the one screen that has to offer it had nothing to offer — which is how a required
 * taxonomy becomes a field somebody types "price" into.
 */
export interface LossReasonOption {
  code: string
  label: string
}

export async function lossReasonList(ctx: AnyCtx): Promise<LossReasonOption[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({ code: lossReasons.code, label: lossReasons.label })
      .from(lossReasons)
      .where(eq(lossReasons.companyId, ctx.companyId))
      .orderBy(asc(lossReasons.label)),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// What this style was quoted at, for the order that came out of it
// ─────────────────────────────────────────────────────────────────────────────

export interface StyleQuote {
  rfqId: string
  title: string
  version: number
  fobPrice: string
  currency: string
  status: QuoteStatus
  sentAt: Date | null
  validityDate: string | null
}

/** Mirrors `quoteStatusEnum`. The buyer's answer lives on the ENQUIRY (`won`/`lost`),
 *  not here — a quote is only ever draft, sent, or replaced by a later version. */
type QuoteStatus = 'draft' | 'sent' | 'superseded'

/**
 * The latest quote returned against an enquiry for this style.
 *
 * The first row of the order's sign-off panel (design canvas, "What the departments have
 * signed"): a merchandiser looking at a confirmed order wants the price it was won at,
 * and that number lives here, frozen at the version that was sent — not recomputed from
 * today's cost sheet, which is a different number for good reasons.
 *
 * Joined by style code rather than by an order id, because there is no link between the
 * two: an enquiry becomes an order through a person, not a foreign key. That makes this a
 * best-effort match, and the caller must say so — an order whose style was never quoted
 * (a repeat, a direct placement) correctly gets null rather than somebody else's price.
 */
export async function quoteForStyle(ctx: AnyCtx, styleCode: string): Promise<StyleQuote | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        rfqId: rfqs.id,
        title: rfqs.title,
        version: quotes.version,
        fobPrice: quotes.fobPrice,
        currency: quotes.currency,
        status: quotes.status,
        sentAt: quotes.sentAt,
        validityDate: quotes.validityDate,
      })
      .from(quotes)
      .innerJoin(rfqs, eq(rfqs.id, quotes.rfqId))
      .where(scoped(quotes, ctx, eq(rfqs.styleCode, styleCode)))
      // Newest enquiry first, then its newest quote: a style re-enquired next season must
      // not answer with last season's price.
      .orderBy(desc(rfqs.createdAt), desc(quotes.version))
      .limit(1)

    return row ?? null
  })
}
