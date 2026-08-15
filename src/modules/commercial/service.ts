/**
 * 2.2 Bonded Warehouse & UD — service layer (brief §Operations).
 *
 * This module owns the UD balance gate, one of the five named server-side gates
 * (CLAUDE.md rule 8). Module 3.1 Store calls `drawUd` from inside its own issue
 * transaction; nothing else writes `ud_consumptions`.
 *
 * The concurrency requirement is explicit in architecture §9: "UD/BTB concurrent overdraw
 * attempt → row-lock inside the gate check transaction; second writer blocks then fails
 * the gate." Two storekeepers issuing the last of a bonded roll at the same moment must
 * not both succeed, and a check that reads the balance outside a lock would let them.
 */
import { and, desc, eq, sql } from 'drizzle-orm'

import { factoryToday } from '@/lib/dates'
import { compareDecimalStrings } from '@/lib/quantity'

import { recordChange, registerAuditedTables } from '../core/audit'
import type { AnyCtx, RequestCtx } from '../core/ctx'
import { AppError, notFound } from '../core/errors'
import { assertGate, GATES } from '../core/gates'
import { emit } from '../core/outbox'
import { defineStateMachine } from '../core/state-machine'
import { scoped } from '../core/scoped'
import { type TenantDb, withTenantRead, withTenantTx } from '../core/tenancy'

import {
  applyAmendment,
  BankDocsError,
  discrepancyAge,
  realizationLag,
  realizationShortfall,
  type LcAmendmentDiff,
} from './bank-docs'
import { COMMERCIAL_EVENTS } from './events'
import { btbHeadroom, detectLcConflicts } from './lc-conflicts'
import {
  bankCharges,
  btbLcs,
  docSubmissions,
  lcAmendments,
  lcs,
  udConsumptions,
  udReconciliations,
  uds,
} from './schema'
import {
  checkUdDraw,
  computeUdBalance,
  type UdAuthorizedItem,
  type UdDrawDecision,
  type UdItemBalance,
  type UdStatus,
  UdError,
} from './ud'
import {
  createLcPayload,
  createUdPayload,
  lcFromSwiftDraft,
  udAuthorizedItems,
  udOverrideDraft,
} from './zod'

/** ⚖ — compliance-bearing; a customs inspector may ask who drew what, and when. */
registerAuditedTables('uds', 'ud_consumptions', 'lcs', 'btb_lcs', 'lc_amendments', 'doc_submissions')


/** Load a UD and its consumption ledger, optionally locking the UD row. */
async function loadUd(
  // `ctx` first, like every other function that reads a tenant's rows. Adding it to a
  // private helper is what let both of its queries name the company (plan 1.3) — the
  // alternative was two `.where` clauses standing on RLS alone in the middle of the UD
  // ledger, which is the one place in this module a wrong row is a customs problem.
  ctx: AnyCtx,
  tx: TenantDb,
  udId: string,
  lock: boolean,
): Promise<{
  ud: { id: string; number: string; status: UdStatus; validUntil: string | null; authorizedItems: UdAuthorizedItem[] }
  consumptions: { itemRef: string; qty: string; unit: string }[]
}> {
  const query = tx.select().from(uds).where(scoped(uds, ctx, eq(uds.id, udId)))
  const [row] = lock ? await query.for('update') : await query

  if (!row) throw notFound('commercial.errors.ud_not_found', { udId })

  const parsed = udAuthorizedItems.safeParse(row.authorizedItems)
  if (!parsed.success) {
    // A declaration transcribed before a schema tightening, or hand-edited. Refuse rather
    // than compute a balance from data we cannot vouch for.
    throw new AppError('validation_failed', 'commercial.errors.ud_items_invalid', {
      udId,
      issues: parsed.error.issues.map((i) => i.message),
    })
  }

  const ledger = await tx
    .select({ itemRef: udConsumptions.itemRef, qty: udConsumptions.qty, unit: udConsumptions.unit })
    .from(udConsumptions)
    .where(scoped(udConsumptions, ctx, eq(udConsumptions.udId, udId)))

  return {
    ud: {
      id: row.id,
      number: row.number,
      status: row.status,
      validUntil: row.validUntil,
      authorizedItems: parsed.data,
    },
    consumptions: ledger,
  }
}

/**
 * Read-only preview of the gate — "could this issue go through?".
 *
 * The storekeeper's screen calls this to show the free balance before they commit to a
 * quantity. It takes NO lock, so its answer can be stale by the time they press save;
 * that is fine, because `drawUd` re-checks under a lock and is the only thing that
 * decides. A preview that locked would hold a row open for as long as someone stared at
 * a screen.
 */
export async function checkUdBalance(
  ctx: AnyCtx,
  input: { udId: string; itemRef: string; qty: string; unit: string; today?: string },
): Promise<UdDrawDecision> {
  return withTenantRead(ctx, async (tx) => {
    const { ud, consumptions } = await loadUd(ctx, tx, input.udId, false)
    return checkUdDraw({
      ud,
      consumptions,
      itemRef: input.itemRef,
      qty: input.qty,
      unit: input.unit,
      today: input.today ?? factoryToday(),
    })
  })
}

/** The whole ledger for one UD — the reconciliation and the balance screen both read it. */
export async function getUdBalance(
  ctx: AnyCtx,
  udId: string,
): Promise<{ udNumber: string; status: UdStatus; validUntil: string | null; items: UdItemBalance[] }> {
  return withTenantRead(ctx, async (tx) => {
    const { ud, consumptions } = await loadUd(ctx, tx, udId, false)
    const balance = computeUdBalance({ authorizedItems: ud.authorizedItems, consumptions })
    return {
      udNumber: ud.number,
      status: ud.status,
      validUntil: ud.validUntil,
      items: [...balance.values()],
    }
  })
}

export interface UdDrawInput {
  udId: string
  itemRef: string
  /**
   * Other names the same material answers to, tried when `itemRef` is not on the
   * declaration. A declaration typed from the customs paper authorizes "12oz stretch
   * denim"; the store issues FAB-DEN-12 — same cloth, two vocabularies, and the ledger
   * must be written in the DECLARATION's or the reconciliation will not balance. The
   * first ref the declaration actually authorizes is the one recorded.
   */
  itemRefAliases?: readonly string[]
  qty: string
  unit: string
  /** The issue this draw belongs to. Set by module 3.1. */
  storeIssueId?: string
  today?: string
  /**
   * Set ONLY by the approve path, when an owner has approved a deliberate overdraw
   * through pending_changes. Never settable from a request.
   */
  approvedOverride?: boolean
}

/**
 * Draw against a UD, inside the caller's transaction.
 *
 * Takes a `tx` rather than opening one: module 3.1 calls this from inside its store-issue
 * transaction, so the issue and the consumption commit together. A draw recorded without
 * its issue — or an issue without its draw — is a reconciliation that will not balance,
 * which is the one thing customs actually checks.
 *
 * `FOR UPDATE` on the UD row is the concurrency answer (architecture §9). Two
 * storekeepers issuing the last of a roll at the same moment serialise here: the second
 * blocks, then re-reads a ledger that already includes the first, and fails the gate.
 */
export async function drawUd(
  ctx: AnyCtx,
  tx: TenantDb,
  input: UdDrawInput,
): Promise<{ consumptionId: string; decision: UdDrawDecision }> {
  const { ud, consumptions } = await loadUd(ctx, tx, input.udId, true)

  // The ledger is written in the declaration's vocabulary: the first candidate ref the
  // declaration authorizes wins; when none does, the primary ref carries the refusal so
  // the message names what the store calls the thing.
  const authorized = new Set(
    (ud.authorizedItems as { itemRef?: string }[]).map((item) => item.itemRef).filter(Boolean),
  )
  const itemRef =
    [input.itemRef, ...(input.itemRefAliases ?? [])].find((ref) => authorized.has(ref)) ??
    input.itemRef

  const decision = checkUdDraw({
    ud,
    consumptions,
    itemRef,
    qty: input.qty,
    unit: input.unit,
    today: input.today ?? factoryToday(),
  })

  if (!decision.allowed && !input.approvedOverride) {
    // Hard block. Overdrawing a UD is legal exposure, not a warning — the storekeeper
    // gets the numbers and, if the factory really means it, an owner approves an override
    // through pending_changes.
    throw new AppError('gate_blocked', decision.reasonKey ?? 'commercial.ud.blocked', {
      gate: 'ud_balance',
      ...decision.facts,
    })
  }

  const [row] = await tx
    .insert(udConsumptions)
    .values({
      companyId: ctx.companyId,
      udId: input.udId,
      storeIssueId: input.storeIssueId ?? null,
      // The RESOLVED ref — the declaration's own word for the material, never the
      // store's, or computeUdBalance refuses the whole ledger as inconsistent.
      itemRef,
      qty: input.qty,
      unit: input.unit,
      overrideOf: input.approvedOverride && !decision.allowed ? input.udId : null,
      createdBy: ctx.userId,
    })
    .returning({ id: udConsumptions.id })

  if (!row) throw new Error('ud_consumptions insert returned nothing')

  await recordChange(ctx, tx, {
    action: 'insert',
    targetTable: 'ud_consumptions',
    targetId: row.id,
    after: {
      udNumber: ud.number,
      // The RESOLVED ref, matching the row that was just written. An audit trail that names
      // the material differently from the ledger it is auditing is worse than none: it is
      // the customs officer's evidence that the two records disagree.
      itemRef,
      qty: input.qty,
      unit: input.unit,
      override: Boolean(input.approvedOverride && !decision.allowed),
    },
  })

  if (input.approvedOverride && !decision.allowed) {
    // An approved overdraw is the single most audit-worthy event in this module. It gets
    // its own event so the owner digest and the compliance file both see it.
    await emit(ctx, tx, {
      eventName: COMMERCIAL_EVENTS.udOverdrawn,
      payload: {
        udId: input.udId,
        udNumber: ud.number,
        itemRef,
        qty: input.qty,
        shortfall: decision.shortfall ?? null,
        approvedBy: ctx.userId,
      },
      aggregateTable: 'uds',
      aggregateId: input.udId,
    })
  }

  /*
   * Exhausted is a real state: it stops the gate wasting a lock on a UD with nothing left.
   *
   * `itemRef` — resolved — and not `input.itemRef`, which is what this line said, and which
   * made every legal bonded issue of aliased material throw. The store issues FAB-DEN-12;
   * the declaration authorises "12oz stretch denim"; the row above is correctly written in
   * the declaration's words and this recompute then appended a consumption in the store's,
   * so `computeUdBalance` refused the whole ledger as naming a material the UD does not
   * authorise — AFTER the draw had been written, so the transaction rolled back and the
   * storekeeper was told the declaration did not cover cloth that it plainly did.
   *
   * The alias mechanism a few lines up exists for exactly this case and had therefore never
   * once worked end to end: the only bonded issues that succeeded were the ones where the
   * item code happened to be spelled the way customs spelled it.
   */
  const remaining = computeUdBalance({
    authorizedItems: ud.authorizedItems,
    consumptions: [...consumptions, { itemRef, qty: input.qty, unit: input.unit }],
  })
  const anyFree = [...remaining.values()].some((item) => compareDecimalStrings(item.free, '0') > 0)

  if (!anyFree && ud.status === 'active') {
    udMachine.assert(ud.status, 'exhausted')
    await tx.update(uds).set({ status: 'exhausted', updatedAt: new Date() }).where(scoped(uds, ctx, eq(uds.id, ud.id)))
    await emit(ctx, tx, {
      eventName: COMMERCIAL_EVENTS.udExhausted,
      payload: { udId: ud.id, udNumber: ud.number },
      aggregateTable: 'uds',
      aggregateId: ud.id,
    })
  }

  return { consumptionId: row.id, decision }
}

/** Convenience wrapper for callers that are not already inside a transaction. */
export async function drawUdStandalone(
  ctx: RequestCtx,
  input: UdDrawInput,
): Promise<{ consumptionId: string; decision: UdDrawDecision }> {
  return withTenantTx(ctx, (tx) => drawUd(ctx, tx, input))
}

/**
 * Freeze a period's balances and store the snapshot the customs PDF is rendered from.
 *
 * Snapshotted rather than recomputed at render time: a reconciliation submitted to
 * customs must produce the same figures if it is regenerated a year later, and a live
 * query would drift as the ledger grows.
 */
export async function snapshotReconciliation(
  ctx: RequestCtx,
  input: { udId: string; period: string },
): Promise<{ reconciliationId: string; items: UdItemBalance[] }> {
  if (!/^\d{4}-\d{2}$/.test(input.period)) {
    throw new AppError('validation_failed', 'commercial.errors.invalid_period', {
      period: input.period,
    })
  }

  return withTenantTx(ctx, async (tx) => {
    const { ud, consumptions } = await loadUd(ctx, tx, input.udId, true)
    const items = [...computeUdBalance({ authorizedItems: ud.authorizedItems, consumptions }).values()]

    const [row] = await tx
      .insert(udReconciliations)
      .values({
        companyId: ctx.companyId,
        udId: input.udId,
        period: input.period,
        snapshot: { udNumber: ud.number, generatedAt: new Date().toISOString(), items },
        createdBy: ctx.userId,
      })
      .onConflictDoNothing()
      .returning({ id: udReconciliations.id })

    if (!row) {
      throw new AppError('conflict', 'commercial.errors.reconciliation_exists', {
        udId: input.udId,
        period: input.period,
      })
    }

    return { reconciliationId: row.id, items }
  })
}

/** Mark UDs past their validity date. Used by the nightly job. */
export async function expireLapsedUds(
  ctx: AnyCtx,
  input: { today?: string } = {},
): Promise<{ expired: number }> {
  const today = input.today ?? factoryToday()

  return withTenantTx(ctx, async (tx) => {
    // The WHERE already restricts this to `active`, and the machine says so out loud —
    // the predicate is what makes it true, this is what makes it checkable.
    udMachine.assert('active', 'expired')
    const lapsed = await tx
      .update(uds)
      .set({ status: 'expired', updatedAt: new Date() })
      .where(scoped(uds, ctx, and(eq(uds.status, 'active'), sql`${uds.validUntil} < ${today}`)))
      .returning({ id: uds.id, number: uds.number })

    for (const ud of lapsed) {
      await emit(ctx, tx, {
        eventName: COMMERCIAL_EVENTS.udExpired,
        payload: { udId: ud.id, udNumber: ud.number, expiredOn: today },
        aggregateTable: 'uds',
        aggregateId: ud.id,
      })
    }

    return { expired: lapsed.length }
  })
}

export { UdError }

// ─────────────────────────────────────────────────────────────────────────────
// BTB headroom — the gate 3.2 Procurement calls before issuing an import PO
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is there room under the master LC for this back-to-back?
 *
 * Exposed here because `btb_lcs` and `lcs` belong to this module (rule 11) — procurement
 * reads the answer, not the tables. A BTB funds the fabric and trims for an order against
 * the master LC the buyer opened; over-opening BTBs against a master is how a factory ends
 * up owing its suppliers more than the buyer will ever pay it.
 *
 * `excludeBtbId` exists for re-checks on an existing BTB: counting it as used would
 * compare it with itself.
 */
export interface BtbHeadroomResult {
  passed: boolean
  reasonKey?: string
  facts?: Record<string, unknown>
}

export async function checkBtbHeadroom(
  ctx: AnyCtx,
  input: { btbLcId: string; limitPct: number; excludeBtbId?: string },
): Promise<BtbHeadroomResult> {
  return withTenantRead(ctx, (tx) => checkBtbHeadroomIn(ctx, tx, input))
}

/**
 * The body, taking a transaction rather than opening one.
 *
 * `issuePo` used to call the wrapper from inside its own `withTenantTx`, which opens a
 * SECOND transaction on another connection while the first is still open — the shape this
 * codebase already warns about in `saveBreakdownIn`, where it deadlocks under approval. It
 * also meant the headroom was read outside the transaction that then wrote the PO, so the
 * answer was already stale by the time it was used (audit note on plan 2.6).
 *
 * `lock` takes `FOR UPDATE` on the master credit, which is what `openBtb` already does on
 * its own path: two callers deciding against the same ceiling must queue, not race.
 */
export async function checkBtbHeadroomIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { btbLcId: string; limitPct: number; excludeBtbId?: string; lock?: boolean },
): Promise<BtbHeadroomResult> {
    const [btb] = await tx.select().from(btbLcs).where(scoped(btbLcs, ctx, eq(btbLcs.id, input.btbLcId)))
    if (!btb) {
      return {
        passed: false,
        reasonKey: 'gates.btb_headroom.btb_not_found',
        facts: { btbLcId: input.btbLcId },
      }
    }

    const masterQuery = tx.select().from(lcs).where(scoped(lcs, ctx, eq(lcs.id, btb.masterLcId)))
    const [master] = input.lock ? await masterQuery.for('update') : await masterQuery
    if (!master) {
      return {
        passed: false,
        reasonKey: 'gates.btb_headroom.master_not_found',
        facts: { masterLcId: btb.masterLcId },
      }
    }

    if (master.status !== 'active') {
      // A BTB drawn against a master that is not live has nothing funding it.
      return {
        passed: false,
        reasonKey: 'gates.btb_headroom.master_not_active',
        facts: { masterLcId: master.id, masterStatus: master.status },
      }
    }

    if (btb.currency !== master.currency) {
      // Netting a BTB against a master in another currency needs a rate nobody has
      // stated. Refusing is the only honest answer.
      return {
        passed: false,
        reasonKey: 'gates.btb_headroom.currency_mismatch',
        facts: { btbCurrency: btb.currency, masterCurrency: master.currency },
      }
    }

    const siblings = await tx
      .select({ id: btbLcs.id, value: btbLcs.value })
      .from(btbLcs)
      .where(scoped(btbLcs, ctx, and(eq(btbLcs.masterLcId, master.id), sql`${btbLcs.status} <> 'closed'`)))

    const headroom = btbHeadroom({
      masterValue: master.value,
      existingBtbValues: siblings
        .filter((row) => row.id !== input.excludeBtbId)
        .map((row) => row.value),
      limitPct: input.limitPct,
    })

    return headroom.exceeded
      ? {
          passed: false,
          reasonKey: 'gates.btb_headroom.exceeded',
          facts: {
            masterLcId: master.id,
            limit: headroom.limit,
            used: headroom.used,
            free: headroom.free,
            currency: master.currency,
            limitPct: input.limitPct,
            // Composed here because only `reason` crosses a server action's boundary — the
            // catalogue copy for this key carried {limit}/{used}/{free} and reached the
            // screen with the braces still in it. The figures are the whole refusal.
            reason:
              `The back-to-back credits under ${master.number} would pass their ceiling. ` +
              `${input.limitPct}% of the master is ${headroom.limit} ${master.currency}, ` +
              `${headroom.used} is already opened, and ${headroom.free} is free.`,
          },
        }
      : {
          passed: true,
          facts: { limit: headroom.limit, used: headroom.used, free: headroom.free },
        }
}

/**
 * What one back-to-back credit is worth, for a caller deciding whether it funds something.
 *
 * `checkBtbHeadroomIn` answers a different question — whether the CREDITS fit under their
 * master — and answering it says nothing about whether any particular purchase order fits
 * inside the credit it names. Procurement needs the credit's own figures to decide that, and
 * `btb_lcs` is this module's table (rule 11), so it reads them through here rather than
 * touching the rows.
 *
 * Takes the transaction, like its neighbour, so a caller mid-write does not open a second
 * connection against a row it has already locked.
 */
export async function btbCreditIn(
  ctx: AnyCtx,
  tx: TenantDb,
  btbLcId: string,
): Promise<{ id: string; number: string; value: string; currency: string; masterLcId: string } | null> {
  const [btb] = await tx
    .select({
      id: btbLcs.id,
      number: btbLcs.number,
      value: btbLcs.value,
      currency: btbLcs.currency,
      masterLcId: btbLcs.masterLcId,
    })
    .from(btbLcs)
    .where(scoped(btbLcs, ctx, eq(btbLcs.id, btbLcId)))

  return btb ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// 2.1 LC Register & Bank Docs ⚖
// ─────────────────────────────────────────────────────────────────────────────

/**
 * preparing → submitted → accepted | discrepant → realized.
 *
 * `discrepant → submitted` is the loop that matters: a refused presentation is corrected and
 * re-presented, which is routine. `realized` is terminal — the money has arrived, and a
 * status that could move afterwards would let a settled receivable reopen.
 */
/**
 * A customs declaration's lifecycle (audit BE-M1).
 *
 * `uds.status` was set by raw update in two places with nothing declaring what a legal
 * move is. It matters more here than on most columns: the UD gate reads this status to
 * decide whether bonded fabric may be issued, so a declaration moved backwards — expired
 * to active — is duty-free fabric drawn against a dead permission, which is the exposure
 * the gate exists to prevent.
 *
 * Terminal both ways on purpose. An exhausted UD has nothing left to draw and an expired
 * one has no time left to draw it; either way the answer is a new declaration, not a
 * revived one.
 */
export const udMachine = defineStateMachine({
  field: 'status',
  initial: 'active',
  transitions: {
    active: ['exhausted', 'expired', 'closed'],
    // Exhausted is about quantity and expiry about time, so a UD with nothing left can
    // still lapse — the customs record should say which happened.
    exhausted: ['expired', 'closed'],
    expired: ['closed'],
    closed: [],
  },
})

export type UdLifecycle = (typeof udMachine.states)[number]

export const submissionMachine = defineStateMachine({
  field: 'bankStatus',
  initial: 'preparing',
  transitions: {
    preparing: ['submitted'],
    submitted: ['accepted', 'discrepant'],
    accepted: ['realized', 'discrepant'],
    discrepant: ['submitted', 'realized'],
    realized: [],
  },
})

export type BankStatus = (typeof submissionMachine.states)[number]

/** Company policy. Owned by Settings (X.3); passed in until that module exists. */
export interface BankDocsPolicy {
  /** Days a discrepancy may sit before it escalates. Brief says 5. */
  discrepancyEscalateAfterDays: number
  /** A realization short by more than this needs a written reason. */
  explainShortfallAbovePct: string
  /** Master-LC percentage a BTB may not exceed. */
  btbLimitPct?: number
}

function wrapBankDocsError<T>(run: () => T): T {
  try {
    return run()
  } catch (error) {
    if (error instanceof BankDocsError) {
      throw new AppError('validation_failed', 'commercial.errors.bank_docs_invalid', {
        reason: error.message,
      })
    }
    throw error
  }
}

/**
 * Tie a credit to the order it pays for ⚖.
 *
 * `order_lcs` has been READ since 2.1 shipped — the amendment path re-checks conflicts
 * through it, the countdown job fans alerts out through it — and had no writer anywhere:
 * not a service function, not an action, not a screen. Every conflict the module can
 * detect was unreachable, because the join it detects through was permanently empty.
 * The orders module's register says why the door belongs HERE: linking a credit is a
 * commercial decision (rule 11 — one writer per shared table, and this is it).
 *
 * The buyer must match. A credit from one buyer covering another buyer's order is goods
 * shipping against a promise that cannot pay for them.
 */
export async function linkOrder(
  ctx: RequestCtx,
  input: { lcId: string; orderId: string },
): Promise<{ linked: boolean; floatDays: number | null }> {
  return withTenantTx(ctx, async (tx) => {
    const [lc] = await tx.select().from(lcs).where(scoped(lcs, ctx, eq(lcs.id, input.lcId)))
    if (!lc) throw notFound('commercial.errors.lc_not_found', { lcId: input.lcId })

    const { orderLcs, orders } = await import('@/modules/orders/schema')
    const [order] = await tx
      .select({
        id: orders.id,
        buyerId: orders.buyerId,
        poNumbers: orders.poNumbers,
        plannedExFactoryDate: orders.plannedExFactoryDate,
      })
      .from(orders)
      .where(scoped(orders, ctx, eq(orders.id, input.orderId)))
    if (!order) throw notFound('commercial.errors.order_not_found', { orderId: input.orderId })

    if (order.buyerId !== lc.buyerId) {
      throw new AppError('validation_failed', 'commercial.errors.lc_order_buyer_mismatch', {
        reason: `${lc.number} was issued by a different buyer than this order — a credit cannot pay for goods it was never opened against`,
      })
    }

    // Idempotent on the pair: re-linking is a no-op, never a duplicate row.
    const inserted = await tx
      .insert(orderLcs)
      .values({ companyId: ctx.companyId, orderId: order.id, lcId: lc.id })
      .onConflictDoNothing()
      .returning({ id: orderLcs.id })

    // Days between planned ex-factory and the credit's latest shipment. The number a
    // commercial officer actually watches: 1 is a working credit, negative is a refusal
    // at the bank already written into the plan.
    const floatDays =
      lc.latestShipmentDate && order.plannedExFactoryDate
        ? Math.round(
            (Date.parse(`${lc.latestShipmentDate}T00:00:00Z`) -
              Date.parse(`${order.plannedExFactoryDate}T00:00:00Z`)) /
              86_400_000,
          )
        : null

    if (inserted.length > 0) {
      await recordChange(ctx, tx, {
        action: 'update',
        targetTable: 'lcs',
        targetId: lc.id,
        before: {},
        after: { linkedOrderId: order.id, poNumbers: order.poNumbers ?? [], floatDays },
      })
    }

    return { linked: inserted.length > 0, floatDays }
  })
}

/**
 * Amend an LC ⚖ (brief: "amend LC (versioned diff, re-runs conflict detector)").
 *
 * The detector runs against the AMENDED terms and its findings are stored on the amendment
 * row. An amendment that tightens the credit can put orders in conflict that were fine an
 * hour ago, and the whole point of recording the conflicts here is that somebody can see
 * which amendment caused them rather than discovering it when a shipment is refused.
 */
export async function amendLc(
  ctx: RequestCtx,
  input: {
    lcId: string
    diff: LcAmendmentDiff
    receivedAt: string
    documentId?: string
    presentationDays?: number
  },
): Promise<{ amendmentId: string; number: number; tightened: boolean; conflicts: unknown[] }> {
  return withTenantTx(ctx, async (tx) => {
    const [lc] = await tx.select().from(lcs).where(scoped(lcs, ctx, eq(lcs.id, input.lcId))).for('update')
    if (!lc) throw notFound('commercial.errors.lc_not_found', { lcId: input.lcId })

    if (lc.status === 'closed' || lc.status === 'expired') {
      // A bank does not amend a credit that is no longer live.
      throw new AppError('conflict', 'commercial.errors.lc_not_amendable', {
        lcId: lc.id,
        status: lc.status,
      })
    }

    const result = wrapBankDocsError(() =>
      applyAmendment(
        {
          value: lc.value,
          currency: lc.currency,
          tolerancePct: lc.tolerancePct,
          latestShipmentDate: lc.latestShipmentDate,
          expiryDate: lc.expiryDate,
        },
        input.diff,
      ),
    )

    const [latest] = await tx
      .select({ number: lcAmendments.number })
      .from(lcAmendments)
      .where(scoped(lcAmendments, ctx, eq(lcAmendments.lcId, lc.id)))
      .orderBy(desc(lcAmendments.number))
      .limit(1)

    const number = (latest?.number ?? 0) + 1

    // Re-run the detector against the amended terms, over every order on this credit.
    const { orderLcs, orders } = await import('@/modules/orders/schema')
    const linked = await tx
      .select({
        id: orders.id,
        poNumbers: orders.poNumbers,
        status: orders.status,
        plannedExFactory: orders.plannedExFactoryDate,
      })
      .from(orders)
      .innerJoin(orderLcs, eq(orderLcs.orderId, orders.id))
      .where(scoped(orders, ctx, eq(orderLcs.lcId, lc.id)))

    const conflicts = detectLcConflicts({
      lc: {
        id: lc.id,
        number: lc.number,
        latestShipmentDate: result.terms.latestShipmentDate,
        expiryDate: result.terms.expiryDate,
        status: lc.status,
      },
      orders: linked.map((order) => ({
        id: order.id,
        poNumbers: order.poNumbers,
        plannedExFactoryDate: order.plannedExFactory,
        status: order.status,
      })),
      presentationDays: input.presentationDays,
    })

    await tx
      .update(lcs)
      .set({
        value: result.terms.value,
        tolerancePct: result.terms.tolerancePct,
        latestShipmentDate: result.terms.latestShipmentDate,
        expiryDate: result.terms.expiryDate,
        updatedAt: new Date(),
      })
      .where(scoped(lcs, ctx, eq(lcs.id, lc.id)))

    const [row] = await tx
      .insert(lcAmendments)
      .values({
        companyId: ctx.companyId,
        lcId: lc.id,
        number,
        diff: result.changed,
        tightened: result.tightened,
        conflictsAfter: conflicts,
        receivedAt: input.receivedAt,
        documentId: input.documentId ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: lcAmendments.id })

    if (!row) throw new Error('lc_amendments insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'lcs',
      targetId: lc.id,
      before: {
        value: lc.value,
        tolerancePct: lc.tolerancePct,
        latestShipmentDate: lc.latestShipmentDate,
        expiryDate: lc.expiryDate,
      },
      after: {
        amendmentNumber: number,
        diff: result.changed,
        tightened: result.tightened,
        conflictCount: conflicts.length,
      },
    })

    await emit(ctx, tx, {
      eventName: COMMERCIAL_EVENTS.lcAmended,
      payload: {
        lcId: lc.id,
        lcNumber: lc.number,
        amendmentId: row.id,
        number,
        diff: result.changed,
        tightened: result.tightened,
      },
      aggregateTable: 'lcs',
      aggregateId: lc.id,
    })

    if (conflicts.length > 0) {
      // Somebody has to act on these today, not when a shipment is refused.
      await emit(ctx, tx, {
        eventName: COMMERCIAL_EVENTS.lcConflictDetected,
        payload: { lcId: lc.id, causedByAmendment: number, conflicts },
        aggregateTable: 'lcs',
        aggregateId: lc.id,
      })
    }

    return { amendmentId: row.id, number, tightened: result.tightened, conflicts }
  })
}

/**
 * Open a back-to-back LC (brief: "open BTB (headroom validation)").
 *
 * The headroom gate runs here — `checkBtbHeadroom` above computes it, and this is the write
 * that must not happen when it fails. Over-opening BTBs against a master is how a factory
 * ends up owing its suppliers more than the buyer will ever pay it.
 */
export async function openBtb(
  ctx: RequestCtx,
  input: {
    masterLcId: string
    number: string
    supplierId?: string
    value: string
    currency: string
    openedAt?: string
    expiryDate?: string
  },
  policy: BankDocsPolicy,
): Promise<{ btbLcId: string; headroom: Record<string, unknown> }> {
  if (policy.btbLimitPct === undefined) {
    // A headroom check against an unstated ceiling is a pass that means nothing.
    throw new AppError('validation_failed', 'commercial.errors.no_btb_limit', {})
  }

  return withTenantTx(ctx, async (tx) => {
    const [master] = await tx
      .select()
      .from(lcs)
      .where(scoped(lcs, ctx, eq(lcs.id, input.masterLcId)))
      // Locked so two BTBs opened at the same instant cannot both see the same headroom.
      .for('update')

    if (!master) {
      throw notFound('commercial.errors.lc_not_found', { lcId: input.masterLcId })
    }
    if (master.currency !== input.currency) {
      throw new AppError('validation_failed', 'commercial.errors.btb_currency_mismatch', {
        masterCurrency: master.currency,
        btbCurrency: input.currency,
      })
    }

    const siblings = await tx
      .select({ value: btbLcs.value })
      .from(btbLcs)
      .where(scoped(btbLcs, ctx, and(eq(btbLcs.masterLcId, master.id), sql`${btbLcs.status} <> 'closed'`)))

    const headroom = btbHeadroom({
      masterValue: master.value,
      // The proposed BTB counts against the ceiling — checking without it would approve
      // every BTB right up to the limit and then one more.
      existingBtbValues: [...siblings.map((s) => s.value), input.value],
      limitPct: policy.btbLimitPct!,
    })

    assertGate(GATES.btbHeadroom, {
      passed: !headroom.exceeded,
      reasonKey: 'gates.btb_headroom.exceeded',
      facts: {
        masterLcId: master.id,
        limit: headroom.limit,
        used: headroom.used,
        free: headroom.free,
        currency: master.currency,
        limitPct: policy.btbLimitPct!,
      },
    })

    const [row] = await tx
      .insert(btbLcs)
      .values({
        companyId: ctx.companyId,
        masterLcId: master.id,
        number: input.number,
        supplierId: input.supplierId ?? null,
        value: input.value,
        currency: input.currency,
        openedAt: input.openedAt ?? null,
        expiryDate: input.expiryDate ?? null,
        status: 'active',
        createdBy: ctx.userId,
      })
      .returning({ id: btbLcs.id })

    if (!row) throw new Error('btb_lcs insert returned nothing')

    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'btb_lcs',
      targetId: row.id,
      after: {
        masterLcId: master.id,
        number: input.number,
        value: input.value,
        currency: input.currency,
        headroomAfter: headroom.free,
      },
    })

    await emit(ctx, tx, {
      eventName: COMMERCIAL_EVENTS.btbOpened,
      payload: {
        btbLcId: row.id,
        masterLcId: master.id,
        number: input.number,
        value: input.value,
        currency: input.currency,
        freeAfter: headroom.free,
      },
      aggregateTable: 'btb_lcs',
      aggregateId: row.id,
    })

    return { btbLcId: row.id, headroom: headroom as unknown as Record<string, unknown> }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The submission lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fill an open presentation's invoiced amount once 11.1 raises the invoice.
 *
 * A presentation is deliberately openable before the invoice exists — the desk needs a row
 * to track while chasing it — but `postRealization` rightly refuses a realization against
 * no invoiced amount, and NOTHING wrote the amount in later (live-test finding, Phase 8:
 * "have it filled in later" was a comment, not a mechanism). This is the mechanism: the
 * `finance.invoice.drafted` consumer calls it, so commercial stays the one writer of its
 * own table (rule 11). A submission already realized, or already carrying an amount, is
 * left alone — a bank advice reconciled against one number must not have that number move.
 */
export async function fillSubmissionInvoice(
  ctx: AnyCtx,
  input: { shipmentId: string; invoicedAmount: string; currency: string },
): Promise<{ filled: boolean }> {
  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(docSubmissions)
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.shipmentId, input.shipmentId)))
      .for('update')

    if (!row) return { filled: false }
    if (row.invoicedAmount || row.bankStatus === 'realized') return { filled: false }

    await tx
      .update(docSubmissions)
      .set({ invoicedAmount: input.invoicedAmount, currency: input.currency, updatedAt: new Date() })
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'doc_submissions',
      targetId: row.id,
      before: { invoicedAmount: null },
      after: { invoicedAmount: input.invoicedAmount, currency: input.currency },
    })

    return { filled: true }
  })
}

/** Open a presentation for a shipment, from the checklist 8.1 handed off. */
export async function openSubmission(
  // AnyCtx: the 8.1 → 2.1 consumer opens presentations as a system actor.
  ctx: AnyCtx,
  input: {
    lcId: string
    shipmentId?: string
    docs: unknown[]
    invoicedAmount?: string
    currency: string
  },
): Promise<{ submissionId: string }> {
  return withTenantTx(ctx, async (tx) => {
    const [lc] = await tx.select({ id: lcs.id }).from(lcs).where(scoped(lcs, ctx, eq(lcs.id, input.lcId)))
    if (!lc) throw notFound('commercial.errors.lc_not_found', { lcId: input.lcId })

    /*
     * The EXP gate, on the door 8.1 does not own.
     *
     * `handoffDocsToBank` enforces this properly — preflight, trail, then re-checked under
     * a lock — and the worker consumer that normally reaches this function documents that
     * the gate "has already passed by the time this event exists". True for the event path
     * and false for the other one: `createSubmission` is a human action calling straight
     * into here, so a presentation could be opened against a shipment with no EXP number
     * at all. Bangladesh Bank requires one per export shipment; without it the presentation
     * cannot legally be made, which is why this is a block and not a warning.
     *
     * Inside this transaction rather than through 8.1's `queries.ts` (rule 11) because a
     * gate that reads in one transaction and writes in another is a gate with a gap. Same
     * trade, and the same dynamic import, that `shipment/service.ts` makes to read `lcs`.
     */
    if (input.shipmentId) {
      // Note the shape of the remaining hole: a presentation with NO `shipmentId` skips
      // this, because there is no shipment whose EXP number could be checked. That is
      // correct for the non-export presentations this column is nullable for, and it is
      // also the way to dodge the gate — so the honest control is that a presentation with
      // no shipment is visibly unlinked to one, not that this branch is exhaustive.
      const { shipments } = await import('@/modules/shipment/schema')
      const [shipment] = await tx
        .select({ id: shipments.id, expNumber: shipments.expNumber })
        .from(shipments)
        .where(scoped(shipments, ctx, eq(shipments.id, input.shipmentId)))
        .for('update')

      if (!shipment) {
        throw notFound('commercial.errors.shipment_not_found', { shipmentId: input.shipmentId })
      }
      if (!shipment.expNumber) {
        throw new AppError('gate_blocked', 'gates.exp_number.missing', {
          gate: GATES.expNumber,
          shipmentId: shipment.id,
          lcId: input.lcId,
        })
      }
    }

    const [row] = await tx
      .insert(docSubmissions)
      .values({
        companyId: ctx.companyId,
        lcId: input.lcId,
        shipmentId: input.shipmentId ?? null,
        docs: input.docs,
        invoicedAmount: input.invoicedAmount ?? null,
        currency: input.currency,
        createdBy: ctx.userId,
      })
      .returning({ id: docSubmissions.id })

    if (!row) throw new Error('doc_submissions insert returned nothing')

    // A presentation is the moment documents leave for the bank. Opening one silently was
    // the same gap as createLc: the lifecycle updates were audited, the creation was not.
    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'doc_submissions',
      targetId: row.id,
      after: {
        lcId: input.lcId,
        shipmentId: input.shipmentId ?? null,
        invoicedAmount: input.invoicedAmount ?? null,
        currency: input.currency,
      },
    })

    return { submissionId: row.id }
  })
}

/**
 * Move a presentation through the bank's lifecycle ⚖.
 *
 * `realized` goes through `postRealization` instead, because it moves money and has to write
 * the receivable in the same transaction.
 */
export async function setSubmissionStatus(
  ctx: RequestCtx,
  input: {
    submissionId: string
    bankStatus: Exclude<BankStatus, 'realized'>
    submittedAt?: string
    discrepancyNotes?: string
    discrepantSince?: string
  },
): Promise<void> {
  await withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(docSubmissions)
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.id, input.submissionId)))
      .for('update')

    if (!row) {
      throw notFound('commercial.errors.submission_not_found', {
        submissionId: input.submissionId,
      })
    }

    submissionMachine.assert(row.bankStatus as BankStatus, input.bankStatus)

    if (input.bankStatus === 'submitted' && !input.submittedAt && !row.submittedAt) {
      // The aging clock and the whole realization-lag model hang off this date.
      throw new AppError('validation_failed', 'commercial.errors.submitted_needs_date', {})
    }

    if (input.bankStatus === 'discrepant' && !input.discrepancyNotes) {
      // "Discrepant" with no note is a refused presentation nobody can correct.
      throw new AppError('validation_failed', 'commercial.errors.discrepancy_needs_notes', {})
    }

    await tx
      .update(docSubmissions)
      .set({
        bankStatus: input.bankStatus,
        submittedAt: input.submittedAt ?? row.submittedAt,
        discrepancyNotes:
          input.bankStatus === 'discrepant' ? input.discrepancyNotes! : row.discrepancyNotes,
        discrepantSince:
          input.bankStatus === 'discrepant'
            ? (input.discrepantSince ?? factoryToday())
            : row.discrepantSince,
        updatedAt: new Date(),
      })
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'doc_submissions',
      targetId: row.id,
      before: { bankStatus: row.bankStatus },
      after: { bankStatus: input.bankStatus, discrepancyNotes: input.discrepancyNotes ?? null },
    })

    if (input.bankStatus === 'submitted') {
      await emit(ctx, tx, {
        eventName: COMMERCIAL_EVENTS.docsSubmitted,
        payload: {
          submissionId: row.id,
          lcId: row.lcId,
          shipmentId: row.shipmentId,
          submittedAt: input.submittedAt ?? row.submittedAt,
        },
        aggregateTable: 'doc_submissions',
        aggregateId: row.id,
      })
    }

    if (input.bankStatus === 'discrepant') {
      await emit(ctx, tx, {
        eventName: COMMERCIAL_EVENTS.docsDiscrepant,
        payload: {
          submissionId: row.id,
          lcId: row.lcId,
          shipmentId: row.shipmentId,
          notes: input.discrepancyNotes,
        },
        aggregateTable: 'doc_submissions',
        aggregateId: row.id,
      })
    }
  })
}

export interface RealizationResult {
  submissionId: string
  realizedAmount: string
  shortfall: string
  shortfallPct: string
  needsExplanation: boolean
}

/**
 * Post a realization ⚖ (brief: "`postRealization` → Finance receivable + emits
 * `finance.realized`").
 *
 * The money has landed. Two things matter here:
 *
 *  1. **The shortfall is computed and stored, not inferred.** The bank deducts its charges
 *     before crediting, so realized < invoiced is normal — and a receivable derived from the
 *     invoice alone would stay open by the deduction forever.
 *  2. **A large shortfall needs a written reason.** A 12% deduction is not bank charges;
 *     something was disputed or discounted, and closing the account without saying what
 *     loses the only chance to find out.
 */
export async function postRealization(
  ctx: RequestCtx,
  input: {
    submissionId: string
    realizedAmount: string
    realizedAt: string
    shortfallReason?: string
  },
  policy: BankDocsPolicy,
): Promise<RealizationResult> {
  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .select()
      .from(docSubmissions)
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.id, input.submissionId)))
      .for('update')

    if (!row) {
      throw notFound('commercial.errors.submission_not_found', {
        submissionId: input.submissionId,
      })
    }

    submissionMachine.assert(row.bankStatus as BankStatus, 'realized')

    if (!row.invoicedAmount) {
      throw new AppError('validation_failed', 'commercial.errors.no_invoiced_amount', {
        submissionId: row.id,
      })
    }

    const shortfall = wrapBankDocsError(() =>
      realizationShortfall({
        invoiced: row.invoicedAmount!,
        realized: input.realizedAmount,
        explainAbovePct: policy.explainShortfallAbovePct,
      }),
    )

    if (shortfall.needsExplanation && !input.shortfallReason) {
      throw new AppError('validation_failed', 'commercial.errors.shortfall_needs_reason', {
        submissionId: row.id,
        shortfall: shortfall.shortfall,
        shortfallPct: shortfall.shortfallPct,
        thresholdPct: policy.explainShortfallAbovePct,
      })
    }

    await tx
      .update(docSubmissions)
      .set({
        bankStatus: 'realized',
        realizedAmount: input.realizedAmount,
        realizedAt: input.realizedAt,
        shortfallReason: input.shortfallReason ?? null,
        updatedAt: new Date(),
      })
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.id, row.id)))

    await recordChange(ctx, tx, {
      action: 'update',
      targetTable: 'doc_submissions',
      targetId: row.id,
      before: { bankStatus: row.bankStatus },
      after: {
        bankStatus: 'realized',
        realizedAmount: input.realizedAmount,
        realizedAt: input.realizedAt,
        shortfall: shortfall.shortfall,
      },
    })

    // 11.1 closes the receivable off this.
    await emit(ctx, tx, {
      eventName: COMMERCIAL_EVENTS.financeRealized,
      payload: {
        submissionId: row.id,
        lcId: row.lcId,
        shipmentId: row.shipmentId,
        invoicedAmount: row.invoicedAmount,
        realizedAmount: input.realizedAmount,
        currency: row.currency,
        realizedAt: input.realizedAt,
        shortfall: shortfall.shortfall,
        shortfallReason: input.shortfallReason ?? null,
      },
      aggregateTable: 'doc_submissions',
      aggregateId: row.id,
    })

    return {
      submissionId: row.id,
      realizedAmount: input.realizedAmount,
      shortfall: shortfall.shortfall,
      shortfallPct: shortfall.shortfallPct,
      needsExplanation: shortfall.needsExplanation,
    }
  })
}

export async function recordBankCharge(
  ctx: RequestCtx,
  input: {
    lcId?: string
    submissionId?: string
    kind:
      | 'lc_opening'
      | 'amendment'
      | 'negotiation'
      | 'discrepancy'
      | 'courier'
      | 'swift'
      | 'acceptance'
      | 'other'
    amount: string
    currency: string
    chargedOn: string
    note?: string
  },
): Promise<{ chargeId: string }> {
  if (!input.lcId && !input.submissionId) {
    // A charge attributable to neither a credit nor a presentation cannot reach an order,
    // which is the only reason to record it.
    throw new AppError('validation_failed', 'commercial.errors.charge_needs_parent', {})
  }

  return withTenantTx(ctx, async (tx) => {
    const [row] = await tx
      .insert(bankCharges)
      .values({
        companyId: ctx.companyId,
        lcId: input.lcId ?? null,
        submissionId: input.submissionId ?? null,
        kind: input.kind,
        amount: input.amount,
        currency: input.currency,
        chargedOn: input.chargedOn,
        note: input.note ?? null,
        createdBy: ctx.userId,
      })
      .returning({ id: bankCharges.id })

    if (!row) throw new Error('bank_charges insert returned nothing')
    return { chargeId: row.id }
  })
}

/** Discrepancies past the escalation window (brief §Jobs: "discrepancy aging (>5d)"). */
export async function agingDiscrepancies(
  ctx: AnyCtx,
  input: { today: string },
  policy: BankDocsPolicy,
): Promise<
  { submissionId: string; lcId: string; days: number; notes: string | null }[]
> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select()
      .from(docSubmissions)
      .where(scoped(docSubmissions, ctx, eq(docSubmissions.bankStatus, 'discrepant')))

    const out: { submissionId: string; lcId: string; days: number; notes: string | null }[] = []

    for (const row of rows) {
      if (!row.discrepantSince) continue
      const age = wrapBankDocsError(() =>
        discrepancyAge({
          discrepantSince: row.discrepantSince!,
          today: input.today,
          escalateAfterDays: policy.discrepancyEscalateAfterDays,
        }),
      )
      if (!age.escalate) continue
      out.push({
        submissionId: row.id,
        lcId: row.lcId,
        days: age.days,
        notes: row.discrepancyNotes,
      })
    }

    // Oldest first — the one rotting longest is the one to chase.
    return out.sort((a, b) => b.days - a.days)
  })
}

/**
 * How long this buyer's bank actually takes to pay (brief §Jobs: "realization-lag stats per
 * buyer", feeding 11.1's receivable forecast).
 */
export async function buyerRealizationLag(
  ctx: AnyCtx,
  input: { buyerId: string },
): Promise<{ medianDays: number | null; observations: number }> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({ submittedAt: docSubmissions.submittedAt, realizedAt: docSubmissions.realizedAt })
      .from(docSubmissions)
      .innerJoin(lcs, eq(docSubmissions.lcId, lcs.id))
      .where(scoped(docSubmissions, ctx, eq(lcs.buyerId, input.buyerId)))

    return wrapBankDocsError(() =>
      realizationLag(
        rows
          .filter((row) => row.submittedAt !== null)
          .map((row) => ({ submittedAt: row.submittedAt!, realizedAt: row.realizedAt })),
      ),
    )
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// The UD overdraw override — through pending_changes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask an owner to authorise drawing more bonded material than the UD covers.
 *
 * The gate that blocked the issue is a hard block for a reason: bonded fabric came in
 * duty-free against a customs undertaking, and drawing past it is duty owed plus a penalty.
 * So there is no "proceed anyway" on the storekeeper's screen — there is a request, and an
 * owner signs it or does not.
 *
 * The numbers travel on the draft. An approver is accepting a specific quantity of legal
 * exposure on a specific item, and "approve the overdraw" without the shortfall in front of
 * them is a signature nobody can defend to a customs officer.
 *
 * Refuses when the balance actually covers the draw — an approval nobody needs to make
 * still costs a reviewer their attention, and an inbox full of those is an inbox that stops
 * being read.
 */
export async function proposeUdOverride(
  ctx: RequestCtx,
  input: { udId: string; itemRef: string; qty: string; unit: string; storeIssueId?: string; reason: string },
): Promise<{ pendingChangeId: string; decision: UdDrawDecision }> {
  const { propose } = await import('../core/pending-changes')

  const decision = await checkUdBalance(ctx, {
    udId: input.udId,
    itemRef: input.itemRef,
    qty: input.qty,
    unit: input.unit,
  })

  if (decision.allowed) {
    throw new AppError('validation_failed', 'commercial.errors.ud_not_short', {
      udId: input.udId,
      itemRef: input.itemRef,
    })
  }

  const payload = udOverrideDraft.parse({
    udId: input.udId,
    itemRef: input.itemRef,
    qty: input.qty,
    unit: input.unit,
    ...(input.storeIssueId ? { storeIssueId: input.storeIssueId } : {}),
    reason: input.reason,
  })

  const { id } = await propose(ctx, {
    moduleId: 'commercial',
    targetTable: 'ud_consumptions',
    // No `targetId`: an insert has no existing row to aim at, and `propose` enforces that.
    // The UD the draw lands against travels in the payload, where the approver can see it.
    operation: 'insert',
    zodSchemaKey: 'ud_override_v1',
    // A person typed this reason and a person chose the quantity. No extractor, so no field
    // confidence — a constant would sail straight past the check the pending flow exists for.
    source: 'user_draft',
    payload: payload as unknown as Record<string, unknown>,
  })

  return { pendingChangeId: id, decision }
}

/**
 * Commit an approved overdraw.
 *
 * `approvedOverride` is set HERE and nowhere else — it is the one flag that lets a draw past
 * the balance check, and `UdDrawInput` documents it as unsettable from a request. Routing it
 * through the commit handler means the only way to overdraw a UD is an owner's approval that
 * left an `audit_log` row behind it.
 */
export async function commitUdOverride(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  const payload = udOverrideDraft.parse(input.payload)

  const { consumptionId, decision } = await drawUd(ctx, tx, {
    udId: payload.udId,
    itemRef: payload.itemRef,
    qty: payload.qty,
    unit: payload.unit,
    ...(payload.storeIssueId ? { storeIssueId: payload.storeIssueId } : {}),
    approvedOverride: true,
  })

  return {
    rowId: consumptionId,
    after: {
      udId: payload.udId,
      itemRef: payload.itemRef,
      qty: payload.qty,
      unit: payload.unit,
      reason: payload.reason,
      overdrawnBy: decision.shortfall ?? null,
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Recording the instruments themselves
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Record a Utilization Declaration (canvas P1: "Record a UD").
 *
 * The authorised items ARE the declaration — a UD with no items authorises nothing, which
 * is why the zod refuses an empty list rather than storing a shell somebody fills in later.
 * Every bonded issue in the factory is checked against these quantities, so a UD recorded
 * wrong is a gate calibrated wrong.
 *
 * `number` is unique per company: two rows for one declaration means two independent
 * balances for one legal undertaking, and both of them will look fine.
 */
export async function createUd(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ udId: string; number: string }> {
  return withTenantTx(ctx, (tx) => createUdIn(ctx, tx, input))
}

/**
 * Commit a UD drafted from a scan — the far end of MARBIM's intake for this module.
 *
 * A commit handler rather than core's generic write, and not a stylistic choice: core
 * treats payload keys as literal column names, so `authorizedItems` and `validUntil` were
 * refused as invalid identifiers the moment somebody approved. It also gets the duplicate
 * number check and `ud.created`, which a raw row insert would skip — and a second UD row
 * carrying the same customs number is a bonded-material balance that double-counts.
 */
export async function commitUdFromScan(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { operation: 'insert' | 'update' | 'delete'; targetId: string | null; payload: Record<string, unknown> },
): Promise<{ rowId: string; before: null; after: Record<string, unknown> }> {
  if (input.operation !== 'insert') {
    throw new AppError('validation_failed', 'commercial.errors.ud_draft_insert_only', {
      operation: input.operation,
    })
  }

  const result = await createUdIn(ctx, tx, input.payload)
  return { rowId: result.udId, before: null, after: { udId: result.udId, number: result.number } }
}

/** The creation itself, inside a transaction the caller owns. */
async function createUdIn(
  ctx: AnyCtx,
  tx: TenantDb,
  input: unknown,
): Promise<{ udId: string; number: string }> {
  const payload = createUdPayload.parse(input)

  return (async () => {
    const [existing] = await tx.select({ id: uds.id }).from(uds).where(scoped(uds, ctx, eq(uds.number, payload.number)))
    if (existing) {
      throw new AppError('conflict', 'commercial.errors.ud_number_exists', {
        number: payload.number,
      })
    }

    const [row] = await tx
      .insert(uds)
      .values({
        companyId: ctx.companyId,
        number: payload.number,
        issueDate: payload.issueDate ?? null,
        validUntil: payload.validUntil ?? null,
        authorizedItems: payload.authorizedItems,
        documentId: payload.documentId ?? null,
        status: 'active',
        createdBy: ctx.userId,
      })
      .returning({ id: uds.id })

    if (!row) throw new Error('uds insert returned nothing')

    await emit(ctx, tx, {
      eventName: COMMERCIAL_EVENTS.udCreated,
      payload: { udId: row.id, number: payload.number, items: payload.authorizedItems.length },
      aggregateTable: 'uds',
      aggregateId: row.id,
    })

    return { udId: row.id, number: payload.number }
  })()
}

/**
 * Record a letter of credit (canvas P1: "Record an LC").
 *
 * Opened as `active`, because an LC that has been advised to the factory is already
 * governing what it may ship. `draft` exists for one recorded but not yet advised, and
 * nothing here can set it — a status the recorder chooses is a status that gets chosen
 * wrongly under time pressure.
 *
 * Conflicts are NOT scanned here. `detectLcConflicts` is a pure function over an LC and the
 * orders against it, and at the moment an LC is recorded there are usually none linked yet —
 * a scan would report "no conflicts" on an LC nobody has attached an order to, which is a
 * clean bill of health that means nothing. The register and the nightly countdown do it once
 * the relationship exists.
 */
export async function createLc(
  ctx: RequestCtx,
  input: unknown,
): Promise<{ lcId: string; number: string }> {
  const payload = createLcPayload.parse(input)

  /*
   * The two dates, checked here rather than only by the CHECK constraint behind them.
   *
   * `lcs_expiry_after_latest_shipment` has forbidden this combination since 0008, and the
   * register's own comment reasons that a screen handling it would be unreachable code. That
   * was true of every path that READS an LC and false of the one that creates one: a driver
   * error is not an `AppError`, so the constraint fired as a raw Postgres exception and the
   * person saw React #441 with no clue which field to fix (live test, Phase 3 — an expiry of
   * 5 December typed into a browser reading mm/dd, stored as 12 May).
   *
   * The database keeps the guarantee; this gives it a sentence.
   */
  return withTenantTx(ctx, async (tx) => {
    const { lcId, after } = await writeLc(ctx, tx, payload)

    // CLAUDE.md rule 10 names `lcs` explicitly, and this was the one write that skipped it:
    // a credit could come into existence with an outbox event and no before/after row, so
    // the question "who entered this value, and when" had no answer (audit BE-B5).
    await recordChange(ctx, tx, {
      action: 'insert',
      targetTable: 'lcs',
      targetId: lcId,
      after,
    })

    return { lcId, number: payload.number }
  })
}

/**
 * The credit itself, written inside somebody else's transaction.
 *
 * Two callers with genuinely different surroundings: `createLc`, which opens its own
 * transaction and records its own audit row, and the `lcs` commit handler, which runs inside
 * the approve transaction where core writes the audit row from what the handler returns.
 *
 * Everything that makes an LC valid lives HERE rather than in either caller — the two dates,
 * the unique number — because a drafted credit that skipped those checks would be a credit
 * that a model, not a person, decided was coherent. A draft is reviewed for whether it
 * matches the paper; it is not a second opinion on whether the rules apply.
 */
async function writeLc(
  ctx: AnyCtx,
  tx: TenantDb,
  payload: {
    buyerId: string
    number: string
    value: string
    currency: string
    tolerancePct: string
    issueDate?: string | undefined
    latestShipmentDate?: string | undefined
    expiryDate?: string | undefined
    docsRequired: Record<string, boolean | undefined>
    documentId?: string | undefined
  },
): Promise<{ lcId: string; after: Record<string, unknown> }> {
  /*
   * The two dates, checked here rather than only by the CHECK constraint behind them.
   *
   * `lcs_expiry_after_latest_shipment` has forbidden this combination since 0008, and the
   * register's own comment reasons that a screen handling it would be unreachable code. That
   * was true of every path that READS an LC and false of the one that creates one: a driver
   * error is not an `AppError`, so the constraint fired as a raw Postgres exception and the
   * person saw React #441 with no clue which field to fix (live test, Phase 3 — an expiry of
   * 5 December typed into a browser reading mm/dd, stored as 12 May).
   *
   * The database keeps the guarantee; this gives it a sentence.
   */
  if (
    payload.expiryDate &&
    payload.latestShipmentDate &&
    payload.expiryDate < payload.latestShipmentDate
  ) {
    throw new AppError('validation_failed', 'commercial.errors.lc_expiry_before_shipment', {
      expiry: payload.expiryDate,
      latestShipment: payload.latestShipmentDate,
    })
  }

  const [existing] = await tx
    .select({ id: lcs.id })
    .from(lcs)
    .where(scoped(lcs, ctx, eq(lcs.number, payload.number)))
  if (existing) {
    throw new AppError('conflict', 'commercial.errors.lc_number_exists', {
      number: payload.number,
    })
  }

  const [row] = await tx
    .insert(lcs)
    .values({
      companyId: ctx.companyId,
      buyerId: payload.buyerId,
      number: payload.number,
      value: payload.value,
      currency: payload.currency,
      tolerancePct: payload.tolerancePct,
      issueDate: payload.issueDate ?? null,
      latestShipmentDate: payload.latestShipmentDate ?? null,
      expiryDate: payload.expiryDate ?? null,
      docsRequired: payload.docsRequired,
      status: 'active',
      createdBy: ctx.userId,
    })
    .returning({ id: lcs.id })

  if (!row) throw new Error('lcs insert returned nothing')

  await emit(ctx, tx, {
    eventName: COMMERCIAL_EVENTS.lcCreated,
    payload: { lcId: row.id, number: payload.number, value: payload.value },
    aggregateTable: 'lcs',
    aggregateId: row.id,
  })

  return {
    lcId: row.id,
    after: {
      number: payload.number,
      value: payload.value,
      currency: payload.currency,
      latestShipmentDate: payload.latestShipmentDate ?? null,
      expiryDate: payload.expiryDate ?? null,
    },
  }
}

/**
 * A credit read off a SWIFT message, committed when somebody signs the draft.
 *
 * Called by the `lcs` commit handler in `register.ts`, inside the approve transaction, so
 * the row, its audit entry and the outbox event still commit together. Core writes the audit
 * from the `after` returned here — which is why this does not write one itself.
 */
export async function commitLcFromDraft(
  ctx: AnyCtx,
  tx: TenantDb,
  input: { payload: Record<string, unknown> },
): Promise<{ rowId: string; after: Record<string, unknown> }> {
  // Parsed again at approve, not trusted from insert: a schema that has tightened since the
  // draft was created must reject it now rather than commit stale data (PLAYBOOK §3).
  const payload = lcFromSwiftDraft.parse(input.payload)

  /*
   * The buyer is optional while a model is reading and required to write.
   *
   * `lcFromSwiftDraft` stopped demanding a uuid from the extractor — no page carries one, and
   * asking produced an invention that failed the whole reading. It arrives instead from the
   * intake context picker, merged in at confidence 1. If it is missing by the time somebody
   * approves, the draft is not committable: a credit belonging to nobody cannot be reconciled
   * against a shipment, which is the reason `createLcPayload` requires it.
   */
  if (!payload.buyerId) {
    throw new AppError('validation_failed', 'commercial.errors.lc_draft_no_buyer', {
      number: payload.number,
    })
  }

  const { lcId, after } = await writeLc(ctx, tx, { ...payload, buyerId: payload.buyerId })
  return { rowId: lcId, after }
}
