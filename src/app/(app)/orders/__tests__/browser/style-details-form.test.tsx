/**
 * Filling in the style's identity (design canvas, "Style & documents").
 *
 * One rule carries the whole component: a form that posts every field would blank the
 * four somebody never touched, because the service treats a present key as an instruction.
 * So these pin what actually goes over the wire — only what changed, trimmed — and that
 * the form stays shut until asked for, since the tab is opened to read far more often
 * than to correct.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StyleDetailsForm } from '../../[orderId]/style-details-form'

const updateStyleDetails = vi.fn()
const refresh = vi.fn()

vi.mock('@/modules/orders/actions', () => ({
  updateStyleDetails: (...args: unknown[]) => updateStyleDetails(...args),
}))

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

const CURRENT = {
  season: 'AW-26',
  customerLabel: null,
  patternNo: null,
  basedOnStyle: null,
  packingMethod: null,
}

beforeEach(() => {
  updateStyleDetails.mockReset().mockResolvedValue({ orderStyleId: 'style-1' })
  refresh.mockReset()
})

const open = async () => {
  const user = userEvent.setup()
  render(<StyleDetailsForm orderStyleId="style-1" current={CURRENT} />)
  await user.click(screen.getByRole('button', { name: 'Fill in style details' }))
  return user
}

describe('the style details form', () => {
  it('stays shut until asked for — the tab is for reading', () => {
    render(<StyleDetailsForm orderStyleId="style-1" current={CURRENT} />)
    expect(screen.queryByLabelText('Pattern no')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Fill in style details' })).toBeInTheDocument()
  })

  it('opens with what is already recorded, so a correction starts from the truth', async () => {
    await open()
    expect(screen.getByLabelText('Season')).toHaveValue('AW-26')
  })

  it('sends only the field that changed — the untouched ones are not blanked', async () => {
    const user = await open()

    await user.type(screen.getByLabelText('Pattern no'), 'PTN-4471')
    await user.click(screen.getByRole('button', { name: 'Save details' }))

    await waitFor(() => expect(updateStyleDetails).toHaveBeenCalledTimes(1))
    expect(updateStyleDetails).toHaveBeenCalledWith({
      orderStyleId: 'style-1',
      patternNo: 'PTN-4471',
    })
  })

  it('trims what was typed rather than storing somebody’s stray space', async () => {
    const user = await open()

    await user.type(screen.getByLabelText('Packing'), '  Flat pack  ')
    await user.click(screen.getByRole('button', { name: 'Save details' }))

    await waitFor(() => expect(updateStyleDetails).toHaveBeenCalledTimes(1))
    expect(updateStyleDetails).toHaveBeenCalledWith({
      orderStyleId: 'style-1',
      packingMethod: 'Flat pack',
    })
  })

  it('saving with nothing changed asks the server for nothing at all', async () => {
    const user = await open()
    await user.click(screen.getByRole('button', { name: 'Save details' }))

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Save details' })).not.toBeInTheDocument(),
    )
    expect(updateStyleDetails).not.toHaveBeenCalled()
  })

  it('says what went wrong in the form rather than closing on a failure', async () => {
    // The server's own words, not a generic fallback: `actionErrorMessage` prefers the
    // message that was actually thrown, which is what a bug report needs.
    updateStyleDetails.mockRejectedValueOnce(new Error('that style is not yours'))
    const user = await open()

    await user.type(screen.getByLabelText('Season'), '-X')
    await user.click(screen.getByRole('button', { name: 'Save details' }))

    await waitFor(() =>
      expect(screen.getByText('that style is not yours')).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Save details' })).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})
