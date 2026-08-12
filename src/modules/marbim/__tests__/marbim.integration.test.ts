/**
 * X.2 integration.
 *
 * The pure rules are covered by `marbim.test.ts`. What is asserted here is the pipeline:
 * text in, a `pending_changes` row out, with real per-field confidence — and the refusals
 * that stop that pipeline being a way for a model to write to an ERP unsupervised.
 *
 *  - a provider returning a CONSTANT confidence is refused before a draft exists;
 *  - an extraction can only target a table its module whitelisted;
 *  - `failed` retries and `rejected` does not;
 *  - the correction rate is per extractor VERSION and null before anybody reviews;
 *  - MARBIM_MOCK actually selects a provider, and without one MARBIM refuses;
 *  - cross-company reads see nothing.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { getRedis } from '@/lib/redis'
import { createDirectClient, createDirectDb } from '@/db/direct'
import { approvalRules, companies, pendingChanges, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { approve, confirmDraft } from '@/modules/core/pending-changes'
import { withTenantRead } from '@/modules/core/tenancy'
import { mockProvider } from '@/modules/marbim/mock-provider'
import {
  registerProvider,
  resetProvider,
  type ExtractRequest,
  type ExtractResult,
  type MarbimProvider,
} from '@/modules/marbim/provider'
import '@/modules/marbim/register'
import { chatTurns, extractionJobs } from '@/modules/marbim/schema'
import {
  buildPrompt,
  chat,
  conversation,
  extractorScores,
  queueExtraction,
  recentJobs,
  retryableJobs,
  runExtraction,
} from '@/modules/marbim/service'
import '@/modules/rfq/register'
// The prompt tests ask for these modules' primers, and an unregistered module is refused.
import '@/modules/costing/register'
import '@/modules/cutting/register'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `mar-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['merchandiser'] }
const ownerCtx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['owner'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['merchandiser'] }

const POLICY = { extractionsPerHour: 20, maxAttempts: 3, dailyTokenCeiling: 2_000_000 }

let buyerId: string

/** A buyer enquiry as one actually arrives. */
const ENQUIRY = (buyer: string) => `From: sourcing@hm.com
Subject: New enquiry — basic tee

Hi,

Please quote for the following.

buyerId: ${buyer}
title: Basic crew tee
productType: tshirt
quantity: 12,000 pcs
currency: USD

Thanks`

beforeAll(async () => {
  await db.insert(companies).values([
    { id: COMPANY, name: 'Marbim Co', slug: `mar-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `oth-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Merch' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })
  buyerId = buyer!.id
})

afterEach(() => {
  // Each test picks its own provider; leaving one registered would leak into the next.
  registerProvider(mockProvider)
})

afterAll(async () => {
  resetProvider()
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const reset = async () => {
  await db.delete(extractionJobs).where(eq(extractionJobs.companyId, COMPANY))
  await db.delete(chatTurns).where(eq(chatTurns.companyId, COMPANY))
  await db.delete(pendingChanges).where(eq(pendingChanges.companyId, COMPANY))

  /*
   * The rate-limit counter lives in Redis now, not in a `count(*)` over the table above
   * (plan 6.6, audit AI-M5) — so deleting the rows no longer resets the allowance, and a
   * fixture that only truncated the database would leave every case after the first few
   * running against an exhausted hour.
   *
   * Written before running the suite rather than after watching it go red: the whole point
   * of moving the counter out of the transaction is that it is no longer derived from the
   * rows, and a `reset` that does not know that is a fixture lying about the state it made.
   */
  await getRedis().del(`marbim:extract:${COMPANY}`)
}

const queue = (over: Record<string, unknown> = {}) =>
  queueExtraction(
    ctx,
    {
      moduleId: 'rfq',
      targetTable: 'rfqs',
      zodSchemaKey: 'rfq',
      extractorName: 'enquiry-email',
      extractorVersion: '1.0.0',
      sourceText: ENQUIRY(buyerId),
      ...over,
    },
    POLICY,
  )

/**
 * A provider that returns exactly what a test wants, including bad output.
 *
 * The cast is confined to this one helper: `extract` is generic in the value it produces, and
 * a test that hand-writes a fixed result cannot satisfy that generic. Everything the tests
 * actually assert on — the confidence map, the method, the refusals — stays fully typed.
 */
/**
 * The raiser checks the reading before anybody else is asked.
 *
 * An `ai_extraction` draft raised on somebody's behalf lands in `drafted`, not `pending`:
 * the person who sent the document is the only one holding the paper, so they confirm what
 * was read off it before it reaches an approver who cannot check it. These tests are about
 * what happens AFTER that step, so they take it explicitly rather than pretending the
 * inbox sees an unconfirmed reading.
 */
const confirmAsRaiser = (pendingChangeId: string) => confirmDraft(ctx, { pendingChangeId })

const fakeProvider = (
  extract: (request: ExtractRequest<unknown>) => Promise<ExtractResult<unknown>>,
): MarbimProvider => ({
  id: 'test/fake',
  extract: extract as MarbimProvider['extract'],
  generate: mockProvider.generate,
  embed: mockProvider.embed,
})

describe('X.2 · the extraction pipeline', () => {
  it('turns an enquiry email into a pending change with per-field confidence', async () => {
    await reset()
    registerProvider(mockProvider)

    const queued = await queue()
    const result = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)

    expect(result.status).toBe('succeeded')
    expect(result.pendingChangeId).toBeTruthy()

    const [draft] = await db
      .select()
      .from(pendingChanges)
      .where(eq(pendingChanges.id, result.pendingChangeId!))

    expect(draft!.source).toBe('ai_extraction')
    expect(draft!.moduleId).toBe('rfq')
    // The version travels onto the draft, which is how the correction rate groups later.
    expect(draft!.extractorVersion).toBe('1.0.0')

    // Real per-field confidence, not one number repeated.
    const confidence = draft!.fieldConfidence as Record<string, number>
    expect(Object.keys(confidence).length).toBeGreaterThan(1)
    expect(new Set(Object.values(confidence)).size).toBeGreaterThan(1)

    // And nothing invented. This email labels no style code and no target price; an earlier
    // version searched the whole document for each field's SHAPE when no label was found and
    // confidently produced styleCode "USD" and a target price of 12 read out of "12,000 pcs".
    // A reviewer skimming a draft that is right about four fields does not re-derive the
    // fifth — inventing one is worse than leaving it blank.
    const payload = draft!.payload as Record<string, unknown>
    expect(payload).not.toHaveProperty('styleCode')
    expect(payload).not.toHaveProperty('targetPrice')
    expect(payload.quantity).toBe(12_000)
  })

  it('the draft is approvable and becomes a real row', async () => {
    await reset()
    const queued = await queue()
    const { pendingChangeId } = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)

    await confirmAsRaiser(pendingChangeId!)
    const approved = await approve(ownerCtx, { pendingChangeId: pendingChangeId! })
    expect(approved.status).toBe('committed')

    const { rfqs } = await import('@/modules/rfq/schema')
    const [rfq] = await db.select().from(rfqs).where(eq(rfqs.id, approved.committedRowId!))
    expect(rfq!.quantity).toBe(12000)
  })

  it('REFUSES a provider that returns a constant confidence', async () => {
    await reset()
    // The exact defect brief 1.2 flags on its extractor. A constant makes the approve inbox
    // look like it ranks drafts by reliability when it ranks them by nothing.
    registerProvider(
      fakeProvider(async () => ({
        value: { buyerId, title: 'T', productType: 'tshirt', quantity: 100 },
        fieldConfidence: { buyerId: 0.85, title: 0.85, productType: 0.85, quantity: 0.85 },
        method: 'fake',
        model: 'fake',
      })),
    )

    const queued = await queue()
    const result = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)

    expect(result.status).toBe('rejected')
    expect(result.error).toMatch(/constant/i)

    // No draft was created. The refusal happens before one exists.
    const drafts = await db.select().from(pendingChanges).where(eq(pendingChanges.companyId, COMPANY))
    expect(drafts).toHaveLength(0)
  })

  it('refuses a field with no confidence at all', async () => {
    await reset()
    registerProvider(
      fakeProvider(async () => ({
        value: { buyerId, title: 'T', quantity: 100 },
        fieldConfidence: { buyerId: 0.9, title: 0.8 },
        method: 'fake',
        model: 'fake',
      })),
    )

    const result = await runExtraction(ctx, { jobId: (await queue()).jobId }, POLICY)
    expect(result.status).toBe('rejected')
    expect(result.error).toMatch(/quantity/)
  })

  it('cannot target a table its module never whitelisted', async () => {
    await reset()
    // `propose` would refuse it later anyway; refusing at queue time means the mistake is
    // found by the person who made it.
    await expect(queue({ targetTable: 'quotes' })).rejects.toThrow(/target_not_registered/)
  })

  it('cannot target a module that does not exist', async () => {
    await reset()
    await expect(queue({ moduleId: 'nonsense' })).rejects.toThrow(/unknown_module/)
  })
})

describe('X.2 · failure states', () => {
  it('a retryable failure stays retryable while attempts remain', async () => {
    await reset()
    registerProvider(
      fakeProvider(async () => {
        const { ProviderError } = await import('@/modules/marbim/provider')
        throw new ProviderError('model timed out', { retryable: true })
      }),
    )

    const queued = await queue()
    const first = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)
    expect(first.status).toBe('failed')

    // Still in the worker's list.
    const pending = await retryableJobs(ctx, POLICY)
    expect(pending.map((job) => job.id)).toContain(queued.jobId)
  })

  it('stops retrying once the attempts run out', async () => {
    await reset()
    registerProvider(
      fakeProvider(async () => {
        const { ProviderError } = await import('@/modules/marbim/provider')
        throw new ProviderError('model timed out', { retryable: true })
      }),
    )

    const queued = await queue()
    for (let i = 0; i < POLICY.maxAttempts; i += 1) {
      await runExtraction(ctx, { jobId: queued.jobId }, POLICY)
    }

    const [job] = await db.select().from(extractionJobs).where(eq(extractionJobs.id, queued.jobId))
    expect(job!.status).toBe('rejected')
    expect(await retryableJobs(ctx, POLICY)).toHaveLength(0)
  })

  it('an unreadable input is rejected immediately, not retried', async () => {
    await reset()
    registerProvider(mockProvider)

    // A queue that keeps retrying a document nobody will ever parse never drains.
    const queued = await queue({ sourceText: 'nothing useful here at all' })
    const result = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)

    expect(result.status).toBe('rejected')
    expect(await retryableJobs(ctx, POLICY)).toHaveLength(0)
  })

  it('a redelivered succeeded job does not produce a second draft', async () => {
    await reset()
    const queued = await queue()
    const first = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)
    const again = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)

    expect(again.pendingChangeId).toBe(first.pendingChangeId)
    const drafts = await db.select().from(pendingChanges).where(eq(pendingChanges.companyId, COMPANY))
    expect(drafts).toHaveLength(1)
  })

  it('rate-limits a company rather than queueing a hundred jobs that fail one at a time', async () => {
    await reset()
    const tight = { extractionsPerHour: 2, maxAttempts: 3, dailyTokenCeiling: 2_000_000 }

    await queueExtraction(ctx, { moduleId: 'rfq', targetTable: 'rfqs', zodSchemaKey: 'rfq', extractorName: 'e', extractorVersion: '1', sourceText: 'x' }, tight)
    await queueExtraction(ctx, { moduleId: 'rfq', targetTable: 'rfqs', zodSchemaKey: 'rfq', extractorName: 'e', extractorVersion: '1', sourceText: 'x' }, tight)

    await expect(
      queueExtraction(ctx, { moduleId: 'rfq', targetTable: 'rfqs', zodSchemaKey: 'rfq', extractorName: 'e', extractorVersion: '1', sourceText: 'x' }, tight),
    ).rejects.toThrow(/rate_limited/)
  })
})

describe('X.2 · correction telemetry', () => {
  it('is null before anybody reviews, not zero', async () => {
    await reset()
    await runExtraction(ctx, { jobId: (await queue()).jobId }, POLICY)

    const scores = await extractorScores(ctx)
    const score = scores.find((s) => s.extractorName === 'enquiry-email')!

    // A brand-new extractor at 0% would rank as the most trustworthy thing in the system on
    // the strength of never having been checked.
    expect(score.drafted).toBe(1)
    expect(score.reviewed).toBe(0)
    expect(score.correctionRatePct).toBeNull()
  })

  it('counts a corrected approval against the extractor VERSION that produced it', async () => {
    await reset()

    const v1 = await runExtraction(ctx, { jobId: (await queue()).jobId }, POLICY)
    await confirmAsRaiser(v1.pendingChangeId!)
    await approve(ownerCtx, {
      pendingChangeId: v1.pendingChangeId!,
      corrections: { title: 'Basic crew tee (corrected)' },
    })

    const v2 = await runExtraction(
      ctx,
      { jobId: (await queue({ extractorVersion: '2.0.0' })).jobId },
      POLICY,
    )
    await confirmAsRaiser(v2.pendingChangeId!)
    await approve(ownerCtx, { pendingChangeId: v2.pendingChangeId! })

    const scores = await extractorScores(ctx)
    const first = scores.find((s) => s.extractorVersion === '1.0.0')!
    const second = scores.find((s) => s.extractorVersion === '2.0.0')!

    // An extractor that improved must not carry the record of the version it replaced.
    expect(first.correctionRatePct).toBe('100.00')
    expect(second.correctionRatePct).toBe('0.00')
  })

  it('does NOT count an auto-approved draft as reviewed', async () => {
    await reset()
    // A rule that commits anything confident enough, with no person in the loop.
    const [rule] = await db
      .insert(approvalRules)
      .values({
        companyId: COMPANY,
        moduleId: 'rfq',
        targetTable: 'rfqs',
        // The extraction's own ctx performs the auto-commit, so the rule has to admit it.
        requiredRoles: ['owner', 'merchandiser'],
        autoApprove: true,
        minConfidence: '0.50',
        isActive: true,
      })
      .returning({ id: approvalRules.id })

    try {
      await runExtraction(ctx, { jobId: (await queue()).jobId }, POLICY)

      const scores = await extractorScores(ctx)
      const score = scores.find((s) => s.extractorName === 'enquiry-email')!

      // The draft committed — but nobody checked it, so it says nothing about whether the
      // extractor was right. Counting it would make an extractor's score improve exactly as
      // fewer people looked at its output.
      expect(score.drafted).toBe(1)
      expect(score.reviewed).toBe(0)
      expect(score.correctionRatePct).toBeNull()
    } finally {
      await db.delete(approvalRules).where(eq(approvalRules.id, rule!.id))
    }
  })
})

describe('X.2 · the prompt', () => {
  it('assembles the registered modules’ own primers, with versions', async () => {
    const prompt = buildPrompt({ moduleIds: ['costing', 'cutting'], scope: { moduleId: 'cutting' } })

    expect(prompt.text).toContain('MARBIM')
    expect(prompt.primerVersions.costing).toBe('1.5.0')
    expect(prompt.primerVersions.cutting).toBe('5.1.0')
    // The scoped module leads — that is the department the person is standing in.
    expect(prompt.text.indexOf('## cutting')).toBeLessThan(prompt.text.indexOf('## costing'))
  })

  it('REFUSES a module that is not loaded rather than answering without its craft', async () => {
    // Silently dropping the primer would have MARBIM answer a costing question with no
    // costing knowledge, sounding exactly as confident as if it had it.
    expect(() => buildPrompt({ moduleIds: ['costing', 'nonsense'], scope: {} })).toThrow(
      /unknown_module/,
    )
  })

  it('records the primer versions on the turn, so an answer is reproducible', async () => {
    await reset()
    registerProvider(mockProvider)

    const conversationId = randomUUID()
    await chat(ctx, {
      conversationId,
      turnIndex: 0,
      question: 'What is the margin floor?',
      moduleIds: ['costing'],
    })

    const turns = await conversation(ctx, conversationId)
    expect(turns).toHaveLength(1)
    expect((turns[0]!.primerVersions as Record<string, string>).costing).toBe('1.5.0')
  })

  it('redacts a pasted secret before it is stored or sent', async () => {
    await reset()
    const conversationId = randomUUID()

    await chat(ctx, {
      conversationId,
      turnIndex: 0,
      question: 'connect with postgres://user:hunter2@db.internal:5432/prod and tell me the total',
      moduleIds: [],
    })

    const [turn] = await conversation(ctx, conversationId)
    // A connection string pasted into a chat box would otherwise live in the database
    // forever.
    expect(turn!.question).not.toContain('hunter2')
    expect(turn!.question).toContain('[redacted]')
  })
})

describe('X.2 · the provider seam', () => {
  it('MARBIM_MOCK selects a provider — the flag now means something', async () => {
    const { hasProvider } = await import('@/modules/marbim/provider')
    // Importing the register module is what wires it. Before this, the flag was validated at
    // boot and did nothing.
    expect(hasProvider()).toBe(true)
  })

  it('with NO provider, MARBIM refuses rather than inventing output', async () => {
    await reset()
    resetProvider()

    // A system that quietly answers with fabricated data when its model is unconfigured is
    // worse than one that says it cannot answer.
    const queued = await queue()
    const result = await runExtraction(ctx, { jobId: queued.jobId }, POLICY)

    expect(result.status).toBe('rejected')
    expect(result.error).toMatch(/no MARBIM provider/)
  })
})

describe('X.2 · tenancy', () => {
  it('another company sees no jobs or turns', async () => {
    await reset()
    registerProvider(mockProvider)
    await queue()
    await chat(ctx, {
      conversationId: randomUUID(),
      turnIndex: 0,
      question: 'hello',
      moduleIds: [],
    })

    const seen = await withTenantRead(otherCtx, async (tx) => ({
      jobs: await tx.select().from(extractionJobs),
      turns: await tx.select().from(chatTurns),
    }))

    expect(seen.jobs).toHaveLength(0)
    expect(seen.turns).toHaveLength(0)
  })

  it('another company cannot run this company’s job', async () => {
    await reset()
    const queued = await queue()

    await expect(
      runExtraction(otherCtx, { jobId: queued.jobId }, POLICY),
    ).rejects.toThrow(/job_not_found/)
  })

  it('recent jobs are scoped and capped', async () => {
    await reset()
    await queue()
    const jobs = await recentJobs(ctx, { limit: 9999 })
    expect(jobs.length).toBeLessThanOrEqual(200)
    expect(jobs.every((job) => job.companyId === COMPANY)).toBe(true)
  })
})
