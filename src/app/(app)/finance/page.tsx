import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { money, subtract } from '@/lib/money'
import { compareDecimalStrings, subtractDecimalStrings } from '@/lib/quantity'
import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { PayableAction } from '@/components/fx/payable-action'
import { Badge } from '@/components/fx/primitives'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { cashTimelineFor } from '@/modules/finance/service'
import {
  payableBook,
  positionByCurrency,
  profitability,
  receivableBook,
  type PayableRow,
  type ReceivableRow,
} from '@/modules/finance/queries'
import { shipmentBoard } from '@/modules/shipment/queries'

import { RaiseInvoiceButton } from './raise-invoice'

/**
 * 8.1 Commercial Finance.
 *
 * The money side of the credits and purchase orders: what is still owed to the
 * factory, what it still owes, and which orders made less than they were
 * quoted at.
 *
 * Nothing on this screen is netted across currencies. Receivables land in USD
 * and wages are paid in BDT, and there is no ambient exchange rate anywhere in
 * this system — a finance screen is the worst place to invent the first one.
 */
export const dynamic = 'force-dynamic'

/**
 * a + b on decimal strings, exactly. The aging buckets total a column the same way the
 * old float sum did (per bucket, no currency netting introduced here) — but a bucket of
 * numeric(14,2) receivables must not drift by a float's rounding.
 */
const addDecimalStrings = (a: string, b: string): string =>
  subtractDecimalStrings(a, b.startsWith('-') ? b.slice(1) : `-${b}`)

export default async function FinancePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const now = new Date()
  const [position, receivables, payables, orders] = await Promise.all([
    positionByCurrency(ctx),
    receivableBook(ctx, { now }),
    payableBook(ctx, { now }),
    profitability(ctx),
  ])

  // Eight weeks, in the currency the factory is most exposed in. A cash timeline in the
  // wrong currency is worse than none: it nets a USD receivable against a BDT payroll and
  // reports a comfortable position that does not exist.
  const today = now.toISOString().slice(0, 10)
  const primaryCurrency = position[0]?.currency ?? 'USD'
  const cash = await cashTimelineFor(ctx, {
    from: today,
    weeks: 8,
    currency: primaryCurrency,
  }).catch(() => null)

  // Aging is computed from the expected date, which is where the money was PROMISED — not
  // the invoice date. A buyer on 60-day terms is not overdue on day 31, and a book that
  // ages from the invoice makes every one of them look late.
  const AGE_BUCKETS = [
    { label: 'Current', min: 0, max: Infinity },
    { label: '1–30 d', min: -30, max: -1 },
    { label: '31–60 d', min: -60, max: -31 },
    { label: '60 d +', min: -Infinity, max: -61 },
  ]
  const aging = AGE_BUCKETS.map((bucket) => {
    const rows = receivables.filter(
      (r) =>
        r.status !== 'settled' &&
        r.daysToExpected !== null &&
        r.daysToExpected >= bucket.min &&
        r.daysToExpected <= bucket.max,
    )
    return {
      label: bucket.label,
      count: rows.length,
      total: rows.reduce((sum, r) => addDecimalStrings(sum, r.amount), '0.00'),
    }
  })

  /*
   * The shipments an invoice can be raised against (live-test finding, Phase 8: `invoices`
   * was a pending target nothing proposed). Read through shipment's own queries (rule 11).
   */
  const shipmentRows = await shipmentBoard(ctx)
  const invoiceChoices = shipmentRows.map((s) => ({
    id: s.id,
    orderId: s.orderId,
    label: `${s.poNumber ?? s.orderId.slice(0, 8)} · partial ${s.partialNo} · ${
      s.packedQty.toLocaleString()
    } pcs`,
    suggestedNumber: `INV-${(s.poNumber ?? s.orderId.slice(0, 8)).replace(/^PO-/, '')}-${s.partialNo}`,
  }))

  const overdueIn = receivables.filter((r) => r.daysToExpected !== null && r.daysToExpected < 0)
  const overdueOut = payables.filter((p) => p.daysToDue !== null && p.daysToDue < 0)
  const shortfalls = receivables.filter(
    (r) => r.shortfall && compareDecimalStrings(r.shortfall, '0') > 0,
  )

  return (
    <>
      <PageHeader
        eyebrow="Commercial finance"
        title={
          position.length === 0
            ? 'Nothing open'
            : `${receivables.length + payables.length} open items`
        }
        meta={overdueIn.length > 0 ? `${overdueIn.length} overdue in` : undefined}
        ownsAmber
        actions={<RaiseInvoiceButton shipments={invoiceChoices} />}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {shortfalls.length > 0 ? (
          <InlineAlert tone="warning">
            {shortfalls.length} {shortfalls.length === 1 ? 'realization came' : 'realizations came'}{' '}
            in short of the invoice. A shortfall is a discount, a claim or a bank charge — each
            needs a written reason, not a write-off.
          </InlineAlert>
        ) : null}

        {overdueOut.length > 0 ? (
          <InlineAlert tone="danger">
            {overdueOut.length} {overdueOut.length === 1 ? 'payable is' : 'payables are'} past due.
            A supplier who stops shipping is a production problem, not an accounts one.
          </InlineAlert>
        ) : null}

        {/* ── Eight weeks of cash (canvas P1) ─────────────────────────── */}
        {cash && cash.buckets.length > 0 ? (
          <section>
            <SectionHeading
              eyebrow={
                cash.firstNegativeWeek
                  ? `goes negative in the week of ${cash.firstNegativeWeek}`
                  : `closing position, week ${cash.buckets.length}`
              }
            >
              Eight weeks of cash · {cash.currency}
            </SectionHeading>

            <div style={{ overflowX: 'auto' }}>
              <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: 720 }}>
                <thead>
                  <tr>
                    {['Week of', 'In', 'Out', 'Net', 'Closing'].map((h) => (
                      <th
                        key={h}
                        style={{
                          textAlign: h === 'Week of' ? 'left' : 'right',
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--fx-border-default)',
                          font: "400 10.5px/1 var(--fx-font-mono)",
                          letterSpacing: '.06em',
                          textTransform: 'uppercase',
                          color: 'var(--fx-text-tertiary)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cash.buckets.map((bucket) => {
                    const negative = compareDecimalStrings(bucket.closingBalance, '0') < 0
                    return (
                      <tr key={bucket.weekStart}>
                        <td
                          style={{
                            padding: '9px 12px',
                            borderBottom: '1px solid var(--fx-border-subtle)',
                            font: "400 13px/1.3 var(--fx-font-mono)",
                            // The week the money runs out is the only cell anybody acts on.
                            borderLeft: negative ? '3px solid var(--fx-danger)' : undefined,
                          }}
                        >
                          {bucket.weekStart}
                        </td>
                        <td style={cashCell}>{bucket.inflow}</td>
                        <td style={cashCell}>{bucket.outflow}</td>
                        <td style={cashCell}>{bucket.net}</td>
                        <td
                          style={{
                            ...cashCell,
                            fontWeight: 600,
                            color: negative ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                          }}
                        >
                          {bucket.closingBalance}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {cash.excludedOutsideWindow > 0 ? (
              <p
                style={{
                  marginTop: 10,
                  marginBottom: 0,
                  font: "400 12px/1.6 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                {cash.excludedOutsideWindow} item
                {cash.excludedOutsideWindow === 1 ? ' falls' : 's fall'} outside these eight
                weeks and {cash.excludedOutsideWindow === 1 ? 'is' : 'are'} not in the totals —
                said out loud, because a timeline that quietly drops rows is one nobody can
                reconcile against the books.
              </p>
            ) : null}
          </section>
        ) : null}

        {/* ── What the buyers owe, by age (canvas P3) ──────────────────── */}
        {receivables.length > 0 ? (
          <section>
            <SectionHeading eyebrow="aged from the date the money was promised">
              What the buyers owe
            </SectionHeading>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                gap: 1,
                background: 'var(--fx-border-subtle)',
                border: '1px solid var(--fx-border-subtle)',
              }}
            >
              {aging.map((bucket, index) => (
                <div
                  key={bucket.label}
                  style={{ background: 'var(--fx-bg-surface)', padding: '14px 16px' }}
                >
                  <div
                    style={{
                      font: "400 10.5px/1 var(--fx-font-mono)",
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {bucket.label}
                  </div>
                  <div
                    style={{
                      marginTop: 6,
                      font: "600 20px/1.2 var(--fx-font-sans)",
                      // Anything past 30 days is money the factory has already spent.
                      color: index >= 2 ? 'var(--fx-danger)' : 'var(--fx-text-primary)',
                    }}
                  >
                    {bucket.total}
                  </div>
                  <div
                    style={{
                      marginTop: 3,
                      font: "400 11.5px/1.3 var(--fx-font-sans)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {bucket.count} {bucket.count === 1 ? 'invoice' : 'invoices'}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <SectionHeading eyebrow="never netted across currencies">Position</SectionHeading>
          {position.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 14px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              No open receivables or payables.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
              {position.map((p) => (
                <div
                  key={p.currency}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '18px 22px',
                    minWidth: 260,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 12,
                  }}
                >
                  <Eyebrow>{p.currency}</Eyebrow>
                  {/* Two figures, not one net number: the net of a USD
                      receivable and a BDT payable is a figure in neither. */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                        owed to us
                      </span>
                      <span data-numeric style={{ font: "600 20px/1.1 var(--fx-font-mono)", color: 'var(--fx-success)' }}>
                        {p.incoming}
                      </span>
                      <span style={{ font: "400 11.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                        {p.incomingCount} open
                      </span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, textAlign: 'right' }}>
                      <span style={{ font: "400 12px/1 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                        we owe
                      </span>
                      <span data-numeric style={{ font: "600 20px/1.1 var(--fx-font-mono)", color: 'var(--fx-text-primary)' }}>
                        {p.outgoing}
                      </span>
                      <span style={{ font: "400 11.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                        {p.outgoingCount} open
                      </span>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeading eyebrow={`${receivables.length} items`}>Coming in</SectionHeading>
          {receivables.length === 0 ? (
            <EmptyState
              title="No receivables"
              body="A receivable is opened when documents are submitted to the bank. Its expected date comes from the buyer's realization lag, not from the stated payment terms."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {receivables.map((r) => (
                <ReceivableRowView key={r.id} row={r} />
              ))}
            </div>
          )}
        </section>

        <section>
          <SectionHeading eyebrow={`${payables.length} items`}>Going out</SectionHeading>
          {payables.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 14px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              Nothing owed.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {payables.map((p) => (
                <PayableRowView key={p.id} row={p} />
              ))}
            </div>
          )}
        </section>

        {orders.length > 0 ? (
          <section>
            <SectionHeading eyebrow="worst first">What orders actually made</SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {orders.map((o) => (
                <div
                  key={o.orderId}
                  className="fx-selvage"
                  data-status={
                    o.actualMarginPct && o.quotedMarginPct
                      ? compareDecimalStrings(o.actualMarginPct, o.quotedMarginPct) < 0
                        ? 'at-risk'
                        : 'on-track'
                      : undefined
                  }
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                  }}
                >
                  <div style={{ padding: '14px 20px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'baseline', gap: 14, flexWrap: 'wrap' }}>
                      <span data-numeric data-mono style={{ font: "500 14px/1.3 var(--fx-font-mono)" }}>
                        {o.fobPrice} {o.currency}
                      </span>
                      <span data-numeric style={{ font: "600 18px/1.2 var(--fx-font-mono)" }}>
                        {o.actualMarginPct ?? '—'}%
                      </span>
                      <span
                        data-numeric
                        style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                      >
                        quoted {o.quotedMarginPct ?? '—'}%
                      </span>
                      {/* Both figures are on the same basis, read from the cost
                          sheet rather than assumed — a variance between margins
                          computed on different bases is made of arithmetic. */}
                      {o.marginBasis ? <Badge>on {o.marginBasis}</Badge> : null}
                    </div>

                    {o.variance.length > 0 ? (
                      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap' }}>
                        {o.variance.map((v) => (
                          <span
                            key={v.component}
                            style={{ font: "400 12.5px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                          >
                            {v.component}{' '}
                            <span
                              style={{
                                color: compareDecimalStrings(v.variance, '0') < 0
                                  ? 'var(--fx-danger)'
                                  : 'var(--fx-success)',
                              }}
                            >
                              {v.variance}
                            </span>
                          </span>
                        ))}
                      </div>
                    ) : null}

                    {o.varianceUnreadable > 0 ? (
                      <span style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-warning)' }}>
                        {o.varianceUnreadable} waterfall{' '}
                        {o.varianceUnreadable === 1 ? 'row' : 'rows'} could not be read — this
                        breakdown does not account for the whole variance
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </>
  )
}

function ReceivableRowView({ row }: { row: ReceivableRow }) {
  const late = row.daysToExpected !== null && row.daysToExpected < 0
  const short = row.shortfall && compareDecimalStrings(row.shortfall, '0') > 0

  return (
    <div
      className="fx-selvage"
      data-status={late ? 'late' : row.status === 'realized' ? 'done' : 'on-track'}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
      }}
    >
      <div
        style={{
          padding: '13px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          flex: 1,
          minHeight: 'var(--fx-row-height)',
        }}
      >
        {row.invoiceNumber ? <Ident size={13}>{row.invoiceNumber}</Ident> : null}
        <span data-numeric data-mono style={{ font: "500 15px/1.3 var(--fx-font-mono)" }}>
          {row.amount} {row.currency}
        </span>
        <Badge tone={row.status === 'realized' ? 'success' : 'neutral'}>
          {row.status.replace(/_/g, ' ')}
        </Badge>
        {short ? <Badge tone="warning">short {row.shortfall}</Badge> : null}

        <span
          data-numeric
          data-mono
          style={{
            marginLeft: 'auto',
            font: "400 13px/1.3 var(--fx-font-mono)",
            color: late ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
          }}
        >
          {row.expectedAt
            ? late
              ? `${Math.abs(row.daysToExpected!)} d overdue`
              : `expected ${row.expectedAt}`
            : 'no expected date'}
        </span>

        {/* The basis is shown so a wrong forecast can be explained rather than
            merely corrected next time. */}
        {row.expectedBasis && Object.keys(row.expectedBasis).length > 0 ? (
          <span
            style={{
              width: '100%',
              font: "400 12px/1.4 var(--fx-font-mono)",
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {Object.entries(row.expectedBasis)
              .map(([k, v]) => `${k.replace(/_/g, ' ')} ${v}`)
              .join(' · ')}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function PayableRowView({ row }: { row: PayableRow }) {
  const late = row.daysToDue !== null && row.daysToDue < 0

  return (
    <div
      className="fx-selvage"
      data-status={late ? 'late' : row.status === 'paid' ? 'done' : 'on-track'}
      data-critical={late || undefined}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
      }}
    >
      <div
        style={{
          padding: '13px 20px',
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          flexWrap: 'wrap',
          flex: 1,
          minHeight: 'var(--fx-row-height)',
        }}
      >
        {row.poNumber ? <Ident size={13}>{row.poNumber}</Ident> : null}
        <span style={{ font: "400 14px/1.3 var(--fx-font-sans)" }}>
          {row.supplierName ?? row.reference ?? '—'}
        </span>
        <span data-numeric data-mono style={{ font: "500 15px/1.3 var(--fx-font-mono)" }}>
          {row.amount} {row.currency}
        </span>
        <Badge tone={row.status === 'paid' ? 'success' : 'neutral'}>
          {row.status.replace(/_/g, ' ')}
        </Badge>
        <span
          data-numeric
          data-mono
          style={{
            marginLeft: 'auto',
            font: "400 13px/1.3 var(--fx-font-mono)",
            color: late ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
          }}
        >
          {row.dueAt
            ? late
              ? `${Math.abs(row.daysToDue!)} d past due`
              : `due ${row.dueAt}`
            : 'no due date'}
        </span>

        {/* Unpaid rows only. Offering to pay a settled payable is how a supplier gets paid
            twice, and the approver would have nothing to compare the amount against. */}
        {row.status !== 'paid' && row.status !== 'cancelled' ? (
          <PayableAction
            payableId={row.id}
            reference={row.supplierName ?? row.reference ?? 'payable'}
            amount={row.amount}
            currency={row.currency}
            outstanding={
              subtract(money(row.amount, row.currency), money(row.paidAmount ?? '0', row.currency))
                .amount
            }
          />
        ) : null}
      </div>
    </div>
  )
}

const cashCell: React.CSSProperties = {
  padding: '9px 12px',
  borderBottom: '1px solid var(--fx-border-subtle)',
  textAlign: 'right',
  font: "400 13px/1.3 var(--fx-font-mono)",
  whiteSpace: 'nowrap',
}
