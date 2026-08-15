/**
 * LC conflict detection (brief 1.3, Operations — "pure fn, used by API + nightly job").
 *
 * A Letter of Credit is the instrument that actually pays the factory. Two dates on it
 * end the conversation if they are missed:
 *
 *  - **latest shipment date** — ship after it and the bank can refuse the documents;
 *  - **expiry date** — present documents after it and the bank can refuse them.
 *
 * Either refusal turns a shipped order into an unpaid one, which is why a conflict is a
 * red alert in the order book, the order detail, shipment and the owner's exceptions feed
 * rather than a badge someone might notice.
 *
 * Lives in `commercial` because that module owns the `lcs` tables (architecture §2.3,
 * CLAUDE.md rule 11). It is pure and takes plain data, so orders can call it with rows it
 * already holds — a computation, not a cross-module read.
 */

export type LcStatus = 'draft' | 'active' | 'expired' | 'closed'

export interface LcForConflictCheck {
  id: string
  number: string
  /** Goods must be shipped on or before this date. */
  latestShipmentDate: string | null
  /** Documents must be presented on or before this date. */
  expiryDate: string | null
  status: LcStatus
}

export interface OrderForConflictCheck {
  id: string
  poNumbers: readonly string[]
  /** Null while the TNA has not been generated yet. */
  plannedExFactoryDate: string | null
  status: string
}

export type LcConflictKind =
  | 'latest_shipment'
  | 'expiry'
  | 'presentation_window'
  | 'unknown_ex_factory'

export interface LcConflict {
  kind: LcConflictKind
  lcId: string
  lcNumber: string
  orderId: string
  poNumbers: readonly string[]
  severity: 'critical' | 'warning'
  /** How many days past the limit. Absent for `unknown_ex_factory`. */
  daysOver?: number
  /** i18n key — never a display string (CLAUDE.md, definition of done). */
  messageKey: string
  facts: Record<string, string | number | null>
}

/**
 * Banks need the documents in hand before the LC expires, and assembling them (B/L,
 * invoice, packing list, certificate of origin, inspection certificate) takes days after
 * the goods leave. A shipment that is legal on the latest-shipment date can still be
 * unpayable because nobody could present in time.
 *
 * Ten days is the common working assumption; it is a parameter because it is a policy,
 * not a law, and Settings will own it per company.
 */
const DEFAULT_PRESENTATION_DAYS = 10

/** Orders that can no longer breach a future shipment date. */
const SETTLED_ORDER_STATUSES = new Set(['shipped_full', 'closed', 'cancelled'])

/** An LC that is not live cannot be breached by a future shipment. */
const LIVE_LC_STATUSES = new Set<LcStatus>(['draft', 'active'])

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000

function dayDiff(from: string, to: string): number {
  if (!ISO_DATE.test(from) || !ISO_DATE.test(to)) {
    throw new Error(`LC conflict check expects YYYY-MM-DD dates, got "${from}" / "${to}"`)
  }
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY)
}

export function detectLcConflicts(input: {
  lc: LcForConflictCheck
  orders: readonly OrderForConflictCheck[]
  /** Days needed between shipment and document presentation. */
  presentationDays?: number
}): LcConflict[] {
  const { lc } = input
  if (!LIVE_LC_STATUSES.has(lc.status)) return []

  const presentationDays = input.presentationDays ?? DEFAULT_PRESENTATION_DAYS
  const conflicts: LcConflict[] = []

  for (const order of input.orders) {
    if (SETTLED_ORDER_STATUSES.has(order.status)) continue

    const base = {
      lcId: lc.id,
      lcNumber: lc.number,
      orderId: order.id,
      poNumbers: order.poNumbers,
    }

    // Unknown is not the same as safe. An order with no ex-factory date cannot be
    // cleared, and returning "no conflict" is how one slips through the net.
    if (!order.plannedExFactoryDate) {
      conflicts.push({
        ...base,
        kind: 'unknown_ex_factory',
        severity: 'warning',
        messageKey: 'commercial.lc.conflict.unknown_ex_factory',
        facts: {
          latestShipmentDate: lc.latestShipmentDate,
          expiryDate: lc.expiryDate,
          reason:
            `This order has no ex-factory date, so it cannot be checked against ` +
            `${lc.number} — whose latest shipment date is ` +
            `${lc.latestShipmentDate ?? 'not stated'}. Unknown is not the same as safe.`,
        },
      })
      continue
    }

    const exFactory = order.plannedExFactoryDate

    /**
     * At most ONE finding per order, in the order the merchandiser would act on them.
     *
     * The three kinds are not independent: an order that misses the latest shipment date
     * necessarily has no presentation window either. Reporting both is technically true
     * and practically noise — it doubles the exceptions feed with a consequence of a
     * problem already listed, and a feed nobody finishes reading is a feed that hides
     * the real thing. Fix the shipment date and the derived finding disappears with it.
     */

    // "Not later than": shipping ON the latest shipment date is compliant. An off-by-one
    // here either cries wolf on a valid shipment or misses a real breach.
    if (lc.latestShipmentDate) {
      const daysOver = dayDiff(lc.latestShipmentDate, exFactory)
      if (daysOver > 0) {
        conflicts.push({
          ...base,
          kind: 'latest_shipment',
          severity: 'critical',
          daysOver,
          messageKey: 'commercial.lc.conflict.latest_shipment',
          facts: {
            plannedExFactoryDate: exFactory,
            latestShipmentDate: lc.latestShipmentDate,
            daysOver,
            /*
             * The dates, in the sentence itself.
             *
             * Only `reason` crosses a server action's boundary (lib/action-failure.ts), so
             * the catalogue copy's {plannedExFactoryDate} was reaching a merchandiser as a
             * literal brace. And this is the refusal that most needs its figures: "four days
             * past" is a countdown somebody can still act on, where "the credit cannot accept
             * this shipment" only says the truck is stuck.
             */
            reason:
              `This shipment leaves on ${exFactory}, ${daysOver} day(s) after ` +
              `${lc.number}'s latest shipment date of ${lc.latestShipmentDate}. The bank ` +
              `will refuse the presentation unless the credit is amended.`,
          },
        })
        continue
      }
    }

    if (!lc.expiryDate) continue

    // The goods cannot even ship before the credit dies.
    const daysOverExpiry = dayDiff(lc.expiryDate, exFactory)
    if (daysOverExpiry > 0) {
      conflicts.push({
        ...base,
        kind: 'expiry',
        severity: 'critical',
        daysOver: daysOverExpiry,
        messageKey: 'commercial.lc.conflict.expiry',
        facts: {
          plannedExFactoryDate: exFactory,
          expiryDate: lc.expiryDate,
          daysOver: daysOverExpiry,
          reason:
            `${lc.number} expired on ${lc.expiryDate}, ${daysOverExpiry} day(s) before this ` +
            `shipment leaves on ${exFactory}. There is nothing left to present against.`,
        },
      })
      continue
    }

    // Shipping is fine — but is there room left to present the documents?
    const available = dayDiff(exFactory, lc.expiryDate)
    if (available < presentationDays) {
      conflicts.push({
        ...base,
        kind: 'presentation_window',
        severity: 'critical',
        daysOver: presentationDays - available,
        messageKey: 'commercial.lc.conflict.presentation_window',
        facts: {
          plannedExFactoryDate: exFactory,
          expiryDate: lc.expiryDate,
          availableDays: available,
          requiredDays: presentationDays,
          reason:
            `Shipping on ${exFactory} leaves ${available} day(s) before ${lc.number} expires ` +
            `on ${lc.expiryDate}, and the documents need ${presentationDays}. The date is ` +
            `fine; the turnaround is not.`,
        },
      })
    }
  }

  return conflicts
}

/**
 * Back-to-back headroom (brief 1.3: `Σ(btb values) ≤ master.value × btb_limit_pct`).
 *
 * A back-to-back LC funds the fabric and trims for an order against the master LC the
 * buyer opened. Over-opening BTBs against a master is how a factory ends up owing more to
 * its suppliers than the buyer will ever pay it — so the check is a hard gate on import
 * POs, not a report.
 *
 * Money is decimal strings throughout; the comparison is done in integer paisa/cents so
 * no float ever touches an LC value.
 */
export function btbHeadroom(input: {
  masterValue: string
  existingBtbValues: readonly string[]
  limitPct: number
}): { limit: string; used: string; free: string; exceeded: boolean } {
  const toMinor = (value: string): bigint => {
    if (!/^-?\d+(\.\d{1,2})?$/.test(value)) {
      throw new Error(`"${value}" is not a money amount`)
    }
    const [whole = '0', fraction = ''] = value.replace('-', '').split('.')
    const minor = BigInt(whole + fraction.padEnd(2, '0'))
    return value.startsWith('-') ? -minor : minor
  }

  const toDecimal = (minor: bigint): string => {
    const negative = minor < 0n
    const digits = (negative ? -minor : minor).toString().padStart(3, '0')
    return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
  }

  // limitPct is a whole percentage (e.g. 75). Scale by 100 so the division is exact.
  const limitMinor = (toMinor(input.masterValue) * BigInt(Math.round(input.limitPct * 100))) / 10_000n
  const usedMinor = input.existingBtbValues.reduce((sum, value) => sum + toMinor(value), 0n)

  return {
    limit: toDecimal(limitMinor),
    used: toDecimal(usedMinor),
    free: toDecimal(limitMinor - usedMinor),
    exceeded: usedMinor > limitMinor,
  }
}
