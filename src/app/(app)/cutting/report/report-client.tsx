'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { ReadIntoForm, type ReadFields } from '@/components/shell/read-into-form'
import { SyncPill } from '@/components/fx/floor'
import { useT } from '@/components/fx/locale'
import { Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import type { LayForReport } from '@/modules/cutting/queries'

/**
 * Cut against plan.
 *
 * The grid starts pre-filled with what the marker says the lay yields, because that is what
 * a cutter is confirming nine times out of ten — and typing four numbers that are already
 * known is how a wrong one gets typed. Every cell is editable; the difference from expected
 * is shown as it changes, not after saving.
 *
 * **Over tolerance does not block.** The service records the report either way and stores
 * the variance for the manager, which is right: the pieces are already cut, and refusing to
 * write down what happened does not un-cut them. What the screen owes is that nobody can
 * file an out-of-tolerance report without having seen that it is out of tolerance.
 */
export function ReportClient({
  lay,
  openLays,
  tolerancePct,
}: {
  lay: LayForReport
  openLays: readonly { id: string; layNo: string; color: string }[]
  tolerancePct: string
}) {
  const t = useT()
  const router = useRouter()
  const { capture, online, queued, syncing, refused, sync, clear } = useOfflineQueue()

  const [actual, setActual] = useState<Record<string, string>>(() =>
    Object.fromEntries(lay.cells.map((cell) => [cell.size, String(cell.expected)])),
  )
  const [filed, setFiled] = useState<string | null>(null)
  const [readNote, setReadNote] = useState<string | null>(null)

  /**
   * The cut sheet off the table.
   *
   * Only the ACTUAL column is taken. A sheet prints the marker ratio, the expected figure
   * and what came off side by side, and the short row is the entire point of the document —
   * a size that came out under plan is what the report exists to record, so nothing here
   * quietly rounds it up to the expectation the screen has already prefilled.
   *
   * The lay is NOT switched from the reading. This screen is already open on one lay; a
   * photograph naming a different one is somebody about to file the wrong table's numbers,
   * and the honest answer is to say so rather than to follow the paper.
   */
  function fillFromSheet(read: ReadFields) {
    const str = (x: unknown) => (x === null || x === undefined ? '' : String(x))
    const sheetLay = str(read.values.layNo).toLowerCase().replace(/[^a-z0-9]/g, '')
    const thisLay = lay.layNo.toLowerCase().replace(/[^a-z0-9]/g, '')

    if (sheetLay && sheetLay !== thisLay) {
      setReadNote(
        `That sheet is for ${str(read.values.layNo)} and this is ${lay.layNo}. Open the right lay before filing it.`,
      )
      return
    }

    const cells = Array.isArray(read.values.cells)
      ? (read.values.cells as Record<string, unknown>[])
      : []
    const bySize = new Map(cells.map((cell) => [str(cell.size).toUpperCase(), str(cell.cut)]))

    const missed: string[] = []
    setActual((prev) => {
      const next = { ...prev }
      for (const cell of lay.cells) {
        const found = bySize.get(cell.size.toUpperCase())
        if (found !== undefined && found !== '') next[cell.size] = found
        else missed.push(cell.size)
      }
      return next
    })

    setReadNote(
      missed.length > 0
        ? `The sheet has nothing for ${missed.join(', ')} — those are still the expected figures, not counted ones.`
        : null,
    )
  }

  const tolerance = Number(tolerancePct)

  const rows = lay.cells.map((cell) => {
    const entered = Number(actual[cell.size] ?? '')
    const cut = Number.isFinite(entered) ? entered : 0
    const variance = cut - cell.expected
    // Against what this LAY should have produced, not against the order — a lay is judged
    // on its own marker, and the order's completion is a separate question.
    const variancePct = cell.expected > 0 ? Math.abs(variance / cell.expected) * 100 : 0
    return { ...cell, cut, variance, outside: variancePct > tolerance && variance !== 0 }
  })

  const totalExpected = rows.reduce((n, r) => n + r.expected, 0)
  const totalCut = rows.reduce((n, r) => n + r.cut, 0)
  // Garments are an integer count, not money — the lint rule matches on the name. Summing
  // pieces is exact; there is no decimal to lose.
  // eslint-disable-next-line fabricxai/no-float-money
  const totalDifference = totalCut - totalExpected
  const outside = rows.filter((r) => r.outside)
  const valid = rows.every((r) => Number.isFinite(r.cut) && r.cut >= 0) && totalCut > 0

  async function file() {
    if (!valid) return

    await capture({
      moduleId: 'cutting',
      operation: 'record_cut_report',
      payload: {
        layId: lay.layId,
        // "Colour|Size" — the only key shape `cutting/zod.ts` accepts.
        cells: Object.fromEntries(rows.map((r) => [`${lay.color}|${r.size}`, r.cut])),
      },
    })

    setFiled(t('ui.cutting.report_filed_summary', { layNo: lay.layNo, count: totalCut }))
    router.refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 24 }}>
      <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />

      <ReadIntoForm kindId="cut_sheet" prompt="the cutting sheet" onFilled={fillFromSheet} />
      {readNote ? <InlineAlert tone="warning">{readNote}</InlineAlert> : null}

      {refused.length > 0 ? (
        <InlineAlert tone="danger">
          {t.plural('ui.cutting.reports_refused', refused.length)}
          {refused.map((r) => (
            <button
              key={r.offlineKey}
              onClick={() => void clear(r.offlineKey)}
              style={{
                marginLeft: 8,
                background: 'transparent',
                border: 'none',
                textDecoration: 'underline',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {t('ui.common.dismiss')}
            </button>
          ))}
        </InlineAlert>
      ) : null}

      {filed ? (
        <InlineAlert tone="success">
          {t('ui.cutting.report_filed', { summary: filed })}{' '}
          {online ? t('ui.cutting.sent') : t('ui.cutting.held_offline')}{' '}
          {t('ui.cutting.report_filed_note')}
        </InlineAlert>
      ) : null}

      {openLays.length > 1 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {openLays.map((l) => (
            <button
              key={l.id}
              onClick={() => router.push(`/cutting/report?lay=${l.id}`)}
              style={{
                minHeight: 44,
                padding: '10px 14px',
                borderRadius: 'var(--fx-radius-full)',
                border: `1px solid ${l.id === lay.layId ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                background: l.id === lay.layId ? 'var(--fx-text-primary)' : 'transparent',
                color: l.id === lay.layId ? 'var(--fx-text-inverse)' : 'var(--fx-text-secondary)',
                cursor: 'pointer',
                font: "500 12.5px/1 var(--fx-font-mono)",
              }}
            >
              {l.layNo} · {l.color}
            </button>
          ))}
        </div>
      ) : null}

      <SectionHeading eyebrow={t('ui.cutting.report_eyebrow_hint')}>
        {t('ui.cutting.report_heading')}
      </SectionHeading>

      <div
        style={{
          background: 'var(--fx-bg-surface)',
          border: '1px solid var(--fx-border-subtle)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 1fr 1fr 1fr',
            gap: 12,
            padding: '12px 18px',
            background: 'var(--fx-bg-sunken)',
            font: "500 12px/1 var(--fx-font-mono)",
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            color: 'var(--fx-text-tertiary)',
          }}
        >
          <div>{t('ui.cutting.col_size')}</div>
          <div style={{ textAlign: 'right' }}>{t('ui.cutting.col_marker_says')}</div>
          <div style={{ textAlign: 'right' }}>{t('ui.cutting.col_cut')}</div>
          <div style={{ textAlign: 'right' }}>{t('ui.cutting.col_difference')}</div>
          <div style={{ textAlign: 'right' }}>{t('ui.cutting.col_order_needs')}</div>
        </div>

        {rows.map((row) => (
          <div
            key={row.size}
            style={{
              display: 'grid',
              gridTemplateColumns: '90px 1fr 1fr 1fr 1fr',
              gap: 12,
              alignItems: 'center',
              padding: '10px 18px',
              minHeight: 56,
              borderTop: '1px solid var(--fx-border-subtle)',
              borderLeft: `3px solid ${row.outside ? 'var(--fx-danger)' : 'transparent'}`,
            }}
          >
            <div style={{ font: "600 15px/1.2 var(--fx-font-sans)" }}>{row.size}</div>
            <div
              style={{
                textAlign: 'right',
                font: "400 14px/1.3 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {row.expected}
            </div>
            <div style={{ textAlign: 'right' }}>
              <input
                inputMode="numeric"
                aria-label={t('ui.cutting.cut_cell_label', { size: row.size })}
                value={actual[row.size] ?? ''}
                onChange={(e) => setActual((a) => ({ ...a, [row.size]: e.target.value }))}
                style={{
                  width: '100%',
                  minHeight: 44,
                  padding: '8px 10px',
                  textAlign: 'right',
                  border: '1px solid var(--fx-border-default)',
                  borderRadius: 'var(--fx-radius-sm)',
                  background: 'var(--fx-bg-surface)',
                  color: 'var(--fx-text-primary)',
                  font: "500 15px/1.2 var(--fx-font-mono)",
                }}
              />
            </div>
            <div
              style={{
                textAlign: 'right',
                font: "500 14px/1.3 var(--fx-font-mono)",
                color: row.variance === 0
                  ? 'var(--fx-text-tertiary)'
                  : row.outside
                    ? 'var(--fx-danger)'
                    : 'var(--fx-warning)',
              }}
            >
              {row.variance > 0 ? '+' : ''}
              {row.variance}
            </div>
            <div
              style={{
                textAlign: 'right',
                font: "400 13px/1.3 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {row.ordered > 0 ? `${row.alreadyCut + row.cut} / ${row.ordered}` : '—'}
            </div>
          </div>
        ))}

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '90px 1fr 1fr 1fr 1fr',
            gap: 12,
            padding: '12px 18px',
            borderTop: '1px solid var(--fx-border-default)',
            background: 'var(--fx-bg-sunken)',
            font: "600 14px/1.3 var(--fx-font-mono)",
          }}
        >
          <div>{t('ui.common.total')}</div>
          <div style={{ textAlign: 'right', color: 'var(--fx-text-tertiary)' }}>{totalExpected}</div>
          <div style={{ textAlign: 'right' }}>{totalCut}</div>
          <div
            style={{
              textAlign: 'right',
              color: totalDifference === 0 ? 'var(--fx-text-tertiary)' : 'var(--fx-warning)',
            }}
          >
            {totalDifference > 0 ? '+' : ''}
            {totalDifference}
          </div>
          <div />
        </div>
      </div>

      {outside.length > 0 ? (
        <InlineAlert tone="danger">
          {t('ui.cutting.outside_tolerance', {
            list: outside
              .map((r) => `${r.size} ${r.variance > 0 ? '+' : ''}${r.variance}`)
              .join(', '),
            tolerance: tolerancePct,
          })}
        </InlineAlert>
      ) : null}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          {t('ui.cutting.report_footer_note', { layNo: lay.layNo })}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button variant="primary" size="lg" disabled={!valid} onClick={() => void file()}>
            {t('ui.cutting.save_report_button')}
          </Button>
        </span>
      </div>
    </div>
  )
}
