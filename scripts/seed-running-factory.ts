/**
 * A factory already mid-flight — three orders, three phases (adoption/UX testing).
 *
 * `pnpm tsx scripts/seed-running-factory.ts --slug=test-textile`
 *
 * ## Why this exists next to the other two seeds
 *
 * `seed-day0` gives a factory its masters and nothing else — the honest day-one state, and
 * the one that exposed the missing creation doors. `pnpm seed` fills a tenant with
 * factory-scale reference data but books no orders. Neither produces what a person
 * evaluating this product actually needs to see: a floor with work ON it, at different
 * stages, the way a real Tuesday looks.
 *
 * So: three buyers who look like real ones, and three orders deliberately caught at
 * different points —
 *
 *   · **JKT-2210 · sampling.** Booked, TNA generated, PP sample raised and sitting with the
 *     buyer. Cutting is BLOCKED behind it, which is the gate worth seeing unexercised.
 *   · **POLO-2244 · production.** PP approved, fabric issued, lay spread, cut reported,
 *     four days of hourly output across two lines with real-looking variance, endline
 *     counts and inline defects behind them.
 *   · **DENIM-2251 · shipping.** Sewn out, final inspection PASSED against its own AQL
 *     plan, cartons packed to the breakdown, shipment opened with its EXP number.
 *
 * ## Everything goes through the real services
 *
 * `createOrder`, `generateTna`, `saveBreakdown`, `createSampleRequest`, `createLay`,
 * `recordCutReport`, `planLineDay`, `recordHourlyOutputs` — because a seed that inserts
 * rows directly can produce a state the product itself could never reach, and then the
 * screens built on top of it are being tested against a fiction. Where no service exists
 * (items, locations, workers) the seed writes directly and says so — that gap is finding
 * D1 of the day-one walkthrough, not a shortcut taken here.
 *
 * Idempotent by PO number: re-running leaves an existing order alone rather than booking
 * the same goods twice.
 */
import 'dotenv/config'
// Importing the registry IS registration — without it `propose()` refuses every target,
// and the services below reach for it as soon as anything drafts.
import '@/modules/registry'

import { and, eq, sql } from 'drizzle-orm'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, roles as rolesTable } from '@/db/schema/core'
import { factoryToday, shiftFactoryDate } from '@/lib/dates'
import { buyers } from '@/modules/buyers/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { scoped, tenantEq } from '@/modules/core/scoped'
import { withTenantRead, withTenantTx } from '@/modules/core/tenancy'
import { orders, orderStyles } from '@/modules/orders/schema'
import {
  createOrder,
  findTemplateForProductType,
  generateTna,
  refreshMilestoneStatuses,
  saveBreakdown,
  seedDefaultTnaTemplates,
  setOrderStatus,
} from '@/modules/orders/service'
import { lines } from '@/modules/planning/schema'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

const SLUG = flag('slug') ?? 'test-textile'

/** Today, and dates relative to it — the factory clock, not the server's. */
const T = factoryToday()
const day = (offset: number): string => shiftFactoryDate(T, offset)

const BUYERS = [
  { code: 'BST', name: 'Bestseller A/S', country: 'DK' },
  { code: 'HM', name: 'H&M Hennes & Mauritz AB', country: 'SE' },
  { code: 'PRK', name: 'Primark Ltd', country: 'IE' },
]

const SIZES = ['S', 'M', 'L', 'XL', 'XXL']

interface OrderRef {
  id: string
  styleId: string
  styleCode: string
}
type LineRef = { id: string; code: string }

const STAGES = ['pattern', 'cutting', 'sewing', 'finishing', 'qc', 'dispatched'] as const

/**
 * JKT-2210 — the PP sample is with the buyer, and the cutting floor is waiting on it.
 *
 * Deliberately left WITHOUT a verdict. The PP gate is the most consequential one in this
 * product (a factory that cuts before approval eats the fabric), and a seed where every
 * gate is already open never shows anyone what a gate does. Try to spread a lay against
 * this order and the refusal is the feature.
 */
async function samplingPhase(ctx: RequestCtx, order: OrderRef): Promise<void> {
  const { advanceStage, createSampleRequest, dispatchSample } = await import(
    '@/modules/sampling/service'
  )
  if (await sampleExists(ctx, 'SR-2210-PP')) {
    console.log('[running] JKT-2210 · sampling already seeded, left alone')
    return
  }

  const { sampleRequestId } = await createSampleRequest(ctx, {
    orderId: order.id,
    type: 'pp',
    styleCode: order.styleCode,
    requestNo: 'SR-2210-PP',
    dueDate: day(9),
  })

  for (const [i, stage] of STAGES.entries()) {
    await advanceStage(ctx, {
      sampleRequestId,
      stage,
      occurredAt: new Date(`${day(i - 6)}T09:30:00Z`).toISOString(),
    })
  }

  await dispatchSample(ctx, {
    sampleRequestId,
    courier: 'DHL Express',
    awb: '7412 9930 118',
    dispatchedAt: new Date(`${day(-1)}T16:10:00Z`).toISOString(),
  })

  console.log('[running] JKT-2210 · PP sample SR-2210-PP dispatched, verdict pending — cutting blocked')
}

/**
 * POLO-2244 — approved, cut, and four days into sewing on two lines.
 *
 * The output curve is not flat: day one runs at roughly 62 % of target the way a new style
 * does, and climbs. A seed that produces a perfect 100 % every hour makes the efficiency
 * screens look broken when they finally meet a real factory.
 */
async function productionPhase(ctx: RequestCtx, order: OrderRef, allLines: LineRef[]): Promise<void> {
  const { advanceStage, createSampleRequest, dispatchSample, recordFeedback } = await import(
    '@/modules/sampling/service'
  )
  const { createMarker, createLay, recordCutReport } = await import('@/modules/cutting/service')
  const { getPolicy } = await import('@/modules/settings/service')
  const { planLineDay, recordEndlineCount, recordHourlyOutputs } = await import(
    '@/modules/production/service'
  )
  if (await sampleExists(ctx, 'SR-2244-PP')) {
    console.log('[running] POLO-2244 · production already seeded, left alone')
    return
  }

  // ── the PP sample, approved, which is what opens the cutting gate ──
  const { sampleRequestId } = await createSampleRequest(ctx, {
    orderId: order.id,
    type: 'pp',
    styleCode: order.styleCode,
    requestNo: 'SR-2244-PP',
    dueDate: day(-20),
  })
  for (const [i, stage] of STAGES.entries()) {
    await advanceStage(ctx, {
      sampleRequestId,
      stage,
      occurredAt: new Date(`${day(i - 30)}T10:00:00Z`).toISOString(),
    })
  }
  await dispatchSample(ctx, {
    sampleRequestId,
    courier: 'DHL Express',
    awb: '7412 8801 447',
    dispatchedAt: new Date(`${day(-24)}T15:00:00Z`).toISOString(),
  })
  await recordFeedback(ctx, {
    sampleRequestId,
    verdict: 'approved_with_comments',
    comments: [
      { area: 'collar', comment: 'rib tension slightly loose — tighten on bulk' },
      { area: 'placket', comment: 'button spacing ok, keep as sample' },
    ],
    recordedOn: day(-20),
  })

  // ── fabric out of the store, against this order ──
  const rollIds = await issueFabricFor(ctx, order.id, 14)
  if (rollIds.length === 0) {
    console.log('[running] POLO-2244 · no free rolls in store — cutting/production skipped')
    return
  }

  const { markerId } = await createMarker(ctx, {
    code: 'MK-2244-A',
    styleCode: order.styleCode,
    sizeRatio: { S: 1, M: 2, L: 2, XL: 1 },
    layLengthMeters: '7.40',
    efficiencyPct: '84.50',
    fabricWidthInches: '58.00',
  })

  const { layId } = await createLay(ctx, {
    orderId: order.id,
    orderStyleId: order.styleId,
    markerId,
    layNo: 'LAY-2244-01',
    color: 'White',
    plies: 60,
    layLengthMeters: '7.40',
    rollsDrawn: rollIds,
  })

  // Cut short of the marker's yield in two sizes — the small, ordinary shortfall a cutting
  // room actually reports, and the one the cut-vs-order screens exist to surface. The
  // wastage tolerance comes from the tenant's own policy, the way the action supplies it.
  await recordCutReport(
    ctx,
    {
      layId,
      cells: {
        'White|S': 60,
        'White|M': 118,
        'White|L': 120,
        'White|XL': 58,
      },
    },
    await getPolicy(ctx, 'cutting'),
  )

  // ── four days of sewing on two lines ──
  const floorLines = allLines.slice(0, 2)
  const HOURS = [8, 9, 10, 11, 12, 14, 15, 16]
  const RAMP = [0.62, 0.78, 0.9, 0.96] // a new style finding its rhythm

  for (const [d, ramp] of RAMP.entries()) {
    const producedOn = day(d - 3)
    for (const line of floorLines) {
      await planLineDay(ctx, {
        lineId: line.id,
        orderId: order.id,
        planDate: producedOn,
        targetPerHour: 120,
        manpowerPlanned: 36,
        smv: '14.80',
      })

      const entries = HOURS.map((hourSlot, h) => ({
        lineId: line.id,
        orderId: order.id,
        producedOn,
        hourSlot,
        target: 120,
        // Deterministic wobble — no Math.random, so two runs of this seed tell the
        // same story and a screenshot stays comparable.
        actual: Math.round(120 * ramp) + ((h * 7 + d * 3) % 11) - 5,
      }))
      await recordHourlyOutputs(ctx, { entries })

      const made = entries.reduce((sum, e) => sum + e.actual, 0)
      const defective = Math.round(made * (0.06 - d * 0.008))
      await recordEndlineCount(ctx, {
        lineId: line.id,
        countedOn: producedOn,
        checked: made,
        passed: made - defective,
        defective,
        defects: defective + 3,
        rework: Math.round(defective * 0.8),
      })
    }
  }

  console.log(
    `[running] POLO-2244 · PP approved · lay cut 356 pcs · ${RAMP.length} days on ${floorLines.length} lines`,
  )
}

/**
 * DENIM-2251 — sewn, inspected, packed, and booked onto a vessel.
 *
 * The one order where every gate downstream of production is satisfied, so the shipment
 * desk has something real to look at: a passed final inspection, cartons that add up to
 * the packing list, and an EXP number without which no bank document may be submitted.
 */
async function shippingPhase(ctx: RequestCtx, order: OrderRef, allLines: LineRef[]): Promise<void> {
  const { runFinalInspection, setFinalInspectionStatus } = await import('@/modules/quality/service')
  const { getPolicy } = await import('@/modules/settings/service')
  const { createShipment, loadCartons, packCarton, recordFinishingOutput, setExpNumber } =
    await import('@/modules/shipment/service')
  const { planLineDay, recordEndlineCount, recordHourlyOutputs } = await import(
    '@/modules/production/service'
  )
  // Keyed on the finishing output rather than the shipment: it is the first row this phase
  // writes that carries a unique index, so a run that died mid-way is caught here instead
  // of at the constraint six calls later.
  const { finishingOutputs } = await import('@/modules/shipment/schema')
  const [alreadyShipped] = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: finishingOutputs.id })
      .from(finishingOutputs)
      .where(scoped(finishingOutputs, ctx, eq(finishingOutputs.orderId, order.id))),
  )
  if (alreadyShipped) {
    console.log('[running] DENIM-2251 · shipping already seeded, left alone')
    return
  }

  // A short tail of sewing history, so the order does not appear to have shipped without
  // ever having been made.
  const line = allLines[2] ?? allLines[0]
  if (line) {
    for (const d of [-9, -8, -7]) {
      const producedOn = day(d)
      await planLineDay(ctx, {
        lineId: line.id,
        orderId: order.id,
        planDate: producedOn,
        targetPerHour: 90,
        manpowerPlanned: 40,
        smv: '22.50',
      })
      const entries = [8, 9, 10, 11, 12, 14, 15, 16].map((hourSlot, h) => ({
        lineId: line.id,
        orderId: order.id,
        producedOn,
        hourSlot,
        target: 90,
        actual: 88 + ((h * 5 + d) % 7) - 3,
      }))
      await recordHourlyOutputs(ctx, { entries })
      const made = entries.reduce((s, e) => s + e.actual, 0)
      await recordEndlineCount(ctx, {
        lineId: line.id,
        countedOn: producedOn,
        checked: made,
        passed: made - 14,
        defective: 14,
        defects: 17,
        rework: 11,
      })
    }
  }

  // ── finishing, then the inspection that gates packing ──
  const packed: Record<string, number> = {
    'Indigo|S': 150,
    'Indigo|M': 270,
    'Indigo|L': 330,
    'Indigo|XL': 240,
    'Indigo|XXL': 60,
  }
  await recordFinishingOutput(ctx, {
    orderId: order.id,
    orderStyleId: order.styleId,
    outputDate: day(-4),
    cells: packed,
  })

  const lotQty = Object.values(packed).reduce((a, b) => a + b, 0)
  const inspection = await runFinalInspection(
    ctx,
    {
      orderId: order.id,
      orderStyleId: order.styleId,
      inspectionNo: 'FI-2251-01',
      lotQty,
      inspectionLevel: 'II',
      majorAql: '2.5',
      minorAql: '4.0',
      // Few enough to sit under the plan's acceptance number — but the verdict below is
      // whatever the AQL table says, not what this seed wanted. If it ever comes back
      // failed, that is the sampling plan talking and the line above is what to change.
      defects: [
        { code: 'OIL_STAIN', count: 2 },
        { code: 'LOOSE_THREAD', count: 3 },
        { code: 'BROKEN_STITCH', count: 1 },
      ],
    },
    await getPolicy(ctx, 'quality'),
  )
  // An inspection that shipped was reported, not left in the inspector's drafts.
  await setFinalInspectionStatus(ctx, {
    finalInspectionId: inspection.finalInspectionId,
    status: 'submitted',
  })
  console.log(
    `[running] DENIM-2251 · final inspection ${inspection.outcome.verdict} · ${inspection.outcome.plan.sampleSize} pcs sampled`,
  )

  // ── cartons: a solid-colour ratio pack, 30 pcs a carton ──
  const cartonIds: string[] = []
  const perCarton = 30
  let cartonNo = 1
  for (const [cell, qty] of Object.entries(packed)) {
    for (let left = qty; left > 0; left -= perCarton) {
      const inThis = Math.min(perCarton, left)
      const result = await packCarton(ctx, {
        orderId: order.id,
        cartonNo: `CTN-2251-${String(cartonNo).padStart(3, '0')}`,
        contents: { [cell]: inThis },
        grossKg: (inThis * 0.62 + 1.1).toFixed(2),
        netKg: (inThis * 0.62).toFixed(2),
        lengthCm: '60.00',
        widthCm: '40.00',
        heightCm: '35.00',
      })
      cartonIds.push(result.cartonId)
      cartonNo += 1
    }
  }

  const shipment = await createShipment(ctx, {
    orderId: order.id,
    partialNo: 1,
    plannedExFactory: day(3),
    forwarder: 'Kuehne+Nagel Bangladesh',
    bookingRef: 'KNBD-559214',
    mode: 'sea',
  })
  await loadCartons(ctx, { shipmentId: shipment.shipmentId, cartonIds })
  // No bank document may be submitted without it (rule 8) — so a shipping desk with no EXP
  // is a desk stuck at a wall this seed has no reason to build.
  await setExpNumber(ctx, { shipmentId: shipment.shipmentId, expNumber: 'EXP-2026-004471' })

  console.log(
    `[running] DENIM-2251 · ${cartonIds.length} cartons · ${lotQty} pcs · shipment booked, EXP set`,
  )
}

/**
 * Tick off the milestones each order has genuinely passed.
 *
 * `limit` names the only milestones allowed to be actualised for that PO; `null` means
 * every milestone already due. The distinction matters: an order still waiting on its PP
 * verdict has NOT hit its cutting milestones, and a seed that ticked them anyway would
 * show a green calendar over a blocked gate — the exact contradiction this data exists to
 * let somebody see.
 *
 * Actualised a few days after plan, not on it. A calendar where every milestone landed
 * exactly on its planned date is not a factory anybody has worked in, and the variance
 * columns would have nothing to show.
 */
async function actualizePastMilestones(
  ctx: RequestCtx,
  limits: Record<string, readonly string[] | null>,
): Promise<void> {
  const { actualizeMilestone } = await import('@/modules/orders/service')
  const { tnaMilestones } = await import('@/modules/orders/schema')

  let done = 0
  for (const [po, limit] of Object.entries(limits)) {
    const [order] = await withTenantRead(ctx, (tx) =>
      tx
        .select({ id: orders.id })
        .from(orders)
        .where(scoped(orders, ctx, sql`${orders.poNumbers} @> ARRAY[${po}]::text[]`)),
    )
    if (!order) continue

    const due = await withTenantRead(ctx, (tx) =>
      tx
        .select({ id: tnaMilestones.id, name: tnaMilestones.name, planned: tnaMilestones.plannedDate })
        .from(tnaMilestones)
        .where(scoped(tnaMilestones, ctx, and(eq(tnaMilestones.orderId, order.id), sql`${tnaMilestones.actualDate} is null`))),
    )

    for (const [i, m] of due.entries()) {
      if (m.planned >= T) continue
      if (limit && !limit.includes(m.name)) continue
      // A day or two after plan, varying by position — deterministic, so two runs of this
      // seed tell the same story.
      const actual = shiftFactoryDate(m.planned, i % 3)
      await actualizeMilestone(ctx, {
        milestoneId: m.id,
        actualDate: actual > T ? T : actual,
      })
      done += 1
    }
  }
  console.log(`[running] ${done} milestones actualised`)
}

/**
 * Has this phase already run?
 *
 * Each floor phase is keyed on its own sample request number, because the request is the
 * first thing the phase writes — so a run interrupted anywhere after it will skip the
 * phase rather than half-repeat it. Blunt on purpose: re-seeding a phase properly means
 * deleting its rows, and a script that guessed which half to redo would be worse than one
 * that plainly declines.
 */
async function sampleExists(ctx: RequestCtx, requestNo: string): Promise<boolean> {
  const { sampleRequests } = await import('@/modules/sampling/schema')
  const [row] = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: sampleRequests.id })
      .from(sampleRequests)
      .where(scoped(sampleRequests, ctx, eq(sampleRequests.requestNo, requestNo))),
  )
  return Boolean(row)
}

/**
 * Issue up to `want` free rolls to an order, so the cutting gate can pass.
 *
 * Skips bonded stock deliberately: a bonded issue draws a UD, and quietly consuming a
 * declaration to make a demo look full is exactly the sort of thing that makes a customs
 * balance untrustworthy. Bonded flow gets its own exercise, on purpose, not as a side
 * effect of seeding.
 */
async function issueFabricFor(ctx: RequestCtx, orderId: string, want: number): Promise<string[]> {
  const { grnLines, grns, issueLines, rolls } = await import('@/modules/store/schema')
  const { issueStock } = await import('@/modules/store/service')

  const free = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: rolls.id, itemId: rolls.itemId, qty: rolls.qty, unit: rolls.unit })
      .from(rolls)
      .innerJoin(grnLines, eq(rolls.grnLineId, grnLines.id))
      .innerJoin(grns, eq(grnLines.grnId, grns.id))
      .where(
        scoped(
          rolls,
          ctx,
          eq(rolls.status, 'in_stock'),
          eq(grns.bonded, false),
          sql`not exists (select 1 from ${issueLines} il where il.roll_id = ${rolls.id})`,
        ),
      )
      .limit(want),
  )
  if (free.length === 0) return []

  await issueStock(ctx, {
    orderId,
    lines: free.map((r) => ({ itemId: r.itemId, rollId: r.id, qty: r.qty, unit: r.unit })),
  })
  return free.map((r) => r.id)
}

async function main(): Promise<void> {
  const client = createDirectClient()
  const db = createDirectDb(client)

  try {
    const [company] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      // eslint-disable-next-line fabricxai/require-tenant-predicate -- this IS the tenant resolution; there is no companyId until it returns
      .where(eq(companies.slug, SLUG))
    if (!company) throw new Error(`no company with slug "${SLUG}"`)

    // Act as an owner of this tenant, so every service call is a real, authorised one.
    const [owner] = await db
      .select({ userId: rolesTable.userId })
      .from(rolesTable)
      .where(and(eq(rolesTable.companyId, company.id), eq(rolesTable.role, 'owner')))
    if (!owner) throw new Error(`company ${company.name} has no owner`)

    const ctx: RequestCtx = {
      companyId: company.id,
      userId: owner.userId,
      roles: ['owner', 'merchandiser', 'commercial', 'planner', 'store', 'cutting', 'production', 'quality', 'shipment'],
    }

    console.log(`[running] ${company.name} (${company.id})`)

    // ── buyers ────────────────────────────────────────────────────────────────
    const buyerIds: Record<string, string> = {}
    for (const b of BUYERS) {
      const [row] = await withTenantTx(ctx, (tx) =>
        tx
          .insert(buyers)
          .values({
            companyId: ctx.companyId,
            code: b.code,
            name: b.name,
            country: b.country,
            createdBy: ctx.userId,
          })
          .onConflictDoUpdate({ target: [buyers.companyId, buyers.code], set: { name: b.name } })
          .returning({ id: buyers.id }),
      )
      buyerIds[b.code] = row!.id
    }
    console.log(`[running] buyers: ${BUYERS.map((b) => b.name).join(', ')}`)

    await seedDefaultTnaTemplates(ctx)

    // ── the three orders ──────────────────────────────────────────────────────
    const plan = [
      {
        po: 'JKT-2210',
        buyer: 'BST',
        style: 'ST-2210',
        description: "men's woven jacket · 12oz canvas, garment washed",
        qty: 9000,
        price: '18.40',
        productType: 'jacket',
        ship: day(62),
        status: 'confirmed' as const,
        grid: { Navy: [900, 1800, 2100, 1500, 600], Stone: [400, 500, 700, 400, 100] },
      },
      {
        po: 'POLO-2244',
        buyer: 'HM',
        style: 'ST-2244',
        description: "men's polo · 180gsm pique, 3-button placket",
        qty: 24000,
        price: '6.20',
        productType: 'polo',
        ship: day(24),
        status: 'in_production' as const,
        grid: { White: [2400, 4800, 5400, 3000, 900], Navy: [1800, 2400, 2100, 1000, 200] },
      },
      {
        po: 'DENIM-2251',
        buyer: 'PRK',
        style: 'ST-2251',
        description: "men's denim jacket · 12oz stretch, stone wash",
        qty: 12000,
        price: '16.50',
        productType: 'jacket',
        ship: day(6),
        status: 'shipped_partial' as const,
        grid: { Indigo: [1500, 2700, 3300, 2400, 600], Black: [300, 400, 500, 250, 50] },
      },
    ]

    for (const p of plan) {
      const [existing] = await withTenantRead(ctx, (tx) =>
        tx
          .select({ id: orders.id })
          .from(orders)
          .where(scoped(orders, ctx, sql`${orders.poNumbers} @> ARRAY[${p.po}]::text[]`)),
      )
      if (existing) {
        console.log(`[running] ${p.po} already there, left alone`)
        continue
      }

      const created = await createOrder(ctx, {
        order: {
          buyerId: buyerIds[p.buyer]!,
          poNumbers: [p.po],
          totalValue: (Number(p.price) * p.qty).toFixed(2),
          currency: 'USD',
          plannedExFactoryDate: p.ship,
        },
        styles: [
          {
            styleCode: p.style,
            description: p.description,
            contractedQty: p.qty,
            unitPrice: p.price,
            currency: 'USD',
          },
        ],
      })

      const template = await findTemplateForProductType(ctx, { productType: p.productType })
      if (template) {
        await generateTna(ctx, {
          orderId: created.orderId,
          templateId: template.id,
          exFactoryDate: p.ship,
        })
      }

      const [style] = await withTenantRead(ctx, (tx) =>
        tx
          .select({ id: orderStyles.id })
          .from(orderStyles)
          .where(scoped(orderStyles, ctx, eq(orderStyles.orderId, created.orderId))),
      )

      const cells = Object.entries(p.grid).flatMap(([color, qtys]) =>
        (qtys as number[]).map((qty, i) => ({ color, size: SIZES[i]!, qty })),
      )
      await saveBreakdown(ctx, {
        orderStyleId: style!.id,
        cells,
        buyerRevision: false,
        reason: 'buyer purchase order',
      })

      // Walk the status machine the way the desk would, one legal transition at a time.
      const path: Record<string, string[]> = {
        confirmed: [],
        in_production: ['in_production'],
        shipped_partial: ['in_production', 'shipped_partial'],
      }
      for (const next of path[p.status] ?? []) {
        await setOrderStatus(ctx, { orderId: created.orderId, status: next as never })
      }

      console.log(
        `[running] ${p.po} · ${p.style} · ${p.qty.toLocaleString()} pcs · ${p.status} · ships ${p.ship}`,
      )
    }

    // ── the calendar these orders have actually walked ────────────────────────
    //
    // Without this every order reads LATE on its very first milestone, because a TNA
    // template dates "PO received" 120–150 days before ex-factory — a date already in the
    // past for anything shipping this quarter. A factory mid-flight has HIT those
    // milestones; leaving them unactualised produced a desk claiming three late orders on
    // a floor that is visibly working, which is the seed lying about the state it built.
    //
    // Only milestones whose planned date has passed, and only up to the phase each order
    // has actually reached: JKT is still in sampling, so its cutting milestones stay open.
    await actualizePastMilestones(ctx, {
      'JKT-2210': ['order_confirmed', 'yarn_booking', 'fabric_booking', 'yarn_in_house'],
      'POLO-2244': null, // everything already due
      'DENIM-2251': null,
    })

    await refreshMilestoneStatuses(ctx, { today: T })

    // ── the floor ─────────────────────────────────────────────────────────────
    const found = await withTenantRead(ctx, (tx) =>
      tx
        .select({ id: orders.id, po: orders.poNumbers, styleId: orderStyles.id, styleCode: orderStyles.styleCode })
        .from(orders)
        .innerJoin(orderStyles, eq(orderStyles.orderId, orders.id))
        .where(tenantEq(orders, ctx)),
    )
    const byPo = (po: string) => {
      const row = found.find((o) => (o.po as string[]).includes(po))
      if (!row) throw new Error(`${po} missing after booking`)
      return row
    }

    const lineRows = await withTenantRead(ctx, (tx) =>
      tx.select({ id: lines.id, code: lines.code }).from(lines).where(scoped(lines, ctx, eq(lines.isActive, true))),
    )

    await samplingPhase(ctx, byPo('JKT-2210'))
    await productionPhase(ctx, byPo('POLO-2244'), lineRows)
    await shippingPhase(ctx, byPo('DENIM-2251'), lineRows)

    console.log('\n[running] done.')
  } finally {
    await client.end()
  }
}

await main()
