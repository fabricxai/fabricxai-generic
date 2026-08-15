'use server'

import { revalidatePath } from 'next/cache'
import { headers } from 'next/headers'

import { surfaced, type ActionFailure } from '@/lib/action-failure'
import { requireRole } from '@/modules/core/session'

import {
  assignMachineToLine,
  cancelTicket,
  claimTicket,
  completePm,
  openTicket,
  registerMachine,
  upsertPmSchedule,
  resolveTicket,
} from './service'

function refresh(): void {
  revalidatePath('/maintenance')
  // Resolving a ticket writes downtime minutes back to the line, so the floor's own view
  // of its efficiency is stale the moment a machine starts running again.
  revalidatePath('/lines')
}

/**
 * Report a stopped machine by hand.
 *
 * `line_down` is deliberately not offerable here. That priority is what an AUTOMATIC ticket
 * from a production stoppage *is* — the floor logged the line as stopped and the system
 * raised the ticket. A person choosing it would jump the queue those automatic tickets
 * exist to order, which is how the genuinely dead line ends up third in the list.
 */
export async function reportMachine(input: {
  machineId?: string
  lineId?: string
  priority: 'high' | 'normal'
  notes?: string
}): Promise<{ ticketId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance', 'production')
  return surfaced(async () => {
    const result = await openTicket(ctx, input)
    refresh()
    return { ticketId: result.ticketId }
  })
}

/** A mechanic takes the ticket. One claimant, so two do not walk to the same machine. */
export async function takeTicket(input: {
  ticketId: string
}): Promise<{ status: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    const result = await claimTicket(ctx, input)
    refresh()
    return { status: String(result.status) }
  })
}

/**
 * Machine running — close the ticket.
 *
 * The canvas says it plainly: "resolving writes the downtime minutes back to the line's
 * efficiency, unprompted". A mechanic should not have to file a second thing; the minutes
 * the line lost are a fact of the repair, not a separate report somebody remembers to make.
 *
 * Parts used come off spares stock in the same transaction, because a part fitted and not
 * deducted is a reorder point that never trips.
 */
export async function resolveMachineTicket(input: {
  ticketId: string
  partsUsed?: { partId: string; qty: number }[]
  notes?: string
}): Promise<{ downMinutes: number | null } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    const result = await resolveTicket(ctx, input)
    refresh()
    return { downMinutes: (result as { downMinutes?: number }).downMinutes ?? null }
  })
}

/** Cancel a ticket that should not have been raised. A reason is required. */
export async function dropTicket(input: {
  ticketId: string
  reason: string
}): Promise<{ status: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    const result = await cancelTicket(ctx, input)
    refresh()
    return { status: String(result.status) }
  })
}

/**
 * Tick a preventive-maintenance visit off.
 *
 * The checklist is required and cannot be empty — an empty list is a signature on nothing,
 * and a PM record with no checks is exactly what an auditor finds when a machine that was
 * "serviced" throws a needle through somebody's hand.
 */
export async function markPmDone(input: {
  scheduleId: string
  machineId: string
  completedOn: string
  checked: { step: string; ok: boolean; note?: string }[]
}): Promise<{ alreadyRecorded: boolean } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    const result = await completePm(ctx, input)
    refresh()
    return { alreadyRecorded: result.alreadyRecorded }
  })
}

/** Add a machine to the registry. */
export async function addMachine(input: {
  machineType: string
  brand?: string
  model?: string
  serial?: string
  lineId?: string
}): Promise<{ machineId: string } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    const result = await registerMachine(ctx, input)
    refresh()
    return result
  })
}

/**
 * Move a machine to another line.
 *
 * The PM schedule travels with the MACHINE, not the line — a machine serviced in March is
 * due again in September wherever it happens to be sitting, and a schedule that stayed with
 * the line would reset the clock every time the floor was rebalanced.
 */
export async function moveMachine(input: {
  machineId: string
  lineId: string | null
  on: string
}): Promise<void | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    await assignMachineToLine(ctx, input)
    refresh()
  })
}

/**
 * Define what gets checked on a type of machine, and how often.
 *
 * Re-saving the same (type, cadence) replaces its checklist — see `upsertPmSchedule`. Past
 * completions keep the steps that were actually checked on the day, so editing a schedule
 * never rewrites a service record.
 */
export async function savePmSchedule(input: {
  machineType: string
  cadence: 'daily' | 'weekly' | 'monthly'
  checklist: string[]
}): Promise<{ replaced: boolean } | ActionFailure> {
  const ctx = await requireRole(await headers(), 'maintenance')
  return surfaced(async () => {
    const result = await upsertPmSchedule(ctx, input)
    refresh()
    return { replaced: result.replaced }
  })
}
