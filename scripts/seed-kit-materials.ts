/**
 * The live-test kit's money rails and materials, as reference data the traps can bite into.
 *
 * `pnpm tsx scripts/seed-kit-materials.ts --slug=test-textile`
 *
 * ## What this is for
 *
 * The runbook's Phases 3 and 4 are mostly setup with five refusals hidden in them, and the
 * refusals are the point:
 *
 *   · **BTB headroom** — a fourth back-to-back credit that would push the pile past the
 *     master LC's ceiling must be REJECTED at the counter, not discovered at the bank.
 *   · **UD overdraw** — 1,450 yards drawn against a declaration with 1,200 left is legal
 *     exposure, so it blocks and an owner may override it in writing.
 *   · **Shade mix** — an order already cut in shade A being handed shade B warns.
 *   · **Import PO without a BTB** — blocked at financing.
 *   · **Failed 4-point rolls** — three rolls the mill's own packing list flags must not be
 *     issuable.
 *
 * A refusal cannot be tested against an empty tenant: every one of them is arithmetic over
 * rows that must already exist and must already be *nearly* exhausted. So this seeds the
 * three credits, the four sub-credits that fit, the two declarations drawn down to the
 * kit's stated balances, the suppliers, the items, the receipts and the rolls — and then
 * stops, deliberately, one step short of each trap.
 *
 * ## What it deliberately does NOT do
 *
 *   · BTB-5120-02 ($62,000) — the one that must be refused. Opened here it would either
 *     succeed and prove nothing, or fail and leave the tenant unable to show the refusal.
 *   · SPO-1105 — the import PO with no BTB behind it.
 *   · ISS-117 (shade B) and ISS-118 (1,450 yds) — the two store refusals.
 *
 * Those five are for a person to attempt, through the screen, as the role that would.
 *
 * ## Everything goes through the real services
 *
 * `createLc`, `linkOrder`, `openBtb`, `createUd`, `drawUdStandalone`, `createSupplier`,
 * `upsertItem`, `issuePo`, `receiveGrn`, `inspectFabric`, `issueStock`. A gate that a seed
 * wrote around is a gate that has never run.
 *
 * Idempotent: each stretch checks for its own first row and skips if it is already there.
 */
import 'dotenv/config'
// Importing the registry IS registration — the gates and commit handlers below are all
// reached through it.
import '@/modules/registry'

import { and, eq, inArray, sql } from 'drizzle-orm'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, roles as rolesTable } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import { btbLcs, lcs, uds } from '@/modules/commercial/schema'
import {
  type BankDocsPolicy,
  createLc,
  createUd,
  drawUdStandalone,
  getUdBalance,
  linkOrder,
  openBtb,
} from '@/modules/commercial/service'
import type { RequestCtx } from '@/modules/core/ctx'
import { scoped, tenantEq } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'
import { orders, orderStyles } from '@/modules/orders/schema'
import {
  createOrder,
  findTemplateForProductType,
  generateTna,
  saveBreakdown,
} from '@/modules/orders/service'
import { supplierPos, suppliers } from '@/modules/procurement/schema'
import { createSupplier, issuePo, type ProcurementPolicy } from '@/modules/procurement/service'
import { inspectFabric, type QualityPolicy } from '@/modules/quality/service'
import { getPolicy, setPolicy } from '@/modules/settings/service'
import { grns, locations, rolls } from '@/modules/store/schema'
import { issueStock, receiveGrn, upsertItem } from '@/modules/store/service'

const args = process.argv.slice(2)
const flag = (name: string): string | undefined =>
  args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')

const SLUG = flag('slug') ?? 'test-textile'

// ─────────────────────────────────────────────────────────────────────────────
// The kit's own numbers. Transcribed, not derived — where the kit and the arithmetic
// disagree the kit is what the tester will be holding, and a seed that quietly corrected
// it would make the runbook's ticks unverifiable.
// ─────────────────────────────────────────────────────────────────────────────

const KIT_LCS = [
  {
    number: 'LC-4471',
    buyer: 'BST',
    value: '244800.00',
    tolerancePct: '3',
    issueDate: '2026-08-10',
    expiryDate: '2026-12-05',
    latestShipmentDate: '2026-11-18',
    linkPo: 'PO-BF-2044',
    docsRequired: {
      commercial_invoice: true,
      packing_list: true,
      bl: true,
      certificate_of_origin: true,
      inspection_certificate: true,
      exp_form: true,
    },
  },
  {
    number: 'LC-5120',
    buyer: 'HM',
    value: '198000.00',
    tolerancePct: '3',
    issueDate: '2026-08-25',
    expiryDate: '2026-12-10',
    latestShipmentDate: '2026-11-17',
    linkPo: 'PO-BF-2051',
    docsRequired: { commercial_invoice: true, packing_list: true, bl: true, exp_form: true },
  },
] as const

/**
 * The three that fit. BTB-5120-02 is absent on purpose — see the header.
 *
 * Against a 70% ceiling: LC-4471 carries 44,300 of an allowed 171,360, and LC-5120 carries
 * 78,900 of an allowed 138,600. Adding 62,000 to the second makes 140,900, which is 2,300
 * over — small enough that a person eyeballing it would let it through, which is exactly
 * why the arithmetic is the machine's job.
 */
const KIT_BTBS = [
  { number: 'BTB-4471-01', master: 'LC-4471', supplier: 'Square Yarns Ltd', value: '34500.00' },
  { number: 'BTB-4471-02', master: 'LC-4471', supplier: null, value: '9800.00' },
  { number: 'BTB-5120-01', master: 'LC-5120', supplier: 'Foshan Denim Mills', value: '78900.00' },
] as const

/**
 * The two declarations, and how much of each is already spent.
 *
 * `priorDrawn` is recorded as a standalone consumption with no store issue behind it, and
 * that is honest rather than convenient: a UD runs for a year across several consignments,
 * and what the store received last week is not the whole of what has been declared against
 * it. UD-2026-044 having 22,800 of 24,000 yards gone while 23,500 yards sit in the bonded
 * store IS the factory's exposure — it imported against a declaration nearly spent, and the
 * next issue is the one that finds out.
 *
 * `itemRef` is written the way customs wrote it. The store speaks in codes; `drawUd`
 * resolves between the two through the item's name, which is why the item below is named
 * "12oz stretch denim" and carries its width in `spec` rather than in its name.
 */
const KIT_UDS = [
  {
    number: 'UD-2026-031',
    validUntil: '2027-03-31',
    itemRef: '30/1 combed cotton yarn',
    authorized: '42000.00',
    unit: 'kg',
    priorDrawn: '28560.00',
    expectFree: '13440.00',
  },
  {
    number: 'UD-2026-044',
    validUntil: '2027-02-28',
    itemRef: '12oz stretch denim',
    authorized: '24000.00',
    unit: 'yds',
    priorDrawn: '22800.00',
    expectFree: '1200.00',
  },
] as const

const KIT_SUPPLIERS = [
  { code: 'SQ-YRN', name: 'Square Yarns Ltd', type: 'yarn', origin: 'local', currency: 'USD' },
  { code: 'FOSHAN', name: 'Foshan Denim Mills', type: 'fabric_mill', origin: 'import', currency: 'USD' },
  { code: 'DHK-TRM', name: 'Dhaka Trims House', type: 'trims', origin: 'local', currency: 'BDT' },
  { code: 'CLNWSH', name: 'CleanWash BD', type: 'subcontract', origin: 'local', currency: 'BDT' },
] as const

/**
 * The kit's item master.
 *
 * `FAB-PIQ-180` already existed from the demo seed, in metres. Knit piqué is bought, dyed,
 * issued and costed by the kilo in every factory in Bangladesh, and the kit says kg — so
 * this corrects it. Nothing has ever been transacted against that item, which is the only
 * condition under which `upsertItem` will now let a unit change.
 */
const KIT_ITEMS = [
  { code: 'YRN-30-1', name: '30/1 combed cotton yarn', kind: 'yarn', uom: 'kg', spec: { count: '30/1', fibre: 'combed cotton' } },
  { code: 'GRG-PIQ', name: 'greige piqué 180gsm', kind: 'greige', uom: 'kg', spec: { gsm: '180', construction: 'single piqué' } },
  { code: 'FAB-PIQ-180', name: 'dyed piqué 180gsm', kind: 'fabric', uom: 'kg', spec: { gsm: '180', construction: 'single piqué' } },
  { code: 'FAB-DEN-12', name: '12oz stretch denim', kind: 'fabric', uom: 'yds', spec: { weight: '12oz', width: '58"', stretch: 'yes' } },
  { code: 'TRM-PLK', name: '3-button placket set', kind: 'trim', uom: 'pcs', spec: {} },
  { code: 'TRM-ZIP', name: 'YKK jacket zipper', kind: 'trim', uom: 'pcs', spec: {} },
] as const

/** Dyed piqué from the factory's own dyeing — lot, shade, and which shade group it is in. */
const PIQUE_ROLLS = [
  ['R-P-01', '218.40', 'DYE-LOT-1', 'A'], ['R-P-02', '181.50', 'DYE-LOT-1', 'A'],
  ['R-P-03', '196.50', 'DYE-LOT-1', 'A'], ['R-P-04', '193.40', 'DYE-LOT-1', 'A'],
  ['R-P-05', '224.20', 'DYE-LOT-1', 'A'], ['R-P-06', '220.60', 'DYE-LOT-2', 'A'],
  ['R-P-07', '233.50', 'DYE-LOT-2', 'A'], ['R-P-08', '185.20', 'DYE-LOT-2', 'A'],
  ['R-P-09', '205.30', 'DYE-LOT-2', 'A'], ['R-P-10', '181.80', 'DYE-LOT-2', 'A'],
  ['R-P-11', '193.10', 'DYE-LOT-2', 'A'], ['R-P-12', '210.30', 'DYE-LOT-3', 'B'],
  ['R-P-13', '181.60', 'DYE-LOT-3', 'B'], ['R-P-14', '191.90', 'DYE-LOT-3', 'B'],
  ['R-P-15', '219.00', 'DYE-LOT-3', 'B'], ['R-P-16', '212.70', 'DYE-LOT-3', 'B'],
  ['R-P-17', '193.20', 'DYE-LOT-3', 'B'], ['R-P-18', '215.40', 'DYE-LOT-4', 'B'],
] as const

/** Foshan's consignment. 19–21 are the three the packing list flags — they fail 4-point. */
const DENIM_ROLLS = [
  ['R-D-01', '1343.00', 'A'], ['R-D-02', '1102.00', 'B'], ['R-D-03', '1342.00', 'A'],
  ['R-D-04', '1309.00', 'A'], ['R-D-05', '1202.00', 'B'], ['R-D-06', '1147.00', 'A'],
  ['R-D-07', '1387.00', 'A'], ['R-D-08', '1201.00', 'B'], ['R-D-09', '1128.00', 'A'],
  ['R-D-10', '1129.00', 'A'], ['R-D-11', '1354.00', 'B'], ['R-D-12', '1281.00', 'A'],
  ['R-D-13', '1342.00', 'A'], ['R-D-14', '1319.00', 'B'], ['R-D-15', '1261.00', 'A'],
  ['R-D-16', '1392.00', 'A'], ['R-D-17', '1214.00', 'B'], ['R-D-18', '1266.00', 'A'],
  ['R-D-19', '1349.00', 'A'], ['R-D-20', '1286.00', 'B'], ['R-D-21', '1359.00', 'A'],
] as const

const FAILED_ROLLS = ['R-D-19', 'R-D-20', 'R-D-21']

// ─────────────────────────────────────────────────────────────────────────────

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

    const [owner] = await db
      .select({ userId: rolesTable.userId })
      .from(rolesTable)
      .where(and(eq(rolesTable.companyId, company.id), eq(rolesTable.role, 'owner')))
    if (!owner) throw new Error(`company ${company.name} has no owner`)

    const ctx: RequestCtx = {
      companyId: company.id,
      userId: owner.userId,
      roles: ['owner', 'admin', 'merchandiser', 'commercial', 'procurement', 'store', 'quality'],
    }

    console.log(`[kit] ${company.name} (${SLUG})`)

    await setBtbCeiling(ctx)
    const orderIds = await bookDenimOrder(ctx)
    await moneyRails(ctx, orderIds)
    const udIds = await declarations(ctx)
    const supplierIds = await supplierList(ctx)
    const itemIds = await itemMaster(ctx)
    const poIds = await supplierOrders(ctx, supplierIds, itemIds)
    await receipts(ctx, { udIds, itemIds, poIds })
    await fourPoint(ctx)
    await firstIssue(ctx, orderIds, itemIds)
    await report(ctx, udIds)
    await phase3Fixtures(ctx, orderIds)

    console.log('\n[kit] done. Five traps are armed and unfired — see the header.')
  } finally {
    await client.end()
  }
}

/**
 * The back-to-back ceiling the traps are measured against.
 *
 * The kit gives a limit PER CREDIT: 75% on LC-4471, 70% on LC-5120. This product holds one
 * figure for the whole company, so the tighter of the two is set — which keeps both credits
 * legal and makes the trap fire where the kit says it should. **The mismatch is real and
 * worth recording**: a BTB ceiling is a term the issuing bank writes into a particular
 * credit, not a house rule, and a factory running two credits on different terms cannot say
 * so here. Noted rather than worked around.
 */
async function setBtbCeiling(ctx: RequestCtx): Promise<void> {
  for (const moduleId of ['commercial', 'procurement']) {
    const current = await getPolicy<{ btbLimitPct?: number }>(ctx, moduleId)
    if (current.btbLimitPct === 70) continue
    await setPolicy(ctx, { moduleId, patch: { btbLimitPct: 70 } })
  }
  console.log('[kit] BTB ceiling set to 70% of the master credit')
}

/** PO-BF-2051 — H&M's denim jacket, the order the UD trap is drawn against. */
async function bookDenimOrder(ctx: RequestCtx): Promise<Map<string, string>> {
  const existing = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: orders.id, po: orders.poNumbers })
      .from(orders)
      .where(scoped(orders, ctx, sql`${orders.poNumbers} && ARRAY['PO-BF-2044','PO-BF-2051']::text[]`)),
  )

  const byPo = new Map<string, string>()
  for (const row of existing) {
    for (const po of row.po as string[]) byPo.set(po, row.id)
  }

  if (!byPo.has('PO-BF-2051')) {
    const [buyer] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: buyers.id }).from(buyers).where(scoped(buyers, ctx, eq(buyers.code, 'HM'))),
    )
    if (!buyer) throw new Error('buyer HM missing — run seed-running-factory first')

    const created = await createOrder(ctx, {
      order: {
        buyerId: buyer.id,
        poNumbers: ['PO-BF-2051'],
        totalValue: '198000.00',
        currency: 'USD',
        // One day inside LC-5120's latest shipment. The float the runbook asks Tanvir to
        // look at, and the reason any slip on this order is an LC conflict rather than a
        // planning problem.
        plannedExFactoryDate: '2026-11-16',
      },
      styles: [
        {
          styleCode: 'ST-2712',
          description: "men's denim jacket · 12oz stretch denim",
          contractedQty: 12000,
          unitPrice: '16.50',
          currency: 'USD',
        },
      ],
    })

    const template = await findTemplateForProductType(ctx, { productType: 'jacket' })
    if (template) {
      await generateTna(ctx, {
        orderId: created.orderId,
        templateId: template.id,
        exFactoryDate: '2026-11-16',
      })
    }

    const [style] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: orderStyles.id }).from(orderStyles).where(scoped(orderStyles, ctx, eq(orderStyles.orderId, created.orderId))),
    )

    const grid: Record<string, Record<string, number>> = {
      'Indigo Wash': { S: 800, M: 1600, L: 1900, XL: 1100 },
      'Black Wash': { S: 500, M: 1300, L: 1500, XL: 900 },
      'Light Stone': { S: 300, M: 700, L: 900, XL: 500 },
    }
    await saveBreakdown(ctx, {
      orderStyleId: style!.id,
      cells: Object.entries(grid).flatMap(([color, sizes]) =>
        Object.entries(sizes).map(([size, qty]) => ({ color, size, qty })),
      ),
      buyerRevision: false,
      reason: 'buyer purchase order',
    })

    byPo.set('PO-BF-2051', created.orderId)
    console.log('[kit] PO-BF-2051 · ST-2712 · 12,000 pcs · ships 2026-11-16')
  }

  return byPo
}

/** The two master credits, linked to their orders, and the three sub-credits that fit. */
async function moneyRails(ctx: RequestCtx, orderIds: Map<string, string>): Promise<void> {
  const lcIds = new Map<string, string>()

  for (const lc of KIT_LCS) {
    const [found] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: lcs.id }).from(lcs).where(scoped(lcs, ctx, eq(lcs.number, lc.number))),
    )
    if (found) {
      lcIds.set(lc.number, found.id)
      continue
    }

    const [buyer] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: buyers.id }).from(buyers).where(scoped(buyers, ctx, eq(buyers.code, lc.buyer))),
    )
    if (!buyer) throw new Error(`buyer ${lc.buyer} missing`)

    const created = await createLc(ctx, {
      buyerId: buyer.id,
      number: lc.number,
      value: lc.value,
      currency: 'USD',
      tolerancePct: lc.tolerancePct,
      issueDate: lc.issueDate,
      latestShipmentDate: lc.latestShipmentDate,
      expiryDate: lc.expiryDate,
      docsRequired: lc.docsRequired,
    })
    lcIds.set(lc.number, created.lcId)

    const orderId = orderIds.get(lc.linkPo)
    if (orderId) {
      const { floatDays } = await linkOrder(ctx, { lcId: created.lcId, orderId })
      console.log(
        `[kit] ${lc.number} · $${Number(lc.value).toLocaleString()} → ${lc.linkPo} · ${floatDays} day float`,
      )
    } else {
      console.log(`[kit] ${lc.number} · $${Number(lc.value).toLocaleString()} (no ${lc.linkPo} to link)`)
    }
  }

  const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')

  for (const btb of KIT_BTBS) {
    const [found] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: btbLcs.id }).from(btbLcs).where(scoped(btbLcs, ctx, eq(btbLcs.number, btb.number))),
    )
    if (found) continue

    const masterLcId = lcIds.get(btb.master)
    if (!masterLcId) continue

    let supplierId: string | undefined
    if (btb.supplier) {
      const [row] = await withTenantRead(ctx, (tx) =>
        tx.select({ id: suppliers.id }).from(suppliers).where(scoped(suppliers, ctx, eq(suppliers.name, btb.supplier!))),
      )
      supplierId = row?.id
    }

    const opened = await openBtb(
      ctx,
      {
        masterLcId,
        number: btb.number,
        value: btb.value,
        currency: 'USD',
        ...(supplierId ? { supplierId } : {}),
      },
      policy,
    )
    console.log(
      `[kit] ${btb.number} · $${Number(btb.value).toLocaleString()} · free after: $${Number(opened.headroom.free).toLocaleString()}`,
    )
  }
}

/** The two UDs, drawn down to the balances the kit states. */
async function declarations(ctx: RequestCtx): Promise<Map<string, string>> {
  const ids = new Map<string, string>()

  for (const ud of KIT_UDS) {
    const [found] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: uds.id }).from(uds).where(scoped(uds, ctx, eq(uds.number, ud.number))),
    )
    if (found) {
      ids.set(ud.number, found.id)
      continue
    }

    const created = await createUd(ctx, {
      number: ud.number,
      validUntil: ud.validUntil,
      authorizedItems: [{ itemRef: ud.itemRef, qty: ud.authorized, unit: ud.unit }],
    })
    ids.set(ud.number, created.udId)

    await drawUdStandalone(ctx, {
      udId: created.udId,
      itemRef: ud.itemRef,
      qty: ud.priorDrawn,
      unit: ud.unit,
    })
    console.log(
      `[kit] ${ud.number} · ${Number(ud.authorized).toLocaleString()} ${ud.unit} authorised, ${Number(ud.priorDrawn).toLocaleString()} already drawn`,
    )
  }

  return ids
}

async function supplierList(ctx: RequestCtx): Promise<Map<string, string>> {
  const ids = new Map<string, string>()

  for (const s of KIT_SUPPLIERS) {
    const [found] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: suppliers.id }).from(suppliers).where(scoped(suppliers, ctx, eq(suppliers.code, s.code))),
    )
    if (found) {
      ids.set(s.name, found.id)
      continue
    }
    const created = await createSupplier(ctx, {
      code: s.code,
      name: s.name,
      type: s.type,
      origin: s.origin,
      defaultCurrency: s.currency,
    })
    ids.set(s.name, created.supplierId)
    console.log(`[kit] supplier ${s.name} (${s.origin})`)
  }

  return ids
}

async function itemMaster(ctx: RequestCtx): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  for (const item of KIT_ITEMS) {
    const created = await upsertItem(ctx, {
      code: item.code,
      name: item.name,
      kind: item.kind,
      uom: item.uom,
      spec: item.spec,
    })
    ids.set(item.code, created.itemId)
  }
  console.log(`[kit] ${KIT_ITEMS.length} items on the master list`)
  return ids
}

/**
 * The three purchase orders that were legally issuable.
 *
 * SPO-1105 is missing on purpose: a top-up from Foshan, an IMPORT supplier, with no BTB
 * behind it. Issuing it must be refused at financing, and that refusal is a person's to
 * see.
 */
async function supplierOrders(
  ctx: RequestCtx,
  supplierIds: Map<string, string>,
  itemIds: Map<string, string>,
): Promise<Map<string, string>> {
  const ids = new Map<string, string>()
  const policy = await getPolicy<ProcurementPolicy>(ctx, 'procurement')

  const [btb5120] = await withTenantRead(ctx, (tx) =>
    tx.select({ id: btbLcs.id }).from(btbLcs).where(scoped(btbLcs, ctx, eq(btbLcs.number, 'BTB-5120-01'))),
  )

  const plan = [
    {
      poNumber: 'SPO-1101',
      supplier: 'Square Yarns Ltd',
      currency: 'USD',
      lines: [{ item: 'YRN-30-1', qty: '10600.00', unit: 'kg', unitPrice: '3.1000' }],
    },
    {
      poNumber: 'SPO-1102',
      supplier: 'Dhaka Trims House',
      currency: 'BDT',
      lines: [{ item: 'TRM-PLK', qty: '38000.00', unit: 'pcs', unitPrice: '21.3600' }],
    },
    {
      poNumber: 'SPO-1103',
      supplier: 'Foshan Denim Mills',
      currency: 'USD',
      // Import. Without this the gate refuses — which is SPO-1105's whole story.
      btbLcId: btb5120?.id,
      lines: [{ item: 'FAB-DEN-12', qty: '23500.00', unit: 'yds', unitPrice: '3.3500' }],
    },
  ] as const

  for (const po of plan) {
    const [found] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: supplierPos.id }).from(supplierPos).where(scoped(supplierPos, ctx, eq(supplierPos.poNumber, po.poNumber))),
    )
    if (found) {
      ids.set(po.poNumber, found.id)
      continue
    }

    const supplierId = supplierIds.get(po.supplier)
    if (!supplierId) continue

    const issued = await issuePo(
      ctx,
      {
        supplierId,
        poNumber: po.poNumber,
        currency: po.currency,
        ...('btbLcId' in po && po.btbLcId ? { btbLcId: po.btbLcId } : {}),
        lines: po.lines.map((l) => ({
          itemId: itemIds.get(l.item)!,
          qty: l.qty,
          unit: l.unit,
          unitPrice: l.unitPrice,
        })),
      },
      policy,
    )
    ids.set(po.poNumber, issued.supplierPoId)
    console.log(`[kit] ${po.poNumber} · ${po.supplier} · ${issued.currency} ${Number(issued.totalValue).toLocaleString()}`)
  }

  return ids
}

/**
 * What physically arrived.
 *
 * Four receipts, and the fourth is the one worth explaining. The dyed piqué has no supplier
 * behind it — this factory knits and dyes its own — so it comes in on a GRN with no
 * purchase order and into the GENERAL store, because nothing about it is bonded. The denim
 * and the yarn are imported duty-free and land in the bonded store against their
 * declarations.
 */
async function receipts(
  ctx: RequestCtx,
  refs: { udIds: Map<string, string>; itemIds: Map<string, string>; poIds: Map<string, string> },
): Promise<void> {
  const locationRows = await withTenantRead(ctx, (tx) =>
    tx.select({ id: locations.id, kind: locations.kind }).from(locations).where(tenantEq(locations, ctx)),
  )
  const bonded = locationRows.find((l) => l.kind === 'bonded')?.id
  const general = locationRows.find((l) => l.kind === 'general')?.id
  if (!bonded || !general) throw new Error('this tenant has no bonded and general store')

  const plan = [
    {
      challanNo: 'SQ-88213',
      receivedAt: '2026-09-04',
      bonded: true,
      udId: refs.udIds.get('UD-2026-031'),
      supplierPoId: refs.poIds.get('SPO-1101'),
      lines: [{ itemId: refs.itemIds.get('YRN-30-1')!, qty: '10600.00', unit: 'kg', rolls: [] }],
    },
    {
      challanNo: 'DTH-4402',
      receivedAt: '2026-09-10',
      bonded: false,
      supplierPoId: refs.poIds.get('SPO-1102'),
      lines: [{ itemId: refs.itemIds.get('TRM-PLK')!, qty: '38000.00', unit: 'pcs', rolls: [] }],
    },
    {
      challanNo: 'FS-INV-7741',
      receivedAt: '2026-09-29',
      bonded: true,
      udId: refs.udIds.get('UD-2026-044'),
      supplierPoId: refs.poIds.get('SPO-1103'),
      lines: [
        {
          itemId: refs.itemIds.get('FAB-DEN-12')!,
          qty: '23500.00',
          unit: 'yds',
          rolls: DENIM_ROLLS.map(([rollNo, qty, shade]) => ({
            rollNo,
            qty,
            locationId: bonded,
            lot: 'FS-7741',
            shadeGroup: shade,
          })),
        },
      ],
    },
    {
      challanNo: 'DYE-2026-09',
      receivedAt: '2026-09-22',
      bonded: false,
      lines: [
        {
          itemId: refs.itemIds.get('FAB-PIQ-180')!,
          qty: '3657.60',
          unit: 'kg',
          rolls: PIQUE_ROLLS.map(([rollNo, qty, lot, shade]) => ({
            rollNo,
            qty,
            locationId: general,
            lot,
            dyeLot: lot,
            shadeGroup: shade,
          })),
        },
      ],
    },
  ]

  for (const grn of plan) {
    const [found] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: grns.id }).from(grns).where(scoped(grns, ctx, eq(grns.challanNo, grn.challanNo))),
    )
    if (found) continue

    const received = await receiveGrn(ctx, {
      challanNo: grn.challanNo,
      receivedAt: grn.receivedAt,
      bonded: grn.bonded,
      ...(grn.udId ? { udId: grn.udId } : {}),
      ...(grn.supplierPoId ? { supplierPoId: grn.supplierPoId } : {}),
      lines: grn.lines,
    })
    console.log(`[kit] GRN ${grn.challanNo} · ${received.rolls} rolls`)
  }
}

/**
 * The mill's own 4-point sheet, filed roll by roll.
 *
 * Rolls 19, 20 and 21 fail — the packing list says so, and a roll that failed inspection
 * must not be issuable however much the floor wants it. The other eighteen pass, because a
 * roll nobody inspected is blocked too, and an unexercised gate cannot tell those two
 * refusals apart on a screen.
 *
 * 58" cloth over the roll's own yardage, at points chosen to land either side of the
 * threshold rather than at a number nobody would believe.
 */
async function fourPoint(ctx: RequestCtx): Promise<void> {
  const [grn] = await withTenantRead(ctx, (tx) =>
    tx.select({ id: grns.id }).from(grns).where(scoped(grns, ctx, eq(grns.challanNo, 'FS-INV-7741'))),
  )
  if (!grn) return

  const { grnLines } = await import('@/modules/store/schema')
  const rollRows = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: rolls.id, rollNo: rolls.rollNo })
      .from(rolls)
      .innerJoin(grnLines, eq(grnLines.id, rolls.grnLineId))
      .where(scoped(rolls, ctx, eq(grnLines.grnId, grn.id))),
  )

  const { fabricInspections } = await import('@/modules/quality/schema')
  const already = await withTenantRead(ctx, (tx) =>
    tx.select({ id: fabricInspections.id }).from(fabricInspections).where(scoped(fabricInspections, ctx, eq(fabricInspections.grnId, grn.id))),
  )
  if (already.length > 0) return

  const policy = await getPolicy<QualityPolicy>(ctx, 'quality')

  let passed = 0
  let failed = 0
  for (const [rollNo, qty] of DENIM_ROLLS) {
    const roll = rollRows.find((r) => r.rollNo === rollNo)
    if (!roll) continue

    // Points per 100 sq yd = totalPoints × 3600 / (yards × width). At 58" and ~1,300 yards
    // that is roughly totalPoints × 0.048 — so ~600 points to fail a 40 threshold and ~250
    // to sit comfortably under it.
    const fail = FAILED_ROLLS.includes(rollNo)
    const bands = fail
      ? { 1: 60, 2: 55, 3: 70, 4: 60 }
      : { 1: 40, 2: 20, 3: 10, 4: 5 }

    const result = await inspectFabric(
      ctx,
      {
        grnId: grn.id,
        rollId: roll.id,
        points4: bands,
        inspectedLengthYards: qty,
        widthInches: '58.00',
      },
      policy,
    )
    if (result.result === 'fail') failed += 1
    else passed += 1
  }

  console.log(`[kit] 4-point filed · ${passed} passed, ${failed} failed (threshold ${policy.fabricMaxPointsPer100SqYd}/100sq yd)`)
}

/**
 * ISS-114 — the first issue against PO-BF-2044, all of it shade A.
 *
 * This is what arms the shade-mix trap. `checkShadeMix` compares what an order already
 * holds against what is being picked, so until an order holds SOMETHING there is no mix to
 * warn about, and ISS-117's shade B rolls would go out silently.
 *
 * The kit calls ISS-114 6,200 kg; the eleven rolls it names come to 2,233.5. The rolls are
 * what the seed can be truthful about, so the rolls win and the tonnage does not.
 */
async function firstIssue(
  ctx: RequestCtx,
  orderIds: Map<string, string>,
  itemIds: Map<string, string>,
): Promise<void> {
  const orderId = orderIds.get('PO-BF-2044')
  if (!orderId) {
    console.log('[kit] no PO-BF-2044 — skipping ISS-114')
    return
  }

  const itemId = itemIds.get('FAB-PIQ-180')!
  const shadeA = PIQUE_ROLLS.filter(([, , , shade]) => shade === 'A').map(([rollNo]) => rollNo)

  const picked = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: rolls.id, rollNo: rolls.rollNo, qty: rolls.qty, unit: rolls.unit, status: rolls.status })
      .from(rolls)
      .where(scoped(rolls, ctx, and(eq(rolls.itemId, itemId), inArray(rolls.rollNo, [...shadeA])))),
  )

  const free = picked.filter((r) => r.status === 'in_stock')
  if (free.length === 0) {
    console.log('[kit] shade A piqué already issued — skipping ISS-114')
    return
  }

  const issued = await issueStock(ctx, {
    orderId,
    lines: free.map((r) => ({ itemId, rollId: r.id, qty: r.qty, unit: r.unit })),
  })
  const total = free.reduce((sum, r) => sum + Number(r.qty), 0)
  console.log(
    `[kit] ISS-114 · ${free.length} shade-A rolls · ${total.toFixed(2)} kg → PO-BF-2044 · ${issued.warnings.length} warnings`,
  )
}

/**
 * The Phase-3 fixtures (build plan 3.0) — the rows the last two AI doors need to exist
 * before they can be tested against anything.
 *
 * · **A PP approval and an open lay for PO-BF-2044.** The cut-sheet reader refuses a
 *   photograph naming a different lay, so the lay is created as the kit's own LAY-32, on
 *   the rolls the kit assigns it, and left WITHOUT a cut report — an open lay is the state
 *   the report screen exists for. The PP approval goes through the real sampling flow
 *   (request → stages → dispatch → buyer verdict), because a lay behind an unapproved PP
 *   would need the gate written around, and a gate a seed writes around has never run.
 *
 * · **A bank submission under LC-4471, accepted, invoiced at USD 122,400.** Exactly what
 *   the kit's realization advice describes (BF-INV-2044-1, 18,000 pcs at 6.80), so the
 *   advice reader posts against the submission the paper is actually about. Opened without
 *   a shipment — the presentation is the fixture, not the logistics behind it — and walked
 *   preparing → submitted → accepted through the machine, since a realization may only land
 *   on an accepted presentation.
 */
async function phase3Fixtures(ctx: RequestCtx, orderIds: Map<string, string>): Promise<void> {
  const { advanceStage, createSampleRequest, dispatchSample, recordFeedback } = await import(
    '@/modules/sampling/service'
  )
  const { createLay, createMarker } = await import('@/modules/cutting/service')
  const { openSubmission, setSubmissionStatus } = await import('@/modules/commercial/service')
  const { sampleRequests } = await import('@/modules/sampling/schema')
  const { lays, markers } = await import('@/modules/cutting/schema')
  const { docSubmissions } = await import('@/modules/commercial/schema')
  const { orderStyles } = await import('@/modules/orders/schema')
  const { rolls } = await import('@/modules/store/schema')

  const orderId = orderIds.get('PO-BF-2044')
  if (!orderId) return

  // ── the PP verdict that opens cutting ──
  const [existingPp] = await withTenantRead(ctx, (tx) =>
    tx.select({ id: sampleRequests.id }).from(sampleRequests).where(scoped(sampleRequests, ctx, eq(sampleRequests.requestNo, 'SR-2610-PP'))),
  )
  if (!existingPp) {
    const { sampleRequestId } = await createSampleRequest(ctx, {
      orderId,
      type: 'pp',
      styleCode: 'ST-2610',
      requestNo: 'SR-2610-PP',
      dueDate: '2026-09-20',
    })
    for (const [i, stage] of (['pattern', 'cutting', 'sewing', 'finishing', 'qc', 'dispatched'] as const).entries()) {
      await advanceStage(ctx, {
        sampleRequestId,
        stage,
        occurredAt: new Date(Date.UTC(2026, 8, 10 + i, 9, 30)).toISOString(),
      })
    }
    await dispatchSample(ctx, {
      sampleRequestId,
      courier: 'DHL Express',
      awb: '7412 9930 226',
      dispatchedAt: new Date(Date.UTC(2026, 8, 16, 16, 0)).toISOString(),
    })
    // The kit's own document: 22-BSL-PP-approval-ST-2610 — the buyer said yes.
    await recordFeedback(ctx, {
      sampleRequestId,
      verdict: 'approved',
      recordedOn: '2026-09-22',
    })
    console.log('[kit] SR-2610-PP approved — cutting open on PO-BF-2044')
  }

  // ── the marker and the open lay ──
  const [existingLay] = await withTenantRead(ctx, (tx) =>
    tx.select({ id: lays.id }).from(lays).where(scoped(lays, ctx, eq(lays.layNo, 'LAY-32'))),
  )
  if (!existingLay) {
    const [style] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: orderStyles.id }).from(orderStyles).where(scoped(orderStyles, ctx, eq(orderStyles.orderId, orderId))),
    )
    let [marker] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: markers.id }).from(markers).where(scoped(markers, ctx, eq(markers.code, 'ST-2610-A'))),
    )
    if (!marker) {
      const created = await createMarker(ctx, {
        code: 'ST-2610-A',
        styleCode: 'ST-2610',
        // The kit's ratio: S1 M2 L2 XL1 at 86.4% on 180cm cloth.
        sizeRatio: { S: 1, M: 2, L: 2, XL: 1 },
        layLengthMeters: '9.60',
        efficiencyPct: '86.4',
      })
      marker = { id: created.markerId }
    }

    const kitRolls = await withTenantRead(ctx, (tx) =>
      tx.select({ id: rolls.id, rollNo: rolls.rollNo }).from(rolls).where(scoped(rolls, ctx, inArray(rolls.rollNo, ['R-P-04', 'R-P-05']))),
    )
    await createLay(ctx, {
      orderId,
      orderStyleId: style!.id,
      markerId: marker.id,
      layNo: 'LAY-32',
      color: 'White',
      plies: 118,
      layLengthMeters: '9.60',
      rollsDrawn: kitRolls.map((r) => r.id),
    })
    console.log('[kit] LAY-32 spread on White · 118 plies · open, waiting for its cut report')
  }

  // ── the accepted presentation the realization advice pays ──
  const [existingSub] = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: docSubmissions.id })
      .from(docSubmissions)
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.invoicedAmount, '122400.00'))),
  )
  if (!existingSub) {
    const [lc] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: lcs.id }).from(lcs).where(scoped(lcs, ctx, eq(lcs.number, 'LC-4471'))),
    )
    if (lc) {
      const { submissionId } = await openSubmission(ctx, {
        lcId: lc.id,
        docs: [
          { kind: 'commercial_invoice', status: 'ready' },
          { kind: 'packing_list', status: 'ready' },
          { kind: 'bl', status: 'ready' },
        ],
        invoicedAmount: '122400.00',
        currency: 'USD',
      })
      await setSubmissionStatus(ctx, { submissionId, bankStatus: 'submitted', submittedAt: '2026-11-14' })
      await setSubmissionStatus(ctx, { submissionId, bankStatus: 'accepted' })
      console.log('[kit] presentation under LC-4471 · USD 122,400 · accepted, awaiting realization')
    }
  }
}

/** What a person opening the screens next should see. */
async function report(ctx: RequestCtx, udIds: Map<string, string>): Promise<void> {
  console.log('\n[kit] declaration balances')
  for (const ud of KIT_UDS) {
    const id = udIds.get(ud.number)
    if (!id) continue
    const balance = await getUdBalance(ctx, id)
    for (const item of balance.items) {
      const matches = item.free === ud.expectFree ? '✔' : `✘ expected ${ud.expectFree}`
      console.log(
        `  ${ud.number} · ${item.itemRef} · ${Number(item.free).toLocaleString()} ${item.unit} free  ${matches}`,
      )
    }
  }
}

await main()
