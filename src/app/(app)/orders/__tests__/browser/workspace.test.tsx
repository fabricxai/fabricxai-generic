/**
 * The order workspace's four new pieces, rendered (specs/order-centric-core.md §2).
 *
 * The data behind them is integration-tested (`orderTimeline`) and unit-tested
 * (`orderPulse`); what is asserted here is that they RENDER what those produce — a
 * strip that translates its fact keys rather than printing them, a timeline that says
 * what happened in words a merchandiser reads, papers grouped by kind, and a tab strip
 * that links rather than switches client state.
 *
 * All four are server components, but pure ones — no async, no request scope — so jsdom
 * renders them directly. That is the point of keeping the I/O in the page.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/*
 * The timeline and documents tabs render `EntityRef`, whose module imports the peek
 * server action — and a `'use server'` file is an ordinary import in jsdom, so it drags
 * the db client (and `env.ts`, which refuses to load in a browser) in with it. Mocked at
 * the boundary, exactly as the drawer's own browser test does. Nothing here calls it:
 * outside the provider `EntityRef` is text, which is what these assertions read.
 */
vi.mock('@/app/actions/entity-drawer', () => ({ openEntityPeek: vi.fn() }))

import { LocaleProvider } from '@/components/fx/locale'
import type { OrderFileRef, TimelineEvent } from '@/modules/orders/queries'
import type { OrderPulse } from '@/modules/orders/service'

import { OrderDocuments } from '../../[orderId]/documents'
import { PulseStrip } from '../../[orderId]/pulse-strip'
import { OrderTimeline } from '../../[orderId]/timeline'
import { WorkspaceTabs } from '../../[orderId]/workspace-tabs'

const at = (iso: string) => new Date(iso)

describe('the pulse strip', () => {
  const pulse: OrderPulse = {
    status: 'in_production',
    next: { name: 'cutting_start', plannedDate: '2026-06-10', daysTo: 4, ownerRole: 'cutting' },
    facts: [
      { key: 'pulse.exp_missing', params: { partialNo: 2 }, severity: 'critical' },
      { key: 'pulse.milestones_at_risk', params: { count: 3 }, severity: 'warning' },
    ],
  }

  it('translates its facts with their numbers, rather than printing keys', () => {
    render(<PulseStrip pulse={pulse} locale="en" />)

    // The catalogue sentence with {partialNo} filled — a visible `pulse.exp_missing`
    // would mean the strip is showing the reader an identifier.
    expect(screen.getByText(/Shipment 2 has no EXP number/)).toBeInTheDocument()
    expect(screen.getByText(/3 milestone\(s\) at risk/)).toBeInTheDocument()
    expect(screen.queryByText(/pulse\./)).not.toBeInTheDocument()
  })

  it('says what is next and how long there is', () => {
    render(<PulseStrip pulse={pulse} locale="en" />)
    expect(screen.getByLabelText('What this order is waiting on')).toHaveTextContent(
      'cutting_start',
    )
    expect(screen.getByLabelText('What this order is waiting on')).toHaveTextContent('in 4d')
  })

  it('says overdue rather than a negative number of days', () => {
    render(
      <PulseStrip
        pulse={{ ...pulse, next: { ...pulse.next!, daysTo: -6 }, facts: [] }}
        locale="en"
      />,
    )
    expect(screen.getByLabelText('What this order is waiting on')).toHaveTextContent('6d overdue')
  })

  it('renders nothing at all when there is nothing to say', () => {
    // A banner that is always present is a banner nobody reads.
    const { container } = render(
      <PulseStrip pulse={{ status: 'closed', next: null, facts: [] }} locale="en" />,
    )
    expect(container).toBeEmptyDOMElement()
  })

  it('reads the Bangla catalogue for a Bangla device', () => {
    render(<PulseStrip pulse={pulse} locale="bn" />)
    expect(screen.getByText(/শিপমেন্ট 2/)).toBeInTheDocument()
  })
})

describe('the timeline', () => {
  const events: TimelineEvent[] = [
    { kind: 'status', at: at('2026-06-01T09:00:00Z'), byName: 'Nafisa', from: 'confirmed', to: 'in_production' },
    { kind: 'approval', at: at('2026-05-30T09:00:00Z'), byName: 'Rashed', targetTable: 'order_breakdowns', source: 'ai_extraction' },
    { kind: 'document', at: at('2026-05-29T09:00:00Z'), byName: null, documentId: 'doc-1', filename: 'po.pdf', label: 'buyer PO scan' },
    { kind: 'milestone', at: at('2026-05-28T00:00:00Z'), byName: null, name: 'fabric_in_house' },
    { kind: 'revision', at: at('2026-05-27T09:00:00Z'), byName: 'Nafisa', revision: 2, reason: 'Buyer email' },
    { kind: 'created', at: at('2026-05-01T09:00:00Z'), byName: 'Nafisa' },
  ]

  it('says what happened, in the order it was given', () => {
    render(<OrderTimeline events={events} />)
    const rows = screen.getAllByRole('listitem')
    expect(rows).toHaveLength(6)

    expect(rows[0]).toHaveTextContent('Nafisa moved it from confirmed to in_production')
    expect(rows[1]).toHaveTextContent('Rashed approved a change to order_breakdowns')
    expect(rows[3]).toHaveTextContent('fabric_in_house completed')
    expect(rows[4]).toHaveTextContent('Nafisa committed revision 2')
    expect(rows[5]).toHaveTextContent('Order opened by Nafisa')
  })

  it('names an unattributed row honestly rather than leaving a blank', () => {
    render(
      <OrderTimeline
        events={[{ kind: 'status', at: at('2026-06-01T09:00:00Z'), byName: null, from: null, to: 'closed' }]}
      />,
    )
    expect(screen.getByRole('listitem')).toHaveTextContent('the system moved it to closed')
  })

  it('a filed paper is peekable by its label', () => {
    render(<OrderTimeline events={events} />)
    // Outside the drawer provider EntityRef degrades to text, which is exactly what a
    // print view or a test should see — the label, never a raw document id.
    expect(screen.getByText('buyer PO scan')).toBeInTheDocument()
    expect(screen.queryByText('doc-1')).not.toBeInTheDocument()
  })

  it('says so when nothing has happened', () => {
    render(<OrderTimeline events={[]} />)
    expect(screen.getByText(/Nothing has happened to this order yet/)).toBeInTheDocument()
  })
})

describe('the documents tab', () => {
  const file = (over: Partial<OrderFileRef> = {}): OrderFileRef => ({
    documentId: 'doc-1',
    filename: 'po.pdf',
    label: null,
    kind: 'buyer_po',
    filedAt: at('2026-05-29T09:00:00Z'),
    ...over,
  })

  it('groups by the document’s own kind', () => {
    render(
      <OrderDocuments
        files={[
          file(),
          file({ documentId: 'doc-2', filename: 'lc.pdf', kind: 'lc' }),
          file({ documentId: 'doc-3', filename: 'lc-amend.pdf', kind: 'lc' }),
        ]}
      />,
    )
    expect(screen.getByText('buyer_po')).toBeInTheDocument()
    expect(screen.getByText('lc')).toBeInTheDocument()
  })

  it('an unclassified paper gets its own heading rather than vanishing', () => {
    render(<OrderDocuments files={[file({ kind: null })]} />)
    expect(screen.getByText('unfiled')).toBeInTheDocument()
    expect(screen.getByText('po.pdf')).toBeInTheDocument()
  })

  it('shows the filer’s label with the filename beside it', () => {
    render(<OrderDocuments files={[file({ label: 'buyer PO scan' })]} />)
    const row = screen.getByText('buyer PO scan').closest('div')!
    expect(within(row).getByText(/po\.pdf/)).toBeInTheDocument()
  })

  it('explains where papers come from when there are none', () => {
    render(<OrderDocuments files={[]} />)
    expect(screen.getByText(/No papers are filed against this order yet/)).toBeInTheDocument()
  })
})

describe('the tab strip', () => {
  it('links each tab, marks the active one, and keeps the order’s path', () => {
    render(
      <WorkspaceTabs
        tabs={[
          { id: 'overview', label: 'Overview' },
          { id: 'documents', label: 'Documents', hint: '3' },
        ]}
        active="documents"
        basePath="/orders/ord-1"
      />,
    )

    const docs = screen.getByRole('tab', { name: /Documents/ })
    expect(docs).toHaveAttribute('href', '/orders/ord-1?tab=documents')
    expect(docs).toHaveAttribute('aria-selected', 'true')
    expect(docs).toHaveTextContent('3')
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'false')
  })
})

/** The locale provider is only needed by components using `useT`; the strip takes it as a prop. */
describe('rendering inside the shell’s locale provider', () => {
  it('the timeline does not need one', () => {
    render(
      <LocaleProvider locale="bn">
        <OrderTimeline events={[{ kind: 'created', at: at('2026-05-01T09:00:00Z'), byName: 'Nafisa' }]} />
      </LocaleProvider>,
    )
    expect(screen.getByRole('listitem')).toBeInTheDocument()
  })
})
