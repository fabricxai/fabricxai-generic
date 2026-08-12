/**
 * What an exception says to the person who has to act on it.
 *
 * ## Why this exists
 *
 * The owner's two screens — `/home` and `/dashboard` — each had their own version of the
 * same line of code:
 *
 * ```ts
 * Object.entries(detail).map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`).join(' · ')
 * ```
 *
 * which is a JSON object read aloud. What the factory owner actually saw on the first screen
 * of their morning was nine rows of this:
 *
 * ```
 * TNA RISK  a0bc1cae-66e3-4892-a01d-640c4c115d8c
 * status late · orderId 8b98b8dd-b017-4cc3-aac8-c80b00ec8f23 · milestone pp_sample_submit
 * ```
 *
 * Two uuids, a column name, a state machine value, and — the part that matters — no way
 * whatsoever to tell which ORDER is late. Nine problems, none of them identifiable. The
 * information was all present and none of it was legible, which is the worst of both: it
 * looks answerable, so somebody scrolls past it believing they have read it.
 *
 * ## What replaces it
 *
 * A sentence, in one place, used by both screens. The subject a person recognises (the PO
 * number, the credit number) is resolved by the feed query and comes in as `subject`; this
 * turns the rest into words. Where a value has an established translation — a milestone name,
 * a module — it goes through the catalogue rather than being pretty-printed here.
 */
import { t, type Locale } from '@/lib/i18n'

import { milestoneLabel } from './tna'

export interface ExceptionCopyInput {
  kind: string
  /** What the exception is ABOUT, already resolved to something a person names it by. */
  subject: string | null
  detail: Record<string, string | number | boolean | null> | null
}

/** The kind, as a department would say it. */
export function exceptionKindLabel(kind: string, locale: Locale): string {
  const KINDS: Record<string, string> = {
    lc_conflict: 'Letter of credit',
    tna_risk: 'Schedule',
    cap_critical: 'Corrective action',
    runrate_miss: 'Run rate',
    approval_waiting: 'Waiting for approval',
    payroll_anomaly: 'Payroll',
  }
  return KINDS[kind] ?? t(locale, `analytics.exceptions.${kind}`)
}

const str = (v: unknown): string | null =>
  v === null || v === undefined || v === '' ? null : String(v)

/**
 * One sentence: what is true, and why it matters.
 *
 * Falls back to the kind's own label rather than to a dump. A detail this does not recognise
 * is a detail nobody has written words for yet, and the honest thing is to say less rather
 * than to print the object — an unreadable explanation is not more informative than none.
 */
export function describeException(input: ExceptionCopyInput, locale: Locale): string {
  const d = input.detail ?? {}
  const subject = input.subject

  switch (input.kind) {
    case 'tna_risk': {
      const milestone = str(d.milestone)
      const step = milestone ? milestoneLabel(milestone, locale) : 'A milestone'
      const planned = str(d.plannedDate)
      const late = str(d.status) === 'late'
      const who = subject ? `${subject} — ` : ''
      return planned
        ? `${who}${step} was due ${planned} and is ${late ? 'past due' : 'at risk'}.`
        : `${who}${step} is ${late ? 'past due' : 'at risk'}.`
    }

    case 'lc_conflict': {
      const number = str(d.lcNumber) ?? subject
      const latest = str(d.latestShipmentDate)
      return latest
        ? `${number ?? 'A credit'} must ship by ${latest} and the order is not on course to.`
        : `${number ?? 'A credit'} has a date conflict against the order it pays for.`
    }

    case 'cap_critical': {
      const deadline = str(d.deadline)
      const who = subject ? `${subject}: ` : ''
      return deadline
        ? `${who}a critical audit finding is still open, due ${deadline}.`
        : `${who}a critical audit finding is still open.`
    }

    case 'approval_waiting': {
      const where = str(d.moduleId)
      return where
        ? `A ${where} draft has been waiting in the approve inbox with nobody on it.`
        : 'A draft has been waiting in the approve inbox with nobody on it.'
    }

    case 'runrate_miss':
      return subject
        ? `${subject} is running below the rate it needs to ship on time.`
        : 'A line is running below the rate it needs to ship on time.'

    case 'payroll_anomaly':
      return subject
        ? `${subject} has a wage figure outside what the gazette grade explains.`
        : 'A wage figure is outside what the gazette grade explains.'

    default:
      return exceptionKindLabel(input.kind, locale)
  }
}
