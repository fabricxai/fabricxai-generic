/**
 * Payloads for 4.1, including every `pending_changes` payload.
 *
 * `plannedDaily` is the field to be careful with. It is a jsonb map of date → quantity,
 * which is convenient to render and easy to let rot: a plan whose daily quantities do not
 * sum to the allocated total, or that carries dates outside its own window, is a plan the
 * overload check will silently mis-answer. Both are refused here rather than at the UI.
 */
import { z } from 'zod'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

export const isoDate = z.string().regex(ISO_DATE, 'expected YYYY-MM-DD')
export const decimal = (max = 8) =>
  z.string().regex(new RegExp(`^\\d{1,${max}}(\\.\\d{1,2})?$`), 'expected a positive decimal')

export const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'expected a percentage')

/**
 * The factory's own shape: a unit, its floors, and the sewing lines on them.
 *
 * None of the three could be created. `lines` was read by the planning board, the hourly
 * tracker, the day plan and the capacity arithmetic, and written only by the seed — so a
 * factory that opened a new line could not put it in the system, and a factory that had
 * never been seeded had no board at all.
 *
 * A line belongs to a floor and a floor to a unit, so the three go in together: asking a
 * planner to create a unit, then a floor, then a line through three separate forms is how
 * the first one gets abandoned.
 */
export const factoryUnitPayload = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
})

export const floorPayload = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  /** Either an existing unit, or the code of one to create alongside it. */
  factoryUnitId: z.uuid().optional(),
  factoryUnit: factoryUnitPayload.optional(),
}).refine((f) => Boolean(f.factoryUnitId) || Boolean(f.factoryUnit), {
  message: 'a floor belongs to a factory unit — name an existing one or describe a new one',
  path: ['factoryUnitId'],
})

export const linePayload = z.object({
  code: z.string().min(1).max(40),
  name: z.string().min(1).max(200),
  /** Nominal head count. The day plan carries what is actually rostered. */
  capacityManpower: z.number().int().positive().optional(),
  machinesCount: z.number().int().positive().optional(),
  floorId: z.uuid().optional(),
  floor: floorPayload.optional(),
  isActive: z.boolean().default(true),
})

/**
 * When a set of lines is working, over a stretch of dates.
 *
 * A range and a working week rather than a row per day, because that is how a factory
 * actually decides it: six days, Friday off, eight hours, an hour of it planned downtime for
 * changeover and maintenance. Expanding that into dates is arithmetic, and asking a planner
 * to enter ninety rows to say it is how a calendar never gets entered at all.
 *
 * `weekdays` is ISO — 1 is Monday, 7 is Sunday. Bangladesh's weekend is Friday, so the
 * default working week here is 1–4 and 6–7, which is not a detail to leave to a US-shaped
 * default of Saturday-Sunday.
 */
export const lineCalendarRangePayload = z.object({
  lineIds: z.array(z.uuid()).min(1),
  from: isoDate,
  to: isoDate,
  /** ISO weekday numbers the line works. */
  weekdays: z.array(z.number().int().min(1).max(7)).min(1),
  shiftMinutes: z.number().int().min(1).max(1440),
  plannedDowntimeMinutes: z.number().int().min(0).default(0),
  manpower: z.number().int().positive().optional(),
})

export const smvRecordPayload = z.object({
  styleCode: z.string().min(1),
  smv: decimal(6),
  source: z.enum(['ie_study', 'estimate']),
  measuredAt: isoDate.optional(),
})

export const learningCurvePointPayload = z.object({
  productType: z.string().min(1),
  dayIndex: z.number().int().min(1),
  efficiencyPct: pct,
})

/**
 * One line, one day. Kept for the day-level correction a supervisor makes — a line that
 * worked an extra shift, or lost one — alongside `lineCalendarRangePayload`, which is how a
 * working week is set in the first place.
 */
export const lineCalendarDayPayload = z.object({
  lineId: z.string().uuid(),
  calendarDate: isoDate,
  shiftMinutes: z.number().int().min(1).max(1440),
  plannedDowntimeMinutes: z.number().int().min(0).max(1440).default(0),
  manpower: z.number().int().min(1).optional(),
})

/**
 * A day-by-day quantity map. Refused when it is empty, because an allocation with no
 * daily plan looks scheduled on a Gantt while contributing nothing to any overload check
 * — the most dangerous state a plan can be in.
 */
export const plannedDaily = z
  .record(isoDate, z.number().int().min(0))
  .refine((map) => Object.keys(map).length > 0, {
    message: 'plannedDaily cannot be empty — an allocation with no daily plan is invisible to the overload check',
  })

export const allocationPayload = z
  .object({
    orderId: z.string().uuid(),
    /**
     * Which style of the order is on the line. Optional only because a single-style order
     * resolves unambiguously; a multi-style order is refused without it, since SMV is a
     * property of a style and an order carrying three of them has no single SMV.
     */
    orderStyleId: z.string().uuid().optional(),
    lineId: z.string().uuid(),
    startDate: isoDate,
    endDate: isoDate,
    plannedDaily,
  })
  .refine((a) => a.endDate >= a.startDate, {
    message: 'endDate is before startDate',
    path: ['endDate'],
  })
  .refine(
    (a) => Object.keys(a.plannedDaily).every((d) => d >= a.startDate && d <= a.endDate),
    {
      // A quantity planned outside the window is work nobody is counting capacity for.
      message: 'plannedDaily contains a date outside [startDate, endDate]',
      path: ['plannedDaily'],
    },
  )

export const scenarioPayload = z.object({
  name: z.string().min(1).max(120),
  draftAllocations: z.array(allocationPayload).default([]),
})

/**
 * What an approved scenario commits — the whole set, applied as one decision.
 *
 * The planning assumptions travel ON the draft. Approval re-runs the overload check, and
 * re-running it against whatever the company default happens to be at approve time would
 * check a different plan from the one the planner submitted. Same reason a cost sheet
 * carries its own FX rate: there is no ambient assumption in this system.
 */
export const applyScenarioPayload = z.object({
  scenarioId: z.string().uuid(),
  allocations: z.array(allocationPayload).min(1),
  assumptions: z.object({
    expectedEfficiencyPct: pct,
    defaultShiftMinutes: z.number().int().min(1).max(1440),
  }),
})

export const PLANNING_ZOD_MAP = {
  allocation: allocationPayload,
  scenario_apply: applyScenarioPayload,
  smv_record: smvRecordPayload,
} as const

export type AllocationPayload = z.infer<typeof allocationPayload>
export type ApplyScenarioPayload = z.infer<typeof applyScenarioPayload>
