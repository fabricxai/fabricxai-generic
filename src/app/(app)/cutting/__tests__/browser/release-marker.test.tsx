/**
 * Releasing a marker off the CAD plan.
 *
 * The lay screen has always refused without one, and nothing in the product could release
 * one: the cutting module had no actions file, `createMarker` sat in the service with no
 * caller, and the only route was asking MARBIM to draft it in conversation (Nordkap §8, F37).
 *
 * What matters in the form is the ratio. It is **per ply** — the lay multiplies it by the
 * number of plies — so a cell typed wrong cuts the wrong garment count for every ply in the
 * spread, and an empty marker costs fabric and yields nothing.
 */
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ReleaseMarkerButton } from '../../release-marker'

const releaseMarker = vi.fn()
const refresh = vi.fn()

vi.mock('@/modules/cutting/actions', () => ({
  releaseMarker: (...args: unknown[]) => releaseMarker(...args),
}))
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh }) }))

beforeEach(() => {
  releaseMarker.mockReset().mockResolvedValue({ markerId: 'marker-1' })
  refresh.mockReset()
})

const STYLES = ['ST-2244', 'ST-2815']

async function openForm(user: ReturnType<typeof userEvent.setup>) {
  render(<ReleaseMarkerButton styles={STYLES} />)
  await user.click(screen.getByRole('button', { name: /release a marker/i }))
  return screen.getByRole('dialog')
}

describe('a marker can be released without asking the assistant', () => {
  it('1 · refuses a marker with nothing in it', async () => {
    const user = userEvent.setup()
    const dialog = await openForm(user)

    const submit = within(dialog).getByRole('button', { name: /release it/i })
    expect(submit).toBeDisabled()

    await user.type(within(dialog).getByRole('textbox', { name: /marker code/i }), 'ST-2815-A')
    await user.type(within(dialog).getByRole('combobox', { name: /^style$/i }), 'ST-2815')
    await user.type(within(dialog).getByRole('textbox', { name: /lay length/i }), '7.20')

    // Everything filled except the thing that decides what gets cut.
    expect(submit).toBeDisabled()
    expect(
      within(dialog).getByText(/costs fabric and yields no garments/i),
    ).toBeInTheDocument()
  })

  it('2 · says what one ply makes as the ratio is typed', async () => {
    const user = userEvent.setup()
    const dialog = await openForm(user)

    await user.type(within(dialog).getByRole('textbox', { name: 'XS' }), '1')
    expect(within(dialog).getByText(/one ply makes 1 piece\./i)).toBeInTheDocument()

    await user.type(within(dialog).getByRole('textbox', { name: 'S' }), '2')
    await user.type(within(dialog).getByRole('textbox', { name: 'M' }), '3')
    await user.type(within(dialog).getByRole('textbox', { name: 'L' }), '2')
    await user.type(within(dialog).getByRole('textbox', { name: 'XL' }), '1')

    // The Nordkap marker: 1·2·3·2·1 across five sizes.
    expect(within(dialog).getByText(/one ply makes 9 pieces\./i)).toBeInTheDocument()
  })

  it('3 · sends the ratio as numbers, dropping the sizes left blank', async () => {
    const user = userEvent.setup()
    const dialog = await openForm(user)

    await user.type(within(dialog).getByRole('textbox', { name: /marker code/i }), 'ST-2815-A')
    await user.type(within(dialog).getByRole('combobox', { name: /^style$/i }), 'ST-2815')
    await user.type(within(dialog).getByRole('textbox', { name: /lay length/i }), '7.20')
    const RATIO: readonly (readonly [string, string])[] = [
      ['XS', '1'], ['S', '2'], ['M', '3'], ['L', '2'], ['XL', '1'],
    ]
    for (const [size, n] of RATIO) {
      await user.type(within(dialog).getByRole('textbox', { name: size }), n)
    }

    await user.click(within(dialog).getByRole('button', { name: /release it/i }))

    expect(releaseMarker).toHaveBeenCalledWith({
      code: 'ST-2815-A',
      styleCode: 'ST-2815',
      // XXL was left blank: absent, not zero. A marker that cuts no XXL does not list it.
      sizeRatio: { XS: 1, S: 2, M: 3, L: 2, XL: 1 },
      layLengthMeters: '7.20',
    })
    expect(refresh).toHaveBeenCalled()
  })

  it('4 · a refusal from the server is shown as its own sentence', async () => {
    const user = userEvent.setup()
    releaseMarker.mockResolvedValue({
      failed: true,
      code: 'conflict',
      messageKey: 'cutting.errors.marker_code_exists',
      reason: 'A marker called ST-2815-A already exists.',
    })
    const dialog = await openForm(user)

    await user.type(within(dialog).getByRole('textbox', { name: /marker code/i }), 'ST-2815-A')
    await user.type(within(dialog).getByRole('combobox', { name: /^style$/i }), 'ST-2815')
    await user.type(within(dialog).getByRole('textbox', { name: /lay length/i }), '7.20')
    await user.type(within(dialog).getByRole('textbox', { name: 'M' }), '3')
    await user.click(within(dialog).getByRole('button', { name: /release it/i }))

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument()
    expect(refresh).not.toHaveBeenCalled()
  })
})
