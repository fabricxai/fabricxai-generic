/**
 * 9.1 Machines & Tickets — service layer.
 *
 * This module runs at 2am on a floor with a stopped line, so almost every decision here is
 * about what to do when the data and the world disagree. Two of them are worth naming.
 *
 * **A ticket is raised by the system.** 6.1 emits a machine stoppage and this module opens
 * the ticket and links back. A supervisor with a dead line does not go and file paperwork,
 * and a maintenance system that only knows about the breakdowns somebody remembered to
 * report has no idea which machines actually break.
 *
 * **A resolution is never blocked by a stock count.** If a mechanic fits two loopers and the
 * store believed it had one, the work happened — refusing to record it would leave a
 * resolved machine as an open ticket for the sake of a counter. The shortfall is recorded on
 * the ticket and emitted, so the discrepancy is visible instead of buried in a negative
 * number that would silently corrupt every reorder list afterwards.
 */
import { and, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm'

import { money, type Money } from '@/lib/money'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, conflict, notFound } from '../core/errors'
import { notify } from '../core/notifications'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { withTenantRead, withTenantTx, type TenantDb } from '../core/tenancy'

import { MAINTENANCE_EVENTS } from './events'
import {
  breakdownOutliers,
  estimatedDowntimeLoss,
  MaintenanceError,
  pmDueList,
  reorderList,
  utilizationPct,
  type BreakdownOutlier,
  type PmDue,
  type ReorderLine,
} from './maintenance'
import {
  downtimeCosts,
  machines,
  pmCompletions,
  pmSchedules,
  spareParts,
  tickets,
} from './schema'
import {
  autoTicketInput,
  claimTicketInput,
  completePmInput,
  pmScheduleInput,
  machineInput,
  manualTicketInput,
  monthlyCostInput,
  resolveTicketInput,
} from './zod'

/** ⚖-adjacent: a downtime cost is a taka figure that reaches an owner's monthly report. */
registerAuditedTables('downtime_costs')

/**
 * open → claimed → resolved. Either of the first two may be cancelled.
 *
 * `resolved` is terminal on purpose. A machine that breaks again is a NEW breakdown — the
 * thing this module exists to count — and reopening the old ticket would hide a machine
 * failing weekly behind one long-running ticket.
 */
export const ticketMachine = defineStateMachine({
  field: 'status',
  initial: 'open',
  transitions: {
    open: ['claimed', 'cancelled'],
    claimed: ['resolved', 'cancelled'],
    resolved: [],
    cancelled: [],
  },
})

export type TicketStatus = (typeof ticketMachine.states)[number]

/** Company policy. Owned by X.3 Settings; passed in until each caller reads it from there. */
export interface MaintenancePolicy {
  /** What one minute of a stopped line is worth. No default — see `estimatedDowntimeLoss`. */
  lineValuePerMinute: Money
  /** Fleet tickets in the window before the outlier report says anything. */
  minFleetTickets: number
  /** Times the median a machine must reach to be called an outlier. */
  outlierMultiple: number
  /** Absolute ticket floor, which is what decides when the median is zero. */
  outlierMinTickets: number
}

function wrapMaintenanceError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof MaintenanceError) {
      throw new AppError('validation_failed', 'maintenance.errors.invalid', {
        reason: error.message,
      })
    }
    throw error
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Machines
// ─────────────────────────────────────────────────────────────────────────────

export async function registerMachine(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ machineId: string }> {
  const payload = machineInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    if (payload.lineId) await assertLine(ctx, tx, payload.lineId)

    if (payload.serial) {
      const [existing] = await tx
        .select({ id: machines.id })
        .from(machines)
        .where(scoped(machines, ctx, eq(machines.serial, payload.serial)))

      // A typed conflict rather than the `machines_company_serial_key` violation. Serials
      // are copied off a plate by hand and collide for ordinary reasons — and the second
      // row would split a machine's service history in two, so the newer one looks
      // overdue and the older one looks maintained.
      if (existing) {
        throw conflict('maintenance.errors.serial_exists', { serial: payload.serial })
      }
    }

    const [row] = await tx
      .insert(machines)
      .values({
        companyId: ctx.companyId,
        machineType: payload.machineType,
        brand: payload.brand ?? null,
        model: payload.model ?? null,
        serial: payload.serial ?? null,
        purchasedAt: payload.purchasedAt ?? null,
        lineId: payload.lineId ?? null,
        assignmentHistory: payload.lineId
          ? [{ lineId: payload.lineId, from: payload.assignedFrom ?? null, to: null }]
          : [],
        createdBy: ctx.userId,
      })
      .returning({ id: machines.id })

    if (!row) throw new Error('machines insert returned nothing')
    return { machineId: row.id }
  })
}

/**
 * Move a machine to a line, appending to its history.
 *
 * The history is appended, never rewritten. A machine that keeps moving between lines is
 * itself a finding — often the reason it keeps breaking — and the current `line_id` alone
 * cannot show that.
 */
export async function assignMachineToLine(
  ctx: RequestCtx,
  input: { machineId: string; lineId: string | null; on: string },
): Promise<{ machineId: string }> {
  return withTenantTx(ctx, async (tx) => {
    const [machine] = await tx
      .select()
      .from(machines)
      .where(scoped(machines, ctx, eq(machines.id, input.machineId)))
      .for('update')
    if (!machine) throw notFound('maintenance.errors.machine_not_found', { id: input.machineId })

    if (input.lineId) await assertLine(ctx, tx, input.lineId)

    const history = [...(machine.assignmentHistory as { lineId: string; to: string | null }[])]
    const open = history.find((entry) => entry.to === null)
    if (open) open.to = input.on
    if (input.lineId) history.push({ lineId: input.lineId, from: input.on, to: null } as never)

    await tx
      .update(machines)
      .set({ lineId: input.lineId, assignmentHistory: history, updatedAt: new Date() })
      .where(scoped(machines, ctx, eq(machines.id, machine.id)))

    return { machineId: machine.id }
  })
}

/**
 * A line id read under tenant scope before anything references it.
 *
 * Postgres runs foreign-key checks with RLS bypassed, so the FK alone would accept another
 * factory's line perfectly happily and quietly attach this company's machine to it.
 */
// `ctx` on both: these two exist because a foreign key is checked with RLS bypassed, so
// the query proving ownership had better name the company itself (plan 1.3).
async function assertLine(ctx: AnyCtx, tx: TenantDb, lineId: string): Promise<void> {
  const { lines } = await import('@/modules/planning/schema')
  const [line] = await tx.select({ id: lines.id }).from(lines).where(scoped(lines, ctx, eq(lines.id, lineId)))
  if (!line) throw notFound('maintenance.errors.line_not_found', { lineId })
}

// ─────────────────────────────────────────────────────────────────────────────
// Tickets
// ─────────────────────────────────────────────────────────────────────────────

export interface TicketResult {
  ticketId: string
  status: TicketStatus
  /** False when this stoppage already had a ticket — a redelivered event. */
  created: boolean
}

/**
 * Open a ticket from a 6.1 machine stoppage. Always `line_down`.
 *
 * The priority is not a judgement: the event only fires for `reason = 'machine'`, and a
 * machine stoppage means the line is not sewing. Letting this be configurable would let a
 * stopped line be filed as routine.
 *
 * Idempotent on the downtime id. The outbox redelivers freely and one stoppage must not
 * become three tickets, which would then read as three breakdowns in the outlier report.
 */
export async function openTicketFromDowntime(
  ctx: AnyCtx,
  input: unknown,
): Promise<TicketResult> {
  const payload = autoTicketInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [existing] = await tx
      .select()
      .from(tickets)
      .where(scoped(tickets, ctx, eq(tickets.downtimeId, payload.downtimeId)))

    if (existing) {
      return { ticketId: existing.id, status: existing.status as TicketStatus, created: false }
    }

    // The machine id travels on the event and belongs to this company or it does not exist.
    if (payload.machineId) await assertMachine(ctx, tx, payload.machineId)
    await assertLine(ctx, tx, payload.lineId)

    const [row] = await tx
      .insert(tickets)
      .values({
        companyId: ctx.companyId,
        machineId: payload.machineId ?? null,
        downtimeId: payload.downtimeId,
        lineId: payload.lineId,
        source: 'downtime_auto',
        priority: 'line_down',
        status: 'open',
        reportedAt: new Date(payload.startedAt),
        notes: payload.note ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: tickets.id })

    if (!row) throw new Error('tickets insert returned nothing')

    await emit(ctx, tx, {
      eventName: MAINTENANCE_EVENTS.ticketOpened,
      payload: {
        ticketId: row.id,
        machineId: payload.machineId ?? null,
        lineId: payload.lineId,
        priority: 'line_down',
        source: 'downtime_auto',
      },
      aggregateTable: 'tickets',
      aggregateId: row.id,
    })

    /*
     * The Ticket app's loud buzz (mobile contract §3): a line-down ticket is a line making
     * nothing, and a mechanic who hears about it in the corridor an hour later is the
     * exact failure the auto-ticket exists to prevent. Role-addressed — whoever is on
     * shift claims it, and claim already notifies the reporter back.
     */
    await notify(ctx, {
      role: 'maintenance',
      kind: 'maintenance.ticket.opened',
      severity: 'critical',
      titleKey: 'maintenance.notifications.ticket_opened.title',
      params: {},
      moduleId: 'maintenance',
      entityTable: 'tickets',
      entityId: row.id,
      href: '/maintenance',
      dedupeKey: `ticket-opened:${row.id}`,
      channels: ['in_app', 'push'],
    })

    return { ticketId: row.id, status: 'open' as const, created: true }
  })
}

export async function openTicket(ctx: RequestCtx, input: unknown): Promise<TicketResult> {
  const payload = manualTicketInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    if (payload.machineId) await assertMachine(ctx, tx, payload.machineId)
    if (payload.lineId) await assertLine(ctx, tx, payload.lineId)

    const [row] = await tx
      .insert(tickets)
      .values({
        companyId: ctx.companyId,
        machineId: payload.machineId ?? null,
        lineId: payload.lineId ?? null,
        source: 'manual',
        priority: payload.priority,
        status: 'open',
        notes: payload.notes ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: tickets.id })

    if (!row) throw new Error('tickets insert returned nothing')

    await emit(ctx, tx, {
      eventName: MAINTENANCE_EVENTS.ticketOpened,
      payload: {
        ticketId: row.id,
        machineId: payload.machineId ?? null,
        lineId: payload.lineId ?? null,
        priority: payload.priority,
        source: 'manual',
      },
      aggregateTable: 'tickets',
      aggregateId: row.id,
    })

    return { ticketId: row.id, status: 'open' as const, created: true }
  })
}

async function assertMachine(ctx: AnyCtx, tx: TenantDb, machineId: string): Promise<void> {
  const [machine] = await tx.select({ id: machines.id }).from(machines).where(scoped(machines, ctx, eq(machines.id, machineId)))
  if (!machine) throw notFound('maintenance.errors.machine_not_found', { id: machineId })
}

/**
 * A mechanic takes the ticket.
 *
 * `FOR UPDATE` then the state machine: two mechanics tapping claim on the same line-down
 * ticket is the normal case, not the exotic one, and the second must find it already
 * claimed rather than overwrite the first.
 */
export async function claimTicket(ctx: RequestCtx, input: unknown): Promise<TicketResult> {
  const payload = claimTicketInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(scoped(tickets, ctx, eq(tickets.id, payload.ticketId)))
      .for('update')
    if (!ticket) throw notFound('maintenance.errors.ticket_not_found', { id: payload.ticketId })

    ticketMachine.assert(ticket.status as TicketStatus, 'claimed')

    await tx
      .update(tickets)
      .set({ status: 'claimed', claimedBy: ctx.userId, claimedAt: new Date(), updatedAt: new Date() })
      .where(scoped(tickets, ctx, eq(tickets.id, ticket.id)))

    /*
     * Tell the reporter somebody is coming (adoption plan 2.4).
     *
     * The auto-raised ticket meant a supervisor with a dead line did not file paperwork
     * twice — and then heard nothing until the machine ran. The moment between "reported"
     * and "resolved" is exactly when a line is standing and its supervisor is deciding
     * whether to walk to maintenance themselves. Addressed to the person who raised it
     * when one is recorded, else to the production desk; a ticket raised by the mechanic
     * about their own work notifies nobody.
     */
    if (ticket.createdBy && ticket.createdBy !== ctx.userId) {
      await notify(ctx, {
        userId: ticket.createdBy,
        kind: 'maintenance.ticket.claimed',
        titleKey: 'maintenance.notifications.ticket_claimed.title',
        params: {},
        moduleId: 'maintenance',
        entityTable: 'tickets',
        entityId: ticket.id,
        href: '/maintenance',
        // The Hour app's buzz (mobile contract §3): the supervisor who reported a stopped
        // line learns a mechanic is coming while still standing at the machine.
        channels: ['in_app', 'push'],
      })
    }

    return { ticketId: ticket.id, status: 'claimed' as const, created: false }
  })
}

export interface ResolveResult extends TicketResult {
  /** Parts used for which the store had fewer than the mechanic fitted. */
  shortfalls: { partId: string; name: string; used: number; onHand: number; shortfall: number }[]
}

/**
 * The machine runs again.
 *
 * Spare parts come off the shelf here, and this is the one place the module deliberately
 * accepts an inconsistency: if the mechanic fitted more than the store believed it had, the
 * work still happened. Refusing the resolution would leave a running machine showing as an
 * open line-down ticket because a counter was stale, which is the wrong thing to optimise on
 * a factory floor at 2am.
 *
 * What it will NOT do is write a negative stock level. `on_hand` floors at zero, the
 * shortfall is recorded on the ticket and emitted for somebody to reconcile, and every
 * reorder list afterwards is computed from a number that is at least not a lie.
 */
export async function resolveTicket(ctx: RequestCtx, input: unknown): Promise<ResolveResult> {
  const payload = resolveTicketInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(scoped(tickets, ctx, eq(tickets.id, payload.ticketId)))
      .for('update')
    if (!ticket) throw notFound('maintenance.errors.ticket_not_found', { id: payload.ticketId })

    ticketMachine.assert(ticket.status as TicketStatus, 'resolved')

    const shortfalls: ResolveResult['shortfalls'] = []
    const recorded: unknown[] = []

    for (const used of payload.partsUsed) {
      const [part] = await tx
        .select()
        .from(spareParts)
        .where(scoped(spareParts, ctx, eq(spareParts.id, used.partId)))
        .for('update')
      if (!part) throw notFound('maintenance.errors.part_not_found', { partId: used.partId })

      const shortfall = Math.max(0, used.qty - part.onHand)
      if (shortfall > 0) {
        shortfalls.push({
          partId: part.id,
          name: part.name,
          used: used.qty,
          onHand: part.onHand,
          shortfall,
        })
      }

      await tx
        .update(spareParts)
        .set({ onHand: Math.max(0, part.onHand - used.qty), updatedAt: new Date() })
        .where(scoped(spareParts, ctx, eq(spareParts.id, part.id)))

      recorded.push({ partId: part.id, name: part.name, qty: used.qty, shortfall })
    }

    await tx
      .update(tickets)
      .set({
        status: 'resolved',
        resolvedAt: new Date(),
        partsUsed: recorded,
        notes: payload.notes ?? ticket.notes,
        updatedAt: new Date(),
      })
      .where(scoped(tickets, ctx, eq(tickets.id, ticket.id)))

    await emit(ctx, tx, {
      eventName: MAINTENANCE_EVENTS.ticketResolved,
      payload: {
        ticketId: ticket.id,
        machineId: ticket.machineId,
        downtimeId: ticket.downtimeId,
        partsUsed: recorded,
      },
      aggregateTable: 'tickets',
      aggregateId: ticket.id,
    })

    if (shortfalls.length > 0) {
      // Emitted rather than logged: somebody has to go and count the shelf, and a console
      // line in a worker is not a task anybody is given.
      await emit(ctx, tx, {
        eventName: MAINTENANCE_EVENTS.partsShortfall,
        payload: { ticketId: ticket.id, shortfalls },
        aggregateTable: 'tickets',
        aggregateId: ticket.id,
      })
    }

    if (ticket.createdBy && ticket.createdBy !== ctx.userId) {
      /*
       * Claim already told the reporter help was coming; this closes the loop — a line
       * supervisor who reported a stoppage learns it is fixed without walking over to
       * look. Resolve never notified at all before the Hour app needed the buzz.
       */
      await notify(ctx, {
        userId: ticket.createdBy,
        kind: 'maintenance.ticket.resolved',
        titleKey: 'maintenance.notifications.ticket_resolved.title',
        params: {},
        moduleId: 'maintenance',
        entityTable: 'tickets',
        entityId: ticket.id,
        href: '/maintenance',
        channels: ['in_app', 'push'],
      })
    }

    return { ticketId: ticket.id, status: 'resolved' as const, created: false, shortfalls }
  })
}

export async function cancelTicket(
  ctx: RequestCtx,
  input: { ticketId: string; reason: string },
): Promise<TicketResult> {
  return withTenantTx(ctx, async (tx) => {
    const [ticket] = await tx
      .select()
      .from(tickets)
      .where(scoped(tickets, ctx, eq(tickets.id, input.ticketId)))
      .for('update')
    if (!ticket) throw notFound('maintenance.errors.ticket_not_found', { id: input.ticketId })

    ticketMachine.assert(ticket.status as TicketStatus, 'cancelled')

    await tx
      .update(tickets)
      .set({
        status: 'cancelled',
        notes: [ticket.notes, `cancelled: ${input.reason}`].filter(Boolean).join('\n'),
        updatedAt: new Date(),
      })
      .where(scoped(tickets, ctx, eq(tickets.id, ticket.id)))

    return { ticketId: ticket.id, status: 'cancelled' as const, created: false }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Preventive maintenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What is due today, per MACHINE.
 *
 * Schedules are per machine type, so the cross-product is built here: every machine of a
 * type inherits every schedule for that type, and its own last completion decides whether
 * it is due. A machine with no completion at all comes back due today.
 */
export async function pmDue(ctx: AnyCtx, today: string): Promise<(PmDue & { machineType: string })[]> {
  return withTenantRead(ctx, async (tx) => {
    const schedules = await tx.select().from(pmSchedules)
    if (schedules.length === 0) return []

    const fleet = await tx
      .select({ id: machines.id, machineType: machines.machineType })
      .from(machines)
      .where(scoped(machines, ctx, inArray(machines.machineType, schedules.map((s) => s.machineType))))

    const completions = await tx
      .select({
        machineId: pmCompletions.machineId,
        scheduleId: pmCompletions.scheduleId,
        completedOn: sql<string>`max(${pmCompletions.completedOn})`,
      })
      .from(pmCompletions)
      .groupBy(pmCompletions.machineId, pmCompletions.scheduleId)

    const lastBy = new Map(
      completions.map((row) => [`${row.machineId}|${row.scheduleId}`, row.completedOn]),
    )

    const rows = fleet.flatMap((machine) =>
      schedules
        .filter((schedule) => schedule.machineType === machine.machineType)
        .map((schedule) => ({
          scheduleId: schedule.id,
          machineId: machine.id,
          cadence: schedule.cadence,
          lastCompletedOn: lastBy.get(`${machine.id}|${schedule.id}`) ?? null,
        })),
    )

    const due = wrapMaintenanceError(() => pmDueList(rows, today))
    const typeById = new Map(fleet.map((machine) => [machine.id, machine.machineType]))

    return due.map((entry) => ({ ...entry, machineType: typeById.get(entry.machineId) ?? '' }))
  })
}

/**
 * Define what gets checked on a type of machine, and how often.
 *
 * Nothing created these rows before this. `pmDue` returns an empty list when no schedule
 * exists, so a factory with forty-eight machines and no schedules saw "nothing is due" every
 * day, correctly and uselessly — the whole preventive-maintenance feature was inert because
 * there was no way to say what preventive maintenance meant.
 *
 * One schedule per (type, cadence): the unique index says so, and re-saving replaces the
 * checklist rather than creating a second. Two weekly schedules for overlocks would put
 * every overlock on the list twice with different steps, and a mechanic would sign one.
 *
 * **Past completions are untouched.** A checklist that changes does not invalidate services
 * already recorded against the old one — `pm_completions` stores the steps that were
 * actually checked, so a visit stays readable as what was done that day.
 */
export async function upsertPmSchedule(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ scheduleId: string; replaced: boolean }> {
  const payload = pmScheduleInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [existing] = await tx
      .select({ id: pmSchedules.id })
      .from(pmSchedules)
      .where(scoped(pmSchedules, ctx, 
        and(
          eq(pmSchedules.machineType, payload.machineType),
          eq(pmSchedules.cadence, payload.cadence),
        ),
      ))

    if (existing) {
      await tx
        .update(pmSchedules)
        .set({ checklist: payload.checklist, updatedAt: new Date() })
        .where(scoped(pmSchedules, ctx, eq(pmSchedules.id, existing.id)))

      return { scheduleId: existing.id, replaced: true }
    }

    const [row] = await tx
      .insert(pmSchedules)
      .values({
        companyId: ctx.companyId,
        machineType: payload.machineType,
        cadence: payload.cadence,
        checklist: payload.checklist,
        createdBy: ctx.userId,
      })
      .returning({ id: pmSchedules.id })

    if (!row) throw new Error('pm_schedules insert returned nothing')
    return { scheduleId: row.id, replaced: false }
  })
}

/** Every schedule, and how many machines each one covers. */
export async function pmSchedulesWithReach(
  ctx: AnyCtx,
): Promise<{ id: string; machineType: string; cadence: string; checklist: string[]; machines: number }[]> {
  return withTenantRead(ctx, async (tx) => {
    const schedules = await tx.select().from(pmSchedules).orderBy(pmSchedules.machineType)

    const counts = await tx
      .select({ machineType: machines.machineType, n: sql<number>`count(*)`.mapWith(Number) })
      .from(machines)
      .groupBy(machines.machineType)

    const byType = new Map(counts.map((c) => [c.machineType, c.n]))

    return schedules.map((schedule) => ({
      id: schedule.id,
      machineType: schedule.machineType,
      cadence: schedule.cadence,
      checklist: (schedule.checklist ?? []).filter((s): s is string => typeof s === 'string'),
      // Zero is worth showing: a schedule for a machine type the factory does not own is a
      // typo in the type name, and it silently covers nothing.
      machines: byType.get(schedule.machineType) ?? 0,
    }))
  })
}

export async function completePm(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ completionId: string; alreadyRecorded: boolean }> {
  const payload = completePmInput.parse(input)

  return withTenantTx(ctx, async (tx) => {
    const [schedule] = await tx
      .select()
      .from(pmSchedules)
      .where(scoped(pmSchedules, ctx, eq(pmSchedules.id, payload.scheduleId)))
    if (!schedule) {
      throw notFound('maintenance.errors.schedule_not_found', { id: payload.scheduleId })
    }

    const [machine] = await tx.select().from(machines).where(scoped(machines, ctx, eq(machines.id, payload.machineId)))
    if (!machine) throw notFound('maintenance.errors.machine_not_found', { id: payload.machineId })

    if (machine.machineType !== schedule.machineType) {
      // A checklist for an overlock signed off against a button-holer records a service that
      // did not happen, on a machine that then looks maintained.
      throw new AppError('validation_failed', 'maintenance.errors.schedule_type_mismatch', {
        machineType: machine.machineType,
        scheduleType: schedule.machineType,
      })
    }

    const [existing] = await tx
      .select()
      .from(pmCompletions)
      .where(scoped(pmCompletions, ctx, 
        and(
          eq(pmCompletions.machineId, payload.machineId),
          eq(pmCompletions.scheduleId, payload.scheduleId),
          eq(pmCompletions.completedOn, payload.completedOn),
        ),
      ))

    // A double-tap on a handset is not a second service.
    if (existing) return { completionId: existing.id, alreadyRecorded: true }

    const [row] = await tx
      .insert(pmCompletions)
      .values({
        companyId: ctx.companyId,
        scheduleId: payload.scheduleId,
        machineId: payload.machineId,
        completedOn: payload.completedOn,
        checked: payload.checked,
        createdBy: ctx.userId,
      })
      .returning({ id: pmCompletions.id })

    if (!row) throw new Error('pm_completions insert returned nothing')

    await emit(ctx, tx, {
      eventName: MAINTENANCE_EVENTS.pmCompleted,
      payload: {
        completionId: row.id,
        machineId: payload.machineId,
        scheduleId: payload.scheduleId,
        completedOn: payload.completedOn,
      },
      aggregateTable: 'pm_completions',
      aggregateId: row.id,
    })

    return { completionId: row.id, alreadyRecorded: false }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reports
// ─────────────────────────────────────────────────────────────────────────────

export async function lowStock(ctx: AnyCtx): Promise<ReorderLine[]> {
  return withTenantRead(ctx, async (tx) => {
    const parts = await tx.select().from(spareParts)
    return wrapMaintenanceError(() =>
      reorderList(
        parts.map((part) => ({
          partId: part.id,
          name: part.name,
          onHand: part.onHand,
          minLevel: part.minLevel,
        })),
      ),
    )
  })
}

/**
 * Machine stoppage minutes and what they cost, per machine, for one month.
 *
 * Reads 6.1's `downtimes` — the owner module's table, through its own columns, never
 * recomputed here. Only CLOSED stoppages are counted: an open one has no duration yet, and
 * treating "started an hour ago" as an hour of loss would make the figure move every time
 * the report was run.
 */
export async function compileMonthlyDowntimeCosts(
  ctx: AnyCtx,
  input: unknown,
  policy: MaintenancePolicy,
): Promise<{ forMonth: string; machines: number; totalMinutes: number }> {
  const payload = monthlyCostInput.parse(input)
  const { downtimes } = await import('@/modules/production/schema')

  const monthStart = payload.forMonth
  const start = new Date(`${monthStart}T00:00:00Z`)
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1))

  return withTenantTx(ctx, async (tx) => {
    const rows = await tx
      .select({
        machineId: downtimes.machineId,
        minutes: sql<string>`coalesce(sum(extract(epoch from (${downtimes.endedAt} - ${downtimes.startedAt})) / 60), 0)`,
      })
      .from(downtimes)
      .where(scoped(downtimes, ctx, 
        and(
          eq(downtimes.reason, 'machine'),
          sql`${downtimes.machineId} is not null`,
          sql`${downtimes.endedAt} is not null`,
          gte(downtimes.startedAt, start),
          lte(downtimes.startedAt, end),
        ),
      ))
      .groupBy(downtimes.machineId)

    let totalMinutes = 0

    for (const row of rows) {
      if (!row.machineId) continue

      const minutes = Math.round(Number(row.minutes))
      totalMinutes += minutes

      const loss = wrapMaintenanceError(() =>
        estimatedDowntimeLoss({ minutes, valuePerMinute: policy.lineValuePerMinute }),
      )

      const values = {
        companyId: ctx.companyId,
        machineId: row.machineId,
        forMonth: monthStart,
        minutes,
        // Stored WITH the figure: the value of a line-minute moves, and a loss nobody can
        // reproduce is a loss nobody can defend.
        valuePerMinute: policy.lineValuePerMinute.amount,
        estimatedLoss: loss.amount,
        currency: loss.currency,
        computedAt: new Date(),
      }

      await tx
        .insert(downtimeCosts)
        .values(values)
        .onConflictDoUpdate({
          target: [downtimeCosts.machineId, downtimeCosts.forMonth],
          set: values,
        })

      await recordChange(ctx, tx, {
        action: 'update',
        targetTable: 'downtime_costs',
        targetId: row.machineId,
        before: null,
        after: { forMonth: monthStart, minutes, estimatedLoss: loss.amount },
      })
    }

    return { forMonth: monthStart, machines: rows.length, totalMinutes }
  })
}

/**
 * Which machines break down far more than the typical one, over a window.
 *
 * Counts CLOSED and open tickets alike — a machine that has been down since Tuesday is
 * exactly the kind this report exists to surface — but excludes cancelled ones, which are
 * tickets that turned out not to be breakdowns.
 */
export async function breakdownReport(
  ctx: AnyCtx,
  input: { from: Date; to: Date },
  policy: MaintenancePolicy,
): Promise<BreakdownOutlier[]> {
  return withTenantRead(ctx, async (tx) => {
    const fleet = await tx.select({ id: machines.id }).from(machines)
    if (fleet.length === 0) return []

    const counted = await tx
      .select({ machineId: tickets.machineId, n: sql<string>`count(*)` })
      .from(tickets)
      .where(scoped(tickets, ctx, 
        and(
          sql`${tickets.status} <> 'cancelled'`,
          gte(tickets.reportedAt, input.from),
          lte(tickets.reportedAt, input.to),
        ),
      ))
      .groupBy(tickets.machineId)

    const byMachine = new Map(counted.map((row) => [row.machineId, Number(row.n)]))

    // Every machine in the fleet, including the ones with no tickets — they are what makes
    // the median mean anything.
    const rows = fleet.map((machine) => ({
      machineId: machine.id,
      tickets: byMachine.get(machine.id) ?? 0,
    }))

    return wrapMaintenanceError(() =>
      breakdownOutliers(rows, {
        minFleetTickets: policy.minFleetTickets,
        multiple: policy.outlierMultiple,
        minTickets: policy.outlierMinTickets,
      }),
    )
  })
}

/** How much of its line's open time a machine ran, over a window. */
export async function machineUtilization(
  ctx: AnyCtx,
  input: { machineId: string; availableMinutes: number; from: Date; to: Date },
): Promise<{ machineId: string; downMinutes: number; utilizationPct: string }> {
  const { downtimes } = await import('@/modules/production/schema')

  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx
      .select({
        minutes: sql<string>`coalesce(sum(extract(epoch from (${downtimes.endedAt} - ${downtimes.startedAt})) / 60), 0)`,
      })
      .from(downtimes)
      .where(scoped(downtimes, ctx, 
        and(
          eq(downtimes.machineId, input.machineId),
          sql`${downtimes.endedAt} is not null`,
          gte(downtimes.startedAt, input.from),
          lte(downtimes.startedAt, input.to),
        ),
      ))

    const downMinutes = Math.round(Number(row?.minutes ?? 0))

    return {
      machineId: input.machineId,
      downMinutes,
      utilizationPct: wrapMaintenanceError(() =>
        utilizationPct({
          runMinutes: input.availableMinutes - downMinutes,
          availableMinutes: input.availableMinutes,
        }),
      ),
    }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function openTickets(ctx: AnyCtx): Promise<(typeof tickets.$inferSelect)[]> {
  return withTenantRead(ctx, async (tx) =>
    tx
      .select()
      .from(tickets)
      .where(scoped(tickets, ctx, inArray(tickets.status, ['open', 'claimed'])))
      // line_down first, then oldest — the order a mechanic should work in.
      .orderBy(sql`${tickets.priority}`, tickets.reportedAt),
  )
}

export async function ticketById(
  ctx: AnyCtx,
  ticketId: string,
): Promise<typeof tickets.$inferSelect | null> {
  return withTenantRead(ctx, async (tx) => {
    const [row] = await tx.select().from(tickets).where(scoped(tickets, ctx, eq(tickets.id, ticketId)))
    return row ?? null
  })
}

export { money, isNull }
