import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { lines } from '@/modules/planning/schema'
import { endlineCounts } from '@/modules/production/schema'

import { EndlineClient } from './endline-client'
import { factoryToday } from '@/lib/dates'

/**
 * 6.1 Line tracking · endline QC (canvas P3).
 *
 * The count taken at the end of a sewing line: how many garments were checked, how many
 * passed, and how many defects were found across them. Two numbers come out of it and both
 * are read everywhere else in the factory — DHU (defects per hundred units) and pass rate.
 *
 * Neither is stored. They are derived from the count on every read, because a stored
 * percentage and the numbers under it disagree the first time somebody corrects a count,
 * and the percentage is the one people quote.
 */
export const dynamic = 'force-dynamic'

export default async function EndlinePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const today = factoryToday()

  const [allLineRows, counts] = await Promise.all([
    withTenantRead(ctx, (tx) =>
      tx
        .select({ id: lines.id, code: lines.code, name: lines.name })
        .from(lines)
        .where(eq(lines.isActive, true))
        .orderBy(lines.code),
    ),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          lineId: endlineCounts.lineId,
          checked: endlineCounts.checked,
          passed: endlineCounts.passed,
          defective: endlineCounts.defective,
          defects: endlineCounts.defects,
          rework: endlineCounts.rework,
          updatedAt: endlineCounts.updatedAt,
        })
        .from(endlineCounts)
        .where(eq(endlineCounts.countedOn, today)),
    ),
  ])

  // The caller's line narrowing, honoured — a chief scoped to L1/L2 counts L1/L2.
  const lineRows = ctx.lineScope
    ? allLineRows.filter((row) => ctx.lineScope!.includes(row.code))
    : allLineRows

  if (lineRows.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
          eyebrow={tui(locale, 'ui.production.endline_eyebrow')}
          title={tui(locale, 'ui.production.no_lines_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.production.endline_empty_title')}
          body={tui(locale, 'ui.production.endline_empty_body')}
        />
      </FloorScreen>
    )
  }

  const byLine = new Map(counts.map((c) => [c.lineId, c]))

  return (
    <FloorScreen>
      <PageHeader
        eyebrow={tui(locale, 'ui.production.endline_eyebrow_dated', { date: today })}
        title={tui(locale, 'ui.production.endline_title')}
        meta={tui(locale, 'ui.production.endline_meta', {
          counted: counts.length,
          total: lineRows.length,
        })}
        ownsAmber
      />
      <EndlineClient
        countedOn={today}
        lines={lineRows.map((line) => {
          const count = byLine.get(line.id)
          return {
            lineId: line.id,
            code: line.code,
            name: line.name,
            checked: count?.checked ?? null,
            passed: count?.passed ?? null,
            defective: count?.defective ?? null,
            defects: count?.defects ?? null,
            rework: count?.rework ?? null,
            lastWrittenAt: count?.updatedAt?.toISOString() ?? null,
          }
        })}
      />
    </FloorScreen>
  )
}
