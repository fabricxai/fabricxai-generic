/**
 * X.2 MARBIM Platform — service layer.
 *
 * The module that lets a model write to an ERP. Everything it produces goes through
 * `pending_changes` (rule 3), so the job here is not "let the model do things" — it is to
 * make what the model proposed reviewable: with real per-field confidence, with the evidence
 * it read, with the extractor version that produced it, and with a prompt somebody can
 * reproduce.
 *
 * Extraction runs as a JOB, never in a request. The brief requires it, and the reason is
 * plain: a model call is seconds of latency with a real failure rate, and a merchandiser
 * uploading a tech pack should not be watching a spinner that might end in a 504.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'
import { z, type ZodType } from 'zod'

import { extractDocumentText } from '@/lib/document-text'
import { consume } from '@/lib/rate-limit'

import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { emit } from '../core/outbox'
import { propose } from '../core/pending-changes'
import { getModule, resolvePendingSchema } from '../core/registry'
import { withTenantRead, withTenantTx } from '../core/tenancy'

import { MARBIM_EVENTS } from './events'
import {
  assembleSystemPrompt,
  assertDraftProvenance,
  assertExtractionConfidence,
  MarbimError,
  redactForPrompt,
  type AssembledPrompt,
  type PrimerFragment,
  type PromptScope,
} from './marbim'
import {
  budgetedHistory,
  runToolCalls,
  MAX_TOOL_ITERATIONS,
  type ExecutedCall,
} from './loop'
import {
  getProvider,
  modelForRole,
  MODEL_READABLE_MIME,
  ProviderError,
  type ExtractFile,
  type MarbimProvider,
  type TextMessage,
} from './provider'
import { chatTurns, extractionJobs, marbimCallLog } from './schema'
import {
  collectTools,
  validateToolPack,
  type DraftTool,
  type ModuleTool,
  type ToolPack,
} from './tools'
import { extractionRequest } from './zod'

/** Company policy. Read from X.3 Settings by the caller, like every other module's. */
export interface MarbimPolicy {
  /** Extractions a company may start per hour. A model bill is a real cost. */
  extractionsPerHour: number
  /** Attempts before a retryable failure stops being retried. */
  maxAttempts: number
  /**
   * Tokens this company may spend across ALL roles in a rolling 24 hours (audit AI-H4).
   *
   * A ceiling and not a rate limit: the failure being prevented is not bursty traffic, it is
   * a month's software budget spent in an afternoon — by a loop that keeps asking for tools,
   * by two hundred POs uploaded at once, or by somebody discovering that a long paste gets a
   * long answer. Counted from `marbim_call_log`, which records what the vendor said it cost
   * rather than what we guessed.
   */
  dailyTokenCeiling: number
}

/**
 * How much conversation to carry forward, in characters (audit AI-H3).
 *
 * ~4 characters to a token, so this is roughly 3k tokens of transcript on top of a system
 * prompt that is already the bulk of the request. See `budgetedHistory` for why characters.
 */
const HISTORY_BUDGET_CHARS = 12_000

/**
 * What the extractor is told, beyond the schema.
 *
 * ## Why dates need saying out loud
 *
 * The schema demands `YYYY-MM-DD` and nothing ever told the model so. Every date field in
 * this system is a strict calendar date, and almost no document a factory receives writes
 * one: a SWIFT MT700 states `261118` for 18 November 2026, a Bangladeshi challan writes
 * `18/11/2026`, an audit report writes "06 Oct 2026". The model transcribed what the page
 * said — faithfully, which is what it is for — and zod refused the payload with
 * "expected YYYY-MM-DD", after the model call had been paid for.
 *
 * Converting a written date into the storage format is READING, not inventing, so it
 * belongs in the instruction rather than in a coercion step afterwards. And it must be the
 * model that does it, because only the model can see the rest of the page: `05/12/2026` is
 * two different dates depending on where the document came from, and the code holding the
 * result has no way to tell.
 *
 * ## And why it may refuse instead
 *
 * An ambiguous numeric date with nothing around it to settle it is left EMPTY. A missing
 * ex-factory date is visible to whoever approves the draft; a plausible wrong one is not,
 * and a date that is wrong by six months is the class of error that reaches a bank.
 *
 * ## What a target needs said about it that its schema cannot say.
 *
 * Field names and types are already in the schema; this is for the cases where a document's
 * shape and the schema's shape disagree, and the model has to be told which is which.
 *
 * The buyer-PO note exists because of a real, silent failure. A PO's quantity table has one
 * row per colour and size — ten rows for one garment — and `styles[]` was the only repeating
 * structure the schema offered. The extractor did the reasonable thing with what it had and
 * returned ten styles, all with the same style code, one size's quantity each. Nothing
 * refused it: the payload was valid, the confidence was high, and approving it would have
 * created an order with ten duplicate styles and no grid. A wrong answer no gate can catch
 * is the kind that has to be prevented at the instruction.
 */
const TARGET_NOTES: Record<string, readonly string[]> = {
  supplier_quotes: [
    'This is a PROFORMA INVOICE or quotation from a mill, trader or accessories supplier.',
    '',
    'ITEMS: `itemName` is the supplier\'s own description, word for word — "12 OZ STRETCH',
    'DENIM, 98PCT COTTON 2PCT SPANDEX, CUTTABLE WIDTH 58IN, INDIGO". Do not shorten it or',
    'translate it into a category: the screen matches it against this factory\'s list and',
    'shows what it matched, and a tidied description matches the wrong thing. An article',
    'or style number ("ART GR-1288S") goes in `itemCode`.',
    '',
    'PRICES: `unitPrice` is per unit, not the line total. "USD 3.35/YD" is 3.35. The total',
    'is a check, not a field — if the line says 23,500 YDS at USD 3.35 and totals 78,725,',
    'the unit price is 3.35.',
    '',
    'THE TERMS ARE IN THE PROSE, and they are what makes two quotes comparable:',
    '',
    '  · `leadTimeDays` — "SHIPMENT: WITHIN 25 DAYS AFTER RECEIPT OF WORKABLE L/C" is 25.',
    '    A calendar date instead of a number of days is not a lead time; leave it out.',
    '  · `priceTerm` — CFR, CIF, FOB, EXW, DDP, exactly as printed. This decides whether',
    '    freight is already in the price, and a buyer comparing an FOB quote with a CFR one',
    '    on unit price alone has compared nothing.',
    '  · `moq` — a stated minimum order quantity, when there is one.',
    '',
    'Do NOT invent freight or duty. If the paper does not state a figure, leave the field',
    'out — a zero is a claim that shipping is free, and it will be ranked as one.',
  ],
  grns: [
    'This is a DELIVERY CHALLAN — a supplier\'s note of what was sent, usually a phone',
    'photograph of a carbon-copy pad, often handwritten, sometimes at an angle.',
    '',
    'ITEMS: read what the paper calls the material into `itemName`, word for word. Do not',
    'translate it into a code, a category or a tidier name — the receiving screen matches',
    'it against this factory\'s own list and shows the storekeeper what it matched, and a',
    '"helpful" rewording is what makes that match silently wrong. If the challan ALSO',
    'prints a code, put that in `itemCode`; many do, shared with the supplier.',
    '',
    'QUANTITIES: the figure and its unit as printed — "10,600" and "KG". Bangladeshi',
    'challans write kg, yds, pcs, cone, dozen. Do not convert between them, ever.',
    '',
    'ROLLS: only when the challan itemises them individually, which fabric deliveries',
    'usually do and yarn or trims never do. A roll line has its own number and its own',
    'quantity; a lot or batch number often covers several rolls at once.',
    '',
    'Do NOT read: whether the goods are bonded, and any UD or bond-licence number that',
    'appears. Duty-free status is a customs position a storekeeper states deliberately,',
    'not a line to be transcribed off a delivery note.',
    '',
    'A challan number is whatever the pad prints — "Challan No", "CH", "DN", or just a',
    'number beside the date. If two numbers appear, the one the supplier calls their',
    'challan or delivery number is the one, not their invoice number.',
  ],
  lcs: [
    'DOCUMENTS REQUIRED (field 46A) is a numbered list written in bank prose, and',
    '`docsRequired` is a fixed vocabulary of seven kinds. Map each line onto ONE of:',
    '',
    '  commercial_invoice      — "signed commercial invoice", "invoice in triplicate"',
    '  packing_list            — "packing list", "weight list"',
    '  bl                      — "bill of lading", "ocean B/L", "full set clean on board"',
    '  certificate_of_origin   — "certificate of origin", "GSP Form A", "Form A"',
    '  beneficiary_certificate — "beneficiary certificate", "beneficiary declaration"',
    '  inspection_certificate  — "inspection certificate", named inspector (Intertek, SGS)',
    '  exp_form                — "EXP form", "EXP form copy"',
    '',
    'Return the kind, not the sentence: {"commercial_invoice": true, "bl": true}. A line',
    'that is none of the seven is left out entirely — do not invent a key for it. The',
    'quantities ("in triplicate") and the conditions ("made out to order of X") are not',
    'part of this field.',
    '',
    'The CREDIT NUMBER is field :20:, exactly as printed. It is often quoted again later',
    'under 47A ("all documents must quote LC no ..."); the two agree, and :20: is the one.',
    '',
    'The two dates that matter are 44C (latest shipment — goods ON the vessel) and 31D',
    '(expiry — documents AT the bank). They are different dates and both are needed.',
    'Do not fill the buyer: no SWIFT message carries this system\'s id for one.',
  ],
  orders: [
    'PO NUMBERS: capture EVERY reference the document gives, not just the one labelled',
    '"PO No". A buyer\'s order often carries two — the buyer\'s own number, and a supplier',
    'reference it asks to be quoted on invoices and shipping documents ("supplier ref to',
    'quote on docs", "please quote", "our ref"). Both go in `poNumbers`. The one the buyer',
    'asks to be quoted is what the bank matches the export documents against, so dropping',
    'it is how a set of documents gets refused at presentation for naming the wrong order.',
    '',
    'Every reference to THE ORDER, and nothing else. A style code, a tech-pack or BOM',
    'reference, an article or EAN number, the buyer\'s department code — these identify a',
    'GARMENT or a document, not the order, and they belong to their own fields or to no',
    'field at all. "Capture every reference" read too widely puts the style code in',
    '`poNumbers`, and the desk then shows an order that answers to a name nobody uses.',
    '',
    'A STYLE is one garment the buyer is buying — one style code, one description, one',
    'unit price. A purchase order usually has exactly one, occasionally two or three.',
    'The table of quantities per colour and size is NOT a list of styles: it is that one',
    'style\'s BREAKDOWN, and it goes in that style\'s `breakdown` array, one entry per cell.',
    '`contractedQty` is the TOTAL across the whole grid — the figure the PO calls the order',
    'quantity — not one row of it. If the document prints a total, use it; a grid that does',
    'not add up to the printed total is a real discrepancy and the approver needs to see',
    'both numbers, so do not silently correct either one.',
  ],
}

export function extractionInstruction(moduleId: string, targetTable: string): string {
  return [
    `Extract a ${targetTable} record for the ${moduleId} module.`,
    '',
    'Dates: every date field must be written YYYY-MM-DD, whatever the document does.',
    'Convert what the page states — "18/11/2026", "18 Nov 2026", and the six-digit SWIFT',
    'form "261118" are all 2026-11-18. Do not copy the document\'s formatting through.',
    'If a purely numeric date is ambiguous (05/12/2026 could be 5 December or 12 May) and',
    'nothing else on the page settles which, leave that field empty rather than choosing:',
    'a missing date is visible to the person approving this, and a wrong one is not.',
    ...(TARGET_NOTES[targetTable] ? ['', ...TARGET_NOTES[targetTable]] : []),
  ].join('\n')
}

/**
 * What to record on a failed job.
 *
 * An `AppError`'s `message` is only `kind: messageKey` — the thing that actually says WHY is
 * in `details.reason`. Storing just the key would leave whoever opens a rejected job reading
 * "validation_failed: marbim.errors.invalid", which tells them nothing they did not already
 * know from the status column.
 */
function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  if (error instanceof AppError && typeof error.details.reason === 'string') {
    return `${error.message} — ${error.details.reason}`
  }
  return error.message
}

function wrapMarbimError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof MarbimError) {
      throw new AppError('validation_failed', 'marbim.errors.invalid', { reason: error.message })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Prompt assembly
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gather the primers of every registered module.
 *
 * Read from the registry rather than a list here, so a module that ships a primer is
 * automatically part of MARBIM's knowledge and one that does not is automatically absent.
 * A hand-maintained list would drift the first time somebody added a module on a Friday.
 */
export function collectPrimers(moduleIds: readonly string[]): PrimerFragment[] {
  const primers: PrimerFragment[] = []

  for (const moduleId of moduleIds) {
    const definition = getModule(moduleId)

    if (!definition) {
      // Refused, not skipped. A module that is not loaded produces no primer, and silently
      // omitting it would have MARBIM answer a costing question without the costing craft
      // while looking exactly as confident as if it had it.
      throw new AppError('validation_failed', 'marbim.errors.unknown_module', { moduleId })
    }

    // Registered but with no primer is fine — not every module has craft to teach.
    if (!definition.domainPrimer) continue

    primers.push({
      moduleId,
      version: definition.domainPrimer.version,
      text: definition.domainPrimer.text,
    })
  }

  return primers
}

export function buildPrompt(input: {
  moduleIds: readonly string[]
  scope: PromptScope
}): AssembledPrompt {
  return wrapMarbimError(() =>
    assembleSystemPrompt({ primers: collectPrimers(input.moduleIds), scope: input.scope }),
  )
}

/**
 * A tool's argument schema, as JSON Schema, for the vendor to guide the model with.
 *
 * Guidance only. The tool's zod parses the args again before the executor sees them
 * (`runToolCalls`), because a model is an untrusted client that happens to be helpful and a
 * schema the vendor was *asked* to honour is not a schema anything enforced.
 *
 * Returns undefined rather than throwing on an exotic schema. A tool whose zod cannot be
 * expressed as JSON Schema should still be offered — the model gets a permissive object and
 * a description, and the validation that matters is unaffected.
 */
function toJsonSchema(tool: ModuleTool): unknown {
  try {
    return z.toJSONSchema(tool.input as never)
  } catch {
    return undefined
  }
}

/** Every tool in scope, validated against what each module actually registered. */
export function toolsInScope(packs: readonly ToolPack[]): ModuleTool[] {
  for (const pack of packs) {
    const definition = getModule(pack.moduleId)
    if (!definition) {
      throw new AppError('validation_failed', 'marbim.errors.unknown_module', {
        moduleId: pack.moduleId,
      })
    }
    validateToolPack(pack, { pendingTargets: definition.pendingTargets })
  }
  return collectTools(packs)
}

/**
 * Run a draft tool, and turn what it proposes into a pending change.
 *
 * `tools.ts` has described this function since the day the contract was written — twice, in
 * the comments explaining why a draft tool is safe — and it did not exist. So a draft tool
 * could be registered, validated and executed, and its proposal had nowhere to go: the two
 * halves of the safety argument were a type that forbade writing and a door that was never
 * built. Every draft tool was decoration.
 *
 * This is the only path from a tool to `pending_changes`, and it is deliberately narrow:
 *
 *  - the tool's own zod validates the arguments before its executor sees them;
 *  - `assertDraftProvenance` refuses a proposal that cannot say where its payload came from;
 *  - `propose` re-validates the payload against the module's registered schema and refuses
 *    a target the module never whitelisted.
 *
 * Nothing is committed, and nothing here is scored. A chat-composed draft has no extractor
 * behind it and therefore no per-field confidence (plan 6.3 — the eight modules that shipped
 * one had typed the numbers). It lands in the inbox reading "no confidence" on every field,
 * which is true, and `confidenceMin` of `null` means it can never clear an auto-approve
 * floor — so it always gets a human, which is what a machine-composed row deserves.
 */
export async function runDraftTool(
  ctx: RequestCtx,
  tool: DraftTool,
  args: unknown,
  input: { moduleId: string; sourceDocumentId?: string } ,
): Promise<{ pendingChangeId: string }> {
  const proposal = await tool.execute(ctx, tool.input.parse(args))

  if (proposal.targetTable !== tool.targetTable) {
    // The tool declared one target and proposed against another. `validateToolPack` checked
    // the DECLARED one against the module's whitelist, so letting the proposal name its own
    // would route around that check entirely.
    throw new AppError('validation_failed', 'marbim.errors.target_not_registered', {
      declared: tool.targetTable,
      proposed: proposal.targetTable,
    })
  }

  wrapMarbimError(() =>
    assertDraftProvenance({ payload: proposal.payload, method: proposal.method }),
  )

  const proposed = await propose(ctx, {
    moduleId: input.moduleId,
    targetTable: proposal.targetTable,
    ...(proposal.targetId === undefined ? {} : { targetId: proposal.targetId }),
    operation: proposal.operation,
    payload: proposal.payload,
    zodSchemaKey: proposal.zodSchemaKey,
    // No `fieldConfidence`, and `propose` now REFUSES one on this source. Nothing measured
    // anything: the payload is arguments a model wrote into a tool call.
    //
    // `ai_chat`, not `ai_extraction`: nothing was read off a document here, somebody asked
    // MARBIM a question. The inbox reads the two differently and should.
    source: 'ai_chat',
    ...(proposal.sourceDocumentId ? { sourceDocumentId: proposal.sourceDocumentId } : {}),
  })

  return { pendingChangeId: proposed.id }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extraction
// ─────────────────────────────────────────────────────────────────────────────

export interface QueuedExtraction {
  jobId: string
  status: 'queued'
}

/**
 * Queue an extraction (brief: "runs as BullMQ jobs, not in-request, with per-company rate
 * limits").
 *
 * The rate limit is checked here rather than in the worker so a caller finds out immediately
 * that they are over it, instead of queueing a hundred jobs that fail one at a time. A model
 * bill is a real cost and a runaway loop is a real way to incur one.
 */
export async function queueExtraction(
  ctx: RequestCtx,
  input: unknown,
  policy: MarbimPolicy,
): Promise<QueuedExtraction> {
  const payload = extractionRequest.parse(input)

  const definition = getModule(payload.moduleId)
  if (!definition) {
    throw new AppError('validation_failed', 'marbim.errors.unknown_module', {
      moduleId: payload.moduleId,
    })
  }
  if (!definition.pendingTargets.includes(payload.targetTable)) {
    // The registry whitelist, checked at queue time. `propose` would refuse it later
    // anyway; refusing now means the mistake is found by the person who made it.
    throw new AppError('validation_failed', 'marbim.errors.target_not_registered', {
      moduleId: payload.moduleId,
      targetTable: payload.targetTable,
    })
  }

  /*
   * The per-company hourly limit, in Redis (plan 6.6, audit AI-M5).
   *
   * It was `select count(*) from extraction_jobs where created_at > now() - 1 hour`, inside
   * the insert transaction, on every queue. Three problems, in ascending order of how much
   * they matter:
   *
   *  1. **It is a scan that grows with the table**, run on the path a person is waiting on.
   *  2. **It counts the wrong thing.** Rows, not attempts — so a company that queued sixty
   *     documents and deleted them has a fresh allowance, and one whose jobs all failed and
   *     retried is charged once for work the provider did five times.
   *  3. **It does not hold under concurrency.** Two simultaneous requests both read 59 and
   *     both insert. `READ COMMITTED` gives no protection here and the count is not a
   *     constraint, so the limit was advisory at exactly the moment it was being tested.
   *
   * `INCR` is atomic, so the third problem simply goes away. The counter is consumed BEFORE
   * the insert and deliberately not returned if the insert then fails: a refused document
   * still cost a check, and a limit that refunds itself on error is one a client can spin
   * against for free.
   *
   * `consume` fails OPEN when Redis is unreachable — the considered exception documented in
   * `lib/rate-limit.ts`. Here that means an unavailable Redis lets extractions through
   * uncounted, which is the right trade: the ceiling in 6.5 counts real token spend, so the
   * cost is bounded by something else anyway.
   */
  const limit = await consume(`marbim:extract:${ctx.companyId}`, {
    limit: policy.extractionsPerHour,
    windowSeconds: 3_600,
  })

  if (!limit.ok) {
    throw new AppError('rate_limited', 'marbim.errors.rate_limited', {
      limit: policy.extractionsPerHour,
      windowHours: 1,
      retryAfterSeconds: limit.resetSeconds,
    })
  }

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(extractionJobs)
      .values({
        companyId: ctx.companyId,
        moduleId: payload.moduleId,
        targetTable: payload.targetTable,
        zodSchemaKey: payload.zodSchemaKey,
        extractorName: payload.extractorName,
        extractorVersion: payload.extractorVersion,
        sourceDocumentId: payload.sourceDocumentId ?? null,
        // Redacted at the door, not at the model call: whatever is stored here is read by
        // people too.
        sourceText: payload.sourceText ? redactForPrompt(payload.sourceText) : null,
        contextValues: payload.contextValues ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: extractionJobs.id })

    if (!row) throw new Error('extraction_jobs insert returned nothing')

    // In the same transaction as the job, so a queued job and the event saying so cannot
    // disagree (rule 6). Declared since X.2 and emitted by nothing until 6.5.
    await emit(ctx, tx, {
      eventName: MARBIM_EVENTS.extractionQueued,
      payload: {
        jobId: row.id,
        moduleId: payload.moduleId,
        extractorName: payload.extractorName,
        requestedBy: ctx.userId,
      },
      aggregateTable: 'extraction_jobs',
      aggregateId: row.id,
    })

    return { jobId: row.id, status: 'queued' as const }
  })
}

export interface ExtractionOutcome {
  jobId: string
  status: 'succeeded' | 'failed' | 'rejected'
  pendingChangeId?: string
  error?: string
}

export interface ReadDocumentInput {
  moduleId: string
  targetTable: string
  /**
   * What the reading is parsed into, resolved by the CALLER.
   *
   * The queued path resolves it through `resolvePendingSchema`, which refuses a table the
   * module has not declared proposable — right, because that path proposes. The inline path
   * resolves it through `resolveReadSchema`, which asks only that the module named the
   * schema, because filling somebody's form is not a write and the proposable-target gate
   * has nothing to say about it. Passing the schema in is what keeps those two rules where
   * they belong instead of in here.
   */
  schema: ZodType
  sourceText?: string | undefined
  sourceDocumentId?: string | undefined
  /** Ids the person chose. Merged over the model's reading and scored 1. */
  contextValues?: Record<string, string> | undefined
  /** Whose spend this is, when it is not the calling ctx's own. */
  createdBy?: string | undefined
}

export interface ReadDocumentResult {
  payload: Record<string, unknown>
  fieldConfidence: Record<string, number>
  model: string
}

/**
 * A document, read into a checked payload — everything the extraction pipeline does except
 * decide what to do with the answer.
 *
 * Factored out of `runExtraction` so a second caller could exist. The queued path takes this
 * and proposes a pending change for somebody else to approve; the inline path (a person in a
 * dialog, holding the paper, about to press save themselves) takes the same result and fills
 * the form in front of them. One implementation, so the two cannot drift into reading the
 * same purchase order differently — which is the failure that would be hardest to notice and
 * worst to explain.
 *
 * Everything that makes a reading trustworthy stays here: the file conversion, the call
 * ledger the daily ceiling is computed from, the person's context outranking the model, and
 * `assertExtractionConfidence` refusing a uniform score.
 */
export async function readDocumentInto(
  ctx: AnyCtx,
  input: ReadDocumentInput,
): Promise<ReadDocumentResult> {
  const schema = input.schema
  let source = input.sourceText ?? ''

  /*
   * No text means the file IS the document (plan: file-native intake). The bytes are
   * fetched tenant-scoped at run time rather than stored on the job — the job row stays
   * small, and a document quarantined between queue and run is refused here exactly as
   * it would be for a person. When text exists it is what gets read, file or no file:
   * a human transcription was deliberate, and silently preferring the file would make
   * the paste box a decoration.
   */
  let file: ExtractFile | undefined
  if (!source.trim() && input.sourceDocumentId) {
    const { readDocumentBytes } = await import('@/modules/core/documents')
    const original = await readDocumentBytes(ctx, input.sourceDocumentId)

    if (MODEL_READABLE_MIME.has(original.mimeType)) {
      file = {
        base64: Buffer.from(original.bytes).toString('base64'),
        mimeType: original.mimeType,
        filename: original.filename,
      }
    } else {
      /*
       * A Word document or a spreadsheet — which the model cannot read, and which this
       * product accepted at upload and then did nothing with, in silence, until now.
       *
       * The text comes out here rather than at the door because the bytes are already
       * being fetched tenant-scoped at this point, and because a conversion that failed
       * during upload would have to be reported through a presign response that has no
       * room to say anything useful. Extracted text is ordinary source text from here on:
       * same extractor, same measured per-field confidence, same approve inbox.
       */
      const extracted = extractDocumentText(original.bytes, original.mimeType)
      if (extracted === null) {
        // `.doc` from 1997, a HEIC photo, a corrupt archive. Refused by name, so the
        // person is told to paste the text rather than left waiting for a draft.
        throw new AppError('validation_failed', 'marbim.errors.file_unreadable', {
          mimeType: original.mimeType,
          filename: original.filename,
        })
      }
      source = extracted
    }
  }

  /*
   * The extraction call, and the ledger entry it had never written.
   *
   * `marbim_call_log`'s own header says extraction lands here — "a factory that uploads
   * two hundred POs in an afternoon has spent real money, and the daily ceiling has to
   * see it, otherwise the budget only governs the cheapest of the three roles" — and
   * nothing wrote the row. Only the chat loop did. So the ceiling counted conversations
   * and ignored document reading entirely: the table held zero `extract` rows across
   * every tenant, while extractions ran and were billed.
   *
   * Logged either way. A call that failed after the vendor accepted it was still paid
   * for, and a ledger that only records successes drifts upward exactly as reliability
   * gets worse.
   */
  const extractStartedAt = Date.now()
  let result
  try {
    result = await getProvider().extract({
      role: 'extract',
      schema,
      input: source,
      instruction: extractionInstruction(input.moduleId, input.targetTable),
      ...(file ? { file } : {}),
    })
  } catch (error) {
    await logCall(ctx, {
      role: 'extract',
      // The call died before it could say which model answered. The configured one is
      // the honest guess, and 'unknown' is what the chat path records in the same spot.
      model: modelForRole('extract') ?? 'unknown',
      iteration: 0,
      durationMs: Date.now() - extractStartedAt,
      outcome: error instanceof Error ? error.message : String(error),
      createdBy: input.createdBy,
    })
    throw error
  }

  await logCall(ctx, {
    role: 'extract',
    model: result.model,
    iteration: 0,
    ...(result.usage ? { usage: result.usage } : {}),
    durationMs: Date.now() - extractStartedAt,
    outcome: 'ok',
    createdBy: input.createdBy,
  })

  /**
   * The person's fields, folded in over the extractor's.
   *
   * Context wins on a collision, and deliberately: if somebody picked the buyer from a
   * list of their own buyers and the model also read a name off the page, the person is
   * the one who knows which record it maps to.
   *
   * Scored 1.0 — not as flattery of the extraction, but because a chosen value carries no
   * reading risk. A reviewer looking at the draft sees the buyer at 1.0 and the quantity
   * at 0.62 and knows exactly where to look, which is the entire point of per-field
   * confidence. `assertExtractionConfidence` still refuses a payload that is uniform, so
   * a context-only draft cannot slip through wearing certainty it did not earn.
   */
  const context = input.contextValues ?? {}
  const payload = {
    ...(result.value as Record<string, unknown>),
    ...context,
    // The pipeline's own knowledge outranks the model's reading, same as the person's
    // context does. The model, offered a uuid field, fills it with whatever id-shaped
    // string the page has — the job KNOWS which document it is reading. Schemas without
    // the field are unaffected: propose stores the parsed payload, and parsing strips
    // keys a schema does not name.
    ...(input.sourceDocumentId ? { sourceDocumentId: input.sourceDocumentId } : {}),
  }
  const fieldConfidence = { ...result.fieldConfidence }
  for (const field of Object.keys(context)) fieldConfidence[field] = 1
  if (input.sourceDocumentId) fieldConfidence.sourceDocumentId = 1

  // The check the whole module exists for. A constant is refused before it becomes a
  // draft that looks reviewed.
  wrapMarbimError(() =>
    assertExtractionConfidence({
      payload,
      fieldConfidence,
      method: result.method,
      uniformConfidenceJustification: result.uniformConfidenceJustification,
    }),
  )
  return { payload, fieldConfidence, model: result.model }
}

/**
 * Run a queued extraction. Called by the worker, never in a request.
 *
 * The confidence check is the load-bearing line. A provider that returns a constant is
 * refused HERE, before the draft exists — which is why the mock provider produces genuinely
 * varying scores rather than a fixed number that would sail past it.
 *
 * `failed` and `rejected` are different on purpose. A timeout is retryable; a PDF this
 * extractor cannot read is not, and retrying it forever fills a queue with one document
 * nobody will ever parse.
 */
export async function runExtraction(
  ctx: AnyCtx,
  input: { jobId: string },
  policy: MarbimPolicy,
): Promise<ExtractionOutcome> {
  const job = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx.select().from(extractionJobs).where(eq(extractionJobs.id, input.jobId))
    return row
  })

  if (!job) throw notFound('marbim.errors.job_not_found', { jobId: input.jobId })
  if (job.status === 'succeeded') {
    // Already done. A redelivered job must not produce a second draft of the same document.
    return { jobId: job.id, status: 'succeeded', pendingChangeId: job.pendingChangeId ?? undefined }
  }
  if (job.status === 'rejected') {
    throw conflict('marbim.errors.job_rejected', { jobId: job.id })
  }

  await withTenantTx(ctx, async (tx) => {
    await tx
      .update(extractionJobs)
      .set({
        status: 'running',
        attempts: job.attempts + 1,
        startedAt: new Date(),
        // Cleared, not left behind. A retry of a failed job carries that attempt's
        // `finished_at` and error otherwise — the row would claim to be both running and
        // finished, which the table's own check constraint refuses outright.
        finishedAt: null,
        error: null,
        updatedAt: new Date(),
      })
      .where(eq(extractionJobs.id, job.id))
  })

  try {
    const { payload, fieldConfidence, model } = await readDocumentInto(ctx, {
      moduleId: job.moduleId,
      targetTable: job.targetTable,
      schema: resolvePendingSchema(job.moduleId, job.targetTable, job.zodSchemaKey),
      ...(job.sourceText ? { sourceText: job.sourceText } : {}),
      ...(job.sourceDocumentId ? { sourceDocumentId: job.sourceDocumentId } : {}),
      ...(job.contextValues ? { contextValues: job.contextValues } : {}),
      ...(job.createdBy ? { createdBy: job.createdBy } : {}),
    })

    const proposed = await propose(ctx, {
      moduleId: job.moduleId,
      targetTable: job.targetTable,
      operation: 'insert',
      payload,
      zodSchemaKey: job.zodSchemaKey,
      fieldConfidence,
      source: 'ai_extraction',
      sourceDocumentId: job.sourceDocumentId ?? undefined,
      extractorVersion: job.extractorVersion,
      model,
      // The draft belongs to whoever queued the reading, not to the worker that ran it.
      // Without this every AI draft was raised by nobody — see `onBehalfOf`.
      ...(job.createdBy ? { onBehalfOf: job.createdBy } : {}),
    })

    return await withTenantTx(ctx, async (tx) => {
      await tx
        .update(extractionJobs)
        .set({
          status: 'succeeded',
          pendingChangeId: proposed.id,
          model,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(extractionJobs.id, job.id))

      /*
       * The event, in the same transaction as the status (rule 6, audit AI-H5).
       *
       * `MARBIM_EVENTS` has been declared since X.2 and emitted by NOTHING, so the one job
       * that runs on a schedule and produces work for a person was the one job that told
       * nobody it had finished. Somebody who typed out a buyer's PO learned their draft was
       * ready by going back and looking.
       */
      await emit(ctx, tx, {
        eventName: MARBIM_EVENTS.extractionSucceeded,
        payload: {
          jobId: job.id,
          pendingChangeId: proposed.id,
          moduleId: job.moduleId,
          targetTable: job.targetTable,
          extractorName: job.extractorName,
          // Who to tell. The job carries it because the queueing action recorded it.
          requestedBy: job.createdBy,
        },
        aggregateTable: 'extraction_jobs',
        aggregateId: job.id,
      })

      return { jobId: job.id, status: 'succeeded' as const, pendingChangeId: proposed.id }
    })
  } catch (error) {
    // Retryable only while attempts remain. A provider timeout deserves another go; a
    // document this extractor cannot read does not, and neither does an attempt count that
    // has run out.
    //
    // One AppError IS retryable: `unknown_module`. That is the worker booting without the
    // module registry imported — a deployment fault, not a fault in the document. Treating
    // it as terminal would permanently reject every queued extraction on the first pass
    // after such a misconfiguration.
    const configFault =
      error instanceof AppError && error.messageKey.endsWith('unknown_module')
    const retryable =
      error instanceof ProviderError
        ? error.retryable
        : configFault || !(error instanceof AppError)
    const exhausted = job.attempts + 1 >= policy.maxAttempts
    const status = retryable && !exhausted ? ('failed' as const) : ('rejected' as const)

    await withTenantTx(ctx, async (tx) => {
      await tx
        .update(extractionJobs)
        .set({
          status,
          error: {
            message: describeFailure(error),
            retryable,
            attempts: job.attempts + 1,
          },
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(extractionJobs.id, job.id))

      // Two events, because they mean different things to whoever is listening: `failed` is
      // "this will be tried again", `rejected` is "this document is not going to be read,
      // enter it by hand". A consumer that could not tell them apart would either nag about
      // a transient timeout or stay silent about a dead job.
      await emit(ctx, tx, {
        eventName:
          status === 'failed'
            ? MARBIM_EVENTS.extractionFailed
            : MARBIM_EVENTS.extractionRejected,
        payload: {
          jobId: job.id,
          moduleId: job.moduleId,
          extractorName: job.extractorName,
          reason: describeFailure(error),
          attempts: job.attempts + 1,
          requestedBy: job.createdBy,
        },
        aggregateTable: 'extraction_jobs',
        aggregateId: job.id,
      })
    })

    return { jobId: job.id, status, error: describeFailure(error) }
  }
}

/** Jobs a worker should pick up: queued, or failed with attempts left. */
export async function retryableJobs(
  ctx: AnyCtx,
  policy: MarbimPolicy,
): Promise<(typeof extractionJobs.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(extractionJobs)
      .where(
        sql`(${extractionJobs.status} = 'queued')
            or (${extractionJobs.status} = 'failed' and ${extractionJobs.attempts} < ${policy.maxAttempts})`,
      )
      .orderBy(extractionJobs.createdAt),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Correction telemetry
// ─────────────────────────────────────────────────────────────────────────────

export interface ExtractorScore {
  extractorName: string
  extractorVersion: string
  drafted: number
  reviewed: number
  corrected: number
  /** Null when nothing has been reviewed. Never 0 — see below. */
  correctionRatePct: string | null
}

/**
 * How often an extractor's drafts get edited before approval (brief: "correction telemetry:
 * field-level edits on drafts logged → correction-rate per extractor version").
 *
 * Grouped by extractor AND version, which is the whole point: an extractor that improved
 * should not carry the correction rate of the version it replaced, and one that regressed
 * should not hide behind its predecessor's record.
 *
 * Null rather than zero when nothing has been reviewed. A brand-new extractor with a 0%
 * correction rate would rank as the most trustworthy thing in the system on the strength of
 * never having been checked.
 */
export async function extractorScores(ctx: AnyCtx): Promise<ExtractorScore[]> {
  const { pendingChanges } = await import('@/db/schema/core')

  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        extractorName: extractionJobs.extractorName,
        extractorVersion: extractionJobs.extractorVersion,
        status: pendingChanges.status,
        reviewedBy: pendingChanges.reviewedBy,
        corrections: pendingChanges.corrections,
      })
      .from(extractionJobs)
      .leftJoin(pendingChanges, eq(extractionJobs.pendingChangeId, pendingChanges.id))
      .where(eq(extractionJobs.status, 'succeeded'))

    const byExtractor = new Map<string, ExtractorScore>()

    for (const row of rows) {
      const key = `${row.extractorName}@${row.extractorVersion}`
      const entry = byExtractor.get(key) ?? {
        extractorName: row.extractorName,
        extractorVersion: row.extractorVersion,
        drafted: 0,
        reviewed: 0,
        corrected: 0,
        correctionRatePct: null,
      }

      entry.drafted += 1

      // Only a HUMAN review says anything about whether the extraction was right. An
      // auto-approved draft never met a reviewer.
      if (row.status && row.status !== 'pending' && row.reviewedBy) {
        entry.reviewed += 1
        if (row.corrections && Object.keys(row.corrections).length > 0) entry.corrected += 1
      }

      byExtractor.set(key, entry)
    }

    return [...byExtractor.values()]
      .map((entry) => ({
        ...entry,
        correctionRatePct:
          entry.reviewed === 0
            ? null
            : ((entry.corrected * 10000) / entry.reviewed / 100).toFixed(2),
      }))
      // Worst first — the extractor most in need of attention.
      .sort((a, b) => Number(b.correctionRatePct ?? -1) - Number(a.correctionRatePct ?? -1))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Chat
// ─────────────────────────────────────────────────────────────────────────────

export interface ChatResult {
  turnId: string
  answer: string
  /** Tools that RAN, with whether each worked. Since 6.5 these are executions, not requests. */
  toolCalls: ExecutedCall[]
  primerVersions: Record<string, string>
  /** Which provider answered, and how long it took — the surface prints both. */
  model: string
  durationMs: number
  /** Drafts this turn put in the approve inbox. Empty for a question that only read. */
  proposedChangeIds: string[]
  /** True when the iteration cap forced the final answer. The surface says so. */
  cappedAtIterationLimit: boolean
}

/**
 * Tokens this company has spent in the last 24 hours (audit AI-H4).
 *
 * Reads the log rather than a counter, because a counter would have to be maintained
 * transactionally with a call that has already been billed — and the failure mode of a drifting
 * counter is a ceiling that silently stops applying.
 */
export async function tokensSpentToday(ctx: AnyCtx, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - 86_400_000)

  const [row] = await withTenantRead(ctx, async (tx) =>
    tx
      .select({
        total: sql<string>`coalesce(sum(coalesce(${marbimCallLog.inputTokens}, 0) + coalesce(${marbimCallLog.outputTokens}, 0)), 0)`,
      })
      .from(marbimCallLog)
      .where(and(eq(marbimCallLog.companyId, ctx.companyId), gte(marbimCallLog.createdAt, since))),
  )

  return Number(row?.total ?? 0)
}

/**
 * Record one provider call.
 *
 * Its own transaction, outside the caller's. The vendor has already billed for this call, so
 * rolling the row back because something later failed would make the ledger disagree with the
 * invoice in the only direction that matters — under-counting — and the ceiling would drift
 * upward over time as failures accumulated.
 *
 * Never throws. Observability that can take down the thing it observes is a net loss, and the
 * same argument is written out at length in `core/job-runs.ts`.
 */
async function logCall(
  // AnyCtx: an extraction runs on the queue's system ctx, and its spend is the spend that
  // was invisible. A ledger that only accepts a signed-in caller cannot record the calls
  // made on a person's behalf, which is most of them.
  ctx: AnyCtx,
  entry: {
    role: 'extract' | 'reason' | 'embed'
    model: string
    conversationId?: string
    iteration: number
    usage?: { inputTokens: number; outputTokens: number }
    durationMs: number
    outcome: string
    /** Who the call was made for, when `ctx` is the queue rather than a person. */
    createdBy?: string | null
  },
): Promise<void> {
  try {
    await withTenantTx(ctx, async (tx) => {
      await tx.insert(marbimCallLog).values({
        companyId: ctx.companyId,
        role: entry.role,
        model: entry.model,
        conversationId: entry.conversationId ?? null,
        iteration: entry.iteration,
        inputTokens: entry.usage?.inputTokens ?? null,
        outputTokens: entry.usage?.outputTokens ?? null,
        durationMs: entry.durationMs,
        outcome: entry.outcome.slice(0, 500),
        createdBy: entry.createdBy ?? ctx.userId,
      })
    })
  } catch (error) {
    console.error('[marbim] could not record a provider call:', error)
  }
}

/**
 * One conversation turn.
 *
 * Records the primer versions on the row, which is what makes an answer reproducible. The
 * question is redacted before it is stored or sent — a connection string pasted into a chat
 * box is the realistic accident, and it would otherwise live in the database forever.
 */

/**
 * One retry for a failure the provider has already told us is transient.
 *
 * `ProviderError` carries `retryable`, and until now only the queued-extraction path read
 * it — a chat asking the same question got the raw error. The one that actually happened:
 * Anthropic returns a turn with no text and no tool calls (`end_turn`), the provider throws
 * because an empty turn is unrenderable, and the surface says "I lost the connection halfway
 * through". Asking again worked every time, which means the user was doing the retry by
 * hand and being told a network story to explain why they had to.
 *
 * Bounded at one extra attempt, deliberately. A retryable error here is a coin-flip, not a
 * queue: the caller is a person watching a spinner that already ran for thirty seconds, and
 * a second failure is worth showing rather than hiding behind a third try. Overload (429,
 * 529) is also flagged retryable and a short pause is exactly right for it; anything the
 * provider marked NOT retryable — a bad request, a missing key, a model with no logprobs —
 * is rethrown untouched, because it will fail identically the next time.
 */
async function generateWithRetry(request: Parameters<MarbimProvider['generate']>[0]) {
  try {
    return await getProvider().generate(request)
  } catch (error) {
    if (!(error instanceof ProviderError) || !error.retryable) throw error

    // Long enough to clear a rate-limit window's edge, short enough that a person waiting
    // does not read it as a hang.
    await new Promise((resolve) => setTimeout(resolve, 750))
    return getProvider().generate(request)
  }
}

export async function chat(
  ctx: RequestCtx,
  input: {
    conversationId: string
    turnIndex: number
    question: string
    moduleIds: readonly string[]
    scope?: PromptScope
    packs?: readonly ToolPack[]
    /** Role-filtered by the action (audit AI-H6). Empty means "answer without tools". */
    tools?: readonly ModuleTool[]
    policy?: MarbimPolicy
    /**
     * Vendor model for this turn (composer tier). Absent → the registered reasoner's default.
     */
    model?: string
  },
): Promise<ChatResult> {
  const question = redactForPrompt(input.question)
  const prompt = buildPrompt({ moduleIds: input.moduleIds, scope: input.scope ?? {} })

  // `packs` still validates what the modules registered; `tools` is what this CALLER may
  // reach. Passing both means a role filter cannot accidentally widen the set — the
  // intersection is what runs.
  const registered = input.packs ? toolsInScope(input.packs) : []
  const tools = input.tools
    ? registered.filter((tool) => input.tools!.some((allowed) => allowed.name === tool.name))
    : registered

  const moduleOf = (name: string): string | undefined => name.split('.')[0]

  /*
   * The ceiling, checked before the first call and not after (audit AI-H4).
   *
   * Refused rather than truncated: a factory that has spent its day's budget should be told
   * so, in words, at the moment it asks — not given a shorter answer it cannot tell from a
   * complete one. The window is rolling, so it clears itself without an operator.
   */
  if (input.policy) {
    const spent = await tokensSpentToday(ctx)
    if (spent >= input.policy.dailyTokenCeiling) {
      throw new AppError('rate_limited', 'marbim.errors.token_ceiling', {
        spent,
        ceiling: input.policy.dailyTokenCeiling,
      })
    }
  }

  const history = await withTenantRead(ctx, async (tx) =>
    tx
      .select({ question: chatTurns.question, answer: chatTurns.answer })
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.companyId, ctx.companyId),
          eq(chatTurns.conversationId, input.conversationId),
        ),
      )
      .orderBy(chatTurns.turnIndex),
  )

  const messages: TextMessage[] = [
    ...budgetedHistory(history, HISTORY_BUDGET_CHARS),
    { role: 'user', content: question },
  ]

  const executed: ExecutedCall[] = []
  const pendingChangeIds: string[] = []

  // Measured across the whole loop, not one call: the number under the tool strip answers
  // "how long did MARBIM take", and four rounds of reads is what it took.
  const startedAt = Date.now()
  let answer = ''
  let model = ''
  let capped = false

  for (let iteration = 0; ; iteration += 1) {
    /*
     * The last pass offers NO tools, which forces an answer from what the model already has.
     * Offering them again would invite a request nobody will run — the state 6.2 had to
     * write honest copy for, and the one this whole item exists to end.
     */
    const finalPass = iteration >= MAX_TOOL_ITERATIONS
    const callStartedAt = Date.now()

    const request = {
      role: 'reason' as const,
      system: prompt.text,
      messages,
      ...(input.model ? { model: input.model } : {}),
      ...(finalPass || tools.length === 0
        ? {}
        : {
            tools: tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              schema: toJsonSchema(tool),
            })),
          }),
    }

    let result
    try {
      result = await generateWithRetry(request)
    } catch (error) {
      await logCall(ctx, {
        role: 'reason',
        model: 'unknown',
        conversationId: input.conversationId,
        iteration,
        durationMs: Date.now() - callStartedAt,
        outcome: error instanceof Error ? error.message : String(error),
      })
      throw error
    }

    await logCall(ctx, {
      role: 'reason',
      model: result.model,
      conversationId: input.conversationId,
      iteration,
      ...(result.usage ? { usage: result.usage } : {}),
      durationMs: Date.now() - callStartedAt,
      outcome: 'ok',
    })

    model = result.model
    answer = result.text

    if (finalPass || result.toolCalls.length === 0) {
      /*
       * `capped` is simply whether this was the forced pass.
       *
       * Reaching `finalPass` at all means the model used all four tool rounds and was asked
       * once more with none offered — so it answered from what it had. Written first as a
       * three-way expression that returned the PREVIOUS `capped` when the final pass came
       * back with no tool calls, which is always: the final pass is the one where no tools
       * are offered. It reported false in exactly the case it exists to report.
       */
      capped = finalPass
      break
    }

    // `runToolCalls` has already parsed the args with the tool's own zod, so the runner is
    // the execution and nothing else.
    const round = await runToolCalls(ctx, result.toolCalls, { tools, moduleOf }, {
      read: (readCtx, tool, args) =>
        (tool as Extract<ModuleTool, { kind: 'read' }>).execute(readCtx, args),
      draft: (draftCtx, tool, args, moduleId) => runDraftTool(draftCtx, tool, args, { moduleId }),
    })

    executed.push(...round.executed)
    pendingChangeIds.push(...round.pendingChangeIds)

    // The model's own request replayed alongside the answers — INCLUDING the reasoning that
    // led to it. Anything else rewrites the conversation underneath it, and the vendors reject
    // that: Anthropic signs its thinking blocks, and a turn replayed without them came back
    // empty every time (the "lost the connection" report from the first live test).
    messages.push({
      role: 'assistant',
      content: result.text,
      toolCalls: result.toolCalls,
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    })
    messages.push({ role: 'user', content: '', toolResults: round.results })
  }

  const durationMs = Date.now() - startedAt

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(chatTurns)
      .values({
        companyId: ctx.companyId,
        conversationId: input.conversationId,
        turnIndex: input.turnIndex,
        question,
        answer,
        toolCalls: executed,
        proposedChangeIds: pendingChangeIds,
        model,
        primerVersions: prompt.primerVersions,
        scope: (input.scope ?? {}) as Record<string, unknown>,
        createdBy: ctx.userId,
      })
      .returning({ id: chatTurns.id })

    if (!row) throw new Error('chat_turns insert returned nothing')

    return {
      turnId: row.id,
      answer,
      toolCalls: executed,
      primerVersions: prompt.primerVersions,
      model,
      durationMs,
      proposedChangeIds: pendingChangeIds,
      cappedAtIterationLimit: capped,
    }
  })
}

/**
 * A conversation, oldest turn first — only the caller's own threads.
 *
 * `RequestCtx`, not `AnyCtx`, and the narrowing is the point rather than a type detail: this
 * query is scoped to `created_by = ctx.userId`, and a system context's `userId` is `null` by
 * definition. "The caller's own threads" has no meaning for a caller that is not a person —
 * the honest answers would be every thread in the company or none, and both are wrong for a
 * function whose whole purpose is that a shared assistant does not show one operator another
 * one's questions.
 *
 * Every caller is a server action behind `requireRole`, so nothing loses access.
 */
export async function conversation(
  ctx: RequestCtx,
  conversationId: string,
): Promise<(typeof chatTurns.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(chatTurns)
      .where(
        and(
          eq(chatTurns.companyId, ctx.companyId),
          eq(chatTurns.conversationId, conversationId),
          eq(chatTurns.createdBy, ctx.userId),
        ),
      )
      .orderBy(chatTurns.turnIndex),
  )
}

export interface ConversationSummary {
  conversationId: string
  /** First question in the thread — what the history list shows. */
  preview: string
  turnCount: number
  lastAt: Date
}

/**
 * Recent threads this person started, newest activity first.
 *
 * Scoped to `createdBy` so history is personal — a factory's shared assistant must not
 * surface another user's questions in somebody else's panel.
 */
export async function listConversations(
  // Personal history, so a real person — see `conversation` above.
  ctx: RequestCtx,
  input: { limit?: number } = {},
): Promise<ConversationSummary[]> {
  const limit = Math.min(input.limit ?? 30, 50)
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        conversationId: chatTurns.conversationId,
        preview: sql<string>`coalesce(
          min(case when ${chatTurns.turnIndex} = 0 then ${chatTurns.question} end),
          min(${chatTurns.question})
        )`,
        turnCount: sql<number>`count(*)::int`,
        lastAt: sql<Date>`max(${chatTurns.createdAt})`,
      })
      .from(chatTurns)
      .where(and(eq(chatTurns.companyId, ctx.companyId), eq(chatTurns.createdBy, ctx.userId)))
      .groupBy(chatTurns.conversationId)
      .orderBy(sql`max(${chatTurns.createdAt}) desc`)
      .limit(limit)

    return rows.map((row) => ({
      conversationId: row.conversationId,
      preview: row.preview,
      turnCount: row.turnCount,
      lastAt: row.lastAt instanceof Date ? row.lastAt : new Date(row.lastAt),
    }))
  })
}

/** Recent extraction jobs, newest first — the admin runbook screen. */
export async function recentJobs(
  ctx: AnyCtx,
  input: { limit?: number } = {},
): Promise<(typeof extractionJobs.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(extractionJobs)
      .orderBy(desc(extractionJobs.createdAt))
      .limit(Math.min(input.limit ?? 50, 200)),
  )
}

/**
 * One job's fate, for a surface following it — the composer's "read this document" flow
 * polls this until the job resolves. The error is flattened to its message: the raw jsonb
 * carries attempts and retryability, which are the worker's business, not the person's.
 */
export async function extractionStatus(
  ctx: AnyCtx,
  input: { jobId: string },
): Promise<{
  status: string
  error: string | null
  pendingChangeId: string | null
  moduleId: string
  targetTable: string
}> {
  const job = await withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        status: extractionJobs.status,
        error: extractionJobs.error,
        pendingChangeId: extractionJobs.pendingChangeId,
        moduleId: extractionJobs.moduleId,
        targetTable: extractionJobs.targetTable,
      })
      .from(extractionJobs)
      .where(eq(extractionJobs.id, input.jobId))
    return row
  })

  if (!job) throw notFound('marbim.errors.job_not_found', { jobId: input.jobId })

  const error =
    job.error && typeof job.error === 'object' && 'message' in job.error
      ? String((job.error as { message: unknown }).message)
      : null

  return {
    status: job.status,
    error,
    pendingChangeId: job.pendingChangeId,
    moduleId: job.moduleId,
    targetTable: job.targetTable,
  }
}

export { and, conflict, MARBIM_EVENTS }
