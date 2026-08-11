/**
 * The model seam.
 *
 * MARBIM never imports a vendor SDK. It declares the two shapes it needs — structured
 * extraction and a text turn — and something registers an implementation. Three reasons,
 * in order of how much they matter:
 *
 *  1. **Every test in this module runs offline and deterministically.** A test suite that
 *     needs a network and a key is a test suite that gets skipped, and the logic being
 *     guarded here is the logic that decides whether a model may write to an ERP.
 *  2. `MARBIM_MOCK` becomes real. It was validated at boot and did nothing (docs/STUBS.md);
 *     now it selects the deterministic provider.
 *  3. Swapping Anthropic for anything else is a file, not a refactor. Models by role, never
 *     hardcoded provider ids.
 *
 * **No provider is registered by default, and the default is not "pretend".** An unconfigured
 * MARBIM refuses rather than silently returning plausible-looking output — the same reason
 * 5.1's PP gate fails closed.
 */
import type { ZodType } from 'zod'

export class ProviderError extends Error {
  override readonly name = 'ProviderError'
  /** False for a bad input, true for a timeout or a rate limit. Drives retry vs reject. */
  readonly retryable: boolean

  constructor(message: string, options: { retryable: boolean }) {
    super(message)
    this.retryable = options.retryable
  }
}

/** What a model is asked for, by ROLE rather than by name. */
export type ModelRole = 'extract' | 'reason' | 'embed'

export interface ExtractRequest<T> {
  role: ModelRole
  schema: ZodType<T>
  /** The document text or message being read. Already redacted. May be empty when `file` is set. */
  input: string
  /** What the extractor is for — becomes part of the prompt. */
  instruction: string
  /**
   * The original file, for a provider whose extract model can read it natively — a PDF's
   * pages or a scan's pixels instead of pasted text. Confidence still comes from the output
   * tokens' log-probabilities, so uncertainty about a blurry digit is finally *measured*
   * rather than laundered through somebody's transcription. A provider that cannot read
   * files refuses (ProviderError, not retryable) instead of quietly extracting from the
   * empty `input`.
   */
  file?: ExtractFile
}

/** PDF or image bytes on their way to a vision-capable extract model. */
export interface ExtractFile {
  base64: string
  mimeType: string
  filename: string
}

/**
 * What an extract model may be handed directly. PDFs go as file parts (the vendor renders
 * text and page images server-side, so scans inside PDFs read too); JPEG/PNG/WebP go as
 * image parts. HEIC is uploadable to us but not readable by the API, and CSV/XLSX/DOCX
 * have text a person or a converter should produce — all of those are refusals at the
 * intake door, not silent empties in the worker.
 */
export const MODEL_READABLE_MIME: ReadonlySet<string> = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
])

export interface ExtractResult<T> {
  value: T
  /**
   * Per FIELD, from the model. Not optional and not a constant — `assertExtractionConfidence`
   * refuses both, which is the point of the whole seam.
   */
  fieldConfidence: Record<string, number>
  /** How these numbers were produced. Recorded on the job and grouped by in the report. */
  method: string
  uniformConfidenceJustification?: string
  model: string
  usage?: TokenUsage
}

export interface EmbedRequest {
  role: ModelRole
  /** The texts to embed, in order. The result vectors come back in the same order. */
  inputs: readonly string[]
  /**
   * The width the CALLER's column is. Checked by the caller against what comes back, because
   * a model that quietly returns 768 dims for a vector(1536) column fails per row inside a
   * background job nobody is watching.
   */
  dimensions: number
}

export interface EmbedResult {
  vectors: number[][]
  model: string
  usage?: TokenUsage
}

/** A tool the model asked for. The `id` is what a result is matched back to. */
export interface ToolCall {
  /** Vendor-assigned, and opaque. Anthropic will not accept a result without it. */
  id: string
  name: string
  args: Record<string, unknown>
}

/** What running one tool produced, on its way back into the conversation. */
export interface ToolResult {
  /** The `ToolCall.id` this answers. */
  id: string
  /** Serialised for the model to read. Never a raw row — see `redactForPrompt`. */
  content: string
  /** A refusal or a failure. The model is told, so it can say so rather than retry blindly. */
  isError?: boolean
}

/**
 * One turn of the conversation as the provider sees it.
 *
 * `toolCalls` and `toolResults` are what make an execution loop possible (plan 6.5). A model
 * that asked for three tools must be replayed its OWN request alongside the answers, or the
 * next turn has results it never asked for — vendors reject that, and rightly: it is how a
 * conversation gets rewritten underneath a model.
 */
export interface TextMessage {
  role: 'user' | 'assistant'
  content: string
  /** Assistant turns only: what this turn asked to run. */
  toolCalls?: readonly ToolCall[]
  /** User turns only: answers to the previous assistant turn's calls, in any order. */
  toolResults?: readonly ToolResult[]
  /**
   * Assistant turns only: the model's own reasoning blocks, VERBATIM, to be replayed unedited.
   *
   * Opaque on purpose — the shape belongs to whichever vendor produced it, and this layer must
   * not be tempted to read, trim or reformat it. Anthropic's thinking blocks are signed, and a
   * turn replayed without the block that preceded its tool calls is a turn the model no longer
   * recognises as its own: it answers with nothing at all. Providers that have no such concept
   * simply never set this.
   */
  reasoning?: readonly unknown[]
}

export interface TextRequest {
  role: ModelRole
  system: string
  messages: readonly TextMessage[]
  /**
   * Tool descriptions the model may choose from.
   *
   * Absent or empty means the model must answer from what it already has. The execution loop
   * uses that deliberately on its final turn: once the iteration cap is reached, offering
   * tools again would invite a request that will not be run (plan 6.5).
   */
  tools?: { name: string; description: string; schema?: unknown }[]
  /**
   * Optional per-call model id (composer "marbim fast" / "marbim large").
   * When absent, the reasoner uses the model it was constructed with.
   */
  model?: string
}

/** What a call cost, when the vendor says. Recorded per call for the ceiling (audit AI-H4). */
export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface TextResult {
  text: string
  /** Tools the model asked to run, in order. */
  toolCalls: ToolCall[]
  model: string
  usage?: TokenUsage
  /** Why the model stopped. `max_tokens` means the answer is cut off, and it is worth saying. */
  stopReason?: string
  /** The turn's reasoning blocks, to be handed straight back on the next turn. See TextMessage. */
  reasoning?: readonly unknown[]
}

export interface MarbimProvider {
  readonly id: string
  /**
   * Which model serves each role, where they differ.
   *
   * Absent for a single-model provider — the deterministic one answers every role itself, and
   * its `id` says so. The real provider routes each role to a different vendor (plan 6.4), so
   * "which model answered" has three answers and `id` alone cannot be truthful about all of
   * them. A role absent from this map is one the deployment has no key for.
   */
  readonly models?: Partial<Record<ModelRole, string>>
  extract<T>(request: ExtractRequest<T>): Promise<ExtractResult<T>>
  generate(request: TextRequest): Promise<TextResult>
  /** Required, not optional: 1.6 Order Memory cannot fingerprint a style without it. */
  embed(request: EmbedRequest): Promise<EmbedResult>
}

let provider: MarbimProvider | null = null

export function registerProvider(next: MarbimProvider): void {
  provider = next
}

/** Test-only: the provider is module-global, so suites must be able to reset it. */
export function resetProvider(): void {
  provider = null
}

/**
 * The provider in force.
 *
 * Throws when none is registered rather than falling back to a mock. A system that quietly
 * answers with invented data when its model is unconfigured is worse than one that says it
 * cannot answer — the first is discovered by somebody acting on a fabricated number.
 */
export function getProvider(): MarbimProvider {
  if (!provider) {
    throw new ProviderError(
      'no MARBIM provider is registered — set MARBIM_MOCK for the deterministic one, or register a real model provider',
      { retryable: false },
    )
  }
  return provider
}

export const hasProvider = (): boolean => provider !== null

import { surfaceLabelFor } from './surface-label'

/**
 * Which model answered, for telemetry and jobs.
 *
 * Returns the vendor model id actually in force (`claude-sonnet-5`, `mock/…`, …).
 * Prefer `providerSurfaceLabel()` for anything a person reads.
 *
 * Null when nothing is registered — the caller shows nothing rather than guessing.
 */
export const providerId = (): string | null => provider?.id ?? null

/**
 * Product-facing name for the panel header (and anything else a person skims).
 *
 * People see "marbim fast" / "marbim large". The backend is unchanged: reason still
 * runs on the configured Claude model, extract/embed on their configured vendors.
 * This function only renames the caption — it never picks a model. Mock stays as
 * itself so a deterministic answer is never dressed up as a product tier.
 */
export function providerSurfaceLabel(id: string | null = providerId()): string | null {
  return surfaceLabelFor(id)
}

/**
 * The model serving one role, for a caller that needs to name it specifically.
 *
 * Falls back to the provider id, which is correct for a single-model provider and is the
 * best available answer for a role the composite has no key for — the caller is about to get
 * a refusal from that role anyway, and naming the provider is more use than naming nothing.
 */
export const modelForRole = (role: ModelRole): string | null =>
  provider?.models?.[role] ?? provider?.id ?? null

/** Roles this deployment can actually serve. Empty when no provider is registered. */
export function availableRoles(): ModelRole[] {
  if (!provider) return []
  if (!provider.models) return ['extract', 'reason', 'embed']
  return (Object.keys(provider.models) as ModelRole[]).filter((role) => provider?.models?.[role])
}
