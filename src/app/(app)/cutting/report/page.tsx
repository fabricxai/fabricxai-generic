import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { layForReport, recentLays } from '@/modules/cutting/queries'
import type { CuttingPolicy } from '@/modules/cutting/service'
import { getPolicy } from '@/modules/settings/service'

import { ReportClient } from './report-client'

/**
 * 5.1 Cutting · cut report (canvas P3).
 *
 * What actually came off the table, against what the marker said it would. The tolerance
 * comes from Settings rather than a constant here — a factory that has agreed 2% with its
 * buyer and a factory that has agreed 5% are running the same screen against different
 * numbers, and a hardcoded default would be a silent allowance.
 */
export const dynamic = 'force-dynamic'

export default async function CutReportPage({
  searchParams,
}: {
  searchParams: Promise<{ lay?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const lays = await recentLays(ctx)
  // Only a lay still open can be reported: a report closes it, and a second report is a
  // correction that goes through the approve inbox instead.
  const open = lays.filter((l) => l.status === 'open')

  if (open.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/cutting', label: 'Cutting' }}
          eyebrow={tui(locale, 'ui.cutting.report_eyebrow')}
          title={tui(locale, 'ui.cutting.report_nothing_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.cutting.report_empty_title')}
          body={tui(locale, 'ui.cutting.report_empty_body')}
        />
        <FloorTabs
        tabs={[
          { href: '/cutting', label: 'Queue' },
          { href: '/cutting/lay', label: 'Lay' },
          { href: '/cutting/report', label: 'Report' },
        ]}
      />
    </FloorScreen>
    )
  }

  const requested = (await searchParams).lay
  const targetId = open.find((l) => l.id === requested)?.id ?? open[0]!.id

  const [lay, policy] = await Promise.all([
    layForReport(ctx, targetId),
    getPolicy<CuttingPolicy>(ctx, 'cutting'),
  ])

  if (!lay) redirect('/cutting')

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/cutting', label: 'Cutting' }}
        eyebrow={tui(locale, 'ui.cutting.report_eyebrow')}
        title={`${lay.layNo} · ${lay.color}`}
        meta={tui(locale, 'ui.cutting.report_meta', {
          plies: lay.plies,
          marker: lay.markerCode,
          tolerance: policy.tolerancePct,
        })}
        ownsAmber
      />
      <ReportClient
        lay={lay}
        openLays={open.map((l) => ({ id: l.id, layNo: l.layNo, color: l.color }))}
        tolerancePct={policy.tolerancePct}
      />
      <FloorTabs
        tabs={[
          { href: '/cutting', label: 'Queue' },
          { href: '/cutting/lay', label: 'Lay' },
          { href: '/cutting/report', label: 'Report' },
        ]}
      />
    </FloorScreen>
  )
}
