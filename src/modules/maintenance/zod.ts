/**
 * Payloads for 9.1.
 *
 * The module registers no pending targets: nothing here is drafted by a model. A ticket is
 * raised by a machine stopping or by a mechanic standing in front of it, and a spare-part
 * count is something somebody counted. There is no document to extract any of it from.
 */
import { z } from 'zod'

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')

export const machineInput = z.object({
  machineType: z.string().min(1),
  brand: z.string().optional(),
  model: z.string().optional(),
  serial: z.string().optional(),
  purchasedAt: isoDate.optional(),
  lineId: z.uuid().optional(),
  assignedFrom: isoDate.optional(),
})

/**
 * A machine's nameplate, photographed on the floor.
 *
 * The rivet-on plate every industrial machine carries: maker, model, serial, sometimes the
 * type and the year. Registering a floor of four hundred machines means typing four hundred
 * of these, and the serial — the one field that has to be exact, because it is what a spare
 * part and a service call are ordered against — is a fifteen-character string of letters and
 * digits read off oily metal.
 *
 * The line is not read. Which line a machine stands on is where somebody put it, not
 * something stamped on it.
 */
export const machineNameplateDraft = z.object({
  /** "single needle lockstitch", "overlock 5-thread", "flatlock" — what it does. */
  machineType: z.string().min(1),
  brand: z.string().max(80).optional().catch(undefined),
  model: z.string().max(80).optional().catch(undefined),
  /** Exactly as stamped, including letters, dashes and leading zeros. */
  serial: z.string().max(80).optional().catch(undefined),
  purchasedAt: isoDate.optional().catch(undefined),
})

/** What 6.1's machine-downtime event carries. */
export const autoTicketInput = z.object({
  downtimeId: z.uuid(),
  lineId: z.uuid(),
  machineId: z.uuid().nullish(),
  startedAt: z.string(),
  note: z.string().nullish(),
})

export const manualTicketInput = z.object({
  machineId: z.uuid().optional(),
  lineId: z.uuid().optional(),
  /**
   * `line_down` is deliberately absent from what a person may choose. It is what an
   * automatic ticket from a stoppage IS, and a manual ticket claiming it would jump a queue
   * the automatic ones exist to order.
   */
  priority: z.enum(['high', 'normal']),
  notes: z.string().optional(),
})

export const claimTicketInput = z.object({
  ticketId: z.uuid(),
})

export const resolveTicketInput = z.object({
  ticketId: z.uuid(),
  partsUsed: z
    .array(z.object({ partId: z.uuid(), qty: z.number().int().positive() }))
    .default([]),
  notes: z.string().optional(),
})

/**
 * A preventive-maintenance schedule: what to check on a type of machine, and how often.
 *
 * `checklist` cannot be empty. A schedule with no steps produces due dates nobody can sign
 * off — `completePm` refuses a visit with no checks — so an empty one is a machine that
 * looks scheduled and can never be serviced on the record.
 */
export const pmScheduleInput = z.object({
  machineType: z.string().min(1),
  cadence: z.enum(['daily', 'weekly', 'monthly']),
  checklist: z.array(z.string().min(1)).min(1),
})

export const completePmInput = z.object({
  scheduleId: z.uuid(),
  machineId: z.uuid(),
  completedOn: isoDate,
  /** Which checks were actually made. An empty list is a signature on nothing. */
  checked: z
    .array(z.object({ step: z.string().min(1), ok: z.boolean(), note: z.string().optional() }))
    .min(1),
})

export const monthlyCostInput = z.object({
  /** First day of the month. */
  forMonth: isoDate,
})

/**
 * Maintenance proposes nothing and still needs a schema.
 *
 * Registering a machine is not a claim to be reviewed the next morning — the machine is on
 * the floor or it is not. `machine_nameplate_v1` exists so a reading has a shape to be parsed
 * into, which `resolveReadSchema` asks the module to name.
 */
export const MAINTENANCE_ZOD_MAP = {
  machine_nameplate_v1: machineNameplateDraft,
} as const

export type MachineInput = z.infer<typeof machineInput>
export type ManualTicketInput = z.infer<typeof manualTicketInput>
export type ResolveTicketInput = z.infer<typeof resolveTicketInput>
