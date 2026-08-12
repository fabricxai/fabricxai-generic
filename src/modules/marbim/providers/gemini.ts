/**
 * Gemini — the `extract` role (plan 6.4, audit AI-B1).
 *
 * Reading a document is Gemini's job in this platform, and the reason is not preference: it
 * is the only one of the three vendors that returns per-token log-probabilities alongside a
 * schema-constrained JSON response. Without those there is nothing to derive a per-field
 * confidence FROM, and a `pending_changes` draft with no confidence cannot exist for an
 * `ai_extraction` source (rule 3, and plan 6.3 which removed the fabricated alternative).
 *
 * OCR will land here too, when 6.6 decides it — a scanned PO is the same call with an inline
 * image part instead of text.
 *
 * ## Fail-closed, twice
 *
 * `responseLogprobs` is not available on every model. If it comes back absent this throws
 * rather than returning the value with an invented score: an extractor that silently stops
 * measuring looks exactly like one that is working, which is the worst failure this module
 * has. Same for a response that does not satisfy the schema — a partial draft that parses is
 * worse than a failed job somebody can see in the intake list.
 */
import { GoogleGenAI } from '@google/genai'
import { z } from 'zod'

import { DOCUMENT_GUARD, fenceDocument } from '../marbim'
import { ProviderError, type ExtractRequest, type ExtractResult } from '../provider'

import { fieldConfidenceFromTokens, ConfidenceError, type ChosenToken } from './field-confidence'

/**
 * How many alternatives to ask for at each position.
 *
 * One. The chosen token's own probability is the whole input to the confidence derivation —
 * the alternatives are not read, and asking for more would be paying per token for a number
 * nothing consumes.
 */
const LOGPROBS_TOP_K = 1

/**
 * The instruction wrapped around every extraction.
 *
 * Versioned because `extractor_version` on the draft is what the correction-rate report
 * groups by: change the wording and the numbers from before and after must not pool.
 *
 * **Bump this whenever `SYSTEM` or the fencing changes.** 1.1.0 is the injection guard
 * (plan 6.6) — a real change to what the model is told, so its drafts are a different
 * population from 1.0.0's and averaging the two would hide whichever direction it moved.
 */
export const EXTRACTOR_PROMPT_VERSION = '1.1.0'

const SYSTEM = `You read documents for a Bangladeshi garment export factory and return structured data.

${DOCUMENT_GUARD}

Rules:
- Return ONLY the fields the schema asks for.
- If a field is not stated in the document, omit it. Never infer a value from what is
  typical, and never carry a number over from a different line because it looks similar.
- Transcribe quantities, prices and dates exactly as written. Do not convert units, do not
  reformat dates, and do not tidy a style code.
- A number you are unsure of is still better transcribed than guessed at, but your
  uncertainty is measured from your own output — do not hedge in the text.`

/**
 * Gemini's logprob payload, validated rather than trusted.
 *
 * A vendor SDK's types describe what the API is DOCUMENTED to return. This is the only place
 * in the module where an outside system's shape becomes a number that decides whether a row
 * reaches an ERP table, so it gets a zod parse like any other untrusted input.
 */
const logprobsSchema = z.object({
  chosenCandidates: z
    .array(
      z.object({
        token: z.string(),
        logProbability: z.number(),
      }),
    )
    .min(1),
})

/** A network fault, a rate limit or an overload is worth retrying; a bad request is not. */
function classify(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: number })?.status
  const retryable =
    status === 429 ||
    status === 408 ||
    (typeof status === 'number' && status >= 500) ||
    /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)

  return new ProviderError(`gemini: ${message}`, { retryable })
}

export interface GeminiOptions {
  apiKey: string
  /** By role, never hardcoded — the caller reads it from env. */
  model: string
}

export function geminiExtractor({ apiKey, model }: GeminiOptions) {
  const client = new GoogleGenAI({ apiKey })

  return {
    model,

    async extract<T>(request: ExtractRequest<T>): Promise<ExtractResult<T>> {
      if (request.file) {
        // Gemini can read inline PDFs, but this path's logprobs are dead (see the header) —
        // a file read here would produce a value with no measured confidence. The OpenAI
        // extract model is the one that serves files; refusing beats extracting nothing.
        throw new ProviderError(
          'the gemini extract path reads text only — set MARBIM_MODEL_EXTRACT to an OpenAI ' +
            'model (e.g. gpt-4o-mini) for direct PDF/image reading, or paste the text',
          { retryable: false },
        )
      }
      if (!request.input.trim()) {
        // Not retryable: an empty document will still be empty next time, and a job that
        // retries one forever is a queue that never drains.
        throw new ProviderError('nothing to extract from', { retryable: false })
      }

      let response
      try {
        response = await client.models.generateContent({
          model,
          contents: [
            {
              role: 'user',
              // Fenced, not `---`-separated. A buyer's amendment sheet is full of `---`, so
              // the old separator was one a document could forge by accident (audit AI-M3).
              parts: [{ text: `${request.instruction}\n\n${fenceDocument(request.input)}` }],
            },
          ],
          config: {
            systemInstruction: SYSTEM,
            responseMimeType: 'application/json',
            responseJsonSchema: z.toJSONSchema(request.schema),
            // The whole reason this role is Gemini's.
            responseLogprobs: true,
            logprobs: LOGPROBS_TOP_K,
            // Extraction is transcription. Sampling variety is not a feature here, and a
            // deterministic read is one a correction rate can be computed against.
            temperature: 0,
          },
        })
      } catch (error) {
        throw classify(error)
      }

      const candidate = response.candidates?.[0]
      const parsed = logprobsSchema.safeParse(candidate?.logprobsResult)

      if (!parsed.success) {
        /*
         * The fail-closed path, and the one worth reading twice. Returning the extracted
         * value here with a made-up confidence would undo the whole of 6.3 invisibly — the
         * draft would look identical to a measured one in the approve inbox.
         *
         * Not retryable: a model that does not support logprobs will not support them on the
         * next attempt either. This is a configuration error and should surface as a failed
         * job saying so.
         */
        throw new ProviderError(
          `gemini returned no token log-probabilities for ${model}, so nothing measured how ` +
            'sure it was — an extraction cannot carry per-field confidence without them. ' +
            'Use a model that supports responseLogprobs.',
          { retryable: false },
        )
      }

      const tokens: ChosenToken[] = parsed.data.chosenCandidates

      let fieldConfidence: Record<string, number>
      let text: string
      try {
        ;({ fieldConfidence, text } = fieldConfidenceFromTokens(tokens))
      } catch (error) {
        if (error instanceof ConfidenceError) {
          throw new ProviderError(`gemini: ${error.message}`, { retryable: false })
        }
        throw error
      }

      // Parsed from the tokens, not from `response.text`: the two must agree, and the token
      // stream is the one the confidence was computed against. A mismatch would mean the
      // scores are keyed to fields that are not in the payload — which
      // `assertExtractionConfidence` would then reject, correctly but confusingly.
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new ProviderError('gemini returned text that is not JSON', { retryable: true })
      }

      const validated = request.schema.safeParse(value)
      if (!validated.success) {
        throw new ProviderError(
          `gemini returned a value the schema rejects: ${validated.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
          // Retryable: a schema miss is usually a one-off at temperature 0's margins, and a
          // second attempt costs one call against a document a person is waiting on.
          { retryable: true },
        )
      }

      return {
        value: validated.data,
        fieldConfidence,
        // Grouped by in the correction-rate report, so it names the derivation and not just
        // the vendor: two extractors both "gemini" that scored differently would pool.
        method: `gemini/token-logprobs@${EXTRACTOR_PROMPT_VERSION}`,
        model,
        /*
         * The vendor's own count. Third of three providers to have reported it and dropped
         * it — only Anthropic ever filled this in, so the daily token ceiling has been
         * counting chat and nothing else since the ceiling was written.
         *
         * Omitted rather than zeroed when absent: null reads as "not reported", zero reads
         * as "free", and only one of those is true.
         */
        ...(response.usageMetadata
          ? {
              usage: {
                inputTokens: response.usageMetadata.promptTokenCount ?? 0,
                outputTokens: response.usageMetadata.candidatesTokenCount ?? 0,
              },
            }
          : {}),
      }
    },
  }
}
