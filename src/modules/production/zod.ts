/**
 * Payloads for 6.1 ⚡
 *
 * These arrive in bursts from tablets at the end of every hour, so validation is cheap
 * and strict: a malformed row must be rejected per-row, not fail the batch.
 */
import { z } from 'zod'

export const calendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((value) => {
    // Date#toISOString THROWS on an invalid date — the old guard crashed with "Invalid
    // time value" on exactly the input it exists to refuse ("0000-00-00" matches the
    // regex). Date.parse returns NaN instead, which a refine can answer false to.
    const time = Date.parse(`${value}T00:00:00Z`)
    return !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === value
  }, {
    message: 'not a real calendar date',
  })

/** One cell of the hourly board. */
export const hourlyOutputEntry = z.object({
  lineId: z.uuid(),
  orderId: z.uuid().optional(),
  producedOn: calendarDate,
  hourSlot: z.number().int().min(0).max(23),
  target: z.number().int().min(0).default(0),
  actual: z.number().int().min(0),
})

/**
 * A burst. The brief's target is 50 lines × 10 entries under concurrent dashboard reads,
 * so the cap is generous enough for a whole shift's catch-up after a network outage.
 */
export const hourlyOutputBatch = z.object({
  entries: z.array(hourlyOutputEntry).min(1).max(600),
})

export const openDowntime = z.object({
  lineId: z.uuid(),
  startedAt: z.string().datetime(),
  reason: z.enum(['machine', 'feeding', 'absent', 'power', 'other']),
  machineId: z.uuid().optional(),
  note: z.string().max(500).optional(),
})

export const closeDowntime = z.object({
  downtimeId: z.uuid(),
  endedAt: z.string().datetime(),
  note: z.string().max(500).optional(),
})

export const endlineCount = z.object({
  lineId: z.uuid(),
  countedOn: calendarDate,
  checked: z.number().int().min(0),
  passed: z.number().int().min(0),
  defective: z.number().int().min(0),
  /** Defects, not defective garments — one garment can carry several. */
  defects: z.number().int().min(0),
  rework: z.number().int().min(0),
})

/**
 * The day's plan for one line: which order it runs, at what target, with how many people.
 * The record everything else on the floor hangs off — hourly outputs take their orderId
 * from it, the board takes its targets, the day-close takes SMV and manpower.
 */
export const dayPlan = z.object({
  lineId: z.uuid(),
  orderId: z.uuid(),
  planDate: calendarDate,
  targetPerHour: z.number().int().positive(),
  manpowerPlanned: z.number().int().positive(),
  smv: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,2})?$/, 'expected minutes, like 18.40')
    .optional(),
})

export const PRODUCTION_ZOD_MAP = {} as const

export type HourlyOutputEntry = z.infer<typeof hourlyOutputEntry>
export type OpenDowntime = z.infer<typeof openDowntime>
