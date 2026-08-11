import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { FloorScreen } from '@/components/fx/floor'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { WorkCue } from '@/components/shell/work-cue'
import { getCtx } from '@/modules/core/session'
import { orderList } from '@/modules/orders/queries'
import { ppApprovedStyles, sampleBoard, type SampleRow } from '@/modules/sampling/queries'
import { ppBlockingAlerts, type SamplingPolicy } from '@/modules/sampling/service'
import { getPolicy } from '@/modules/settings/service'

import { NewSampleButton } from './new-sample'

/**
 * 1.4 Sampling Room.
 *
 * This module owns the answer to the PP-approval gate that blocks cutting, so
 * the board leads with the PP samples rather than listing the room in date
 * order. A proto sample running late costs a few days; a PP sample running late
 * stops a cutting table.
 */
export const dynamic = 'force-dynamic'

const STAGES = ['pattern', 'cutting', 'sewing', 'finishing', 'qc', 'dispatched'] as const

export default async function SamplingPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const now = new Date()
  const today = now.toISOString().slice(0, 10)
  const policy = await getPolicy<SamplingPolicy>(ctx, 'sampling')
  const [samples, approvedStyles, blocking] = await Promise.all([
    sampleBoard(ctx, { now }),
    ppApprovedStyles(ctx),
    ppBlockingAlerts(ctx, { today }, policy),
  ])

  const pp = samples.filter((s) => s.type === 'pp')
  const ppOutstanding = pp.filter((s) => s.status !== 'approved' && s.status !== 'closed')
  const overdue = samples.filter(
    (s) =>
      s.daysToDue !== null &&
      s.daysToDue < 0 &&
      !['approved', 'rejected', 'closed'].includes(s.status),
  )

  const cueItems = [
    ...(blocking.length > 0
      ? [
          {
            label: `${blocking.length} PP style${blocking.length === 1 ? '' : 's'} blocking cut`,
            href: '/sampling',
          },
        ]
      : []),
    ...(overdue.length > 0
      ? [{ label: `${overdue.length} overdue sample${overdue.length === 1 ? '' : 's'}`, href: '/sampling' }]
      : []),
  ]

  return (
    <FloorScreen>
      <PageHeader
        eyebrow="Sampling room"
        title={samples.length === 0 ? 'No samples' : `${samples.length} samples`}
        meta={overdue.length > 0 ? `${overdue.length} overdue` : undefined}
        ownsAmber
        actions={
          <NewSampleButton
            orders={(await orderList(ctx))
              .filter((row) => !['shipped_full', 'closed', 'cancelled'].includes(row.status))
              .map((row) => ({
                id: row.id,
                label: `${row.poNumbers[0] ?? row.id.slice(0, 8)} · ${row.styleCode ?? ''}`,
                styleCode: row.styleCode,
              }))}
          />
        }
      />

      <WorkCue items={cueItems} />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        {ppOutstanding.length > 0 ? (
          <InlineAlert tone="warning">
            {ppOutstanding.length} PP {ppOutstanding.length === 1 ? 'sample is' : 'samples are'}{' '}
            still without a buyer verdict. Cutting cannot start on those styles — the gate fails
            closed, so nothing here needs to be switched on for that to hold.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading
            eyebrow={`${approvedStyles.length} ${approvedStyles.length === 1 ? 'style' : 'styles'} cleared`}
          >
            Pre-production approval
          </SectionHeading>

          {pp.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 22,
                font: "400 15px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              No PP samples requested yet. Until one is approved for a style, cutting on that
              style is blocked.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {pp.map((s) => (
                <SampleCard key={s.id} sample={s} highlight />
              ))}
            </div>
          )}
        </section>

        <section>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 16,
              flexWrap: 'wrap',
            }}
          >
            <SectionHeading eyebrow={`${samples.length - pp.length} others`}>
              The rest of the room
            </SectionHeading>
            {/* Everything above is the room now; this is what the room already learned. */}
            <Link
              href="/sampling/library"
              style={{
                font: "400 13px/1.4 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              Library — what the buyer said last time →
            </Link>
          </div>

          {samples.length - pp.length === 0 ? (
            <EmptyState
              title="Nothing else in the room"
              body="Proto, fit, SMS, TOP and shipment samples all pass through here. Only the PP verdict gates cutting."
              action={
                <Link
                  href="/orders"
                  style={{
                    font: '500 13px/1 var(--fx-font-sans)',
                    color: 'var(--fx-accent-pressed)',
                    textDecoration: 'none',
                  }}
                >
                  Open order desk →
                </Link>
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {samples
                .filter((s) => s.type !== 'pp')
                .map((s) => (
                  <SampleCard key={s.id} sample={s} />
                ))}
            </div>
          )}
        </section>
      </div>
    </FloorScreen>
  )
}

function SampleCard({ sample, highlight }: { sample: SampleRow; highlight?: boolean }) {
  const overdue =
    sample.daysToDue !== null &&
    sample.daysToDue < 0 &&
    !['approved', 'rejected', 'closed'].includes(sample.status)

  const status =
    sample.status === 'approved'
      ? 'on-track'
      : sample.status === 'rejected'
        ? 'late'
        : overdue
          ? 'late'
          : sample.status === 'closed'
            ? 'done'
            : 'at-risk'

  const stageIndex = sample.stage ? STAGES.indexOf(sample.stage as (typeof STAGES)[number]) : -1

  return (
    <div
      className="fx-selvage"
      data-status={status}
      data-critical={(highlight && overdue) || undefined}
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        boxShadow: 'var(--fx-sh1)',
      }}
    >
      <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 10, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <Link
        href={`/sampling/${sample.id}`}
        style={{ textDecoration: 'none', color: 'inherit' }}
        aria-label={`Open ${sample.requestNo}`}
      >
        <Ident size={14}>{sample.requestNo}</Ident>
      </Link>
          <Badge tone={sample.type === 'pp' ? 'accent' : 'neutral'}>{sample.type}</Badge>
          <span style={{ font: "600 16px/1.3 var(--fx-font-sans)" }}>{sample.styleCode}</span>
          {sample.poNumber ? (
            <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
              {sample.poNumber}
            </span>
          ) : null}
          <Badge
            tone={
              sample.status === 'approved'
                ? 'success'
                : sample.status === 'rejected'
                  ? 'danger'
                  : 'neutral'
            }
          >
            {sample.status.replace(/_/g, ' ')}
          </Badge>
          <span
            data-numeric
            data-mono
            style={{
              marginLeft: 'auto',
              font: "400 13px/1.3 var(--fx-font-mono)",
              color: overdue ? 'var(--fx-danger)' : 'var(--fx-text-tertiary)',
            }}
          >
            {sample.dueDate
              ? overdue
                ? `${Math.abs(sample.daysToDue!)} d overdue`
                : `due ${sample.dueDate}`
              : 'no due date'}
          </span>
        </div>

        {/* Stage progress as the slash rule, filling left to right. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ display: 'flex', gap: 5 }}>
            {STAGES.map((stage, i) => (
              <span
                key={stage}
                title={stage}
                style={{
                  width: 3,
                  height: 16,
                  transform: 'skewX(var(--fx-slash-angle))',
                  background:
                    i <= stageIndex ? 'var(--fx-text-primary)' : 'var(--fx-border-default)',
                }}
              />
            ))}
          </span>
          <span style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
            {sample.stage ?? 'not started'}
            {sample.roundCount > 0
              ? ` · round ${sample.roundCount}`
              : ''}
          </span>
        </div>

        {sample.latestVerdict ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span
              style={{
                font: "500 13.5px/1.4 var(--fx-font-sans)",
                color:
                  sample.latestVerdict.verdict === 'rejected'
                    ? 'var(--fx-danger)'
                    : sample.latestVerdict.verdict === 'approved'
                      ? 'var(--fx-success)'
                      : 'var(--fx-warning)',
              }}
            >
              round {sample.latestVerdict.round} · {sample.latestVerdict.verdict.replace(/_/g, ' ')}
            </span>

            {sample.latestVerdict.comments.map((c, i) => (
              <span
                key={i}
                style={{ font: "400 13.5px/1.5 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}
              >
                <strong style={{ color: 'var(--fx-text-primary)' }}>{c.area}</strong> — {c.comment}
                {c.page ? (
                  <span style={{ color: 'var(--fx-text-tertiary)' }}> · p.{c.page}</span>
                ) : null}
              </span>
            ))}

            {/* A rejection whose comments cannot be read is a sample nobody can
                remake correctly — said out loud rather than shown as no comment. */}
            {sample.latestVerdict.unreadableComments > 0 ? (
              <span style={{ font: "400 13px/1.4 var(--fx-font-mono)", color: 'var(--fx-danger)' }}>
                {sample.latestVerdict.unreadableComments} buyer{' '}
                {sample.latestVerdict.unreadableComments === 1 ? 'comment' : 'comments'} could not be
                read — ask for the comment sheet again before remaking
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  )
}
