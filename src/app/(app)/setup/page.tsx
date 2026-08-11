import { asc, eq } from 'drizzle-orm'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { lines } from '@/modules/planning/schema'
import { items, locations } from '@/modules/store/schema'
import { workers } from '@/modules/workforce/schema'

import { MastersClient } from './masters-client'

/**
 * Factory setup — the four master lists (day-one finding D1).
 *
 * A new factory could not start work at all. Nothing in this product created an item, a
 * location, a worker or a line; the only writer was the seed script. The store could
 * therefore never receive anything, HR could never register anybody, and the planning
 * board had no lines to plan against — permanently, and invisibly, because every one of
 * those screens rendered correctly and simply had nothing to offer.
 *
 * Barakah only worked because `seed-day0` planted items and lines, and the missing
 * locations were created by hand in psql during the live test.
 *
 * One screen for four modules, deliberately. Architecturally these belong in store,
 * workforce and planning, and their services do live there — this page only reads and
 * calls. What is shared is not the domain but the moment: somebody sitting down to tell
 * the system what their factory is made of.
 */
export const dynamic = 'force-dynamic'

export default async function SetupPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const [itemRows, locationRows, lineRows, workerRows] = await Promise.all([
    withTenantRead(ctx, (tx) =>
      tx
        .select({ id: items.id, code: items.code, name: items.name, uom: items.uom, kind: items.kind })
        .from(items)
        .where(eq(items.isActive, true))
        .orderBy(asc(items.code)),
    ),
    withTenantRead(ctx, (tx) =>
      tx
        .select({ id: locations.id, code: locations.code, name: locations.name, kind: locations.kind })
        .from(locations)
        .orderBy(asc(locations.code)),
    ),
    withTenantRead(ctx, (tx) =>
      tx
        .select({ id: lines.id, code: lines.code, name: lines.name, manpower: lines.capacityManpower })
        .from(lines)
        .where(eq(lines.isActive, true))
        .orderBy(asc(lines.code)),
    ),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          id: workers.id,
          employeeNo: workers.employeeNo,
          name: workers.name,
          grade: workers.grade,
        })
        .from(workers)
        .where(eq(workers.status, 'active'))
        .orderBy(asc(workers.employeeNo)),
    ),
  ])

  return (
    <>
      <PageHeader
        eyebrow="Setup"
        title="What your factory is made of"
        meta="Items, locations, lines and workers. Everything downstream — receiving, issuing, cutting, the board, attendance, payroll — needs these to exist first."
      />
      <MastersClient
        items={itemRows.map((r) => ({ id: r.id, code: r.code, name: r.name, detail: `${r.kind} · ${r.uom}` }))}
        locations={locationRows.map((r) => ({ id: r.id, code: r.code, name: r.name, detail: r.kind }))}
        lines={lineRows.map((r) => ({
          id: r.id,
          code: r.code,
          name: r.name,
          ...(r.manpower ? { detail: `${r.manpower} operators` } : {}),
        }))}
        workers={workerRows.map((r) => ({
          id: r.id,
          code: r.employeeNo,
          name: r.name,
          detail: `grade ${r.grade}`,
        }))}
        canWriteWorkers={ctx.roles.some((role) => role === 'hr' || role === 'owner' || role === 'admin')}
      />
    </>
  )
}
