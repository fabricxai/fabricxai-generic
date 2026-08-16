'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

import { InlineAlert, Modal } from '@/components/fx/feedback'
import { TextInput } from '@/components/fx/forms'
import { Button } from '@/components/fx/primitives'
import { actionErrorMessage } from '@/lib/action-error'
import { unwrap } from '@/lib/action-failure'
import { releaseMarker } from '@/modules/cutting/actions'

/**
 * Releasing a marker off the CAD plan.
 *
 * `/cutting/lay` has always refused without one — *"A lay is spread under a marker … and CAD
 * releases it before cutting can start"* — and nothing in the product could release one. The
 * only route was asking MARBIM to draft it in conversation, which is a strange only-door for
 * a plan somebody is holding (Nordkap §8, F37).
 *
 * **The ratio is per ply, and it is the whole point of the form.** One ply of this marker
 * yields these pieces; the lay multiplies by plies. Getting a cell wrong cuts the wrong
 * garment count for every ply in the spread — which is why the sizes are typed individually
 * rather than as one string somebody has to punctuate correctly, and why the form shows what
 * one ply makes as you go.
 */
const SIZES = ['XS', 'S', 'M', 'L', 'XL', 'XXL'] as const

export function ReleaseMarkerButton({ styles }: { styles: readonly string[] }) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [open, setOpen] = useState(false)
  const [code, setCode] = useState('')
  const [styleCode, setStyleCode] = useState('')
  const [ratio, setRatio] = useState<Record<string, string>>({})
  const [layLength, setLayLength] = useState('')
  const [width, setWidth] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [released, setReleased] = useState<string | null>(null)

  const cells = Object.entries(ratio)
    .map(
      ([size, raw]) =>
        // eslint-disable-next-line fabricxai/no-float-money -- pieces per ply, a whole count and not money; a non-integer is dropped by the filter below
        [size, Number.parseInt(raw, 10)] as const,
    )
    .filter(([, n]) => Number.isInteger(n) && n > 0)

  const perPly = cells.reduce((sum, [, n]) => sum + n, 0)
  const ready = code.trim() !== '' && styleCode.trim() !== '' && layLength.trim() !== '' && perPly > 0

  function reset() {
    setCode('')
    setStyleCode('')
    setRatio({})
    setLayLength('')
    setWidth('')
    setFailure(null)
  }

  function submit() {
    if (!ready) return
    setFailure(null)

    startTransition(async () => {
      try {
        unwrap(
          await releaseMarker({
            code: code.trim(),
            styleCode: styleCode.trim(),
            sizeRatio: Object.fromEntries(cells),
            layLengthMeters: layLength.trim(),
            ...(width.trim() ? { fabricWidthInches: width.trim() } : {}),
          }),
        )
        setReleased(`${code.trim()} · ${styleCode.trim()}`)
        setOpen(false)
        reset()
        router.refresh()
      } catch (error) {
        setFailure(actionErrorMessage(error, 'The marker was not released.'))
      }
    })
  }

  return (
    <>
      {released ? (
        <InlineAlert tone="success">
          {released} released. A lay can be spread under it now.
        </InlineAlert>
      ) : null}

      <Button variant="secondary" onClick={() => setOpen(true)}>
        Release a marker
      </Button>

      <Modal
        open={open}
        onClose={() => {
          setOpen(false)
          reset()
        }}
        width={620}
        title="Release a marker"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {failure ? <InlineAlert tone="danger">{failure}</InlineAlert> : null}

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <TextInput
              label="Marker code"
              mono
              required
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="ST-2815-A"
              hint="What the CAD plan calls it. The cutting table asks for it by this."
            />
            <label htmlFor="marker-style" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Style</span>
              <input
                id="marker-style"
                // Named explicitly: a datalist input is a combobox, and a wrapping label
                // alone did not give it an accessible name — a screen reader would have
                // announced an unlabelled combobox on the field that decides what is cut.
                aria-label="Style"
                list="cutting-styles"
                value={styleCode}
                onChange={(e) => setStyleCode(e.target.value)}
                placeholder="ST-2815"
                style={BOX}
              />
              <datalist id="cutting-styles">
                {styles.map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
              <span style={HINT}>
                The style this marker cuts. A lay finds its marker by this exact code.
              </span>
            </label>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <span style={{ font: "500 13px/1.3 var(--fx-font-sans)" }}>Pieces per ply, by size</span>
            <p style={{ margin: 0, ...HINT }}>
              What ONE ply of this marker yields. The lay multiplies it by the number of plies,
              so a cell typed wrong cuts the wrong count for every ply in the spread.
            </p>
            <div
              className="fx-stack-tablet"
              style={{ display: 'grid', gridTemplateColumns: `repeat(${SIZES.length}, 1fr)`, gap: 10 }}
            >
              {SIZES.map((size) => (
                <label key={size} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span
                    style={{
                      font: "500 11px/1 var(--fx-font-mono)",
                      letterSpacing: '.06em',
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {size}
                  </span>
                  <input
                    inputMode="numeric"
                    value={ratio[size] ?? ''}
                    onChange={(e) => setRatio((r) => ({ ...r, [size]: e.target.value }))}
                    placeholder="0"
                    style={{ ...BOX, font: "400 14px/1.4 var(--fx-font-mono)" }}
                  />
                </label>
              ))}
            </div>
            <span style={HINT}>
              {perPly > 0
                ? `One ply makes ${perPly} ${perPly === 1 ? 'piece' : 'pieces'}.`
                : 'A marker with nothing in it costs fabric and yields no garments.'}
            </span>
          </div>

          <div className="fx-stack-tablet" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
            <TextInput
              label="Lay length (m)"
              mono
              required
              inputMode="decimal"
              value={layLength}
              onChange={(e) => setLayLength(e.target.value)}
              placeholder="7.20"
              hint="One ply's length. Times the plies, this is what the spread consumes."
            />
            <TextInput
              label="Fabric width (in)"
              mono
              inputMode="decimal"
              value={width}
              onChange={(e) => setWidth(e.target.value)}
              placeholder="72"
              hint="Optional — the width the marker was planned at."
            />
          </div>

          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button
              variant="ghost"
              onClick={() => {
                setOpen(false)
                reset()
              }}
            >
              Cancel
            </Button>
            <Button variant="primary" disabled={!ready || pending} onClick={submit}>
              {pending ? 'Releasing…' : 'Release it'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

const BOX: React.CSSProperties = {
  minHeight: 44,
  minWidth: 0,
  padding: '10px 12px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 14px/1.4 var(--fx-font-sans)",
}

const HINT: React.CSSProperties = {
  font: "400 12px/1.5 var(--fx-font-sans)",
  color: 'var(--fx-text-tertiary)',
}
