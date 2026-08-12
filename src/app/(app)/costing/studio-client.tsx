'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'

import { Card } from '@/components/fx/data'
import { InlineAlert } from '@/components/fx/feedback'
import { actionErrorMessage } from '@/lib/action-error'
import { Eyebrow, SlashRule } from '@/components/fx/signature'
import { MarbimMark } from '@/components/fx/mark'
import { Button } from '@/components/fx/primitives'
import { approveSheet, previewSheet, saveCostSheet } from '@/modules/costing/actions'
import type { CostSheetResult } from '@/modules/costing/cost-sheet'

/**
 * The live cost sheet.
 *
 * Every figure here comes back from the server. The engine works on scaled
 * integers over decimal strings — this component never does arithmetic on a
 * money value, it only renders what came back.
 */

interface MaterialRow {
  ref: string
  consumption: string
  uom: string
  ratePerUom: string
  wastagePct: string
}

/** A men's shirt, as a starting point somebody can edit into their own style. */
const INITIAL_FABRIC: MaterialRow[] = [
  { ref: '40s poplin body', consumption: '1.42', uom: 'm', ratePerUom: '2.35', wastagePct: '6' },
  { ref: 'Collar and cuff interlining', consumption: '0.09', uom: 'm', ratePerUom: '0.62', wastagePct: '4' },
]

const INITIAL_TRIMS: MaterialRow[] = [
  { ref: 'Buttons 18L horn-look', consumption: '10', uom: 'pcs', ratePerUom: '0.012', wastagePct: '2' },
  { ref: 'Sewing thread 40/2', consumption: '145', uom: 'm', ratePerUom: '0.0004', wastagePct: '8' },
  { ref: 'Main and care labels', consumption: '3', uom: 'pcs', ratePerUom: '0.021', wastagePct: '1' },
]

/**
 * The studio pre-filled from a bill of materials — consumption, wastage and refs from the
 * BOM, rates at zero for the merchandiser to price. `bomId` rides through to the save so
 * the sheet pins which BOM it was costed against.
 */
export interface StudioSeed {
  bomId: string
  styleCode: string
  fabric: MaterialRow[]
  trims: MaterialRow[]
}

export function CostingStudio({
  marginFloorPct,
  seed = null,
}: {
  marginFloorPct: string | null
  seed?: StudioSeed | null
}) {
  const [fabric, setFabric] = useState(seed?.fabric ?? INITIAL_FABRIC)
  const [trims, setTrims] = useState(seed?.trims ?? INITIAL_TRIMS)
  const [smv, setSmv] = useState('18.4')
  const [efficiencyPct, setEfficiencyPct] = useState('62')
  const [labourRate, setLabourRate] = useState('3.10')
  const [marginPct, setMarginPct] = useState('12')
  const [fx, setFx] = useState('0.00837')

  const [styleCode, setStyleCode] = useState(seed?.styleCode ?? 'SH-4471')
  const [saved, setSaved] = useState<{ sheetId: string; version: number } | null>(null)
  const [noted, setNoted] = useState<string | null>(null)

  const [result, setResult] = useState<CostSheetResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  // Built in one place so the preview and the saved version cannot drift apart — the
  // whole point of computing both from the same sections. Memoised so it is an honest
  // effect dependency rather than a new object every render.
  const sections = useMemo(
    () => ({
      currency: 'USD',
      localCurrency: 'BDT',
      // Snapshotted, never looked up — an FOB quoted in January at one rate is a
      // different quote from the same figure at another.
      fxRateLocalToBase: fx,
      fabric,
      trims,
      embellishment: [],
      cm: { method: 'smv' as const, smv, efficiencyPct, labourRatePerMinuteLocal: labourRate },
      commercial: [],
      marginPct,
      marginBasis: 'price' as const,
    }),
    [fabric, trims, smv, efficiencyPct, labourRate, marginPct, fx],
  )

  useEffect(() => {

    const timer = setTimeout(() => {
      startTransition(async () => {
        try {
          setResult(await previewSheet(sections))
          setError(null)
        } catch (e) {
          setError(actionErrorMessage(e, 'That sheet did not compute'))
        }
      })
    }, 250)

    return () => clearTimeout(timer)
  }, [sections])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1.35fr .85fr', gap: 20, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {seed ? (
          <InlineAlert tone="info">
            Seeded from the bill of materials for {seed.styleCode} — consumption and wastage
            are the BOM&apos;s, rates start at zero. Price each line; a zero rate is a line
            nobody has priced, not a free material.
          </InlineAlert>
        ) : null}
        <MaterialSection title="Fabric" rows={fabric} onChange={setFabric} />
        <MaterialSection title="Trims" rows={trims} onChange={setTrims} />

        <Card padding="20px 22px">
          <Eyebrow>Cut and make</Eyebrow>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
              gap: 14,
              marginTop: 14,
            }}
          >
            <NumField label="SMV" value={smv} onChange={setSmv} />
            <NumField label="Efficiency %" value={efficiencyPct} onChange={setEfficiencyPct} />
            <NumField label="Labour ৳/min" value={labourRate} onChange={setLabourRate} />
            <NumField label="Margin %" value={marginPct} onChange={setMarginPct} />
            <NumField label="FX $/৳" value={fx} onChange={setFx} />
          </div>
          <div
            style={{
              font: "400 12px/1.5 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
              marginTop: 12,
            }}
          >
            labour is priced in ৳ and converted at the snapshotted rate — there is no ambient
            exchange rate in this system
          </div>
        </Card>
      </div>

      <Card padding={0}>
        <div style={{ padding: '20px 22px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <Eyebrow>Result</Eyebrow>
          {pending ? <MarbimMark state="thinking" size={20} label="Costing" /> : null}
        </div>

        {error ? (
          <div style={{ padding: '0 22px 20px' }}>
            <InlineAlert tone="danger">{error}</InlineAlert>
          </div>
        ) : result ? (
          <>
            {(
              [
                ['Fabric', result.sections.fabric],
                ['Trims', result.sections.trims],
                ['Embellishment', result.sections.embellishment],
                ['Cut and make', result.sections.cm],
                ['Commercial', result.sections.commercial],
              ] as const
            ).map(([label, section]) => (
              <div
                key={label}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 12,
                  padding: '11px 22px',
                  borderTop: '1px solid var(--fx-border-subtle)',
                }}
              >
                <span style={{ font: "400 13.5px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                  {label}
                  {section.localAmount ? (
                    <span style={{ color: 'var(--fx-text-tertiary)', marginLeft: 8 }}>
                      ৳{section.localAmount}
                    </span>
                  ) : null}
                </span>
                <span data-numeric data-mono style={{ font: "500 13.5px/1.3 var(--fx-font-mono)" }}>
                  ${section.total}
                </span>
              </div>
            ))}

            <div style={{ padding: '14px 22px 0' }}>
              <SlashRule />
            </div>

            <Row label="Total cost" value={`$${result.totalCost}`} strong />
            <Row label="FOB price" value={`$${result.fobPrice}`} strong />

            <div
              style={{
                padding: '16px 22px 20px',
                borderTop: '1px solid var(--fx-border-subtle)',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <span style={{ font: "400 13.5px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                  Achieved margin
                </span>
                <span
                  data-numeric
                  style={{
                    font: "600 26px/1.1 var(--fx-font-sans)",
                    color: result.belowMarginFloor ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                  }}
                >
                  {result.achievedMarginPct}%
                </span>
              </div>

              {/* The gate. Server-side and structured — the studio reports it,
                  it does not decide it. */}
              {result.belowMarginFloor ? (
                <InlineAlert tone="danger">
                  Below the {marginFloorPct}% floor. Only an owner can approve this — for
                  anyone else the server refuses it, and an owner who does is recorded as
                  having accepted the shortfall deliberately.
                </InlineAlert>
              ) : marginFloorPct ? (
                <div style={{ font: "400 12px/1.5 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                  clears the {marginFloorPct}% floor
                </div>
              ) : null}

              {/* ── Save and approve (canvas P2) ─────────────────────── */}
              {noted ? <InlineAlert tone="success">{noted}</InlineAlert> : null}

              <div
                style={{
                  display: 'flex',
                  gap: 10,
                  flexWrap: 'wrap',
                  alignItems: 'flex-end',
                  paddingTop: 4,
                }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: '1 1 140px' }}>
                  <span style={{ font: "400 11px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                    STYLE
                  </span>
                  <input
                    value={styleCode}
                    onChange={(e) => setStyleCode(e.target.value)}
                    style={{
                      minHeight: 40,
                      minWidth: 0,
                      padding: '8px 11px',
                      border: '1px solid var(--fx-border-default)',
                      borderRadius: 'var(--fx-radius-sm)',
                      background: 'var(--fx-bg-surface)',
                      color: 'var(--fx-text-primary)',
                      font: "400 13.5px/1.4 var(--fx-font-sans)",
                    }}
                  />
                </label>

                <Button
                  variant="secondary"
                  disabled={pending || !styleCode.trim()}
                  onClick={() =>
                    startTransition(async () => {
                      try {
                        const r = await saveCostSheet({
                          styleCode: styleCode.trim(),
                          sections,
                          // The sheet pins the BOM it was costed against. Only when the
                          // studio was opened FROM one — a hand-built sheet pins nothing.
                          ...(seed ? { bomId: seed.bomId } : {}),
                        })
                        setSaved({ sheetId: r.sheetId, version: r.version })
                        setNoted(
                          `Saved as v${r.version} — FOB ${r.computed.fobPrice}, margin ${r.computed.achievedMarginPct}%.`,
                        )
                        setError(null)
                      } catch (e) {
                        setError(actionErrorMessage(e, 'The sheet was not saved'))
                      }
                    })
                  }
                >
                  {saved ? `Save as v${saved.version + 1}` : 'Save this version'}
                </Button>

                {/* Offered even below the floor. The server refuses and says why — hiding
                    the button would leave a merchandiser guessing which of the flags is
                    the blocking one. */}
                <Button
                  variant="primary"
                  disabled={pending || !saved}
                  onClick={() =>
                    startTransition(async () => {
                      if (!saved) return
                      try {
                        const r = await approveSheet({ sheetId: saved.sheetId })
                        setNoted(
                          r.belowFloor
                            ? `v${r.version} approved BELOW the floor — recorded as a deliberate decision.`
                            : `v${r.version} approved. The order desk quotes from it.`,
                        )
                        setError(null)
                      } catch (e) {
                        setError(actionErrorMessage(e, 'The sheet was not approved'))
                      }
                    })
                  }
                >
                  Submit for approval
                </Button>
              </div>

              {result.flags.map((f) => (
                <InlineAlert key={f.code} tone="warning">
                  {f.messageKey}
                  {Object.keys(f.facts).length > 0 ? (
                    <span style={{ color: 'var(--fx-text-tertiary)' }}>
                      {' '}
                      · {Object.entries(f.facts).map(([k, v]) => `${k} ${v}`).join(' · ')}
                    </span>
                  ) : null}
                </InlineAlert>
              ))}
            </div>
          </>
        ) : (
          <div style={{ padding: '0 22px 22px', font: "400 13.5px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
            Enter a consumption and a rate to see the sheet.
          </div>
        )}
      </Card>
    </div>
  )
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        gap: 12,
        padding: '11px 22px',
      }}
    >
      <span
        style={{
          font: `${strong ? 600 : 400} 13.5px/1.3 var(--fx-font-sans)`,
          color: 'var(--fx-text-primary)',
        }}
      >
        {label}
      </span>
      <span data-numeric data-mono style={{ font: `${strong ? 600 : 500} 14px/1.3 var(--fx-font-mono)` }}>
        {value}
      </span>
    </div>
  )
}

function NumField({
  label,
  value,
  onChange,
}: {
  label: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <span style={{ font: "400 11.5px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
        {label}
      </span>
      {/* inputMode decimal, and the value stays a STRING all the way to the
          server — parsing it here would put a float in the middle of a price. */}
      <input
        value={value}
        inputMode="decimal"
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'var(--fx-bg-surface)',
          color: 'var(--fx-text-primary)',
          border: '1px solid var(--fx-border-default)',
          borderRadius: 'var(--fx-radius-sm)',
          padding: '9px 11px',
          font: "400 13.5px/1.2 var(--fx-font-mono)",
          width: '100%',
        }}
      />
    </label>
  )
}

function MaterialSection({
  title,
  rows,
  onChange,
}: {
  title: string
  rows: MaterialRow[]
  onChange: (rows: MaterialRow[]) => void
}) {
  function set(i: number, key: keyof MaterialRow, value: string) {
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: value } : r)))
  }

  return (
    <Card padding={0}>
      <div style={{ padding: '18px 22px 12px' }}>
        <Eyebrow>{title}</Eyebrow>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.6fr .7fr .5fr .8fr .6fr',
          gap: 10,
          padding: '8px 22px',
          background: 'var(--fx-bg-sunken)',
          font: "500 11px/1 var(--fx-font-mono)",
          letterSpacing: '.06em',
          textTransform: 'uppercase',
          color: 'var(--fx-text-tertiary)',
        }}
      >
        <div>Item</div>
        <div>Cons.</div>
        <div>UoM</div>
        <div>Rate</div>
        <div>Waste %</div>
      </div>
      {rows.map((row, i) => (
        <div
          key={i}
          style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr .7fr .5fr .8fr .6fr auto',
            gap: 10,
            padding: '10px 22px',
            borderTop: '1px solid var(--fx-border-subtle)',
            alignItems: 'center',
          }}
        >
          <Cell value={row.ref} onChange={(v) => set(i, 'ref', v)} text />
          <Cell value={row.consumption} onChange={(v) => set(i, 'consumption', v)} />
          <Cell value={row.uom} onChange={(v) => set(i, 'uom', v)} text />
          <Cell value={row.ratePerUom} onChange={(v) => set(i, 'ratePerUom', v)} />
          <Cell value={row.wastagePct} onChange={(v) => set(i, 'wastagePct', v)} />
          <button
            type="button"
            aria-label={`remove ${row.ref || 'this line'}`}
            onClick={() => onChange(rows.filter((_, idx) => idx !== i))}
            style={{
              border: 'none',
              background: 'none',
              cursor: 'pointer',
              color: 'var(--fx-text-tertiary)',
              font: "400 14px/1 var(--fx-font-mono)",
              padding: '4px 2px',
            }}
          >
            ×
          </button>
        </div>
      ))}

      {/*
        * The hand this section never had. A seeded sheet arrives with the BOM's lines and
        * nothing else — and the first live tech pack proved a BOM can be missing a line
        * the document priced by omission (the sew thread, stated with no consumption).
        * A sheet that cannot grow a row makes that omission permanent.
        */}
      <div style={{ padding: '10px 22px', borderTop: '1px solid var(--fx-border-subtle)' }}>
        <button
          type="button"
          onClick={() =>
            onChange([...rows, { ref: '', consumption: '0', uom: 'pcs', ratePerUom: '0', wastagePct: '0' }])
          }
          style={{
            border: 'none',
            background: 'none',
            cursor: 'pointer',
            color: 'var(--fx-accent)',
            font: "500 13px/1 var(--fx-font-sans)",
            padding: 0,
          }}
        >
          ＋ add a line
        </button>
      </div>
    </Card>
  )
}

function Cell({
  value,
  onChange,
  text,
}: {
  value: string
  onChange: (v: string) => void
  text?: boolean
}) {
  return (
    <input
      value={value}
      inputMode={text ? undefined : 'decimal'}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: 'transparent',
        color: 'var(--fx-text-primary)',
        border: '1px solid transparent',
        borderRadius: 'var(--fx-radius-sm)',
        padding: '7px 8px',
        font: text ? '400 13.5px/1.2 var(--fx-font-sans)' : '400 13px/1.2 var(--fx-font-mono)',
        width: '100%',
      }}
    />
  )
}

/**
 * The studio behind a door (plan 2.3, audit S4a).
 *
 * `/costing` LANDED inside the 31-input form, which is the destination for one task —
 * costing a new style — and the wrong place for the visit a merchandiser makes most,
 * which is checking a sheet that already exists. The sheet list leads now and the form
 * opens on demand.
 *
 * A seed still opens it immediately: a deep link from the RFQ desk arrives with a style
 * already chosen, and making that person click "Cost a style" to see the form they were
 * sent to would be a door in front of a door.
 */
export function CostingStudioDoor({
  marginFloorPct,
  seed = null,
}: {
  marginFloorPct: string | null
  seed?: StudioSeed | null
}) {
  const [open, setOpen] = useState(Boolean(seed))

  if (!open) {
    return (
      <div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Cost a style
        </Button>
      </div>
    )
  }

  return <CostingStudio marginFloorPct={marginFloorPct} seed={seed} />
}
