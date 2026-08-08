/**
 * A refusal carried ACROSS the server-action boundary, as a value.
 *
 * In production Next.js masks the message of anything a server action THROWS — the client
 * receives "Minified React error #441", whatever the server said. Three live-test findings
 * in a row surfaced that way: a Money precision throw, a costing zod refusal, and markWon's
 * "an order needs a requested ship date". Each was a perfectly good typed sentence that a
 * person needed to read and could not.
 *
 * The framework's own guidance (server-actions guide: "Constrain return values. Action
 * returns are serialized to the client.") is that an EXPECTED failure is data, not an
 * exception. So: services keep throwing `AppError` — that contract is right, and it is what
 * makes gates testable — and the ACTION layer catches it at the boundary and returns this
 * shape instead. Unexpected errors (bugs) still throw and still get masked, which is
 * correct: their message is nobody's business.
 *
 * The client side calls `unwrap()` on the result, which re-throws a local `ActionRefused`
 * that `actionErrorMessage` knows how to read — so existing catch-and-show code keeps
 * working with the real sentence in hand.
 */
import { AppError } from '@/modules/core/errors'

export interface ActionFailure {
  /** Discriminant. Never present on a success payload. */
  failed: true
  /** `AppError.code` — 'validation_failed', 'forbidden', 'conflict', … */
  code: string
  /** i18n key for the catalogue copy. */
  messageKey: string
  /**
   * The one specific sentence, when the service gave one (`details.reason`). Shown in
   * preference to the catalogue copy because "an order needs a requested ship date" beats
   * any generic sentence filed under the key.
   */
  reason?: string
}

/**
 * The boundary translation, for the SERVER side of an action.
 *
 * Wrap the service call: an `AppError` — an expected, typed refusal — comes back as an
 * `ActionFailure` value the client can read; anything else is a genuine bug and stays
 * thrown, where production's masking is correct. Adopt this in every action whose refusal
 * a person needs to read; the modules still throwing surface #441 until they do.
 */
export async function surfaced<T>(work: () => Promise<T>): Promise<T | ActionFailure> {
  try {
    return await work()
  } catch (error) {
    if (error instanceof AppError) {
      const reason = error.details.reason
      return {
        failed: true,
        code: error.code,
        messageKey: error.messageKey,
        ...(typeof reason === 'string' ? { reason } : {}),
      }
    }
    throw error
  }
}

export function isActionFailure(value: unknown): value is ActionFailure {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { failed?: unknown }).failed === true &&
    typeof (value as { messageKey?: unknown }).messageKey === 'string'
  )
}

/** The client-side re-throw. `actionErrorMessage` reads `.failure` for the real copy. */
export class ActionRefused extends Error {
  override readonly name = 'ActionRefused'
  readonly failure: ActionFailure

  constructor(failure: ActionFailure) {
    super(`${failure.code}: ${failure.messageKey}`)
    this.failure = failure
  }
}

/** `unwrap(await someAction(input))` — success passes through, refusal throws locally. */
export function unwrap<T>(result: T | ActionFailure): T {
  if (isActionFailure(result)) throw new ActionRefused(result)
  return result
}
