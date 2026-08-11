/**
 * How the top bar's "Ask MARBIM" button reaches the panel.
 *
 * The panel is mounted once in the shell — it has to be, or the thread would not survive
 * navigation — and the button lives inside the top bar. They are siblings, so neither can
 * hold the other's state. A context provider would work and would also mean wrapping the
 * whole authenticated tree to move one boolean.
 *
 * A window event is the smaller answer: the button announces intent, the panel decides what
 * to do with it. It also means any screen can add its own in-context "Ask MARBIM" button
 * (X.2 asks for those) without touching the shell at all.
 */
export const MARBIM_OPEN_EVENT = 'marbim:open'

/**
 * `prefill` seeds the composer — "Ask about PO-BF-2044: " — WITHOUT sending (adoption
 * plan 1.3). The person finishes the question; a row affordance that fired a canned
 * question would be a button wearing a chat costume, and the half-typed prompt is what
 * teaches the grammar of asking. The code travels because the ref-resolvers accept it.
 */
export function requestMarbimOpen(prefill?: string): void {
  window.dispatchEvent(new CustomEvent(MARBIM_OPEN_EVENT, { detail: prefill ? { prefill } : undefined }))
}
