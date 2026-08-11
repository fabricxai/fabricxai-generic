/**
 * Turning what a person can SEE into what the system stores.
 *
 * ## The gap this closes
 *
 * Every record here has two identifiers. A `uuid`, which is the primary key, the foreign key
 * every other table joins on, and correct — and which appears in no screen, no document and
 * no export. And a human code — `B-04501`, `LAY-31`, `ST-2610-A`, `SMP-2044-PP`, `L1` — which
 * is printed on the row, said out loud on the floor, and unique per company by index.
 *
 * MARBIM's read tools were given the first and not the second. Forty-three tool inputs across
 * seventeen modules require a uuid, so the copilot could only be asked about a specific record
 * using the one identifier the product deliberately never shows anybody. Asked about
 * "B-04501" — a code visible in the table beside the chat panel — the model answered from its
 * primers and said, correctly, that it had no way to look it up. A guardrail doing its job on
 * top of a door that was never built.
 *
 * ## How it works
 *
 * A module declares, in its `register.ts`, how to turn a reference of a kind IT owns into an
 * id — resolving through its own `queries.ts`, never another module's tables (rule 11). Tools
 * then take `entityRef` instead of a uuid and call `resolveRef` in their executor.
 *
 * A uuid still passes straight through. The screens hand ids to the copilot when they have
 * them (a scoped conversation on an order page knows its own id), and a resolver that refused
 * a uuid would break that in order to fix chat.
 *
 * ## What it deliberately does not do
 *
 * It does not guess. An unresolvable code is a typed refusal naming the kind and the
 * reference, not a fuzzy match on the nearest row: "did you mean B-04502" is the kind of
 * helpfulness that eventually books a shipment against the wrong buyer. Fuzzy search belongs
 * in a `find` tool a person reads the results of, not in an id lookup a tool acts on.
 *
 * It also does not check that a uuid EXISTS. The query the tool is about to run is scoped to
 * the tenant and will return nothing for an id from another company — which is the same
 * answer, arrived at without a second round trip.
 */
import type { AnyCtx } from './ctx'
import { AppError } from './errors'
import { listModules } from './registry'

/**
 * A reference as a person would write it: a uuid, or the code printed on the row.
 *
 * Bounded rather than open — the longest human identifier in this system is a cost-sheet
 * style version, and a tool input that accepts four kilobytes of "reference" is an input the
 * model will eventually fill with a sentence.
 */
export const ENTITY_REF_MAX = 80

/** Resolve one kind of reference. Returns `null` when this company has no such row. */
export type RefResolver = (ctx: AnyCtx, ref: string) => Promise<string | null>

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-9a-f][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Whether this is already an id, in which case nothing needs resolving. */
export const isUuid = (value: string): boolean => UUID.test(value.trim())

/**
 * The id behind a reference, or a refusal that says which reference failed.
 *
 * `kind` is the vocabulary a module registers under — `buyer`, `order`, `line`. It is not a
 * table name: two modules may read the same row by different names, and the tool asking is
 * describing what it wants, not where it lives.
 */
export async function resolveRef(ctx: AnyCtx, kind: string, ref: string): Promise<string> {
  const trimmed = ref.trim()

  if (trimmed === '') {
    throw new AppError('validation_failed', 'errors.reference_empty', { kind })
  }
  if (isUuid(trimmed)) return trimmed

  const resolver = resolverFor(kind)
  if (!resolver) {
    /*
     * A tool asked for a kind nobody owns. That is a wiring mistake rather than a bad
     * reference, and it fails loudly here instead of silently answering "not found" for
     * every value a person could possibly type.
     */
    throw new AppError('validation_failed', 'errors.reference_kind_unknown', { kind })
  }

  const id = await resolver(ctx, trimmed)
  if (id === null) {
    throw new AppError('validation_failed', 'errors.reference_not_found', { kind, ref: trimmed })
  }
  return id
}

/**
 * The module that owns this kind of reference.
 *
 * Resolved from the registry on each call rather than cached: modules register at import,
 * a dev server re-evaluates them, and a map captured once would go stale on the first hot
 * reload — the same trap the registries themselves had.
 */
function resolverFor(kind: string): RefResolver | undefined {
  for (const definition of listModules()) {
    const resolver = definition.refResolvers?.[kind]
    if (resolver) return resolver
  }
  return undefined
}

/** Every reference kind the loaded modules can resolve — for tests and for the primers. */
export function knownRefKinds(): string[] {
  const kinds = new Set<string>()
  for (const definition of listModules()) {
    for (const kind of Object.keys(definition.refResolvers ?? {})) kinds.add(kind)
  }
  return [...kinds].sort()
}
