/**
 * The date field, tested at the level where the bug actually lived.
 *
 * `<input type="date">` has no format of its own to test — it renders in whatever order the
 * BROWSER's locale prefers, so the same keystrokes produced 5 December on one machine and
 * 12 May on another, and no unit test could have told them apart. That is the whole reason
 * this control exists, and the reason its behaviour has to be pinned here: the contract is
 * "what a Bangladeshi operator types, day first, is what gets stored".
 *
 * Live test, Phase 3: LC-4471's expiry went in as `05/12/2026`, was stored as 12 May, landed
 * before the credit's latest shipment date, and surfaced as React error #441.
 */
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'

import { DateInput } from '../../forms'

/** The control as a screen uses it: parent holds ISO, field speaks dd/mm/yyyy. */
function Harness({ initial = '', onIso }: { initial?: string; onIso?: (iso: string) => void }) {
  const [value, setValue] = useState(initial)
  return (
    <>
      <DateInput
        aria-label="Expiry"
        value={value}
        onChange={(iso) => {
          setValue(iso)
          onIso?.(iso)
        }}
      />
      <output data-testid="iso">{value}</output>
    </>
  )
}

describe('a date is typed day first, whatever the browser thinks', () => {
  it('stores 5 December when 05/12 is typed — not 12 May', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText('Expiry'), '05122026')

    expect(screen.getByTestId('iso').textContent).toBe('2026-12-05')
  })

  it('shows a stored date back in the same order it was typed', () => {
    render(<Harness initial="2026-12-05" />)

    expect(screen.getByLabelText('Expiry')).toHaveValue('05/12/2026')
  })

  it('supplies the separators, so nobody types them', async () => {
    const user = userEvent.setup()
    render(<Harness />)

    const field = screen.getByLabelText('Expiry')
    await user.type(field, '0512')

    expect(field).toHaveValue('05/12')
  })

  it('holds nothing until the date is complete', async () => {
    // A half-typed date is not a date. If the parent kept the last complete value, a form
    // submitted on Enter mid-edit would save a date the person had already started changing.
    const onIso = vi.fn()
    const user = userEvent.setup()
    render(<Harness onIso={onIso} />)

    await user.type(screen.getByLabelText('Expiry'), '0512')

    expect(screen.getByTestId('iso').textContent).toBe('')
    expect(onIso).toHaveBeenLastCalledWith('')
  })

  it('refuses a day that does not exist rather than rolling it forward', async () => {
    // 31 February is 3 March to a lenient parser. A silently moved ex-factory date or CAP
    // deadline is worse than a refused one.
    const user = userEvent.setup()
    render(<Harness />)

    const field = screen.getByLabelText('Expiry')
    await user.type(field, '31022026')
    await user.tab()

    expect(screen.getByTestId('iso').textContent).toBe('')
    expect(screen.getByRole('alert')).toHaveTextContent(/dd\/mm\/yyyy/)
  })

  it('says nothing while the date is merely unfinished', async () => {
    // The complaint belongs after the person has left the field, not on their third keystroke.
    const user = userEvent.setup()
    render(<Harness />)

    await user.type(screen.getByLabelText('Expiry'), '05')

    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('lets a complete date be edited without the box emptying itself', async () => {
    // The regression this guards: deleting one digit emits '', and a naive resync from the
    // parent would read that back as "clear the field" and wipe what is still on screen.
    const user = userEvent.setup()
    render(<Harness initial="2026-12-05" />)

    const field = screen.getByLabelText('Expiry')
    await user.click(field)
    await user.keyboard('{End}{Backspace}')

    expect(field).toHaveValue('05/12/202')
    expect(screen.getByTestId('iso').textContent).toBe('')
  })

  it('follows the parent when the parent genuinely changes it', async () => {
    // A prefill, or a form reset after a save. Distinguished from the case above by
    // comparing what is typed against what arrived.
    const { rerender } = render(<DateInput aria-label="Expiry" value="" onChange={() => {}} />)
    expect(screen.getByLabelText('Expiry')).toHaveValue('')

    rerender(<DateInput aria-label="Expiry" value="2026-11-18" onChange={() => {}} />)
    expect(screen.getByLabelText('Expiry')).toHaveValue('18/11/2026')
  })

  it('keeps a calendar for the people who would rather point', () => {
    // Typing is the primary route; the picker is the convenience, and on a floor tablet it
    // is the one most people reach for.
    render(<Harness />)

    expect(screen.getByRole('button', { name: /calendar/i })).toBeInTheDocument()
  })
})
