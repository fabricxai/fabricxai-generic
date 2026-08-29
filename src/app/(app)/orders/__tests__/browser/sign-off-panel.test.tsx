/**
 * The sign-off panel, rendered (design canvas, order dossier).
 *
 * `sign-off.test.ts` pins what each row SAYS. This pins the one thing only the rendering
 * can get wrong: that an unanswered row still looks unanswered. A grey dot and a passed
 * gate are the same shape at a glance, and a panel whose absences read as ticks is worse
 * than no panel — somebody stops chasing a department that has not started.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { SignOffRow } from '../../[orderId]/sign-off'
import { SignOffPanel } from '../../[orderId]/sign-off-panel'

const rows: SignOffRow[] = [
  {
    key: 'quote',
    label: 'Price quote returned',
    detail: 'FOB 4.8500 USD · quote v2, sent 2026-05-13',
    badge: 'v2',
    state: 'done',
    href: '/rfq?rfq=rfq-1',
  },
  {
    key: 'confirmation_sheet',
    label: 'Order confirmation sheet',
    detail: 'Not recorded here. FabricXAI has no confirmation sheet and no signature chain.',
    badge: null,
    state: 'unmodelled',
    href: null,
  },
  {
    key: 'credit',
    label: 'Credit and back-to-back headroom',
    detail: 'No letter of credit is linked to this order.',
    badge: null,
    state: 'none',
    href: null,
  },
]

describe('the sign-off panel', () => {
  it('says in words that a row is not recorded, not only in grey', () => {
    render(<SignOffPanel rows={rows} />)

    const sheet = screen.getByText('Order confirmation sheet').closest('li')!
    expect(within(sheet).getByText('not recorded here')).toBeInTheDocument()
  })

  it('does not put that label on a row that is merely empty', () => {
    // "Nothing recorded" and "we cannot record this" are different problems with different
    // owners: one is a colleague to chase, the other is a gap in the product.
    render(<SignOffPanel rows={rows} />)

    const credit = screen.getByText('Credit and back-to-back headroom').closest('li')!
    expect(within(credit).queryByText('not recorded here')).not.toBeInTheDocument()
    expect(within(credit).getByText('No letter of credit is linked to this order.')).toBeInTheDocument()
  })

  it('offers a way in only where the module has a screen', () => {
    render(<SignOffPanel rows={rows} />)

    const links = screen.getAllByRole('link', { name: 'Open' })
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/rfq?rfq=rfq-1')
  })

  it('counts only the gates that can be answered', () => {
    /*
     * Two of these three cannot be passed — one is unmodelled, one has nothing recorded.
     * A heading reading "1 of 3" would be right; "1 of 2" is the honest score, because a
     * gate the platform does not hold is not a gate the factory is failing.
     */
    render(<SignOffPanel rows={rows} />)

    expect(screen.getByText(/1 of 2 gates passed/)).toBeInTheDocument()
  })
})
