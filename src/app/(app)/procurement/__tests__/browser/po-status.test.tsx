/**
 * Moving a purchase order along its life (finding F20).
 *
 * The interesting behaviour is what this control refuses to offer. `updatePoStatus` sat
 * behind a role wall and a state machine with no caller at all, so the risk in giving it one
 * is offering a move the server will refuse — or worse, one it will accept and should not.
 *
 * Two of those matter here. `received` is derived from what the store books at the gate, so
 * it must never be a button: a status typed by hand would claim a delivery no receipt
 * supports. And `cancelled` is terminal, so it takes a second, deliberate press — a table is
 * read far more often than it is acted on.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { PoStatusControl } from '../../po-status'

const updatePoStatus = vi.fn()
const refresh = vi.fn()

// Mocked at the module boundary: a server action in jsdom would POST to a server that is
// not running. The gate itself has its own integration coverage.
vi.mock('@/modules/procurement/actions', () => ({
  updatePoStatus: (...args: unknown[]) => updatePoStatus(...args),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

beforeEach(() => {
  updatePoStatus.mockReset().mockResolvedValue(undefined)
  refresh.mockReset()
})

const row = (status: string) => (
  <PoStatusControl supplierPoId="po-1" poNumber="PO-2815-F" status={status} />
)

describe('a purchase order can finally be moved along', () => {
  it('1 · offers a freshly issued order the two moves that are a person’s', () => {
    render(row('issued'))

    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeEnabled()
    // Not this one, ever: a receipt says goods arrived, not a button.
    expect(screen.queryByRole('button', { name: /received/i })).toBeNull()
  })

  it('2 · never offers a status the store derives from receipts', () => {
    for (const status of ['issued', 'confirmed', 'in_production']) {
      const { unmount } = render(row(status))
      expect(screen.queryByRole('button', { name: /received/i })).toBeNull()
      unmount()
    }
  })

  it('3 · renders nothing at all once only a receipt can move it', () => {
    for (const status of ['shipped', 'received_partial', 'received', 'cancelled']) {
      const { container, unmount } = render(row(status))
      expect(container).toBeEmptyDOMElement()
      unmount()
    }
  })

  it('4 · sends the move and refreshes the row', async () => {
    const user = userEvent.setup()
    render(row('issued'))

    await user.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(updatePoStatus).toHaveBeenCalledWith({ supplierPoId: 'po-1', status: 'confirmed' })
    expect(refresh).toHaveBeenCalled()
  })

  it('5 · cancelling asks first, and one press alone does not cancel', async () => {
    const user = userEvent.setup()
    render(row('issued'))

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))

    // Nothing has been sent yet — the row is asking, by name.
    expect(updatePoStatus).not.toHaveBeenCalled()
    expect(screen.getByText(/cancel PO-2815-F\?/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /yes, cancel it/i }))
    expect(updatePoStatus).toHaveBeenCalledWith({ supplierPoId: 'po-1', status: 'cancelled' })
  })

  it('6 · backing out of a cancel leaves the order exactly as it was', async () => {
    const user = userEvent.setup()
    render(row('issued'))

    await user.click(screen.getByRole('button', { name: /^cancel$/i }))
    await user.click(screen.getByRole('button', { name: /keep it/i }))

    expect(updatePoStatus).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: /^confirm$/i })).toBeEnabled()
  })

  it('7 · a refused move is shown as the server’s own sentence, not swallowed', async () => {
    const user = userEvent.setup()
    // The shape `surfaced()` returns: a refusal as a value, which `unwrap` re-throws.
    updatePoStatus.mockResolvedValue({
      failed: true,
      code: 'conflict',
      messageKey: 'procurement.errors.po_illegal_transition',
      reason: 'A received order cannot be cancelled.',
    })
    render(row('issued'))

    await user.click(screen.getByRole('button', { name: /^confirm$/i }))

    expect(await screen.findByText(/a received order cannot be cancelled\./i)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})
