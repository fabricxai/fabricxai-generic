/**
 * "Verify & apply" on the raiser's own reading (design canvas, MARBIM draft panel).
 *
 * The server decides whether this person may sign their own extraction; this component's
 * only job is to not offer a door that is shut, and to say plainly which of the two doors
 * a click went through. Both are worth pinning because both were wrong in the design's
 * first reading of the problem: a button that always shows would 403 half the factory, and
 * one that replaces "send for approval" would quietly remove the second signature from
 * people who wanted it.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ConfirmReading, type UnconfirmedDraft } from '../../confirm-reading'

const confirmMyDraft = vi.fn()
const discardMyDraft = vi.fn()

vi.mock('@/modules/approvals/actions', () => ({
  confirmMyDraft: (...args: unknown[]) => confirmMyDraft(...args),
  discardMyDraft: (...args: unknown[]) => discardMyDraft(...args),
}))

const draft = (canApply: boolean): UnconfirmedDraft => ({
  id: 'draft-1',
  moduleId: 'orders',
  targetTable: 'order_breakdowns',
  model: 'test-extractor',
  canApply,
  fields: [{ name: 'reason', value: 'Buyer moved volume', confidence: 0.91 }],
})

beforeEach(() => {
  confirmMyDraft.mockReset().mockResolvedValue({ id: 'draft-1', status: 'committed' })
  discardMyDraft.mockReset().mockResolvedValue(undefined)
  // The component reloads after a write; jsdom has no navigation.
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...window.location, reload: vi.fn() },
  })
})

const open = async (canApply: boolean) => {
  const user = userEvent.setup()
  render(<ConfirmReading drafts={[draft(canApply)]} />)
  await user.click(screen.getByRole('button', { name: 'Check it' }))
  return user
}

describe('the raiser’s check', () => {
  it('offers no apply button when the server did not open the door', async () => {
    await open(false)

    expect(screen.queryByRole('button', { name: 'Verify & apply' })).not.toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'This is right — send for approval' }),
    ).toBeInTheDocument()
  })

  it('offers both doors when it did, and keeps sending on as one of them', async () => {
    await open(true)

    expect(screen.getByRole('button', { name: 'Verify & apply' })).toBeInTheDocument()
    // Not replaced. Holding the document does not always mean being sure.
    expect(
      screen.getByRole('button', { name: 'Send for approval instead' }),
    ).toBeInTheDocument()
  })

  it('applying asks for the apply, and sending on does not', async () => {
    const user = await open(true)

    await user.click(screen.getByRole('button', { name: 'Verify & apply' }))
    await waitFor(() => expect(confirmMyDraft).toHaveBeenCalledTimes(1))
    expect(confirmMyDraft).toHaveBeenCalledWith({
      pendingChangeId: 'draft-1',
      corrections: {},
      apply: true,
    })
  })

  it('sending on carries no apply flag at all — absent, not false', async () => {
    const user = await open(true)

    await user.click(screen.getByRole('button', { name: 'Send for approval instead' }))
    await waitFor(() => expect(confirmMyDraft).toHaveBeenCalledTimes(1))
    // The action's zod treats absent and false the same, but sending `false` would say the
    // client had an opinion about a door it was never asked about.
    expect(confirmMyDraft).toHaveBeenCalledWith({
      pendingChangeId: 'draft-1',
      corrections: {},
    })
  })

  it('a refusal from the server stays on screen instead of closing', async () => {
    confirmMyDraft.mockRejectedValueOnce(new Error('that is not yours to sign'))
    const user = await open(true)

    await user.click(screen.getByRole('button', { name: 'Verify & apply' }))

    await waitFor(() =>
      expect(screen.getByText('that is not yours to sign')).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Verify & apply' })).toBeInTheDocument()
  })

  it('says what applying will do, and only where it is possible', async () => {
    const { unmount } = render(<ConfirmReading drafts={[draft(false)]} />)
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Check it' }))
    expect(screen.queryByText(/written straight to/)).not.toBeInTheDocument()
    unmount()

    await open(true)
    expect(screen.getByText(/written straight to/)).toBeInTheDocument()
  })
})
