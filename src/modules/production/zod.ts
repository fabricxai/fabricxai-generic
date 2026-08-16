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
  /**
   * Why the hour went the way it did, when there is something to say (§9, F43).
   *
   * Three states, because the batch upsert has to tell them apart:
   *
   *  - **absent** — this write has no opinion. The quick keypad across every line does not
   *    ask for a remark, and re-entering an hour through it must not wipe the explanation
   *    somebody typed off the sheet;
   *  - **empty string** — clear it, said deliberately;
   *  - **text** — set it.
   */
  remark: z.string().max(200).optional(),
})

/**
 * A burst. The brief's target is 50 lines × 10 entries under concurrent dashboard reads,
 * so the cap is generous enough for a whole shift's catch-up after a network outage.
 */
export const hourlyOutputBatch = z.object({
  entries: z.array(hourlyOutputEntry).min(1).max(600),
})

/**
 * A supervisor's hourly production sheet, photographed at the end of the day.
 *
 * Every line in every factory in Bangladesh keeps one of these on a clipboard: the hour, the
 * target, what came off, and a remark when something went wrong. The tablet is meant to
 * replace it and does not, because the clipboard works when the network does not and the
 * supervisor already trusts it. What actually happens is that somebody types eleven rows off
 * the sheet at seven in the evening, which is when they are least able to.
 *
 * The strict twin is `hourlyOutputEntry`, which names the line and the order by uuid. This
 * reads what the sheet says — "L-1", "ST-2610 Polo (PO-BF-2044)" — and the screen resolves
 * them, the same way the challan reading resolves a material.
 *
 * ## Hours are read as the sheet writes them
 *
 * "8-9", "12-1", "2-3" — a Bangladeshi shift runs 8am to 7pm with a break, and the
 * afternoon is written in 12-hour form with no am/pm because everybody on the floor knows.
 * `hourSlot` is the 24-hour START of the band, so "2-3" is 14. Getting that wrong files an
 * afternoon's output against the small hours of the morning, where nothing was made and
 * nobody looks.
 */
export const hourlySheetDraft = z.object({
  /** What the sheet calls the line — "L-1", "Line 1", "L1". */
  lineCode: z.string().min(1),
  producedOn: calendarDate,
  /** The style or order the sheet names, so the screen can attach the output to it. */
  reference: z.string().max(120).optional().catch(undefined),
  /** Stated once at the top of most sheets rather than per row. */
  targetPerHour: z.number().int().min(0).optional().catch(undefined),
  hours: z
    .array(
      z.object({
        /** 24-hour start of the band. "8-9" is 8, "2-3" is 14, "6-7" is 18. */
        hourSlot: z.number().int().min(0).max(23),
        target: z.number().int().min(0).optional().catch(undefined),
        actual: z.number().int().min(0),
        /** "needle chg SN-1-021", "thread break" — why an hour missed. */
        remark: z.string().max(200).optional().catch(undefined),
      }),
    )
    .min(1)
    .max(24),
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

/**
 * Production drafts nothing into the approve inbox and still needs a schema.
 *
 * Nothing here is proposed: an hour of output is a fact somebody on the floor states, not a
 * claim to be reviewed the next morning. `hourly_sheet_v1` is registered because a reading
 * has to be parsed into something, and `resolveReadSchema` asks the module to name it —
 * filling a supervisor's own screen from their own clipboard is not a write, so it needs no
 * proposable target and no commit handler.
 */
export const PRODUCTION_ZOD_MAP = {
  hourly_sheet_v1: hourlySheetDraft,
} as const

export type HourlyOutputEntry = z.infer<typeof hourlyOutputEntry>
export type OpenDowntime = z.infer<typeof openDowntime>
