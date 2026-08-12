/**
 * Payloads for 5.1, including every `pending_changes` payload.
 *
 * `cells` is a flat `"Colour|Size" → qty` map rather than a nested object. Colour names
 * come from buyer documents and contain spaces, slashes and the occasional comma, so the
 * separator is a character that cannot appear in one — a nested map would be tidier and
 * would break the first time somebody types "Navy/White".
 */
import { z } from 'zod'

export const decimal = (max = 12) =>
  z.string().regex(new RegExp(`^\\d{1,${max}}(\\.\\d{1,2})?$`), 'expected a positive decimal')

export const pct = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/, 'expected a percentage')

/** `Colour|Size`. The pipe is the one character a buyer's colour name never contains. */
export const CELL_SEPARATOR = '|'
const cellKeyPattern = /^[^|]+\|[^|]+$/

export const cellMap = z
  .record(z.string().regex(cellKeyPattern, 'expected "Colour|Size"'), z.number().int().min(0))
  .refine((map) => Object.keys(map).length > 0, { message: 'no cells reported' })

export const sizeRatio = z
  .record(z.string().min(1), z.number().int().min(0))
  .refine((r) => Object.values(r).some((n) => n > 0), {
    // A marker with nothing in it costs fabric and yields no garments.
    message: 'marker has no pieces in it',
  })

export const markerPayload = z.object({
  code: z.string().min(1).max(60),
  styleCode: z.string().min(1),
  sizeRatio,
  layLengthMeters: decimal(),
  efficiencyPct: pct.optional(),
  fabricWidthInches: decimal(6).optional(),
})

export const createLayPayload = z.object({
  orderId: z.string().uuid(),
  orderStyleId: z.string().uuid(),
  markerId: z.string().uuid(),
  layNo: z.string().min(1).max(60),
  color: z.string().min(1),
  plies: z.number().int().min(1),
  layLengthMeters: decimal(),
  /** Store rolls this lay consumes. Empty is refused by the issued-fabric gate. */
  rollsDrawn: z.array(z.string().uuid()).default([]),
  fabricDrawnMeters: decimal().optional(),
  offlineKey: z.string().min(1).max(120).optional(),
})

export const cutReportPayload = z.object({
  layId: z.string().uuid(),
  cells: cellMap,
  offlineKey: z.string().min(1).max(120).optional(),
})

/**
 * A correction to a report that is already filed. Goes through `pending_changes` because
 * restating what came off the table changes the order's cut position, and the first
 * number was written by somebody who was standing there.
 */
export const cutReportCorrectionPayload = z.object({
  cutReportId: z.string().uuid(),
  cells: cellMap,
  reason: z.string().min(1).max(500),
})

export const bundleScanPayload = z.object({
  qrToken: z.string().min(1),
  status: z.enum(['in_sewing', 'done']),
})

/**
 * A cutting sheet, photographed at the table.
 *
 * The cut report screen already knows the lay and what the marker expected; what it asks for
 * is what actually came off, size by size, and that is written on a clipboard next to the
 * spreader. `cutReportPayload` names the lay by uuid, which no sheet carries — this reads the
 * lay number as printed and the screen matches it against the lays it is already showing.
 *
 * The cut quantity is the one that matters and the one people get wrong: the sheet prints
 * plies, expected and actual side by side, and the actual is the only one this is asking for.
 */
export const cutSheetDraft = z.object({
  /** "LAY-32", "L-32", "Lay No 32" — matched against the lays on the screen. */
  layNo: z.string().min(1),
  /** The colour being spread. One lay is one colour.  */
  color: z.string().max(60).optional().catch(undefined),
  plies: z.number().int().min(0).optional().catch(undefined),
  cells: z
    .array(
      z.object({
        size: z.string().min(1).max(20),
        /** What actually came off the table for this size. Never the marker's ratio. */
        cut: z.number().int().min(0),
      }),
    )
    .min(1),
})

export const CUTTING_ZOD_MAP = {
  cut_sheet_v1: cutSheetDraft,
  marker: markerPayload,
  cut_report_correction: cutReportCorrectionPayload,
} as const

export type MarkerPayload = z.infer<typeof markerPayload>
export type CreateLayPayload = z.infer<typeof createLayPayload>
export type CutReportPayload = z.infer<typeof cutReportPayload>
export type CutReportCorrectionPayload = z.infer<typeof cutReportCorrectionPayload>
