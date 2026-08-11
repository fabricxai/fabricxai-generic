import type { ReactNode } from 'react'

/**
 * Sidebar glyphs — one per nav id, drawn in the product's line language.
 *
 * Stroke-only, `currentColor`, no fills heavier than a hairline. They sit next to the
 * amber slash indicator and must not compete with it: 16px, 1.5 stroke, square caps.
 * No icon library — the design system asks for derivatives of the mark language, not a
 * third-party set dropped in unchanged.
 */

const SIZE = 16
const STROKE = 1.5

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <g
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinecap="square"
        strokeLinejoin="miter"
      >
        {children}
      </g>
    </svg>
  )
}

const ICONS: Record<string, ReactNode> = {
  // Checklist — what needs you today
  home: (
    <Glyph>
      <path d="M3 3.5h10v10H3z" />
      <path d="M5.5 6.5h5" />
      <path d="M5.5 9h3.5" />
      <path d="M5.5 11.5h4" />
    </Glyph>
  ),
  // Inbox tray
  approve: (
    <Glyph>
      <path d="M2 5.5h12v7H2z" />
      <path d="M2 5.5l6 4 6-4" />
    </Glyph>
  ),
  // Wordmark-adjacent X — MARBIM is the system's voice
  marbim: (
    <Glyph>
      <path d="M3.5 3.5l9 9" />
      <path d="M12.5 3.5l-9 9" />
    </Glyph>
  ),
  // Calendar / TNA
  orders: (
    <Glyph>
      <rect x="2.5" y="3.5" width="11" height="10" rx="0" />
      <path d="M2.5 6.5h11" />
      <path d="M5.5 2v3" />
      <path d="M10.5 2v3" />
    </Glyph>
  ),
  // Stacked cards — memory of past orders
  memory: (
    <Glyph>
      <path d="M4 4.5h9v8H4z" />
      <path d="M2.5 3h9" />
      <path d="M2.5 3v8" />
    </Glyph>
  ),
  // Sewing sample / garment outline
  sampling: (
    <Glyph>
      <path d="M5 2.5h6l1.5 3.5H3.5L5 2.5z" />
      <path d="M3.5 6v7.5h9V6" />
      <path d="M8 9v4.5" />
    </Glyph>
  ),
  // Person / buyer
  buyers: (
    <Glyph>
      <circle cx="8" cy="5" r="2.25" />
      <path d="M3.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4" />
    </Glyph>
  ),
  // Document with quote mark
  rfq: (
    <Glyph>
      <path d="M4 2.5h6l3 3V13.5H4z" />
      <path d="M10 2.5V5.5h3" />
      <path d="M6 8.5h4" />
      <path d="M6 11h3" />
    </Glyph>
  ),
  // Calculator / cost sheet
  costing: (
    <Glyph>
      <rect x="3" y="2.5" width="10" height="11" />
      <path d="M3 6h10" />
      <path d="M6 8.5h1.5M8.5 8.5H10M6 11h1.5M8.5 11H10" />
    </Glyph>
  ),
  // Credit / banknote
  lcs: (
    <Glyph>
      <rect x="2" y="4" width="12" height="8" />
      <circle cx="8" cy="8" r="1.75" />
      <path d="M4 6h1.5M10.5 10H12" />
    </Glyph>
  ),
  // Ledger columns
  finance: (
    <Glyph>
      <path d="M2.5 13.5V5l4-2.5 3 2 4-2v11" />
      <path d="M2.5 13.5h11" />
      <path d="M6.5 7v6.5M9.5 8.5V13.5" />
    </Glyph>
  ),
  // Cart / procurement
  procurement: (
    <Glyph>
      <path d="M2.5 3.5h2l1.5 7h7l1.5-5H6" />
      <circle cx="7.5" cy="13" r="1" />
      <circle cx="12" cy="13" r="1" />
    </Glyph>
  ),
  // Board / columns
  planning: (
    <Glyph>
      <rect x="2.5" y="2.5" width="11" height="11" />
      <path d="M6.5 2.5v11M9.5 2.5v11M2.5 6.5h11M2.5 9.5h11" />
    </Glyph>
  ),
  // Shelf / store
  store: (
    <Glyph>
      <path d="M2.5 4h11v2.5H2.5z" />
      <path d="M3.5 6.5v6.5h9V6.5" />
      <path d="M2.5 10h11" />
    </Glyph>
  ),
  // Bonded seal / UD
  ud: (
    <Glyph>
      <path d="M8 2.5l5 2.5v4c0 3-2.2 4.8-5 5.5-2.8-.7-5-2.5-5-5.5V5z" />
      <path d="M5.5 8l2 2 3.5-3.5" />
    </Glyph>
  ),
  // Scissors / cutting
  cutting: (
    <Glyph>
      <circle cx="4.5" cy="4.5" r="2" />
      <circle cx="4.5" cy="11.5" r="2" />
      <path d="M6 5.5l7.5-3M6 10.5l7.5 3M6 5.5l0 5" />
    </Glyph>
  ),
  // Sewing line / conveyor
  lines: (
    <Glyph>
      <path d="M2 5h12" />
      <path d="M2 8h12" />
      <path d="M2 11h12" />
      <path d="M5 5v6M11 5v6" />
    </Glyph>
  ),
  // Check / QC
  quality: (
    <Glyph>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.5 8.2l1.8 1.8 3.5-4" />
    </Glyph>
  ),
  // Truck box
  shipment: (
    <Glyph>
      <path d="M2.5 4.5h7v7h-7z" />
      <path d="M9.5 7h3l1.5 2v2.5h-4.5" />
      <circle cx="5" cy="12.5" r="1.25" />
      <circle cx="12" cy="12.5" r="1.25" />
    </Glyph>
  ),
  // Wrench
  maintenance: (
    <Glyph>
      <path d="M10.5 2.5a3 3 0 00-3.8 3.8L3 10l3 3 3.7-3.7a3 3 0 003.8-3.8L11 7.5 10.5 2.5z" />
    </Glyph>
  ),
  // Factory overview
  dashboard: (
    <Glyph>
      <path d="M2.5 13.5V7l3-2 2.5 2 2.5-3 3 2v7.5" />
      <path d="M2.5 13.5h11" />
      <path d="M5.5 13.5v-3h2v3" />
    </Glyph>
  ),
  // People / workforce
  workforce: (
    <Glyph>
      <circle cx="6" cy="5" r="2" />
      <circle cx="11" cy="6" r="1.5" />
      <path d="M2.5 13c0-2 1.6-3.5 3.5-3.5S9.5 11 9.5 13" />
      <path d="M9.5 13c.3-1.4 1.4-2.5 3-2.5 1.2 0 2.2.6 2.7 1.5" />
    </Glyph>
  ),
  // Clipboard / audit
  compliance: (
    <Glyph>
      <path d="M5 3.5h6v11H5z" />
      <path d="M6.5 2.5h3v2h-3z" />
      <path d="M6.5 7.5h3M6.5 10h3" />
    </Glyph>
  ),
  // Gear / settings
  settings: (
    <Glyph>
      <circle cx="8" cy="8" r="2.25" />
      <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2M4.1 4.1l1.4 1.4M10.5 10.5l1.4 1.4M11.9 4.1l-1.4 1.4M5.5 10.5l-1.4 1.4" />
    </Glyph>
  ),
}

/** Glyph for a nav id, or a quiet placeholder so the label column stays aligned. */
export function NavIcon({ id }: { id: string }) {
  return ICONS[id] ?? (
    <Glyph>
      <path d="M4 8h8" />
    </Glyph>
  )
}
