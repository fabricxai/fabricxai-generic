/**
 * The entity drawer mechanism against a real database (specs/order-centric-core.md §3).
 *
 * What a typecheck cannot see: that `peekEntity` walks its walls in the right order —
 * unknown kind loudly, inactive module with the same typed refusal every other surface
 * uses, roles before any query, references through `core/refs` — and that the one core
 * kind (`document`) answers another tenant's id and a missing one identically.
 */
import { randomUUID } from 'node:crypto'

import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, companyModules, documents, users } from '@/db/schema/core'
import { peekEntity, knownDrawerKinds, type DrawerPeek } from '@/modules/core/drawer'
import { setModuleEnabled } from '@/modules/core/activation'
import type { RequestCtx } from '@/modules/core/ctx'
import { registerModule, type ModuleDefinition } from '@/modules/core/registry'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const OTHER = randomUUID()
const USER = `drw-user-${randomUUID().slice(0, 8)}`

const owner: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['owner'] }
const store: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['store'] }
const merch: RequestCtx = { companyId: COMPANY, userId: USER, roles: ['merchandiser'] }
const otherOwner: RequestCtx = { companyId: OTHER, userId: USER, roles: ['owner'] }

/** Registered fresh — this file tests the MECHANISM, not any real module's payload. */
const suffix = randomUUID().slice(0, 8)
const MODULE = `drw_mod_${suffix}`
const KIND = `drw_widget_${suffix}`
const GATED_KIND = `drw_gated_${suffix}`

const WIDGET_ID = randomUUID()
const WIDGET_CODE = `WID-${suffix.toUpperCase()}`

const widgetPeek = (id: string): DrawerPeek => ({
  kind: KIND,
  id,
  title: WIDGET_CODE,
  facts: [{ labelKey: 'ui.peek.doc_status', value: 'spinning' }],
})

const definition: ModuleDefinition = {
  id: MODULE,
  pendingTargets: [],
  zodMap: {},
  approvalDefaults: { requiredRoles: ['owner'] },
  refResolvers: {
    // The same seam real modules use: a human code becomes an id, or null.
    [KIND]: async (_ctx, ref) => (ref === WIDGET_CODE ? WIDGET_ID : null),
  },
  drawers: {
    [KIND]: {
      peek: async (_ctx, id) => (id === WIDGET_ID ? widgetPeek(id) : null),
    },
    [GATED_KIND]: {
      roles: ['store'],
      peek: async (_ctx, id) => widgetPeek(id),
    },
  },
}

const DOC_ID = randomUUID()

beforeAll(async () => {
  await db
    .insert(companies)
    .values([
      { id: COMPANY, name: 'Drawer Co', slug: `drw-${COMPANY.slice(0, 8)}` },
      { id: OTHER, name: 'Bystander Co', slug: `drb-${OTHER.slice(0, 8)}` },
    ])
    .onConflictDoNothing()
  await db
    .insert(users)
    .values([{ id: USER, email: `${USER}@fabricxai.test`, name: 'Drawer Tester' }])
    .onConflictDoNothing()
  await db.insert(documents).values({
    id: DOC_ID,
    companyId: COMPANY,
    bucket: 'test',
    objectKey: `drw/${DOC_ID}`,
    filename: 'challan-2044.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 183_402,
    status: 'ready',
  })

  registerModule(definition)
})

afterAll(async () => {
  await db.delete(documents).where(eq(documents.id, DOC_ID))
  await db.delete(companyModules).where(eq(companyModules.companyId, COMPANY))
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(companies).where(eq(companies.id, OTHER))
  await client.end()
})

describe('the walls, in order', () => {
  it('a kind nobody owns fails loudly, not as not-found', async () => {
    await expect(peekEntity(owner, `drw_ghost_${suffix}`, WIDGET_ID)).rejects.toMatchObject({
      code: 'validation_failed',
      messageKey: 'errors.drawer_kind_unknown',
    })
  })

  it('a switched-off module is not peekable, with the refusal every surface shares', async () => {
    await setModuleEnabled(owner, MODULE, false)
    await expect(peekEntity(owner, KIND, WIDGET_ID)).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.module_inactive',
    })
    await setModuleEnabled(owner, MODULE, true)
  })

  it('a kind with a roles list refuses the wrong desk and admits supervision', async () => {
    await expect(peekEntity(merch, GATED_KIND, WIDGET_ID)).rejects.toMatchObject({
      code: 'forbidden',
      messageKey: 'errors.forbidden',
    })
    await expect(peekEntity(store, GATED_KIND, WIDGET_ID)).resolves.toMatchObject({
      title: WIDGET_CODE,
    })
    await expect(peekEntity(owner, GATED_KIND, WIDGET_ID)).resolves.toMatchObject({
      title: WIDGET_CODE,
    })
  })
})

describe('references', () => {
  it('a uuid passes straight through; a code resolves through the module resolver', async () => {
    const byId = await peekEntity(owner, KIND, WIDGET_ID)
    const byCode = await peekEntity(owner, KIND, WIDGET_CODE)
    expect(byId.id).toBe(WIDGET_ID)
    expect(byCode.id).toBe(WIDGET_ID)
  })

  it('a code nobody printed is a typed refusal naming the reference', async () => {
    await expect(peekEntity(owner, KIND, 'WID-NOPE')).rejects.toMatchObject({
      code: 'validation_failed',
      messageKey: 'errors.reference_not_found',
    })
  })

  it('a provider answering null is not_found — the id was well-formed and the row is not there', async () => {
    await expect(peekEntity(owner, KIND, randomUUID())).rejects.toMatchObject({
      code: 'not_found',
      messageKey: 'errors.reference_not_found',
    })
  })
})

describe('the document kind, which core owns', () => {
  it('answers with the file facts a reader needs', async () => {
    const peek = await peekEntity(owner, 'document', DOC_ID)
    expect(peek.title).toBe('challan-2044.pdf')
    expect(peek.subtitle).toBe('application/pdf')
    expect(peek.facts).toContainEqual({
      labelKey: 'ui.peek.doc_size',
      value: '179.1 KB',
      mono: true,
    })
  })

  it('another tenant’s id and a missing one are the same answer', async () => {
    await expect(peekEntity(otherOwner, 'document', DOC_ID)).rejects.toMatchObject({
      code: 'not_found',
      messageKey: 'errors.reference_not_found',
    })
    await expect(peekEntity(owner, 'document', randomUUID())).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('is in the known kinds, beside whatever the modules registered', () => {
    const kinds = knownDrawerKinds()
    expect(kinds).toContain('document')
    expect(kinds).toContain(KIND)
  })
})
