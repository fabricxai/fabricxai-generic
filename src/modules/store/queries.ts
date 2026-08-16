/**
 * Read models for the store floor.
 *
 * `free` is the only number a storekeeper can act on — on-hand includes stock
 * already promised to another order, and issuing against it is how two cutting
 * tables get sent the same roll. Over-reservation is surfaced loudly rather
 * than clamped to zero: promising more than exists is a real state, and hiding
 * it means the shortage is discovered at the cutting table instead of here.
 */
import { asc, desc, eq, inArray } from 'drizzle-orm'
import { z } from 'zod'

import { uds } from '@/modules/commercial/schema'
import type { AnyCtx } from '@/modules/core/ctx'
import { readJsonbObject } from '@/modules/core/jsonb'
import { scoped } from '@/modules/core/scoped'
import { withTenantRead } from '@/modules/core/tenancy'

/**
 * `items.spec` is free-form per item kind — construction and width for a woven,
 * gsm and knit type for a jersey. Values only, no nesting: a spec is something
 * a storekeeper reads off a label, and anything deeper belongs in the tech pack.
 */
const itemSpec = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

import { orders } from '@/modules/orders/schema'

import {
  grnLines,
  grns,
  issueLines,
  issues,
  items,
  locations,
  requisitionLines,
  requisitions,
  rolls,
} from './schema'
import { getStock } from './service'
import type { ItemStock } from './stock'

export interface StockRow extends ItemStock {
  code: string
  name: string
  kind: string
  /** Rendered "40s poplin · 133x72" — null when the stored spec would not parse. */
  spec: string | null
  /** Rolls in stock, and how many carry a dye lot that must not be mixed. */
  rollCount: number
  shadeGroups: string[]
}

function describeSpec(raw: unknown): string | null {
  const spec = readJsonbObject(itemSpec, raw, 'store_items.spec')
  if (!spec) return null

  const parts = Object.values(spec).map(String).filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

export async function stockOnHand(ctx: AnyCtx): Promise<StockRow[]> {
  const stock = await getStock(ctx)
  if (stock.size === 0) return []

  const itemIds = [...stock.keys()]

  return withTenantRead(ctx, async (tx) => {
    const [itemRows, rollRows] = await Promise.all([
      tx
        .select({
          id: items.id,
          code: items.code,
          name: items.name,
          kind: items.kind,
          spec: items.spec,
        })
        .from(items)
        .where(scoped(items, ctx, inArray(items.id, itemIds))),
      tx
        .select({ itemId: rolls.itemId, shadeGroup: rolls.shadeGroup, status: rolls.status })
        .from(rolls)
        .where(scoped(rolls, ctx, inArray(rolls.itemId, itemIds))),
    ])

    return itemRows
      .map((item): StockRow => {
        const s = stock.get(item.id)!
        // Only rolls actually in the store — issued stock is on the floor.
        const mine = rollRows.filter(
          (r) => r.itemId === item.id && (r.status === 'in_stock' || r.status === 'returned'),
        )
        return {
          ...s,
          code: item.code,
          name: item.name,
          kind: item.kind,
          spec: describeSpec(item.spec),
          rollCount: mine.length,
          shadeGroups: [...new Set(mine.map((r) => r.shadeGroup).filter((g): g is string => !!g))],
        }
      })
      .sort((a, b) => a.code.localeCompare(b.code))
  })
}

export interface GrnRow {
  id: string
  challanNo: string
  receivedAt: string
  bonded: boolean
  udId: string | null
  inspectionStatus: string
  offlineKey: string | null
  lineCount: number
}

/** Recent receipts, newest first — what came through the gate today. */
export async function recentGrns(ctx: AnyCtx, limit = 25): Promise<GrnRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        id: grns.id,
        challanNo: grns.challanNo,
        receivedAt: grns.receivedAt,
        bonded: grns.bonded,
        udId: grns.udId,
        inspectionStatus: grns.inspectionStatus,
        offlineKey: grns.offlineKey,
      })
      .from(grns)
      .orderBy(desc(grns.receivedAt))
      .limit(limit)

    if (rows.length === 0) return []

    // Counted from `grn_lines`, whose `grn_id` is what a GRN id actually matches.
    // `rolls.grn_line_id` points at a LINE, so comparing it to a GRN id silently
    // matched nothing and every receipt reported zero lines.
    const lines = await tx
      .select({ grnId: grnLines.grnId })
      .from(grnLines)
      .where(scoped(grnLines, ctx, 
        inArray(
          grnLines.grnId,
          rows.map((r) => r.id),
        ),
      ))

    return rows.map((r) => ({
      ...r,
      lineCount: lines.filter((l) => l.grnId === r.id).length,
    }))
  })
}

/** Items a storekeeper can receive or issue against. */
export async function itemList(
  ctx: AnyCtx,
): Promise<{ id: string; code: string; name: string; uom: string }[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({ id: items.id, code: items.code, name: items.name, uom: items.uom })
      .from(items)
      .where(scoped(items, ctx, eq(items.isActive, true)))
      .orderBy(asc(items.code)),
  )
}

/**
 * The rolls behind one item, grouped the way a storekeeper picks them (canvas P2).
 *
 * Shade group leads because it is the decision: rolls in the same group may be cut
 * together, rolls in different ones may not, and a lay spread across two shades is
 * discovered by a buyer rather than by the store. Ungrouped rolls (trims, and fabric that
 * arrived without a dye lot) sort last under a null group rather than being hidden.
 */
export interface RollRow {
  id: string
  rollNo: string
  lot: string | null
  dyeLot: string | null
  shadeGroup: string | null
  qty: string
  unit: string
  status: string
  locationCode: string
  locationKind: string
  receivedAt: string
  challanNo: string
  /** The declaration this roll's GRN named, when bonded — what the balance preview asks
      about (adoption plan 2.3). Null for general stock. */
  udId: string | null
  /** Its NUMBER, because a screen says UD-2026-058 and never a uuid. */
  udNumber: string | null
}

export async function rollsForItem(ctx: AnyCtx, itemId: string): Promise<RollRow[]> {
  return withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: rolls.id,
        rollNo: rolls.rollNo,
        lot: rolls.lot,
        dyeLot: rolls.dyeLot,
        shadeGroup: rolls.shadeGroup,
        qty: rolls.qty,
        unit: rolls.unit,
        status: rolls.status,
        locationCode: locations.code,
        locationKind: locations.kind,
        receivedAt: grns.receivedAt,
        challanNo: grns.challanNo,
        udId: grns.udId,
        udNumber: uds.number,
      })
      .from(rolls)
      .innerJoin(locations, eq(locations.id, rolls.locationId))
      .innerJoin(grnLines, eq(grnLines.id, rolls.grnLineId))
      .innerJoin(grns, eq(grns.id, grnLines.grnId))
      // Left: general stock has no declaration, and a roll without one still belongs on
      // the list. Read through 2.2's table for the number only (rule 11 is about writes).
      .leftJoin(uds, eq(uds.id, grns.udId))
      .where(scoped(rolls, ctx, eq(rolls.itemId, itemId)))
      // Nulls last: an ungrouped roll is not "group zero", it is a roll nobody has
      // shade-matched, and it belongs at the bottom of the pick list.
      .orderBy(asc(rolls.shadeGroup), asc(rolls.rollNo)),
  )
}

/**
 * What the floor is still owed (canvas P3).
 *
 * An issue is made against a REQUISITION, not against an order — the requisition is what
 * says how much this order was sized for, and issuing without one is how a cutting table
 * takes another order's cloth. Lines that are fully issued are dropped: the screen is a
 * list of what is outstanding, and a settled line on it is noise a storekeeper has to read
 * past every time.
 */
export interface OutstandingLine {
  requisitionId: string
  requisitionLineId: string
  orderId: string
  poNumbers: string[]
  itemId: string
  itemCode: string
  itemName: string
  requiredQty: string
  issuedQty: string
  outstandingQty: string
  unit: string
}

/**
 * The shade groups each order has ALREADY been issued.
 *
 * The pick screen's mixing warning used to see only the current pick — two rolls of B in
 * one issue warned, one roll of B after yesterday's A went through silently, and the
 * cross-issue case is the one that actually reaches a cutting table (live-test finding,
 * Phase 4). The service records the warning either way; this is what lets the screen say
 * it BEFORE the rolls leave the rack.
 */
export async function issuedShadeGroups(
  ctx: AnyCtx,
  orderIds: readonly string[],
): Promise<Record<string, string[]>> {
  if (orderIds.length === 0) return {}
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .selectDistinct({ orderId: issues.orderId, shadeGroup: rolls.shadeGroup })
      .from(issueLines)
      .innerJoin(issues, eq(issues.id, issueLines.issueId))
      .innerJoin(rolls, eq(rolls.id, issueLines.rollId))
      .where(scoped(issueLines, ctx, inArray(issues.orderId, [...orderIds])))

    const byOrder: Record<string, string[]> = {}
    for (const row of rows) {
      if (!row.shadeGroup) continue
      ;(byOrder[row.orderId] ??= []).push(row.shadeGroup)
    }
    return byOrder
  })
}

export async function outstandingRequisitions(ctx: AnyCtx): Promise<OutstandingLine[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        requisitionId: requisitions.id,
        requisitionLineId: requisitionLines.id,
        orderId: requisitions.orderId,
        poNumbers: orders.poNumbers,
        itemId: items.id,
        itemCode: items.code,
        itemName: items.name,
        requiredQty: requisitionLines.requiredQty,
        issuedQty: requisitionLines.issuedQty,
        unit: requisitionLines.unit,
      })
      .from(requisitionLines)
      .innerJoin(requisitions, eq(requisitions.id, requisitionLines.requisitionId))
      .innerJoin(orders, eq(orders.id, requisitions.orderId))
      .innerJoin(items, eq(items.id, requisitionLines.itemId))
      .where(scoped(requisitionLines, ctx, inArray(requisitions.status, ['open', 'partial'])))
      .orderBy(asc(items.code))

    return rows
      .map((row) => ({
        ...row,
        outstandingQty: (Number(row.requiredQty) - Number(row.issuedQty)).toFixed(2),
      }))
      .filter((row) => Number(row.outstandingQty) > 0)
  })
}
