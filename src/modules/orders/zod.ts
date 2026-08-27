/**
 * 1.3 payload schemas, including every `pending_changes` payload (brief step 2).
 *
 * These are the boundary. A draft that MARBIM extracted from a buyer PO and a form a
 * merchandiser typed both land here, and both are re-validated at approve — so a schema
 * that tightens later must be able to reject a draft written under the looser one. That
 * is why each pending payload is registered under a versioned key rather than inferred.
 *
 * Money is a decimal STRING throughout. Accepting a JS number here would quietly make
 * every unit price a float before it ever reached `lib/money`.
 */
import { z } from 'zod'

/** `YYYY-MM-DD`, and a real date — `2026-02-30` parses in JS and must not pass. */
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

/** numeric(14,2) as a string. Never a number — see lib/money. */
export const moneyAmount = z
  .string()
  .regex(/^-?\d{1,12}(\.\d{1,2})?$/, 'expected a decimal amount with at most 2 places')

export const currencyCode = z.string().length(3).regex(/^[A-Z]{3}$/, 'expected an ISO-4217 code')

export const orderStatus = z.enum([
  'confirmed',
  'in_production',
  'shipped_partial',
  'shipped_full',
  'closed',
  'cancelled',
])

// ─────────────────────────────────────────────────────────────────────────────
// TNA templates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A bare name means "the template's own spacing is the required lead time"; the object
 * form states a different gap, which is how deliberate slack is declared (see tna.ts).
 */
export const tnaDependency = z.union([
  z.string().min(1),
  z.object({ name: z.string().min(1), gapDays: z.number().int().min(0) }),
])

export const tnaTemplateMilestone = z.object({
  name: z
    .string()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, 'milestone names are snake_case identifiers'),
  offsetDaysBeforeExFactory: z.number().int().min(0),
  dependsOn: z.array(tnaDependency).default([]),
  critical: z.boolean().default(false),
  ownerRole: z.string().optional(),
})

export const tnaTemplatePayload = z.object({
  name: z.string().min(1),
  productType: z.string().min(1),
  milestones: z.array(tnaTemplateMilestone).min(1),
})

// ─────────────────────────────────────────────────────────────────────────────
// Orders
// ─────────────────────────────────────────────────────────────────────────────

export const createOrderPayload = z.object({
  buyerId: z.uuid(),
  poNumbers: z.array(z.string().min(1)).min(1),
  totalValue: moneyAmount.optional(),
  currency: currencyCode.default('USD'),
  plannedExFactoryDate: calendarDate.optional(),
  ownerUserId: z.string().min(1).optional(),
  agentSnapshot: z.record(z.string(), z.unknown()).optional(),
})

/**
 * The style's identity as the buyer states it — season, pattern, how it packs.
 *
 * Split out because it is written from three directions: at order creation, by a
 * merchandiser correcting the dossier afterwards, and by MARBIM reading a tech pack. Every
 * field optional, because a style entered by hand carries a code and nothing else.
 */
export const styleDetails = z.object({
  season: z.string().min(1).max(40).optional(),
  customerLabel: z.string().min(1).max(120).optional(),
  patternNo: z.string().min(1).max(60).optional(),
  basedOnStyle: z.string().min(1).max(60).optional(),
  packingMethod: z.string().min(1).max(120).optional(),
})

export const orderStylePayload = z.object({
  styleCode: z.string().min(1),
  description: z.string().optional(),
  /** Pieces the buyer contracted. What the breakdown must eventually add up to. */
  contractedQty: z.number().int().positive().optional(),
  unitPrice: moneyAmount.optional(),
  currency: currencyCode.default('USD'),
  ...styleDetails.shape,
})

/** Correcting the dossier after the fact — the style is named, the rest is what changed. */
export const updateStyleDetailsPayload = z.object({
  orderStyleId: z.uuid(),
  ...styleDetails.shape,
})

/** One cell of the colour × size grid. Pieces are integers. */
export const breakdownCell = z.object({
  color: z.string().min(1),
  size: z.string().min(1),
  qty: z.number().int().positive(),
})

export const saveBreakdownPayload = z.object({
  orderStyleId: z.uuid(),
  cells: z.array(breakdownCell).min(1),
  /** Set when the buyer asked for the change — forces a new revision. */
  buyerRevision: z.boolean().default(false),
  reason: z.string().optional(),
  documentId: z.uuid().optional(),
})

export const generateTnaPayload = z.object({
  orderId: z.uuid(),
  templateId: z.uuid(),
  exFactoryDate: calendarDate,
})

export const actualizeMilestonePayload = z.object({
  milestoneId: z.uuid(),
  actualDate: calendarDate,
})

// ─────────────────────────────────────────────────────────────────────────────
// pending_changes payloads
//
// Registered in register.ts under these keys. The key is stored on the draft so approve
// re-validates against a NAMED schema rather than re-deriving one from the payload shape
// — which is what makes a tightened schema able to reject an old draft.
// ─────────────────────────────────────────────────────────────────────────────

// ── Transcription tolerance, extraction drafts ONLY ──────────────────────────
//
// The model reads a PAPER purchase order: "Ship date: 15 NOV 2026", "USD 244,800.00",
// "36,000 pcs". The first live PO intake failed on every one of those — the draft schema
// demanded the database's shapes from a document that has never heard of them. Same cure
// as costing's tech-pack layer: transcribe here, keep `createOrderPayload` strict — the
// commit path re-validates against the strict shapes, so nothing lenient reaches a row.

const MONTH_BY_NAME: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

/** "15 NOV 2026", "Nov 15, 2026", "15.11.2026", "15/11/2026" → "2026-11-15". */
const transcribedCalendarDate = z.preprocess((value) => {
  if (typeof value !== 'string') return value
  const text = value.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text

  let m = /^(\d{1,2})[ ./-]([A-Za-z]{3,9})[ ./,-]*(\d{4})$/.exec(text)
  if (m) {
    const month = MONTH_BY_NAME[m[2]!.slice(0, 3).toLowerCase()]
    if (month) return `${m[3]}-${month}-${m[1]!.padStart(2, '0')}`
  }
  m = /^([A-Za-z]{3,9})[ .]*(\d{1,2}),?\s*(\d{4})$/.exec(text)
  if (m) {
    const month = MONTH_BY_NAME[m[1]!.slice(0, 3).toLowerCase()]
    if (month) return `${m[3]}-${month}-${m[2]!.padStart(2, '0')}`
  }
  m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(text)
  if (m) {
    // Day-first (the buyers here are European; so is the kit's PO). A first part that
    // can only be a month ("11/15/2026") is read as US order — 15 is not a month.
    let day = Number(m[1])
    let month = Number(m[2])
    if (month > 12 && day <= 12) [day, month] = [month, day]
    return `${m[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  return value
}, calendarDate)

/** "USD 244,800.00" → "244800.00" · "6.9500" → "6.95". Never rounds — trailing zeros only. */
const transcribedMoney = z.preprocess((value) => {
  if (typeof value === 'number') return String(value)
  if (typeof value !== 'string') return value
  const match = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/.exec(value)
  if (!match) return value
  const [whole, fraction = ''] = match[0].replace(/,/g, '').split('.')
  const trimmed = fraction.length > 2 ? fraction.replace(/0+$/, '') : fraction
  return trimmed ? `${whole}.${trimmed}` : whole
}, moneyAmount)

/** "36,000" or "36,000 pcs" → 36000. */
const transcribedCount = z.preprocess((value) => {
  if (typeof value === 'string') {
    const digits = /\d+/.exec(value.replace(/,/g, ''))?.[0]
    if (digits) return Number(digits)
  }
  return value
}, z.number().int().positive())

/** A style as the model transcribes it off the PO. Strict twin: `orderStylePayload`. */
const orderStyleDraft = z.object({
  styleCode: z.string().min(1),
  description: z.string().optional(),
  contractedQty: transcribedCount.optional(),
  unitPrice: transcribedMoney.optional(),
  currency: currencyCode.default('USD'),
  /**
   * The colour × size grid, when the PO carries one — and it nearly always does.
   *
   * This had nowhere to go, and the consequence was not that the grid was dropped: it was
   * that the extractor put it somewhere wrong. Given a PO with ten quantity rows and a
   * `styles[]` array as the only repeating structure in the schema, the model produced TEN
   * styles — same style code ten times, one size's quantity each — and approving that would
   * have created an order with ten duplicate styles and no breakdown at all.
   *
   * A schema with no home for the most repetitive thing on the page does not omit it; it
   * invites the model to improvise. So the grid gets a home, and the extraction instruction
   * for this target now says which is which.
   */
  breakdown: z.array(breakdownCell).optional(),
  ...styleDetails.shape,
})

/** What MARBIM extracts from a buyer PO scan. Every field is uncertain, hence optional. */
/**
 * An order drafted from a buyer's purchase order.
 *
 * `styles` is required and at least one, because a PO always names what is being bought and
 * an order with no style is one nobody can cost, cut or ship — `createOrder` refuses it. A
 * draft that omitted them looked committable right up to the moment somebody approved it.
 *
 * `buyerId` is the one field no document carries: the PO names the buyer in words, and the
 * uuid is ours. MARBIM's intake collects it from a picker and merges it in at confidence 1
 * (`marbim/intake.ts`) — AFTER the provider validates the model's own output, which is why
 * whatever id-shaped string the model transcribed is dropped here rather than refused: the
 * picker's value is the one that counts, and `createOrder` still requires a real uuid.
 */
export const orderFromPoDraft = z.object({
  buyerId: z.uuid().optional().catch(undefined),
  poNumbers: z.array(z.string().min(1)).min(1),
  totalValue: transcribedMoney.optional(),
  currency: currencyCode.default('USD'),
  plannedExFactoryDate: transcribedCalendarDate.optional(),
  styles: z.array(orderStyleDraft).min(1),
})

/** A buyer's amendment, drafted from an email or an amended PO. */
export const orderRevisionDraft = z.object({
  orderStyleId: z.uuid(),
  cells: z.array(breakdownCell).min(1),
  reason: z.string().min(1),
  documentId: z.uuid().optional(),
})

/**
 * `tna_milestones.depends_on`, as the engine actually writes it.
 *
 * Two shapes, both legitimate: a bare name when the dependency is plain
 * sequencing, and `{name, gapDays}` when the gap is somebody's judgement —
 * PP approval → cutting is four days for a reason. A reader that handles only
 * the first drops exactly the dependencies that carry a decision, so this
 * normalises both into one shape at the read boundary.
 */
export const milestoneDependency = z.union([
  z.string().min(1).transform((name) => ({ name, gapDays: null as number | null })),
  z.object({
    name: z.string().min(1),
    gapDays: z.number().int().nullable().default(null),
  }),
])

export type MilestoneDependency = z.infer<typeof milestoneDependency>

export const ORDERS_ZOD_MAP = {
  order_from_po_v1: orderFromPoDraft,
  order_revision_v1: orderRevisionDraft,
} as const

export type CreateOrderPayload = z.infer<typeof createOrderPayload>
export type SaveBreakdownPayload = z.infer<typeof saveBreakdownPayload>
export type GenerateTnaPayload = z.infer<typeof generateTnaPayload>
export type ActualizeMilestonePayload = z.infer<typeof actualizeMilestonePayload>
export type TnaTemplatePayload = z.infer<typeof tnaTemplatePayload>
