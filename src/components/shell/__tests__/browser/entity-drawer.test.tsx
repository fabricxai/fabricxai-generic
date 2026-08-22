/**
 * The entity drawer, rendered (spec §3).
 *
 * The server walls have integration coverage (`drawer.integration.test.ts`); what is
 * asserted here is the chrome a reader actually touches — a chip opens the peek, a
 * related chip REPLACES it with one step back rather than nesting, Escape closes, and
 * a refusal arrives as its catalogue sentence rather than a masked key.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { EntityDrawerProvider, EntityRef } from '../../entity-drawer'
import type { DrawerPeek } from '@/modules/core/drawer'

const openEntityPeek = vi.fn()

// Mocked at the module boundary, like every browser test of a screen: a server action
// in jsdom would POST to a Next server that is not running.
vi.mock('@/app/actions/entity-drawer', () => ({
  openEntityPeek: (...args: unknown[]) => openEntityPeek(...args),
}))

const orderPeek: DrawerPeek = {
  kind: 'order',
  id: 'ord-1',
  title: 'PO-BF-2044',
  subtitle: 'Borealis Fashion · ST-2610-A',
  status: { label: 'risk', tone: 'warning' },
  facts: [{ labelKey: 'ui.peek.doc_status', value: 'in_production' }],
  href: '/orders/ord-1',
  related: [{ kind: 'document', reference: 'doc-9', label: 'challan-2044.pdf' }],
}

const documentPeek: DrawerPeek = {
  kind: 'document',
  id: 'doc-9',
  title: 'challan-2044.pdf',
  subtitle: 'application/pdf',
  facts: [{ labelKey: 'ui.peek.doc_size', value: '179.1 KB', mono: true }],
}

beforeEach(() => {
  openEntityPeek.mockReset()
})

function mount() {
  return render(
    <EntityDrawerProvider>
      <EntityRef kind="order" reference="PO-BF-2044" />
    </EntityDrawerProvider>,
  )
}

describe('opening a peek', () => {
  it('a reference chip opens the drawer with the payload', async () => {
    openEntityPeek.mockResolvedValue(orderPeek)
    mount()

    await userEvent.click(screen.getByRole('button', { name: 'PO-BF-2044' }))

    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Borealis Fashion')
    expect(dialog).toHaveTextContent('in_production')
    expect(openEntityPeek).toHaveBeenCalledWith({ kind: 'order', reference: 'PO-BF-2044' })
    // The full screen stays one click away.
    expect(screen.getByRole('link', { name: /Open the full screen/ })).toHaveAttribute(
      'href',
      '/orders/ord-1',
    )
  })

  it('a refusal shows its sentence and no stale payload', async () => {
    openEntityPeek.mockResolvedValue({
      failed: true,
      code: 'forbidden',
      messageKey: 'errors.module_inactive',
    })
    mount()

    await userEvent.click(screen.getByRole('button', { name: 'PO-BF-2044' }))

    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      // The catalogue copy for module_inactive, not the raw key.
      expect(dialog).toHaveTextContent(/switched off/i),
    )
    expect(dialog).not.toHaveTextContent('PO-BF-2044')
  })
})

describe('the one-level stack', () => {
  it('a related chip replaces the peek and Back restores it without a refetch', async () => {
    openEntityPeek.mockResolvedValueOnce(orderPeek).mockResolvedValueOnce(documentPeek)
    mount()

    await userEvent.click(screen.getByRole('button', { name: 'PO-BF-2044' }))
    await screen.findByRole('dialog')

    await userEvent.click(await screen.findByRole('button', { name: 'challan-2044.pdf' }))
    await waitFor(() =>
      expect(screen.getByRole('dialog')).toHaveTextContent('application/pdf'),
    )
    // Replaced, not nested: one dialog, and the order's facts are gone.
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(screen.getByRole('dialog')).not.toHaveTextContent('in_production')

    await userEvent.click(screen.getByRole('button', { name: /Back/ }))
    expect(screen.getByRole('dialog')).toHaveTextContent('in_production')
    // Back is the page the reader just had — no second fetch for it.
    expect(openEntityPeek).toHaveBeenCalledTimes(2)
  })
})

describe('closing', () => {
  it('Escape closes and clears everything', async () => {
    openEntityPeek.mockResolvedValue(orderPeek)
    mount()

    await userEvent.click(screen.getByRole('button', { name: 'PO-BF-2044' }))
    await screen.findByRole('dialog')

    await userEvent.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('outside the provider', () => {
  it('the chip degrades to plain text', () => {
    render(<EntityRef kind="order" reference="PO-BF-2044" />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
    expect(screen.getByText('PO-BF-2044')).toBeInTheDocument()
  })
})
