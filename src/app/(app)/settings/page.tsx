import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { auditTrail, auditedTables, companyProfile, listPolicies, roleMatrix } from '@/modules/settings/service'
import { activeLines } from '@/modules/production/queries'
import { listApprovalRules } from '@/modules/approvals/queries'
import { ApprovalRules } from './approval-rules'

import { AuditViewer } from './audit-viewer'
import { PolicySection } from './policy-section'
import { LineScopeControls } from './line-scope'
import { RoleControls } from './role-controls'
import { FactoryTypePanel, ProfileForm } from './settings-client'

/**
 * X.3 Settings & Admin ⚖.
 *
 * Everything here is read for any signed-in user and editable only by owner or
 * admin — the service enforces that, so a non-admin sees the same figures and
 * simply has no form.
 */
export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const canEdit = ctx.roles.includes('owner') || ctx.roles.includes('admin')

  const [profile, policies, matrix, approvalRuleRows, lineRows] = await Promise.all([
    companyProfile(ctx),
    listPolicies(ctx),
    roleMatrix(ctx),
    listApprovalRules(ctx),
    // Read unscoped on purpose: an admin narrowing somebody else has to see every line,
    // including the ones they do not supervise themselves.
    activeLines({ companyId: ctx.companyId, userId: ctx.userId, roles: ctx.roles }),
  ])

  const lineCodes = lineRows.map((line) => line.code)

  // The trail names who did what, so it is owner and admin only — a screen showing
  // everybody every action turns an accountability record into a surveillance one.
  const [trail, trailTables] = canEdit
    ? await Promise.all([auditTrail(ctx, { limit: 200 }), auditedTables(ctx)])
    : [[], []]

  return (
    <>
      <PageHeader
        eyebrow="Settings"
        title={profile?.legalName ?? 'This factory'}
        meta={canEdit ? undefined : 'read-only'}
        ownsAmber={!canEdit}
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
        {/*
          The jump strip (plan 2.4, audit S4b). Fifty-eight inputs on one page is fine for
          the once-a-quarter visit ONLY if "cut tolerance" is reachable without scrolling
          past payroll — anchors, not per-module routes, because splitting the page would
          break the one thing it does well: everything the factory is configured by,
          reviewable in one scroll.
        */}
        <nav
          aria-label="Settings sections"
          style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: -8 }}
        >
          {[
            ['#identity', 'Identity'],
            ['#factory-type', 'What it makes'],
            ['#rules-commercial', 'Money & documents'],
            ['#rules-floor', 'Floor & planning'],
            ['#rules-quality', 'Quality'],
            ['#rules-desk', 'Desks'],
            ['#rules-oversight', 'Oversight'],
            ['#rules-platform', 'Platform'],
            ['#people', 'People'],
            ['#routing', 'Approval routing'],
            ['#audit', 'Audit trail'],
          ].map(([href, label]) => (
            <a
              key={href}
              href={href}
              style={{
                font: '500 12.5px/1 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
                textDecoration: 'none',
                border: '1px solid var(--fx-border-default)',
                borderRadius: 'var(--fx-radius-sm)',
                padding: '8px 12px',
                minHeight: 'var(--fx-tap-min)',
                display: 'inline-flex',
                alignItems: 'center',
              }}
            >
              {label}
            </a>
          ))}
        </nav>

        <section id="identity" style={{ scrollMarginTop: 76 }}>
          <SectionHeading>Identity</SectionHeading>
          <ProfileForm
            canEdit={canEdit}
            profile={
              profile
                ? {
                    legalName: profile.legalName,
                    addressLines: profile.addressLines,
                    country: profile.country,
                    binNumber: profile.binNumber,
                    tinNumber: profile.tinNumber,
                    bondLicenceNo: profile.bondLicenceNo,
                    factoryType: profile.factoryType,
                    timezone: profile.timezone,
                    locale: profile.locale,
                    baseCurrency: profile.baseCurrency,
                    localCurrency: profile.localCurrency,
                  }
                : null
            }
          />
        </section>

        <section id="factory-type" style={{ scrollMarginTop: 76 }}>
          <SectionHeading eyebrow="changes which modules exist">What this unit makes</SectionHeading>
          <FactoryTypePanel current={profile?.factoryType ?? 'woven'} />
        </section>

        <PolicySection
          canEdit={canEdit}
          policies={policies.map((p) => ({
            moduleId: p.moduleId,
            label: p.label,
            effective: p.effective,
            overrides: p.overrides,
            unresolvable: p.unresolvable,
          }))}
        />

        <section id="people" style={{ scrollMarginTop: 76 }}>
          <SectionHeading eyebrow={`${matrix.length} people`}>Who can do what</SectionHeading>
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
                gridTemplateColumns: canEdit ? '1.2fr 1.6fr 2fr 1.6fr' : '1.2fr 1.6fr 2fr',
                gap: 14,
                padding: '10px 18px',
                background: 'var(--fx-bg-sunken)',
                font: "500 11px/1 var(--fx-font-mono)",
                letterSpacing: '.06em',
                textTransform: 'uppercase',
                color: 'var(--fx-text-tertiary)',
              }}
            >
              <div>Name</div>
              <div>Email</div>
              <div>Roles</div>
              {canEdit ? <div>Change</div> : null}
            </div>
            {matrix.map((row) => (
              <div
                key={row.userId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: canEdit ? '1.2fr 1.6fr 2fr 1.6fr' : '1.2fr 1.6fr 2fr',
                  gap: 14,
                  padding: '13px 18px',
                  borderTop: '1px solid var(--fx-border-subtle)',
                  alignItems: 'center',
                  minHeight: 'var(--fx-row-height)',
                }}
                className="fx-stack-tablet"
              >
                <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>{row.name ?? '—'}</span>
                <span
                  data-mono
                  style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                >
                  {row.email ?? '—'}
                </span>
                <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {row.roles.filter((r) => !r.revokedAt).map((r) => (
                    <Badge key={r.role}>{r.role}</Badge>
                  ))}
                  {/* A revoked role is shown struck rather than removed: "was an
                      admin until Tuesday" is the question an audit actually asks. */}
                  {row.roles
                    .filter((r) => r.revokedAt)
                    .map((r) => (
                      <span
                        key={`${r.role}-revoked`}
                        style={{
                          font: "500 11px/1 var(--fx-font-mono)",
                          letterSpacing: '.05em',
                          textTransform: 'uppercase',
                          color: 'var(--fx-text-tertiary)',
                          textDecoration: 'line-through',
                          padding: '5px 8px',
                        }}
                      >
                        {r.role}
                      </span>
                    ))}
                </span>

                {canEdit ? (
                  <>
                    <RoleControls
                      userId={row.userId}
                      held={row.roles.filter((r) => !r.revokedAt).map((r) => r.role)}
                    />
                    {/*
                      * Which lines each role covers. Stored since the schema shipped, read by
                      * the line screens and now enforced by the production service — and
                      * settable by nothing but SQL until this (§9, F46).
                      */}
                    <LineScopeControls
                      userId={row.userId}
                      lines={lineCodes}
                      held={row.roles
                        .filter((r) => !r.revokedAt)
                        .map((r) => ({
                          role: r.role,
                          lines: Array.isArray((r.scope as { lines?: unknown }).lines)
                            ? ((r.scope as { lines: unknown[] }).lines.filter(
                                (l): l is string => typeof l === 'string',
                              ))
                            : [],
                        }))}
                    />
                  </>
                ) : null}
              </div>
            ))}
          </div>
        </section>

        <section id="routing" style={{ scrollMarginTop: 76 }}>
          <SectionHeading eyebrow="who signs which drafts">Approval routing</SectionHeading>
          <ApprovalRules rules={approvalRuleRows} canEdit={ctx.roles.includes('owner')} />
        </section>

        {canEdit ? (
          <section id="audit" style={{ scrollMarginTop: 76 }}>
            <SectionHeading eyebrow="who changed what, and when">The audit trail</SectionHeading>
            <AuditViewer
              initial={trail.map((row) => ({
                id: String(row.id),
                actorUserId: row.actorUserId,
                actorName: row.actorName,
                actorRole: row.actorRole,
                action: row.action,
                targetTable: row.targetTable,
                targetId: row.targetId,
                changedFields: row.changedFields,
                occurredAt: row.occurredAt.toISOString(),
              }))}
              tables={trailTables}
            />
          </section>
        ) : null}
      </div>
    </>
  )
}
