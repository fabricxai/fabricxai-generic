/**
 * Anthropic — the `reason` role (plan 6.4, audit AI-B1).
 *
 * This is the model that answers a merchandiser's question with the department primers in
 * front of it. The primers are the product: nineteen modules' worth of craft about UD
 * balances, LC latest-shipment conflicts, gazette wage grades and what DHU means on a line —
 * and the value of the copilot is almost entirely how well the model uses them, which is why
 * reasoning is the role that gets the strongest model rather than the cheapest.
 *
 * ## The tool round trip
 *
 * Since 6.5 this carries the real per-tool JSON schema (from the tool's own zod) and replays
 * the conversation properly: an assistant turn that asked for three tools goes back with its
 * OWN `tool_use` blocks, and the answers follow as `tool_result` blocks referencing them by
 * id. Anything else is rewriting the conversation underneath the model, and the API rejects
 * it — correctly.
 *
 * A tool with no schema still gets a permissive object rather than being dropped. Dropping
 * it would silently shrink what the model can ask for; the loop validates every call against
 * the tool's zod before executing it regardless, so the schema here is guidance to the model,
 * never the enforcement.
 */
import Anthropic from '@anthropic-ai/sdk'

import { ProviderError, type TextMessage, type TextRequest, type TextResult } from '../provider'

/**
 * Tool names, across the one API that will not accept ours.
 *
 * Every tool in this platform is `module.name` — `orders.tna_status`, `store.grn_lines` — and
 * the dot is load-bearing: it is how a reader, a log line and the scope check all tell which
 * module a call belongs to. Anthropic requires `^[a-zA-Z0-9_-]{1,128}$`, so a request
 * carrying 116 of them is rejected outright with
 * `tools.0.custom.name: String should match pattern`.
 *
 * That 400 arrives BEFORE any token is generated, so the surface showed "I lost the
 * connection halfway through" — a network story for what was a schema rejection. Every
 * question failed identically, which is what made the copilot look unreachable rather than
 * misconfigured.
 *
 * `.` ↔ `__` because it round-trips exactly: no tool name contains a double underscore
 * (verified across all 116), so decoding cannot merge two distinct tools into one. The
 * encoding is applied in all three places a name crosses the wire — the tool list, the
 * replayed `tool_use` blocks of earlier turns, and the names that come BACK on a call — and
 * the loop above this layer never sees the encoded form.
 */
export const encodeToolName = (name: string): string => name.replaceAll('.', '__')
export const decodeToolName = (name: string): string => name.replaceAll('__', '.')

/**
 * One of our messages as the Messages API wants it.
 *
 * A turn carrying tool calls or tool results becomes a CONTENT ARRAY; a plain turn stays a
 * string. Both are valid, and keeping the simple case simple means the overwhelming majority
 * of turns — a question and an answer — read as what they are on the wire.
 */
export function toAnthropicMessage(message: TextMessage): Anthropic.MessageParam {
  const blocks: Anthropic.ContentBlockParam[] = []

  /*
   * Reasoning first, byte-for-byte as it arrived.
   *
   * Claude Sonnet 5 thinks on every turn whether or not we ask it to, and the thinking block it
   * returns is SIGNED. The API's rule is that an assistant turn must be replayed with its own
   * thinking intact; this file used to read only `text` and `tool_use`, so every turn after the
   * first was handed back to the model with its reasoning amputated. It answered by stopping
   * dead — `end_turn`, no text, no tool call — which the loop above reported as "I lost the
   * connection halfway through". Nothing was lost: we had removed the model's own words from
   * its mouth and asked it to continue the sentence.
   *
   * Position matters as much as presence: thinking precedes the tool_use blocks it reasoned
   * toward. Never edit these — the signature is over the original bytes.
   */
  for (const block of message.reasoning ?? []) {
    blocks.push(block as Anthropic.ContentBlockParam)
  }

  // Results next. Anthropic requires every `tool_result` at the START of the user turn that
  // follows the `tool_use`, before any other content.
  for (const result of message.toolResults ?? []) {
    blocks.push({
      type: 'tool_result',
      tool_use_id: result.id,
      content: result.content,
      ...(result.isError ? { is_error: true } : {}),
    })
  }

  if (message.content) blocks.push({ type: 'text', text: message.content })

  for (const call of message.toolCalls ?? []) {
    // Encoded here too: a replayed turn must name the tool exactly as the request that
    // introduced it did, or the API rejects the history as referring to an unknown tool.
    blocks.push({
      type: 'tool_use',
      id: call.id,
      name: encodeToolName(call.name),
      input: call.args,
    })
  }

  if (blocks.length === 0) {
    // An empty turn is rejected by the API. This is only reachable from a bug in the loop,
    // and a placeholder is a kinder failure than a 400 with no context.
    blocks.push({ type: 'text', text: '(no content)' })
  }

  return { role: message.role, content: blocks }
}

/**
 * Long enough for a full department answer with a table in it, short enough that a runaway
 * generation is a cost line rather than an incident. 6.5 adds the real ceilings (AI-H4).
 */
const MAX_TOKENS = 4_096

function classify(error: unknown): ProviderError {
  const message = error instanceof Error ? error.message : String(error)
  const status = (error as { status?: number })?.status
  const retryable =
    status === 429 ||
    status === 408 ||
    status === 529 ||
    (typeof status === 'number' && status >= 500) ||
    /timeout|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)

  return new ProviderError(`anthropic: ${message}`, { retryable })
}

export interface AnthropicOptions {
  apiKey: string
  model: string
}

export function anthropicReasoner({ apiKey, model }: AnthropicOptions) {
  const client = new Anthropic({ apiKey })

  return {
    model,

    async generate(request: TextRequest): Promise<TextResult> {
      if (request.messages.length === 0) {
        throw new ProviderError('nothing to answer', { retryable: false })
      }

      let response
      try {
        response = await client.messages.create({
          model: request.model ?? model,
          max_tokens: MAX_TOKENS,
          system: request.system,
          messages: request.messages.map(toAnthropicMessage),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  name: encodeToolName(tool.name),
                  description: tool.description,
                  input_schema: (tool.schema as Anthropic.Tool['input_schema']) ?? {
                    type: 'object' as const,
                    additionalProperties: true,
                  },
                })),
              }
            : {}),
        })
      } catch (error) {
        throw classify(error)
      }

      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
        .trim()

      const toolCalls = response.content
        .filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use')
        .map((block) => ({
          id: block.id,
          // Back to the real name before it leaves this file: the loop, the scope check and
          // every log line downstream key off `module.tool`.
          name: decodeToolName(block.name),
          args: (block.input ?? {}) as Record<string, unknown>,
        }))

      // Kept whole and unread — see toAnthropicMessage. `redacted_thinking` carries no readable
      // text at all and must still be replayed, so this selects by what a block ISN'T rather
      // than naming the two kinds we happen to know about today.
      const reasoning = response.content.filter(
        (block) => block.type !== 'text' && block.type !== 'tool_use',
      )

      if (!text && toolCalls.length === 0) {
        // An empty turn with nothing asked for is a failure the surface cannot render, and
        // showing a blank answer bubble reads as "MARBIM has nothing to say about your
        // order book" rather than as the fault it is.
        throw new ProviderError(`anthropic returned an empty turn (${response.stop_reason})`, {
          retryable: true,
        })
      }

      return {
        text,
        toolCalls,
        reasoning,
        model: response.model,
        usage: {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        },
        ...(response.stop_reason ? { stopReason: response.stop_reason } : {}),
      }
    },
  }
}
