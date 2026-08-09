import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { inspectableGrns } from '@/modules/quality/queries'
import type { QualityPolicy } from '@/modules/quality/service'
import { companyProfile, getPolicy } from '@/modules/settings/service'

import { FabricClient } from './fabric-client'

/**
 * 7.1 Quality · 4-point fabric inspection (canvas P2).
 *
 * The inspection frame. A roll is run over a lit table, faults are counted into four penalty
 * bands, and the total is normalised to points per hundred square yards — a RATE, because
 * the same twelve faults is a pass on a 60" roll and a fail on a 36" one.
 *
 * This screen is the reason a woven store cannot issue uninspected fabric: `GATES.fabric
 * Inspection` fails closed, so until somebody stands here and records a result, the rolls
 * do not move. That is deliberate. Fabric faults found on the cutting table have already
 * cost the marker, the lay and the labour, and by then the mill will say the damage
 * happened in this building.
 */
export const dynamic = 'force-dynamic'

export default async function FabricInspectionPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const [policy, profile, grns] = await Promise.all([
    getPolicy<QualityPolicy>(ctx, 'quality'),
    companyProfile(ctx),
    inspectableGrns(ctx, {}),
  ])

  const woven = (profile?.factoryType ?? 'woven') === 'woven'
  const awaiting = grns.filter((g) => g.uninspected > 0)

  if (grns.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
          eyebrow={tui(locale, 'ui.quality.fabric_eyebrow')}
          title={tui(locale, 'ui.quality.fabric_empty_page_title')}
          ownsAmber
        />
        <EmptyState
          title={tui(locale, 'ui.quality.fabric_empty_title')}
          body={tui(locale, 'ui.quality.fabric_empty_body')}
        />
      </FloorScreen>
    )
  }

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/quality', label: 'Quality' }}
        eyebrow={tui(locale, 'ui.quality.fabric_eyebrow_full')}
        title={
          awaiting.length > 0
            ? tui(
                locale,
                awaiting.length === 1
                  ? 'ui.quality.deliveries_awaiting_one'
                  : 'ui.quality.deliveries_awaiting_other',
                { count: awaiting.length },
              )
            : tui(locale, 'ui.quality.all_graded')
        }
        meta={tui(locale, 'ui.quality.fabric_pass_meta', {
          threshold: policy.fabricMaxPointsPer100SqYd,
        })}
        ownsAmber
      />
      <FabricClient
        grns={grns}
        threshold={policy.fabricMaxPointsPer100SqYd}
        // Knit composites grade greige on the machine, so the store gate does not apply and
        // this screen should not imply that production is waiting on it.
        mandatory={woven}
      />
    </FloorScreen>
  )
}
