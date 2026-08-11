/**
 * Turning a code somebody can see into the id the system stores.
 *
 * The gap: every record has a `uuid` primary key that appears in no screen, no document and
 * no export, and a human code — `B-04501`, `LAY-31`, `L1` — that is printed on the row and
 * unique per company by index. MARBIM's read tools were given the first and not the second,
 * so asked about a buyer code visible in the table beside the chat panel, the model could
 * only answer that it had no way to look it up.
 *
 * These cases pin the three decisions that make the mechanism safe rather than merely
 * convenient: a uuid still passes through, a miss is a refusal rather than a near match, and
 * a kind nobody owns fails as the wiring fault it is.
 */
import { describe, expect, it, vi } from 'vitest'

import { isUuid, knownRefKinds, resolveRef, type RefResolver } from '@/modules/core/refs'
import { registerModule, type ModuleDefinition } from '@/modules/core/registry'

const ctx = { companyId: '11111111-1111-4111-8111-111111111111', userId: 'u-1', roles: ['owner' as const] }

/** A module that owns one kind of reference, registered under a unique id per test. */
let n = 0
function moduleResolving(kind: string, resolver: RefResolver): string {
  const id = `refs_test_${(n += 1)}`
  const definition: ModuleDefinition = {
    id,
    pendingTargets: [],
    zodMap: {},
    approvalDefaults: { requiredRoles: ['owner'] },
    refResolvers: { [kind]: resolver },
  }
  registerModule(definition)
  return id
}

describe('a uuid is already an id', () => {
  it('passes straight through without consulting anybody', async () => {
    // The screens hand ids to the copilot when they have them — a conversation scoped to an
    // order page knows its own. A resolver that refused a uuid would break that in order to
    // fix chat.
    const resolver = vi.fn<RefResolver>()
    moduleResolving('never_called', resolver)

    const id = '22222222-2222-4222-8222-222222222222'
    await expect(resolveRef(ctx, 'never_called', id)).resolves.toBe(id)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('recognises one whatever the surrounding whitespace', async () => {
    const id = '22222222-2222-4222-8222-222222222222'
    await expect(resolveRef(ctx, 'anything', `  ${id}  `)).resolves.toBe(id)
  })

  it('does not mistake a code for one', () => {
    for (const code of ['B-04501', 'LAY-31', 'L1', 'not-a-uuid', '']) {
      expect(isUuid(code), code).toBe(false)
    }
  })
})

describe('a code goes to the module that owns it', () => {
  it('resolves through the registered resolver', async () => {
    const kind = 'buyer_alpha'
    moduleResolving(kind, async (_ctx, ref) =>
      ref === 'B-04501' ? '33333333-3333-4333-8333-333333333333' : null,
    )

    await expect(resolveRef(ctx, kind, 'B-04501')).resolves.toBe(
      '33333333-3333-4333-8333-333333333333',
    )
  })

  it('hands the resolver the caller’s own ctx, so the lookup is tenant-scoped', async () => {
    // The resolver reads through its module's queries, which scope by company. A code is
    // only unique WITHIN a company — `B-04501` may exist in two factories.
    const kind = 'buyer_beta'
    const resolver = vi.fn<RefResolver>(async () => '44444444-4444-4444-8444-444444444444')
    moduleResolving(kind, resolver)

    await resolveRef(ctx, kind, 'B-04501')
    expect(resolver).toHaveBeenCalledWith(ctx, 'B-04501')
  })

  it('trims what a person pasted', async () => {
    const kind = 'buyer_gamma'
    moduleResolving(kind, async (_ctx, ref) =>
      ref === 'B-04501' ? '55555555-5555-4555-8555-555555555555' : null,
    )

    await expect(resolveRef(ctx, kind, ' B-04501\n')).resolves.toBe(
      '55555555-5555-4555-8555-555555555555',
    )
  })
})

describe('what it refuses', () => {
  it('refuses a miss instead of finding the nearest row', async () => {
    /*
     * The whole reason this is a lookup and not a search. "Did you mean B-04502" is the kind
     * of helpfulness that eventually books a shipment against the wrong buyer — and unlike a
     * person choosing from a list, a tool acts on the answer immediately.
     */
    const kind = 'buyer_delta'
    moduleResolving(kind, async () => null)

    await expect(resolveRef(ctx, kind, 'B-99999')).rejects.toThrow(/reference_not_found/)
  })

  it('refuses an empty reference before asking anybody', async () => {
    const kind = 'buyer_epsilon'
    const resolver = vi.fn<RefResolver>(async () => 'x')
    moduleResolving(kind, resolver)

    await expect(resolveRef(ctx, kind, '   ')).rejects.toThrow(/reference_empty/)
    expect(resolver).not.toHaveBeenCalled()
  })

  it('says a kind nobody owns is a wiring fault, not a bad reference', async () => {
    // A tool asking for a kind no module registered would otherwise answer "not found" for
    // every value a person could possibly type, and look like their mistake.
    await expect(resolveRef(ctx, 'nothing_owns_this', 'B-04501')).rejects.toThrow(
      /reference_kind_unknown/,
    )
  })
})

describe('what the system can resolve', () => {
  it('lists every registered kind, for the primers to be honest about', async () => {
    const kind = `buyer_zeta_${(n += 1)}`
    moduleResolving(kind, async () => null)

    expect(knownRefKinds()).toContain(kind)
    // Sorted, so a primer generated from it does not churn on module load order.
    expect([...knownRefKinds()]).toEqual([...knownRefKinds()].sort())
  })
})
