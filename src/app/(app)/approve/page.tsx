import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { LockedState } from '@/components/fx/feedback'
import { PageHeader } from '@/components/shell/page-shell'
import { WorkCue } from '@/components/shell/work-cue'
import { canSee, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { inboxRows, listApprovalRules } from '@/modules/approvals/queries'
import type { ApprovalsPolicy } from '@/modules/approvals/service'
import { companyProfile, getPolicy } from '@/modules/settings/service'

import { WhatArrivesHere } from './what-arrives'

import { ApproveInbox } from './inbox-client'

/**
 * X.1 Approve Inbox.
 *
 * The queue is built on the SERVER from the caller's roles: `service.inbox()`
 * only returns drafts whose routing rule names a role this reviewer holds. So
 * this is not a shared queue with a filter on top — two people signed in at the
 * same time see genuinely different lists, and neither learns the size of the
 * other's.
 */
export const dynamic = 'force-dynamic'

export default async function ApprovePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const profile = await companyProfile(ctx)
  const item = NAV.find((n) => n.id === 'approve')!

  // Roles that draft but never sign land here only by deep link. They get the
  // quiet 403 card — no counts, no column headers, nothing that describes the
  // shape of what they cannot see.
  if (!canSee(item, ctx.roles, profile?.factoryType ?? 'woven')) {
    return <LockedState what="the approve inbox" />
  }

  const policy = await getPolicy<ApprovalsPolicy>(ctx, 'approvals')
  const [rows, rules] = await Promise.all([
    inboxRows(ctx, { now: new Date() }, policy),
    listApprovalRules(ctx),
  ])

  const aging = rows.filter((r) => r.aging).length

  return (
    <>
      <PageHeader
        eyebrow="Approve inbox"
        title={rows.length === 0 ? 'Nothing waiting' : `${rows.length} waiting on you`}
        meta={
          rows.length === 0
            ? "Your role's queue · oldest first"
            : aging > 0
              ? `${aging} aging · oldest first · your role's queue`
              : "Oldest first · your role's queue"
        }
        // The amber moment on this screen belongs to the one approve action in
        // the list, not to the header rule.
        ownsAmber={false}
      />
      <WorkCue
        items={
          aging > 0
            ? [
                {
                  label: `${aging} draft${aging === 1 ? '' : 's'} past ${policy.agingEscalateAfterHours}h`,
                  href: '/approve',
                },
              ]
            : rows.length > 0
              ? [{ label: `${rows.length} draft${rows.length === 1 ? '' : 's'} waiting on your role`, href: '/approve' }]
              : []
        }
      />
      {rows.length === 0 ? <WhatArrivesHere roles={ctx.roles} rules={rules} /> : null}
      <ApproveInbox
        rows={rows.map((r) => ({
          ...r,
          createdAt: r.createdAt.toISOString(),
          requiredRoles: [...r.requiredRoles],
        }))}
        escalateAfterHours={policy.agingEscalateAfterHours}
      />
    </>
  )
}
