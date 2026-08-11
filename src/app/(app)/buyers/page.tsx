import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Badge } from '@/components/fx/primitives'
import { EmptyState } from '@/components/fx/feedback'
import { Eyebrow, SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { WorkCue } from '@/components/shell/work-cue'
import { canWrite, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'
import { buyerAccounts, pipeline } from '@/modules/buyers/queries'
import type { BuyerDeskPolicy } from '@/modules/buyers/service'
import { getPolicy } from '@/modules/settings/service'

import { LeadOpener } from './pipeline-client'
import { BuyerTermsButton } from './buyer-terms'
import { NewLead } from './new-lead'
import type { DrawerLead } from './lead-drawer'
import Link from 'next/link'

/**
 * 1.1 Buyer & Lead Desk.
 *
 * The board's job is to make a quiet lead impossible to miss, so the quiet ones
 * are lifted out above the pipeline rather than left to be spotted inside it.
 * "Twenty-one days on a division of a buyer we already ship to" is the easiest
 * order on the board, and it is exactly the row that gets scrolled past.
 */
export const dynamic = 'force-dynamic'

export default async function BuyersPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const policy = await getPolicy<BuyerDeskPolicy>(ctx, 'buyers')
  const now = new Date()

  const [board, accounts] = await Promise.all([
    pipeline(ctx, { now, quietAfterDays: policy.quietAfterDays }),
    buyerAccounts(ctx),
  ])

  const profile = await companyProfile(ctx)
  const mayWrite = canWrite(
    NAV.find((n) => n.id === 'buyers')!,
    ctx.roles,
    profile?.factoryType ?? 'woven',
  )

  /** What the drawer needs, from the card the board already has. */
  const drawerLead = (lead: (typeof board.quiet)[number]): DrawerLead => ({
    id: lead.id,
    companyName: lead.companyName,
    country: lead.country,
    stage: lead.stage,
    daysQuiet: lead.daysQuiet,
    lastActivity: lead.lastActivity,
  })

  const open = board.stages
    .filter((s) => s.stage !== 'won' && s.stage !== 'lost')
    .reduce((n, s) => n + s.leads.length, 0)

  return (
    <>
      <PageHeader
        eyebrow="Buyer & lead desk"
        title={open === 0 ? 'No open leads' : `${open} leads in play`}
        meta={board.quiet.length > 0 ? `${board.quiet.length} gone quiet` : undefined}
        {...(mayWrite ? { actions: <NewLead /> } : {})}
        /*
         * The button is this screen's amber moment when it is there, so the header's rule
         * goes muted — `ownsAmber`'s own contract: one primary action or one accent, never
         * both. For a read-only role there is no button, and the header takes it back.
         */
        ownsAmber={!mayWrite}
      />

      <WorkCue
        items={
          board.quiet.length > 0
            ? [
                {
                  label: `${board.quiet.length} quiet lead${board.quiet.length === 1 ? '' : 's'}`,
                  href: '/buyers',
                },
              ]
            : []
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
        {board.quiet.length > 0 ? (
          <section>
            <SectionHeading eyebrow={`quiet for ${policy.quietAfterDays}+ days`}>
              Nobody has touched these
            </SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {board.quiet.map((lead) => (
                <LeadOpener key={lead.id} lead={drawerLead(lead)} canWrite={mayWrite}>
                <div
                  className="fx-selvage"
                  data-status={lead.daysQuiet >= policy.quietAfterDays * 2 ? 'late' : 'at-risk'}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    boxShadow: 'var(--fx-sh1)',
                  }}
                >
                  <div style={{ padding: '16px 20px', display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <span style={{ font: "600 15px/1.3 var(--fx-font-sans)" }}>
                        {lead.companyName}
                      </span>
                      {lead.country ? <Badge>{lead.country}</Badge> : null}
                      <Badge tone="info">{stageLabel(lead.stage)}</Badge>
                      <span
                        data-numeric
                        style={{
                          marginLeft: 'auto',
                          font: "500 12px/1 var(--fx-font-mono)",
                          color: 'var(--fx-danger)',
                        }}
                      >
                        {lead.daysQuiet} days quiet
                      </span>
                    </div>
                    {lead.notes ? (
                      <div
                        style={{
                          font: "400 13.5px/1.55 var(--fx-font-sans)",
                          color: 'var(--fx-text-secondary)',
                          textWrap: 'pretty',
                        }}
                      >
                        {lead.notes}
                      </div>
                    ) : null}
                    <div style={{ font: "400 12px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}>
                      {lead.lastActivity
                        ? `last ${lead.lastActivity.kind} on ${lead.lastActivity.occurredAt}`
                        : 'nothing has ever been logged against this lead'}
                    </div>
                  </div>
                </div>
                </LeadOpener>
              ))}
            </div>
          </section>
        ) : null}

        <section>
          <SectionHeading>Pipeline</SectionHeading>

          {open === 0 && board.stages.every((s) => s.leads.length === 0) ? (
            <EmptyState
              title="No leads yet"
              body="A lead is anyone who might become a buyer — from a fair, a referral, a buying house or straight inbound. Logging the first call starts the quiet clock."
              action={
                mayWrite ? (
                  <span style={{ font: '400 13px/1.4 var(--fx-font-sans)', color: 'var(--fx-text-tertiary)' }}>
                    Use New lead above to start one.
                  </span>
                ) : (
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
                )
              }
            />
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 14,
                alignItems: 'start',
              }}
            >
              {board.stages.map((column) => (
                <div key={column.stage} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingBottom: 8,
                      borderBottom: '1px solid var(--fx-border-subtle)',
                    }}
                  >
                    <Eyebrow>{column.label}</Eyebrow>
                    <span
                      data-numeric
                      style={{
                        marginLeft: 'auto',
                        font: "500 12px/1 var(--fx-font-mono)",
                        color: 'var(--fx-text-tertiary)',
                      }}
                    >
                      {column.leads.length}
                    </span>
                  </div>

                  {column.leads.map((lead) => (
                    <LeadOpener key={lead.id} lead={drawerLead(lead)} canWrite={mayWrite}>
                    <div
                      style={{
                        background: 'var(--fx-bg-surface)',
                        border: '1px solid var(--fx-border-subtle)',
                        borderRadius: 'var(--fx-radius-md)',
                        padding: '13px 15px',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 7,
                        boxShadow: 'var(--fx-sh1)',
                      }}
                    >
                      <span style={{ font: "600 14px/1.3 var(--fx-font-sans)" }}>
                        {lead.companyName}
                      </span>
                      <span
                        style={{
                          font: "400 12.5px/1.45 var(--fx-font-sans)",
                          color: 'var(--fx-text-tertiary)',
                          display: '-webkit-box',
                          WebkitLineClamp: 3,
                          WebkitBoxOrient: 'vertical',
                          overflow: 'hidden',
                        }}
                      >
                        {lead.notes ?? '—'}
                      </span>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                        {lead.agentName ? (
                          <span
                            style={{ font: "400 11.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                          >
                            {lead.agentName}
                            {lead.agentCommissionPct ? ` · ${lead.agentCommissionPct}%` : ''}
                          </span>
                        ) : (
                          <span
                            style={{ font: "400 11.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                          >
                            direct
                          </span>
                        )}
                        <span
                          data-numeric
                          style={{
                            marginLeft: 'auto',
                            font: "400 11.5px/1.3 var(--fx-font-mono)",
                            color:
                              lead.daysQuiet >= policy.quietAfterDays
                                ? 'var(--fx-warning)'
                                : 'var(--fx-text-tertiary)',
                          }}
                        >
                          {lead.daysQuiet}d
                        </span>
                      </div>
                      {lead.lostReason ? (
                        <span
                          style={{ font: "400 11.5px/1.4 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                        >
                          lost · {lead.lostReason}
                        </span>
                      ) : null}
                    </div>
                    </LeadOpener>
                  ))}
                </div>
              ))}
            </div>
          )}
        </section>

        <section>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
            <SectionHeading eyebrow={`${accounts.length} accounts`}>Buyers</SectionHeading>
            {mayWrite ? (
              <BuyerTermsButton buyers={accounts.map((a) => ({ id: a.id, name: a.name }))} />
            ) : null}
          </div>

          {accounts.length === 0 ? (
            <div
              style={{
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                padding: 24,
                font: "400 14px/1.55 var(--fx-font-sans)",
                color: 'var(--fx-text-secondary)',
              }}
            >
              No buyers yet. Converting a won lead creates one.
            </div>
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
                  gridTemplateColumns: '.7fr 1.6fr 1fr .9fr .9fr',
                  gap: 14,
                  padding: '10px 18px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 11px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>Code</div>
                <div>Name</div>
                <div>Country</div>
                <div>Status</div>
                <div style={{ textAlign: 'right' }}>Open orders</div>
              </div>
              {accounts.map((b) => (
                <div
                  key={b.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '.7fr 1.6fr 1fr .9fr .9fr',
                    gap: 14,
                    padding: '13px 18px',
                    borderTop: '1px solid var(--fx-border-subtle)',
                    alignItems: 'center',
                    minHeight: 'var(--fx-row-height)',
                  }}
                >
                  <span data-mono style={{ font: "500 13px/1.3 var(--fx-font-mono)" }}>
                    {b.code}
                  </span>
                  <span style={{ font: "400 14px/1.3 var(--fx-font-sans)" }}>{b.name}</span>
                  <span style={{ font: "400 13px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                    {b.country ?? '—'}
                  </span>
                  <span>
                    <Badge tone={b.status === 'active' ? 'success' : 'neutral'}>{b.status}</Badge>
                  </span>
                  <span
                    data-numeric
                    style={{ font: "500 13px/1.3 var(--fx-font-mono)", textAlign: 'right' }}
                  >
                    {b.activeOrders}
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

function stageLabel(stage: string): string {
  return stage.replace(/_/g, ' ')
}
