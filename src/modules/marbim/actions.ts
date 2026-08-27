'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'
import { z } from 'zod'

import { env } from '@/lib/env'
import { consume } from '@/lib/rate-limit'
import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { companyProfile, getPolicy } from '@/modules/settings/service'
import { listModules, resolveReadSchema } from '@/modules/core/registry'
import { TEXT_EXTRACTABLE_MIME } from '@/lib/document-text'

import { activeModuleIds, assertModuleActive } from '@/modules/core/activation'
import { AppError } from '@/modules/core/errors'
import type { AnyCtx } from '@/modules/core/ctx'
import { buyerAccounts } from '@/modules/buyers/queries'
import { recentAudits } from '@/modules/compliance/queries'

import { intakeKind, intakeKindsFor, mayFileKind, mayReadKind } from './intake'
import { extractorVersionFor } from './marbim'
import { EXTRACTOR_PROMPT_VERSION } from './providers/gemini'
import { hasProvider, MODEL_READABLE_MIME, modelForRole } from './provider'
import { primerModulesForRoles, toolsForRoles } from './scope'
import {
  chat,
  conversation,
  extractionStatus,
  listConversations,
  queueExtraction,
  readDocumentInto,
  tokensSpentToday,
  type ChatResult,
  type ConversationSummary,
  type MarbimPolicy,
} from './service'
import type { ToolPack } from './tools'

/**
 * The MARBIM surface's one write path.
 *
 * `moduleIds` decides which department primers lead the prompt, and it is
 * derived here from the screen the user asked FROM rather than taken from the
 * client. A client that could name its own primers could ask the cutting
 * assistant to answer a payroll question.
 */

/**
 * Everyone the nav offers MARBIM to. Asking a question is a read however it is phrased —
 * MARBIM writes nothing itself, and anything it drafts lands in somebody's approve inbox.
 */
const ASK_ROLES = [
  'merchandiser',
  'commercial',
  'planner',
  'store',
  'procurement',
  'cutting',
  'production',
  'quality',
  'shipment',
  'maintenance',
  'hr',
  'compliance',
  'finance',
  'member',
  'viewer',
] as const

/**
 * Narrower than asking: intake QUEUES an extraction, which costs a provider call and fills
 * somebody's approve inbox with drafts to review (audit AI-H7 — the intake path had no role
 * gate at all, and is not in the nav, so the shell's own check never covered it either).
 * A viewer or a plain member has nothing to draft and no inbox to answer for.
 */
const INTAKE_ROLES = ASK_ROLES.filter(
  (role): role is Exclude<(typeof ASK_ROLES)[number], 'member' | 'viewer'> =>
    role !== 'member' && role !== 'viewer',
)

const askInput = z.object({
  conversationId: z.string().uuid(),
  turnIndex: z.number().int().min(0),
  question: z.string().min(1).max(4000),
  /** The screen MARBIM was opened from. Narrows which primers lead. */
  fromModule: z.string().min(1).max(64).optional(),
  /** Composer tier — maps to Claude sonnet (fast) or opus (large). */
  tier: z.enum(['fast', 'large']).default('fast'),
})

export async function ask(
  input: z.input<typeof askInput>,
): Promise<ChatResult | ActionFailure> {
  const ctx = await requireRole(await headers(), ...ASK_ROLES)

  // Refusals return as values (rate limits, token ceilings, zod): production masks thrown
  // messages, so before this wrap they reached the person asking as React #441.
  return surfaced(async () => {
    const { conversationId, turnIndex, question, fromModule, tier } = askInput.parse(input)

    // Only modules that actually registered a primer, and only ones this caller's
    // roles can already read — MARBIM never widens what a person can see.
    //
    // Filtered by the company's active-module set FIRST (spec §1): a switched-off
    // module contributes no primer, no pack and no tools, so the assistant cannot
    // narrate or draft into a department the factory has shelved. An inactive
    // `fromModule` falls out of `known` below and the scope widens to everything
    // active, which is what opening MARBIM from a stale tab deserves.
    const active = await activeModuleIds(ctx)
    const registered = listModules().filter((m) => active.has(m.id))
    const known = new Set(registered.map((m) => m.id))
    const lead = fromModule && known.has(fromModule) ? fromModule : undefined

    const inScope = lead ? registered.filter((m) => m.id === lead) : registered

    // The packs the modules in scope actually registered.
    //
    // This was hardcoded to `[]` with a note saying packs would be wired "as each module
    // lands". Two modules had landed theirs and were still being ignored, so MARBIM answered
    // every question with "no tools are available in this scope" — indistinguishable from a
    // module that had never registered one. A module adding a pack now takes effect by the
    // act of registering it, which is how the rest of the registry already works.
    const packs = inScope
      .map((m) => m.toolPack)
      .filter((pack): pack is ToolPack => isToolPack(pack))

    /*
     * Filtered by ROLE before the model ever sees the list (plan 6.5, audit AI-H6).
     *
     * The caption under the composer has always said "MARBIM reads what your role can already
     * read", and until now it did not: every pack in scope went into the prompt whoever was
     * asking, so a viewer's conversation advertised `workforce.payroll_run`. That was a
     * disclosure of shape rather than data while nothing executed. Since the loop landed it
     * would be the data.
     *
     * Read tools need `canSee` on the module, draft tools need `canWrite` — the nav's own
     * answers, not a second list that could drift from the one the sidebar uses.
     */
    const profile = await companyProfile(ctx)
    const factoryType = profile?.factoryType ?? 'woven'
    const tools = toolsForRoles({ packs, roles: ctx.roles, factoryType })

    const policy = await getPolicy<MarbimPolicy>(ctx, 'marbim')

    // Product tiers stay Claude — fast is MARBIM_MODEL_REASON, large is the opus-class override.
    const model =
      tier === 'large' ? env.MARBIM_MODEL_REASON_LARGE : env.MARBIM_MODEL_REASON

    return chat(ctx, {
      conversationId,
      turnIndex,
      question,
      model,
      // Primers follow the same audience. A primer for a module whose tools this person cannot
      // call is prompt they can only be frustrated by, and it is paid for on every request.
      moduleIds: primerModulesForRoles(
        inScope.map((m) => m.id),
        ctx.roles,
        factoryType,
      ),
      scope: lead ? { moduleId: lead } : {},
      packs,
      tools,
      policy,
    })
  })
}

/**
 * The registry stores `toolPack` as `unknown` — core must not depend on MARBIM's types, or
 * every module would compile against the assistant. So the shape is checked here, at the
 * one place that converts it back. A malformed pack is skipped rather than thrown on: one
 * module's bad registration must not make the assistant unusable for the other twenty.
 */
function isToolPack(value: unknown): value is ToolPack {
  if (typeof value !== 'object' || value === null) return false
  const pack = value as Partial<ToolPack>
  return typeof pack.moduleId === 'string' && Array.isArray(pack.tools)
}

export interface ContextOption {
  id: string
  label: string
  /** Secondary line — what tells two similar rows apart. */
  detail: string
}

/**
 * The choices behind a context picker, read through the owning module (rule 11).
 *
 * One function serves both the screen and the check in `readDocument`, on purpose. Two
 * copies would drift, and the copy that drifted would be the one deciding whether a
 * submitted id is allowed.
 */
async function contextOptions(
  ctx: AnyCtx,
  source: 'buyers' | 'audits' | 'order_styles',
): Promise<ContextOption[]> {
  if (source === 'order_styles') {
    // Read through the orders module's own queries (rule 11), open orders only.
    const { orderStyleChoices } = await import('@/modules/orders/queries')
    const rows = await orderStyleChoices(ctx)
    return rows.map((style) => ({
      id: style.id,
      // The PO is what somebody reads off the email; the style code is what the grid
      // belongs to. Both, because an order with two styles is common and picking the
      // wrong one writes a revision against the wrong garment.
      label: [style.poNumber, style.styleCode].filter(Boolean).join(' · ') || style.styleCode,
      detail: [style.buyerName, style.description].filter(Boolean).join(' · '),
    }))
  }

  if (source === 'buyers') {
    const rows = await buyerAccounts(ctx)
    return rows.map((buyer) => ({
      id: buyer.id,
      label: buyer.name,
      detail: [buyer.code, buyer.country].filter(Boolean).join(' · '),
    }))
  }

  const rows = await recentAudits(ctx)
  return rows.map((audit) => ({
    id: audit.id,
    label: `${audit.regime} · ${audit.auditor}`,
    // The finding count is the thing that stops a report being filed twice — an audit that
    // already has findings is almost certainly not the one somebody is entering now.
    detail:
      audit.findingCount > 0
        ? `${audit.auditedOn} · ${audit.findingCount} findings already recorded`
        : audit.auditedOn,
  }))
}

/** What the intake screen shows in a kind's pickers. Empty for kinds needing no context. */
export async function intakeContext(
  kindId: string,
): Promise<{ field: string; label: string; options: ContextOption[] }[] | ActionFailure> {
  const ctx = await requireRole(await headers(), ...ASK_ROLES)

  return surfaced(async () => {
    const kind = intakeKind(kindId)
    if (!mayFileKind(kind, ctx.roles)) {
      throw new AppError('forbidden', 'marbim.errors.kind_not_your_desk', { kindId })
    }
    // The desk wall, then the tenant wall — a kind whose module this factory has
    // switched off has no inbox for the draft to land in.
    await assertModuleActive(ctx, kind.moduleId)

    const resolved = []
    for (const field of kind.context ?? []) {
      resolved.push({
        field: field.field,
        label: field.label,
        options: await contextOptions(ctx, field.source),
      })
    }
    return resolved
  })
}

/**
 * Ask MARBIM to read a document somebody has uploaded.
 *
 * The person says what the document IS; the extractor reads it and files a draft. That
 * ordering is deliberate and explained in `intake.ts` — a classifier that guesses wrong puts
 * a draft in an approve inbox where it looks exactly like a right one.
 *
 * Nothing is written to the target table here, or ever, by this path. The extraction lands
 * in `pending_changes` with per-field confidence and waits for a person (CLAUDE.md rule 3).
 * The five-minute `marbim.run_extractions` schedule is what actually runs it, so this
 * returns a queued job rather than a result — a reader who expects a draft immediately would
 * be surprised, and the screen says so.
 *
 * **Text or a readable file — one of them must actually be readable.** Pasted text is what
 * gets read when it exists. Without it, a PDF/JPEG/PNG/WebP attachment is handed to the
 * extract model directly (`runExtraction` fetches the bytes) — the model's own reader sees
 * the pages, and per-field confidence measures the whole journey from pixels to value. A
 * type the model cannot read (HEIC, spreadsheets, Word) with no pasted text is refused at
 * this door, not queued into a job that would fail in the worker. The document id still
 * travels into `propose` either way, so an approver can check the original.
 */
export async function readDocument(input: {
  kindId: string
  sourceText?: string
  documentId?: string
  contextValues?: Record<string, string>
}): Promise<{ jobId: string; label: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), ...INTAKE_ROLES)

  // Refusals return as values, exactly as in `readIntoForm` below: production masks thrown
  // messages, so before this wrap every gate in here reached the operator as React #441.
  return surfaced(async () => {
    /*
     * Nothing queues into a void (plan 6.1, audit AI-B1).
     *
     * `runQueuedExtractions` skips the whole batch when no provider is registered — correctly,
     * because the backlog is intact and will run when one is configured. What was wrong is
     * what happened before it: this action accepted the document, told the operator it was
     * queued, and left it in a pile nothing would ever read. A person who has typed out a
     * buyer's PO deserves to be told the copilot is not available, at the moment they press
     * the button, rather than to discover it by the draft never arriving.
     *
     * Checked at the door rather than in `queueExtraction`, because the job row is the thing
     * that should not exist — a refusal after the insert would leave exactly the pile this
     * prevents.
     */
    if (!env.MARBIM_ENABLED || !hasProvider()) {
      throw new AppError('validation_failed', 'marbim.errors.unavailable', {
        enabled: env.MARBIM_ENABLED,
        provider: hasProvider(),
      })
    }

    const policy = await getPolicy<MarbimPolicy>(ctx, 'marbim')

    const kind = intakeKind(input.kindId)

    /*
     * The wall, not the filter. `listIntakeKinds` decides which chips appear; this decides
     * what may actually be queued, and a screen is never the thing that decides.
     */
    if (!mayFileKind(kind, ctx.roles)) {
      throw new AppError('forbidden', 'marbim.errors.kind_not_your_desk', { kindId: kind.id })
    }

    // Same second wall as `intakeContext`: the module the draft would land in must be
    // active for THIS company, whatever chips a stale screen still shows.
    await assertModuleActive(ctx, kind.moduleId)

    /*
     * A form-filling kind has no proposable target, so queueing it would create a job that can
     * only die at `propose` — after the upload, after the wait, in a status list. Refused at
     * the door, the same way an unreadable file is.
     */
    if (kind.fillsFormOnly) {
      throw new AppError('validation_failed', 'marbim.errors.kind_is_inline_only', {
        kindId: kind.id,
      })
    }

    /*
     * The one-of-them-is-readable gate, checked before any work is queued.
     *
     * A file-only submission is only accepted when the file can actually be read — by the
     * extract model directly (PDF, photographs) or by the server's own converter first
     * (Word, Excel, CSV). Checked against the document row, not the client's word, because
     * the mime the server stored at upload is the one the worker will fetch. Refusing here
     * beats a job that queues, runs, and fails where only the status list would say why.
     *
     * The upload allowlist stays WIDER than this on purpose: a legacy `.doc` or a HEIC photo
     * is worth keeping as evidence against a GRN even though nothing can draft from it.
     */
    const sourceText = input.sourceText?.trim() ? input.sourceText : undefined
    if (!sourceText) {
      if (!input.documentId) {
        throw new AppError('validation_failed', 'marbim.errors.nothing_to_read', {})
      }
      const { documentMeta } = await import('@/modules/core/documents')
      const meta = await documentMeta(ctx, input.documentId)
      if (!MODEL_READABLE_MIME.has(meta.mimeType) && !TEXT_EXTRACTABLE_MIME.has(meta.mimeType)) {
        throw new AppError('validation_failed', 'marbim.errors.file_unreadable', {
          mimeType: meta.mimeType,
        })
      }
    }

    /**
     * Context ids are checked against the caller's OWN options, not merely parsed.
     *
     * These values are merged into the payload and scored 1.0, so an unchecked one would be
     * a way to write a chosen id into a draft wearing full confidence. Re-resolving the list
     * server-side means an id from another company is not in it, and the tenancy-scoped
     * query is what makes that true rather than a check somebody has to remember.
     */
    const contextValues: Record<string, string> = {}
    for (const field of kind.context ?? []) {
      const chosen = input.contextValues?.[field.field]
      if (!chosen) {
        throw new AppError('validation_failed', 'marbim.errors.context_required', {
          field: field.field,
        })
      }

      const options = await contextOptions(ctx, field.source)
      if (!options.some((option) => option.id === chosen)) {
        throw new AppError('validation_failed', 'marbim.errors.context_unknown', {
          field: field.field,
        })
      }

      contextValues[field.field] = chosen
    }

    const { jobId } = await queueExtraction(
      ctx,
      {
        moduleId: kind.moduleId,
        targetTable: kind.targetTable,
        zodSchemaKey: kind.zodSchemaKey,
        extractorName: `intake.${kind.id}`,
        // Versioned so a rewritten extractor's results are never pooled with its
        // predecessor's — the whole reason the field is required. It was the literal `'1'`
        // until plan 6.4, which made the correction-rate report one lifetime average across
        // every prompt and every model the system had ever run.
        extractorVersion: extractorVersionFor({
          // A file read is a different population from a text read for the correction-rate
          // report: it includes the model's own reading of the pages, not just of somebody's
          // transcription. The suffix keeps the two from pooling.
          promptVersion: sourceText ? EXTRACTOR_PROMPT_VERSION : `${EXTRACTOR_PROMPT_VERSION}f`,
          model: modelForRole('extract'),
        }),
        sourceText,
        sourceDocumentId: input.documentId,
        contextValues: Object.keys(contextValues).length > 0 ? contextValues : undefined,
      },
      policy,
    )

    revalidatePath('/approve')

    return { jobId, label: kind.label }
  })
}

/**
 * Read a document straight into the form the person already has open.
 *
 * The other path — `readDocument` above — queues a job, drafts a `pending_change`, and asks
 * somebody to approve it. That is right when a document arrives and nobody is standing over
 * it. It is the wrong shape entirely for the case this exists for: a commercial officer with
 * the SWIFT advice in front of them, the "Record a credit" dialog already open, and eighteen
 * fields to type off a page a model can read in two seconds. Sending them away to an intake
 * screen, then to an inbox, then back, to enter data they are holding, is why nobody would
 * ever use it.
 *
 * ## This does not write anything
 *
 * It fills a form. The person then checks it and presses the dialog's own save, which is the
 * ordinary manual action with its own role wall and its own validation — so the WRITER is the
 * human, exactly as they were before, and CLAUDE.md rule 3 is untouched: no AI write happens
 * here, and none bypasses `pending_changes`. This is the workspace's stated agentic-input
 * pattern — unstructured text → schema → pre-filled form → human review → save — and manual
 * entry stays available because it is the same form.
 *
 * The reading is still measured, still logged against the daily ceiling, still refused if the
 * extractor returns a uniform confidence. What changes is only who the answer goes to.
 */
export async function readIntoForm(input: {
  kindId: string
  documentId?: string
  sourceText?: string
  contextValues?: Record<string, string>
}): Promise<
  | {
      fields: { name: string; value: unknown; confidence: number | null }[]
      model: string
      label: string
    }
  | ActionFailure
> {
  const ctx = await requireRole(await headers(), ...INTAKE_ROLES)

  return surfaced(async () => {
    if (!env.MARBIM_ENABLED || !hasProvider()) {
      throw new AppError('validation_failed', 'marbim.errors.unavailable', {
        enabled: env.MARBIM_ENABLED,
        provider: hasProvider(),
      })
    }

    const kind = intakeKind(input.kindId)
    // The wall, not the filter — same as the queued path. A screen never decides this.
    // `mayReadKind`, because a form-filling kind is unfileable by everybody and reading one
    // is exactly what this action is for.
    if (!mayReadKind(kind, ctx.roles)) {
      throw new AppError('forbidden', 'marbim.errors.kind_not_your_desk', { kindId: kind.id })
    }
    // Reading fills a form whose SAVE lives behind the module's own actions — and those
    // refuse when the module is off. Refusing here spares the person filling a form
    // whose save button can only 403.
    await assertModuleActive(ctx, kind.moduleId)

    const sourceText = input.sourceText?.trim() ? input.sourceText : undefined
    if (!sourceText) {
      if (!input.documentId) {
        throw new AppError('validation_failed', 'marbim.errors.nothing_to_read', {})
      }
      const { documentMeta } = await import('@/modules/core/documents')
      const meta = await documentMeta(ctx, input.documentId)
      if (!MODEL_READABLE_MIME.has(meta.mimeType) && !TEXT_EXTRACTABLE_MIME.has(meta.mimeType)) {
        throw new AppError('validation_failed', 'marbim.errors.file_unreadable', {
          mimeType: meta.mimeType,
        })
      }
    }

    /*
     * The same hourly limit the queued path consumes, and for the same reason: this makes
     * real, billable model calls. An inline door that did not count would be the cheapest
     * way to spend a factory's whole budget, and the ceiling would only ever see the path
     * nobody uses.
     */
    const policy = await getPolicy<MarbimPolicy>(ctx, 'marbim')
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

    const spent = await tokensSpentToday(ctx)
    if (spent >= policy.dailyTokenCeiling) {
      throw new AppError('rate_limited', 'marbim.errors.token_ceiling', {
        spent,
        ceiling: policy.dailyTokenCeiling,
      })
    }

    /* Context ids re-resolved against the caller's own options, never merely parsed —
       they are merged in at confidence 1, so an unchecked one would be a way to put another
       company's id into somebody's form wearing certainty. */
    const contextValues: Record<string, string> = {}
    for (const field of kind.context ?? []) {
      const chosen = input.contextValues?.[field.field]
      if (!chosen) continue
      const options = await contextOptions(ctx, field.source)
      if (!options.some((option) => option.id === chosen)) {
        throw new AppError('validation_failed', 'marbim.errors.context_unknown', {
          field: field.field,
        })
      }
      contextValues[field.field] = chosen
    }

    const read = await readDocumentInto(ctx, {
      moduleId: kind.moduleId,
      targetTable: kind.targetTable,
      // `resolveReadSchema`, not `resolvePendingSchema`: this fills a form and proposes
      // nothing, so the proposable-target gate is not the one that applies.
      schema: resolveReadSchema(kind.moduleId, kind.zodSchemaKey),
      ...(sourceText ? { sourceText } : {}),
      ...(input.documentId ? { sourceDocumentId: input.documentId } : {}),
      ...(Object.keys(contextValues).length > 0 ? { contextValues } : {}),
      createdBy: ctx.userId,
    })

    return {
      // Flattened for the dialog, which fills field by field and marks each with how sure
      // the reading was. Null rather than 0 for a field with no score: "not read" and "read
      // and unsure" are different things and the screen shows them differently.
      fields: Object.entries(read.payload).map(([name, value]) => ({
        name,
        value,
        confidence: read.fieldConfidence[name] ?? null,
      })),
      model: read.model,
      label: kind.label,
    }
  })
}

/**
 * The intake kinds, as the composer's "read this document" flow needs them.
 *
 * The intake PAGE gets this list server-rendered; the composer discovers it after an
 * attach, client-side. Same source (`INTAKE_KINDS`), same role wall as the submission it
 * leads to — a viewer's drawer must not offer chips whose submit would 403.
 */
export async function listIntakeKinds(): Promise<
  | { id: string; label: string; hint: string; targetTable: string; needsContext: boolean }[]
  | ActionFailure
> {
  const ctx = await requireRole(await headers(), ...INTAKE_ROLES)

  return surfaced(async () =>
    // The caller's OWN kinds, in THIS company's active modules. Chips that 403 on submit
    // are worse than no chips — that is as true of a switched-off module's paper as of a
    // wage gazette offered to a merchandiser.
    intakeKindsFor(ctx.roles, await activeModuleIds(ctx)).map((kind) => ({
      id: kind.id,
      label: kind.label,
      hint: kind.hint,
      targetTable: kind.targetTable,
      needsContext: (kind.context ?? []).length > 0,
    })),
  )
}

/**
 * One extraction's fate, for the surface that queued it to follow. Read-only and
 * tenant-scoped; the poller stops the moment the status is terminal.
 */
export async function extractionJobStatus(input: { jobId: string }): Promise<
  | {
      status: string
      error: string | null
      pendingChangeId: string | null
      targetTable: string
    }
  | ActionFailure
> {
  const ctx = await requireRole(await headers(), ...INTAKE_ROLES)

  return surfaced(async () => {
    const job = await extractionStatus(ctx, { jobId: input.jobId })
    return {
      status: job.status,
      error: job.error,
      pendingChangeId: job.pendingChangeId,
      targetTable: job.targetTable,
    }
  })
}

/** Recent threads for the history list in the panel. */
export async function listChatHistory(): Promise<
  { conversationId: string; preview: string; turnCount: number; lastAt: string }[] | ActionFailure
> {
  const ctx = await requireRole(await headers(), ...ASK_ROLES)

  return surfaced(async () => {
    const rows: ConversationSummary[] = await listConversations(ctx, { limit: 30 })
    return rows.map((row) => ({
      conversationId: row.conversationId,
      preview: row.preview,
      turnCount: row.turnCount,
      lastAt: row.lastAt.toISOString(),
    }))
  })
}

/** Turns for one of the caller's conversations — hydrates the surface on reopen / history pick. */
export async function loadChatTurns(input: { conversationId: string }): Promise<
  | {
      id: string
      turnIndex: number
      question: string
      answer: string | null
      toolCalls: { name: string; ok: boolean; ms?: number; error?: string }[]
      model: string | null
    }[]
  | ActionFailure
> {
  const ctx = await requireRole(await headers(), ...ASK_ROLES)

  return surfaced(async () => {
    const { conversationId } = z.object({ conversationId: z.string().uuid() }).parse(input)
    const turns = await conversation(ctx, conversationId)
    return turns.map((turn) => ({
      id: turn.id,
      turnIndex: turn.turnIndex,
      question: turn.question,
      answer: turn.answer,
      toolCalls: normalizeStoredToolCalls(turn.toolCalls),
      model: turn.model,
    }))
  })
}

function normalizeStoredToolCalls(
  raw: unknown,
): { name: string; ok: boolean; ms?: number; error?: string }[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) return []
    const row = entry as { name?: unknown; ok?: unknown; ms?: unknown; error?: unknown }
    if (typeof row.name !== 'string') return []
    return [
      {
        name: row.name,
        ok: row.ok !== false,
        ...(typeof row.ms === 'number' ? { ms: row.ms } : {}),
        ...(typeof row.error === 'string' ? { error: row.error } : {}),
      },
    ]
  })
}
