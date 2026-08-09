import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { measurementSubjects } from '@/modules/quality/queries'

import { MeasurementsClient } from './measurements-client'

/**
 * 7.1 Quality · measurements (canvas P3).
 *
 * A QC lays a garment on a table, runs a tape over each point of measure, and compares it to
 * the buyer's chart. The screen is the chart, plus a column per piece.
 *
 * **Tolerances are asymmetric and the screen shows both halves.** A body length at
 * +1.0 / −0.5 is the normal shape of a spec sheet: a buyer takes a shirt slightly long far
 * more readily than slightly short. Rendering that as ±0.75 — the average, or the tighter
 * of the two — rejects garments nobody would have rejected and passes ones somebody will.
 *
 * **Nothing is graded in the browser.** Deviations and pass/fail come back from
 * `measurementVariance` on the server, against the chart VERSION the check is filed under,
 * and are stored on the row. A chart revised next month must not silently re-grade a check
 * that is already in a buyer's report.
 */
export const dynamic = 'force-dynamic'

export default async function MeasurementsPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const subjects = await measurementSubjects(ctx)

  if (subjects.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
          eyebrow={tui(locale, 'ui.quality.measure_eyebrow')}
          title={tui(locale, 'ui.quality.measure_empty_page_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.quality.measure_empty_title')}
          body={tui(locale, 'ui.quality.measure_empty_body')}
        />
      </FloorScreen>
    )
  }

  const withoutChart = subjects.filter((s) => s.specId === null)

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
        eyebrow={tui(locale, 'ui.quality.measure_eyebrow_full')}
        title={tui(locale, 'ui.quality.charts_meta', {
          measured: subjects.length - withoutChart.length,
          total: subjects.length,
        })}
        meta={
          withoutChart.length > 0
            ? tui(locale, 'ui.quality.without_chart_meta', { count: withoutChart.length })
            : undefined
        }
        ownsAmber
      />
      <MeasurementsClient subjects={subjects} />
    </FloorScreen>
  )
}
