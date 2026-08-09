'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { propose } from '@/modules/core/pending-changes'
import { requireRole } from '@/modules/core/session'

import { invoicePayload } from './zod'

/**
 * Ask for a payment to be released (canvas P4: "finance.recordPayment → Approve inbox ·
 * approver: OWNER").
 *
 * A request, not a payment. Money leaving the factory is approved by somebody other than
 * the person who arranged the delivery — that separation is the whole control, and a screen
 * that paid on click would remove it while looking identical.
 *
 * The amount and date travel on the draft, so the owner signs a number rather than a
 * supplier's name.
 */
/**
 * Raise an invoice — as a DRAFT for the approve inbox, never directly.
 *
 * `invoices` was a registered pending target with a commit handler, a zod and an audit
 * mark, and nothing anywhere proposed one (live-test finding, Phase 8): no invoice meant
 * no receivable, so the whole realization chain — the money actually landing — started at
 * a record the product could not create. Same separation as the payable above: the person
 * who typed the commercial invoice is not the person who signs that the factory is owed
 * this money.
 */
export async function raiseInvoice(input: {
  orderId: string
  shipmentId?: string
  number: string
  invoiceDate: string
  value: string
  currency: string
}): Promise<{ pendingChangeId: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'finance', 'commercial')
    const parsed = invoicePayload.parse(input)

    const { id } = await propose(ctx, {
      moduleId: 'finance',
      targetTable: 'invoices',
      operation: 'insert',
      zodSchemaKey: 'invoice',
      // A person read the commercial invoice and typed this. No extractor, no confidence.
      source: 'user_draft',
      payload: { ...parsed },
    })

    revalidatePath('/approve')
    revalidatePath('/finance')

    return { pendingChangeId: id }
  })
}

export async function requestPayablePayment(input: {
  payableId: string
  paidAmount: string
  paidAt: string
}): Promise<{ pendingChangeId: string }> {
  const ctx = await requireRole(await headers(), 'finance', 'commercial')

  const { id } = await propose(ctx, {
    moduleId: 'finance',
    targetTable: 'payables',
    // An update, so the row it changes must be named — and `propose` enforces that an
    // update carries a target while an insert does not.
    targetId: input.payableId,
    operation: 'update',
    zodSchemaKey: 'pay_payable',
    // A person read an invoice and typed this. No extractor, so no field confidence.
    source: 'user_draft',
    payload: { ...input },
  })

  revalidatePath('/approve')
  revalidatePath('/finance')

  return { pendingChangeId: id }
}
