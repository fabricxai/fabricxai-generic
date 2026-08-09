import { factoryMonth } from '@/lib/dates'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Card } from '@/components/fx/data'
import { LockedState } from '@/components/fx/feedback'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { Ident } from '@/components/fx/format'
import { PageHeader } from '@/components/shell/page-shell'
import { PayrollRunControl } from '@/components/fx/payroll-run'

import { AttendanceImport, GazetteDoor } from './payroll-doors'
import { canSee, NAV } from '@/components/shell/nav'
import { getCtx } from '@/modules/core/session'
import { companyProfile } from '@/modules/settings/service'
import {
  activeGazette,
  canSeePayroll,
  headcount,
  payrollRunList,
  roster,
} from '@/modules/workforce/queries'

/**
 * 10.1 Workforce & Payroll 🔒.
 *
 * The only screen in this product with a security posture of its own, and the
 * shape of the refusal is part of the contract:
 *
 *  - Payroll is **hr and owner only**, enforced in the service rather than by
 *    hiding a link. A deep link from any other role gets the locked card.
 *  - The locked card leaks **nothing** — no run count, no headcount, no column
 *    headers, no skeleton rows. A role that cannot see payroll should not learn
 *    the size or shape of what it cannot see.
 *  - Reading wage lines is **itself audited**. Who looked at whose pay is
 *    information worth keeping.
 *
 * The roster is not payroll. Headcount and sections are ordinary factory data,
 * so they render for anyone who can open the module — only the money is gated.
 */
export const dynamic = 'force-dynamic'

export default async function WorkforcePage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  // The module is HIDDEN from nav for roles without it, and a deep link has to
  // agree — otherwise "hidden" means only "not linked", and the roster leaks to
  // anyone who guesses the URL. Nav and page read the same rule.
  const profile = await companyProfile(ctx)
  const navItem = NAV.find((n) => n.id === 'workforce')!
  if (!canSee(navItem, ctx.roles, profile?.factoryType ?? 'woven')) {
    return <LockedState what="workforce" />
  }

  const maySeePay = canSeePayroll(ctx)

  // Ordinary factory data, deliberately outside the gate.
  const [people, sections] = await Promise.all([roster(ctx), headcount(ctx)])

  // Only fetched when the caller may see it — not fetched-then-hidden, which
  // would put wage figures in a payload the browser receives.
  const [gazette, runs] = maySeePay
    ? await Promise.all([activeGazette(ctx), payrollRunList(ctx)])
    : [null, []]

  const active = sections.reduce((n, s) => n + s.active, 0)

  return (
    <>
      <PageHeader
        eyebrow="Workforce"
        title={people.length === 0 ? 'No workers on file' : `${active} on the floor`}
        meta={maySeePay ? undefined : 'payroll hidden for your role'}
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        <section>
          <SectionHeading eyebrow={`${sections.length} sections`}>Headcount</SectionHeading>
          {sections.length === 0 ? (
            <Card>
              <span style={{ font: "400 15px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                No workers registered yet.
              </span>
            </Card>
          ) : (
            <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
              {sections.map((s) => (
                <div
                  key={s.section}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '16px 20px',
                    minWidth: 170,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 5,
                  }}
                >
                  <span
                    style={{
                      font: "500 11px/1 var(--fx-font-mono)",
                      letterSpacing: '.08em',
                      textTransform: 'uppercase',
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {s.section}
                  </span>
                  <span data-numeric style={{ font: "600 26px/1.1 var(--fx-font-sans)" }}>
                    {s.active}
                  </span>
                  {s.onLeave > 0 ? (
                    <span
                      data-numeric
                      style={{ font: "400 12.5px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-tertiary)' }}
                    >
                      {s.onLeave} on leave
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── Everything below this line is 🔒 ────────────────────────── */}
        {maySeePay ? (
          <>
            <section>
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <SectionHeading eyebrow={gazette ? `v${gazette.version}` : undefined}>
                  Wage gazette
                </SectionHeading>
                <span style={{ marginLeft: 'auto' }}>
                  <GazetteDoor />
                </span>
              </div>

              {!gazette ? (
                <Card>
                  <span
                    style={{ font: "400 15px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}
                  >
                    No gazette is active. Payroll cannot be computed without one — the grade
                    table is uploaded and activated rather than typed in, so a run can always
                    name the version it was calculated against.
                  </span>
                </Card>
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
                      gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr',
                      gap: 12,
                      padding: '10px 20px',
                      background: 'var(--fx-bg-sunken)',
                      font: "500 11px/1 var(--fx-font-mono)",
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    <div>Grade</div>
                    <div style={{ textAlign: 'right' }}>Basic</div>
                    <div style={{ textAlign: 'right' }}>House</div>
                    <div style={{ textAlign: 'right' }}>Medical</div>
                    <div style={{ textAlign: 'right' }}>Transport</div>
                    <div style={{ textAlign: 'right' }}>Food</div>
                  </div>

                  {gazette.grades.map((g) => (
                    <div
                      key={g.grade}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr 1fr',
                        gap: 12,
                        padding: '12px 20px',
                        borderTop: '1px solid var(--fx-border-subtle)',
                        alignItems: 'center',
                        minHeight: 'var(--fx-row-height)',
                      }}
                    >
                      <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>{g.grade}</span>
                      <Taka value={g.basic} strong />
                      <Taka value={g.houseRent} />
                      <Taka value={g.medical} />
                      <Taka value={g.transport} />
                      <Taka value={g.food} />
                    </div>
                  ))}

                  <div
                    style={{
                      padding: '11px 20px',
                      borderTop: '1px solid var(--fx-border-subtle)',
                      font: "400 12.5px/1.5 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    effective {gazette.effectiveFrom} · overtime is 2× basic hourly (basic ÷ 208) ·
                    two festival bonuses a year, pro-rated
                  </div>
                </div>
              )}
            </section>

            <section>
              <SectionHeading eyebrow={`${runs.length} runs`}>Payroll</SectionHeading>

              {/* The device export lands here first — a run computed on an empty month is
                  a payroll of absences (live-test finding, Phase 9). */}
              <AttendanceImport />

              <PayrollRunControl
                defaultPeriod={factoryMonth()}
                openRun={
                  // The newest run that is not yet disbursed — the one a period's work is
                  // still happening against.
                  runs.find((r) => r.disbursedAt === null)
                    ? {
                        id: runs.find((r) => r.disbursedAt === null)!.id,
                        period: runs.find((r) => r.disbursedAt === null)!.period,
                        status: runs.find((r) => r.disbursedAt === null)!.status,
                        totalNet: null,
                        lineCount: runs.find((r) => r.disbursedAt === null)!.lineCount,
                      }
                    : null
                }
                canApprove={ctx.roles.includes('owner')}
              />
              {runs.length === 0 ? (
                <Card>
                  <span
                    style={{ font: "400 15px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}
                  >
                    No payroll runs yet. A run is computed against the gazette in force, and the
                    rules it used are snapshotted onto it — so a figure can be defended years
                    later without re-deriving it from today&rsquo;s rules.
                  </span>
                </Card>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {runs.map((r) => (
                    <div
                      key={r.id}
                      className="fx-selvage"
                      data-status={
                        r.disbursedAt ? 'done' : r.approvedAt ? 'on-track' : 'at-risk'
                      }
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
                        <Ident size={14}>{r.period}</Ident>
                        <Badge
                          tone={
                            r.status === 'disbursed'
                              ? 'success'
                              : r.status === 'approved'
                                ? 'info'
                                : 'neutral'
                          }
                        >
                          {r.status}
                        </Badge>
                        <span
                          data-numeric
                          style={{ font: "400 13px/1.3 var(--fx-font-mono)", color: 'var(--fx-text-secondary)' }}
                        >
                          {r.lineCount} workers
                        </span>
                        <span
                          style={{
                            marginLeft: 'auto',
                            font: "400 12.5px/1.3 var(--fx-font-mono)",
                            color: 'var(--fx-text-tertiary)',
                          }}
                        >
                          {r.disbursedAt
                            ? `disbursed ${r.disbursedAt.toISOString().slice(0, 10)}`
                            : r.approvedAt
                              ? `approved ${r.approvedAt.toISOString().slice(0, 10)}`
                              : 'not yet approved'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div
                style={{
                  marginTop: 10,
                  font: "400 12.5px/1.5 var(--fx-font-mono)",
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                opening a run&rsquo;s lines is recorded — who read whose wages, and when
              </div>
            </section>
          </>
        ) : (
          /* The locked card says only that access is missing. No counts, no
             headers, no skeletons — the shape of what is hidden is hidden too. */
          <LockedState what="payroll" />
        )}

        <section>
          <SectionHeading eyebrow={`${people.length} shown`}>Roster</SectionHeading>
          {people.length === 0 ? (
            <Card>
              <span style={{ font: "400 15px/1.55 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                No workers on file.
              </span>
            </Card>
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
                  gridTemplateColumns: '.8fr 1.6fr 1.1fr .7fr 1fr .8fr',
                  gap: 12,
                  padding: '10px 20px',
                  background: 'var(--fx-bg-sunken)',
                  font: "500 11px/1 var(--fx-font-mono)",
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  color: 'var(--fx-text-tertiary)',
                }}
              >
                <div>ID</div>
                <div>Name</div>
                <div>Designation</div>
                <div>Grade</div>
                <div>Section</div>
                <div>Line</div>
              </div>

              {people.map((w) => (
                <div
                  key={w.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '.8fr 1.6fr 1.1fr .7fr 1fr .8fr',
                    gap: 12,
                    padding: '12px 20px',
                    borderTop: '1px solid var(--fx-border-subtle)',
                    alignItems: 'center',
                    minHeight: 'var(--fx-row-height)',
                  }}
                >
                  <Ident size={13}>{w.employeeNo}</Ident>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ font: "500 14px/1.3 var(--fx-font-sans)" }}>{w.name}</span>
                    {/* The floor reads Bangla; the name is shown as written. */}
                    {w.nameBn ? (
                      <span lang="bn" style={{ font: "400 13px/1.4 var(--fx-font-bangla)", color: 'var(--fx-text-tertiary)' }}>
                        {w.nameBn}
                      </span>
                    ) : null}
                  </div>
                  <span style={{ font: "400 13.5px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                    {w.designation ?? '—'}
                  </span>
                  <span style={{ font: "400 13px/1.3 var(--fx-font-mono)" }}>{w.grade ?? '—'}</span>
                  <span style={{ font: "400 13.5px/1.3 var(--fx-font-sans)", color: 'var(--fx-text-secondary)' }}>
                    {w.section ?? '—'}
                  </span>
                  <span>{w.lineCode ? <Badge>{w.lineCode}</Badge> : null}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

/** Wages are BDT — local currency, and always labelled as such. */
function Taka({ value, strong }: { value: string; strong?: boolean }) {
  return (
    <span
      data-numeric
      data-mono
      style={{
        font: `${strong ? 600 : 400} ${strong ? 14 : 13}px/1.3 var(--fx-font-mono)`,
        textAlign: 'right',
        color: strong ? 'var(--fx-text-primary)' : 'var(--fx-text-secondary)',
      }}
    >
      ৳{value}
    </span>
  )
}
