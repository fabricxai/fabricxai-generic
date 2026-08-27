/**
 * The order's papers, rendered (design canvas, "Style & documents").
 *
 * Three panels whose data lives in three modules, and the assertions here are about the
 * claims the screen makes on their behalf: that a colourway list comes from the grid
 * rather than a field somebody maintains, that "measured" and "planned" consumption are
 * never allowed to look alike, and that an out-of-tolerance measurement is named rather
 * than coloured.
 */
import { render, screen, within } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

/*
 * The style panel's edit form imports the orders actions, and a `'use server'` file is an
 * ordinary import under jsdom — so it drags `env.ts` in, which refuses to load in a
 * browser. Mocked at the boundary, as the drawer's and the workspace's tests do. Nothing
 * here opens the form; `style-details-form.test.tsx` owns that.
 */
vi.mock('@/modules/orders/actions', () => ({ updateStyleDetails: vi.fn() }))

import type { BomDetailLine } from '@/modules/costing/queries'
import type { OrderDetail } from '@/modules/orders/queries'
import type { StyleMeasurementChart } from '@/modules/quality/queries'

import { StyleDossier } from '../../[orderId]/dossier'

const style = (over: Partial<NonNullable<OrderDetail['style']>> = {}) => ({
  id: 'style-1',
  styleCode: 'SH-4471',
  description: 'Rib crew tee 2-pack',
  contractedQty: 50_000,
  unitPrice: '4.85',
  currency: 'USD',
  activeRevision: 2,
  season: 'AW-26',
  customerLabel: 'H&M basics',
  patternNo: 'PTN-4471',
  basedOnStyle: 'SH-4102',
  packingMethod: 'Flat pack',
  ...over,
})

const breakdown = [
  { color: 'Navy', size: 'S', qty: 3_000 },
  { color: 'Navy', size: 'M', qty: 6_000 },
  { color: 'White', size: 'S', qty: 2_000 },
  { color: 'Heather grey', size: 'XXL', qty: 500 },
]

const line = (over: Partial<BomDetailLine> = {}): BomDetailLine => ({
  id: 'line-1',
  lineGroup: 'fabric',
  itemRef: 'KM-27917',
  spec: '95% cotton 5% elastane rib · 220 GSM',
  consumption: '1.1700',
  consumptionBasis: 'planned',
  uom: 'm',
  wastagePct: '3.00',
  sourcePage: 4,
  ...over,
})

const chart = (over: Partial<StyleMeasurementChart> = {}): StyleMeasurementChart => ({
  specId: 'spec-1',
  version: 2,
  unit: 'cm',
  points: [
    { name: 'Bust @ armhole flat', spec: '52.5', tolPlus: '1.0', tolMinus: '1.0', measured: '52.0', outOfTolerance: false },
    { name: 'Back neck width', spec: '18.5', tolPlus: '0.5', tolMinus: '0.5', measured: '19.4', outOfTolerance: true },
  ],
  lastCheck: { sampledSize: '12', result: 'fail', at: new Date('2026-08-06T09:00:00Z'), missingPoints: [] },
  ...over,
})

describe('the style panel', () => {
  it('reads the colourways and the size run off the grid, not off a field', () => {
    render(<StyleDossier style={style()} breakdown={breakdown} bom={null} chart={null} />)

    expect(screen.getByText(/Navy · White · Heather grey/)).toBeInTheDocument()
    expect(screen.getByText(/3 options/)).toBeInTheDocument()
    expect(screen.getByText('S – XXL')).toBeInTheDocument()
  })

  it('says a field is not recorded rather than printing a dash that reads as none', () => {
    render(
      <StyleDossier
        style={style({ season: null, patternNo: null, packingMethod: null })}
        breakdown={breakdown}
        bom={null}
        chart={null}
      />,
    )
    expect(screen.getAllByText('not recorded').length).toBeGreaterThanOrEqual(3)
  })

  it('names the pattern this one was cut from — repeat orders are the norm', () => {
    render(<StyleDossier style={style()} breakdown={breakdown} bom={null} chart={null} />)
    expect(screen.getByText(/based on SH-4102/)).toBeInTheDocument()
  })

  it('an order with no style says so instead of rendering empty panels', () => {
    render(<StyleDossier style={null} breakdown={[]} bom={null} chart={null} />)
    expect(screen.getByText(/no style on it yet/)).toBeInTheDocument()
  })
})

describe('fabric and trims', () => {
  it('groups by where the line sits in the garment, fabric first', () => {
    render(
      <StyleDossier
        style={style()}
        breakdown={breakdown}
        bom={{
          approved: true,
          sheetVersion: 3,
          lines: [line(), line({ id: 'line-2', lineGroup: 'trims', itemRef: 'Neck rib', spec: 'self fabric 1.8 cm' })],
        }}
        chart={null}
      />,
    )
    expect(screen.getByText('Fabric')).toBeInTheDocument()
    expect(screen.getByText('Trims')).toBeInTheDocument()
    expect(screen.getByText(/from the approved cost sheet · v3/)).toBeInTheDocument()
  })

  it('never lets a measured consumption look like an estimate', () => {
    render(
      <StyleDossier
        style={style()}
        breakdown={breakdown}
        bom={{
          approved: false,
          sheetVersion: null,
          lines: [line({ consumptionBasis: 'actual' })],
        }}
        chart={null}
      />,
    )
    expect(screen.getByText('measured')).toBeInTheDocument()
    expect(screen.getByText(/from the tech pack · not yet costed/)).toBeInTheDocument()
  })

  it('shows consumption with its wastage, at the BOM’s own precision', () => {
    render(
      <StyleDossier style={style()} breakdown={breakdown} bom={{ approved: true, sheetVersion: 1, lines: [line()] }} chart={null} />,
    )
    expect(screen.getByText(/1.1700 m/)).toBeInTheDocument()
    expect(screen.getByText(/\+3.00%/)).toBeInTheDocument()
  })

  it('explains what is missing when no BOM exists, and what that stops', () => {
    render(<StyleDossier style={style()} breakdown={breakdown} bom={null} chart={null} />)
    expect(screen.getByText(/No bill of materials exists for SH-4471/)).toBeInTheDocument()
    expect(screen.getByText(/sizes the fabric\s+requisition/)).toBeInTheDocument()
  })
})

describe('the measurement chart', () => {
  it('puts the measurement beside the spec it was judged against', () => {
    render(<StyleDossier style={style()} breakdown={breakdown} bom={null} chart={chart()} />)

    const row = screen.getByText('Back neck width').closest('div')!
    expect(within(row).getByText('18.5')).toBeInTheDocument()
    expect(within(row).getByText('19.4')).toBeInTheDocument()
  })

  it('names the points that failed rather than leaving it to a colour', () => {
    render(<StyleDossier style={style()} breakdown={breakdown} bom={null} chart={chart()} />)
    expect(screen.getByText(/1 point out of tolerance on the last check: Back neck width/)).toBeInTheDocument()
    // And says which chart version judged it — the check was not re-judged on read.
    expect(screen.getByText(/version live when the piece was measured/)).toBeInTheDocument()
  })

  it('says when a check was partial, because a partial check is not a clean one', () => {
    render(
      <StyleDossier
        style={style()}
        breakdown={breakdown}
        bom={null}
        chart={chart({ lastCheck: { sampledSize: '12', result: 'pass', at: new Date(), missingPoints: ['Sleeve length'] } })}
      />,
    )
    expect(screen.getByText(/1 point was not measured/)).toBeInTheDocument()
  })

  it('shows the spec alone when nothing has been measured on this order', () => {
    render(
      <StyleDossier
        style={style()}
        breakdown={breakdown}
        bom={null}
        chart={chart({ lastCheck: null, points: [{ name: 'Bust', spec: '52.5', tolPlus: '1.0', tolMinus: '1.0', measured: null, outOfTolerance: false }] })}
      />,
    )
    expect(screen.getByText(/nothing measured on this order yet/)).toBeInTheDocument()
    expect(screen.getByText('—')).toBeInTheDocument()
  })

  it('explains what a missing chart costs when a fit sample is rejected', () => {
    render(<StyleDossier style={style()} breakdown={breakdown} bom={null} chart={null} />)
    expect(screen.getByText(/a fit rejection cannot be argued with numbers/)).toBeInTheDocument()
  })
})
