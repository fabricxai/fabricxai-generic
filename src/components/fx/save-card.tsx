'use client'

import { useRef, useState } from 'react'

/**
 * A card that can leave the system as a picture (live-test feedback, Phase 8).
 *
 * The people these cards are FOR are mostly not logged in: a buyer's merchandiser on
 * WhatsApp, an owner in a car, a bank officer who wants the realization summary. The
 * factory's actual sharing medium is a screenshot — so this makes the screenshot
 * first-class: pixel-exact, whole-card, named after what it shows, taken with one tap
 * instead of a crop.
 *
 * Read-only by construction: it captures the rendered DOM and changes nothing, so it is
 * safe on any card including ⚖ ones. The capture happens entirely client-side.
 */
export function SavableCard({
  filename,
  children,
}: {
  /** Without extension — `PO-BF-2044-outcome` becomes `PO-BF-2044-outcome.png`. */
  filename: string
  children: React.ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [busy, setBusy] = useState(false)

  async function save() {
    const node = ref.current
    if (!node || busy) return
    setBusy(true)
    try {
      // Dynamic so the capture library is not in the page bundle of every screen that
      // merely RENDERS a card — it loads on the first save.
      const { toPng } = await import('html-to-image')
      const bg =
        getComputedStyle(document.body).backgroundColor || '#ffffff'
      const url = await toPng(node, { backgroundColor: bg, pixelRatio: 2 })
      const a = document.createElement('a')
      a.href = url
      a.download = `${filename}.png`
      a.click()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ position: 'relative' }}>
      <div ref={ref}>{children}</div>
      <button
        onClick={() => void save()}
        disabled={busy}
        aria-label={`Save ${filename} as an image`}
        title="Save this card as an image"
        style={{
          position: 'absolute',
          top: 8,
          right: 8,
          minHeight: 32,
          padding: '4px 10px',
          font: "500 12px/1 var(--fx-font-sans)",
          color: 'var(--fx-text-tertiary)',
          background: 'transparent',
          border: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-sm)',
          cursor: busy ? 'wait' : 'pointer',
        }}
      >
        {busy ? 'Saving…' : '⤓ Save'}
      </button>
    </div>
  )
}
