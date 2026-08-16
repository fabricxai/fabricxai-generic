/**
 * Sending a roll back to the rack.
 *
 * `rollMachine` has allowed `issued → returned` since it was written and nothing could make
 * the move — the three rolls that failed 4-point and were issued before the gate could see
 * them had to be fetched home with a script. What is tested here is the storekeeper's half:
 * the door only appears on a roll that actually went out, and it will not open a return
 * without a reason, because the reason is what explains a returned bonded draw to whoever
 * reads the declaration months later.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { RollsClient } from '../../rolls-client'

const capture = vi.fn()
const refresh = vi.fn()

// The floor writes through the offline queue (rule 7), so that is the boundary to mock —
// the rack is where the signal is worst and a return must survive being offline.
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

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))
vi.mock('@/modules/store/actions', () => ({ draftStockAdjustment: vi.fn() }))

beforeEach(() => {
  capture.mockReset().mockResolvedValue(undefined)
  refresh.mockReset()
})

const ITEMS = [
  { itemId: 'item-1', code: 'FAB-FLC-280', name: 'brushed back fleece', onHand: '900.00', unit: 'kg', rollCount: 3 },
]

const roll = (over: Record<string, unknown> = {}) => ({
  id: 'roll-issued',
  rollNo: 'R-F-17',
  lot: 'HL-L1-CHM',
  dyeLot: 'HL-L1-CHM',
  shadeGroup: 'A',
  qty: '25.40',
  unit: 'kg',
  status: 'issued',
  locationCode: 'BOND-1',
  locationKind: 'bonded',
  receivedAt: '2026-11-12',
  challanNo: 'ZJH-DC-8842',
  udId: 'ud-1',
  udNumber: 'UD-2026-058',
  ...over,
})

const view = (rolls: ReturnType<typeof roll>[]) =>
  render(<RollsClient items={ITEMS} selectedItemId="item-1" rolls={rolls as never} />)

describe('a roll can be sent back from the rack', () => {
  it('1 · offers the door only on a roll that actually went out', () => {
    view([
      roll(),
      roll({ id: 'roll-in-stock', rollNo: 'R-F-18', status: 'in_stock' }),
      roll({ id: 'roll-adjusted', rollNo: 'R-F-19', status: 'adjusted_out' }),
    ])

    // One issued roll, one door.
    expect(screen.getAllByRole('button', { name: /send back/i })).toHaveLength(1)
    // A roll on the rack is adjusted, not returned; one written off is neither.
    expect(screen.getAllByRole('button', { name: /adjust/i })).toHaveLength(1)
  })

  it('2 · will not send it back without a reason, and says which declaration is affected', async () => {
    const user = userEvent.setup()
    view([roll()])

    await user.click(screen.getByRole('button', { name: /send back/i }))
    const dialog = screen.getByRole('dialog')

    // The bonded warning names the declaration by NUMBER — never its id.
    expect(within(dialog).getByText(/UD-2026-058/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/ud-1/)).toBeNull()

    const submit = within(dialog).getByRole('button', { name: /send it back/i })
    expect(submit).toBeDisabled()

    // Ten characters is the floor the payload sets; the screen refuses first, at the one
    // moment somebody is looking.
    await user.type(within(dialog).getByRole('textbox'), 'wrong')
    expect(submit).toBeDisabled()

    await user.type(within(dialog).getByRole('textbox'), ' shade for the lay')
    expect(submit).toBeEnabled()
  })

  it('3 · sends the roll and its reason through the offline queue', async () => {
    const user = userEvent.setup()
    view([roll()])

    await user.click(screen.getByRole('button', { name: /send back/i }))
    const dialog = screen.getByRole('dialog')
    await user.type(within(dialog).getByRole('textbox'), 'failed 4-point, held for the claim')
    await user.click(within(dialog).getByRole('button', { name: /send it back/i }))

    expect(capture).toHaveBeenCalledWith({
      moduleId: 'store',
      operation: 'return_rolls',
      payload: { rollIds: ['roll-issued'], reason: 'failed 4-point, held for the claim' },
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('4 · a general-stock roll is returned without a bonded warning', async () => {
    const user = userEvent.setup()
    view([roll({ udId: null, udNumber: null, locationKind: 'general', locationCode: 'GEN-1' })])

    await user.click(screen.getByRole('button', { name: /send back/i }))
    const dialog = screen.getByRole('dialog')

    // Nothing was drawn against a declaration, so nothing is given back — saying otherwise
    // would teach a storekeeper that every return touches customs.
    expect(within(dialog).queryByText(/UD-/)).toBeNull()
  })
})
