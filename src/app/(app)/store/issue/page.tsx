import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { PageHeader } from '@/components/shell/page-shell'
import { tui } from '@/lib/i18n-ui'
import { requestLocale } from '@/lib/ui-locale'
import { getCtx } from '@/modules/core/session'
import { orderList } from '@/modules/orders/queries'
import {
  issuedShadeGroups,
  itemList,
  outstandingRequisitions,
  rollsForItem,
  type RollRow,
} from '@/modules/store/queries'
import { getStock } from '@/modules/store/service'

import { IssueClient } from './issue-client'
import { NewStoreRequisition } from './new-requisition'

/**
 * 3.1 Store · issue to production (canvas P3).
 *
 * The screen exists for two things a storekeeper cannot see from a number on a shelf:
 *
 *  - **Free, not on hand.** On-hand includes cloth already promised to another order.
 *    Issuing against it is how two cutting tables are sent the same roll, so the running
 *    total here is always against free.
 *  - **Shade.** Rolls carry a dye lot. Two lots in one lay is a garment that leaves with
 *    two different navies in it, found by the buyer rather than by the store — so picking
 *    across shade groups warns before the lay is spread, not after.
 *
 * Rolls are loaded per outstanding item rather than for the whole store: a storekeeper
 * issuing poplin has no use for a list of every button in the building.
 */
export const dynamic = 'force-dynamic'

export default async function StoreIssuePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const locale = await requestLocale()

  const outstanding = await outstandingRequisitions(ctx)

  // The door the desk never had: material needs are sized HERE (live-test finding,
  // Phase 4 — `createRequisition` had no caller anywhere). Orders read through the
  // owner's queries (rule 11); settled ones are not offered.
  const [orderRows, items] = await Promise.all([orderList(ctx), itemList(ctx)])
  const orders = orderRows
    .filter((row) => !['shipped_full', 'closed', 'cancelled'].includes(row.status))
    .map((row) => ({
      id: row.id,
      label: `${row.poNumbers[0] ?? row.id.slice(0, 8)} · ${row.styleCode ?? ''}`,
      qty: row.contractedQty,
    }))
  const requestDoor = <NewStoreRequisition orders={orders} items={items} />

  if (outstanding.length === 0) {
    return (
      <FloorScreen>
        <PageHeader
        back={{ href: '/store', label: 'Store' }}
          eyebrow={tui(locale, 'ui.store.issue_eyebrow')}
          title={tui(locale, 'ui.store.issue_title_empty')}
          ownsAmber
          actions={requestDoor}
        />
        <EmptyState
          title={tui(locale, 'ui.store.issue_empty_title')}
          body={tui(locale, 'ui.store.issue_empty_body')}
        />
        <FloorTabs
        tabs={[
          { href: '/store/receive', label: 'Receive' },
          { href: '/store/issue', label: 'Issue' },
          { href: '/store/rolls', label: 'Rolls' },
        ]}
      />
    </FloorScreen>
    )
  }

  const itemIds = [...new Set(outstanding.map((line) => line.itemId))]
  const orderIds = [...new Set(outstanding.map((line) => line.orderId))]
  const [stock, rollLists, shadeHistory] = await Promise.all([
    getStock(ctx, { itemIds }),
    Promise.all(itemIds.map((id) => rollsForItem(ctx, id))),
    // What each order already holds, shade-wise — the mixing warning must remember
    // yesterday's issue, not just today's pick.
    issuedShadeGroups(ctx, orderIds),
  ])

  const rollsByItem: Record<string, RollRow[]> = {}
  itemIds.forEach((id, i) => {
    // Only what is actually in the store. An issued roll is on the floor already, and a
    // pick list that offers it is a pick list somebody will act on.
    rollsByItem[id] = (rollLists[i] ?? []).filter((roll) => roll.status === 'in_stock')
  })

  const freeByItem: Record<string, string> = {}
  const onHandByItem: Record<string, string> = {}
  for (const id of itemIds) {
    freeByItem[id] = stock.get(id)?.free ?? '0'
    onHandByItem[id] = stock.get(id)?.onHand ?? '0'
  }

  return (
    <FloorScreen>
      <PageHeader
        back={{ href: '/store', label: 'Store' }}
        eyebrow={tui(locale, 'ui.store.issue_eyebrow')}
        title={tui(
          locale,
          outstanding.length === 1 ? 'ui.store.issue_title_one' : 'ui.store.issue_title_other',
          { count: outstanding.length },
        )}
        meta={tui(locale, 'ui.store.issue_meta')}
        ownsAmber
        actions={requestDoor}
      />
      <IssueClient
        lines={outstanding}
        rollsByItem={rollsByItem}
        freeByItem={freeByItem}
        onHandByItem={onHandByItem}
        shadeHistoryByOrder={shadeHistory}
      />
      <FloorTabs
        tabs={[
          { href: '/store/receive', label: 'Receive' },
          { href: '/store/issue', label: 'Issue' },
          { href: '/store/rolls', label: 'Rolls' },
        ]}
      />
    </FloorScreen>
  )
}
