/**
 * A line with nothing planned says so, rather than showing a target of zero (§9, F47).
 *
 * Zero is a number, and the screen printed it where the office's target goes — while nothing
 * measured against it: the board's achieved percentage needs a denominator, and the day-close
 * skips a line with no plan entirely. A supervisor entered a day's output believing it was
 * being counted, and no figure was ever produced from it.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { HourlyClient } from '../../hourly-client'

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

const line = (over: Record<string, unknown> = {}) => ({
  lineId: 'line-1',
  code: 'L1',
  name: 'Line 1',
  target: 145,
  orderId: 'order-1',
  alreadyEntered: false,
  ...over,
})

function mount(lines: Record<string, unknown>[]) {
  render(
    <HourlyClient
      producedOn="2026-08-17"
      hour={9}
      lines={lines as never}
      machines={[]}
      stoppages={[]}
    />,
  )
}

describe('the hourly screen and a line nobody planned', () => {
  it('1 · shows the target when there is one', () => {
    mount([line()])
    expect(screen.getByText(/target 145/i)).toBeInTheDocument()
  })

  it('2 · says there is no plan rather than printing a target of zero', () => {
    mount([line({ target: null })])

    expect(screen.queryByText(/target 0/i)).toBeNull()
    expect(screen.getByText(/no plan today/i)).toBeInTheDocument()
  })

  it('3 · says what that costs, so it is not read as a detail', () => {
    // The consequence is the whole point: the hour is recorded and never measured.
    mount([line({ target: null })])
    expect(screen.getByText(/will not be measured/i)).toBeInTheDocument()
  })

  it('4 · still lets the hour be entered — output happened either way', async () => {
    // Refusing the write would lose a real number to punish a missing plan.
    const user = userEvent.setup()
    mount([line({ target: null })])

    await user.type(screen.getByRole('textbox'), '118')
    await user.click(screen.getByRole('button', { name: /save hour/i }))

    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'record_hourly_outputs',
        payload: expect.objectContaining({
          entries: [expect.objectContaining({ lineId: 'line-1', actual: 118, target: 0 })],
        }),
      }),
    )
  })
})
