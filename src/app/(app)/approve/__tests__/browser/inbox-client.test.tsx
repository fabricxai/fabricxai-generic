/**
 * The approve inbox, rendered (plan 7.2, audit TEST-H8).
 *
 * The screen a reviewer signs from, and the last thing standing between a model's draft and a
 * factory's order book. Until 7.2 no `.tsx` file was reachable by any test, so its keyboard
 * handling — the part a merchandiser clearing forty drafts actually uses — had never been
 * exercised.
 *
 * `j`/`k` to move, `a` to approve, `r` to reject, `x` to select. The dangerous key is `a`: it
 * approves the FOCUSED row, and a focus that has drifted from what is highlighted means
 * signing something you were not looking at.
 */
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ApproveInbox, type InboxRowView } from '../../inbox-client'

const approveDraft = vi.fn()
const rejectDraft = vi.fn()
const draftFields = vi.fn()

/*
 * The server actions are mocked at the module boundary, not stubbed inside the component.
 *
 * A server action in a jsdom test would try to POST to a Next server that is not running; what
 * this file is testing is the screen's own behaviour — which row is focused, what a key does,
 * what the reviewer is told — and the actions themselves have integration coverage.
 */
vi.mock('@/modules/approvals/actions', () => ({
  approveDraft: (...args: unknown[]) => approveDraft(...args),
  rejectDraft: (...args: unknown[]) => rejectDraft(...args),
  draftFields: (...args: unknown[]) => draftFields(...args),
}))

const row = (over: Partial<InboxRowView> = {}): InboxRowView => ({
  id: 'pc-1',
  moduleId: 'orders',
  targetTable: 'orders',
  operation: 'insert',
  source: 'ai_extraction',
  createdAt: '2026-08-01T09:00:00.000Z',
  ageHours: 3,
  weakestConfidence: 0.62,
  requiredRoles: ['merchandiser'],
  approvalsRequired: 1,
  approvals: 0,
  approvedByMe: false,
  title: 'Order SHRT-4410',
  reference: 'PO-1001',
  fromModel: true,
  aging: false,
  ...over,
})

const rows = [
  row({ id: 'pc-1', title: 'Order SHRT-4410' }),
  row({ id: 'pc-2', title: 'Order TROU-2200' }),
  row({ id: 'pc-3', title: 'Order JKT-9000' }),
]

beforeEach(() => {
  approveDraft.mockReset().mockResolvedValue({ status: 'committed', approvals: 1, approvalsRequired: 1 })
  rejectDraft.mockReset().mockResolvedValue(undefined)
  draftFields.mockReset().mockResolvedValue([])
})

describe('the empty state says whose fault the emptiness is', () => {
  it('1 · explains that drafts arrive by ROUTING, not by existing', () => {
    /*
     * A storekeeper with an empty inbox has not been forgotten — nothing has been routed to a
     * role they hold. "No items" would read as a broken screen; this reads as a fact about
     * how the queue works.
     */
    render(<ApproveInbox rows={[]} escalateAfterHours={24} />)

    expect(screen.getByText(/Nothing routed to you/i)).toBeInTheDocument()
    expect(screen.getByText(/stays in its own module/i)).toBeInTheDocument()
  })
})

describe('the keyboard is the interface', () => {
  it('2 · `a` approves the focused row, which starts at the first', async () => {
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('a')

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-1' })
  })

  it('3 · `j` moves down before `a` signs — the pairing that must not drift', async () => {
    /*
     * The dangerous case in this file. `a` approves whatever the component thinks is focused,
     * and a reviewer clearing forty drafts is reading the highlight rather than counting
     * keystrokes. Focus moving and the approval target disagreeing means signing a row you
     * were not looking at, silently, with a valid signature on it.
     */
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('jja')

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-3' })
  })

  it('4 · `k` moves back up', async () => {
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('jjka')

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-2' })
  })

  it('5 · focus stops at both ends rather than wrapping', async () => {
    // Wrapping would put `a` on the FIRST row after somebody held `j` at the bottom, which is
    // the same wrong-row signature as above arrived at from the other direction.
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('jjjjjj')
    await user.keyboard('a')

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-3' })
  })

  it('6 · `r` opens the reject dialog instead of rejecting outright', async () => {
    // Rejecting always asks for a reason: the draft goes back to whoever made it, and
    // "rejected" with no reason is a dead end they cannot act on.
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('r')

    expect(await screen.findByText(/Wrong figure read from the source/i)).toBeInTheDocument()
    expect(rejectDraft).not.toHaveBeenCalled()
  })

  it('7 · keys do nothing while the reject dialog is open', async () => {
    /*
     * A reviewer typing a reason must not be signing rows with the letters in it. `a` appears
     * in "capacity", `r` in "buyer", `x` in "duplicate of another" — this is not a hypothetical
     * collision, it is most of the alphabet a person types into an open form.
     */
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('r')
    await screen.findByText(/Wrong figure read from the source/i)

    await user.keyboard('aaa')

    expect(approveDraft).not.toHaveBeenCalled()
  })

  it('8 · typing in a field never triggers a shortcut', async () => {
    const user = userEvent.setup()
    render(
      <div>
        <input aria-label="search" />
        <ApproveInbox rows={rows} escalateAfterHours={24} />
      </div>,
    )

    await user.click(screen.getByLabelText('search'))
    await user.keyboard('a jacket')

    expect(approveDraft).not.toHaveBeenCalled()
  })
})

describe('selection', () => {
  it('9 · `x` marks a row and the count says so', async () => {
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    expect(screen.getByText(/select rows to approve in one pass/i)).toBeInTheDocument()

    await user.keyboard('x')

    expect(await screen.findByText('1 selected')).toBeInTheDocument()
  })

  it('10 · `x` twice deselects, rather than selecting twice', async () => {
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('xx')

    expect(screen.getByText(/select rows to approve in one pass/i)).toBeInTheDocument()
  })

  it('11 · select-all takes every row, and clearing it takes none', async () => {
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    const all = screen.getByRole('checkbox', { name: /select all/i })
    await user.click(all)
    expect(await screen.findByText('3 selected')).toBeInTheDocument()

    await user.click(all)
    expect(screen.getByText(/select rows to approve in one pass/i)).toBeInTheDocument()
  })
})

describe('what the reviewer is told', () => {
  it('12 · a failed approval says so instead of reporting success', async () => {
    /*
     * The worst possible outcome on this screen is a reviewer believing they signed something
     * they did not. An illegal transition, a tightened schema, a draft somebody else already
     * took — all reach here as a thrown action, and all must be visible.
     */
    /*
     * Thrown in the shape a real server action produces — `code: messageKey`, which
     * `actionErrorMessage` turns into the translated sentence. Asserting on a bare
     * `new Error('nope')` would have tested the fallback branch instead, which is the branch
     * a reviewer almost never sees.
     */
    approveDraft.mockRejectedValue(new Error('conflict: errors.illegal_transition'))
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('a')

    // The typed refusal, in words, not a silent no-op and not a success.
    expect(await screen.findByText(/cannot follow the current one/i)).toBeInTheDocument()
    expect(screen.queryByText(/Approved and committed/i)).not.toBeInTheDocument()
  })

  it('12b · an unrecognised failure still says something', async () => {
    // The fallback branch. A thrown string, a network blip, anything unkeyed — the reviewer
    // must not be left looking at a row that appears to have been signed.
    approveDraft.mockRejectedValue(new Error(''))
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('a')

    expect(await screen.findByText(/did not go through/i)).toBeInTheDocument()
  })

  it('13 · a draft needing a second signature does not claim to be committed', async () => {
    // "Approved and committed" over a row still waiting on a second approver is the same lie
    // in a friendlier tone — the change has not happened and somebody will act as though it has.
    approveDraft.mockResolvedValue({ status: 'pending', approvals: 1, approvalsRequired: 2 })
    const user = userEvent.setup()
    render(<ApproveInbox rows={rows} escalateAfterHours={24} />)

    await user.keyboard('a')

    expect(await screen.findByText(/waiting on 1 more signature/i)).toBeInTheDocument()
  })
})

/**
 * Correcting a field before signing it.
 *
 * The runbook asks a merchandiser to "correct the ship date, then approve". She could do
 * neither half: the panel rendered values as text, so a wrong field meant rejecting the
 * whole draft and asking for it again. `approveDraft` had accepted a `corrections` map since
 * the inbox was written — its own comment calls it "the correction telemetry the extractor is
 * scored on" — and nothing ever sent one.
 *
 * The keyboard case is the one worth the most care. `a` signs the FOCUSED row from a handler
 * that lives on the list, so corrections held inside a row would be invisible to it: a
 * reviewer who fixed a date and pressed `a` would have signed the ORIGINAL and been told it
 * went through.
 */
describe('a reviewer can correct a field before signing', () => {
  const draft = {
    id: 'pc-1',
    moduleId: 'rfq',
    targetTable: 'rfqs',
    targetId: null,
    operation: 'insert',
    source: 'ai_chat',
    sourceDocumentId: null,
    extractorVersion: null,
    model: 'claude-sonnet-5',
    createdAt: new Date('2026-08-01T09:00:00Z'),
    payload: {},
    fields: [
      { field: 'requestedShipDate', before: undefined, after: '2026-11-15', confidence: null, changed: true },
      { field: 'quantity', before: undefined, after: 36000, confidence: null, changed: true },
    ],
    provenance: {
      draftedBy: { id: 'day0-x-rashida', name: 'Rashida Akter' },
      approvals: [],
    },
  }

  beforeEach(() => draftFields.mockResolvedValue(draft))

  async function openRow(user: ReturnType<typeof userEvent.setup>) {
    render(<ApproveInbox rows={[row({ id: 'pc-1' })]} escalateAfterHours={24} />)
    await user.click(screen.getByRole('button', { name: /Order SHRT-4410/i }))
    await waitFor(() => expect(screen.getByLabelText('requestedShipDate')).toBeInTheDocument())
  }

  it('shows whose hands the draft has passed through — the trail a countersignature is for', async () => {
    // The data was always complete (created_by, pending_change_approvals, audit_log) and
    // reached only Settings → audit viewer, behind owner/admin. The reviewer signing the
    // draft is the one person who needs it, on the screen where they sign.
    const user = userEvent.setup()
    await openRow(user)

    expect(screen.getByText(/drafted by Rashida Akter/i)).toBeInTheDocument()
    expect(screen.getByText(/awaiting a first signature/i)).toBeInTheDocument()
  })

  it('sends the corrected value, not the drafted one', async () => {
    const user = userEvent.setup()
    await openRow(user)

    const date = screen.getByLabelText('requestedShipDate')
    await user.clear(date)
    await user.type(date, '2026-11-19')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({
      pendingChangeId: 'pc-1',
      corrections: { requestedShipDate: '2026-11-19' },
    })
  })

  it('the KEYBOARD path sees the correction too', async () => {
    // The dangerous one. `a` approves the focused row from a list-level handler; a
    // correction it could not see would be a signature on something else.
    const user = userEvent.setup()
    await openRow(user)

    const date = screen.getByLabelText('requestedShipDate')
    await user.clear(date)
    await user.type(date, '2026-11-19')
    // Click away first: `a` is deliberately ignored while a field has focus, or typing the
    // letter "a" into a date would sign the draft. Leaving the field is what a reviewer
    // does anyway before reaching for the keyboard.
    await user.click(screen.getByText(/Order SHRT-4410/i))
    await user.keyboard('a')

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft.mock.calls[0]?.[0]).toMatchObject({
      corrections: { requestedShipDate: '2026-11-19' },
    })
  })

  it('keeps a number a number, because zod re-validates at approve', async () => {
    const user = userEvent.setup()
    await openRow(user)

    const qty = screen.getByLabelText('quantity')
    await user.clear(qty)
    await user.type(qty, '35000')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft.mock.calls[0]?.[0]?.corrections).toEqual({ quantity: 35000 })
  })

  it('sends NO corrections when nothing was changed', async () => {
    /*
     * `{}` and "nothing was corrected" are the same fact, and the telemetry must not record
     * an edit that did not happen — the extractor's score depends on the difference.
     */
    const user = userEvent.setup()
    await openRow(user)
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-1' })
  })

  it('typing a field back to its drafted value is not a correction', async () => {
    // Otherwise a reviewer who clicked in, edited, and thought better of it would be
    // recorded as having fixed the field, and the extractor scored for a mistake it did
    // not make.
    const user = userEvent.setup()
    await openRow(user)

    const date = screen.getByLabelText('requestedShipDate')
    await user.clear(date)
    await user.type(date, '2026-11-15')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-1' })
  })

  it('an ai_chat draft is labelled as the model writing it, not a person typing', async () => {
    // The screen named the source `ai_chat` and then credited every field to a human.
    const user = userEvent.setup()
    await openRow(user)

    expect(screen.getAllByText(/model wrote this/i).length).toBeGreaterThan(0)
    expect(screen.queryByText(/typed by a person/i)).not.toBeInTheDocument()
  })
})

/**
 * A wrong number inside a drafted LIST.
 *
 * The scalar editor above shipped with an explicit carve-out: "a BOM's line array … stays
 * read-only, because a text box holding JSON is a way to corrupt a payload". True of a JSON
 * box, and it left the common case with no remedy at all — a tech pack states no consumption
 * for sew thread (derived from stitch length, not printed), the extractor honestly returns
 * zero, `bom_lines_consumption_positive` refuses the row, and a twelve-line BOM with eleven
 * good lines could only be rejected whole and asked for again.
 *
 * Reported from the live tenant as a Postgres INSERT statement quoted at a manager.
 */
describe('a reviewer can correct one cell of a drafted list', () => {
  const bomDraft = {
    id: 'pc-bom',
    moduleId: 'costing',
    targetTable: 'boms',
    targetId: null,
    operation: 'insert',
    source: 'ai_extraction',
    sourceDocumentId: null,
    extractorVersion: 'techpack-v4',
    model: 'gpt-4o-mini',
    createdAt: new Date('2026-08-01T09:00:00Z'),
    payload: {},
    fields: [
      {
        field: 'lines',
        before: undefined,
        confidence: 0.71,
        changed: true,
        after: [
          { lineGroup: 'fabric', itemRef: 'Body fabric', consumption: 0.255, uom: 'kg' },
          { lineGroup: 'trims', itemRef: 'Sew thread', consumption: 0, uom: '—' },
        ],
      },
    ],
    provenance: { draftedBy: { id: 'u-1', name: 'Rashida Akter' }, approvals: [] },
  }

  beforeEach(() => draftFields.mockResolvedValue(bomDraft))

  async function openBom(user: ReturnType<typeof userEvent.setup>) {
    render(<ApproveInbox rows={[row({ id: 'pc-bom', title: 'BOM ST-2610' })]} escalateAfterHours={24} />)
    await user.click(screen.getByRole('button', { name: /BOM ST-2610/i }))
    await waitFor(() =>
      expect(screen.getByLabelText('lines row 2 consumption')).toBeInTheDocument(),
    )
  }

  it('sends the WHOLE list back, with the one cell fixed', async () => {
    const user = userEvent.setup()
    await openBom(user)

    const cell = screen.getByLabelText('lines row 2 consumption')
    await user.clear(cell)
    await user.type(cell, '0.02')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({
      pendingChangeId: 'pc-bom',
      corrections: {
        lines: [
          // Untouched, and still present — `approve` merges corrections over the payload by
          // TOP-LEVEL field, so a partial list would delete the fabric line.
          { lineGroup: 'fabric', itemRef: 'Body fabric', consumption: 0.255, uom: 'kg' },
          { lineGroup: 'trims', itemRef: 'Sew thread', consumption: 0.02, uom: '—' },
        ],
      },
    })
  })

  it('keeps the drafted TYPE, so zod does not refuse it three layers later', async () => {
    const user = userEvent.setup()
    await openBom(user)

    const cell = screen.getByLabelText('lines row 2 consumption')
    await user.clear(cell)
    await user.type(cell, '0.02')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    const sent = approveDraft.mock.calls[0]?.[0]?.corrections?.lines as Record<string, unknown>[]
    // A number, not the string "0.02" a text input yields.
    expect(typeof sent[1]?.consumption).toBe('number')
  })

  it('sends nothing when a cell is typed back to what was drafted', async () => {
    // Same rule the scalar editor holds to: a reviewer clicking through every cell must not
    // be recorded as having fixed them, or the extractor is scored for mistakes it did not
    // make.
    const user = userEvent.setup()
    await openBom(user)

    const cell = screen.getByLabelText('lines row 1 consumption')
    await user.clear(cell)
    await user.type(cell, '0.255')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft).toHaveBeenCalledWith({ pendingChangeId: 'pc-bom' })
  })
})

/**
 * The decimal point, which both editors used to eat.
 *
 * A numeric field emits a NUMBER, and rendering that number back into the box mid-keystroke
 * destroys what is being typed: "16." parses to 16, the box redraws as "16", and the next
 * character lands on it — so 16.50 became 1650 and a BOM's 0.02 became 2. Silent, plausible,
 * and it lands in a price or a bill of materials.
 */
describe('typing a decimal', () => {
  const priced = {
    id: 'pc-1',
    moduleId: 'rfq',
    targetTable: 'rfqs',
    targetId: null,
    operation: 'insert',
    source: 'ai_extraction',
    sourceDocumentId: null,
    extractorVersion: 'v1',
    model: 'gpt-4o-mini',
    createdAt: new Date('2026-08-01T09:00:00Z'),
    payload: {},
    fields: [{ field: 'unitPrice', before: undefined, after: 16, confidence: 0.6, changed: true }],
    provenance: { draftedBy: { id: 'u-1', name: 'Rashida Akter' }, approvals: [] },
  }

  it('survives it on a scalar field', async () => {
    draftFields.mockResolvedValue(priced)
    const user = userEvent.setup()
    render(<ApproveInbox rows={[row({ id: 'pc-1' })]} escalateAfterHours={24} />)
    await user.click(screen.getByRole('button', { name: /Order SHRT-4410/i }))
    await waitFor(() => expect(screen.getByLabelText('unitPrice')).toBeInTheDocument())

    const price = screen.getByLabelText('unitPrice')
    await user.clear(price)
    await user.type(price, '16.50')
    await user.click(screen.getByRole('button', { name: /^approve$/i }))

    await waitFor(() => expect(approveDraft).toHaveBeenCalledOnce())
    expect(approveDraft.mock.calls[0]?.[0]?.corrections).toEqual({ unitPrice: 16.5 })
  })
})
