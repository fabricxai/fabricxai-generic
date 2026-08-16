/**
 * Payloads for 7.1, including every `pending_changes` payload.
 *
 * `inlineCheckPayload` is shaped for the brief's "≤3-tap" capture: line, operation, and a
 * list of tapped defect codes. Everything else on the row — the date, the severity of each
 * code, the defect total — is derived server-side, because a supervisor standing at a
 * sewing machine should not be classifying defects, and two supervisors must not classify
 * the same defect differently.
 */
import { z } from 'zod'

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
export const decimal = (max = 12) =>
  z.string().regex(new RegExp(`^\\d{1,${max}}(\\.\\d{1,2})?$`), 'expected a positive decimal')

export const defectCodePayload = z.object({
  category: z.string().min(1).max(60),
  code: z.string().min(1).max(60),
  label: z.string().min(1).max(200),
  severity: z.enum(['critical', 'major', 'minor']),
})

/** The tap payload. Three taps: line (preselected), operation, defect. */
export const inlineCheckPayload = z.object({
  lineId: z.string().uuid(),
  orderId: z.string().uuid().optional(),
  operation: z.string().min(1).max(120),
  operatorId: z.string().uuid().optional(),
  checkedQty: z.number().int().min(1),
  defects: z
    .array(z.object({ code: z.string().min(1), count: z.number().int().min(1) }))
    .default([]),
  checkedOn: isoDate.optional(),
  occurredAt: z.string().optional(),
  offlineKey: z.string().min(1).max(120).optional(),
})

export const fabricInspectionPayload = z.object({
  grnId: z.string().uuid(),
  rollId: z.string().uuid().optional(),
  /** Defect counts by penalty band. A band-3 defect is worth 3 points. */
  points4: z.object({
    1: z.number().int().min(0).default(0),
    2: z.number().int().min(0).default(0),
    3: z.number().int().min(0).default(0),
    4: z.number().int().min(0).default(0),
  }),
  inspectedLengthYards: decimal(),
  widthInches: decimal(6),
})

/**
 * A measurement as a buyer's chart writes it — tolerated on the way in, strict underneath.
 *
 * Charts write tolerances signed ("+1.0 / −1.0") and the extraction instruction says
 * transcribe exactly; the strict `decimal` above then rejected the minus sign it had just
 * demanded. The magnitude is the value — the sign is the column's job (`tolPlus` versus
 * `tolMinus`), and the QC comparison applies it itself.
 */
const chartDecimal = (max = 12) =>
  z.preprocess((raw) => {
    // "−1.0" arrives as a JSON number as often as a string — same transcription, different
    // type. The magnitude is the value either way.
    const value = typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : raw
    if (typeof value !== 'string') return value
    const match = value.replace(/,/g, '').match(/\d+(?:\.\d+)?/)
    return match ? match[0] : value
  }, decimal(max))

export const measurementSpecPayload = z.object({
  /*
   * Described, because this schema IS the instruction: it becomes the JSON Schema the
   * extract model is handed, and an undescribed field gets whatever the line says. A chart
   * heads itself `ST-2815 · NK-90455 · Rev 2`, and the model filed all three as the code —
   * which put fifty correct points under a string no lookup will ever match.
   */
  styleCode: z
    .string()
    .min(1)
    .describe(
      'The factory\'s own style code ALONE, like "ST-2815". A chart header often prints the ' +
        'style, the buyer\'s article number and a revision on one line — take only the ' +
        'style code, and never the buyer article or the revision.',
    ),
  unit: z.string().min(1).max(10).default('cm'),
  points: z
    .array(
      z.preprocess(
        // Most charts write ONE "Tol +/-" column: a single symmetric magnitude. A point
        // carrying only one of the pair means the chart stated one number for both — fold
        // it across rather than failing thirty points over a column the document does not
        // have. A chart that genuinely writes both still gets both.
        (raw) => {
          if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return raw
          const point = { ...(raw as Record<string, unknown>) }
          const blank = (v: unknown) => v === '' || v === null || v === undefined
          if (blank(point.tolMinus) && !blank(point.tolPlus)) point.tolMinus = point.tolPlus
          if (blank(point.tolPlus) && !blank(point.tolMinus)) point.tolPlus = point.tolMinus
          return point
        },
        z.object({
          name: z
            .string()
            .min(1)
            .describe(
              'The point of measure INCLUDING the size when the chart grades by size — one ' +
                'entry per point per size, named like "A Chest — size M". A graded row ' +
                'becomes several points, never one point with several values.',
            ),
          spec: chartDecimal(8).describe(
            'The measurement itself, one number for one size. Never the POM letter, never a list.',
          ),
          /** Separate, because garment tolerances are asymmetric by nature. */
          tolPlus: chartDecimal(6),
          tolMinus: chartDecimal(6).describe('Magnitude only — the direction is this field.'),
        }),
      ),
    )
    .min(1, 'a measurement spec with no points checks nothing'),
})

export const measurementCheckPayload = z.object({
  measurementSpecId: z.string().uuid(),
  orderId: z.string().uuid(),
  sampledSize: z.string().min(1).max(20),
  values: z.record(z.string().min(1), decimal(8)),
})

/**
 * The pieces measured for one size, captured together.
 *
 * A size is what a QC actually measures — three garments side by side against the buyer's
 * chart — and it is the unit that has to survive or fail as one. The per-piece action wrote
 * each check in its OWN transaction, so a bad value on piece 2 left piece 1 filed and piece
 * 3 missing: a half-measured size that reads as a completed one, on the floor screen with
 * the weakest network in the factory.
 */
export const measurementSetPayload = z.object({
  measurementSpecId: z.string().uuid(),
  orderId: z.string().uuid(),
  sampledSize: z.string().min(1).max(20),
  pieces: z
    .array(z.record(z.string().min(1), decimal(8)))
    .min(1, 'a size with no pieces measures nothing'),
  offlineKey: z.string().min(1).max(120).optional(),
})

export const finalInspectionPayload = z.object({
  orderId: z.string().uuid(),
  orderStyleId: z.string().uuid().optional(),
  inspectionNo: z.string().min(1).max(60),
  lotQty: z.number().int().min(1),
  /**
   * From buyer terms. No defaults — an AQL level the system chose for you is an acceptance
   * number nobody agreed to.
   */
  inspectionLevel: z.enum(['I', 'II', 'III']),
  majorAql: z.string().min(1),
  minorAql: z.string().min(1),
  /** Tapped defect codes with counts; severity comes from `defect_codes`. */
  defects: z
    .array(z.object({ code: z.string().min(1), count: z.number().int().min(1) }))
    .default([]),
  /** The device's key, so a replayed batch returns the original verdict. */
  offlineKey: z.string().min(1).max(120).optional(),
})

export const thirdPartyInspectionPayload = z
  .object({
    orderId: z.string().uuid(),
    agency: z.enum(['sgs', 'intertek', 'bv', 'other']),
    agencyName: z.string().min(1).max(200).optional(),
    scheduledAt: z.string(),
  })
  .refine((r) => r.agency !== 'other' || r.agencyName !== undefined, {
    message: 'name the agency when it is not one of the majors',
    path: ['agencyName'],
  })

export type MeasurementSetPayload = z.infer<typeof measurementSetPayload>

export const QUALITY_ZOD_MAP = {
  defect_code: defectCodePayload,
  measurement_spec: measurementSpecPayload,
} as const

export type InlineCheckPayload = z.infer<typeof inlineCheckPayload>
export type FinalInspectionPayload = z.infer<typeof finalInspectionPayload>
export type MeasurementSpecPayload = z.infer<typeof measurementSpecPayload>
