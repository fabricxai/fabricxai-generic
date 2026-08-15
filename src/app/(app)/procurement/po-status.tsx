'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { updatePoStatus } from '@/modules/procurement/actions'
import { manualPoTransitions } from '@/modules/procurement/procurement'

/**
 * Moving a purchase order along its life (finding F20, Nordkap §5 walk).
 *
 * `updatePoStatus` has existed with a role wall, a state machine and an audit interceptor
 * behind it, and no screen ever called it. So an order could be issued and then never
 * acknowledged, never cancelled, never touched again — and a factory's answer to a PO raised
 * in error became "leave it there", which is how a mill ends up weaving against something
 * nobody meant to place. Cancelling one took a container and a script.
 *
 * **Only the moves that are a person's.** `manualPoTransitions` omits `received` and
 * `received_partial` on purpose: those are what the store books when goods arrive, and a
 * status typed by hand here would claim a delivery no receipt supports.
 *
 * **Cancelling asks first, in the row.** It is the one move that cannot be undone — the
 * machine makes `cancelled` terminal — so it takes two deliberate presses rather than one
 * misplaced click on a line somebody was only reading. Not a modal: a dialog over a table
 * hides the row you are deciding about.
 */
const LABEL: Record<string, string> = {
  confirmed: 'Confirm',
  in_production: 'On the loom',
  shipped: 'Shipped',
  cancelled: 'Cancel',
}

/** What each move means, for the title attribute — the words a buyer would use. */
const MEANS: Record<string, string> = {
  confirmed: 'the supplier has acknowledged this order',
  in_production: 'the supplier has started making it',
  shipped: 'it has left the supplier',
  cancelled: 'this order should never have been placed — nothing is owed on it',
}

export function PoStatusControl({
  supplierPoId,
  poNumber,
  status,
}: {
  supplierPoId: string
  poNumber: string
  status: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const moves = manualPoTransitions(status)
  if (moves.length === 0) return null

  function move(next: string) {
    setFailure(null)
    startTransition(async () => {
      try {
        unwrap(await updatePoStatus({ supplierPoId, status: next as 'confirmed' }))
        setConfirmingCancel(false)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, `${poNumber} did not move.`))
      }
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5, alignItems: 'flex-end' }}>
      {confirmingCancel ? (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span
            style={{
              font: "400 11.5px/1.3 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
            }}
          >
            Cancel {poNumber}?
          </span>
          <Button size="sm" variant="danger" disabled={pending} onClick={() => move('cancelled')}>
            {pending ? 'Cancelling…' : 'Yes, cancel it'}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setConfirmingCancel(false)}>
            Keep it
          </Button>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {moves.map((next) =>
            next === 'cancelled' ? (
              <Button
                key={next}
                size="sm"
                variant="ghost"
                disabled={pending}
                title={MEANS[next]}
                onClick={() => setConfirmingCancel(true)}
              >
                {LABEL[next]}
              </Button>
            ) : (
              <Button
                key={next}
                size="sm"
                variant="secondary"
                disabled={pending}
                title={MEANS[next]}
                onClick={() => move(next)}
              >
                {pending ? '…' : LABEL[next]}
              </Button>
            ),
          )}
        </div>
      )}

      {failure ? (
        <span
          style={{
            font: "400 11.5px/1.4 var(--fx-font-sans)",
            color: 'var(--fx-danger)',
            textAlign: 'right',
            maxWidth: 220,
          }}
        >
          {failure}
        </span>
      ) : null}
    </div>
  )
}
