/**
 * The first grid is typed in this modal (live-test finding, Phase 2).
 *
 * A style fresh off a won RFQ has NO breakdown, and the editor only rendered existing
 * cells — so the one moment the grid must be created was the one moment the modal had
 * nothing to type into, and both save buttons stayed disabled forever. Same shape as the
 * costing studio's missing add-row. These tests pin the add-cell path: cells append, the
 * same cell re-typed corrects itself instead of duplicating, and the correction door
 * sends exactly the typed grid.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { OrderBreakdown } from '../../[orderId]/breakdown-client'

const saveOrderBreakdown = vi.fn()
const proposeOrderRevision = vi.fn()
const refresh = vi.fn()

vi.mock('@/modules/orders/actions', () => ({
  saveOrderBreakdown: (...args: unknown[]) => saveOrderBreakdown(...args),
  proposeOrderRevision: (...args: unknown[]) => proposeOrderRevision(...args),
}))

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh }),
}))

beforeEach(() => {
  saveOrderBreakdown.mockReset().mockResolvedValue({ totalQty: 1200 })
  proposeOrderRevision.mockReset().mockResolvedValue({})
  refresh.mockReset()
})

function renderEmpty() {
  render(
    <OrderBreakdown
      cells={[]}
      orderStyleId="5f0d8b52-0000-4000-8000-000000000042"
      contractedQty={36_000}
      tolerancePct="3.00"
      canWrite
    />,
  )
}

async function addCell(
  user: ReturnType<typeof userEvent.setup>,
  color: string,
  size: string,
  qty: string,
) {
  const colorBox = screen.getByLabelText(/colour/i)
  await user.clear(colorBox)
  await user.type(colorBox, color)
  await user.type(screen.getByLabelText(/^size$/i), size)
  await user.type(screen.getByLabelText(/pieces/i), qty)
  await user.click(screen.getByRole('button', { name: /add the cell/i }))
}

describe('the first grid can be typed', () => {
  it('1 · an empty style offers the add-cell inputs, and a cell appears', async () => {
    const user = userEvent.setup()
    renderEmpty()
    await user.click(screen.getByRole('button', { name: /edit the breakdown/i }))

    await addCell(user, 'White', 'S', '600')

    expect(screen.getByText('White · S')).toBeTruthy()
    // Colour survives the add — the grid is entered row-major. Size and qty clear.
    expect((screen.getByLabelText(/colour/i) as HTMLInputElement).value).toBe('White')
    expect((screen.getByLabelText(/^size$/i) as HTMLInputElement).value).toBe('')
  })

  it('2 · the same cell typed twice corrects itself instead of duplicating', async () => {
    const user = userEvent.setup()
    renderEmpty()
    await user.click(screen.getByRole('button', { name: /edit the breakdown/i }))

    await addCell(user, 'White', 'S', '600')
    await addCell(user, 'White', 'S', '750')

    expect(screen.getAllByText('White · S')).toHaveLength(1)
    expect(screen.getByText(/after 750 pcs/i)).toBeTruthy()
  })

  it('3 · the correction door sends exactly the typed grid', async () => {
    const user = userEvent.setup()
    renderEmpty()
    await user.click(screen.getByRole('button', { name: /edit the breakdown/i }))

    await addCell(user, 'White', 'S', '600')
    await addCell(user, 'Navy', 'M', '600')

    await user.click(screen.getByRole('button', { name: /save as a correction/i }))

    await waitFor(() => expect(saveOrderBreakdown).toHaveBeenCalledOnce())
    expect(saveOrderBreakdown.mock.calls[0]![0]).toMatchObject({
      orderStyleId: '5f0d8b52-0000-4000-8000-000000000042',
      buyerRevision: false,
      cells: [
        { color: 'White', size: 'S', qty: 600 },
        { color: 'Navy', size: 'M', qty: 600 },
      ],
    })
  })

  it('4 · nothing typed, nothing addable — the button waits', async () => {
    const user = userEvent.setup()
    renderEmpty()
    await user.click(screen.getByRole('button', { name: /edit the breakdown/i }))

    expect(
      (screen.getByRole('button', { name: /add the cell/i }) as HTMLButtonElement).disabled,
    ).toBe(true)
  })
})
