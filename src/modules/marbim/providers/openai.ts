/**
 * OpenAI — the `embed` role, and the `extract` role when Gemini cannot serve it.
 *
 * 1.6 Order Memory fingerprints a style so a merchandiser quoting a new enquiry can be shown
 * what the factory actually achieved on the three most similar styles it has made. That is a
 * vector search over a `vector(1536)` column, and it is the one role with a hard numeric
 * contract: the width that comes back must be the width the column is.
 *
 * ## The width is checked here as well as by the caller
 *
 * `EmbedRequest.dimensions` exists because a model that quietly returns 768 dims for a
 * vector(1536) column fails per row inside a background job nobody is watching. The seam's
 * comment puts that check on the caller; it is also done here, because the two failures read
 * completely differently — from here it says "the model is configured wrong", from the
 * caller it says "this style could not be fingerprinted", and the first is the one an
 * operator can act on.
 *
 * `text-embedding-3-*` supports a `dimensions` parameter, so the width is requested rather
 * than hoped for. A model that ignores it still gets caught.
 */
import OpenAI from 'openai'
import { z } from 'zod'

import { DOCUMENT_GUARD, fenceDocument } from '../marbim'
import {
  MODEL_READABLE_MIME,
  ProviderError,
  type EmbedRequest,
  type EmbedResult,
  type ExtractFile,
  type ExtractRequest,
  type ExtractResult,
} from '../provider'

import { fieldConfidenceFromTokens, ConfidenceError, type ChosenToken } from './field-confidence'

function classify(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: number })?.status
  const retryable =
    status === 429 ||
    status === 408 ||
    (typeof status === 'number' && status >= 500) ||
    /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)

  return new ProviderError(`openai: ${message}`, { retryable })
}

export interface OpenAiOptions {
  apiKey: string
  model: string
}

export function openAiEmbedder({ apiKey, model }: OpenAiOptions) {
  const client = new OpenAI({ apiKey })

  return {
    model,

    async embed(request: EmbedRequest): Promise<EmbedResult> {
      if (request.inputs.length === 0) {
        throw new ProviderError('nothing to embed', { retryable: false })
      }
      if (request.dimensions <= 0) {
        throw new ProviderError(`cannot embed into ${request.dimensions} dimensions`, {
          retryable: false,
        })
      }
      if (request.inputs.some((input) => !input.trim())) {
        // An empty string embeds to a vector that is near every other empty string, so a
        // blank style would come back as the closest match to every future blank one.
        throw new ProviderError('cannot embed an empty input', { retryable: false })
      }

      let response
      try {
        response = await client.embeddings.create({
          model,
          input: [...request.inputs],
          dimensions: request.dimensions,
        })
      } catch (error) {
        throw classify(error)
      }

      // Sorted by index rather than trusted in order. The seam's contract is "the result
      // vectors come back in the same order", and every caller zips them against its own
      // list of styles — a silent reordering would attach each fingerprint to the wrong
      // garment, which no test downstream could tell from a bad embedding.
      const vectors = [...response.data]
        .sort((a, b) => a.index - b.index)
        .map((row) => row.embedding)

      if (vectors.length !== request.inputs.length) {
        throw new ProviderError(
          `openai returned ${vectors.length} vectors for ${request.inputs.length} inputs`,
          { retryable: true },
        )
      }

      const wrong = vectors.find((vector) => vector.length !== request.dimensions)
      if (wrong) {
        throw new ProviderError(
          `openai ${model} returned ${wrong.length}-dimension vectors, and the column is ` +
            `${request.dimensions} — the embedding model is misconfigured`,
          { retryable: false },
        )
      }

      return {
        vectors,
        model: response.model,
        // Same omission as extract had: embedding a factory's whole order history is a real
        // bill, and the ceiling counted none of it.
        ...(response.usage
          ? { usage: { inputTokens: response.usage.prompt_tokens, outputTokens: 0 } }
          : {}),
      }
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The `extract` role
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Versioned exactly as Gemini's is, and SEPARATELY.
 *
 * `extractor_version` is what the correction-rate report groups by, and two vendors reading
 * the same document are two different populations. Pooling them would average a Gemini
 * mistake against an OpenAI one and call the result "the extractor's accuracy".
 */
export const OPENAI_EXTRACTOR_PROMPT_VERSION = '1.0.0'

/**
 * Deliberately the same words as `gemini.ts`.
 *
 * The instruction is the experiment's control. If the two vendors were told different things,
 * a difference in their correction rates would not tell you which reads documents better —
 * only that they were asked differently.
 */
const EXTRACT_SYSTEM = `You read documents for a Bangladeshi garment export factory and return structured data.

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
 * OpenAI's logprob payload, validated rather than trusted — same reasoning as Gemini's.
 *
 * The shapes differ only in spelling: Gemini nests `chosenCandidates[{token, logProbability}]`,
 * OpenAI returns a flat `content[{token, logprob}]`. The derivation in `field-confidence.ts`
 * cares about neither — it reconstructs the JSON from the token stream and scores the value
 * spans — so the whole vendor difference is the adapter below.
 */
const openAiLogprobsSchema = z.object({
  content: z
    .array(
      z.object({
        token: z.string(),
        logprob: z.number(),
      }),
    )
    .min(1),
})

/**
 * The entire vendor difference, exported so it can be tested without a network call.
 *
 * `field-confidence.ts` reconstructs the JSON from the token stream and scores each value
 * span, which is provider-agnostic — it needs only `{token, logProbability}`. Gemini spells
 * that `logProbability` inside `chosenCandidates`; OpenAI spells it `logprob` inside
 * `content`. Everything else about how a number becomes a confidence is shared, and that is
 * what makes swapping the vendor safe: it changes who read the document, not how sure anybody
 * claims to be.
 */
export function chosenTokensFromOpenAi(
  content: readonly { token: string; logprob: number }[],
): ChosenToken[] {
  return content.map((entry) => ({ token: entry.token, logProbability: entry.logprob }))
}

type UserContentPart = OpenAI.Chat.Completions.ChatCompletionContentPart

/**
 * The user message for an extraction, exported so the file/image branch is testable
 * without a network call.
 *
 * The text part always carries the instruction, and the fenced document text when there is
 * any — a paste alongside a file is a human transcription worth showing the model. The file
 * rides as its own part, verbatim base64: nothing here parses it, which is the entire
 * point — the vendor's own reader sees the same pages a human approver will.
 */
export function extractUserContent<T>(request: ExtractRequest<T>): string | UserContentPart[] {
  const text = `${request.instruction}\n\n${
    request.input.trim()
      ? fenceDocument(request.input)
      : 'Read the attached document. Transcribe exactly what it states.'
  }`

  if (!request.file) return text

  return [{ type: 'text', text }, filePart(request.file)]
}

function filePart(file: ExtractFile): UserContentPart {
  if (file.mimeType === 'application/pdf') {
    return {
      type: 'file',
      file: {
        filename: file.filename,
        file_data: `data:application/pdf;base64,${file.base64}`,
      },
    }
  }
  if (MODEL_READABLE_MIME.has(file.mimeType)) {
    return {
      type: 'image_url',
      image_url: { url: `data:${file.mimeType};base64,${file.base64}` },
    }
  }
  throw new ProviderError(
    `the extract model cannot read ${file.mimeType} — readable types are PDF, JPEG, PNG ` +
      'and WebP. Convert it, or paste its text.',
    { retryable: false },
  )
}

/**
 * OpenAI as the document reader.
 *
 * Gemini held this role because it was "the only one of the three vendors that returns
 * per-token log-probabilities alongside a schema-constrained JSON response". That stopped
 * being true in both directions: OpenAI does return them, and — as of August 2026 — no Gemini
 * model on AI Studio does. Twenty-six were checked; thirteen answer "Logprobs is not enabled
 * for this model", the rest are retired, gated to new accounts, or lack JSON mode.
 *
 * So this exists to keep document intake working WITHOUT weakening the rule that made it
 * hard. Confidence still comes from a measurement — the same geometric mean over the same
 * value spans, computed by the same file. Nothing here invents a number, and the fail-closed
 * path below is the same one: no logprobs, no extraction.
 *
 * ## Why `strict: false`
 *
 * OpenAI's strict structured outputs require every property to be listed in `required`, which
 * would force the model to emit a value for a field the document does not state. Asked for a
 * ship date that is not on the PO, a strict call answers `"shipDate": ""` — a fabricated
 * empty string that zod accepts and a reviewer cannot distinguish from a real blank. Verified
 * against the live API before choosing this.
 *
 * Non-strict, the schema is guidance and the SYSTEM rule above does the omitting — which is
 * exactly how the Gemini path works, and `request.schema.safeParse` below is the real gate in
 * both. Same call with the system prompt returns `{"poNumber":"PO-BF-2044"}` and no invented
 * field.
 */
export function openAiExtractor({ apiKey, model }: OpenAiOptions) {
  const client = new OpenAI({ apiKey })

  return {
    model,

    async extract<T>(request: ExtractRequest<T>): Promise<ExtractResult<T>> {
      if (!request.input.trim() && !request.file) {
        throw new ProviderError('nothing to extract from', { retryable: false })
      }

      let response
      try {
        response = await client.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: EXTRACT_SYSTEM },
            {
              role: 'user',
              // Text is fenced for the same reason as Gemini's: a buyer's amendment sheet
              // is full of `---`, so a plain separator is one a document can forge by
              // accident. A file rides as its own content part — see extractUserContent.
              content: extractUserContent(request),
            },
          ],
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'extraction',
              strict: false,
              schema: z.toJSONSchema(request.schema) as Record<string, unknown>,
            },
          },
          logprobs: true,
          // One. The chosen token's own probability is the whole input to the derivation;
          // alternatives are never read, and asking for more is paying per token for nothing.
          top_logprobs: 1,
          // Extraction is transcription. A deterministic read is one a correction rate can be
          // computed against.
          temperature: 0,
        })
      } catch (error) {
        throw classify(error)
      }

      const choice = response.choices[0]
      const parsed = openAiLogprobsSchema.safeParse(choice?.logprobs)

      if (!parsed.success) {
        /*
         * The fail-closed path. Returning the value with an invented score would undo 6.3
         * invisibly — the draft would be indistinguishable from a measured one in the inbox.
         *
         * Not retryable: a model that does not return logprobs will not return them on the
         * next attempt. This is a configuration error and should surface as a failed job.
         */
        throw new ProviderError(
          `openai returned no token log-probabilities for ${model}, so nothing measured how ` +
            'sure it was — an extraction cannot carry per-field confidence without them. ' +
            'Use a model that supports logprobs.',
          { retryable: false },
        )
      }

      const tokens: ChosenToken[] = chosenTokensFromOpenAi(parsed.data.content)

      let fieldConfidence: Record<string, number>
      let text: string
      try {
        ;({ fieldConfidence, text } = fieldConfidenceFromTokens(tokens))
      } catch (error) {
        if (error instanceof ConfidenceError) {
          throw new ProviderError(`openai: ${error.message}`, { retryable: false })
        }
        throw error
      }

      // Parsed from the tokens, not from `choice.message.content`: the two must agree, and
      // the token stream is what the confidence was computed against.
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new ProviderError('openai returned text that is not JSON', { retryable: true })
      }

      const validated = request.schema.safeParse(value)
      if (!validated.success) {
        throw new ProviderError(
          `openai returned a value the schema rejects: ${validated.error.issues
            .map((issue) => `${issue.path.join('.')} ${issue.message}`)
            .join('; ')}`,
          { retryable: true },
        )
      }

      /*
       * A genuinely uniform measurement, explained rather than refused.
       *
       * `assertExtractionConfidence` treats an all-identical map as a constant, because a
       * constant is what an invented confidence looks like. But a clean digital PDF read at
       * temperature 0 really does emit every token at logprob −0.0, and geometric means of
       * certainty are certainty — the first file-native extraction of this repo's own test
       * kit scored exactly 1 on every field and was rejected for being too obviously right.
       * The scores here come from the token stream a few lines up, so when they happen to
       * agree the honest move is to say why, not to fuzz one so the map looks measured.
       */
      const scores = Object.values(fieldConfidence)
      const uniform = scores.length > 0 && scores.every((score) => score === scores[0])

      return {
        value: validated.data,
        fieldConfidence,
        // A file read and a text read are different populations for the correction-rate
        // report — the first includes the model's own reading of the pixels, the second
        // measures only its reading of somebody's transcription.
        method: request.file
          ? `openai/file-logprobs@${OPENAI_EXTRACTOR_PROMPT_VERSION}`
          : `openai/token-logprobs@${OPENAI_EXTRACTOR_PROMPT_VERSION}`,
        ...(uniform
          ? {
              uniformConfidenceJustification:
                `every field's geometric-mean token log-probability came out ${scores[0]} — ` +
                'measured from the same token stream as the values, not assigned; the model ' +
                'read the whole document at uniform certainty',
            }
          : {}),
        model,
        /*
         * What the vendor says it cost.
         *
         * Reported and then thrown away for as long as this provider has existed: only the
         * Anthropic one filled this in, so the daily token ceiling — which counts from
         * `marbim_call_log` — saw conversations and nothing else. Extraction is the role a
         * factory uses in bulk (two hundred POs in an afternoon is a normal week), and it
         * was the role the budget could not see.
         *
         * Omitted rather than zeroed when the response carries no usage block: a null in
         * the ledger reads as "not reported", and a zero reads as "free".
         */
        ...(response.usage
          ? {
              usage: {
                inputTokens: response.usage.prompt_tokens,
                outputTokens: response.usage.completion_tokens,
              },
            }
          : {}),
      }
    },
  }
}
