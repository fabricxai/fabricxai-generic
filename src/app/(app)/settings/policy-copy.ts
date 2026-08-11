/**
 * Plain-language copy and field widgets for Settings → Factory rules.
 *
 * The registry in `modules/settings/policies.ts` owns types and defaults. This
 * file only decides how a human reads and edits those keys — labels, units,
 * grouping, and which control to draw. Nested objects are patched wholesale
 * (shallow merge on the server), so child fields here always rebuild the parent.
 */

export type PolicyFieldKind =
  | 'percent'
  | 'number'
  | 'decimal'
  | 'text'
  | 'boolean'
  | 'money'
  | 'days'
  | 'hours'
  | 'minutes'
  | 'string-list'
  | 'number-list'

export interface PolicyFieldCopy {
  key: string
  /** Dot path under a nested object parent, e.g. `weights.otd` under `scorecard`. */
  path?: string
  label: string
  help: string
  kind: PolicyFieldKind
  /** Unit suffix shown beside the control. */
  unit?: string
  min?: number
  max?: number
  step?: string
}

export interface PolicyModuleCopy {
  moduleId: string
  /** Plain intro under the module title. */
  blurb: string
  fields: readonly PolicyFieldCopy[]
  /**
   * Nested object keys whose children are listed with `path`. Editing any child
   * must PATCH the whole parent object (shallow merge).
   */
  objects?: Readonly<Record<string, readonly PolicyFieldCopy[]>>
}

export type PolicyConcernId =
  | 'commercial'
  | 'floor'
  | 'quality'
  | 'desk'
  | 'oversight'
  | 'platform'

export interface PolicyConcern {
  id: PolicyConcernId
  label: string
  blurb: string
  moduleIds: readonly string[]
}

export const POLICY_CONCERNS: readonly PolicyConcern[] = [
  {
    id: 'commercial',
    label: 'Money & trade documents',
    blurb: 'Margins, LC / BTB limits, receipts, and when bank documents escalate.',
    moduleIds: ['costing', 'rfq', 'finance', 'procurement', 'commercial', 'shipment'],
  },
  {
    id: 'floor',
    label: 'Floor & planning',
    blurb: 'How much extra you cut, when a line is behind, and what a shift looks like.',
    moduleIds: ['cutting', 'planning', 'production', 'sampling'],
  },
  {
    id: 'quality',
    label: 'Quality',
    blurb: 'Fabric points, DHU alerts, and how long a repeated defect must persist.',
    moduleIds: ['quality'],
  },
  {
    id: 'desk',
    label: 'Merchandising desk',
    blurb: 'Quiet leads, sampling gates, and drafts waiting too long in the inbox.',
    moduleIds: ['buyers', 'approvals'],
  },
  {
    id: 'oversight',
    label: 'Oversight',
    blurb: 'Owner scores, compliance deadlines, and machine downtime pricing.',
    moduleIds: ['analytics', 'compliance', 'maintenance'],
  },
  {
    id: 'platform',
    label: 'Platform',
    blurb: 'Email delivery, job health, and MARBIM rate limits.',
    moduleIds: ['delivery', 'job_health', 'marbim'],
  },
]

export const POLICY_MODULE_COPY: Readonly<Record<string, PolicyModuleCopy>> = {
  costing: {
    moduleId: 'costing',
    blurb: 'Protects the factory from approving sheets that make no money.',
    fields: [
      {
        key: 'marginFloorPct',
        label: 'Minimum margin',
        help: 'Below this achieved margin, only an owner can approve a cost sheet.',
        kind: 'percent',
        unit: '%',
      },
    ],
  },
  rfq: {
    moduleId: 'rfq',
    blurb: 'How quotations watch deadlines and follow up on buyer questions.',
    fields: [
      {
        key: 'marginFloorPct',
        label: 'Minimum quote margin',
        help: 'Same idea as costing — quotes under this need an owner.',
        kind: 'percent',
        unit: '%',
      },
      {
        key: 'deadlineNearHours',
        label: 'Deadline warning',
        help: 'Hours before a quote deadline when the desk treats it as urgent.',
        kind: 'hours',
        unit: 'hours',
        min: 0,
      },
      {
        key: 'clarificationStaleDays',
        label: 'Stale clarification',
        help: 'Days without an answer before a clarification is called stale.',
        kind: 'days',
        unit: 'days',
        min: 0,
      },
    ],
  },
  finance: {
    moduleId: 'finance',
    blurb: 'Cash timing and when margin erosion is worth a conversation.',
    fields: [
      {
        key: 'defaultRealizationLagDays',
        label: 'Typical payment lag',
        help: 'Days to assume if a buyer has no payment history. Never zero.',
        kind: 'days',
        unit: 'days',
        min: 1,
      },
      {
        key: 'marginErosionPct',
        label: 'Margin erosion alert',
        help: 'How much margin may slip before finance is alerted.',
        kind: 'percent',
        unit: '%',
      },
      {
        key: 'loadedLineDayRate',
        label: 'Loaded cost of one line-day',
        help: 'Local-currency cost used when CM is allocated. Leave blank rather than guess.',
        kind: 'decimal',
      },
    ],
  },
  procurement: {
    moduleId: 'procurement',
    blurb: 'Back-to-back LC headroom and what counts as a normal over-receipt.',
    fields: [
      {
        key: 'btbLimitPct',
        label: 'Back-to-back LC ceiling',
        help: 'Maximum share of a master LC that may be opened as BTB credits.',
        kind: 'number',
        unit: '%',
        min: 0,
        max: 100,
      },
      {
        key: 'overReceiptTolerancePct',
        label: 'Over-receipt tolerance',
        help: 'How much over the PO a mill delivery may land without a fight.',
        kind: 'percent',
        unit: '%',
      },
    ],
  },
  commercial: {
    moduleId: 'commercial',
    blurb: 'Bank discrepancies and BTB limits on the LC register.',
    fields: [
      {
        key: 'discrepancyEscalateAfterDays',
        label: 'Escalate bank discrepancies after',
        help: 'Days a discrepancy may sit before it is treated as urgent.',
        kind: 'days',
        unit: 'days',
        min: 0,
      },
      {
        key: 'explainShortfallAbovePct',
        label: 'Explain shortfall above',
        help: 'Realisation shortfall of this size or more needs an explanation.',
        kind: 'percent',
        unit: '%',
      },
      {
        key: 'btbLimitPct',
        label: 'Back-to-back LC ceiling',
        help: 'Same ceiling procurement uses when opening BTB credits.',
        kind: 'number',
        unit: '%',
        min: 0,
        max: 100,
      },
    ],
  },
  shipment: {
    moduleId: 'shipment',
    blurb: 'Time the bank needs between goods leaving and documents presenting.',
    fields: [
      {
        key: 'presentationDays',
        label: 'Bank presentation window',
        help: 'Days allowed between shipment and document presentation.',
        kind: 'days',
        unit: 'days',
        min: 0,
      },
    ],
  },
  cutting: {
    moduleId: 'cutting',
    blurb: 'How much extra cutters may lay, and when wastage is an anomaly.',
    fields: [
      {
        key: 'tolerancePct',
        label: 'Cut vs breakdown tolerance',
        help: 'Allowed extra (or short) pieces per size/colour cell.',
        kind: 'percent',
        unit: '%',
      },
      {
        key: 'defaultBundleSize',
        label: 'Default bundle size',
        help: 'Pieces in a bundle when the cutter does not override.',
        kind: 'number',
        unit: 'pcs',
        min: 1,
      },
      {
        key: 'wastageAlertPct',
        label: 'Wastage alert',
        help: 'Fabric used past the marker plan by this much raises an alert.',
        kind: 'percent',
        unit: '%',
      },
    ],
  },
  planning: {
    moduleId: 'planning',
    blurb: 'What “a full day” means when no calendar row exists.',
    fields: [
      {
        key: 'defaultEfficiencyPct',
        label: 'Default line efficiency',
        help: 'Expected efficiency when no learning curve applies. Planning at 100% over-commits.',
        kind: 'percent',
        unit: '%',
      },
      {
        key: 'defaultShiftMinutes',
        label: 'Default shift length',
        help: 'Minutes in a line-day when the calendar has no row (480 = 8 hours).',
        kind: 'minutes',
        unit: 'min',
        min: 1,
        max: 1440,
      },
    ],
  },
  production: {
    moduleId: 'production',
    blurb: 'When hourly tracking calls a line behind target.',
    fields: [
      {
        key: 'behindTargetPct',
        label: 'Behind-target threshold',
        help: 'Achievement against target below this is reported as behind.',
        kind: 'percent',
        unit: '%',
      },
    ],
  },
  sampling: {
    moduleId: 'sampling',
    blurb: 'How close to cut a missing PP approval still blocks the floor.',
    fields: [
      {
        key: 'ppBlockingWindowDays',
        label: 'PP blocking window',
        help: 'Days before sew when a missing PP approval still blocks cutting.',
        kind: 'days',
        unit: 'days',
        min: 0,
      },
    ],
  },
  quality: {
    moduleId: 'quality',
    blurb: 'Fabric acceptance, inline DHU, and repeat-defect patterns.',
    fields: [
      {
        key: 'aqlStandard',
        label: 'AQL standard',
        help: 'Which published sampling standard final inspection uses.',
        kind: 'text',
      },
      {
        key: 'fabricMaxPointsPer100SqYd',
        label: 'Fabric points limit',
        help: 'Maximum 4-point score per 100 square yards before a roll fails.',
        kind: 'decimal',
        unit: 'pts / 100 yd²',
      },
      {
        key: 'dhuAlertThreshold',
        label: 'DHU alert',
        help: 'Defects per hundred units at which a line is flagged.',
        kind: 'decimal',
        unit: 'DHU',
      },
      {
        key: 'repeatDefectDays',
        label: 'Repeat-defect window',
        help: 'Consecutive days the same defect must appear before it is a pattern.',
        kind: 'days',
        unit: 'days',
        min: 2,
      },
    ],
  },
  buyers: {
    moduleId: 'buyers',
    blurb: 'When a lead is quiet, and how close two names must be to count as duplicates.',
    fields: [
      {
        key: 'quietAfterDays',
        label: 'Quiet after',
        help: 'Days without activity before a lead is lifted onto the quiet list.',
        kind: 'days',
        unit: 'days',
        min: 1,
      },
      {
        key: 'duplicateThreshold',
        label: 'Duplicate name similarity',
        help: '0–1 trigram similarity above which two buyer names may be duplicates.',
        kind: 'number',
        min: 0,
        max: 1,
        step: '0.05',
      },
    ],
  },
  approvals: {
    moduleId: 'approvals',
    blurb: 'How long a draft may wait before the inbox treats it as aging.',
    fields: [
      {
        key: 'agingEscalateAfterHours',
        label: 'Escalate aging drafts after',
        help: 'Hours a draft may sit unreviewed before it is called aging.',
        kind: 'hours',
        unit: 'hours',
        min: 1,
      },
    ],
  },
  analytics: {
    moduleId: 'analytics',
    blurb: 'Owner dashboard cache, OTD sample size, and scorecard weights.',
    fields: [
      {
        key: 'ttlSeconds',
        label: 'Dashboard cache',
        help: 'Seconds a computed dashboard figure may be reused before refresh.',
        kind: 'number',
        unit: 'sec',
        min: 30,
      },
      {
        key: 'minShipmentsForOtd',
        label: 'Shipments needed for OTD',
        help: 'Minimum shipments before on-time delivery is scored.',
        kind: 'number',
        unit: 'shipments',
        min: 1,
      },
    ],
    objects: {
      scorecard: [
        {
          key: 'scorecard',
          path: 'minOrders',
          label: 'Orders needed for a scorecard',
          help: 'Minimum closed orders before a buyer scorecard is trusted.',
          kind: 'number',
          min: 1,
        },
        {
          key: 'scorecard',
          path: 'weights.otd',
          label: 'Weight: on-time delivery',
          help: 'Share of the buyer score from OTD (weights should sum near 1).',
          kind: 'number',
          min: 0,
          max: 1,
          step: '0.05',
        },
        {
          key: 'scorecard',
          path: 'weights.dhu',
          label: 'Weight: quality (DHU)',
          help: 'Share of the buyer score from quality.',
          kind: 'number',
          min: 0,
          max: 1,
          step: '0.05',
        },
        {
          key: 'scorecard',
          path: 'weights.margin',
          label: 'Weight: margin',
          help: 'Share of the buyer score from margin.',
          kind: 'number',
          min: 0,
          max: 1,
          step: '0.05',
        },
      ],
      trend: [
        {
          key: 'trend',
          path: 'minPoints',
          label: 'Points needed for a trend',
          help: 'Minimum history points before a trend is drawn.',
          kind: 'number',
          min: 2,
        },
        {
          key: 'trend',
          path: 'thresholdPct',
          label: 'Trend move that matters',
          help: 'Percentage move treated as a real change rather than noise.',
          kind: 'decimal',
          unit: '%',
        },
      ],
    },
  },
  compliance: {
    moduleId: 'compliance',
    blurb: 'CAP deadlines by severity and how soon expiring certificates escalate.',
    fields: [
      {
        key: 'expiryRungs',
        label: 'Certificate warning days',
        help: 'Days-before-expiry rungs that escalate a certificate, largest first (e.g. 90, 60, 30).',
        kind: 'number-list',
      },
      {
        key: 'closerRoles',
        label: 'Who may close findings',
        help: 'Comma-separated roles allowed to accept CAP evidence. Keep this short — never every role.',
        kind: 'string-list',
      },
    ],
    objects: {
      capDeadlineDays: [
        {
          key: 'capDeadlineDays',
          path: 'critical',
          label: 'CAP days — critical',
          help: 'Days allowed to close a critical finding.',
          kind: 'days',
          unit: 'days',
          min: 1,
        },
        {
          key: 'capDeadlineDays',
          path: 'major',
          label: 'CAP days — major',
          help: 'Days allowed to close a major finding.',
          kind: 'days',
          unit: 'days',
          min: 1,
        },
        {
          key: 'capDeadlineDays',
          path: 'minor',
          label: 'CAP days — minor',
          help: 'Days allowed to close a minor finding.',
          kind: 'days',
          unit: 'days',
          min: 1,
        },
        {
          key: 'capDeadlineDays',
          path: 'observation',
          label: 'CAP days — observation',
          help: 'Days allowed to close an observation.',
          kind: 'days',
          unit: 'days',
          min: 1,
        },
      ],
      requiredCertificates: [
        {
          key: 'requiredCertificates',
          path: 'rsc',
          label: 'Required — RSC',
          help: 'Comma-separated certificate kinds expected under RSC.',
          kind: 'string-list',
        },
        {
          key: 'requiredCertificates',
          path: 'bsci',
          label: 'Required — BSCI',
          help: 'Comma-separated certificate kinds expected under BSCI.',
          kind: 'string-list',
        },
        {
          key: 'requiredCertificates',
          path: 'sedex',
          label: 'Required — Sedex',
          help: 'Comma-separated certificate kinds expected under Sedex.',
          kind: 'string-list',
        },
        {
          key: 'requiredCertificates',
          path: 'buyer',
          label: 'Required — buyer',
          help: 'Comma-separated certificate kinds expected for buyer programmes.',
          kind: 'string-list',
        },
        {
          key: 'requiredCertificates',
          path: 'government',
          label: 'Required — government',
          help: 'Comma-separated certificate kinds expected for government licences.',
          kind: 'string-list',
        },
      ],
    },
  },
  maintenance: {
    moduleId: 'maintenance',
    blurb: 'Downtime cost and when a machine’s ticket count looks like an outlier.',
    fields: [
      {
        key: 'minFleetTickets',
        label: 'Minimum fleet tickets',
        help: 'Tickets needed across the fleet before outlier logic runs.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'outlierMultiple',
        label: 'Outlier multiple',
        help: 'A machine is an outlier at this many times the fleet average.',
        kind: 'number',
        min: 1,
        step: '0.5',
      },
      {
        key: 'outlierMinTickets',
        label: 'Minimum tickets for outlier',
        help: 'A machine needs at least this many tickets before it can be called an outlier.',
        kind: 'number',
        min: 1,
      },
    ],
    objects: {
      lineValuePerMinute: [
        {
          key: 'lineValuePerMinute',
          path: 'amount',
          label: 'Value of one line-minute',
          help: 'Loaded cost per minute of downtime. Leave blank — never invent this.',
          kind: 'decimal',
        },
        {
          key: 'lineValuePerMinute',
          path: 'currency',
          label: 'Currency',
          help: 'ISO currency for the line-minute rate (usually BDT).',
          kind: 'text',
        },
      ],
    },
  },
  delivery: {
    moduleId: 'delivery',
    blurb: 'Which alerts email, digest size, and the URL inside those emails.',
    fields: [
      {
        key: 'digestLimit',
        label: 'Digest item limit',
        help: 'Maximum items in a daily digest email.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'appUrl',
        label: 'App URL in emails',
        help: 'Base URL for deep links in notification emails (must be https in production).',
        kind: 'text',
      },
      {
        key: 'emailSeverities',
        label: 'Severities that email',
        help: 'Comma-separated: info, warning, critical. Usually only critical.',
        kind: 'string-list',
      },
    ],
  },
  job_health: {
    moduleId: 'job_health',
    blurb: 'When a scheduled job is late, stuck, or old enough to prune.',
    fields: [
      {
        key: 'toleranceFactor',
        label: 'Lateness tolerance',
        help: 'A job is late after this multiple of its normal interval.',
        kind: 'number',
        min: 1,
        step: '0.1',
      },
      {
        key: 'floorMinutes',
        label: 'Minimum lateness floor',
        help: 'Never call a job late sooner than this many minutes.',
        kind: 'minutes',
        unit: 'min',
        min: 1,
      },
      {
        key: 'stuckAfterMinutes',
        label: 'Stuck after',
        help: 'Minutes a running job may sit before it is treated as stuck.',
        kind: 'minutes',
        unit: 'min',
        min: 1,
      },
      {
        key: 'retentionDays',
        label: 'Job log retention',
        help: 'Days to keep job-run history.',
        kind: 'days',
        unit: 'days',
        min: 1,
      },
    ],
  },
  marbim: {
    moduleId: 'marbim',
    blurb: 'How hard MARBIM may work — documents per hour and daily token ceiling.',
    fields: [
      {
        key: 'extractionsPerHour',
        label: 'Extractions per hour',
        help: 'Maximum document extractions per company per hour.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'maxAttempts',
        label: 'Max extraction attempts',
        help: 'Retries before an extraction is abandoned.',
        kind: 'number',
        min: 1,
      },
      {
        key: 'dailyTokenCeiling',
        label: 'Daily token ceiling',
        help: 'Soft daily token budget across MARBIM calls.',
        kind: 'number',
        min: 1,
      },
    ],
  },
}

/** Fields shown for a module: scalars first, then known nested children. */
export function fieldsForModule(moduleId: string): PolicyFieldCopy[] {
  const copy = POLICY_MODULE_COPY[moduleId]
  if (!copy) return []
  const nested = Object.values(copy.objects ?? {}).flat()
  return [...copy.fields, ...nested]
}

export function moduleBlurb(moduleId: string): string | null {
  return POLICY_MODULE_COPY[moduleId]?.blurb ?? null
}
