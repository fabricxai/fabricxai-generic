/**
 * Starting a lay, from the path a cutting master actually takes.
 *
 * The screen is reached by pressing *start a lay* and then picking the order, which swaps the
 * client's props **without remounting it**. That is what made this screen fail: `markerId` was
 * seeded once from `markers[0]`, so a screen first rendered against a style with no marker
 * kept an empty id forever — while the `<select>` showed its first option, because a browser
 * displays one when the bound value matches nothing. Every field filled, rolls picked, and
 * "Create the lay" sat dead with nothing said (Nordkap §8, F38).
 *
 * Two things are held here: a marker that is offered is a marker that counts, and a disabled
 * button says what it is waiting for.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { LayClient } from '../../lay-client'

const capture = vi.fn()

vi.mock('@/lib/offline/use-offline-queue', () => ({
  useOfflineQueue: () => ({
    capture,
    online: true,
    queued: 0,
    syncing: false,
    refused: [],
    sync: vi.fn(),
    clear: vi.fn(),
  }),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }))

beforeEach(() => capture.mockReset().mockResolvedValue(undefined))

const ORDERS = [
  { orderId: 'order-a', orderStyleId: 'style-a', poNumber: 'POLO-2244', styleCode: 'ST-2244' },
  { orderId: 'order-b', orderStyleId: 'style-b', poNumber: 'NKA-PO-70318', styleCode: 'ST-2815' },
]

const MARKER = {
  id: 'marker-1',
  code: 'ST-2815-A',
  sizeRatio: { XS: 1, S: 2, M: 3, L: 2, XL: 1 },
  layLengthMeters: '7.20',
  efficiencyPct: null,
  fabricWidthInches: null,
}

const roll = (n: string, over: Record<string, unknown> = {}) => ({
  rollId: `roll-${n}`,
  rollNo: `R-F-${n}`,
  shadeGroup: 'A',
  dyeLot: 'HL-L1-CHM',
  qty: '26.70',
  unit: 'kg',
  itemCode: 'FAB-FLC-280',
  usedByLay: null,
  inspection: null,
  inspectionPoints: null,
  ...over,
})

/** The screen as it is reached: mounted on an order with no marker, then switched. */
function mountThenSwitch(rolls = [roll('01')]) {
  const view = render(
    <LayClient orders={ORDERS} target={ORDERS[0]!} markers={[]} rolls={[]} blocked={false} />,
  )
  view.rerender(
    <LayClient
      orders={ORDERS}
      target={ORDERS[1]!}
      markers={[MARKER] as never}
      rolls={rolls as never}
      blocked={false}
    />,
  )
  return view
}

describe('a lay can be started after switching orders', () => {
  it('1 · the marker that is offered is the marker that counts', async () => {
    const user = userEvent.setup()
    mountThenSwitch()

    // The tell of the old bug: nothing computed, because `marker` was undefined while the
    // select displayed ST-2815-A. 96 plies × the ratio is 864 pieces.
    await user.type(screen.getByRole('textbox', { name: /lay no/i }), 'LAY-41')
    await user.type(screen.getByRole('textbox', { name: /colour/i }), 'Charcoal Melange')
    await user.type(screen.getByRole('textbox', { name: /plies/i }), '96')

    // Rendered in more than one place (the eyebrow count and the yield row) — that it
    // computes at all is the point.
    expect((await screen.findAllByText(/864/)).length).toBeGreaterThan(0)
  })

  it('2 · the button enables on that path, and sends the marker with it', async () => {
    const user = userEvent.setup()
    mountThenSwitch()

    await user.type(screen.getByRole('textbox', { name: /lay no/i }), 'LAY-41')
    await user.type(screen.getByRole('textbox', { name: /colour/i }), 'Charcoal Melange')
    await user.type(screen.getByRole('textbox', { name: /plies/i }), '96')
    await user.click(screen.getByRole('button', { name: /^R-F-01/ }))

    const create = screen.getByRole('button', { name: /create the lay/i })
    expect(create).toBeEnabled()

    await user.click(create)
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'create_lay',
        payload: expect.objectContaining({ markerId: 'marker-1', plies: 96 }),
      }),
    )
  })

  it('3 · while it is disabled it says what it is waiting for', async () => {
    const user = userEvent.setup()
    mountThenSwitch()

    // In the order the form is filled — each answer moves the sentence to the next question.
    expect(screen.getByText(/waiting on the lay number/i)).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: /lay no/i }), 'LAY-41')
    expect(screen.getByText(/waiting on the colour/i)).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: /colour/i }), 'Charcoal Melange')
    expect(screen.getByText(/waiting on how many plies/i)).toBeInTheDocument()

    await user.type(screen.getByRole('textbox', { name: /plies/i }), '96')
    expect(screen.getByText(/waiting on the rolls/i)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: /^R-F-01/ }))
    expect(screen.queryByText(/waiting on/i)).toBeNull()
  })

  it('4 · a style with no marker says so rather than going quiet', () => {
    render(
      <LayClient orders={ORDERS} target={ORDERS[1]!} markers={[]} rolls={[]} blocked={false} />,
    )
    expect(screen.getByText(/waiting on a marker for this style/i)).toBeInTheDocument()
  })

  it('5 · cloth quality rejected cannot be put on the table', async () => {
    const user = userEvent.setup()
    mountThenSwitch([
      roll('01'),
      roll('17', { inspection: 'fail', inspectionPoints: '24.00' }),
    ])

    const failed = screen.getByRole('button', { name: /^R-F-17/ })
    expect(failed).toBeDisabled()
    expect(failed).toHaveTextContent(/failed 4-point/i)

    // The clean roll is the only one that can go on the table, so it still reads one roll.
    await user.click(screen.getByRole('button', { name: /^R-F-01/ }))
    expect(screen.getByText(/1 roll/i)).toBeInTheDocument()
  })
})
