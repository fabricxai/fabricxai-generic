import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { asc, eq } from 'drizzle-orm'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { defectCodes } from '@/modules/quality/schema'
import { finalInspectionLots } from '@/modules/quality/queries'
import type { QualityPolicy } from '@/modules/quality/service'
import { getPolicy } from '@/modules/settings/service'

import { FinalClient } from './final-client'

/**
 * 7.1 Quality · final inspection (canvas P4).
 *
 * ISO 2859-1 / ANSI Z1.4 single sampling, normal severity. An inspector pulls a sample from
 * a finished lot, counts defects by severity, and the plan decides.
 *
 * Four things the screen has to get right, and every one of them is a way real systems get
 * this wrong:
 *
 *  1. **Major and minor are two independent verdicts.** A buyer writes "2.5 major / 4.0
 *     minor". Netting them into one number is how a lot ships with eight major defects
 *     against a combined allowance of seventeen.
 *  2. **A critical defect has no acceptance number.** A needle in a garment fails on sight.
 *  3. **The plan is shown BEFORE the count.** An acceptance number revealed afterwards looks
 *     like something somebody chose.
 *  4. **The verdict is never the inspector's to type.** It comes back from the server, off a
 *     versioned table, snapshotted onto the row so it can be defended a year later.
 */
export const dynamic = 'force-dynamic'

export default async function FinalInspectionPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const [policy, lots, codes] = await Promise.all([
    getPolicy<QualityPolicy>(ctx, 'quality'),
    finalInspectionLots(ctx),
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          category: defectCodes.category,
          code: defectCodes.code,
          label: defectCodes.label,
          severity: defectCodes.severity,
        })
        .from(defectCodes)
        .where(eq(defectCodes.isActive, true))
        .orderBy(asc(defectCodes.severity), asc(defectCodes.label)),
    ),
  ])

  if (lots.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
          eyebrow={tui(locale, 'ui.quality.final_eyebrow')}
          title={tui(locale, 'ui.quality.final_empty_page_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.quality.final_empty_title')}
          body={tui(locale, 'ui.quality.final_empty_body')}
        />
      </FloorScreen>
    )
  }

  const failed = lots.flatMap((l) => l.history).filter((h) => h.verdict === 'fail').length

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
        eyebrow={tui(locale, 'ui.quality.final_eyebrow_full', { standard: policy.aqlStandard })}
        title={tui(
          locale,
          lots.length === 1
            ? 'ui.quality.lots_inspectable_one'
            : 'ui.quality.lots_inspectable_other',
          { count: lots.length },
        )}
        meta={
          failed > 0 ? tui(locale, 'ui.quality.lots_failed_meta', { count: failed }) : undefined
        }
        ownsAmber
      />
      <FinalClient lots={lots.map((l) => ({ ...l, history: l.history.map(toWire) }))} defects={codes} />
    </FloorScreen>
  )
}

/** Dates cross to the client as strings; everything else is already serialisable. */
function toWire<T extends { inspectedAt: Date }>(row: T): Omit<T, 'inspectedAt'> & {
  inspectedAt: string
} {
  return { ...row, inspectedAt: row.inspectedAt.toISOString() }
}
