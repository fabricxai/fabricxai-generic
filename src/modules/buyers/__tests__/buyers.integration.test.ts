/**
 * 1.1 integration — buyer lead desk.
 *
 * The normalisation is covered by `buyers.test.ts`. What is asserted here is what only a
 * database can be wrong about:
 *
 *  - trigram duplicate detection actually finds the buyer somebody is about to re-create,
 *    and a matching DOMAIN outranks a similar name;
 *  - `convertLead` is idempotent — a second call returns the buyer it already made;
 *  - terms are versioned, backdating is refused, and the version in force on an ORDER's
 *    date is what `termsFor` returns;
 *  - a buyer manual is approved as one batch, not forty;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import '@/modules/buyers/register'
import {
  buyerRequirements,
  buyers,
  buyerTerms,
  leadActivities,
  leads,
} from '@/modules/buyers/schema'
import {
  convertLead,
  createLead,
  detectDuplicates,
  logActivity,
  quietLeads,
  setLeadStage,
  termsFor,
  upsertTerms,
} from '@/modules/buyers/service'
import { buyerIdByCode } from '@/modules/buyers/queries'
import type { RequestCtx } from '@/modules/core/ctx'
import { approve, propose } from '@/modules/core/pending-changes'
import { withTenantRead } from '@/modules/core/tenancy'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `buy-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['merchandiser'] }
const ownerCtx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['owner'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['merchandiser'] }

const POLICY = { quietAfterDays: 21, duplicateThreshold: 0.6 }

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'Buyer Co', slug: `buy-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Merch' })
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const reset = async () => {
  await db.delete(leadActivities).where(eq(leadActivities.companyId, COMPANY))
  await db.delete(leads).where(eq(leads.companyId, COMPANY))
  await db.delete(buyerRequirements).where(eq(buyerRequirements.companyId, COMPANY))
  await db.delete(buyerTerms).where(eq(buyerTerms.companyId, COMPANY))
  await db.delete(buyers).where(eq(buyers.companyId, COMPANY))
}

const newBuyer = async (over: Record<string, unknown> = {}) => {
  const [row] = await db
    .insert(buyers)
    .values({
      companyId: COMPANY,
      code: `B-${randomUUID().slice(0, 6)}`,
      name: 'H&M Hennes & Mauritz AB',
      normalizedName: 'h m hennes mauritz',
      normalizedDomain: 'hm.com',
      website: 'https://hm.com',
      createdBy: USER,
      ...over,
    })
    .returning({ id: buyers.id })
  return row!.id
}

describe('1.1 · duplicate detection', () => {
  it('finds the buyer somebody is about to re-create under a different spelling', async () => {
    await reset()
    const buyerId = await newBuyer()

    // What a merchandiser would actually type.
    const candidates = await detectDuplicates(ctx, { name: 'H and M Hennes Mauritz' }, POLICY)

    expect(candidates.map((c) => c.id)).toContain(buyerId)
    expect(candidates[0]!.similarity).toBeGreaterThanOrEqual(0.6)
  })

  it('a matching domain outranks a similar name', async () => {
    await reset()
    const sameDomain = await newBuyer({
      name: 'Totally Different Trading',
      normalizedName: 'totally different trading',
      normalizedDomain: 'hm.com',
    })
    await newBuyer({
      name: 'H&M Hennes & Mauritz',
      normalizedName: 'h m hennes mauritz',
      normalizedDomain: null,
      website: null,
    })

    const candidates = await detectDuplicates(
      ctx,
      { name: 'H and M Hennes Mauritz', website: 'www.hm.com/careers' },
      POLICY,
    )

    // The same website is the strongest signal there is — two companies sharing one are
    // the same company.
    expect(candidates[0]!.id).toBe(sameDomain)
    expect(candidates[0]!.domainMatch).toBe(true)
  })

  it('returns nothing for a genuinely unrelated name', async () => {
    await reset()
    await newBuyer()

    const candidates = await detectDuplicates(ctx, { name: 'Kandagawa Textiles' }, POLICY)
    expect(candidates).toHaveLength(0)
  })

it('matches the lead being converted against ITSELF, which the desk has to filter', async () => {
    /*
     * Plan 5.2. `findConversionDuplicates` drops the lead it was asked about, and this is
     * why: trigram similarity of a name against itself is 1.0, so without the filter the
     * conversion dialog would open on every single lead saying "1 record looks like this
     * company" and point at the lead being converted. A warning that always fires is a
     * warning nobody reads, and the one time it means something is the time it is ignored.
     */
    await reset()
    const { leadId } = await createLead(ctx, {
      source: 'fair',
      companyName: 'Padma Knitwear Limited',
      website: 'padmaknit.com.bd',
    })

    const candidates = await detectDuplicates(
      ctx,
      { name: 'Padma Knitwear Limited', website: 'padmaknit.com.bd' },
      POLICY,
    )

    expect(candidates.some((c) => c.id === leadId)).toBe(true)
    expect(candidates.filter((c) => c.id !== leadId)).toEqual([])
  })

  it('does not offer a lead that has already become a buyer', async () => {
    await reset()
    const { leadId } = await createLead(ctx, {
      source: 'fair',
      companyName: 'H&M Hennes & Mauritz AB',
      website: 'hm.com',
    })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })
    await setLeadStage(ctx, { leadId, stage: 'negotiation' })
    await convertLead(ctx, { leadId, code: `B-${randomUUID().slice(0, 6)}` })

    const candidates = await detectDuplicates(ctx, { name: 'H and M Hennes Mauritz' }, POLICY)

    // The buyer, not the lead. Showing both would be two candidates for one company.
    expect(candidates.filter((c) => c.kind === 'lead')).toHaveLength(0)
    expect(candidates.filter((c) => c.kind === 'buyer')).toHaveLength(1)
  })
})

describe('1.1 · the lead pipeline', () => {
  it('converts a lead into a buyer and closes it as won', async () => {
    await reset()
    const { leadId } = await createLead(ctx, {
      source: 'referral',
      companyName: 'Fabrica Apparels Ltd.',
      website: 'fabrica.com.bd',
    })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })
    await setLeadStage(ctx, { leadId, stage: 'negotiation' })

    const result = await convertLead(ctx, { leadId, code: 'FAB' })
    expect(result.created).toBe(true)

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId))
    expect(lead!.stage).toBe('won')
    expect(lead!.convertedBuyerId).toBe(result.buyerId)

    // The normalisation carried across, so the new buyer is findable by the same search
    // that would have found the lead.
    const [buyer] = await db.select().from(buyers).where(eq(buyers.id, result.buyerId))
    expect(buyer!.normalizedName).toBe('fabrica apparels')
    expect(buyer!.normalizedDomain).toBe('fabrica.com.bd')
  })

  it('conversion is idempotent — a second call returns the same buyer', async () => {
    await reset()
    const { leadId } = await createLead(ctx, { source: 'inbound', companyName: 'Next Retail Inc.' })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })
    await setLeadStage(ctx, { leadId, stage: 'negotiation' })

    const first = await convertLead(ctx, { leadId, code: 'NEXT' })
    const second = await convertLead(ctx, { leadId, code: 'NEXT-2' })

    expect(second.created).toBe(false)
    expect(second.buyerId).toBe(first.buyerId)

    // Two buyers for one company splits the order history and every scorecard on it.
    const rows = await db.select().from(buyers).where(eq(buyers.companyId, COMPANY))
    expect(rows).toHaveLength(1)
  })

  it('a lost lead can be reopened, because buyers come back', async () => {
    await reset()
    const { leadId } = await createLead(ctx, { source: 'fair', companyName: 'Seasonal Buyer' })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })
    await setLeadStage(ctx, { leadId, stage: 'lost', lostReason: 'price' })

    // Next season's enquiry, on the same lead, keeping the history.
    await setLeadStage(ctx, { leadId, stage: 'contacted' })

    const [lead] = await db.select().from(leads).where(eq(leads.id, leadId))
    expect(lead!.stage).toBe('contacted')
    expect(lead!.lostReason).toBe('price')
  })

  it('refuses to lose a lead without a reason', async () => {
    await reset()
    const { leadId } = await createLead(ctx, { source: 'fair', companyName: 'Anon' })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })

    await expect(setLeadStage(ctx, { leadId, stage: 'lost' })).rejects.toThrow(
      /lost_needs_reason/,
    )
  })

  it('refuses to convert a lost lead directly', async () => {
    await reset()
    const { leadId } = await createLead(ctx, { source: 'fair', companyName: 'Gone Away' })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })
    await setLeadStage(ctx, { leadId, stage: 'lost', lostReason: 'capacity' })

    await expect(convertLead(ctx, { leadId, code: 'GONE' })).rejects.toThrow(/lead_is_lost/)
  })

  it('quiet means un-CONTACTED, not un-edited', async () => {
    await reset()
    const { leadId } = await createLead(ctx, { source: 'fair', companyName: 'Silent Co' })

    // An old conversation, then a record edit today. The edit is not contact.
    await logActivity(ctx, {
      leadId,
      kind: 'call',
      summary: 'Discussed capacity',
      occurredAt: '2026-06-01',
    })
    await db.update(leads).set({ notes: 'touched today' }).where(eq(leads.id, leadId))

    const quiet = await quietLeads(ctx, { today: '2026-07-30' }, POLICY)
    expect(quiet).toHaveLength(1)
    expect(quiet[0]!.days).toBe(59)
  })

  it('goes quiet from creation when nobody has ever called', async () => {
    await reset()
    await createLead(ctx, { source: 'fair', companyName: 'Never Called' })

    // Created today, so not yet quiet at a 21-day threshold.
    const today = new Date().toISOString().slice(0, 10)
    expect(await quietLeads(ctx, { today }, POLICY)).toHaveLength(0)
  })

  it('a won or lost lead is not waiting on anybody', async () => {
    await reset()
    const { leadId } = await createLead(ctx, { source: 'fair', companyName: 'Closed Co' })
    await setLeadStage(ctx, { leadId, stage: 'contacted' })
    await setLeadStage(ctx, { leadId, stage: 'lost', lostReason: 'compliance' })

    expect(await quietLeads(ctx, { today: '2099-01-01' }, POLICY)).toHaveLength(0)
  })
})

describe('1.1 · terms ⚖', () => {
  const terms = (buyerId: string, over: Record<string, unknown> = {}) =>
    upsertTerms(ctx, {
      buyerId,
      validFrom: '2026-01-01',
      payment: 'lc',
      incoterm: 'FOB',
      tolerancePct: '5',
      aqlLevel: '2.5',
      ...over,
    })

  it('versions rather than editing', async () => {
    await reset()
    const buyerId = await newBuyer()

    const first = await terms(buyerId)
    const second = await terms(buyerId, {
      validFrom: '2026-07-01',
      tolerancePct: '0',
      aqlLevel: '1.5',
    })

    expect(first.version).toBe(1)
    expect(second.version).toBe(2)

    const rows = await db.select().from(buyerTerms).where(eq(buyerTerms.buyerId, buyerId))
    expect(rows).toHaveLength(2)
  })

  it('returns the version in force on the ORDER’s date, not the newest', async () => {
    await reset()
    const buyerId = await newBuyer()
    await terms(buyerId)
    await terms(buyerId, { validFrom: '2026-07-01', tolerancePct: '0', aqlLevel: '1.5' })

    // An order taken in March is governed by January's terms. Reading the newest row would
    // judge already-shipped goods against a standard the buyer had not yet agreed to.
    const march = await termsFor(ctx, { buyerId, onDate: '2026-03-15' })
    expect(march!.aqlLevel).toBe('2.5')
    expect(march!.tolerancePct).toBe('5.00')

    const august = await termsFor(ctx, { buyerId, onDate: '2026-08-15' })
    expect(august!.aqlLevel).toBe('1.5')
  })

  it('has no terms before the first version, rather than inventing one', async () => {
    await reset()
    const buyerId = await newBuyer()
    await terms(buyerId)

    expect(await termsFor(ctx, { buyerId, onDate: '2025-06-01' })).toBeNull()
  })

  it('refuses to backdate a version behind the newest', async () => {
    await reset()
    const buyerId = await newBuyer()
    await terms(buyerId, { validFrom: '2026-07-01' })

    // Backdating would silently change which terms governed orders taken in between.
    await expect(terms(buyerId, { validFrom: '2026-01-01' })).rejects.toThrow(/backdated/)
  })

  it('refuses two versions starting on the same day', async () => {
    await reset()
    const buyerId = await newBuyer()
    await terms(buyerId, { validFrom: '2026-07-01' })

    await expect(terms(buyerId, { validFrom: '2026-07-01' })).rejects.toThrow()
  })
})

describe('1.1 · a buyer manual is one batch', () => {
  it('approves forty requirements as a single decision', async () => {
    await reset()
    const buyerId = await newBuyer()

    const { id } = await propose(ctx, {
      moduleId: 'buyers',
      targetTable: 'buyer_requirements',
      operation: 'insert',
      payload: {
        buyerId,
        requirements: [
          { category: 'packing', text: 'Polybag with suffocation warning', sourcePage: 12 },
          { category: 'labelling', text: 'Care label in EN/FR/DE', sourcePage: 18 },
          { category: 'testing', text: 'AZO dye test per shipment', sourcePage: 44 },
        ],
      },
      zodSchemaKey: 'buyer_requirements',
      source: 'ai_extraction',
      fieldConfidence: { packing: 0.94, labelling: 0.91, testing: 0.88 },
    })

    const result = await approve(ownerCtx, { pendingChangeId: id })
    expect(result.status).toBe('committed')

    const rows = await db
      .select()
      .from(buyerRequirements)
      .where(eq(buyerRequirements.buyerId, buyerId))

    // Three rows from ONE approval. Forty separate approvals is a queue nobody clears.
    expect(rows).toHaveLength(3)
    // The page travels with each, so a disputed requirement can be checked against the PDF.
    expect(rows.map((r) => r.sourcePage).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([12, 18, 44])
  })

  it('refuses an empty extraction', async () => {
    await reset()
    const buyerId = await newBuyer()

    await expect(
      propose(ctx, {
        moduleId: 'buyers',
        targetTable: 'buyer_requirements',
        operation: 'insert',
        payload: { buyerId, requirements: [] },
        zodSchemaKey: 'buyer_requirements',
        source: 'ai_extraction',
        fieldConfidence: { x: 0.9 },
      }),
    ).rejects.toThrow()
  })
})

describe('1.1 · tenancy', () => {
  it('another company sees no leads, buyers or terms', async () => {
    await reset()
    const buyerId = await newBuyer()
    await upsertTerms(ctx, {
      buyerId,
      validFrom: '2026-01-01',
      payment: 'lc',
      incoterm: 'FOB',
      tolerancePct: '5',
      aqlLevel: '2.5',
    })
    await createLead(ctx, { source: 'fair', companyName: 'Private Lead' })

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      leads: await tx.select().from(leads),
      buyers: await tx.select().from(buyers),
      terms: await tx.select().from(buyerTerms),
    }))

    expect(seen.leads).toHaveLength(0)
    expect(seen.buyers).toHaveLength(0)
    expect(seen.terms).toHaveLength(0)
  })

  it('duplicate detection does not leak another company’s buyers', async () => {
    await reset()
    await newBuyer()

    // The single most sensitive read in this module: a competitor's buyer list.
    const candidates = await detectDuplicates(
      otherCtx,
      { name: 'H and M Hennes Mauritz', website: 'hm.com' },
      POLICY,
    )
    expect(candidates).toHaveLength(0)
  })

  it('another company cannot version this factory’s terms', async () => {
    await reset()
    const buyerId = await newBuyer()

    await expect(
      upsertTerms(otherCtx, {
        buyerId,
        validFrom: '2026-02-01',
        payment: 'tt',
        incoterm: 'CIF',
        tolerancePct: '10',
        aqlLevel: '4.0',
      }),
    ).rejects.toThrow(/buyer_not_found/)
  })
})

/**
 * The code a person can see, resolved to the id everything joins on.
 *
 * `B-04501` is printed on the buyer row, said out loud, and written on the buyer's own
 * paperwork. The uuid beside it appears in no screen, no document and no export — and it was
 * the only thing MARBIM's buyer tools would accept, so the copilot could not answer a
 * question about the code sitting in the table next to it.
 */
describe('1.1 · a buyer answers to its code', () => {
  it('resolves the code exactly, whatever case it is typed in', async () => {
    await reset()
    const id = await newBuyer({ code: 'B-04501' })

    await expect(buyerIdByCode(ctx, 'B-04501')).resolves.toBe(id)
    // Read off paper and typed back by hand; `b-04501` is not a different buyer.
    await expect(buyerIdByCode(ctx, 'b-04501')).resolves.toBe(id)
  })

  it('answers nothing for a code this company does not have', async () => {
    await reset()
    await newBuyer({ code: 'B-04501' })

    // NOT the nearest row. A tool acts on this answer immediately, and "did you mean
    // B-04502" is how a shipment ends up against the wrong buyer.
    await expect(buyerIdByCode(ctx, 'B-04502')).resolves.toBeNull()
  })

  it('does not reach across companies', async () => {
    await reset()
    await newBuyer({ code: 'B-04501' })

    const stranger: RequestCtx = { companyId: randomUUID(), userId: USER, roles: ['merchandiser'] }
    // A code is unique WITHIN a company — two factories may both have a B-04501.
    await expect(buyerIdByCode(stranger, 'B-04501')).resolves.toBeNull()
  })
})
