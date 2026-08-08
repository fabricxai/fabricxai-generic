'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState, useTransition } from 'react'

import { InlineAlert, Modal, Toast } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { useLocale, useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { BreakdownGrid } from '@/components/fx/tna'
import { actionErrorMessage } from '@/lib/action-error'
import { compositeKey } from '@/lib/keys'
import { proposeOrderRevision, saveOrderBreakdown } from '@/modules/orders/actions'

interface Cell {
  color: string
  size: string
  qty: number
}

/**
 * Editing the colour × size grid (plan 5.1, audit FE-B2).
 *
 * ## Two doors, and the difference between them is who signs
 *
 * A CORRECTION is the merchandiser's own authority — a mistyped cell, a colour entered
 * twice — and it lands directly. A buyer AMENDMENT bumps `activeRevision`, which the cutting
 * floor reads to know what it is cutting to, so it goes through the approve inbox and a
 * second person reads the diff before the grid moves under people already working to the
 * old one. Both call the same service; what differs is the route and the signature.
 *
 * The screen makes somebody choose. A single "Save" that guessed from whether a reason was
 * typed would put the most consequential decision on this page behind a side effect.
 *
 * ## The diff is shown before either
 *
 * Computed here for the confirmation, and computed again server-side by `saveBreakdown` for
 * the audit row — this one is what the person is agreeing to, not what gets recorded. The
 * total is called out separately from the cells, because the number a merchandiser is
 * actually checking is whether the grid still adds up to what the buyer contracted.
 */
export function OrderBreakdown({
  cells,
  orderStyleId,
  contractedQty,
  tolerancePct,
  canWrite,
}: {
  cells: readonly Cell[]
  orderStyleId: string | null
  contractedQty: number | null | undefined
  tolerancePct: string | null | undefined
  canWrite: boolean
}) {
  const t = useT()
  const locale = useLocale()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Cell[]>([])
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)

  // The first grid is typed HERE, cell by cell — a style fresh off a won RFQ has no
  // breakdown at all, and an editor that only re-types existing cells left it permanently
  // empty (the same missing-first-row bug the costing studio had). Colour survives an add,
  // because a PO grid is entered row-major: White S, White M, White L…
  const [newColor, setNewColor] = useState('')
  const [newSize, setNewSize] = useState('')
  const [newQty, setNewQty] = useState('')

  function addCell() {
    const color = newColor.trim()
    const size = newSize.trim()
    // eslint-disable-next-line fabricxai/no-float-money -- pieces, not money
    const qty = Number.parseInt(newQty, 10)
    if (!color || !size || !Number.isInteger(qty) || qty <= 0) return

    setDraft((rows) => {
      const key = compositeKey(color, size)
      const existing = rows.findIndex((row) => compositeKey(row.color, row.size) === key)
      // The same cell typed twice is a correction of itself, not a second cell.
      if (existing >= 0) return rows.map((row, i) => (i === existing ? { ...row, qty } : row))
      return [...rows, { color, size, qty }]
    })
    setNewSize('')
    setNewQty('')
  }

  const addable =
    // eslint-disable-next-line fabricxai/no-float-money -- pieces, not money
    newColor.trim() !== '' && newSize.trim() !== '' && Number.parseInt(newQty, 10) > 0

  const original = useMemo(
    () => new Map(cells.map((c) => [compositeKey(c.color, c.size), c.qty])),
    [cells],
  )

  const changed = draft.filter((c) => (original.get(compositeKey(c.color, c.size)) ?? 0) !== c.qty)
  const draftTotal = draft.reduce((sum, c) => sum + c.qty, 0)
  const currentTotal = cells.reduce((sum, c) => sum + c.qty, 0)

  function open() {
    setDraft(cells.map((c) => ({ ...c })))
    setReason('')
    setFailure(null)
    setEditing(true)
  }

  function setQty(index: number, raw: string) {
    setDraft((rows) =>
      rows.map((row, i) =>
        i === index
          ? // eslint-disable-next-line fabricxai/no-float-money -- pieces, not money; a blank cell reads as 0 and is dropped below rather than sent
            { ...row, qty: Number.parseInt(raw, 10) || 0 }
          : row,
      ),
    )
  }

  /** Zero-quantity cells are REMOVED, not sent as zero — the grid is what exists. */
  const payloadCells = () => draft.filter((c) => c.qty > 0)

  function correct() {
    if (!orderStyleId) return
    setFailure(null)

    startTransition(async () => {
      try {
        const result = await saveOrderBreakdown({
          orderStyleId,
          cells: payloadCells(),
          buyerRevision: false,
          ...(reason.trim() ? { reason: reason.trim() } : {}),
        })

        setEditing(false)
        setToast(t('ui.orders.breakdown_corrected', { total: result.totalQty }))
        setTimeout(() => setToast(null), 5200)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.orders.breakdown_failed'), locale))
      }
    })
  }

  function amend() {
    if (!orderStyleId || reason.trim().length === 0) return
    setFailure(null)

    startTransition(async () => {
      try {
        await proposeOrderRevision({
          orderStyleId,
          cells: payloadCells(),
          reason: reason.trim(),
        })

        setEditing(false)
        setToast(t('ui.orders.revision_proposed'))
        setTimeout(() => setToast(null), 5200)
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, t('ui.orders.revision_failed'), locale))
      }
    })
  }

  return (
    <>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <BreakdownGrid
          cells={cells}
          contractedQty={contractedQty}
          tolerancePct={tolerancePct}
        />
        {canWrite && orderStyleId ? (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button variant="secondary" onClick={open}>
              {t('ui.orders.edit_breakdown')}
            </Button>
          </div>
        ) : null}
      </div>

      <Modal
        open={editing}
        onClose={() => setEditing(false)}
        title={t('ui.orders.edit_breakdown')}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {draft.length === 0 ? (
            <InlineAlert tone="info">{t('ui.orders.no_cells')}</InlineAlert>
          ) : (
            <div
              className="fx-scroll-x"
              // Focusable, or a keyboard cannot scroll it (WCAG 2.1.1). Found by 7.2's
              // axe sweep at the tablet viewport — the check 4.4 could not make when it
              // added this wrapper, because there was no browser to make it in.
              tabIndex={0}
              style={{ maxHeight: 300, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              {draft.map((cell, index) => (
                <div
                  key={compositeKey(cell.color, cell.size)}
                  className="fx-stack-tablet"
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'minmax(0, 1fr) 120px',
                    gap: 12,
                    alignItems: 'center',
                  }}
                >
                  <span style={{ font: "400 14px/1.3 var(--fx-font-sans)" }}>
                    {cell.color} · {cell.size}
                  </span>
                  <TextInput
                    label=""
                    mono
                    inputMode="numeric"
                    value={String(cell.qty)}
                    onChange={(e) => setQty(index, e.target.value)}
                  />
                </div>
              ))}
            </div>
          )}

          <div
            className="fx-stack-tablet"
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(0, 1fr) minmax(0, .7fr) 100px auto',
              gap: 10,
              alignItems: 'end',
            }}
          >
            <TextInput
              label={t('ui.orders.cell_color')}
              value={newColor}
              onChange={(e) => setNewColor(e.target.value)}
            />
            <TextInput
              label={t('ui.orders.cell_size')}
              mono
              value={newSize}
              onChange={(e) => setNewSize(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addable) addCell()
              }}
            />
            <TextInput
              label={t('ui.orders.cell_qty')}
              mono
              inputMode="numeric"
              value={newQty}
              onChange={(e) => setNewQty(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && addable) addCell()
              }}
            />
            <Button variant="secondary" onClick={addCell} disabled={!addable}>
              {t('ui.orders.add_cell')}
            </Button>
          </div>

          {/*
            * The two numbers that decide whether this is right. Shown together because a
            * grid that adds up to the contracted quantity and a grid whose cells are all
            * correct are different claims, and only one of them is checkable by eye.
            */}
          <div
            style={{
              display: 'flex',
              gap: 18,
              flexWrap: 'wrap',
              font: "400 13px/1.4 var(--fx-font-mono)",
              color: 'var(--fx-text-secondary)',
            }}
          >
            <span>{t('ui.orders.total_now', { total: currentTotal })}</span>
            <span
              style={{
                color: draftTotal === currentTotal ? undefined : 'var(--fx-warning)',
              }}
            >
              {t('ui.orders.total_after', { total: draftTotal })}
            </span>
            <span>{t('ui.orders.cells_changed', { count: changed.length })}</span>
          </div>

          <TextInput
            label={t('ui.orders.revision_reason')}
            hint={t('ui.orders.revision_reason_hint')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />

          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button variant="ghost" onClick={() => setEditing(false)}>
              {t('ui.common.cancel')}
            </Button>
            <Button
              variant="secondary"
              onClick={correct}
              disabled={pending || changed.length === 0}
            >
              {t('ui.orders.save_correction')}
            </Button>
            <Button
              variant="primary"
              onClick={amend}
              // A buyer amendment without a stated reason is a grid change nobody
              // approving it can judge, so the reason is required on this door only.
              disabled={pending || changed.length === 0 || reason.trim().length === 0}
            >
              {t('ui.orders.propose_revision')}
            </Button>
          </div>
        </div>
      </Modal>

      {toast ? (
        <div style={{ position: 'fixed', left: 28, bottom: 28, zIndex: 50, maxWidth: 460 }}>
          <Toast message={toast} />
        </div>
      ) : null}
    </>
  )
}
