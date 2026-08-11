/**
 * Read models for the Buyer & Lead Desk.
 *
 * The pipeline's job is to make a QUIET lead impossible to miss. Days-since-
 * last-activity is therefore computed from `lead_activities`, not from
 * `leads.updated_at` — a row touched by a stage rename is not a lead somebody
 * actually worked, and using updated_at would quietly reset the clock on
 * exactly the leads that have gone cold.
 */
import { desc, eq, ilike, inArray, or, sql } from 'drizzle-orm'

import { likePattern } from '@/lib/search-text'
import type { AnyCtx } from '@/modules/core/ctx'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { orders } from '@/modules/orders/schema'

import { agents, buyers, leadActivities, leads } from './schema'

/** Whole days between a calendar date and now, in the factory's own terms. */
function daysSince(date: string, now: Date): number {
  const then = new Date(`${date}T00:00:00Z`)
  const today = new Date(now.toISOString().slice(0, 10) + 'T00:00:00Z')
  return Math.max(0, Math.round((today.getTime() - then.getTime()) / 86_400_000))
}

export type LeadStage = 'new' | 'contacted' | 'sampling_talk' | 'negotiation' | 'won' | 'lost'

export const LEAD_STAGES: readonly { id: LeadStage; label: string }[] = [
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'sampling_talk', label: 'Sampling talk' },
  { id: 'negotiation', label: 'Negotiation' },
  { id: 'won', label: 'Won' },
  { id: 'lost', label: 'Lost' },
]

export interface LeadCard {
  id: string
  companyName: string
  country: string | null
  stage: LeadStage
  source: string
  notes: string | null
  agentName: string | null
  agentCommissionPct: string | null
  lostReason: string | null
  /**
   * Days since the last logged ACTIVITY, or since the lead arrived when nothing
   * has ever been logged.
   *
   * The fallback is the point: a lead sitting untouched since the day it came in
   * is the quietest lead there is, and reporting it as "no clock" excluded it
   * from the very list built to catch it.
   */
  daysQuiet: number
  /** `occurredAt` is a calendar date in the factory's timezone, not an instant. */
  lastActivity: { kind: string; summary: string; occurredAt: string } | null
}

export async function pipeline(
  ctx: AnyCtx,
  input: { now: Date; quietAfterDays: number },
): Promise<{ stages: { stage: LeadStage; label: string; leads: LeadCard[] }[]; quiet: LeadCard[] }> {
  const cards = await withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: leads.id,
        companyName: leads.companyName,
        country: leads.country,
        stage: leads.stage,
        source: leads.source,
        notes: leads.notes,
        lostReason: leads.lostReason,
        agentName: agents.name,
        agentCommissionPct: agents.commissionPct,
        createdAt: leads.createdAt,
      })
      .from(leads)
      .leftJoin(agents, eq(agents.id, leads.agentId))
      .orderBy(desc(leads.createdAt))
      .limit(300)

    if (rows.length === 0) return []

    // Latest activity per lead, in one pass rather than a query per card.
    const activity = await tx
      .select({
        leadId: leadActivities.leadId,
        kind: leadActivities.kind,
        summary: leadActivities.summary,
        occurredAt: leadActivities.occurredAt,
      })
      .from(leadActivities)
      .where(scoped(leadActivities, ctx, 
        inArray(
          leadActivities.leadId,
          rows.map((r) => r.id),
        ),
      ))
      .orderBy(desc(leadActivities.occurredAt))

    const latest = new Map<string, (typeof activity)[number]>()
    for (const a of activity) if (!latest.has(a.leadId)) latest.set(a.leadId, a)

    return rows.map(({ createdAt, ...row }): LeadCard => {
      const last = latest.get(row.id) ?? null
      return {
        ...row,
        stage: row.stage as LeadStage,
        // Still null, so the card can say nothing was ever logged rather than
        // implying somebody made contact on the day it arrived.
        lastActivity: last
          ? { kind: last.kind, summary: last.summary, occurredAt: last.occurredAt }
          : null,
        daysQuiet: daysSince(
          last ? last.occurredAt : createdAt.toISOString().slice(0, 10),
          input.now,
        ),
      }
    })
  })

  const stages = LEAD_STAGES.map((s) => ({
    stage: s.id,
    label: s.label,
    leads: cards.filter((c) => c.stage === s.id),
  }))

  // Won and lost are settled — a closed lead going quiet is not a problem.
  const quiet = cards
    .filter((c) => c.stage !== 'won' && c.stage !== 'lost')
    .filter((c) => c.daysQuiet >= input.quietAfterDays)
    .sort((a, b) => b.daysQuiet - a.daysQuiet)

  return { stages, quiet }
}

export interface BuyerAccount {
  id: string
  code: string
  name: string
  country: string | null
  status: string
  activeOrders: number
}

export async function buyerAccounts(ctx: AnyCtx): Promise<BuyerAccount[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: buyers.id,
        code: buyers.code,
        name: buyers.name,
        country: buyers.country,
        status: buyers.status,
        // Open work only — a closed order says nothing about the relationship now.
        activeOrders: sql<number>`count(${orders.id}) filter (
          where ${orders.status} not in ('closed', 'cancelled')
        )`.mapWith(Number),
      })
      .from(buyers)
      .leftJoin(orders, eq(orders.buyerId, buyers.id))
      .where(scoped(buyers, ctx, eq(buyers.isActive, true)))
      .groupBy(buyers.id)
      .orderBy(buyers.name)

    return rows
  })
}


/** A buyer or a lead, as the command bar shows it. */
export interface BuyerSearchRow {
  id: string
  name: string
  country: string | null
}

export interface LeadSearchRow {
  id: string
  companyName: string
  stage: string
  country: string | null
}

/** Buyer accounts matching a name or country fragment. */
export async function searchBuyers(
  ctx: AnyCtx,
  input: { term: string; limit: number },
): Promise<BuyerSearchRow[]> {
  const like = likePattern(input.term)

  return withTenantRead(ctx, (tx) =>
    tx
      .select({ id: buyers.id, name: buyers.name, country: buyers.country })
      .from(buyers)
      .where(scoped(buyers, ctx, or(ilike(buyers.name, like), ilike(buyers.country, like))))
      .limit(input.limit),
  )
}

/** Leads matching a company-name or country fragment. */
export async function searchLeads(
  ctx: AnyCtx,
  input: { term: string; limit: number },
): Promise<LeadSearchRow[]> {
  const like = likePattern(input.term)

  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: leads.id,
        companyName: leads.companyName,
        stage: leads.stage,
        country: leads.country,
      })
      .from(leads)
      .where(scoped(leads, ctx, or(ilike(leads.companyName, like), ilike(leads.country, like))))
      .limit(input.limit),
  )
}

/**
 * The id behind a buyer code — `B-04501`, exactly as it is printed on the row.
 *
 * Exact, and only the code. `searchBuyers` above exists for "find me something like this"
 * and returns a list a person chooses from; this answers a tool that is about to ACT, and
 * the nearest match is how a shipment ends up against the wrong buyer. `buyers_company_code_key`
 * makes the answer unique within the company, which is what lets there be one at all.
 *
 * Case-insensitive because a code is read off paper and typed back by hand, and `b-04501`
 * is not a different buyer.
 */
export async function buyerIdByCode(ctx: AnyCtx, code: string): Promise<string | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({ id: buyers.id })
      .from(buyers)
      .where(scoped(buyers, ctx, sql`lower(${buyers.code}) = lower(${code})`))
      .limit(1)
    return row?.id ?? null
  })
}
