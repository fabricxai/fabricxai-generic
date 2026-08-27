import { Card } from '@/components/fx/data'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { FactPair } from '@/components/fx/tna'
import type { BomDetailLine } from '@/modules/costing/queries'
import type { OrderDetail } from '@/modules/orders/queries'
import type { StyleMeasurementChart } from '@/modules/quality/queries'

import { StyleDetailsForm } from './style-details-form'

/**
 * The order's papers — style, cloth and chart (design canvas, "Style & documents").
 *
 * The second tab of a merchandiser's real file. Everything on it already existed in the
 * database and was reachable only from the department that wrote it: the BOM from the
 * costing studio, the measurement chart from the QC capture screen, the style's own
 * identity from nowhere at all. So the questions a buyer asks on the phone — which season
 * is this, what is it cut from, how much cloth per piece, did the PP sample measure inside
 * tolerance — were answered out of the spreadsheet the app was meant to replace.
 *
 * Nothing here is editable except the style's own identity, which this module owns. The
 * cloth belongs to costing and the chart to quality; a field here that wrote to either
 * would be a second writer for a table with one (rule 11).
 */
const groupLabel: Record<string, string> = {
  fabric: 'Fabric',
  trims: 'Trims',
  embellishment: 'Embellishment',
  packing: 'Packing',
}

export function StyleDossier({
  style,
  breakdown,
  bom,
  chart,
  canWrite = false,
}: {
  style: OrderDetail['style']
  breakdown: readonly { color: string; size: string; qty: number }[]
  bom: { approved: boolean; sheetVersion: number | null; lines: readonly BomDetailLine[] } | null
  chart: StyleMeasurementChart | null
  /** False for a role that reads the file but does not describe what the buyer ordered. */
  canWrite?: boolean
}) {
  if (!style) {
    return (
      <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
        This order has no style on it yet, so there are no papers to show.
      </p>
    )
  }

  // Colourways and the size run are FACTS OF THE GRID, not fields somebody maintains —
  // storing them separately would give the order two answers to "which colours" and let
  // them drift the first time a buyer drops one.
  const colours = [...new Set(breakdown.map((cell) => cell.color))]
  const sizes = [...new Set(breakdown.map((cell) => cell.size))]

  const groups = new Map<string, BomDetailLine[]>()
  for (const line of bom?.lines ?? []) {
    groups.set(line.lineGroup, [...(groups.get(line.lineGroup) ?? []), line])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
      <section>
        <SectionHeading eyebrow="what the buyer ordered">Style</SectionHeading>
        <Card>
          <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
            <FactPair label="Style">
              {style.styleCode}
              {style.description ? (
                <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>
                  {' '}
                  · {style.description}
                </span>
              ) : null}
            </FactPair>
            <FactPair label="Season">
              {style.season ?? <Unsaid />}
              {style.customerLabel ? (
                <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>
                  {' '}
                  · buyer&rsquo;s label {style.customerLabel}
                </span>
              ) : null}
            </FactPair>
            <FactPair label="Pattern">
              {style.patternNo ?? <Unsaid />}
              {style.basedOnStyle ? (
                <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>
                  {' '}
                  · based on {style.basedOnStyle}
                </span>
              ) : null}
            </FactPair>
            <FactPair label="Colourways">
              {colours.length > 0 ? colours.join(' · ') : <Unsaid />}
              {colours.length > 0 ? (
                <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>
                  {' '}
                  · {colours.length} option{colours.length === 1 ? '' : 's'}
                </span>
              ) : null}
            </FactPair>
            <FactPair label="Sizes">
              {sizes.length > 0 ? `${sizes[0]} – ${sizes[sizes.length - 1]}` : <Unsaid />}
              {sizes.length > 0 ? (
                <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>
                  {' '}
                  · {sizes.length}-size run
                </span>
              ) : null}
            </FactPair>
            <FactPair label="Packing">{style.packingMethod ?? <Unsaid />}</FactPair>
          </div>

          {canWrite ? (
            <StyleDetailsForm
              orderStyleId={style.id}
              current={{
                season: style.season,
                customerLabel: style.customerLabel,
                patternNo: style.patternNo,
                basedOnStyle: style.basedOnStyle,
                packingMethod: style.packingMethod,
              }}
            />
          ) : null}
        </Card>
      </section>

      <section>
        <SectionHeading
          eyebrow={
            bom
              ? bom.approved
                ? `from the approved cost sheet · v${bom.sheetVersion}`
                : 'from the tech pack · not yet costed'
              : undefined
          }
        >
          Fabric and trims
        </SectionHeading>

        {!bom || bom.lines.length === 0 ? (
          <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
            No bill of materials exists for {style.styleCode} yet. One is drafted when the
            tech pack is read in the costing studio, and it is what sizes the fabric
            requisition — until then, nothing knows how much cloth this order needs.
          </p>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
            {[...groups.entries()].map(([group, lines]) => (
              <div key={group} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div
                  style={{
                    font: '500 11px/1 var(--fx-font-mono)',
                    letterSpacing: '.06em',
                    textTransform: 'uppercase',
                    color: 'var(--fx-text-tertiary)',
                  }}
                >
                  {groupLabel[group] ?? group}
                </div>
                {lines.map((line) => (
                  <div
                    key={line.id}
                    className="fx-stack-tablet"
                    style={{
                      display: 'flex',
                      gap: 14,
                      justifyContent: 'space-between',
                      alignItems: 'baseline',
                      padding: '11px 16px',
                      background: 'var(--fx-bg-surface)',
                      border: '1px solid var(--fx-border-subtle)',
                      borderRadius: 'var(--fx-radius-md)',
                      minHeight: 'var(--fx-row-height)',
                    }}
                  >
                    <span style={{ font: '400 13.5px/1.4 var(--fx-font-sans)', minWidth: 0 }}>
                      <span style={{ fontWeight: 500 }}>{line.itemRef ?? 'unnamed line'}</span>
                      {line.spec ? (
                        <span style={{ color: 'var(--fx-text-tertiary)' }}> · {line.spec}</span>
                      ) : null}
                    </span>
                    <span
                      style={{
                        display: 'inline-flex',
                        gap: 10,
                        alignItems: 'baseline',
                        flexShrink: 0,
                      }}
                    >
                      <span
                        data-mono
                        data-numeric
                        style={{ font: '400 13px/1.4 var(--fx-font-mono)' }}
                      >
                        {line.consumption} {line.uom}
                        <span style={{ color: 'var(--fx-text-tertiary)' }}>
                          {' '}
                          / pc · +{line.wastagePct}%
                        </span>
                      </span>
                      {/*
                        * Measured beats planned, and the difference is money: a planned
                        * consumption is somebody's estimate off a tech pack, a measured one
                        * came off a real lay. Saying which is the whole point of the column.
                        */}
                      <Badge tone={line.consumptionBasis === 'actual' ? 'success' : 'neutral'}>
                        {line.consumptionBasis === 'actual' ? 'measured' : 'planned'}
                      </Badge>
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </section>

      <section>
        <SectionHeading
          eyebrow={
            chart
              ? chart.lastCheck
                ? `spec v${chart.version} · last measured on size ${chart.lastCheck.sampledSize}`
                : `spec v${chart.version} · nothing measured on this order yet`
              : undefined
          }
        >
          Measurement spec
        </SectionHeading>

        {!chart ? (
          <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
            No measurement chart has been read for {style.styleCode}. QC measures against
            the chart, so until one exists a fit rejection cannot be argued with numbers.
          </p>
        ) : (
          <MeasurementTable chart={chart} />
        )}
      </section>
    </div>
  )
}

/** A field nobody has filled in — said as a word, because a dash reads as "none". */
function Unsaid() {
  return (
    <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}>not recorded</span>
  )
}

function MeasurementTable({ chart }: { chart: StyleMeasurementChart }) {
  const failures = chart.points.filter((point) => point.outOfTolerance)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div
        className="fx-scroll-x"
        tabIndex={0}
        style={{
          background: 'var(--fx-bg-surface)',
          border: '1px solid var(--fx-border-subtle)',
          borderRadius: 'var(--fx-radius-md)',
          overflowY: 'hidden',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '2.4fr .8fr .8fr .9fr',
            minWidth: 520,
            gap: 14,
            padding: '10px 18px',
            background: 'var(--fx-bg-sunken)',
            font: '500 11px/1 var(--fx-font-mono)',
            letterSpacing: '.06em',
            textTransform: 'uppercase',
            color: 'var(--fx-text-tertiary)',
          }}
        >
          <div>Point</div>
          <div style={{ textAlign: 'right' }}>Spec</div>
          <div style={{ textAlign: 'right' }}>Tol</div>
          <div style={{ textAlign: 'right' }}>Measured</div>
        </div>

        {chart.points.map((point) => (
          <div
            key={point.name}
            style={{
              display: 'grid',
              gridTemplateColumns: '2.4fr .8fr .8fr .9fr',
              minWidth: 520,
              gap: 14,
              padding: '11px 18px',
              borderTop: '1px solid var(--fx-border-subtle)',
              alignItems: 'baseline',
            }}
          >
            <span style={{ font: '400 13.5px/1.4 var(--fx-font-sans)' }}>{point.name}</span>
            <span
              data-mono
              data-numeric
              style={{ font: '400 13px/1.4 var(--fx-font-mono)', textAlign: 'right' }}
            >
              {point.spec}
            </span>
            <span
              data-mono
              data-numeric
              style={{
                font: '400 13px/1.4 var(--fx-font-mono)',
                textAlign: 'right',
                color: 'var(--fx-text-tertiary)',
              }}
            >
              ±{point.tolPlus === point.tolMinus ? point.tolPlus : `${point.tolPlus}/−${point.tolMinus}`}
            </span>
            <span
              data-mono
              data-numeric
              style={{
                font: '400 13px/1.4 var(--fx-font-mono)',
                textAlign: 'right',
                color: point.outOfTolerance ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                fontWeight: point.outOfTolerance ? 600 : 400,
              }}
            >
              {point.measured ?? '—'}
            </span>
          </div>
        ))}
      </div>

      {failures.length > 0 ? (
        <p style={{ font: '400 13px/1.5 var(--fx-font-sans)', color: 'var(--fx-danger)' }}>
          {failures.length} point{failures.length === 1 ? '' : 's'} out of tolerance on the last
          check: {failures.map((point) => point.name).join(', ')}. Judged against the chart
          version live when the piece was measured, not against this one.
        </p>
      ) : null}

      {chart.lastCheck && chart.lastCheck.missingPoints.length > 0 ? (
        <p style={{ font: '400 13px/1.5 var(--fx-font-sans)', color: 'var(--fx-warning)' }}>
          {chart.lastCheck.missingPoints.length} point
          {chart.lastCheck.missingPoints.length === 1 ? ' was' : 's were'} not measured — a
          partial check is not a clean one.
        </p>
      ) : null}
    </div>
  )
}
