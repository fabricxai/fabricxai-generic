'use client'

import { Fragment } from 'react'

/**
 * A reading, shown the way the document reads — not the way the database stores it.
 *
 * The first version of this dialog put the payload on screen as JSON. It was honest and it
 * was useless: the person being asked "does this match the paper in your hand?" is a
 * merchandiser, not an engineer, and `[{"currency":"USD","breakdown":[{"qty":1150,...` is
 * not a question anybody can answer. Worse, it is answerable-looking, which is how a wrong
 * quantity gets confirmed.
 *
 * So each shape gets the presentation it deserves:
 *
 *   · a plain value            → a labelled box
 *   · a list of plain values   → one line, comma separated, which is how a PO writes them
 *   · a list of records        → a table, one row each, editable cell by cell
 *   · a colour × size grid     → the grid, colours down and sizes across, with its total
 *
 * Everything stays editable, because the point of the step is that the person with the
 * document fixes what the model misread. Edits come back out in the original shape.
 *
 * Field names are humanised for the same reason: `plannedExFactoryDate` is a column name,
 * and "Planned ex-factory date" is what the person calls it.
 */

// ─────────────────────────────────────────────────────────────────────────────

/** `plannedExFactoryDate` → `Planned ex-factory date`. Known terms keep their casing. */
export function humanise(name: string): string {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .toLowerCase()
    .trim()

  const fixed = words
    .replace(/\bex factory\b/g, 'ex-factory')
    .replace(/\bqty\b/g, 'quantity')
    .replace(/\bpo\b/g, 'PO')
    .replace(/\blc\b/g, 'LC')
    .replace(/\bud\b/g, 'UD')
    .replace(/\baql\b/g, 'AQL')
    .replace(/\bsmv\b/g, 'SMV')
    .replace(/\bid\b/g, '')
    .trim()

  return fixed.charAt(0).toUpperCase() + fixed.slice(1)
}

type Row = Record<string, unknown>

const isScalar = (v: unknown): v is string | number | boolean =>
  typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'

const isRecordArray = (v: unknown): v is Row[] =>
  Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'object' && x !== null && !Array.isArray(x))

const isScalarArray = (v: unknown): v is (string | number)[] =>
  Array.isArray(v) && v.length > 0 && v.every(isScalar)

/** A colour × size grid, by shape: every row is exactly a cell of one. */
function isGrid(v: unknown): v is { color: string; size: string; qty: number }[] {
  return (
    isRecordArray(v) &&
    v.every(
      (r) => typeof r.color === 'string' && typeof r.size === 'string' && typeof r.qty === 'number',
    )
  )
}

// ─────────────────────────────────────────────────────────────────────────────

const boxStyle = {
  width: '100%',
  minWidth: 0,
  padding: '9px 11px',
  border: '1px solid var(--fx-border-default)',
  borderRadius: 'var(--fx-radius-sm)',
  background: 'var(--fx-bg-surface)',
  color: 'var(--fx-text-primary)',
  font: "400 13.5px/1.4 var(--fx-font-sans)",
} as const

const cellStyle = {
  ...boxStyle,
  padding: '6px 8px',
  font: "400 13px/1.3 var(--fx-font-mono)",
  textAlign: 'right',
} as const

/**
 * The editor for one field's value, whatever shape it is.
 *
 * `onChange` always hands back a value of the SAME shape it was given — a grid stays an
 * array of cells, a record list stays a record list. The dialog above never has to know
 * which branch rendered.
 */
export function ValueEditor({
  value,
  onChange,
  invalid,
}: {
  value: unknown
  onChange: (next: unknown) => void
  invalid?: boolean
}) {
  if (isGrid(value)) return <GridEditor cells={value} onChange={onChange} />
  if (isRecordArray(value)) return <RecordListEditor rows={value} onChange={onChange} />
  if (isScalarArray(value)) {
    return (
      <input
        value={value.join(', ')}
        onChange={(e) =>
          onChange(
            e.target.value
              .split(',')
              .map((part) => part.trim())
              .filter(Boolean),
          )
        }
        style={{ ...boxStyle, fontFamily: 'var(--fx-font-mono)' }}
      />
    )
  }

  return (
    <input
      value={value === null || value === undefined ? '' : String(value)}
      onChange={(e) => {
        // A number stays a number. Anything the schema then refuses is refused at the field
        // the person just typed, not four screens later at approve.
        const raw = e.target.value
        onChange(typeof value === 'number' && raw.trim() !== '' && !Number.isNaN(Number(raw))
          ? Number(raw)
          : raw)
      }}
      style={{
        ...boxStyle,
        borderColor: invalid ? 'var(--fx-danger)' : 'var(--fx-border-default)',
      }}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * The colour × size grid, laid out as one.
 *
 * This is the shape a cutting floor works to and the shape the buyer's PO prints, so it is
 * the shape somebody can check at a glance — a list of thirty `{color, size, qty}` objects
 * is the same information arranged so that nobody will.
 *
 * The total is shown because it is the number the PO also prints, and the two disagreeing
 * is the single most valuable thing this dialog can surface.
 */
function GridEditor({
  cells,
  onChange,
}: {
  cells: { color: string; size: string; qty: number }[]
  onChange: (next: unknown) => void
}) {
  const colours = [...new Set(cells.map((c) => c.color))]
  const sizes = [...new Set(cells.map((c) => c.size))]
  const at = (color: string, size: string) =>
    cells.find((c) => c.color === color && c.size === size)?.qty ?? 0

  function set(color: string, size: string, qty: number) {
    const rest = cells.filter((c) => !(c.color === color && c.size === size))
    onChange(qty > 0 ? [...rest, { color, size, qty }] : rest)
  }

  const total = cells.reduce((sum, c) => sum + c.qty, 0)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="fx-scroll-x" tabIndex={0} style={{ overflowX: 'auto' }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(120px, auto) repeat(${sizes.length}, minmax(72px, 1fr)) minmax(80px, auto)`,
            gap: 6,
            alignItems: 'center',
            minWidth: 'min-content',
          }}
        >
          <span style={headerCell}>Colour</span>
          {sizes.map((size) => (
            <span key={size} style={{ ...headerCell, textAlign: 'right' }}>
              {size}
            </span>
          ))}
          <span style={{ ...headerCell, textAlign: 'right' }}>Total</span>

          {colours.map((colour) => (
            <Fragment key={colour}>
              <span style={{ font: "400 13px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
                {colour}
              </span>
              {sizes.map((size) => (
                <input
                  key={size}
                  inputMode="numeric"
                  value={at(colour, size) || ''}
                  onChange={(e) => set(colour, size, Number(e.target.value.replace(/\D/g, '')) || 0)}
                  style={cellStyle}
                />
              ))}
              <span
                style={{
                  font: "500 13px/1.3 var(--fx-font-mono)",
                  color: 'var(--fx-text-secondary)',
                  textAlign: 'right',
                }}
              >
                {cells
                  .filter((c) => c.color === colour)
                  .reduce((s, c) => s + c.qty, 0)
                  .toLocaleString()}
              </span>
            </Fragment>
          ))}
        </div>
      </div>
      <div
        style={{
          font: "500 13px/1.3 var(--fx-font-sans)",
          color: 'var(--fx-text-secondary)',
          textAlign: 'right',
        }}
      >
        {total.toLocaleString()} pieces across the grid
      </div>
    </div>
  )
}

const headerCell = {
  font: "500 11px/1 var(--fx-font-mono)",
  letterSpacing: '.06em',
  textTransform: 'uppercase',
  color: 'var(--fx-text-tertiary)',
} as const

// ─────────────────────────────────────────────────────────────────────────────

/**
 * A list of records — a PO's styles, an audit's findings — as a table.
 *
 * Nested lists inside a row (a style's breakdown) get their own block underneath rather
 * than a cell, because a grid does not fit in a table cell and squeezing it there is how
 * the JSON dump happened in the first place.
 */
function RecordListEditor({ rows, onChange }: { rows: Row[]; onChange: (next: unknown) => void }) {
  const scalarKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) =>
    rows.some((r) => isScalar(r[k])),
  )
  const nestedKeys = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((k) =>
    rows.some((r) => Array.isArray(r[k])),
  )

  function edit(index: number, key: string, next: unknown) {
    onChange(rows.map((row, i) => (i === index ? { ...row, [key]: next } : row)))
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {rows.map((row, index) => (
        <div
          key={index}
          style={{
            border: '1px solid var(--fx-border-subtle)',
            borderRadius: 'var(--fx-radius-sm)',
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          {rows.length > 1 ? (
            <span style={{ ...headerCell }}>
              {humanise('item')} {index + 1} of {rows.length}
            </span>
          ) : null}

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: 10,
            }}
          >
            {scalarKeys.map((key) => (
              <label key={key} style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                <span
                  style={{
                    font: "500 12px/1 var(--fx-font-sans)",
                    color: 'var(--fx-text-secondary)',
                  }}
                >
                  {humanise(key)}
                </span>
                <ValueEditor value={row[key] ?? ''} onChange={(next) => edit(index, key, next)} />
              </label>
            ))}
          </div>

          {nestedKeys.map((key) =>
            Array.isArray(row[key]) && (row[key] as unknown[]).length > 0 ? (
              <div key={key} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <span
                  style={{
                    font: "500 12px/1 var(--fx-font-sans)",
                    color: 'var(--fx-text-secondary)',
                  }}
                >
                  {humanise(key)}
                </span>
                <ValueEditor value={row[key]} onChange={(next) => edit(index, key, next)} />
              </div>
            ) : null,
          )}
        </div>
      ))}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Read-only
// ─────────────────────────────────────────────────────────────────────────────

/** True for the colour × size shape, so a reader can special-case it. */
export function looksLikeGrid(value: unknown): value is { color: string; size: string; qty: number }[] {
  return isGrid(value)
}

/**
 * The grid, for somebody who is reading rather than editing — the approve inbox.
 *
 * Same layout as the editor deliberately: an approver and the person who raised the draft
 * should be looking at the same picture, or "I checked it" and "I approved it" are claims
 * about two different things.
 */
export function GridSummary({ cells }: { cells: { color: string; size: string; qty: number }[] }) {
  const colours = [...new Set(cells.map((c) => c.color))]
  const sizes = [...new Set(cells.map((c) => c.size))]
  const at = (color: string, size: string) =>
    cells.find((c) => c.color === color && c.size === size)?.qty ?? 0
  const total = cells.reduce((sum, c) => sum + c.qty, 0)

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span className="fx-scroll-x" tabIndex={0} style={{ display: 'block', overflowX: 'auto' }}>
        <span
          style={{
            display: 'grid',
            gridTemplateColumns: `minmax(100px, auto) repeat(${sizes.length}, minmax(52px, auto)) minmax(64px, auto)`,
            gap: '3px 12px',
            minWidth: 'min-content',
          }}
        >
          <span style={headerCell}>Colour</span>
          {sizes.map((size) => (
            <span key={size} style={{ ...headerCell, textAlign: 'right' }}>
              {size}
            </span>
          ))}
          <span style={{ ...headerCell, textAlign: 'right' }}>Total</span>

          {colours.map((colour) => (
            <Fragment key={colour}>
              <span style={{ font: "400 12.5px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
                {colour}
              </span>
              {sizes.map((size) => (
                <span
                  key={size}
                  data-numeric
                  style={{
                    font: "400 12.5px/1.5 var(--fx-font-mono)",
                    color: 'var(--fx-text-secondary)',
                    textAlign: 'right',
                  }}
                >
                  {at(colour, size).toLocaleString()}
                </span>
              ))}
              <span
                data-numeric
                style={{
                  font: "500 12.5px/1.5 var(--fx-font-mono)",
                  color: 'var(--fx-text-primary)',
                  textAlign: 'right',
                }}
              >
                {cells.filter((c) => c.color === colour).reduce((s, c) => s + c.qty, 0).toLocaleString()}
              </span>
            </Fragment>
          ))}
        </span>
      </span>
      <span style={{ font: "500 12.5px/1.4 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
        {total.toLocaleString()} pieces across the grid
      </span>
    </span>
  )
}

/**
 * A whole payload, read-only, in words.
 *
 * For the screens that show what was proposed without offering to change it — the refused-
 * writes log above all, which dumped `JSON.stringify(payload, null, 2)` into a `<pre>`.
 * That page exists so somebody can see WHY their write was refused; handing them the raw
 * object is handing them the reason in a language they do not read.
 *
 * Recurses through the same shapes the editor knows, so a refused order shows its grid as a
 * grid rather than as ninety characters of braces.
 */
export function PayloadSummary({ payload }: { payload: Record<string, unknown> }) {
  const entries = Object.entries(payload)
  if (entries.length === 0) return null

  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {entries.map(([key, value]) => (
        <span key={key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span
            style={{
              font: "500 11px/1 var(--fx-font-mono)",
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {humanise(key)}
          </span>
          <ReadOnlyValue value={value} />
        </span>
      ))}
    </span>
  )
}

function ReadOnlyValue({ value }: { value: unknown }) {
  if (looksLikeGrid(value)) return <GridSummary cells={value} />

  if (isRecordArray(value)) {
    return (
      <span style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {value.map((row, i) => (
          <span
            key={i}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
              paddingLeft: 10,
              borderLeft: '2px solid var(--fx-border-default)',
            }}
          >
            {Object.entries(row).map(([k, v]) => (
              <span key={k} style={{ font: "400 12.5px/1.5 var(--fx-font-sans)" }}>
                <span style={{ color: 'var(--fx-text-tertiary)' }}>{humanise(k)}: </span>
                {v !== null && typeof v === 'object' ? (
                  <ReadOnlyValue value={v} />
                ) : (
                  <span style={{ color: 'var(--fx-text-primary)' }}>{String(v ?? '—')}</span>
                )}
              </span>
            ))}
          </span>
        ))}
      </span>
    )
  }

  if (isScalarArray(value)) {
    return (
      <span style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
        {value.join(', ')}
      </span>
    )
  }

  return (
    <span style={{ font: "400 13px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-primary)' }}>
      {value === null || value === undefined || value === '' ? '—' : String(value)}
    </span>
  )
}
