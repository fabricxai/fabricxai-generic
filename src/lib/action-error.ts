/**
 * Turning a failed server action into something a person can read.
 *
 * Every service throws `AppError(code, messageKey, details)`, and `messageKey` is exactly
 * the i18n key the reader should see. Across a server-action boundary, though, only
 * `Error.message` survives — Next serialises the message and drops the class, the code and
 * the details. So what reaches a client component is the literal string
 * `conflict: maintenance.errors.serial_exists`.
 *
 * Screens were rendering that. It is not a crash and it is not wrong, but it is a dotted
 * identifier where a sentence should be, and it teaches people that the system talks to
 * itself in front of them.
 *
 * **Parameters do not survive the boundary.** `details` — the serial that collided, the line
 * that was not found — is lost with the class, so the copy here cannot interpolate them.
 * That is why these messages say what happened and where to look rather than naming the
 * value: a message with a visible `{serial}` placeholder in it would be worse than the key.
 * Naming the value needs the action to return a typed failure instead of throwing, which is
 * a larger change than this file.
 */
import { ActionRefused } from './action-failure'
import { DEFAULT_LOCALE, MESSAGES, t, type Locale } from './i18n'
import { notifyOutcome } from './notify'

/** `conflict: maintenance.errors.serial_exists` → `maintenance.errors.serial_exists`. */
const KEYED = /^[a-z_]+:\s*([a-z0-9_]+(?:\.[a-z0-9_]+)+)$/i

/**
 * The sentence to show for a caught action error.
 *
 * Falls back to the raw message when the key is not in the catalogue, rather than to
 * something generic. "Something went wrong" is the least useful sentence in software, and a
 * developer reading a bug report needs the key that was actually thrown.
 */
export function actionErrorMessage(
  error: unknown,
  fallback: string,
  locale: Locale = DEFAULT_LOCALE,
): string {
  /*
   * Announced to the shell's outcome stack as a side effect (live-test feedback, Phase 9:
   * "people can't find out if it actually happened"). Every catch block in the product
   * already calls this to get its sentence — announcing HERE gives every module the
   * edge-of-screen notice without a single call site changing. A refusal (the server
   * said no, in words) and a failure (something broke) show in different tones.
   */
  const announce = (message: string): string => {
    /*
     * Browser only — and this guard is the whole difference between a sentence and a dead
     * screen.
     *
     * Server components call this too: `/procurement/[prId]` turns a failed quote comparison
     * into copy it renders inline. But `notifyOutcome` lives in a `'use client'` module, so
     * merely CALLING its reference during a server render throws "Attempted to call
     * notifyOutcome() from the server" — which the error boundary then shows as React #441
     * with a digest. The screen that was preparing an explanation died producing it, and the
     * page took the whole route down with it.
     */
    if (typeof window !== 'undefined') {
      notifyOutcome(error instanceof ActionRefused ? 'refused' : 'failed', message)
    }
    return message
  }

  if (!(error instanceof Error)) return announce(fallback)

  // A refusal that crossed the boundary as a VALUE (see action-failure.ts) — the only path
  // that still carries real copy in production, where thrown messages are masked.
  if (error instanceof ActionRefused) {
    // The service's own sentence wins over catalogue copy filed under the key — "an order
    // needs a requested ship date" beats "That does not fit what an RFQ accepts."
    if (error.failure.reason) return announce(error.failure.reason)
    const copy = t(locale, error.failure.messageKey)
    if (copy !== error.failure.messageKey) return announce(copy)
    return announce(MESSAGES[DEFAULT_LOCALE][error.failure.messageKey] ?? fallback)
  }

  /*
   * Production's mask for a thrown server error, kept off the screen.
   *
   * When an action throws, Next replaces the message with "Minified React error #441 …" —
   * so the raw text this function would otherwise show is framework boilerplate with an
   * error number in it, the least useful sentence available. The call site's own fallback
   * at least names the act that failed. Actions that return refusals through `surfaced()`
   * never reach this branch; it is the net under the ones that still throw.
   */
  if (/Minified React error #\d|Server Components render/.test(error.message)) {
    return announce(fallback)
  }

  const key = KEYED.exec(error.message)?.[1]
  if (!key) return announce(error.message || fallback)

  // `t` returns the key itself when it has no entry — which is what was being rendered
  // before, so treat it as "no copy exists" rather than as a translation.
  const copy = t(locale, key)
  if (copy !== key) return announce(copy)

  return announce(MESSAGES[DEFAULT_LOCALE][key] ?? error.message)
}
