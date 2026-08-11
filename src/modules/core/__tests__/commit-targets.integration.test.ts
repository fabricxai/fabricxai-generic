/**
 * Every registered pending target, driven through approve() (plan 3.3, audit TEST-H4).
 *
 * Twenty-six tables across fifteen modules are whitelisted as draft targets, and almost none
 * of the commit handlers behind them had ever run. That is the failure mode this file
 * exists for: propose validates the payload, the inbox renders the draft, a reviewer reads
 * it and signs — and the commit is a separate piece of code, reached only at the click.
 * `commit-handlers.test.ts` reads the SOURCE and catches the crudest version (a camelCase
 * payload against core's generic write). It cannot tell whether a handler writes a row,
 * writes the right one, or throws on a foreign key nobody wired.
 *
 * So this is the runtime half. One case per registered target, all through the same
 * `proposeApproveCommit` helper, each asserting the shape of the row that came out — not
 * just that something was written. A row written with the wrong revision, the wrong sign or
 * an empty child table is exactly as broken as no row at all, and only the second assertion
 * catches it.
 *
 * **Coverage is asserted, not assumed.** The last case walks the live registry and fails if
 * a target has no case here, so a module that adds one cannot land it untested.
 *
 * The fixture is one factory's worth of prerequisite rows built once: a buyer, an order and
 * its style and grid, a line, a fabric item and a roll, a supplier and a requisition, a UD,
 * an audit, an enquiry, a sample request, a marker, a lay and its cut report, a shipment.
 * Inserted directly rather than through each module's services — the subject here is the
 * commit handler, and routing every prerequisite through its own service would make a
 * failure in any of fifteen modules read as a failure of this one.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, roles as rolesTable, users } from '@/db/schema/core'
import '@/modules/registry'
import { buyers } from '@/modules/buyers/schema'
import { lcs, uds, udConsumptions } from '@/modules/commercial/schema'
import { audits, findings } from '@/modules/compliance/schema'
import { bomLines, boms } from '@/modules/costing/schema'
import { cutReports, lays, markers } from '@/modules/cutting/schema'
import type { RequestCtx } from '@/modules/core/ctx'
import { listModules } from '@/modules/core/registry'
import { invoices, payables } from '@/modules/finance/schema'
import { orderBreakdowns, orderStyles, orders } from '@/modules/orders/schema'
import { allocations, lines, scenarios, smvRecords } from '@/modules/planning/schema'
import {
  purchaseRequisitions,
  supplierPos,
  supplierQuotes,
  suppliers,
} from '@/modules/procurement/schema'
import { defectCodes, measurementSpecs } from '@/modules/quality/schema'
import { rfqs } from '@/modules/rfq/schema'
import { sampleFeedbackRounds, sampleRequests } from '@/modules/sampling/schema'
import { cartons, finishingOutputs, shipments } from '@/modules/shipment/schema'
import { grnLines, grns, items, locations, rolls, stockAdjustments } from '@/modules/store/schema'
import { wageGazettes, wageGrades } from '@/modules/workforce/schema'

import { proposeApproveCommit } from './support/pending'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OWNER = `tgt-owner-${randomUUID().slice(0, 8)}`

/**
 * One actor, holding every role.
 *
 * Deliberate: this file asks whether a target can COMMIT, and who may approve it is
 * `approvals.integration.test.ts`'s question. A per-module approver ctx here would mean a
 * routing change failing twenty-six cases with a message about commit handlers.
 */
const ctx: RequestCtx = {
  companyId: COMPANY,
  userId: OWNER,
  roles: ['owner', 'admin', 'hr', 'commercial', 'merchandiser', 'quality', 'store'],
}

/** Prerequisite ids, filled in `beforeAll` and read by the payload builders. */
const world = {
  buyerId: '',
  orderId: '',
  orderStyleId: '',
  lineId: '',
  itemId: '',
  rollId: '',
  supplierId: '',
  requisitionId: '',
  supplierPoId: '',
  udId: '',
  auditId: '',
  rfqId: '',
  sampleRequestId: '',
  markerId: '',
  cutReportId: '',
  scenarioId: '',
  payableId: '',
  shipmentId: '',
}

const STYLE = 'ST-3300'
const TODAY = '2026-08-06'

interface TargetCase {
  moduleId: string
  targetTable: string
  /** Distinguishes two cases for one target — see finance/payables. */
  label?: string
  zodSchemaKey: string
  operation?: 'insert' | 'update'
  /** Built lazily — `world` is empty until `beforeAll` has run. */
  payload: () => Record<string, unknown>
  targetId?: () => string
  /** What the committed row must actually look like. */
  verify: (rowId: string) => Promise<void>
}

const CASES: TargetCase[] = [
  // ── buyers ────────────────────────────────────────────────────────────────
  {
    moduleId: 'buyers',
    targetTable: 'buyer_terms',
    zodSchemaKey: 'buyer_terms',
    payload: () => ({
      buyerId: world.buyerId,
      validFrom: TODAY,
      payment: 'lc',
      incoterm: 'FOB',
      tolerancePct: '5',
      aqlLevel: '2.5',
    }),
    verify: async (rowId) => {
      const [row] = await db.execute<{ tolerance_pct: string; aql_level: string }>(
        sql`select tolerance_pct, aql_level from buyer_terms where id = ${rowId}`,
      )
      // 8.1 reads the tolerance as the LC shipping band and 7.1 the AQL level, so both are
      // required with no default — a term that arrived as null would silently widen a gate.
      expect(row?.tolerance_pct).toBe('5.00')
      expect(row?.aql_level).toBe('2.5')
    },
  },
  {
    moduleId: 'buyers',
    targetTable: 'buyer_requirements',
    zodSchemaKey: 'buyer_requirements',
    payload: () => ({
      buyerId: world.buyerId,
      requirements: [
        { category: 'packing', text: 'Solid colour cartons only', sourcePage: 12 },
        { category: 'labelling', text: 'Care label in the side seam', sourcePage: 14 },
      ],
    }),
    verify: async (rowId) => {
      // A batch draft commits a whole manual at once — the handler returns one row id and
      // must have written BOTH. A half-approved manual is worse than an unextracted one.
      const rows = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from buyer_requirements where buyer_id = ${world.buyerId}`,
      )
      expect(Number(rows[0]!.n)).toBe(2)
      expect(rowId).toBeTruthy()
    },
  },

  // ── commercial ────────────────────────────────────────────────────────────
  {
    moduleId: 'commercial',
    targetTable: 'uds',
    zodSchemaKey: 'ud_from_scan_v1',
    payload: () => ({
      number: `UD-${randomUUID().slice(0, 8)}`,
      issueDate: TODAY,
      validUntil: '2027-08-06',
      authorizedItems: [{ itemRef: 'FAB-COTTON-160', qty: '5000.00', unit: 'YDS' }],
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(uds).where(eq(uds.id, rowId))
      // `authorizedItems` and `validUntil` are not column names, which is why core's generic
      // write refused this payload — the draft looked fine right up until somebody signed it.
      expect(row?.authorizedItems).toHaveLength(1)
      expect(row?.validUntil).toBe('2027-08-06')
      expect(row?.status).toBe('active')
    },
  },
  {
    moduleId: 'commercial',
    targetTable: 'lcs',
    zodSchemaKey: 'lc_from_swift_v1',
    payload: () => ({
      buyerId: world.buyerId,
      number: `LC-${randomUUID().slice(0, 8)}`,
      value: '244800.00',
      currency: 'USD',
      tolerancePct: '3',
      issueDate: TODAY,
      // 44C then 31D. The order matters: the module refuses a credit whose documents fall
      // due at the bank before its goods may leave, and it refuses it HERE, at approve.
      latestShipmentDate: '2026-11-18',
      expiryDate: '2026-12-05',
      docsRequired: { commercial_invoice: true, bl: true },
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(lcs).where(eq(lcs.id, rowId))
      expect(row?.value).toBe('244800.00')
      expect(row?.expiryDate).toBe('2026-12-05')
      // A credit arrives live, not as a draft status somebody has to promote afterwards.
      expect(row?.status).toBe('active')
      // The checklist a bank presentation is assembled from, kept as a map so 8.1 can look
      // a kind up rather than scan a list.
      expect(row?.docsRequired).toMatchObject({ commercial_invoice: true, bl: true })
    },
  },
  {
    moduleId: 'commercial',
    targetTable: 'ud_consumptions',
    zodSchemaKey: 'ud_override_v1',
    payload: () => ({
      udId: world.udId,
      itemRef: 'FAB-COTTON-160',
      // MORE than UD-BASE authorises (1,000 YDS). Drawing within the balance would commit
      // through the ordinary path and prove nothing about the override — the whole reason
      // this target exists is the deliberate overdraw routed to the owner.
      qty: '1500.00',
      unit: 'YDS',
      reason: 'Customs allowed the excess against the amended declaration',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(udConsumptions).where(eq(udConsumptions.id, rowId))
      expect(row?.qty).toBe('1500.00')
      // The marker that says this was a deliberate overdraw somebody signed for, not an
      // ordinary draw. Without it the bonded balance looks like it was never exceeded.
      expect(row?.overrideOf).toBe(world.udId)
    },
  },

  // ── compliance ────────────────────────────────────────────────────────────
  {
    moduleId: 'compliance',
    targetTable: 'findings',
    zodSchemaKey: 'findings_batch_v1',
    payload: () => ({
      auditId: world.auditId,
      findings: [
        { severity: 'major', text: 'Fire exit blocked on floor 3', evidence: [], sourcePage: 4 },
        { severity: 'minor', text: 'First aid box under-stocked', evidence: [], sourcePage: 7 },
      ],
    }),
    verify: async () => {
      const rows = await db.select().from(findings).where(eq(findings.auditId, world.auditId))
      expect(rows).toHaveLength(2)
      expect(rows.map((r) => r.severity).sort()).toEqual(['major', 'minor'])
      // The click-to-source target. A disputed finding that cannot be traced to a page is a
      // finding an auditor gets to restate however they remember it.
      expect(rows.every((r) => r.sourcePage !== null)).toBe(true)
    },
  },

  // ── costing ───────────────────────────────────────────────────────────────
  {
    moduleId: 'costing',
    targetTable: 'boms',
    zodSchemaKey: 'bom_from_tech_pack_v1',
    payload: () => ({
      styleCode: STYLE,
      lines: [
        { lineGroup: 'fabric', itemRef: 'FAB-COTTON-160', consumption: '1.45', uom: 'M', wastagePct: '5' },
        { lineGroup: 'trims', itemRef: 'TRM-BTN-18L', consumption: '6', uom: 'PCS' },
      ],
    }),
    verify: async (rowId) => {
      const [bom] = await db.select().from(boms).where(eq(boms.id, rowId))
      expect(bom?.styleCode).toBe(STYLE)

      const lineRows = await db.select().from(bomLines).where(eq(bomLines.bomId, rowId))
      expect(lineRows).toHaveLength(2)
      // Extracted consumption is an ESTIMATE off a tech pack. `actual` is what 1.6 reads as
      // a measured fact from a real order, and defaulting to it would be the single most
      // misleading thing this module could do.
      expect(lineRows.every((l) => l.consumptionBasis === 'planned')).toBe(true)
    },
  },

  // ── cutting ───────────────────────────────────────────────────────────────
  {
    moduleId: 'cutting',
    targetTable: 'markers',
    zodSchemaKey: 'marker',
    payload: () => ({
      code: `MK-${randomUUID().slice(0, 6)}`,
      styleCode: STYLE,
      sizeRatio: { S: 1, M: 2, L: 2, XL: 1 },
      layLengthMeters: '6.40',
      efficiencyPct: '82.50',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(markers).where(eq(markers.id, rowId))
      expect(row?.sizeRatio).toEqual({ S: 1, M: 2, L: 2, XL: 1 })
      expect(row?.layLengthMeters).toBe('6.40')
    },
  },
  {
    moduleId: 'cutting',
    targetTable: 'cut_reports',
    zodSchemaKey: 'cut_report_correction',
    payload: () => ({
      cutReportId: world.cutReportId,
      cells: { 'Navy|M': 180, 'Navy|L': 190 },
      reason: 'Recount after the bundle tickets were reconciled',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(cutReports).where(eq(cutReports.id, rowId))
      expect(row?.cells).toEqual({ 'Navy|M': 180, 'Navy|L': 190 })
      // The correction lands on the SAME report rather than filing a second one — two cut
      // reports for one lay double-count the cut quantity everything downstream reads.
      expect(rowId).toBe(world.cutReportId)
    },
  },

  // ── finance ───────────────────────────────────────────────────────────────
  {
    moduleId: 'finance',
    targetTable: 'invoices',
    zodSchemaKey: 'invoice',
    payload: () => ({
      orderId: world.orderId,
      number: `INV-${randomUUID().slice(0, 6)}`,
      invoiceDate: TODAY,
      value: '48250.00',
      currency: 'USD',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(invoices).where(eq(invoices.id, rowId))
      expect(row?.value).toBe('48250.00')
      // Every amount carries its currency (rule 4). A buyer-facing invoice booked without
      // one is an addition that goes wrong somewhere downstream.
      expect(row?.currency).toBe('USD')
    },
  },
  {
    moduleId: 'finance',
    targetTable: 'payables',
    zodSchemaKey: 'payable',
    payload: () => ({
      supplierPoId: world.supplierPoId,
      reference: 'Mill invoice 8841',
      amount: '12000.00',
      currency: 'USD',
      dueAt: '2026-09-30',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(payables).where(eq(payables.id, rowId))
      expect(row?.status).toBe('open')
      expect(row?.paidAmount).toBeNull()
      // Attributable to something. A payable referencing neither a PO nor a GRN cannot
      // reach an order, which is the reason it is recorded at all.
      expect(row?.supplierPoId).toBe(world.supplierPoId)
    },
  },

  {
    moduleId: 'finance',
    targetTable: 'payables',
    label: 'recording a payment',
    /*
     * The same target, a different schema, chosen by OPERATION.
     *
     * `commitPayable` branches: an insert opens a payable against a PO, an update records
     * money actually paid against one. Two commit paths behind one registered target, and
     * the second is the one that moves cash — a suite that only ever proposes inserts would
     * leave it as unrun as if it had no handler at all.
     */
    zodSchemaKey: 'pay_payable',
    operation: 'update',
    targetId: () => world.payableId,
    payload: () => ({
      payableId: world.payableId,
      paidAmount: '8000.00',
      paidAt: '2026-09-05',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(payables).where(eq(payables.id, rowId))
      expect(row?.paidAmount).toBe('8000.00')
      // Partly paid, not closed. A payable marked settled on a part payment is a supplier
      // who is still owed 4,000 and an ageing report that says nobody is.
      expect(row?.status).toBe('part_paid')
    },
  },

  // ── orders ────────────────────────────────────────────────────────────────
  {
    moduleId: 'orders',
    targetTable: 'orders',
    zodSchemaKey: 'order_from_po_v1',
    payload: () => ({
      buyerId: world.buyerId,
      poNumbers: [`PO-${randomUUID().slice(0, 6)}`],
      totalValue: '90000.00',
      currency: 'USD',
      plannedExFactoryDate: '2026-11-20',
      styles: [{ styleCode: 'ST-4400', contractedQty: 20000, unitPrice: '4.50', currency: 'USD' }],
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(orders).where(eq(orders.id, rowId))
      expect(row?.poNumbers).toHaveLength(1)

      // An order with no style is an order nothing can be cut, costed or planned against.
      const styles = await db.select().from(orderStyles).where(eq(orderStyles.orderId, rowId))
      expect(styles).toHaveLength(1)
      expect(styles[0]?.contractedQty).toBe(20000)
    },
  },
  {
    moduleId: 'orders',
    targetTable: 'order_breakdowns',
    zodSchemaKey: 'order_revision_v1',
    payload: () => ({
      orderStyleId: world.orderStyleId,
      cells: [
        { color: 'Navy', size: 'M', qty: 900 },
        { color: 'Navy', size: 'L', qty: 1100 },
      ],
      reason: 'Buyer amended the size split',
    }),
    verify: async () => {
      const [style] = await db
        .select()
        .from(orderStyles)
        .where(eq(orderStyles.id, world.orderStyleId))

      // A buyer amendment REPLACES the grid and bumps the revision pointer; it does not add
      // cells beside the old ones. Cutting reads `activeRevision` to know what to cut to.
      expect(style?.activeRevision).toBe(2)

      const live = await db
        .select()
        .from(orderBreakdowns)
        .where(eq(orderBreakdowns.revision, 2))
      expect(live.map((c) => c.qty).sort((a, b) => a - b)).toEqual([900, 1100])
    },
  },

  // ── planning ──────────────────────────────────────────────────────────────
  {
    moduleId: 'planning',
    targetTable: 'allocations',
    /*
     * `scenario_apply`, not `allocation` — and finding that out is half of what this case
     * is worth. The zod map offers both, the target is named `allocations`, and the handler
     * parses the SCENARIO payload: an approved plan is a whole board being applied at once,
     * re-checked against the lines as they are at approve time rather than as they were
     * when the planner forked. A draft carrying a single allocation validates against the
     * wrong schema and dies at the click, and nothing but running it says so.
     */
    zodSchemaKey: 'scenario_apply',
    payload: () => ({
      scenarioId: world.scenarioId,
      assumptions: { expectedEfficiencyPct: '60', defaultShiftMinutes: 480 },
      allocations: [
        {
          orderId: world.orderId,
          orderStyleId: world.orderStyleId,
          lineId: world.lineId,
          startDate: '2026-09-01',
          endDate: '2026-09-03',
          plannedDaily: { '2026-09-01': 600, '2026-09-02': 700, '2026-09-03': 700 },
        },
      ],
    }),
    verify: async () => {
      const [row] = await db
        .select()
        .from(allocations)
        .where(eq(allocations.lineId, world.lineId))

      expect(row?.plannedDaily).toEqual({
        '2026-09-01': 600,
        '2026-09-02': 700,
        '2026-09-03': 700,
      })

      // The scenario closes with the board. A scenario left `draft` after its allocations
      // landed could be applied a second time and double-book the line.
      const [scenario] = await db
        .select()
        .from(scenarios)
        .where(eq(scenarios.id, world.scenarioId))
      expect(scenario?.status).toBe('applied')
    },
  },
  {
    moduleId: 'planning',
    targetTable: 'smv_records',
    zodSchemaKey: 'smv_record',
    payload: () => ({ styleCode: STYLE, smv: '14.25', source: 'ie_study', measuredAt: TODAY }),
    verify: async (rowId) => {
      const [row] = await db.select().from(smvRecords).where(eq(smvRecords.id, rowId))
      expect(row?.smv).toBe('14.25')
      // An IE study and a guess are both numbers; only one of them should set a line's
      // capacity, so the provenance is stored rather than flattened to a default.
      expect(row?.source).toBe('ie_study')
    },
  },

  // ── procurement ───────────────────────────────────────────────────────────
  {
    moduleId: 'procurement',
    targetTable: 'suppliers',
    zodSchemaKey: 'supplier',
    payload: () => ({
      code: `SUP-${randomUUID().slice(0, 6)}`,
      name: 'Padma Textile Mills',
      type: 'fabric_mill',
      origin: 'local',
      defaultCurrency: 'BDT',
      contacts: [{ name: 'Mizan', role: 'sales', email: 'mizan@padma.test' }],
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(suppliers).where(eq(suppliers.id, rowId))
      expect(row?.type).toBe('fabric_mill')
      // Local versus import decides whether a purchase needs BTB headroom and a UD.
      expect(row?.origin).toBe('local')
      expect(row?.contacts).toHaveLength(1)
    },
  },
  {
    moduleId: 'procurement',
    targetTable: 'purchase_requisitions',
    zodSchemaKey: 'purchase_requisition',
    payload: () => ({
      orderId: world.orderId,
      prNo: `PR-${randomUUID().slice(0, 6)}`,
      neededBy: '2026-09-15',
      lines: [{ itemId: world.itemId, qty: '4000.00', unit: 'M' }],
    }),
    verify: async (rowId) => {
      const [row] = await db
        .select()
        .from(purchaseRequisitions)
        .where(eq(purchaseRequisitions.id, rowId))
      expect(row?.status).toBe('open')

      // A requisition with no lines buys nothing — the header committing alone is the
      // failure the zod `.min(1)` guards at propose and the handler must honour at commit.
      const lineRows = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from purchase_requisition_lines where purchase_requisition_id = ${rowId}`,
      )
      expect(Number(lineRows[0]!.n)).toBe(1)
    },
  },
  {
    moduleId: 'procurement',
    targetTable: 'supplier_quotes',
    zodSchemaKey: 'supplier_quote',
    payload: () => ({
      purchaseRequisitionId: world.requisitionId,
      supplierId: world.supplierId,
      currency: 'USD',
      quotedOn: TODAY,
      lines: [{ itemId: world.itemId, unitPrice: '2.1500', leadTimeDays: 21, moq: '1000' }],
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(supplierQuotes).where(eq(supplierQuotes.id, rowId))
      expect(row?.currency).toBe('USD')

      const lineRows = await db.execute<{ unit_price: string; lead_time_days: number }>(
        sql`select unit_price, lead_time_days from supplier_quote_lines where supplier_quote_id = ${rowId}`,
      )
      expect(lineRows).toHaveLength(1)
      // Four decimals on a unit price, deliberately: a fabric rate rounded to two puts a
      // real error into a 200,000-metre order.
      expect(lineRows[0]?.unit_price).toBe('2.1500')
      expect(lineRows[0]?.lead_time_days).toBe(21)
    },
  },

  // ── quality ───────────────────────────────────────────────────────────────
  {
    moduleId: 'quality',
    targetTable: 'defect_codes',
    zodSchemaKey: 'defect_code',
    payload: () => ({
      category: 'sewing',
      code: `SKIP-${randomUUID().slice(0, 4)}`,
      label: 'Skipped stitch',
      severity: 'major',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(defectCodes).where(eq(defectCodes.id, rowId))
      // Severity is what an AQL verdict is computed against — a misclassification changes
      // whether a lot passes, so it is stored as given and never inferred.
      expect(row?.severity).toBe('major')
      expect(row?.isActive).toBe(true)
    },
  },
  {
    moduleId: 'quality',
    targetTable: 'measurement_specs',
    zodSchemaKey: 'measurement_spec',
    payload: () => ({
      styleCode: STYLE,
      unit: 'cm',
      points: [
        { name: 'Chest', spec: '52.00', tolPlus: '1.00', tolMinus: '1.00' },
        { name: 'Length', spec: '71.00', tolPlus: '1.50', tolMinus: '0.50' },
      ],
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(measurementSpecs).where(eq(measurementSpecs.id, rowId))
      expect(row?.points).toHaveLength(2)
      expect(row?.version).toBe(1)
      // Asymmetric tolerances survive the round trip. Collapsing them to one number is how
      // a garment 1.5 cm long passes and one 1.5 cm short does too.
      expect(row?.points?.[1]).toMatchObject({ tolPlus: '1.50', tolMinus: '0.50' })
    },
  },

  // ── rfq ───────────────────────────────────────────────────────────────────
  {
    moduleId: 'rfq',
    targetTable: 'rfqs',
    zodSchemaKey: 'rfq',
    payload: () => ({
      buyerId: world.buyerId,
      title: 'Autumn basics enquiry',
      productType: 'tshirt',
      quantity: 25000,
      sizeRatio: { S: 1, M: 2, L: 2, XL: 1 },
      currency: 'USD',
      source: 'ai_extracted',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(rfqs).where(eq(rfqs.id, rowId))
      expect(row?.status).toBe('open')
      expect(row?.sizeRatio).toEqual({ S: 1, M: 2, L: 2, XL: 1 })

      // The handler exists so the enquiry EVENT is emitted; a generic row write would have
      // left nothing downstream knowing the enquiry arrived.
      const events = await db.execute<{ n: string }>(
        sql`select count(*)::text as n from outbox
            where company_id = ${COMPANY} and event_name like 'rfq.%' and aggregate_id = ${rowId}`,
      )
      expect(Number(events[0]!.n)).toBeGreaterThan(0)
    },
  },

  // ── sampling ──────────────────────────────────────────────────────────────
  {
    moduleId: 'sampling',
    targetTable: 'sample_requests',
    zodSchemaKey: 'sample_request',
    payload: () => ({
      orderId: world.orderId,
      type: 'pp',
      styleCode: STYLE,
      requestNo: `SR-${randomUUID().slice(0, 6)}`,
      dueDate: '2026-09-10',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(sampleRequests).where(eq(sampleRequests.id, rowId))
      expect(row?.status).toBe('requested')
      // A PP sample belongs to an order and never to an enquiry — the PP gate that blocks
      // cutting looks the sample up BY order, so a row in both flows is read by neither.
      expect(row?.orderId).toBe(world.orderId)
      expect(row?.rfqId).toBeNull()
    },
  },
  {
    moduleId: 'sampling',
    targetTable: 'sample_feedback_rounds',
    zodSchemaKey: 'feedback_round',
    payload: () => ({
      sampleRequestId: world.sampleRequestId,
      verdict: 'approved',
      comments: [],
      recordedOn: TODAY,
    }),
    verify: async (rowId) => {
      const [row] = await db
        .select()
        .from(sampleFeedbackRounds)
        .where(eq(sampleFeedbackRounds.id, rowId))
      // The verdict that opens the PP gate. There is no default on it precisely because a
      // verdict arriving by omission could clear a gate by omission.
      expect(row?.verdict).toBe('approved')
      expect(row?.round).toBe(1)
    },
  },

  // ── shipment ──────────────────────────────────────────────────────────────
  {
    moduleId: 'shipment',
    targetTable: 'cartons',
    zodSchemaKey: 'carton',
    payload: () => ({
      orderId: world.orderId,
      cartonNo: `CTN-${randomUUID().slice(0, 6)}`,
      contents: { 'Navy|M': 12, 'Navy|L': 12 },
      grossKg: '18.40',
      netKg: '16.90',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(cartons).where(eq(cartons.id, rowId))
      // Derived, not taken from the payload: a carton whose stated total disagrees with its
      // contents is a packing list that reconciles on paper and not in the container.
      expect(row?.totalQty).toBe(24)
      expect(row?.contents).toEqual({ 'Navy|M': 12, 'Navy|L': 12 })
    },
  },
  {
    moduleId: 'shipment',
    targetTable: 'shipments',
    zodSchemaKey: 'tolerance_override',
    operation: 'update',
    targetId: () => world.shipmentId,
    payload: () => ({
      shipmentId: world.shipmentId,
      lcQty: 20000,
      shippedQty: 21000,
      tolerancePct: '3',
      direction: 'over',
      varianceQty: 1000,
      reason: 'Buyer accepted the 5% overship in writing',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(shipments).where(eq(shipments.id, rowId))
      // Recorded ON the shipment, not as a separate note somebody has to find. The bank
      // will compare the invoice quantity to the credit; the acceptance has to travel with
      // the shipment it excuses.
      expect(row?.toleranceOverride).toMatchObject({ direction: 'over', varianceQty: 1000 })
      expect(rowId).toBe(world.shipmentId)
    },
  },

  // ── store ─────────────────────────────────────────────────────────────────
  {
    moduleId: 'store',
    targetTable: 'stock_adjustments',
    zodSchemaKey: 'stock_adjustment_v1',
    payload: () => ({
      itemId: world.itemId,
      rollId: world.rollId,
      qtyDelta: '-40.00',
      unit: 'M',
      reasonCode: 'damage',
      note: 'Water damage on the top layers of the roll',
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(stockAdjustments).where(eq(stockAdjustments.id, rowId))
      expect(row?.qtyDelta).toBe('-40.00')

      // The part that makes on-hand actually change. Stock here is derived from ROLLS, not
      // from an adjustments ledger, so a write-off that files a row and leaves the roll at
      // its old quantity changes nothing anybody can see.
      const [roll] = await db.select().from(rolls).where(eq(rolls.id, world.rollId))
      expect(roll?.qty).toBe('460.00')
    },
  },

  // ── workforce ─────────────────────────────────────────────────────────────
  {
    moduleId: 'workforce',
    targetTable: 'wage_gazettes',
    zodSchemaKey: 'gazette_from_scan_v1',
    payload: () => ({
      version: `SRO-${randomUUID().slice(0, 6)}`,
      effectiveFrom: '2026-12-01',
      grades: [
        { grade: 'G7', basic: '5600.00', houseRent: '2800.00', medical: '750.00' },
        { grade: 'G6', basic: '5900.00', houseRent: '2950.00', medical: '750.00' },
      ],
    }),
    verify: async (rowId) => {
      const [row] = await db.select().from(wageGazettes).where(eq(wageGazettes.id, rowId))
      // Draft, never active. A scanned notification committing straight into force would
      // reprice every payroll run the moment a reviewer clicked approve.
      expect(row?.status).toBe('draft')

      const grades = await db.select().from(wageGrades).where(eq(wageGrades.gazetteId, rowId))
      // A gazette is a header AND its table: the header alone activates cleanly and pays
      // nothing, which is the failure core's generic single-row write would have produced.
      expect(grades).toHaveLength(2)
      expect(grades.find((g) => g.grade === 'G6')?.basic).toBe('5900.00')
    },
  },
]

beforeAll(async () => {
  await db.insert(companies).values({
    id: COMPANY,
    name: 'Target Co',
    slug: `tgt-${COMPANY.slice(0, 8)}`,
  })
  await db.insert(users).values({ id: OWNER, email: `${OWNER}@fabricxai.test`, name: 'Owner' })
  // Without a role row this user is invisible to any join on `users` under a tenant scope
  // (migration 0073) — see the note in approvals.integration.test.ts.
  await db.insert(rolesTable).values({ companyId: COMPANY, userId: OWNER, role: 'owner' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'BUY-1', name: 'Northwind Apparel' })
    .returning({ id: buyers.id })
  world.buyerId = buyer!.id

  const [order] = await db
    .insert(orders)
    .values({
      companyId: COMPANY,
      buyerId: world.buyerId,
      poNumbers: ['PO-BASE-1'],
      currency: 'USD',
      plannedExFactoryDate: '2026-11-01',
      createdBy: OWNER,
    })
    .returning({ id: orders.id })
  world.orderId = order!.id

  const [style] = await db
    .insert(orderStyles)
    .values({
      companyId: COMPANY,
      orderId: world.orderId,
      styleCode: STYLE,
      // Matches the grid below. The breakdown commit re-checks the revised total against
      // the contracted quantity, so a fixture whose grid says 2,000 against a contract of
      // 20,000 is refused — correctly, and it took a run to notice.
      contractedQty: 2000,
      unitPrice: '4.50',
    })
    .returning({ id: orderStyles.id })
  world.orderStyleId = style!.id

  // Revision 1 of the grid. The order_breakdowns case amends it, which is what bumps the
  // style's `activeRevision` to 2.
  await db.insert(orderBreakdowns).values([
    { companyId: COMPANY, orderStyleId: world.orderStyleId, revision: 1, color: 'Navy', size: 'M', qty: 800 },
    { companyId: COMPANY, orderStyleId: world.orderStyleId, revision: 1, color: 'Navy', size: 'L', qty: 1200 },
  ])

  const [line] = await db
    .insert(lines)
    .values({ companyId: COMPANY, code: 'L1', name: 'Line 1', capacityManpower: 40 })
    .returning({ id: lines.id })
  world.lineId = line!.id

  const [item] = await db
    .insert(items)
    .values({
      companyId: COMPANY,
      code: 'FAB-COTTON-160',
      kind: 'fabric',
      name: 'Cotton single jersey 160gsm',
      uom: 'M',
    })
    .returning({ id: items.id })
  world.itemId = item!.id

  // A roll is not free-standing: it exists because a GRN line received it into a location,
  // and both columns are NOT NULL. Stock in this system is the sum of rolls, so a roll with
  // no receipt behind it is on-hand nobody can trace to a delivery.
  const [location] = await db
    .insert(locations)
    .values({ companyId: COMPANY, code: 'WH-1', name: 'Main store', kind: 'general' })
    .returning({ id: locations.id })

  const [grn] = await db
    .insert(grns)
    .values({ companyId: COMPANY, challanNo: 'CH-BASE', receivedAt: '2026-07-20' })
    .returning({ id: grns.id })

  const [grnLine] = await db
    .insert(grnLines)
    .values({
      companyId: COMPANY,
      grnId: grn!.id,
      itemId: world.itemId,
      qty: '500.00',
      unit: 'M',
    })
    .returning({ id: grnLines.id })

  const [roll] = await db
    .insert(rolls)
    .values({
      companyId: COMPANY,
      grnLineId: grnLine!.id,
      itemId: world.itemId,
      locationId: location!.id,
      rollNo: 'R-0001',
      qty: '500.00',
      unit: 'M',
    })
    .returning({ id: rolls.id })
  world.rollId = roll!.id

  const [supplier] = await db
    .insert(suppliers)
    .values({
      companyId: COMPANY,
      code: 'SUP-BASE',
      name: 'Base Mill',
      type: 'fabric_mill',
      origin: 'local',
    })
    .returning({ id: suppliers.id })
  world.supplierId = supplier!.id

  const [pr] = await db
    .insert(purchaseRequisitions)
    .values({
      companyId: COMPANY,
      orderId: world.orderId,
      prNo: 'PR-BASE',
      neededBy: '2026-09-01',
    })
    .returning({ id: purchaseRequisitions.id })
  world.requisitionId = pr!.id

  const [po] = await db
    .insert(supplierPos)
    .values({
      companyId: COMPANY,
      supplierId: world.supplierId,
      poNumber: 'SPO-BASE',
      currency: 'USD',
      totalValue: '12000.00',
    })
    .returning({ id: supplierPos.id })
  world.supplierPoId = po!.id

  const [ud] = await db
    .insert(uds)
    .values({
      companyId: COMPANY,
      number: 'UD-BASE',
      authorizedItems: [{ itemRef: 'FAB-COTTON-160', qty: '1000.00', unit: 'YDS' }],
    })
    .returning({ id: uds.id })
  world.udId = ud!.id

  const [audit] = await db
    .insert(audits)
    .values({ companyId: COMPANY, regime: 'rsc', auditor: 'RSC', auditedOn: '2026-07-01' })
    .returning({ id: audits.id })
  world.auditId = audit!.id

  const [rfq] = await db
    .insert(rfqs)
    .values({
      companyId: COMPANY,
      buyerId: world.buyerId,
      title: 'Base enquiry',
      productType: 'tshirt',
      quantity: 10000,
    })
    .returning({ id: rfqs.id })
  world.rfqId = rfq!.id

  const [sample] = await db
    .insert(sampleRequests)
    .values({
      companyId: COMPANY,
      orderId: world.orderId,
      type: 'pp',
      styleCode: STYLE,
      requestNo: 'SR-BASE',
    })
    .returning({ id: sampleRequests.id })
  world.sampleRequestId = sample!.id

  const [marker] = await db
    .insert(markers)
    .values({
      companyId: COMPANY,
      code: 'MK-BASE',
      styleCode: STYLE,
      sizeRatio: { M: 1, L: 1 },
      layLengthMeters: '6.00',
    })
    .returning({ id: markers.id })
  world.markerId = marker!.id

  const [lay] = await db
    .insert(lays)
    .values({
      companyId: COMPANY,
      orderId: world.orderId,
      orderStyleId: world.orderStyleId,
      markerId: world.markerId,
      layNo: 'LAY-BASE',
      color: 'Navy',
      plies: 100,
      layLengthMeters: '6.00',
    })
    .returning({ id: lays.id })

  const [report] = await db
    .insert(cutReports)
    .values({
      companyId: COMPANY,
      layId: lay!.id,
      cells: { 'Navy|M': 100, 'Navy|L': 100 },
      breakdownRevision: 1,
      tolerancePct: '2.00',
    })
    .returning({ id: cutReports.id })
  world.cutReportId = report!.id

  // Planning refuses to schedule a style with no SMV rather than assuming one — "about
  // twelve minutes" is a ship date. The allocation case needs one to exist before it runs,
  // and depending on the smv_records case above it would make these two cases ordered.
  await db.insert(smvRecords).values({
    companyId: COMPANY,
    styleCode: STYLE,
    smv: '12.50',
    source: 'ie_study',
  })

  const [payable] = await db
    .insert(payables)
    .values({
      companyId: COMPANY,
      supplierPoId: world.supplierPoId,
      reference: 'Mill invoice 8800',
      amount: '12000.00',
      currency: 'USD',
      dueAt: '2026-09-30',
    })
    .returning({ id: payables.id })
  world.payableId = payable!.id

  const [scenario] = await db
    .insert(scenarios)
    .values({ companyId: COMPANY, name: 'September board', createdBy: OWNER })
    .returning({ id: scenarios.id })
  world.scenarioId = scenario!.id

  // A carton may only hold what finishing actually produced — packing more means a carton
  // holds garments that do not exist. Without this the carton case is refused, which is the
  // guard working; the case is here to prove the handler still writes when it should.
  await db.insert(finishingOutputs).values({
    companyId: COMPANY,
    orderId: world.orderId,
    orderStyleId: world.orderStyleId,
    outputDate: '2026-08-01',
    cells: { 'Navy|M': 800, 'Navy|L': 1200 },
    totalQty: 2000,
  })

  const [shipment] = await db
    .insert(shipments)
    .values({
      companyId: COMPANY,
      orderId: world.orderId,
      partialNo: 1,
      plannedExFactory: '2026-11-15',
    })
    .returning({ id: shipments.id })
  world.shipmentId = shipment!.id
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id = ${COMPANY}`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(users).where(eq(users.id, OWNER))
  await client.end()
})

describe('every registered pending target commits', () => {
  it.each(
    CASES.map(
      (c) => [`${c.moduleId}/${c.targetTable}${c.label ? ` · ${c.label}` : ''}`, c] as const,
    ),
  )(
    '%s',
    async (_name, target) => {
      const { rowId } = await proposeApproveCommit(ctx, {
        moduleId: target.moduleId,
        targetTable: target.targetTable,
        zodSchemaKey: target.zodSchemaKey,
        operation: target.operation ?? 'insert',
        targetId: target.targetId?.(),
        payload: target.payload(),
      })

      await target.verify(rowId)
    },
  )
})

describe('the coverage itself', () => {
  it('has a case for every target the registry whitelists', () => {
    /*
     * The ratchet. A module adding a pending target gets a review queue that can be filled
     * and — until somebody writes the case — a commit nobody has ever run. This fails on the
     * day the target is added rather than on the day a reviewer clicks approve.
     */
    const registered = listModules().flatMap((m) =>
      m.pendingTargets.map((t) => `${m.id}/${t}`),
    )
    const covered = new Set(CASES.map((c) => `${c.moduleId}/${c.targetTable}`))
    const untested = registered.filter((name) => !covered.has(name))

    expect(untested, `no commit case for: ${untested.join(', ')}`).toEqual([])
  })

  it('does not carry a case for a target that is no longer registered', () => {
    // The other direction: a case for a target somebody removed passes forever while
    // testing nothing, and reads as coverage.
    const registered = new Set(
      listModules().flatMap((m) => m.pendingTargets.map((t) => `${m.id}/${t}`)),
    )
    const orphans = CASES.map((c) => `${c.moduleId}/${c.targetTable}`).filter(
      (name) => !registered.has(name),
    )

    expect(orphans).toEqual([])
  })
})
