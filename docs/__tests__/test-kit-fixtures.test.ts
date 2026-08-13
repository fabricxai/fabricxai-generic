/**
 * Every test-kit document, parsed by the schema its door actually uses.
 *
 * The kits under `docs/test-kits/` ship an `expected.json` beside each document: the ground
 * truth a tester diffs the approve-inbox draft against. That file is also, for free, a
 * realistic payload — so this suite asks the one question nobody was asking:
 *
 *     if the extractor read this document PERFECTLY, would the schema accept the answer?
 *
 * For `buyer_enquiry` the answer was no, and had always been no. `rfqPayload` required a
 * `buyerId` uuid and typed `targetPrice` as a bare string; every reading died at the
 * provider call with "buyerId Invalid UUID; targetPrice expected a money amount", three
 * attempts each, for every document anyone ever filed. Nothing caught it: the kind named a
 * real module, a whitelisted target and a schema that exists, so `assertIntakeKinds` was
 * happy, and `intake.test.ts` exempted the field because a picker declared it.
 *
 * The distinction this file turns on is §"the empty-handed parse" below. It is not the same
 * question `intake.test.ts` asks and it is not decoration: it is the moment the provider is
 * actually in.
 */
// Before the registry, for the reason intake.test.ts gives: loading every module's
// `register.ts` pulls in the db client, which validates the environment at import.
import 'dotenv/config'

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'
import type { ZodType } from 'zod'

import '@/modules/registry'
import { resolvePendingSchema, resolveReadSchema } from '@/modules/core/registry'
import { INTAKE_KINDS } from '@/modules/marbim/intake'

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** Any id-shaped value; stands in for whatever the intake picker would have supplied. */
const PICKED_ID = '00000000-0000-4000-8000-000000000001'

type Fixture = {
  /** Repo-relative, so a failure message is a path somebody can open. */
  file: string
  kindId: string
  payload: Record<string, unknown>
}

/**
 * `_`-prefixed keys are notes to the tester — `_intakeKind`, `_door`, `_notes`, `_context`,
 * `_cartonCount`. They are not payload and the schemas do not name them.
 */
function stripNotes(raw: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).filter(([key]) => !key.startsWith('_')))
}

function loadFixtures(): Fixture[] {
  // Both kit layouts: `<doc>.expected.json` (test-textile-nordkap) and `expected.json` in a
  // per-document folder (the older FabricXAI Fashion kit). Matching on CONTENT rather than
  // filename keeps a third layout from silently going untested.
  const out: Fixture[] = []
  for (const kit of ['docs/test-kit', 'docs/test-kits']) {
    const root = path.join(REPO, kit)
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!entry.endsWith('.json')) continue
      const file = path.join(kit, entry)
      const raw = JSON.parse(readFileSync(path.join(REPO, file), 'utf8')) as Record<string, unknown>
      const kindId = raw._intakeKind
      if (typeof kindId !== 'string') continue
      out.push({ file, kindId, payload: stripNotes(raw) })
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/** The same way the product reaches a kind's schema — see intake.test.ts's `schemaOf`. */
const schemaOf = (kind: (typeof INTAKE_KINDS)[number]): ZodType =>
  (kind.fillsFormOnly
    ? resolveReadSchema(kind.moduleId, kind.zodSchemaKey)
    : resolvePendingSchema(kind.moduleId, kind.targetTable, kind.zodSchemaKey)) as ZodType

/** zod issues as `path: message`, which is what the provider error string is made of. */
function why(result: { success: false; error: { issues: readonly { path: PropertyKey[]; message: string }[] } }) {
  return result.error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ')
}

const FIXTURES = loadFixtures()
const KIND_BY_ID = new Map(INTAKE_KINDS.map((kind) => [kind.id, kind]))

describe('test-kit fixtures parse against their door’s schema', () => {
  it('found fixtures to check', () => {
    // A glob that quietly matches nothing is a suite that quietly proves nothing.
    expect(FIXTURES.length, 'no expected.json fixtures found under docs/test-kit*/').toBeGreaterThan(0)
  })

  it.each(FIXTURES.map((f) => [f.file, f] as const))('%s names a real intake kind', (_file, fixture) => {
    expect(
      KIND_BY_ID.get(fixture.kindId),
      `"${fixture.file}" claims intake kind "${fixture.kindId}", which is not in INTAKE_KINDS`,
    ).toBeDefined()
  })

  /**
   * The payload as it stands after the pipeline has done everything for the model: context
   * merged, document id written over. This is what `propose` stores and what approve
   * re-validates, so it has to hold.
   */
  it.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s parses once the picker’s ids are merged in',
    (_file, fixture) => {
      const kind = KIND_BY_ID.get(fixture.kindId)
      if (!kind) return // reported by the test above; don't fail twice for one cause

      const payload = { ...fixture.payload }
      for (const field of kind.context ?? []) payload[field.field] = PICKED_ID

      const result = schemaOf(kind).safeParse(payload)
      expect(
        result.success || why(result as never),
        `"${fixture.file}" is a perfect reading of its document and ${kind.zodSchemaKey} rejects it`,
      ).toBe(true)
    },
  )

  /**
   * ── the empty-handed parse ────────────────────────────────────────────────────────────
   *
   * The same payload with the picker's ids REMOVED — which is the payload the provider is
   * asked to produce, and the only one it is ever judged on.
   *
   * `service.ts` folds `contextValues` in over `result.value`, and `result.value` is what the
   * provider already validated. So the buyer the person picked from a dropdown arrives after
   * the schema has had its say. A kind whose schema requires a context field is a kind whose
   * every reading fails, no matter how good the extraction or how clean the document — and
   * the failure surfaces as a red row in "Recent extractions" with nothing actionable in it.
   *
   * This is the assertion that would have caught `buyer_enquiry` on the day it was added.
   */
  it.each(FIXTURES.map((f) => [f.file, f] as const))(
    '%s parses BEFORE the picker’s ids are merged — the moment the provider is judged in',
    (_file, fixture) => {
      const kind = KIND_BY_ID.get(fixture.kindId)
      if (!kind) return

      const payload = { ...fixture.payload }
      for (const field of kind.context ?? []) delete payload[field.field]

      const result = schemaOf(kind).safeParse(payload)
      expect(
        result.success || why(result as never),
        `"${fixture.file}" cannot be produced by any extractor: ${kind.zodSchemaKey} rejects a reading that omits ` +
          `${(kind.context ?? []).map((f) => f.field).join(', ') || 'nothing'}, but contextValues are merged AFTER the ` +
          `provider validates. Make the context field .optional().catch(undefined).`,
      ).toBe(true)
    },
  )
})

describe('the kits cover every door', () => {
  it('every intake kind has at least one fixture', () => {
    // Not busywork: a kind with no fixture is a door whose schema nothing has ever parsed a
    // realistic payload through, which is precisely how buyer_enquiry stayed broken.
    const covered = new Set(FIXTURES.map((f) => f.kindId))
    const missing = INTAKE_KINDS.filter((kind) => !covered.has(kind.id)).map((kind) => kind.id)

    expect(
      missing,
      `no test-kit document exercises: ${missing.join(', ')} — add one under docs/test-kits/, or the door ships unparsed`,
    ).toEqual([])
  })
})
