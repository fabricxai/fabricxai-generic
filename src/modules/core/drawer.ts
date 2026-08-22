/**
 * The entity drawer — peek at any referenced thing without leaving the page
 * (specs/order-centric-core.md §3).
 *
 * The product promise is "everything extracted and shown in the UI, side drawers where
 * necessary", and until now every drawer was bespoke. This is the server half of the one
 * primitive: a module declares, in its `register.ts`, how a kind IT owns becomes a peek —
 * the same registration philosophy as `pendingTargets`, `refResolvers` and `toolPack`,
 * and it composes with both existing seams:
 *
 *  - the REFERENCE is resolved by `core/refs`, so a peek accepts the code a person can
 *    actually see (`PO-BF-2044`) as readily as the uuid a screen already holds;
 *  - the MODULE must be active for the tenant (spec §1) — a switched-off module's rows
 *    are not peekable, by the same wall its screens and actions refuse at.
 *
 * ## The payload is data, not a component
 *
 * A provider returns a `DrawerPeek` — title, facts, links — and ONE client component in
 * the shell renders every kind. Deliberate, twice over: `register.ts` files import
 * schema and db code, so a React renderer registered there would drag the server into
 * the client bundle; and a declarative payload keeps the drawer's promise checkable —
 * a provider CANNOT ship a bespoke screen in a side panel, which is how "peek" stays
 * peek. Fact labels are i18n keys; values arrive formatted by the owning module, which
 * knows its own currencies and dates.
 *
 * Data enters through the owning module's `queries.ts` (rule 11) — a drawer never gets
 * private queries. Draft-review and compose are the two shapes this deliberately does
 * not cover yet; they extend `EntityDrawer` when their slices land, which is why the
 * registration is an object and not a bare function.
 */
import type { AnyCtx, Role } from './ctx'
import { hasRole } from './ctx'
import { activeModuleIds } from './activation'
import { AppError } from './errors'
import { resolveRef } from './refs'
import { listModules } from './registry'

/** One labelled value in the peek. The label is an `ui.*` key; the value is formatted. */
export interface DrawerFact {
  labelKey: string
  value: string
  /** Render in the mono face — codes, amounts, dates. */
  mono?: boolean
}

/** A reference the reader may peek onward to — the drawer's one-level stack. */
export interface DrawerRelated {
  kind: string
  reference: string
  /** What the chip says — a code or a name, already in the reader's terms. */
  label: string
}

export interface DrawerPeek {
  kind: string
  id: string
  /** The identity line — the human code or name a person would say out loud. */
  title: string
  /** Secondary line under the title. Pre-formatted by the module. */
  subtitle?: string
  status?: { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' }
  facts: readonly DrawerFact[]
  /** The full screen, when one exists — "open" in the drawer footer. */
  href?: string
  related?: readonly DrawerRelated[]
}

/** Load one peek. `null` means this tenant has no such row — surfaced as not_found. */
export type DrawerProvider = (ctx: AnyCtx, id: string) => Promise<DrawerPeek | null>

/**
 * What a module registers per kind. An object rather than a bare function so the
 * draft-review and compose shapes (spec §3) extend it without reshaping every module.
 */
export interface EntityDrawer {
  /**
   * Roles that may peek this kind; owner and admin always may. Absent means every
   * signed-in role — right for kinds whose screens are broadly readable, wrong for
   * anything payroll-shaped, which must say so here.
   */
  roles?: readonly Role[]
  peek: DrawerProvider
}

/**
 * Kinds owned by core infrastructure rather than any module.
 *
 * Core is not a module — it cannot register, and its tables (documents, notifications)
 * have no activation switch. The one entry today is `document`: files are filed by
 * every module and read through `core/documents`, so the peek lives beside that code.
 */
const CORE_DRAWERS: Readonly<Record<string, EntityDrawer>> = {
  document: {
    peek: async (ctx, id) => {
      const { documentMeta } = await import('./documents')
      let meta
      try {
        meta = await documentMeta(ctx, id)
      } catch (error) {
        // Another tenant's id and a mistyped one are the same answer, on purpose.
        if (error instanceof AppError && error.code === 'not_found') return null
        throw error
      }
      return {
        kind: 'document',
        id,
        title: meta.filename,
        subtitle: meta.mimeType,
        facts: [
          { labelKey: 'ui.peek.doc_size', value: formatBytes(meta.sizeBytes), mono: true },
          { labelKey: 'ui.peek.doc_status', value: meta.status },
        ],
      }
    },
  },
}

/** `183_402` → `179.1 KB` — the one formatting core owes, since documents are core's. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** The module owning a drawer kind, or undefined. Scanned per call — see refs.ts on why. */
function moduleDrawerFor(kind: string): { moduleId: string; drawer: EntityDrawer } | undefined {
  for (const definition of listModules()) {
    const drawer = definition.drawers?.[kind]
    if (drawer) return { moduleId: definition.id, drawer }
  }
  return undefined
}

/**
 * The one door every peek goes through.
 *
 * Walls in order: the kind must be owned (a typo fails loudly, not as "not found" for
 * every reference forever — same reasoning as `resolveRef`); the owning module must be
 * active for THIS tenant; the caller's roles must be on the kind's list when it has one;
 * the reference resolves through `core/refs`; and the provider's own query is
 * tenant-scoped, so another company's id ends as not_found rather than a row.
 */
export async function peekEntity(
  ctx: AnyCtx,
  kind: string,
  reference: string,
): Promise<DrawerPeek> {
  const core = CORE_DRAWERS[kind]
  const owned = core ? undefined : moduleDrawerFor(kind)
  if (!core && !owned) {
    throw new AppError('validation_failed', 'errors.drawer_kind_unknown', { kind })
  }

  if (owned && !(await activeModuleIds(ctx)).has(owned.moduleId)) {
    throw new AppError('forbidden', 'errors.module_inactive', { moduleId: owned.moduleId })
  }

  const drawer = core ?? owned!.drawer
  if (drawer.roles && !hasRole(ctx, ...drawer.roles, 'owner', 'admin')) {
    throw new AppError('forbidden', 'errors.forbidden', { required: drawer.roles })
  }

  const id = await resolveRef(ctx, kind, reference)
  const peek = await drawer.peek(ctx, id)
  if (!peek) {
    throw new AppError('not_found', 'errors.reference_not_found', { kind, ref: reference })
  }
  return peek
}

/** Every peekable kind — core's and the loaded modules' — for tests and the primers. */
export function knownDrawerKinds(): string[] {
  const kinds = new Set<string>(Object.keys(CORE_DRAWERS))
  for (const definition of listModules()) {
    for (const kind of Object.keys(definition.drawers ?? {})) kinds.add(kind)
  }
  return [...kinds].sort()
}
