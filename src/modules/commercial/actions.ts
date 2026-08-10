'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import { getPolicy } from '@/modules/settings/service'

import {
  amendLc,
  checkUdBalance,
  createLc as createLcIn,
  createUd as createUdIn,
  linkOrder as linkOrderIn,
  openBtb,
  openSubmission,
  postRealization,
  proposeUdOverride,
  setSubmissionStatus,
  snapshotReconciliation,
  type BankDocsPolicy,
  type RealizationResult,
} from './service'
import type { UdDrawDecision } from './ud'
import { factoryToday } from '@/lib/dates'

/**
 * Record a letter of credit (plan 5.5, audit — every root record must be creatable).
 *
 * `createLc` has existed since 2.1 with **no action over it**, so the credit that every
 * shipment date, every BTB ceiling and every bank presentation is checked against could only
 * arrive by seeding. A factory with no LC on record has an `lcLatestShipment` gate with
 * nothing to check, an EXP submission with no docs checklist to build, and a BTB headroom
 * calculation with no master credit behind it.
 *
 * Commercial and the owner only. An LC is a promise to pay held at a bank, and its two dates
 * — latest shipment and expiry — are the ones every shipment crisis is about.
 *
 * Refusals come back as VALUES. A duplicate credit number and a mis-keyed pair of dates are
 * both things a person can fix in the form in front of them, and production masks anything a
 * server action throws — so both arrived as React error #441 until this was surfaced.
 */
export async function createLc(input: {
  buyerId: string
  number: string
  value: string
  currency: string
  tolerancePct?: string
  issueDate?: string
  latestShipmentDate?: string
  expiryDate?: string
  /** `{ commercial_invoice: true, bl: true }` — a MAP, because 8.1 looks documents up by kind. */
  docsRequired?: Record<string, boolean>
  documentId?: string
}): Promise<{ lcId: string; number: string } | ActionFailure> {
  return surfaced(async () => {
    // Inside the boundary, so "your role does not allow this" is a sentence too.
    const ctx = await requireRole(await headers(), 'commercial')
    const result = await createLcIn(ctx, input)

    revalidatePath('/lcs')
    // The shipment desk reads the credit's dates before it confirms a departure.
    revalidatePath('/shipment')
    return result
  })
}

/**
 * Tie a credit to the order it pays for.
 *
 * The join both the conflict detector and the countdown job run through finally gets its
 * writer — see `linkOrder` in the service for the history. Refusals (a buyer mismatch,
 * a vanished order) come back as values: production masks thrown messages, and "that
 * credit belongs to a different buyer" is a sentence a person must read.
 */
export async function linkLcToOrder(input: {
  lcId: string
  orderId: string
}): Promise<{ linked: boolean; floatDays: number | null } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'commercial')
  return surfaced(async () => {
    const result = await linkOrderIn(ctx, input)
    revalidatePath('/lcs')
    revalidatePath('/orders')
    return result
  })
}

/**
 * Record a customs Utilization Declaration.
 *
 * Also actionless since 2.2, and the consequence is sharper than the LC's: the UD balance
 * gate FAILS CLOSED, so with no declaration on record **no bonded fabric can be issued at
 * all**. A factory running duty-free cloth — which is most of them — would find the store
 * refusing every issue with a gate it had no way to satisfy.
 *
 * The authorised items ARE the declaration: the zod refuses an empty list rather than storing
 * a shell somebody fills in later, because every bonded issue is checked against these
 * quantities and a UD recorded wrong is a gate calibrated wrong.
 */
export async function createUd(input: {
  number: string
  issueDate?: string
  validUntil?: string
  authorizedItems: { itemRef: string; qty: string; unit: string }[]
  documentId?: string
}): Promise<{ udId: string; number: string }> {
  const ctx = await requireRole(await headers(), 'commercial', 'store')
  const result = await createUdIn(ctx, input)

  revalidatePath('/ud')
  // The store's issue screen reads the balance this creates.
  revalidatePath('/store')
  revalidatePath('/store/issue')
  return result
}

/**
 * Ask an owner to authorise an overdraw.
 *
 * Deliberately a request rather than a write. The storekeeper who needs the fabric is never
 * the person who accepts the duty exposure — the canvas puts it plainly: "you are the
 * approver — the request arrives in your inbox, not on this screen".
 */
export async function requestUdOverride(input: {
  udId: string
  itemRef: string
  qty: string
  unit: string
  storeIssueId?: string
  reason: string
}): Promise<{ pendingChangeId: string; decision: UdDrawDecision }> {
  const ctx = await requireRole(await headers(), 'store', 'commercial')
  const result = await proposeUdOverride(ctx, input)

  // The request is in somebody's inbox now; the UD itself has not moved.
  revalidatePath('/approve')

  return result
}

/**
 * Freeze a period's UD balances into a reconciliation snapshot.
 *
 * A write, not a report: the figures a factory hands customs must reproduce a year later,
 * and a live query would drift as the ledger grows. Generating the statement is therefore
 * the act of recording what was declared, which is why it is here and not a page render.
 */
export async function generateUdReconciliation(input: {
  udId: string
  period: string
}): Promise<{ reconciliationId: string }> {
  const ctx = await requireRole(await headers(), 'commercial', 'compliance')
  const result = await snapshotReconciliation(ctx, input)

  revalidatePath('/ud')

  return { reconciliationId: result.reconciliationId }
}

/**
 * Would this draw clear? A read, exposed as an action so a commercial officer can ask
 * before the floor finds out.
 *
 * The gate itself runs again inside the store issue's transaction — this is not a
 * reservation and it does not hold anything. Two storekeepers can both be told yes and the
 * second still be refused, which is correct: the balance is only real at the moment of the
 * draw, and a check that pretended otherwise would be worse than no check.
 */
export async function checkUdDraw(input: {
  udId: string
  itemRef: string
  qty: string
  unit: string
}): Promise<UdDrawDecision> {
  const ctx = await requireRole(await headers(), 'store', 'commercial', 'compliance')
  return checkUdBalance(ctx, input)
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.1 Letters of credit
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record an amendment (canvas P2: "every amendment keeps the value it replaced").
 *
 * The service stores the replaced values rather than overwriting the LC, and re-runs the
 * conflict scan afterwards. Both matter for the same reason: a bank asks what the credit
 * said on the day the goods shipped, and an amendment that quietly rewrote history leaves
 * nobody able to answer.
 */
export async function recordLcAmendment(input: {
  lcId: string
  diff: {
    value?: string
    currency?: string
    tolerancePct?: string
    latestShipmentDate?: string | null
    expiryDate?: string | null
  }
  receivedAt: string
}): Promise<{ amendmentId: string; number: number; tightened: boolean }> {
  const ctx = await requireRole(await headers(), 'commercial')
  const result = await amendLc(ctx, input)

  revalidatePath('/lcs')
  revalidatePath(`/lcs/${input.lcId}`)

  return { amendmentId: result.amendmentId, number: result.number, tightened: result.tightened }
}

/**
 * Open a back-to-back credit against a master LC.
 *
 * `openBtb` refuses past the headroom limit and writes nothing — the canvas says exactly
 * that, and it is a gate rather than a warning because a BTB the master cannot fund is a
 * commitment to a supplier the factory has no money for.
 *
 * The limit comes from the factory's `bankDocs` policy, never from this call. A percentage
 * chosen at the point of opening is a percentage chosen to make this one fit.
 */
export async function openBtbCredit(input: {
  masterLcId: string
  number: string
  value: string
  currency: string
  openedAt?: string
  expiryDate?: string
}): Promise<{ btbLcId: string }> {
  const ctx = await requireRole(await headers(), 'commercial')
  const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')

  const result = await openBtb(ctx, input, policy)

  revalidatePath(`/lcs/${input.masterLcId}`)

  return { btbLcId: result.btbLcId }
}

/**
 * Open a presentation — documents going to the bank.
 *
 * `openSubmission` takes `AnyCtx` because 8.1 opens presentations as a system actor when a
 * shipment's documents are ready. This is the human door onto the same operation, for the
 * presentations nobody's shipment raised automatically.
 */
export async function createSubmission(input: {
  lcId: string
  shipmentId?: string
  docs: string[]
  invoicedAmount?: string
  currency: string
}): Promise<{ submissionId: string } | ActionFailure> {
  // Surfaced: the EXP gate inside `openSubmission` refuses a presentation against a
  // shipment with no EXP number, and that refusal must arrive as its sentence.
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'commercial', 'finance')
    const result = await openSubmission(ctx, {
      lcId: input.lcId,
      ...(input.shipmentId ? { shipmentId: input.shipmentId } : {}),
      docs: input.docs,
      ...(input.invoicedAmount ? { invoicedAmount: input.invoicedAmount } : {}),
      currency: input.currency,
    })

    revalidatePath('/lcs/submissions')
    revalidatePath(`/lcs/${input.lcId}`)

    return result
  })
}

/**
 * Move a presentation along the bank's states.
 *
 * `realized` is deliberately not settable here — the type excludes it. Money arriving is a
 * different event from a document being accepted, it carries an amount and a date, and it
 * posts to finance. Letting a status dropdown mark something realized would create a
 * receivable nobody can reconcile to a bank advice.
 */
export async function updateSubmissionStatus(input: {
  submissionId: string
  lcId: string
  bankStatus: 'preparing' | 'submitted' | 'accepted' | 'discrepant'
  submittedAt?: string
  discrepancyNotes?: string
}): Promise<void | ActionFailure> {
  // Surfaced, with the role gate inside: an illegal transition and a role refusal are
  // both sentences a person needs, and production masks anything thrown (live-test
  // finding, Phase 8). `finance` may move these too — the same pairing the realization
  // below has always had, because the person chasing the bank IS often the finance desk.
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'commercial', 'finance')
    await setSubmissionStatus(ctx, {
      submissionId: input.submissionId,
      bankStatus: input.bankStatus,
      ...(input.submittedAt ? { submittedAt: input.submittedAt } : {}),
      ...(input.discrepancyNotes ? { discrepancyNotes: input.discrepancyNotes } : {}),
      // A discrepancy starts ageing the day it is raised, and the escalation job counts from
      // here. Defaulting it to today rather than leaving it null is what makes the clock real.
      ...(input.bankStatus === 'discrepant'
        ? { discrepantSince: factoryToday() }
        : {}),
    })

    revalidatePath('/lcs/submissions')
    revalidatePath(`/lcs/${input.lcId}`)
  })
}

/**
 * Post a realization — the money landed.
 *
 * The shortfall is computed server-side against the invoiced amount and stored, because
 * bank charges are deducted before crediting and a receivable derived from the invoice
 * alone stays open by the deduction forever. Above the factory's threshold the service
 * demands a written reason: a 12% deduction is not charges, it is a dispute or a discount,
 * and closing the account silently loses the only chance to find out which.
 */
export async function postLcRealization(input: {
  submissionId: string
  lcId: string
  realizedAmount: string
  realizedAt: string
  shortfallReason?: string
}): Promise<RealizationResult | ActionFailure> {
  // Surfaced above all for the shortfall gate: "a deduction this size needs a written
  // reason" is the sentence this whole flow exists to say, and it was reaching the
  // browser as React #441.
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'commercial', 'finance')
    const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')

    const result = await postRealization(
      ctx,
      {
        submissionId: input.submissionId,
        realizedAmount: input.realizedAmount,
        realizedAt: input.realizedAt,
        ...(input.shortfallReason ? { shortfallReason: input.shortfallReason } : {}),
      },
      policy,
    )

    revalidatePath('/lcs/submissions')
    revalidatePath(`/lcs/${input.lcId}`)
    // It posts to the receivable book.
    revalidatePath('/finance')

    return result
  })
}
