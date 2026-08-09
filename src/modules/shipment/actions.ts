'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'
import { unassignedCartons } from './queries'
import { getPolicy } from '@/modules/settings/service'

import {
  approvePackingList,
  buildDocChecklist,
  confirmExFactory,
  createShipment,
  generatePackingList,
  handoffDocsToBank,
  loadCartons,
  proposeToleranceOverride,
  setDocStatus,
  setExpNumber,
  type ShipmentPolicy,
  waiveLcDate,
} from './service'

function refresh(): void {
  revalidatePath('/shipment')
  revalidatePath('/orders')
}

/** Open a shipment against an order. Partial shipments are numbered, not implied. */
export async function openShipment(input: {
  orderId: string
  lcId?: string
  partialNo?: number
  plannedExFactory: string
  forwarder?: string
  mode?: 'sea' | 'air'
}): Promise<{ shipmentId: string } | ActionFailure> {
  // Refusals as values (lib/action-failure) — a duplicate partial number is a sentence,
  // and so is a role refusal: requireRole sits INSIDE surfaced throughout this file
  // because production masks anything an action throws (live-test finding, Phase 7 —
  // three React #441s on this screen: two masked 403s and the final-inspection gate).
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment', 'commercial', 'merchandiser')
    const result = await createShipment(ctx, input)
    refresh()
    return result
  })
}

/**
 * Record the EXP number the AD bank issued.
 *
 * `GATES.expNumber` blocks a bank submission without one — it is mandatory per export
 * shipment under Bangladesh Bank rules, and documents presented without it come straight
 * back. Recorded here rather than typed into the presentation, so the number lives on the
 * shipment it belongs to and one shipment cannot be presented under another's EXP.
 */
export async function recordExpNumber(input: {
  shipmentId: string
  expNumber: string
}): Promise<void | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment', 'commercial')
    await setExpNumber(ctx, input)
    refresh()
  })
}

/**
 * Confirm the goods left the factory.
 *
 * Actualises the ex-factory TNA milestone through 1.3 and compares the date against the
 * LC's latest-shipment clause. A shipment that left a day late is still shippable; a
 * shipment that left after the LC's deadline is a discrepancy the bank will raise, and the
 * factory needs to know before the documents go, not after.
 */
export async function confirmShipmentLeft(input: {
  shipmentId: string
  actualExFactory: string
}): Promise<{ lateAgainstLc: boolean } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment', 'commercial')
    const policy = await getPolicy<ShipmentPolicy>(ctx, 'shipment')
    const result = await confirmExFactory(ctx, input, policy)
    refresh()
    return { lateAgainstLc: Boolean((result as { lateAgainstLc?: boolean }).lateAgainstLc) }
  })
}

/**
 * Regenerate the packing list from the cartons.
 *
 * Always regenerable, never edited — the canvas says "from cartons, always regenerable".
 * A packing list somebody corrected by hand is a document that no longer describes what is
 * in the container, and the container is the thing the buyer opens.
 */
export async function regeneratePackingList(input: {
  orderId: string
  shipmentId?: string
}): Promise<{ packingListId: string; version: number } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment')
    const result = await generatePackingList(ctx, input)
    refresh()
    return { packingListId: result.packingListId, version: result.version }
  })
}

/**
 * Approve and lock a packing list version.
 *
 * `acceptMismatches` exists because a list that differs from the order breakdown is
 * sometimes correct — a short shipment inside LC tolerance is a real thing. Accepting it is
 * a deliberate act with a record, not a silent pass.
 */
export async function lockPackingList(input: {
  packingListId: string
  acceptMismatches?: boolean
}): Promise<{ version: number } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment')
    const result = await approvePackingList(ctx, input)
    refresh()
    return { version: result.version }
  })
}

/**
 * Hand the documents to the bank.
 *
 * This is where both gates fire: the EXP number must exist, and the lot's final inspection
 * must have passed. Neither is a warning — documents that reach a bank without an EXP come
 * back, and a lot that failed its own inspection should not be leaving at all.
 */
export async function sendDocsToBank(input: {
  shipmentId: string
}): Promise<{ submitted: string[]; expNumber: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'commercial')
    const result = await handoffDocsToBank(ctx, input)
    refresh()
    revalidatePath('/lcs/submissions')
    return { submitted: result.submitted, expNumber: result.expNumber }
  })
}

/**
 * Ask a manager to accept a quantity discrepancy against the LC.
 *
 * A request, like every other override in the system: the person who packed the container
 * is not the person who accepts the risk of a bank refusing the presentation over it.
 */
export async function requestToleranceException(input: {
  shipmentId: string
  reason: string
}): Promise<{ pendingChangeId: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'commercial', 'merchandiser')
    const result = await proposeToleranceOverride(ctx, input)
    revalidatePath('/approve')
    refresh()
    return result
  })
}

/**
 * Accept, on the record, that this shipment goes against a credit that cannot take its date.
 *
 * The escape hatch for the LC date gate. Owner and commercial only — the credit is
 * commercial's instrument, and the service refuses anyone else with the same message rather
 * than trusting this boundary alone.
 */
export async function acceptLcDateBreach(input: {
  shipmentId: string
  reason: string
}): Promise<{ shipmentId: string; waivedBy: string } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'commercial')
    const result = await waiveLcDate(ctx, input)
    refresh()
    return result
  })
}

/**
 * Load the order's unassigned cartons onto this shipment.
 *
 * Cartons are packed against an ORDER and only later assigned to a container — that split
 * is what makes partial shipments possible, and it is why a freshly packed pallet does not
 * belong to anything yet. The service refuses a carton already on another shipment, and
 * refuses the whole operation once the goods have left, because the manifest after
 * departure is what actually went.
 */
export async function loadOrderCartons(input: {
  shipmentId: string
  orderId: string
}): Promise<{ loaded: number } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment', 'commercial', 'merchandiser')

    const unassigned = await unassignedCartons(ctx, { orderId: input.orderId })

    if (unassigned.length === 0) return { loaded: 0 }

    const result = await loadCartons(ctx, {
      shipmentId: input.shipmentId,
      cartonIds: unassigned.map((c) => c.id),
    })

    refresh()
    return result
  })
}

/**
 * Build the document checklist from the LC's own `docs_required`.
 *
 * Derived from the credit rather than typed, because the credit is what the bank will check
 * against. A checklist somebody assembled from memory is a presentation missing the one
 * certificate this particular buyer's LC asks for, discovered at the counter.
 */
export async function buildShipmentDocChecklist(input: {
  shipmentId: string
}): Promise<{ kinds: string[] } | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment', 'commercial')
    const result = await buildDocChecklist(ctx, input)
    refresh()
    return result
  })
}

/**
 * Mark one document ready — or back to pending.
 *
 * Per document, never "mark them all ready", because that button exists to be pressed by
 * somebody who has not looked. A presentation goes to a bank counter and comes back over a
 * single missing certificate, and the person who ticked the box is the person who should
 * have the certificate in their hand.
 */
export async function markShipmentDoc(input: {
  shipmentId: string
  kind: string
  status: 'pending' | 'ready'
  /**
   * The file itself, uploaded by the caller first.
   *
   * Without this the checklist could not be completed at all: `setDocStatus` refuses any
   * status but `pending` unless a document is attached, and nothing ever attached one. Every
   * document sat pending, so `handoffDocsToBank` had nothing to submit — the whole bank
   * presentation was unreachable through the UI.
   */
  documentId?: string
}): Promise<void | ActionFailure> {
  return surfaced(async () => {
    const ctx = await requireRole(await headers(), 'shipment', 'commercial')
    await setDocStatus(ctx, input)
    refresh()
  })
}
