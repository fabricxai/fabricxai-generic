import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { EmptyState, InlineAlert, LockedState } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { CapActions } from '@/components/fx/cap-actions'
import { canSee, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { capExceptions, certificateLadder, openFindings } from '@/modules/compliance/service'

import { LogAuditButton, RaiseCapButton } from './compliance-doors'
import type { CompliancePolicy } from '@/modules/compliance/service'
import { companyProfile, getPolicy } from '@/modules/settings/service'
import { factoryToday } from '@/lib/dates'

/**
 * 10.2 Compliance & Audit ⚖.
 *
 * Three rules from the module show up as UI here rather than only as prose:
 *
 *  - **`expired` is its own state**, not "0 days remaining". A lapsed
 *    certificate is a different conversation from one expiring on Friday.
 *  - **Closure needs evidence, and the submitter cannot be the closer.**
 *    Self-certification is the first thing an auditor tests.
 *  - **A critical finding is escalated before its deadline.** The deadline is
 *    when a locked fire exit must be FIXED by, not when the owner may first be
 *    told about it.
 */
export const dynamic = 'force-dynamic'

export default async function CompliancePage({
  searchParams,
}: {
  searchParams: Promise<{ cap?: string }>
}) {
  const { cap: capFilter } = await searchParams
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const profile = await companyProfile(ctx)
  const item = NAV.find((n) => n.id === 'compliance')!
  if (!canSee(item, ctx.roles, profile?.factoryType ?? 'woven')) {
    return <LockedState what="compliance" />
  }

  const today = factoryToday()
  const policy = await getPolicy<CompliancePolicy>(ctx, 'compliance')

  const [ladder, allExceptions, findings] = await Promise.all([
    certificateLadder(ctx, today, policy),
    capExceptions(ctx, today),
    openFindings(ctx),
  ])

  /*
   * The CAP filter (role audit 2.7e). Three questions a compliance officer actually asks of
   * this list — what needs evidence, what is waiting on closure, what is already overdue —
   * as URL params rather than client state, so a filtered view can be sent to the person
   * who owns the CAP. At two rows the chips are furniture; at thirty they are the screen.
   */
  const exceptions = allExceptions.filter((e) => {
    switch (capFilter) {
      case 'evidence':
        return e.status === 'open' || e.status === 'in_progress'
      case 'closing':
        return e.status === 'evidence_submitted'
      case 'overdue':
        return e.deadline < today
      default:
        return true
    }
  })

  const expired = ladder.filter((c) => c.state === 'expired')
  const expiring = ladder.filter((c) => c.state !== 'expired' && c.rung !== null)
  const criticals = findings.filter((f) => f.finding.severity === 'critical')
  const canClose = ctx.roles.some((r) => policy.closerRoles.includes(r))
  const mayWrite = ctx.roles.some((r) => r === 'compliance' || r === 'admin' || r === 'owner')

  return (
    <>
      <PageHeader
        eyebrow="Compliance"
        actions={mayWrite ? <LogAuditButton /> : undefined}
        title={
          exceptions.length === 0 && expired.length === 0
            ? 'Nothing outstanding'
            : `${exceptions.length + expired.length} need attention`
        }
        meta={canClose ? undefined : 'read-only · cannot close CAPs'}
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
        {expired.length > 0 ? (
          <InlineAlert tone="danger">
            {expired.length} {expired.length === 1 ? 'certificate has' : 'certificates have'}{' '}
            lapsed. An expired certificate is not a certificate expiring soon — an audit
            arriving today would find the factory uncertified.
          </InlineAlert>
        ) : null}

        {criticals.length > 0 ? (
          <InlineAlert tone="danger">
            {criticals.length} critical{' '}
            {criticals.length === 1 ? 'finding is' : 'findings are'} still open. A critical finding
            fails an audit on its own, regardless of everything else in the file.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading eyebrow={`${ladder.length} on file`}>Certificates</SectionHeading>

          {ladder.length === 0 ? (
            <EmptyState
              title="No certificates on file"
              body="Fire safety, factory licence, bond licence and environmental clearance all carry expiry dates that an audit checks first."
            />
          ) : (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr 1fr',
                  gap: 12,
                  padding: '10px 18px 10px 21px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 11px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>Kind</div>
                <div>Expires</div>
                <div style={{ textAlign: 'right' }}>Days</div>
                <div style={{ textAlign: 'right' }}>State</div>
              </div>

              {ladder.map((c) => {
                const lapsed = c.state === 'expired'
                return (
                  <div
                    key={c.certificateId}
                    className="fx-selvage"
                    data-status={lapsed ? 'late' : c.rung !== null ? 'at-risk' : 'on-track'}
                    data-critical={lapsed || undefined}
                    style={{ borderTop: '1px solid var(--fx-border-subtle)' }}
                  >
                    <div
                      style={{
                        flex: 1,
                        display: 'grid',
                        gridTemplateColumns: '2fr 1fr 1fr 1fr',
                        gap: 12,
                        padding: '13px 18px',
                        alignItems: 'center',
                        minHeight: 'var(--fx-row-height)',
                      }}
                    >
                      <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>
                        {c.kind.replace(/_/g, ' ')}
                      </span>
                      <span
                        data-numeric
                        data-mono
                        style={{
                          font: "400 13px/1.3 var(--fx-font-mono)",
                          color: lapsed ? 'var(--fx-danger)' : 'var(--fx-text-secondary)',
                        }}
                      >
                        {c.expiresOn ?? 'no expiry'}
                      </span>
                      <span
                        data-numeric
                        style={{
                          font: "500 13px/1.3 var(--fx-font-mono)",
                          textAlign: 'right',
                          color: lapsed
                            ? 'var(--fx-danger)'
                            : c.rung !== null
                              ? 'var(--fx-warning)'
                              : 'var(--fx-text-tertiary)',
                        }}
                      >
                        {/* Perpetual certificates sort last and say so, rather
                            than showing a null that reads as "expires today". */}
                        {c.daysRemaining === null
                          ? 'perpetual'
                          : lapsed
                            ? `${Math.abs(c.daysRemaining)} over`
                            : c.daysRemaining}
                      </span>
                      <span style={{ textAlign: 'right' }}>
                        <Badge
                          tone={lapsed ? 'danger' : c.rung !== null ? 'warning' : 'success'}
                        >
                          {c.state}
                        </Badge>
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {expiring.length > 0 ? (
            <div
              style={{
                marginTop: 10,
                font: "400 13px/1.4 var(--fx-font-mono)",
                color: 'var(--fx-text-tertiary)',
              }}
            >
              {expiring.length} inside an alert rung · rungs at{' '}
              {policy.expiryRungs.join(', ')} days
            </div>
          ) : null}
        </section>

        <section>
          <SectionHeading eyebrow={`${exceptions.length} of ${allExceptions.length} shown`}>
            Corrective actions
          </SectionHeading>

          {allExceptions.length > 2 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, margin: '0 0 14px' }}>
              {(
                [
                  [undefined, 'All'],
                  ['evidence', 'Needs evidence'],
                  ['closing', 'Waiting on closure'],
                  ['overdue', 'Overdue'],
                ] as const
              ).map(([param, label]) => {
                const on = capFilter === param || (!capFilter && !param)
                return (
                  <Link
                    key={label}
                    href={param ? `/compliance?cap=${param}` : '/compliance'}
                    style={{
                      minHeight: 'var(--fx-tap-min)',
                      display: 'inline-flex',
                      alignItems: 'center',
                      padding: '8px 14px',
                      borderRadius: 'var(--fx-radius-sm)',
                      border: `1px solid ${on ? 'var(--fx-accent)' : 'var(--fx-border-default)'}`,
                      background: on ? 'var(--fx-accent-subtle)' : 'transparent',
                      color: 'var(--fx-text-primary)',
                      font: "500 12.5px/1 var(--fx-font-sans)",
                      textDecoration: 'none',
                    }}
                  >
                    {label}
                  </Link>
                )
              })}
            </div>
          ) : null}

          {exceptions.length === 0 ? (
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
              No corrective actions need attention. A CAP appears here while it is open, and a
              critical one appears before its deadline rather than after.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {exceptions.map((e) => (
                <div
                  key={e.capId}
                  className="fx-selvage"
                  data-status={e.severity === 'critical' ? 'late' : 'at-risk'}
                  data-critical={e.severity === 'critical' || undefined}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                  }}
                >
                  <div
                    style={{
                      padding: '14px 20px',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      flexWrap: 'wrap',
                      flex: 1,
                    }}
                  >
                    <Badge tone={e.severity === 'critical' ? 'danger' : 'warning'}>
                      {e.severity}
                    </Badge>
                    <Badge>{e.status.replace(/_/g, ' ')}</Badge>
                    <span
                      data-numeric
                      data-mono
                      style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                    >
                      due {e.deadline}
                    </span>
                    {/* Escalation is reported, not decided here — the service
                        computes it from severity and how close the deadline is. */}
                    {e.escalateTo ? (
                      <Badge tone="info">escalates to {String(e.escalateTo)}</Badge>
                    ) : null}
                    {!e.ownerUserId ? <Badge tone="warning">no owner</Badge> : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Open findings and their CAPs (canvas P2) ─────────────────── */}
        {findings.length > 0 ? (
          <section>
            <SectionHeading eyebrow={`${findings.length} open`}>
              Findings and corrective actions
            </SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {findings.map(({ finding, cap }) => {
                const evidence = (cap?.closureEvidence ?? []) as {
                  documentId?: string
                  note?: string
                }[]
                const daysToDeadline = cap?.deadline
                  ? Math.round(
                      (Date.parse(`${cap.deadline}T00:00:00Z`) -
                        Date.parse(`${today}T00:00:00Z`)) /
                        86_400_000,
                    )
                  : null

                return (
                  <div
                    key={finding.id}
                    className="fx-selvage"
                    // `critical` IS the zero-tolerance band in this enum — child labour,
                    // a locked fire exit. There is no separate state above it.
                    data-status={finding.severity === 'critical' ? 'late' : 'at-risk'}
                    data-critical={finding.severity === 'critical' || undefined}
                    style={{
                      background: 'var(--fx-bg-surface)',
                      border: '1px solid var(--fx-border-subtle)',
                      borderRadius: 'var(--fx-radius-md)',
                    }}
                  >
                    <div
                      style={{
                        padding: '14px 18px',
                        display: 'flex',
                        gap: 14,
                        alignItems: 'flex-start',
                        flexWrap: 'wrap',
                      }}
                    >
                      <Badge
                        tone={
                          finding.severity === 'critical'
                            ? 'danger'
                            : finding.severity === 'major'
                              ? 'warning'
                              : 'neutral'
                        }
                      >
                        {finding.severity.replace(/_/g, ' ')}
                      </Badge>
                      <span
                        style={{
                          flex: 1,
                          minWidth: 240,
                          font: "400 14px/1.5 var(--fx-font-sans)",
                        }}
                      >
                        {finding.text}
                      </span>
                      {!cap ? (
                        mayWrite ? (
                          <RaiseCapButton findingId={finding.id} />
                        ) : (
                          <span
                            style={{
                              font: "400 12px/1.4 var(--fx-font-mono)",
                              color: 'var(--fx-text-tertiary)',
                            }}
                          >
                            no corrective action opened yet
                          </span>
                        )
                      ) : null}
                    </div>

                    {cap ? (
                      <CapActions
                        cap={{
                          capId: cap.id,
                          status: cap.status,
                          severity: finding.severity,
                          deadline: cap.deadline,
                          daysToDeadline,
                          evidenceCount: evidence.length,
                          // A note is evidence; a document is proof. Only the second one
                          // closes a critical finding, so the two are counted apart.
                          hasDocument: evidence.some((e) => Boolean(e.documentId)),
                        }}
                        canClose={canClose}
                      />
                    ) : null}
                  </div>
                )
              })}
            </div>
          </section>
        ) : null}

        <Card padding="18px 22px">
          <div
            style={{
              font: "400 15px/1.6 var(--fx-font-sans)",
              color: 'var(--fx-text-secondary)',
              textWrap: 'pretty',
            }}
          >
            A corrective action closes only on evidence, and the person who submitted the
            evidence cannot be the one who accepts it. Self-certification is the first thing an
            auditor tests, and a system that permits it makes every closure in the pack
            arguable.
            {canClose ? null : ' Your role can read this file but cannot close a CAP.'}
          </div>
        </Card>
      </div>
    </>
  )
}
