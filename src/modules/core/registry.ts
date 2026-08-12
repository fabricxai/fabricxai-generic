/**
 * Module registry — the whitelist that makes `pending_changes` safe.
 *
 * A module declares, in its `register.ts`, exactly which tables an AI or junior draft
 * may target and which Zod schema validates each payload. `pending_changes` inserts and
 * approves both resolve through here; a target that is not registered is rejected
 * outright, which is what stops a drafted write from reaching an arbitrary table
 * (CLAUDE.md rule 3).
 */
import type { ZodType } from 'zod'

import type { AnyCtx, Role } from './ctx'
import { isDevReload } from './dev-reload'
import type { RefResolver } from './refs'
import { AppError } from './errors'
import type { TenantDb } from './tenancy'

/**
 * How an approved draft actually becomes a row, when a plain INSERT will not do.
 *
 * Core's generic commit writes one row from the payload, which is right for most targets.
 * It is wrong whenever committing is a domain operation — a breakdown revision has to
 * replace a grid, bump a revision pointer and write an evidence row; a bonded issue has to
 * draw down a UD balance. Those cannot be expressed as an INSERT, and the module that
 * owns the invariant is the only place that should try.
 *
 * The handler receives the approve transaction, so its writes, the audit row and the
 * outbox event still commit together. Returning `before`/`after` lets it describe the
 * change for the audit trail in its own terms rather than as a row diff.
 */
export type PendingCommitHandler = (
  ctx: AnyCtx,
  tx: TenantDb,
  input: {
    operation: 'insert' | 'update' | 'delete'
    targetId: string | null
    payload: Record<string, unknown>
  },
) => Promise<{
  rowId: string
  before?: Record<string, unknown> | null
  after?: Record<string, unknown> | null
}>

export interface ModuleDefinition {
  /** Folder name under src/modules, e.g. 'orders'. */
  id: string
  /** Tables this module may receive drafts for. Nothing else is writable via drafts. */
  pendingTargets: readonly string[]
  /**
   * zodSchemaKey → schema. The key is stored on the draft row so approve re-validates
   * with a named schema rather than re-deriving one from the payload shape.
   */
  zodMap: Readonly<Record<string, ZodType>>
  /** Fallback approver roles when no approval_rules row matches. */
  approvalDefaults: { requiredRoles: readonly Role[]; approvalsRequired?: number }
  /** MARBIM tool pack: read tools + draft tools only. Draft tools emit pending rows. */
  toolPack?: unknown
  /** BullMQ processors owned by this module. */
  jobs?: Readonly<Record<string, unknown>>
  /**
   * Per-target overrides for how an approved draft is committed. Any target without one
   * gets core's generic single-row write.
   */
  commitHandlers?: Readonly<Record<string, PendingCommitHandler>>
  /**
   * How this module turns a human reference into a row id — `{ buyer: … }`, keyed by the
   * vocabulary a tool asks in rather than by table name.
   *
   * Declared here beside `pendingTargets` and `toolPack` because it is the same kind of
   * statement: what this module lets the rest of the system reach, and by which name. The
   * resolver runs through the module's own `queries.ts` (rule 11), so a buyer code is still
   * read by the module that owns buyers.
   *
   * See `refs.ts` for why this exists: forty-three tool inputs required a uuid, and a uuid
   * is the one identifier no screen, document or export in this product ever shows.
   */
  refResolvers?: Readonly<Record<string, RefResolver>>
  /**
   * Versioned prompt fragment giving MARBIM this department's craft. Teaches WHEN to
   * call a computation and how to narrate the result — the computation itself stays in
   * service.ts (CLAUDE.md, module folder contract).
   */
  domainPrimer?: { version: string; text: string }
}

const registry = new Map<string, ModuleDefinition>()

export function registerModule(definition: ModuleDefinition): ModuleDefinition {
  const existing = registry.get(definition.id)
  if (existing && existing !== definition) {
    // Two different modules claiming one id is a permanent bug. A dev server re-evaluating
    // one module is not — see `dev-reload.ts` for why this carve-out exists at all.
    if (!isDevReload()) {
      throw new Error(`module "${definition.id}" is already registered`)
    }
    // Dropped BEFORE the ownership scan below, or the module's own previous entry is found
    // owning its own pending targets and the re-registration fails as a rule-11 violation.
    registry.delete(definition.id)
  }

  for (const target of definition.pendingTargets) {
    // Same shape the pending_changes CHECK constraint enforces in the database.
    if (!/^[a-z_][a-z0-9_]*$/.test(target)) {
      throw new Error(`module "${definition.id}": "${target}" is not a valid table name`)
    }
    /*
     * Somebody ELSE owning it. A module must not collide with its own previous entry —
     * re-registering the same definition (two import paths reaching one module, or a dev
     * server's hot reload) would otherwise find itself in the map and report a rule-11
     * violation against itself, which reads as a real architectural error and is not one.
     */
    const owner = [...registry.values()].find(
      (m) => m.id !== definition.id && m.pendingTargets.includes(target),
    )
    if (owner) {
      // One writer module per table (CLAUDE.md rule 11) — two modules drafting into the
      // same table is the bug that makes "who wrote this row?" unanswerable.
      throw new Error(
        `table "${target}" is already a pending target of module "${owner.id}"; ` +
          `read it through that module's queries.ts instead`,
      )
    }
  }

  registry.set(definition.id, definition)
  return definition
}

export const getModule = (id: string): ModuleDefinition | undefined => registry.get(id)

/**
 * The module's own commit logic for a target, if it declared one. Resolved at approve
 * time rather than at insert, so a module can add a handler later without invalidating
 * drafts already waiting in the inbox.
 */
export const getCommitHandler = (
  moduleId: string,
  targetTable: string,
): PendingCommitHandler | undefined => registry.get(moduleId)?.commitHandlers?.[targetTable]
export const listModules = (): readonly ModuleDefinition[] => [...registry.values()]

/**
 * Resolve the schema for a draft, or throw. Called at insert AND at approve — a schema
 * that has tightened since the draft was created must reject it at approve time rather
 * than commit stale data (PLAYBOOK §3, the X.1 re-validation test).
 */
export function resolvePendingSchema(moduleId: string, targetTable: string, zodSchemaKey: string) {
  const definition = registry.get(moduleId)
  if (!definition) {
    throw new AppError('validation_failed', 'errors.unknown_module', { moduleId })
  }
  if (!definition.pendingTargets.includes(targetTable)) {
    throw new AppError('forbidden', 'errors.target_not_registered', { moduleId, targetTable })
  }
  const schema = definition.zodMap[zodSchemaKey]
  if (!schema) {
    throw new AppError('validation_failed', 'errors.unknown_schema', { moduleId, zodSchemaKey })
  }
  return schema
}

/**
 * The schema behind a document READING, which is not a write.
 *
 * `resolvePendingSchema` refuses a target that is not a registered pending target, and that
 * gate is exactly right for what it governs: rule 3 says an AI writes only through
 * `pending_changes`, into a table its module has declared. It has nothing to say about
 * reading.
 *
 * Filling a form in front of the person who will then press save writes nothing at all — the
 * writer is the human, through the module's own action, with its own role wall. Requiring a
 * `pendingTarget` for that would mean declaring a table proposable in order to be allowed to
 * read a delivery note into a form, which then demands a commit handler for a draft nobody
 * will ever raise. A receipt is not a thing to approve after the fact: the goods are on the
 * floor or they are not, and the person standing next to them is the one who knows.
 *
 * The module must still NAME the schema. What a reading is parsed into stays the module's
 * decision, not the reader's.
 */
export function resolveReadSchema(moduleId: string, zodSchemaKey: string) {
  const definition = registry.get(moduleId)
  if (!definition) {
    throw new AppError('validation_failed', 'errors.unknown_module', { moduleId })
  }
  const schema = definition.zodMap[zodSchemaKey]
  if (!schema) {
    throw new AppError('validation_failed', 'errors.unknown_schema', { moduleId, zodSchemaKey })
  }
  return schema
}

/** Test-only: the registry is module-global, so suites must be able to reset it. */
export const __resetRegistry = (): void => registry.clear()
