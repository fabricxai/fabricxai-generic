'use client'

import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { Ident } from '@/components/fx/format'
import { SyncPill } from '@/components/fx/floor'
import { useT } from '@/components/fx/locale'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import { addQty, multiplyQty, quantity, zeroQty } from '@/lib/quantity'
import type { IssuedRoll } from '@/modules/cutting/queries'

interface MarkerOption {
  id: string
  code: string
  sizeRatio: Record<string, number>
  layLengthMeters: string
  efficiencyPct: string | null
  fabricWidthInches: string | null
}

interface OrderOption {
  orderId: string
  orderStyleId: string
  poNumber: string | null
  styleCode: string
}

const field: React.CSSProperties = {
  minHeight: 44,
  padding: '10px 12px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 14px/1.4 var(--fx-font-sans)",
  width: '100%',
}

/**
 * Spreading a lay.
 *
 * The screen's job is to make three things impossible to get wrong, because each is
 * expensive and none is recoverable once the knife has been through the stack:
 *
 *  - **Rolls come only from what the store issued to THIS order.** The service gate refuses
 *    anything else; offering a wider list would mean a cutter discovers that after picking.
 *  - **Mixing shade groups is shown before the spread, not after.** Two dye lots in one lay
 *    is a garment that leaves with two different navies in it.
 *  - **What the lay makes is computed from the marker, live.** plies × the marker's ratio is
 *    the yield, and a cutter who has to work it out on paper is a cutter who gets it wrong
 *    on the lay that matters.
 */
export function LayClient({
  orders,
  target,
  markers,
  rolls,
  blocked,
}: {
  orders: readonly OrderOption[]
  target: OrderOption
  markers: readonly MarkerOption[]
  rolls: readonly IssuedRoll[]
  blocked: boolean
}) {
  const t = useT()
  const router = useRouter()
  const { capture, online, queued, syncing, refused, sync, clear } = useOfflineQueue()

  /*
   * The CHOSEN marker, which is not always the selected one.
   *
   * This was seeded once with `markers[0]?.id`. The order picker swaps orders without
   * remounting, so on a screen first rendered against a style with no marker the id stayed
   * empty forever — while the `<select>` showed its first option, because a browser displays
   * one when the bound value matches nothing. The marker looked chosen, `marker` was
   * undefined, and "Create the lay" sat dead with nothing said (Nordkap §8, F38).
   *
   * Derived below with a fallback, so a value that matches no option is simply not a choice.
   */
  const [chosenMarkerId, setChosenMarkerId] = useState('')
  const [layNo, setLayNo] = useState('')
  const [colour, setColour] = useState('')
  const [plies, setPlies] = useState('')
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [spread, setSpread] = useState<string[]>([])

  const marker = markers.find((m) => m.id === chosenMarkerId) ?? markers[0]
  // What the select must show: the marker actually in force, never a stale id.
  const markerId = marker?.id ?? ''
  // eslint-disable-next-line fabricxai/no-float-money -- floor keypad ply count, pieces not money; NaN is rejected by the validPlies check on the next line
  const plyCount = Number.parseInt(plies, 10)
  const validPlies = Number.isInteger(plyCount) && plyCount > 0

  const available = rolls.filter((r) => r.usedByLay === null)
  const pickedRolls = available.filter((r) => picked.has(r.rollId))

  // Fabric on the picked rolls, in exact decimal — this is metres, not a piece count.
  const drawn = pickedRolls.reduce(
    (total, roll) => addQty(total, quantity(roll.qty, roll.unit || 'm')),
    zeroQty(rolls[0]?.unit || 'm'),
  )

  // What the marker says this spread consumes: lay length × plies.
  const planned = useMemo(() => {
    if (!marker || !validPlies) return null
    return multiplyQty(quantity(marker.layLengthMeters, 'm'), plyCount)
  }, [marker, validPlies, plyCount])

  /** plies × the marker's ratio — the pieces this lay yields, per size. */
  const yieldBySize = useMemo(() => {
    if (!marker || !validPlies) return []
    return Object.entries(marker.sizeRatio).map(([size, perPly]) => ({
      size,
      pieces: perPly * plyCount,
    }))
  }, [marker, validPlies, plyCount])

  const totalPieces = yieldBySize.reduce((n, cell) => n + cell.pieces, 0)

  const shadeGroups = [...new Set(pickedRolls.map((r) => r.shadeGroup).filter(Boolean))]
  const mixingShades = shadeGroups.length > 1

  const complete =
    !blocked && Boolean(marker) && validPlies && layNo.trim() !== '' && colour.trim() !== '' &&
    pickedRolls.length > 0

  /*
   * What the button is waiting for, in the order a cutting master fills the form.
   *
   * A disabled control with no sentence is the same failure as a silent refusal: this screen
   * sat complete-looking and dead, and the only way to find out why was to read the source.
   * Null once nothing is missing — the gate's own message covers `blocked`.
   */
  const waitingFor = (() => {
    if (blocked) return null
    if (!marker) return t('ui.cutting.needs_marker')
    if (layNo.trim() === '') return t('ui.cutting.needs_lay_no')
    if (colour.trim() === '') return t('ui.cutting.needs_colour')
    if (!validPlies) return t('ui.cutting.needs_plies')
    if (pickedRolls.length === 0) return t('ui.cutting.needs_rolls')
    return null
  })()

  async function createLay() {
    if (!complete || !marker) return

    await capture({
      moduleId: 'cutting',
      operation: 'create_lay',
      payload: {
        orderId: target.orderId,
        orderStyleId: target.orderStyleId,
        markerId: marker.id,
        layNo: layNo.trim(),
        color: colour.trim(),
        plies: plyCount,
        layLengthMeters: marker.layLengthMeters,
        rollsDrawn: pickedRolls.map((r) => r.rollId),
        // Deliberately NOT the picked rolls' total.
        //
        // A cutter draws whole rolls — 3,000 m of cloth may come to the table for a lay
        // that consumes 256 — and the remainder stays on the roll. Sending the roll total
        // as "fabric drawn" made a 40-ply lay report 1,071% wastage. Omitting it lets
        // `createLay` default to the marker plan (lay length × plies), which is what the
        // lay actually consumes. A measured draw belongs here when somebody has measured
        // it; a roll total is not that measurement.
      },
    })

    setSpread((done) => [
      ...done,
      t('ui.cutting.spread_summary', {
        layNo: layNo.trim(),
        plies: plyCount,
        pieces: totalPieces,
      }),
    ])
    setLayNo('')
    setPlies('')
    setPicked(new Set())
    router.refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
      <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />

      {refused.length > 0 ? (
        <InlineAlert tone="danger">
          {t.plural('ui.cutting.lays_refused', refused.length)}
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

      {spread.length > 0 ? (
        <InlineAlert tone="success">
          {t('ui.cutting.spread_done', { list: spread.join(' · ') })}{' '}
          {online ? t('ui.cutting.sent') : t('ui.cutting.held_offline')}
        </InlineAlert>
      ) : null}

      {orders.length > 1 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {orders.map((o) => (
            <button
              key={o.orderId}
              onClick={() => router.push(`/cutting/lay?order=${o.orderId}`)}
              style={{
                minHeight: 44,
                padding: '10px 14px',
                borderRadius: 'var(--fx-radius-full)',
                border: `1px solid ${o.orderId === target.orderId ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                background: o.orderId === target.orderId ? 'var(--fx-text-primary)' : 'transparent',
                color: o.orderId === target.orderId ? 'var(--fx-text-inverse)' : 'var(--fx-text-secondary)',
                cursor: 'pointer',
                font: "500 12.5px/1 var(--fx-font-sans)",
              }}
            >
              {o.poNumber ?? t('ui.cutting.order_chip_fallback')} · {o.styleCode}
            </button>
          ))}
        </div>
      ) : null}

      {/* ── The marker ───────────────────────────────────────────────────── */}
      <SectionHeading eyebrow={t('ui.cutting.markers_released_eyebrow', { count: markers.length })}>
        {t('ui.cutting.marker_heading')}
      </SectionHeading>

      {markers.length === 0 ? (
        <InlineAlert tone="warning">
          {t('ui.cutting.no_marker', { style: target.styleCode })}
        </InlineAlert>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 12.5px/1.3 var(--fx-font-sans)" }}>
              {t('ui.cutting.field_marker')}
            </span>
            <select value={markerId} onChange={(e) => setChosenMarkerId(e.target.value)} style={field}>
              {markers.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.code} · {Object.entries(m.sizeRatio).map(([s, n]) => `${s}:${n}`).join(' ')}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 12.5px/1.3 var(--fx-font-sans)" }}>
              {t('ui.cutting.field_lay_no')}
            </span>
            <input
              value={layNo}
              onChange={(e) => setLayNo(e.target.value)}
              placeholder="LAY-0044"
              style={{ ...field, font: "400 14px/1.4 var(--fx-font-mono)" }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 12.5px/1.3 var(--fx-font-sans)" }}>
              {t('ui.cutting.field_colour')}
            </span>
            <input
              value={colour}
              onChange={(e) => setColour(e.target.value)}
              placeholder={t('ui.cutting.colour_placeholder')}
              style={field}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ font: "500 12.5px/1.3 var(--fx-font-sans)" }}>
              {t('ui.cutting.field_plies')}
            </span>
            <input
              inputMode="numeric"
              value={plies}
              onChange={(e) => setPlies(e.target.value)}
              placeholder="60"
              style={{ ...field, font: "400 14px/1.4 var(--fx-font-mono)" }}
            />
          </label>
        </div>
      )}

      {/* ── What that makes ──────────────────────────────────────────────── */}
      {yieldBySize.length > 0 ? (
        <>
          <SectionHeading eyebrow={t('ui.cutting.pieces_eyebrow', { count: totalPieces })}>
            {t('ui.cutting.yield_heading')}
          </SectionHeading>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: `repeat(${yieldBySize.length + 1}, 1fr)`,
              gap: 1,
              background: 'var(--fx-border-subtle)',
              border: '1px solid var(--fx-border-subtle)',
            }}
          >
            {yieldBySize.map((cell) => (
              <div key={cell.size} style={{ background: 'var(--fx-bg-surface)', padding: '14px 16px' }}>
                <div
                  style={{
                    font: "400 11px/1 var(--fx-font-mono)",
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {cell.size}
                </div>
                <div style={{ marginTop: 6, font: "600 20px/1.1 var(--fx-font-sans)" }}>
                  {cell.pieces}
                </div>
              </div>
            ))}
            <div style={{ background: 'var(--fx-bg-sunken)', padding: '14px 16px' }}>
              <div
                style={{
                  font: "400 11px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {t('ui.common.total')}
              </div>
              <div style={{ marginTop: 6, font: "600 20px/1.1 var(--fx-font-sans)" }}>
                {totalPieces}
              </div>
            </div>
          </div>
          {planned ? (
            <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {t('ui.cutting.marker_plan_note', { planned: planned.value, drawn: drawn.value })}
            </span>
          ) : null}
        </>
      ) : null}

      {/* ── Rolls ────────────────────────────────────────────────────────── */}
      <SectionHeading eyebrow={t('ui.cutting.rolls_issued_eyebrow', { count: available.length })}>
        {t('ui.cutting.rolls_heading')}
      </SectionHeading>

      {mixingShades ? (
        <InlineAlert tone="warning">
          {t('ui.cutting.mixing_shades', {
            groups: shadeGroups.join(t('ui.cutting.shade_join')),
          })}
        </InlineAlert>
      ) : null}

      {available.length === 0 ? (
        <InlineAlert tone="warning">{t('ui.cutting.no_rolls_issued')}</InlineAlert>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {available.map((roll) => {
            const on = picked.has(roll.rollId)
            /*
             * Quality rejected this cloth. The gate refuses it at create either way, but a
             * refusal a cutting master could not see coming is the worse one — `R-F-17` was
             * spread into a lay looking exactly like every other roll on the rack.
             */
            const rejected = roll.inspection === 'fail'
            return (
              <button
                key={roll.rollId}
                disabled={rejected}
                title={rejected ? t('ui.cutting.roll_failed_title') : undefined}
                onClick={() => {
                  if (rejected) return
                  setPicked((current) => {
                    const next = new Set(current)
                    if (next.has(roll.rollId)) next.delete(roll.rollId)
                    else next.add(roll.rollId)
                    return next
                  })
                }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '28px 1.1fr 1fr 130px 110px',
                  gap: 12,
                  alignItems: 'center',
                  textAlign: 'left',
                  padding: '12px 16px',
                  minHeight: 56,
                  border: '1px solid var(--fx-border-subtle)',
                  background: rejected
                    ? 'var(--fx-bg-sunken)'
                    : on
                      ? 'var(--fx-bg-selected)'
                      : 'var(--fx-bg-surface)',
                  cursor: rejected ? 'not-allowed' : 'pointer',
                  opacity: rejected ? 0.72 : 1,
                  font: "400 14px/1.3 var(--fx-font-sans)",
                  color: 'var(--fx-text-primary)',
                }}
              >
                <span aria-hidden style={{ font: "600 15px/1 var(--fx-font-sans)" }}>
                  {on ? '✓' : ''}
                </span>
                <Ident>{roll.rollNo}</Ident>
                <span style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                  {roll.itemCode}
                </span>
                <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", textAlign: 'right' }}>
                  {roll.qty} {roll.unit}
                </span>
                <span style={{ textAlign: 'right', display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                  {rejected ? (
                    <Badge tone="danger">
                      {t('ui.cutting.roll_failed_badge', { points: roll.inspectionPoints ?? '' })}
                    </Badge>
                  ) : null}
                  {roll.shadeGroup ? (
                    <Badge>{t('ui.cutting.shade_badge', { group: roll.shadeGroup })}</Badge>
                  ) : null}
                </span>
              </button>
            )
          })}
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
          {t.plural('ui.cutting.rolls_on_table', pickedRolls.length, { drawn: drawn.value })}
          {planned ? t('ui.cutting.lay_consumes_suffix', { planned: planned.value }) : ''}
          {blocked ? t('ui.cutting.blocked_suffix') : ''}
          {waitingFor ? ` · ${waitingFor}` : ''}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <Button variant="primary" size="lg" disabled={!complete} onClick={() => void createLay()}>
            {blocked ? t('ui.cutting.blocked_button') : t('ui.cutting.create_lay_button')}
          </Button>
        </span>
      </div>
    </div>
  )
}
