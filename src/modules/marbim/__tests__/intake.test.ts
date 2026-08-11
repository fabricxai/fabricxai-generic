/**
 * The intake list, checked for the one thing `assertIntakeKinds` cannot see.
 *
 * `assertIntakeKinds` proves a kind names a real module, a whitelisted target and a schema
 * that exists. All three passed for `supplier_quote`, and it was still impossible to
 * complete: `supplierQuotePayload` requires `purchaseRequisitionId`, `supplierId` and a
 * per-line `itemId`, all UUIDs. **No document on earth contains a UUID.** A supplier's quote
 * names "Meghna Knit Composite Ltd"; the id that stands for them exists only inside this
 * system. So the extraction ran, produced what the document actually said, and was rejected
 * by zod — and would be for every document, from every extractor, forever.
 *
 * That is the failure this file exists to catch. It is invisible in review (each piece is
 * correct), invisible at boot, and shows up as one person watching a draft never arrive.
 *
 * The rule: a kind is only offerable if a person reading the document could supply every
 * required field. A required UUID is a foreign key, and a foreign key is something the
 * system knows and the paper does not.
 */
// First, and before the registry. No database is touched here — this is a pure assertion
// about schema shapes — but loading every module's `register.ts` pulls in the db client,
// which validates the environment at import. Without this the suite fails on nine missing
// variables it never uses.
import 'dotenv/config'

import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'

import '@/modules/registry'
import { getCommitHandler, resolvePendingSchema } from '@/modules/core/registry'
import {
  INTAKE_KINDS,
  assertIntakeKinds,
  intakeKindsFor,
  mayFileKind,
} from '@/modules/marbim/intake'

/**
 * Required UUID-shaped fields, by path.
 *
 * Optional and defaulted fields are skipped: an extractor omitting them is fine, and a
 * `documentId` the caller supplies is not something the extractor was asked to find.
 */
function requiredUuidPaths(schema: ZodType, path = ''): string[] {
  const type = (schema as unknown as { def?: { type?: string } }).def?.type

  if (type === 'object') {
    const shape = (schema as unknown as { shape: Record<string, ZodType> }).shape
    return Object.entries(shape).flatMap(([key, value]) =>
      requiredUuidPaths(value, path ? `${path}.${key}` : key),
    )
  }

  if (type === 'array') {
    const element = (schema as unknown as { element: ZodType }).element
    return requiredUuidPaths(element, `${path}[]`)
  }

  // Anything the caller may leave out is not a field the document has to carry.
  if (type === 'optional' || type === 'nullable' || type === 'default' || type === 'nullish') {
    return []
  }

  if (type === 'string') {
    // Both spellings, because zod 4 stores them differently and the modules use both.
    // `z.uuid()` puts the format on the def; `z.string().uuid()` appends a check. Reading
    // only the second missed `orderFromPoDraft.buyerId` entirely — a guard with a blind
    // spot is worse than none, since it certifies the thing it cannot see.
    const def = (schema as unknown as { def: { format?: string; checks?: { _zod?: { def?: { format?: string } } }[] } }).def
    const isUuid =
      def.format === 'uuid' ||
      (def.checks ?? []).some((check) => check?._zod?.def?.format === 'uuid')
    return isUuid ? [path] : []
  }

  return []
}

describe('MARBIM intake kinds', () => {
  it('every kind names a registered module, target and schema', () => {
    expect(() => assertIntakeKinds()).not.toThrow()
  })

  it.each(INTAKE_KINDS.map((kind) => [kind.id, kind] as const))(
    '%s can actually be completed from a document',
    (_id, kind) => {
      const schema = resolvePendingSchema(kind.moduleId, kind.targetTable, kind.zodSchemaKey)

      // A declared context field is an id the PERSON picks, so the document not carrying it
      // is fine. Anything left over is a field nobody can supply.
      const supplied = new Set((kind.context ?? []).map((field) => field.field))
      const impossible = requiredUuidPaths(schema as ZodType).filter((path) => !supplied.has(path))

      // The message names the fields, because the fix is one of three things: declare a
      // context field, give the module a document-shaped schema that resolves names to ids
      // at commit, or drop the kind.
      expect(
        impossible,
        `intake kind "${kind.id}" requires ${impossible.join(', ')} — UUIDs a document cannot contain and no context field supplies, so no extraction can ever satisfy it`,
      ).toEqual([])
    },
  )

  /**
   * The third layer of the same disease, and the one that cost the most to find.
   *
   * A kind can name a registered target, be completable from a document, and still produce
   * a draft nobody can approve. Without a commit handler, core writes the row generically —
   * and it treats payload KEYS as literal column names, refusing anything that is not a
   * bare lowercase identifier. Every zod schema in this repo names fields in camelCase, so
   * `poNumbers` was rejected as an invalid identifier at the moment a person clicked
   * Approve, after the upload, the extraction and the wait.
   *
   * So: any target whose schema has a camelCase field needs its module to own the commit.
   */
  it.each(INTAKE_KINDS.map((kind) => [kind.id, kind] as const))(
    '%s produces a draft that can actually be committed',
    (_id, kind) => {
      const schema = resolvePendingSchema(kind.moduleId, kind.targetTable, kind.zodSchemaKey)
      const fields = Object.keys(
        (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {},
      )

      const notColumnNames = fields.filter((field) => !/^[a-z_][a-z0-9_]*$/.test(field))
      if (notColumnNames.length === 0) return

      expect(
        getCommitHandler(kind.moduleId, kind.targetTable),
        `intake kind "${kind.id}" drafts ${notColumnNames.join(', ')}, which core's generic write refuses as invalid identifiers — ${kind.moduleId} must register a commit handler for "${kind.targetTable}"`,
      ).toBeTypeOf('function')
    },
  )

  it('every declared context field names a real field of its target schema', () => {
    // A typo here fails in the worst possible way: the picker collects a value, the merge
    // adds a key the schema does not know, and zod rejects the whole draft as invalid —
    // while the required id it was meant to fill is still missing.
    for (const kind of INTAKE_KINDS) {
      const schema = resolvePendingSchema(kind.moduleId, kind.targetTable, kind.zodSchemaKey)
      const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape ?? {}

      for (const field of kind.context ?? []) {
        expect(
          Object.keys(shape),
          `intake kind "${kind.id}" supplies context for "${field.field}", which is not a field of ${kind.zodSchemaKey}`,
        ).toContain(field.field)
      }
    }
  })
})

/**
 * Whose desk each document belongs to.
 *
 * Every kind used to be offered to every role with intake rights, so a merchandiser could
 * file a wage gazette into payroll's approve inbox — a department's ledger drafted by
 * somebody with no standing in it. The chips and the wall are built from one list here so
 * they cannot drift: what a person is shown is exactly what they may queue.
 */
describe('a kind belongs to a desk', () => {
  it('every kind names at least one keyholder', () => {
    // The same rule sync handlers hold to. A kind with no roles is a door anyone with
    // intake rights can open, which is the state this replaced.
    for (const kind of INTAKE_KINDS) {
      expect(kind.roles.length, `${kind.id} has no roles`).toBeGreaterThan(0)
    }
  })

  it('shows a merchandiser their own documents and not another desk’s', () => {
    const ids = intakeKindsFor(['merchandiser']).map((k) => k.id)

    expect(ids).toContain('buyer_enquiry')
    expect(ids).toContain('buyer_po')
    expect(ids).toContain('tech_pack')
    expect(ids).not.toContain('wage_gazette')
    expect(ids).not.toContain('audit_report')
  })

  it('gives each specialist desk its own paper', () => {
    // Sorted on both sides — the assertion is about WHICH kinds a desk holds, not about
    // where they happen to sit in the display list.
    const idsFor = (role: Parameters<typeof intakeKindsFor>[0][number]) =>
      intakeKindsFor([role]).map((k) => k.id).sort()

    expect(idsFor('hr')).toEqual(['wage_gazette'])
    expect(idsFor('compliance')).toEqual(['audit_report'])
    // Commercial holds the bank's paper AND the customs paper; the store shares only the
    // customs declaration, because it receives against it (runbook #19). A credit is not
    // the store's business — it is the factory's exposure at a bank.
    expect(idsFor('commercial')).toEqual(['lc_swift', 'ud_scan'])
    expect(idsFor('store')).toEqual(['ud_scan'])
  })

  it('gives an owner and an admin everything', () => {
    // Supervision, not a department — the same two roles requireRole treats that way.
    expect(intakeKindsFor(['owner'])).toEqual(INTAKE_KINDS)
    expect(intakeKindsFor(['admin'])).toEqual(INTAKE_KINDS)
    // And a supervisory role alongside a narrow one still widens, never narrows.
    expect(intakeKindsFor(['hr', 'admin'])).toEqual(INTAKE_KINDS)
  })

  it('offers nothing to a role that files no documents', () => {
    expect(intakeKindsFor(['planner'])).toEqual([])
    expect(intakeKindsFor([])).toEqual([])
  })

  it('answers the wall with the same list it draws the chips from', () => {
    // `mayFileKind` is what `readDocument` refuses on. If it ever disagreed with
    // `intakeKindsFor`, a chip would appear that 403s when pressed.
    for (const roles of [['merchandiser'], ['hr'], ['store'], ['owner'], ['planner']] as const) {
      const offered = intakeKindsFor(roles)
      for (const kind of INTAKE_KINDS) {
        expect(mayFileKind(kind, roles), `${kind.id} for ${roles.join('+')}`).toBe(
          offered.includes(kind),
        )
      }
    }
  })
})

describe('the enquiry that starts the chain', () => {
  it('exists, drafts an RFQ, and asks who sent it', () => {
    /*
     * Phase 1 of the live test opens "intake → kind 'buyer enquiry'" and that chip did not
     * exist — the document the whole order-to-cash chain starts from had no door, and the
     * tester met six kinds, none of which was theirs.
     */
    const kind = INTAKE_KINDS.find((k) => k.id === 'buyer_enquiry')

    expect(kind).toBeDefined()
    expect(kind!.moduleId).toBe('rfq')
    expect(kind!.targetTable).toBe('rfqs')
    // A buyer's uuid is the one field the email cannot carry — the reason the kinds that
    // could not ask for one were removed rather than left to fail at zod.
    expect(kind!.context?.map((c) => c.field)).toEqual(['buyerId'])
  })
})
