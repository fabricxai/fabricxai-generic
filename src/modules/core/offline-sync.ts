/**
 * Offline batch sync (architecture §3, dev-plan §2.2.6).
 *
 * ONE endpoint for every floor-facing write — store, cutting, production, sampling, QC
 * inline. A tablet on a bad network queues locally and replays the whole batch when it
 * reconnects, sometimes more than once. Each logical write carries a device-generated
 * `offlineKey`; the unique index on `offline_keys` turns a replay into a no-op that
 * returns the ORIGINAL result, so the device reconciles against what actually landed.
 *
 * Two decisions worth stating:
 *
 * 1. **Rows succeed or fail independently.** One bad row in a batch of fifty must not
 *    discard the other forty-nine — the operator has gone home and the data is on a
 *    device that may not come back. Each row gets its own transaction and its own result.
 *
 * 2. **A rejected row is remembered as rejected.** Replaying it returns the same
 *    rejection rather than trying again, so a permanently-invalid row cannot loop
 *    forever, and the device can show the operator exactly what was refused.
 */
import { and, desc, eq, gte, sql } from 'drizzle-orm'

import { FACTORY_TIMEZONE } from '@/lib/dates'
import { offlineKeys } from '@/db/schema/core'

import { isSystemCtx, type AnyCtx, type Role } from './ctx'
import { isDevReload } from './dev-reload'
import { AppError, isAppError } from './errors'
import { scoped } from './scoped'
import { withTenantRead, withTenantTx } from './tenancy'

export interface SyncRow {
  /** Device-generated idempotency key. Stable across replays of the same logical write. */
  offlineKey: string
  moduleId: string
  operation: string
  payload: Record<string, unknown>
  /** Device clock at capture; the server keeps its own timestamps but records this. */
  clientRecordedAt?: string
}

export type SyncRowResult =
  | { offlineKey: string; status: 'applied'; rowId: string }
  | { offlineKey: string; status: 'duplicate'; rowId: string | null }
  | {
      offlineKey: string
      status: 'rejected'
      errorKey: string
      details?: Record<string, unknown>
    }

/**
 * A module's handler for one offline operation. Receives the caller's already-scoped
 * transaction so its write, the `offline_keys` row, and any outbox event all commit
 * together — that atomicity is what makes the idempotency claim true.
 *
 * It gets the whole ROW, not just the payload: the `offlineKey` and the device's own
 * timestamp belong on the business record too. A storekeeper reconciling a tablet against
 * the system looks at the issue, not at an internal ledger table, so the key has to be
 * visible where they are looking.
 */
export type SyncHandler = (
  ctx: AnyCtx,
  tx: Parameters<Parameters<typeof withTenantTx>[1]>[0],
  row: SyncRow,
) => Promise<{ rowId: string }>

/** Roles that may post ANY floor operation — supervision, not a department. */
const SUPERVISORY_ROLES: readonly Role[] = ['owner', 'admin']

const handlers = new Map<string, { roles: readonly Role[]; handler: SyncHandler }>()

const handlerKey = (moduleId: string, operation: string) => `${moduleId}:${operation}`

/**
 * Registered from each module's `register.ts`. Nothing else is syncable.
 *
 * `roles` is REQUIRED (audit BE-H4): /api/sync is the one door for every floor write,
 * and before this parameter existed any authenticated member of the company — a payroll
 * clerk, a viewer — could receive GRNs, issue bonded stock against a UD, or record the
 * buyer feedback that releases the PP-approval gate for cutting. A handler that truly
 * wants "anyone in the company" must say so in its registration, visibly.
 */
export function registerSyncHandler(
  moduleId: string,
  operation: string,
  opts: { roles: readonly Role[] },
  handler: SyncHandler,
): void {
  const key = handlerKey(moduleId, operation)
  // Two modules claiming one floor operation is a permanent bug — /api/sync is the single
  // door every offline write comes through, and the handler decides which roles may use it.
  // A dev server re-evaluating one `register.ts` is not that; see `dev-reload.ts`.
  if (handlers.has(key) && !isDevReload()) {
    throw new Error(`sync handler "${key}" is already registered`)
  }
  if (opts.roles.length === 0) {
    throw new Error(`sync handler "${key}" registered with no roles — every door needs a keyholder`)
  }
  handlers.set(key, { roles: opts.roles, handler })
}

export const listSyncHandlers = (): readonly string[] => [...handlers.keys()]
/** Test-only: the map is module-global, so suites must be able to reset it. */
export const __resetSyncHandlers = (): void => handlers.clear()

/** Bounded so one device cannot post an unbounded batch. Fifty lines is a real shift. */
export const MAX_BATCH_ROWS = 200

export async function syncBatch(
  ctx: AnyCtx,
  rows: readonly SyncRow[],
): Promise<SyncRowResult[]> {
  if (rows.length > MAX_BATCH_ROWS) {
    throw new AppError('validation_failed', 'errors.sync_batch_too_large', {
      rows: rows.length,
      max: MAX_BATCH_ROWS,
    })
  }

  const results: SyncRowResult[] = []
  for (const row of rows) {
    results.push(await applyRow(ctx, row))
  }
  return results
}

async function applyRow(ctx: AnyCtx, row: SyncRow): Promise<SyncRowResult> {
  const registered = handlers.get(handlerKey(row.moduleId, row.operation))

  if (!registered) {
    return {
      offlineKey: row.offlineKey,
      status: 'rejected',
      errorKey: 'errors.sync_operation_unknown',
      details: { moduleId: row.moduleId, operation: row.operation },
    }
  }

  // Role check BEFORE the offline key is claimed, and the refusal is NOT remembered as
  // terminal: a role denial is a verdict on the caller, not on the row. The same row
  // replayed after the operator's roles are fixed must apply, not echo an old refusal.
  const allowed =
    isSystemCtx(ctx) ||
    [...registered.roles, ...SUPERVISORY_ROLES].some((role) => ctx.roles.includes(role))
  if (!allowed) {
    return {
      offlineKey: row.offlineKey,
      status: 'rejected',
      errorKey: 'errors.sync_role_forbidden',
      details: { moduleId: row.moduleId, operation: row.operation, required: registered.roles },
    }
  }

  const { handler } = registered

  try {
    return await withTenantTx(ctx, async (tx): Promise<SyncRowResult> => {
      // Claim the key FIRST. If this insert conflicts, the write already happened — on a
      // previous request, or on a concurrent one from the same device holding the row
      // lock. Either way we must not run the handler again.
      const claimed = await tx
        .insert(offlineKeys)
        .values({
          companyId: ctx.companyId,
          offlineKey: row.offlineKey,
          moduleId: row.moduleId,
          operation: row.operation,
          status: 'applied',
          clientRecordedAt: row.clientRecordedAt ? new Date(row.clientRecordedAt) : null,
        })
        .onConflictDoNothing()
        .returning({ id: offlineKeys.id })

      if (claimed.length === 0) {
        const [existing] = await tx
          .select()
          .from(offlineKeys)
          .where(
            and(
              eq(offlineKeys.companyId, ctx.companyId),
              eq(offlineKeys.offlineKey, row.offlineKey),
            ),
          )

        // A previously rejected row stays rejected — replaying it must not retry it.
        if (existing?.status === 'rejected') {
          return {
            offlineKey: row.offlineKey,
            status: 'rejected',
            errorKey: String(existing.error?.messageKey ?? 'errors.sync_rejected'),
            details: existing.error ?? undefined,
          }
        }

        return {
          offlineKey: row.offlineKey,
          status: 'duplicate',
          rowId: existing?.resultRowId ?? null,
        }
      }

      const { rowId } = await handler(ctx, tx, row)

      await tx
        .update(offlineKeys)
        .set({ resultRowId: rowId })
        .where(scoped(offlineKeys, ctx, eq(offlineKeys.id, claimed[0]!.id)))

      return { offlineKey: row.offlineKey, status: 'applied', rowId }
    })
  } catch (error) {
    // The handler threw, so its transaction rolled back — including the key claim. Record
    // the rejection in its OWN transaction so the device gets a stable answer on replay
    // instead of retrying a write that will never succeed.
    const appError = isAppError(error)
      ? error
      : new AppError('internal', 'errors.sync_failed', {}, String(error))

    await withTenantTx(ctx, (tx) =>
      tx
        .insert(offlineKeys)
        .values({
          companyId: ctx.companyId,
          offlineKey: row.offlineKey,
          moduleId: row.moduleId,
          operation: row.operation,
          status: 'rejected',
          error: appError.toJSON(),
          // Kept only here. A refusal is somebody's work disappearing — a challan counted
          // at the delivery bay, a cut report taken off the table — and the reason alone
          // says a GRN was lost without saying what was on it. `refusedRows` is what turns
          // that into something a supervisor can act on.
          payload: row.payload,
          clientRecordedAt: row.clientRecordedAt ? new Date(row.clientRecordedAt) : null,
        })
        .onConflictDoNothing(),
    )

    return {
      offlineKey: row.offlineKey,
      status: 'rejected',
      errorKey: appError.messageKey,
      details: appError.details,
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The reconciliation report (plan 4.5, audit FE-M6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the server refused, and what it was.
 *
 * A refused row is the one outcome of this endpoint that loses work. Applied and duplicate
 * both end with the write in the database; refused ends with it on a tablet, behind a
 * "Dismiss" link — and dismissing DELETES it. So the only record that a challan was counted
 * and never received was a badge on one device, until somebody tapped it away.
 *
 * This reads the record the server already kept. `offline_keys` has held every refusal since
 * the endpoint was written, with its reason, its module, its operation and the device's own
 * timestamp; nothing read it. The payload is the part that was missing, and it is the part
 * that decides whether a supervisor can re-enter the work or only mourn it.
 */
export interface RefusedRow {
  offlineKey: string
  moduleId: string
  operation: string
  /** The refusal, as the module threw it: `{ messageKey, details, … }`. */
  error: Record<string, unknown> | null
  /** What the device was trying to write. Null for refusals recorded before plan 4.5. */
  payload: Record<string, unknown> | null
  /**
   * The device's clock at capture, and the server's at refusal.
   *
   * Both, because they can be days apart: a tablet that spent a weekend offline captured on
   * Friday and was refused on Monday. A report that showed only one of them would file the
   * lost work against the wrong day, and the day is how somebody finds what is missing.
   */
  capturedAt: Date | null
  refusedAt: Date
}

export async function refusedRows(
  ctx: AnyCtx,
  input: { since: Date; limit?: number } ,
): Promise<RefusedRow[]> {
  return withTenantRead(ctx, async (tx) => {
    const rows = await tx
      .select({
        offlineKey: offlineKeys.offlineKey,
        moduleId: offlineKeys.moduleId,
        operation: offlineKeys.operation,
        error: offlineKeys.error,
        payload: offlineKeys.payload,
        capturedAt: offlineKeys.clientRecordedAt,
        refusedAt: offlineKeys.createdAt,
      })
      .from(offlineKeys)
      .where(
        and(
          // Wall 1. RLS is the second (CLAUDE.md rule 2).
          eq(offlineKeys.companyId, ctx.companyId),
          eq(offlineKeys.status, 'rejected'),
          gte(offlineKeys.createdAt, input.since),
        ),
      )
      .orderBy(desc(offlineKeys.createdAt))
      .limit(input.limit ?? 200)

    return rows
  })
}

/** One day's refusals for one handler — the shape the report groups by. */
export interface RefusedBucket {
  day: string
  moduleId: string
  operation: string
  refused: number
  /** The distinct reasons behind that count, so a spike is readable without expanding it. */
  reasons: string[]
}

/**
 * Refusals per day per handler.
 *
 * Grouped on the SERVER's day rather than the device's, because that is the day the work
 * was actually lost — and because a tablet with a wrong clock would otherwise scatter its
 * refusals across a month. The device's own timestamp is on each row underneath.
 *
 * Counted per handler rather than per module: "store refused 14" is a number, and "store /
 * receive_grn refused 14, all of them ud_balance.insufficient" is a morning's work with a
 * cause attached.
 */
export async function refusedSummary(
  ctx: AnyCtx,
  input: { since: Date },
): Promise<RefusedBucket[]> {
  /*
   * Written as one SQL statement rather than through the query builder.
   *
   * The grouping key is `to_char(created_at at time zone …)`, and Postgres requires the
   * GROUP BY expression to be textually the same as the one in the SELECT. The builder
   * renders the column qualified in one place and bare in the other, which is close enough
   * to read and not close enough for Postgres — it answers "created_at must appear in the
   * GROUP BY clause" about a query that groups by it.
   */
  return withTenantRead(ctx, async (tx) => {
    const result = await tx.execute<{
      day: string
      module_id: string
      operation: string
      refused: string
      reasons: string[]
    }>(sql`
      select
        to_char(created_at at time zone ${FACTORY_TIMEZONE}::text, 'YYYY-MM-DD') as day,
        module_id,
        operation,
        count(*)::text as refused,
        array_agg(distinct coalesce(error ->> 'messageKey', 'errors.unknown')) as reasons
      from offline_keys
      where company_id = ${ctx.companyId}
        and status = 'rejected'
        and created_at >= ${input.since.toISOString()}::timestamptz
      group by 1, module_id, operation
      order by 1 desc, module_id, operation
    `)

    const rows = Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])

    return (rows as { day: string; module_id: string; operation: string; refused: string; reasons: string[] }[]).map(
      (row) => ({
        day: row.day,
        moduleId: row.module_id,
        operation: row.operation,
        refused: Number(row.refused),
        reasons: row.reasons,
      }),
    )
  })
}
