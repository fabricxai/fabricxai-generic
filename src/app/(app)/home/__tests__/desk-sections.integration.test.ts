/**
 * Every desk composes a morning (role audit S1).
 *
 * The failure this guards is the quiet one: a section builder whose query signature drifts
 * (ticketBoard grew a `now` argument mid-build and the compiler caught it — a runtime-shaped
 * drift would not be), or that throws on an empty tenant. Each builder runs against a real
 * database with NOTHING seeded, because the empty tenant is every desk's first morning and
 * the state the audit found three desks stuck rendering.
 *
 * Content correctness (the right PO in the right queue) belongs to each module's own suite —
 * this asserts the composition contract: every role resolves to a desk, every section carries
 * the words its empty state needs, and nothing throws.
 */
import { randomUUID } from 'node:crypto'

import { eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDirectClient, createDirectDb } from '@/db/direct'
import { companies, roles, users } from '@/db/schema/core'
import type { RequestCtx } from '@/modules/core/ctx'
import { tui } from '@/lib/i18n-ui'

import { deskCalmLinks, deskRoleFor, deskSections, type DeskRole } from '../desk-sections'

const client = createDirectClient()
const db = createDirectDb(client)

const COMPANY = randomUUID()
const USER = `desk-${randomUUID().slice(0, 8)}`
const TODAY = '2026-08-12'

const DESKS: DeskRole[] = [
  'store',
  'quality',
  'shipment',
  'commercial',
  'procurement',
  'planner',
  'cutting',
  'maintenance',
  'hr',
  'compliance',
]

beforeAll(async () => {
  await db.insert(companies).values({ id: COMPANY, name: 'Desk Co', slug: `desk-${COMPANY.slice(0, 8)}` })
  await db.insert(users).values({ id: USER, email: `${USER}@fabricxai.test`, name: 'Desk Person' })
  // One roles row so the tenant-scoped auth policies can see the user at all.
  await db.insert(roles).values({ companyId: COMPANY, userId: USER, role: 'member' })
})

afterAll(async () => {
  await db.execute(sql`delete from audit_log where company_id = ${COMPANY}`)
  await db.delete(companies).where(eq(companies.id, COMPANY))
  await db.delete(users).where(eq(users.id, USER))
  await client.end()
})

const words = (key: string, params?: Record<string, unknown>) => tui('en', key, params)

describe('S1 · every desk has a morning', () => {
  it('resolves a desk for each of the ten roles, and none for the rest', () => {
    for (const desk of DESKS) expect(deskRoleFor([desk])).toBe(desk)
    expect(deskRoleFor(['production'])).toBeNull()
    expect(deskRoleFor(['viewer'])).toBeNull()
    expect(deskRoleFor(['member'])).toBeNull()
  })

  it.each(DESKS.map((d) => [d] as const))(
    '%s composes on an empty tenant without throwing',
    async (desk) => {
      // The ctx carries the desk's own role — hr's payroll read enforces it (rule 9).
      const ctx: RequestCtx = { companyId: COMPANY, userId: USER, roles: [desk] }
      const sections = await deskSections(ctx, desk, TODAY, words)

      // Every desk gets its own queues plus the two cross-desk sections (CAPs, my drafts).
      expect(sections.length).toBeGreaterThanOrEqual(3)

      for (const section of sections) {
        expect(section.id).toBeTruthy()
        // An empty tenant renders empty states everywhere, so the copy has to exist and
        // has to be words rather than a key that fell through the catalogue.
        expect(section.title).not.toMatch(/^ui\./)
        expect(section.empty).not.toMatch(/^ui\./)
      }

      /*
       * Almost every queue is empty on an empty tenant — except HR's, and that exception is
       * the desk working: a factory with no active wage gazette cannot compute pay, and
       * "no gazette is active" is a fact ABOUT the empty tenant, not residue in it.
       */
      const rows = sections.flatMap((section) => section.rows)
      if (desk === 'hr') {
        expect(rows.map((row) => row.id)).toEqual(['no-gazette'])
      } else {
        expect(rows).toEqual([])
      }
    },
  )

  it('offers every desk a calm link into its own screens', () => {
    for (const desk of DESKS) {
      const links = deskCalmLinks(desk, words)
      expect(links.length).toBeGreaterThan(0)
      for (const link of links) {
        expect(link.href).toMatch(/^\//)
        expect(link.label).not.toMatch(/^ui\./)
      }
    }
  })
})
