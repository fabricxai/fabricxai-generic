/**
 * 3.1 integration — the first floor-facing module.
 *
 * What is proved here that nothing else can:
 *
 *  - **offline replay is a no-op.** A tablet that loses the network mid-shift resends its
 *    whole batch. The second send must return the original result, not a second issue.
 *  - **a bonded issue draws the UD in the same transaction.** Not "and then also"; the
 *    same one, so an issue with no draw behind it cannot exist.
 *  - **the UD gate still refuses through the store path.** A gate that only works when
 *    called directly is not a gate.
 */
import { randomUUID } from 'node:crypto'

import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, users } from '@/db/schema/core'
import { buyers } from '@/modules/buyers/schema'
import { udConsumptions, uds } from '@/modules/commercial/schema'
import { getUdBalance } from '@/modules/commercial/service'
import type { RequestCtx } from '@/modules/core/ctx'
import { AppError } from '@/modules/core/errors'
import { syncBatch } from '@/modules/core/offline-sync'
import {
  registerFabricInspectionProvider,
  resetFabricInspectionProvider,
} from '@/modules/store/gates'
import { withTenantRead, withTenantTx } from '@/modules/core/tenancy'
import { orders } from '@/modules/orders/schema'
import { bomLines, boms } from '@/modules/costing/schema'
import { issueLines, issues, items, locations, requisitionLines, rolls } from '@/modules/store/schema'
import '@/modules/store/register' // registers the sync handlers
import {
  commitStockAdjustment,
  createRequisition,
  getStock,
  issueStock,
  returnRolls,
  receiveGrn,
} from '@/modules/store/service'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `store-${randomUUID().slice(0, 8)}`
const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['store'] }
const otherCtx: RequestCtx = { companyId: OTHER, userId: USER, roles: ['store'] }

let fabricId: string
let bondedLocationId: string
let orderId: string
let udId: string

/**
 * The 4-point gate is answered by 7.1 Quality and FAILS CLOSED with no provider (rule 8),
 * so every issue in this file would be blocked on an inspection none of these tests are
 * about. Registered permissively here for the same reason the cutting suite registers a
 * permissive PP provider — and the gate's own blocking behaviour is asserted below, where
 * it is the subject rather than a side effect.
 */
const allowFabric = () => registerFabricInspectionProvider(async () => ({ passed: true }))

beforeAll(async () => {
  allowFabric()
  await db.insert(companies).values([
    { id: COMPANY, name: 'Store Co', slug: `store-${COMPANY.slice(0, 8)}` },
    { id: OTHER, name: 'Other Co', slug: `other-${OTHER.slice(0, 8)}` },
  ])
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Storekeeper' })

  const [buyer] = await db
    .insert(buyers)
    .values({ companyId: COMPANY, code: 'HM', name: 'H&M' })
    .returning({ id: buyers.id })

  const [order] = await db
    .insert(orders)
    .values({ companyId: COMPANY, buyerId: buyer!.id, poNumbers: ['PO-1'], createdBy: USER })
    .returning({ id: orders.id })
  orderId = order!.id

  const [item] = await db
    .insert(items)
    .values({ companyId: COMPANY, code: 'FAB-COTTON-160', kind: 'fabric', name: 'Cotton 160gsm', uom: 'M' })
    .returning({ id: items.id })
  fabricId = item!.id

  const [location] = await db
    .insert(locations)
    .values({ companyId: COMPANY, code: 'BOND-1', name: 'Bonded store', kind: 'bonded' })
    .returning({ id: locations.id })
  bondedLocationId = location!.id

  const [ud] = await db
    .insert(uds)
    .values({
      companyId: COMPANY,
      number: 'UD/DHK/2026/9001',
      validUntil: '2099-12-31',
      authorizedItems: [{ itemRef: 'FAB-COTTON-160', qty: '500.00', unit: 'M' }],
      createdBy: USER,
    })
    .returning({ id: uds.id })
  udId = ud!.id
})

afterAll(async () => {
  resetFabricInspectionProvider()
  await db.execute(sql`delete from audit_log where company_id in (${COMPANY}, ${OTHER})`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

describe('3.1 · goods in', () => {
  it('receives a bonded GRN with rolls', async () => {
    const result = await receiveGrn(ctx, {
      challanNo: 'CH-0001',
      receivedAt: '2026-06-01',
      bonded: true,
      udId,
      lines: [
        {
          itemId: fabricId,
          qty: '400.00',
          unit: 'M',
          rolls: [
            { rollNo: 'R-001', qty: '200.00', locationId: bondedLocationId, shadeGroup: 'A' },
            { rollNo: 'R-002', qty: '200.00', locationId: bondedLocationId, shadeGroup: 'A' },
          ],
        },
      ],
    })

    expect(result.rolls).toBe(2)

    // Receiving bonded material is not consuming it — the UD is drawn when it LEAVES.
    const draws = await db.select().from(udConsumptions).where(eq(udConsumptions.udId, udId))
    expect(draws).toHaveLength(0)
  })

  it('refuses a bonded receipt with no declaration behind it', async () => {
    await expect(
      receiveGrn(ctx, {
        challanNo: 'CH-BAD',
        receivedAt: '2026-06-01',
        bonded: true,
        lines: [{ itemId: fabricId, qty: '10.00', unit: 'M', rolls: [] }],
      }),
    ).rejects.toMatchObject({ messageKey: 'store.errors.bonded_requires_ud' })
  })

  it('refuses a line recorded in the wrong unit for the item', async () => {
    await expect(
      receiveGrn(ctx, {
        challanNo: 'CH-UNIT',
        receivedAt: '2026-06-01',
        lines: [{ itemId: fabricId, qty: '10.00', unit: 'KG', rolls: [] }],
      }),
    ).rejects.toMatchObject({ messageKey: 'store.errors.unit_mismatch' })
  })
})

describe('3.1 · stock', () => {
  it('computes free as on-hand minus reserved', async () => {
    const before = await getStock(ctx, { itemIds: [fabricId] })
    expect(before.get(fabricId)).toMatchObject({ onHand: '400.00', reserved: '0.00', free: '400.00' })

    await createRequisition(ctx, {
      orderId,
      orderQty: 100,
      wastagePct: '5',
      lines: [{ itemId: fabricId, consumptionPerPiece: '1.50', unit: 'M' }],
    })

    // 1.5 × 100 = 150; +5% = 157.50
    const after = await getStock(ctx, { itemIds: [fabricId] })
    expect(after.get(fabricId)).toMatchObject({ reserved: '157.50', free: '242.50' })
  })

  it('is invisible to another company', async () => {
    const stock = await getStock(otherCtx, { itemIds: [fabricId] })
    expect(stock.size).toBe(0)

    const visible = await withTenantRead(otherCtx, (tx) =>
      tx.select().from(rolls).where(eq(rolls.itemId, fabricId)),
    )
    expect(visible).toHaveLength(0)
  })
})

describe('3.1 · goods out draws the UD in the same transaction', () => {
  it('issues bonded stock and records the customs draw', async () => {
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-001'))

    const result = await issueStock(ctx, {
      orderId,
      lines: [{ itemId: fabricId, rollId: roll!.id, qty: '200.00', unit: 'M', udId }],
    })

    expect(result.udDraws).toHaveLength(1)

    const draws = await db.select().from(udConsumptions).where(eq(udConsumptions.udId, udId))
    expect(draws).toHaveLength(1)
    // The draw points back at the issue that caused it — that link is what a customs
    // reconciliation is built from.
    expect(draws[0]?.storeIssueId).toBe(result.issueId)
    expect(draws[0]?.qty).toBe('200.00')

    const [after] = await db.select().from(rolls).where(eq(rolls.id, roll!.id))
    expect(after?.status).toBe('issued')
  })

  it('the UD gate still refuses through the store path', async () => {
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-002'))

    // 500 authorised, 200 already drawn — asking for 400 is 100 over.
    const thrown = await issueStock(ctx, {
      orderId,
      lines: [{ itemId: fabricId, rollId: roll!.id, qty: '400.00', unit: 'M', udId }],
    }).catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('gate_blocked')
    expect((thrown as AppError).details).toMatchObject({ gate: 'ud_balance', shortfall: '100.00' })

    // And nothing partial survived: no issue, no draw, roll untouched.
    const draws = await db.select().from(udConsumptions).where(eq(udConsumptions.udId, udId))
    expect(draws).toHaveLength(1)

    const [untouched] = await db.select().from(rolls).where(eq(rolls.id, roll!.id))
    expect(untouched?.status).toBe('in_stock')
  })

  it('resolves the declaration through the roll’s GRN when the caller names none', async () => {
    /*
     * The live client never sent `udId` on a line — it did not know it — so the first
     * bonded issue on the live tenant left the warehouse with no draw recorded and the
     * customs gate never consulted. The roll knows its GRN and the GRN names its
     * declaration; the resolution belongs HERE, where no client can skip it.
     */
    await receiveGrn(ctx, {
      challanNo: 'CH-0002',
      receivedAt: '2026-06-02',
      bonded: true,
      udId,
      lines: [
        {
          itemId: fabricId,
          qty: '100.00',
          unit: 'M',
          rolls: [{ rollNo: 'R-003', qty: '100.00', locationId: bondedLocationId, shadeGroup: 'A' }],
        },
      ],
    })
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-003'))

    const result = await issueStock(ctx, {
      orderId,
      // No udId on the line — exactly what the screen sends.
      lines: [{ itemId: fabricId, rollId: roll!.id, qty: '100.00', unit: 'M' }],
    })

    expect(result.udDraws).toHaveLength(1)
    expect(result.udDraws[0]?.udId).toBe(udId)

    const draws = await db.select().from(udConsumptions).where(eq(udConsumptions.udId, udId))
    expect(draws).toHaveLength(2)
  })

  it('brings a roll back and gives the declaration its balance back', async () => {
    /*
     * The gap this closes: `rollMachine` has allowed `issued → returned` since it was
     * written and nothing could make the move. Cloth comes back for ordinary reasons, and
     * for the one that found it — rolls that failed 4-point were issued before the gate
     * could see them, and there was no way to fetch them home.
     *
     * The bonded half is the part that matters. A returned roll whose UD draw still stands
     * leaves the declaration permanently short of material sitting in the bond, and the
     * drift surfaces at a customs reconciliation months later.
     */
    await receiveGrn(ctx, {
      challanNo: `RET-${randomUUID().slice(0, 6)}`,
      receivedAt: '2026-07-02',
      bonded: true,
      udId,
      lines: [
        {
          itemId: fabricId,
          qty: '60.00',
          unit: 'M',
          rolls: [{ rollNo: 'R-RET', qty: '60.00', locationId: bondedLocationId, shadeGroup: 'A' }],
        },
      ],
    })
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-RET'))

    const before = await getUdBalance(ctx, udId)
    await issueStock(ctx, {
      orderId,
      lines: [{ itemId: fabricId, rollId: roll!.id, qty: '60.00', unit: 'M' }],
    })
    const afterIssue = await getUdBalance(ctx, udId)
    expect(afterIssue.items[0]!.free).not.toBe(before.items[0]!.free)

    const result = await returnRolls(ctx, {
      rollIds: [roll!.id],
      reason: 'failed 4-point at the mill — returned for claim',
    })

    expect(result.rolls).toBe(1)
    expect(result.udReversals).toBe(1)

    const [back] = await db.select().from(rolls).where(eq(rolls.id, roll!.id))
    expect(back!.status).toBe('returned')

    // The balance is whole again, and the draw is still on the ledger with its reason —
    // not deleted, not negated. A customs ledger that can be written downwards is not one.
    const afterReturn = await getUdBalance(ctx, udId)
    expect(afterReturn.items[0]!.free).toBe(before.items[0]!.free)

    const [draw] = await db
      .select()
      .from(udConsumptions)
      .where(and(eq(udConsumptions.udId, udId), eq(udConsumptions.qty, '60.00')))
    expect(draw!.reversedAt).not.toBeNull()
    expect(draw!.reversedReason).toContain('failed 4-point')
  })

  it('reverses the draw for the roll returned, not the one that weighs the same', async () => {
    /*
     * The hazard the line link exists for. Two rolls of identical weight go out on one
     * issue; one comes back. Matching draws by quantity would reverse whichever row the
     * database happened to return, and a customs ledger corrected by coincidence is worse
     * than one left alone — the balance would look right while naming the wrong material.
     */
    await receiveGrn(ctx, {
      challanNo: `TWIN-${randomUUID().slice(0, 6)}`,
      receivedAt: '2026-07-03',
      bonded: true,
      udId,
      lines: [
        {
          itemId: fabricId,
          qty: '50.00',
          unit: 'M',
          rolls: [
            { rollNo: 'R-TWIN-A', qty: '25.00', locationId: bondedLocationId, shadeGroup: 'A' },
            { rollNo: 'R-TWIN-B', qty: '25.00', locationId: bondedLocationId, shadeGroup: 'A' },
          ],
        },
      ],
    })
    const twins = await db.select().from(rolls).where(inArray(rolls.rollNo, ['R-TWIN-A', 'R-TWIN-B']))
    const a = twins.find((r) => r.rollNo === 'R-TWIN-A')!
    const b = twins.find((r) => r.rollNo === 'R-TWIN-B')!

    await issueStock(ctx, {
      orderId,
      lines: [
        { itemId: fabricId, rollId: a.id, qty: '25.00', unit: 'M' },
        { itemId: fabricId, rollId: b.id, qty: '25.00', unit: 'M' },
      ],
    })

    const result = await returnRolls(ctx, { rollIds: [a.id], reason: 'wrong shade for the lay' })
    expect(result.udReversals).toBe(1)

    // The returned roll's line is reversed; its twin's draw still stands.
    const [lineA] = await db.select().from(issueLines).where(eq(issueLines.rollId, a.id))
    const [lineB] = await db.select().from(issueLines).where(eq(issueLines.rollId, b.id))
    const [drawA] = await db
      .select()
      .from(udConsumptions)
      .where(eq(udConsumptions.storeIssueLineId, lineA!.id))
    const [drawB] = await db
      .select()
      .from(udConsumptions)
      .where(eq(udConsumptions.storeIssueLineId, lineB!.id))

    expect(drawA!.reversedAt).not.toBeNull()
    expect(drawB!.reversedAt).toBeNull()
  })

  it('refuses a return with no reason, and one for a roll still in stock', async () => {
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-RET'))

    await expect(returnRolls(ctx, { rollIds: [roll!.id], reason: '  ' })).rejects.toMatchObject({
      messageKey: 'store.errors.return_needs_reason',
    })
    // Already returned — the machine says so rather than silently doing nothing twice.
    await expect(
      returnRolls(ctx, { rollIds: [roll!.id], reason: 'again' }),
    ).rejects.toMatchObject({ code: 'illegal_transition' })
  })

  it('refuses to issue a roll that has already gone out', async () => {
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-001'))

    await expect(
      issueStock(ctx, {
        orderId,
        lines: [{ itemId: fabricId, rollId: roll!.id, qty: '10.00', unit: 'M' }],
      }),
    ).rejects.toMatchObject({ code: 'conflict', messageKey: 'store.errors.roll_not_in_stock' })
  })
})

describe('3.1 · the 4-point gate refuses uninspected fabric', () => {
  // Restores the permissive provider afterwards, so a failure here cannot cascade into
  // every issue in the file — which is exactly what happened when the gate first landed.
  afterAll(() => allowFabric())

  it('blocks the issue when quality has not graded the roll', async () => {
    registerFabricInspectionProvider(async (_ctx, _tx, input) => ({
      passed: false,
      reasonKey: 'gates.fabric_inspection.not_inspected',
      facts: { gate: 'fabric_inspection', rolls: input.rollIds.length },
    }))

    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-002'))

    const thrown = await issueStock(ctx, {
      orderId,
      lines: [{ itemId: fabricId, rollId: roll!.id, qty: '10.00', unit: 'M' }],
    }).catch((e: unknown) => e)

    expect(thrown).toBeInstanceOf(AppError)
    expect((thrown as AppError).code).toBe('gate_blocked')
    expect((thrown as AppError).details).toMatchObject({ gate: 'fabric_inspection' })

    // Nothing partial survived — the roll is still on the shelf.
    const [untouched] = await db.select().from(rolls).where(eq(rolls.id, roll!.id))
    expect(untouched?.status).toBe('in_stock')
  })

  it('fails CLOSED when no provider is registered at all', async () => {
    // The whole point of the seam. A quality gate that silently passes when its module is
    // missing is not a disabled feature, it is fabric reaching the cutting table ungraded.
    resetFabricInspectionProvider()

    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-002'))

    await expect(
      issueStock(ctx, {
        orderId,
        lines: [{ itemId: fabricId, rollId: roll!.id, qty: '10.00', unit: 'M' }],
      }),
    ).rejects.toMatchObject({ code: 'gate_blocked' })
  })
})

describe('3.1 · offline replay is a no-op', () => {
  it('a tablet resending its batch does not issue twice', async () => {
    const [roll] = await db.select().from(rolls).where(eq(rolls.rollNo, 'R-002'))
    const offlineKey = `issue-${randomUUID()}`

    const batch = [
      {
        offlineKey,
        moduleId: 'store',
        operation: 'issue_stock',
        payload: {
          orderId,
          lines: [{ itemId: fabricId, rollId: roll!.id, qty: '150.00', unit: 'M', udId }],
        },
      },
    ]

    const first = await syncBatch(ctx, batch)
    expect(first[0]?.status).toBe('applied')
    const issueId = (first[0] as { rowId: string }).rowId

    // The network dropped before the device saw the response; it sends the batch again.
    const replay = await syncBatch(ctx, batch)
    expect(replay[0]?.status).toBe('duplicate')
    expect((replay[0] as { rowId: string }).rowId).toBe(issueId)

    // One issue, one set of lines, one UD draw. Not two.
    const allIssues = await db.select().from(issues).where(eq(issues.offlineKey, offlineKey))
    expect(allIssues).toHaveLength(1)

    const lines = await db.select().from(issueLines).where(eq(issueLines.issueId, issueId))
    expect(lines).toHaveLength(1)

    // Scoped to THIS issue, which is what the test is about: a replayed batch must not draw
    // its own line twice. Counting every draw on the declaration made the assertion hostage
    // to any other test that issues bonded material.
    const draws = await db
      .select()
      .from(udConsumptions)
      .where(eq(udConsumptions.storeIssueId, issueId))
    expect(draws).toHaveLength(1)
  })

  it('a rejected row stays rejected on replay rather than retrying forever', async () => {
    const offlineKey = `bad-${randomUUID()}`
    const batch = [
      {
        offlineKey,
        moduleId: 'store',
        operation: 'issue_stock',
        payload: {
          orderId,
          // 500 authorised, 350 drawn — 400 more is over, and will stay over.
          lines: [{ itemId: fabricId, qty: '400.00', unit: 'M', udId }],
        },
      },
    ]

    expect((await syncBatch(ctx, batch))[0]?.status).toBe('rejected')
    expect((await syncBatch(ctx, batch))[0]?.status).toBe('rejected')
  })
})

describe('3.1 · requisitions size from what the order was PRICED on', () => {
  it('reads consumption from the BOM rather than trusting the caller', async () => {
    // A quote built on 1.4523 m per garment and a requisition built on somebody's memory
    // of "about 1.45" is how an order quietly runs 2.3 metres short per thousand pieces.
    const [bom] = await db
      .insert(boms)
      .values({ companyId: COMPANY, styleCode: 'ST-WIRED', source: 'manual', createdBy: USER })
      .returning({ id: boms.id })

    await db.insert(bomLines).values({
      companyId: COMPANY,
      bomId: bom!.id,
      lineGroup: 'fabric',
      // The store item's own code — that is how a BOM line finds its item.
      itemRef: 'FAB-COTTON-160',
      consumption: '1.4523',
      uom: 'M',
      wastagePct: '5.00',
    })

    const result = await createRequisition(ctx, {
      orderId,
      orderQty: 1000,
      bomId: bom!.id,
    })

    expect(result.source).toBe('bom')

    const lines = await db
      .select()
      .from(requisitionLines)
      .where(eq(requisitionLines.requisitionId, result.requisitionId))

    // 1.4523 × 1000 × 1.05 = 1524.915 → 1524.92, not the 1522.50 a rounded 1.45 gives.
    expect(lines[0]?.requiredQty).toBe('1524.92')
  })

  it('refuses a BOM naming an item the store has never seen', async () => {
    const [bom] = await db
      .insert(boms)
      .values({ companyId: COMPANY, styleCode: 'ST-GHOST', source: 'manual', createdBy: USER })
      .returning({ id: boms.id })

    await db.insert(bomLines).values({
      companyId: COMPANY,
      bomId: bom!.id,
      lineGroup: 'fabric',
      itemRef: 'FAB-DOES-NOT-EXIST',
      consumption: '1.0000',
      uom: 'M',
      wastagePct: '0',
    })

    // Dropping the line would produce a requisition a line stops waiting for.
    await expect(
      createRequisition(ctx, { orderId, orderQty: 100, bomId: bom!.id }),
    ).rejects.toMatchObject({ messageKey: 'store.errors.bom_item_unknown' })
  })

  it('still accepts explicit lines for a style with no cost sheet', async () => {
    const result = await createRequisition(ctx, {
      orderId,
      orderQty: 50,
      wastagePct: '0',
      lines: [{ itemId: fabricId, consumptionPerPiece: '2.00', unit: 'M' }],
    })

    expect(result.source).toBe('explicit')
  })
})

/**
 * An approved adjustment has to MOVE STOCK.
 *
 * `stock_adjustments` was a registered pending target with no commit handler, so approving
 * one fell through to core's generic writer and threw on the first camelCase key. Worse, a
 * handler that only inserted the adjustment row would leave on-hand unchanged — stock here
 * is derived from rolls — and the screen would quietly disagree with the correction a
 * manager had just signed. Both failures are silent from the reviewer's side, which is why
 * they are pinned here.
 */
describe('stock adjustment · approving one changes the count', () => {
  async function aRoll(qty: string): Promise<{ rollId: string; unit: string }> {
    const rollNo = `ADJ-${randomUUID().slice(0, 8)}`
    await receiveGrn(ctx, {
      challanNo: `ADJ-${randomUUID().slice(0, 8)}`,
      receivedAt: '2026-03-10',
      bonded: false,
      lines: [
        {
          itemId: fabricId,
          qty,
          unit: 'M',
          rolls: [{ rollNo, qty, locationId: bondedLocationId }],
        },
      ],
    })
    const [roll] = await withTenantRead(ctx, (tx) =>
      tx.select({ id: rolls.id, unit: rolls.unit }).from(rolls).where(eq(rolls.rollNo, rollNo)),
    )
    return { rollId: roll!.id, unit: roll!.unit }
  }

  it('writes the shortage off the roll, not just into a ledger', async () => {
    const { rollId, unit } = await aRoll('100.00')

    await withTenantTx(ctx, (tx) =>
      commitStockAdjustment(ctx, tx, {
        payload: {
          itemId: fabricId,
          rollId,
          qtyDelta: '-12.50',
          unit,
          reasonCode: 'damaged',
          note: 'water damage on the outer wraps, cut back to sound cloth',
        },
      }),
    )

    const [roll] = await withTenantRead(ctx, (tx) =>
      tx.select({ qty: rolls.qty, status: rolls.status }).from(rolls).where(eq(rolls.id, rollId)),
    )
    expect(roll!.qty).toBe('87.50')
    expect(roll!.status).toBe('in_stock')
  })

  it('a write-off to zero retires the roll rather than storing a zero quantity', async () => {
    const { rollId, unit } = await aRoll('40.00')

    await withTenantTx(ctx, (tx) =>
      commitStockAdjustment(ctx, tx, {
        payload: {
          itemId: fabricId,
          rollId,
          qtyDelta: '-40.00',
          unit,
          reasonCode: 'written_off',
          note: 'roll destroyed by forklift, nothing recoverable from it',
        },
      }),
    )

    const [roll] = await withTenantRead(ctx, (tx) =>
      tx.select({ status: rolls.status }).from(rolls).where(eq(rolls.id, rollId)),
    )
    // `rolls_qty_positive` forbids a zero, and a roll with no cloth on it is not a thing
    // a storekeeper can be shown.
    expect(roll!.status).toBe('adjusted_out')
  })

  it('REFUSES to take more off a roll than is on it', async () => {
    const { rollId, unit } = await aRoll('30.00')

    await expect(
      withTenantTx(ctx, (tx) =>
        commitStockAdjustment(ctx, tx, {
          payload: {
            itemId: fabricId,
            rollId,
            qtyDelta: '-45.00',
            unit,
            reasonCode: 'miscount',
            note: 'recount after the shelf was restacked by the night shift',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(AppError)
  })
})

/**
 * The unit of measure is locked to protect quantities, so it cannot be locked before any
 * exist.
 *
 * A storekeeper adding an item on day one picks the wrong unit — pcs for thread that comes
 * on cones — and notices immediately. The product's answer used to be that the mistake was
 * permanent: the only way out was a second item under a mangled code, which is then the
 * code that gets typed off half the challans forever.
 *
 * The refusal itself is right and stays. What changed is when it starts applying.
 */
describe('3.1 · the unit of measure', () => {
  const CODE = `TRM-THR-${randomUUID().slice(0, 6)}`

  it('is correctable while nothing has been recorded against the item', async () => {
    const { upsertItem } = await import('@/modules/store/service')

    const first = await upsertItem(ctx, { code: CODE, name: 'sewing thread 40/2', kind: 'trim', uom: 'pcs' })
    expect(first.created).toBe(true)

    const corrected = await upsertItem(ctx, { code: CODE, name: 'sewing thread 40/2', kind: 'trim', uom: 'cone' })
    expect(corrected.created).toBe(false)
    expect(corrected.itemId).toBe(first.itemId)

    const [row] = await withTenantRead(ctx, (tx) =>
      tx.select({ uom: items.uom }).from(items).where(eq(items.id, first.itemId)),
    )
    expect(row!.uom).toBe('cone')
  })

  it('is refused once a quantity exists in it, and says how many', async () => {
    const { upsertItem } = await import('@/modules/store/service')

    // `fabricId` already carries rolls and GRN lines from the receipts above — real
    // quantities, in metres, that a silent reinterpretation would falsify.
    const [fabric] = await withTenantRead(ctx, (tx) =>
      tx.select({ code: items.code, uom: items.uom, name: items.name, kind: items.kind }).from(items).where(eq(items.id, fabricId)),
    )

    await expect(
      upsertItem(ctx, {
        code: fabric!.code,
        name: fabric!.name,
        kind: fabric!.kind,
        uom: fabric!.uom === 'yds' ? 'm' : 'yds',
      }),
    ).rejects.toMatchObject({
      code: 'conflict',
      messageKey: 'store.errors.item_uom_locked',
    })

    // The count is the whole explanation. "42 movements already recorded in m" is a reason
    // a storekeeper can act on; "locked" is a wall.
    await upsertItem(ctx, {
      code: fabric!.code,
      name: fabric!.name,
      kind: fabric!.kind,
      uom: fabric!.uom === 'yds' ? 'm' : 'yds',
    }).catch((e: AppError) => {
      expect(Number((e.details as { movements: number }).movements)).toBeGreaterThan(0)
    })
  })
})
