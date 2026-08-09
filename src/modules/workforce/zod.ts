/**
 * Payload schemas for 10.1, including every `pending_changes` payload.
 *
 * The gazette upload is the important one: it is how a factory's own wage rates enter the
 * system, so it validates shape rigorously and rates not at all. What the government
 * notified is not ours to second-guess — but "basic" being a number rather than a decimal
 * string is a bug we can catch.
 */
import { z } from 'zod'

export const wageAmount = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'expected a positive decimal amount with at most 2 places')

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

export const period = z.string().regex(/^\d{4}-\d{2}$/, 'expected YYYY-MM')

/** One grade as printed in the notification. */
export const gazetteGrade = z.object({
  grade: z.string().min(1).max(16),
  basic: wageAmount,
  houseRent: wageAmount.default('0'),
  medical: wageAmount.default('0'),
  transport: wageAmount.default('0'),
  food: wageAmount.default('0'),
})

/**
 * A whole gazette. Uploaded as a unit and activated as a unit — half a gazette would pay
 * some grades at new rates and some at old ones inside one run.
 */
export const gazetteUpload = z.object({
  version: z.string().min(1).max(64),
  effectiveFrom: calendarDate,
  grades: z.array(gazetteGrade).min(1, 'a gazette needs at least one grade'),
  // `.catch(undefined)`, same reasoning as costing's sourceDocumentId: the extract model
  // fills a uuid field with the id-shaped string the gazette prints (an SRO number) — no
  // paper carries a UUID. Invalid becomes absent; the manual upload supplies a real id.
  documentId: z.uuid().optional().catch(undefined),
  notes: z.string().max(2000).optional(),
})

/** Factory policy, snapshotted onto each run. */
/**
 * One day of one worker, as the biometric device reported it — normalised by the screen
 * from the device's own CSV dialect (live-test finding, Phase 9: attendance had no way
 * in at all). The device is the source; a human never types a punch.
 */
export const deviceAttendanceRow = z.object({
  employeeNo: z.string().min(1).max(40),
  date: calendarDate,
  /** 24h HH:MM, straight from the punch columns. Absent when the device has no punch. */
  in: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  out: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  status: z.enum(['present', 'absent', 'leave', 'holiday']),
  /** The device's own flag, carried verbatim: 'late arrival 08:11', 'missing punches'. */
  exception: z.string().max(200).optional(),
  otHours: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).default('0'),
})

export const attendanceImport = z.object({
  rows: z.array(deviceAttendanceRow).min(1, 'the device export has no rows'),
})

export const payrollRules = z.object({
  currency: z.string().length(3).default('BDT'),
  monthDays: z.number().int().min(28).max(31).default(30),
  attendanceBonus: wageAmount.nullable().default(null),
  attendanceBonusMaxAbsentDays: z.number().int().min(0).default(0),
  festivalBonusBasicPct: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).default('100'),
  festivalBonusMinServiceMonths: z.number().int().min(0).default(12),
})

export const computeRunPayload = z.object({
  period,
  festival: z.string().min(1).nullable().optional(),
  rules: payrollRules.partial().optional(),
})

/** What MARBIM extracts from a scanned gazette notification. Always human-reviewed. */
export const gazetteFromScanDraft = gazetteUpload

export const WORKFORCE_ZOD_MAP = {
  gazette_from_scan_v1: gazetteFromScanDraft,
} as const

export type GazetteUpload = z.infer<typeof gazetteUpload>
export type ComputeRunPayload = z.infer<typeof computeRunPayload>
