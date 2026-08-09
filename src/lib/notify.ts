'use client'

/**
 * The edge-of-screen outcome channel (live-test feedback, Phase 9).
 *
 * Every write already reports its outcome SOMEWHERE — an inline banner beside the form, a
 * toast on one desk — but "somewhere" scrolls out of view, and a person who cannot find
 * the answer to "did that actually happen?" clicks again. This is one channel every screen
 * shares: a plain browser event, listened to by one host in the shell, so a module never
 * imports a toast system — it announces, and the shell shows it at the screen's edge.
 *
 * Wired at the two chokepoints rather than per call site: `actionErrorMessage` announces
 * every refusal and failure the moment a catch block formats one, and `InlineAlert`
 * announces its own success banners as they appear. New screens get the behaviour for
 * free by using the same two things everything already uses.
 */

export type OutcomeKind = 'done' | 'refused' | 'failed'

export const OUTCOME_EVENT = 'fx-outcome'

export interface OutcomeDetail {
  kind: OutcomeKind
  message: string
}

export function notifyOutcome(kind: OutcomeKind, message: string): void {
  if (typeof window === 'undefined' || !message.trim()) return
  window.dispatchEvent(new CustomEvent<OutcomeDetail>(OUTCOME_EVENT, { detail: { kind, message } }))
}
