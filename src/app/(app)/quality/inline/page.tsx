import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { eq } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { lines } from '@/modules/planning/schema'
import { dailyLinePlans } from '@/modules/production/schema'
import { STANDARD_SEWING_OPERATIONS } from '@/modules/quality/quality'
import { dhuByLine, inlineCaptureContext } from '@/modules/quality/queries'
import type { QualityPolicy } from '@/modules/quality/service'
import { getPolicy } from '@/modules/settings/service'

import { InlineClient } from './inline-client'
import { factoryToday } from '@/lib/dates'

/**
 * 7.1 Quality · inline capture (canvas P1).
 *
 * A roving QC walks the line and taps: which operation, what is wrong, whose machine. The
 * canvas caps it at three taps and makes the third skippable, and that constraint is the
 * whole design — a defect that takes thirty seconds to file is a defect that gets remembered
 * until the end of the shift and then written down wrong, or not at all.
 *
 * Severity is deliberately absent from the flow. It comes from the defect code, because two
 * QCs classifying the same broken stitch differently is how a DHU trend stops meaning
 * anything, and because a person standing at a machine should not be adjudicating severity.
 */
export const dynamic = 'force-dynamic'

export default async function InlineQcPage({
  searchParams,
}: {
  searchParams: Promise<{ line?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const today = factoryToday()
  const lineRows = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: lines.id, code: lines.code, name: lines.name })
      .from(lines)
      .where(eq(lines.isActive, true))
      .orderBy(lines.code),
  )

  if (lineRows.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
          eyebrow={tui(locale, 'ui.quality.inline_eyebrow')}
          title={tui(locale, 'ui.quality.no_lines_set_up')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.quality.inline_empty_title')}
          body={tui(locale, 'ui.quality.inline_empty_body')}
        />
        <FloorTabs
        tabs={[
          { href: '/quality/inline', label: 'Walk' },
          { href: '/quality/fabric', label: '4-point' },
          { href: '/quality/final', label: 'Final' },
        ]}
      />
    </FloorScreen>
    )
  }

  const { line: requested } = await searchParams
  const active = lineRows.find((l) => l.id === requested) ?? lineRows[0]!

  const [policy, context, dhu, plan] = await Promise.all([
    getPolicy<QualityPolicy>(ctx, 'quality'),
    inlineCaptureContext(ctx, { lineId: active.id }),
    dhuByLine(ctx, { on: today, threshold: null }),
    withTenantRead(ctx, (tx) =>
      tx
        .select({ orderId: dailyLinePlans.orderId })
        .from(dailyLinePlans)
        .where(eq(dailyLinePlans.lineId, active.id)),
    ),
  ])

  const lineDhu = dhu.find((d) => d.lineId === active.id) ?? null
  const threshold = policy.dhuAlertThreshold ?? null

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
        eyebrow={tui(locale, 'ui.quality.inline_eyebrow_dated', { date: today })}
        title={`${active.code} · ${active.name}`}
        meta={threshold ? tui(locale, 'ui.quality.target_dhu_meta', { threshold }) : undefined}
        ownsAmber
      />
      <InlineClient
        lineId={active.id}
        lines={lineRows.map((l) => ({ id: l.id, code: l.code }))}
        orderId={plan.find((p) => p.orderId)?.orderId ?? null}
        defects={context.defects}
        // History first, standard sequence for the operations this line has never seen.
        // A QC on a brand-new line still gets a usable list; a settled line sees its own.
        operations={[
          ...context.operations,
          ...STANDARD_SEWING_OPERATIONS.filter((op) => !context.operations.includes(op)),
        ]}
        operators={context.operators}
        recent={context.recent.map((r) => ({ ...r, occurredAt: r.occurredAt.toISOString() }))}
        dhu={
          lineDhu
            ? { dhu: lineDhu.dhu, checked: lineDhu.checked, defects: lineDhu.defects }
            : { dhu: null, checked: 0, defects: 0 }
        }
        threshold={threshold}
      />
      <FloorTabs
        tabs={[
          { href: '/quality/inline', label: 'Walk' },
          { href: '/quality/fabric', label: '4-point' },
          { href: '/quality/final', label: 'Final' },
        ]}
      />
    </FloorScreen>
  )
}
