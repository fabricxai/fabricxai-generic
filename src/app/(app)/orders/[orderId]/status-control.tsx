'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { setOrderStatus } from '@/modules/orders/actions'
import type { OrderStatus } from '@/modules/orders/service'

/**
 * Moving an order through its own lifecycle (live-test finding, Phase 8).
 *
 * `setOrderStatus` existed with a state machine behind it and no caller on any screen —
 * the badge showed the status and nothing could change it, so an order could never be
 * CLOSED from the product, and everything that hangs off closing (the frozen profitability
 * waterfall, the memory outcome) was unreachable. The page passes only the machine's own
 * legal next states, so this control cannot offer a move the server would refuse.
 */
export function OrderStatusControl({
  orderId,
  nextStatuses,
}: {
  orderId: string
  nextStatuses: readonly OrderStatus[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [failure, setFailure] = useState<string | null>(null)

  if (nextStatuses.length === 0) return null

  function move(status: OrderStatus) {
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await setOrderStatus({ orderId, status }))
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The order was not moved.'))
      }
    })
  }

  return (
    <span style={{ display: 'inline-flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
        {nextStatuses.map((status) => (
          <Button
            key={status}
            variant="ghost"
            disabled={pending}
            onClick={() => move(status)}
          >
            → {status.replace(/_/g, ' ')}
          </Button>
        ))}
      </span>
      {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}
    </span>
  )
}
