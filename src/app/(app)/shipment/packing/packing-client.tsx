'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

import { InlineAlert } from '@/components/fx/feedback'
import { SyncPill } from '@/components/fx/floor'
import { Badge, Button } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { useOfflineQueue } from '@/lib/offline/use-offline-queue'
import { factoryToday } from '@/lib/dates'

type CellMap = Record<string, number>

interface Carton {
  id: string
  cartonNo: string
  totalQty: number
  contents: CellMap
  at: string
}

/** One colour and size per carton, at a fixed count — the canvas's "carton of 24". */
const CARTON_SIZE = 24

function splitCell(cell: string): { colour: string; size: string } {
  const [colour = cell, size = ''] = cell.split('|')
  return { colour, size }
}

function clockTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

/**
 * The packing floor.
 *
 * Both writes go through the offline queue. Packing happens at the far end of a finishing
 * floor, on a tablet, and a carton built while the network is down is still a carton on a
 * pallet — refusing it would mean the count on the screen and the count in the container
 * disagree, which is the one thing a packing list cannot survive.
 *
 * **The cell turns red on the tap that breaks it**, not afterwards. A packer who has already
 * sealed twelve cartons cannot unsee the over-pack; a packer who is stopped at the tap can
 * go and recount the finishing table.
 */
export function PackingClient({
  orderId,
  orderStyleId,
  orders,
  cells,
  ordered,
  finished,
  packed,
  remaining,
  recent,
}: {
  orderId: string
  orderStyleId: string | null
  orders: readonly { id: string; label: string }[]
  cells: readonly string[]
  ordered: CellMap
  finished: CellMap
  packed: CellMap
  remaining: CellMap
  recent: readonly Carton[]
}) {
  const router = useRouter()
  const { capture, online, queued, syncing, refused, sync, clear } = useOfflineQueue()

  const [selected, setSelected] = useState<string | null>(cells[0] ?? null)
  const [noted, setNoted] = useState<string | null>(null)

  const overPacked = cells.filter((c) => (packed[c] ?? 0) > (finished[c] ?? 0))

  const left = selected ? (remaining[selected] ?? 0) : 0
  // The tap that would break it. Checked before the write so the packer is stopped at the
  // carton they are about to seal, not at the end of a shift.
  const wouldOverPack = selected !== null && left < CARTON_SIZE

  async function addFinished(cell: string) {
    await capture({
      moduleId: 'shipment',
      operation: 'finishing_output',
      payload: {
        orderId,
        ...(orderStyleId ? { orderStyleId } : {}),
        outputDate: factoryToday(),
        cells: { [cell]: CARTON_SIZE },
      },
    })
    setNoted(`+${CARTON_SIZE} finished · ${cell.replace('|', ' ')}`)
    if (online) await sync()
    router.refresh()
  }

  async function makeCarton(cell: string) {
    await capture({
      moduleId: 'shipment',
      operation: 'pack_carton',
      payload: {
        orderId,
        // Sequenced on the device so two tablets packing the same order cannot collide on a
        // number; the server's idempotency key is what actually dedupes a replay.
        cartonNo: `C-${Date.now().toString(36).toUpperCase()}`,
        contents: { [cell]: CARTON_SIZE },
      },
    })
    setNoted(`Carton of ${CARTON_SIZE} · ${cell.replace('|', ' ')}`)
    if (online) await sync()
    router.refresh()
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      <SyncPill online={online} queued={queued} syncing={syncing} onSync={() => void sync()} />

      {refused.length > 0 ? (
        <InlineAlert tone="danger">
          {refused.length} write{refused.length === 1 ? '' : 's'} the server refused — most
          likely an over-pack it will not accept.
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
              dismiss
            </button>
          ))}
        </InlineAlert>
      ) : null}

      {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}

      {overPacked.length > 0 ? (
        <InlineAlert tone="danger">
          More packed than finished on {overPacked.map((c) => c.replace('|', ' ')).join(', ')}.
          Recount the finishing table — or ask the manager to accept the over-ship, which is a
          decision about the LC tolerance, not about this screen.
        </InlineAlert>
      ) : null}

      {/* ── Which order ──────────────────────────────────────────────────── */}
      {orders.length > 1 ? (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {orders.map((o) => {
            const on = o.id === orderId
            return (
              <button
                key={o.id}
                onClick={() => router.push(`/shipment/packing?order=${o.id}`)}
                style={{
                  minHeight: 44,
                  padding: '8px 16px',
                  borderRadius: 'var(--fx-radius-md)',
                  border: `1px solid ${on ? 'var(--fx-text-primary)' : 'var(--fx-border-default)'}`,
                  background: on ? 'var(--fx-text-primary)' : 'transparent',
                  color: on ? 'var(--fx-text-inverse)' : 'var(--fx-text-secondary)',
                  cursor: 'pointer',
                  font: "500 13px/1 var(--fx-font-sans)",
                }}
              >
                {o.label}
              </button>
            )
          })}
        </div>
      ) : null}

      {/* ── Packed against finished ──────────────────────────────────────── */}
      <SectionHeading eyebrow="tap a cell">Packed against finished</SectionHeading>

      {cells.length === 0 ? (
        <InlineAlert tone="info">
          This order has no size breakdown on file, so there is nothing to finish or pack
          against. The grid&rsquo;s cells come from the order&rsquo;s own colour and size
          breakdown.
        </InlineAlert>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))',
            gap: 10,
          }}
        >
          {cells.map((cell) => {
            const { colour, size } = splitCell(cell)
            const made = finished[cell] ?? 0
            const inCartons = packed[cell] ?? 0
            const over = inCartons > made
            const on = cell === selected
            return (
              <button
                key={cell}
                onClick={() => setSelected(cell)}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'flex-start',
                  gap: 6,
                  minHeight: 92,
                  padding: '14px 16px',
                  textAlign: 'left',
                  borderRadius: 'var(--fx-radius-md)',
                  border: `1px solid ${
                    over
                      ? 'var(--fx-danger)'
                      : on
                        ? 'var(--fx-text-primary)'
                        : 'var(--fx-border-default)'
                  }`,
                  background: over
                    ? 'color-mix(in srgb, var(--fx-danger) 10%, var(--fx-bg-surface))'
                    : 'var(--fx-bg-surface)',
                  color: 'var(--fx-text-primary)',
                  cursor: 'pointer',
                }}
              >
                <span style={{ font: "600 14px/1.2 var(--fx-font-sans)" }}>
                  {colour} {size ? `· ${size}` : ''}
                </span>
                <span
                  style={{
                    font: "400 12px/1.4 var(--fx-font-mono)",
                    color: over ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
                  }}
                >
                  {inCartons} packed of {made} finished
                  {ordered[cell] ? ` · ${ordered[cell]} ordered` : ''}
                </span>
                <span style={{ font: "500 12.5px/1 var(--fx-font-mono)" }}>
                  {Math.max(0, remaining[cell] ?? 0)} remaining
                </span>
              </button>
            )
          })}
        </div>
      )}

      {/* ── Carton builder ───────────────────────────────────────────────── */}
      {selected ? (
        <section
          style={{
            border: '1px solid var(--fx-border-default)',
            background: 'var(--fx-bg-surface)',
            padding: '20px 22px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }}
        >
          <SectionHeading eyebrow={`${CARTON_SIZE} pieces a carton · one colour and size`}>
            Carton builder · {selected.replace('|', ' ')}
          </SectionHeading>

          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center' }}>
            <span style={{ display: 'flex', flexDirection: 'column' }}>
              <span
                style={{
                  font: "400 10.5px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                Remaining here
              </span>
              <span
                style={{
                  marginTop: 5,
                  font: "600 26px/1.1 var(--fx-font-sans)",
                  color: left < 0 ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                }}
              >
                {left}
              </span>
            </span>

            <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
              <Button variant="ghost" onClick={() => void addFinished(selected)}>
                ＋ {CARTON_SIZE} finished
              </Button>
              <Button
                variant="primary"
                size="lg"
                disabled={wouldOverPack}
                onClick={() => void makeCarton(selected)}
              >
                ＋ carton of {CARTON_SIZE}
              </Button>
            </span>
          </div>

          {wouldOverPack ? (
            <InlineAlert tone="danger">
              Only {Math.max(0, left)} left finished in this colour and size — a carton of{' '}
              {CARTON_SIZE} would pack more than the floor has made. Report the finished pieces
              first, or pack a different cell.
            </InlineAlert>
          ) : null}
        </section>
      ) : null}

      {/* ── Last cartons ─────────────────────────────────────────────────── */}
      {recent.length > 0 ? (
        <section>
          <SectionHeading eyebrow="last few">Cartons made</SectionHeading>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {recent.map((c) => (
              <div
                key={c.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  flexWrap: 'wrap',
                  padding: '10px 16px',
                  background: 'var(--fx-bg-surface)',
                  border: '1px solid var(--fx-border-subtle)',
                }}
              >
                <span
                  style={{
                    font: "400 12px/1 var(--fx-font-mono)",
                    color: 'var(--fx-text-tertiary)',
                    minWidth: 52,
                  }}
                >
                  {clockTime(c.at)}
                </span>
                <span style={{ font: "600 13px/1.2 var(--fx-font-mono)" }}>{c.cartonNo}</span>
                <span style={{ flex: 1, minWidth: 0, font: "400 13px/1.3 var(--fx-font-sans)" }}>
                  {Object.keys(c.contents)
                    .map((k) => k.replace('|', ' '))
                    .join(', ')}
                </span>
                <Badge tone="neutral">{c.totalQty} pcs</Badge>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  )
}
