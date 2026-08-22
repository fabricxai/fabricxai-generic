/**
 * What each module is called on the activation panel, in an owner's words.
 *
 * Module ids are folder names — `rfq`, `commercial`, `memory` — and the panel is the
 * one screen where a factory owner decides which departments this product runs, so
 * every id needs a name and one sentence saying what would go dark. Keyed by module
 * id, not nav id: nav entries are SCREENS (`lcs`, `ud`, `lines` are three doors into
 * two modules), while a flip acts on the module whole.
 *
 * `module-copy.test.ts` fails the moment a module registers without a row here — an
 * unlabeled toggle on this panel would be a switch marked only with its wiring.
 */
export interface ModuleCopy {
  label: string
  /** One sentence: what the factory loses by switching it off. */
  blurb: string
}

export const MODULE_COPY: Readonly<Record<string, ModuleCopy>> = {
  analytics: {
    label: 'Owner dashboard',
    blurb: 'The cross-department view — orders at risk, exposure, floor pace.',
  },
  approvals: {
    label: 'Approve inbox',
    blurb: 'Where drafts from MARBIM and juniors wait for a signature.',
  },
  buyers: {
    label: 'Buyers',
    blurb: 'Buyer accounts, contacts and history.',
  },
  commercial: {
    label: 'Commercial — LC & UD',
    blurb: 'Master and back-to-back LCs, customs declarations, bank documents.',
  },
  compliance: {
    label: 'Compliance',
    blurb: 'Audits, findings and certificates.',
  },
  costing: {
    label: 'Costing',
    blurb: 'Cost sheets and margins before a price goes out.',
  },
  cutting: {
    label: 'Cutting',
    blurb: 'Markers, lays and bundles between fabric and sewing.',
  },
  finance: {
    label: 'Finance',
    blurb: 'Invoices, realisations and the money position.',
  },
  maintenance: {
    label: 'Maintenance',
    blurb: 'Machines, breakdowns and preventive schedules.',
  },
  marbim: {
    label: 'MARBIM copilot',
    blurb: 'The assistant — chat, document intake and everything it drafts.',
  },
  memory: {
    label: 'Order memory',
    blurb: 'What closed orders teach about the next one.',
  },
  orders: {
    label: 'Orders',
    blurb: 'The order book itself.',
  },
  planning: {
    label: 'Planning',
    blurb: 'Line plans, capacity and the TNA calendar.',
  },
  procurement: {
    label: 'Procurement',
    blurb: 'Requisitions, supplier quotes and purchase orders.',
  },
  production: {
    label: 'Production',
    blurb: 'Sewing lines, endline counts and efficiency.',
  },
  quality: {
    label: 'Quality',
    blurb: 'Inline checks, endline defects and inspections.',
  },
  rfq: {
    label: 'RFQs & quotes',
    blurb: 'Buyer enquiries and the prices quoted back.',
  },
  sampling: {
    label: 'Sampling',
    blurb: 'Sample requests through PP approval — the gate cutting waits on.',
  },
  settings: {
    label: 'Settings',
    blurb: 'This screen. The switches live here, so it cannot be switched off.',
  },
  shipment: {
    label: 'Shipment',
    blurb: 'Packing, bookings, EXP numbers and export documents.',
  },
  store: {
    label: 'Store',
    blurb: 'Fabric and trims — receipts, rolls, issues and the UD drawdown.',
  },
  workforce: {
    label: 'Workforce',
    blurb: 'People, attendance and payroll.',
  },
}
