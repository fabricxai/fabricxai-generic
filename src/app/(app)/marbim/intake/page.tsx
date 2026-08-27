import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { desc } from 'drizzle-orm'

import { Breadcrumbs } from '@/components/fx/data'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { LockedState } from '@/components/fx/feedback'
import { PageHeader } from '@/components/shell/page-shell'
import { env } from '@/lib/env'
import { FloorTabs } from '@/components/shell/floor-tabs'
import { activeModuleIds } from '@/modules/core/activation'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { intakeKindsFor } from '@/modules/marbim/intake'
import { extractionJobs } from '@/modules/marbim/schema'

import { IntakeClient } from './intake-client'

/**
 * X.2 MARBIM · document intake.
 *
 * Say what a document is, give MARBIM its text, and it drafts into the module that owns it.
 *
 * **You pick the type, and that is the design rather than a shortfall.** The canvas asks for
 * a drop-zone that classifies first — "you never pick a type" — and a classifier that guesses
 * wrong is worse than one that does not exist: a tech pack filed as a buyer PO produces a
 * draft in an approve inbox that looks exactly like a right one. The person holding the paper
 * already knows what it is. A classifier would have saved them one tap.
 *
 * **Text or a readable file.** Pasted text is what gets read when it exists; without it, a
 * PDF or photo is handed to the extract model directly and its own reader sees the pages.
 * Types the model cannot read still require the paste, and the screen says which is which
 * so nobody drops a spreadsheet and waits for a draft that cannot come.
 *
 * **Nothing reaches a table from here.** Every extraction lands in `pending_changes` with
 * per-field confidence and waits for a human (CLAUDE.md rule 3). That is what makes reading
 * documents with a model safe, and it is true whether or not anything classified the file.
 */
export const dynamic = 'force-dynamic'

const STATUS_TONE: Record<string, 'success' | 'warning' | 'danger' | 'neutral'> = {
  succeeded: 'success',
  running: 'warning',
  queued: 'neutral',
  failed: 'danger',
  rejected: 'danger',
}

/** Deep-link params: `?kind=<intake kind>` plus any of that kind's context ids by field
    name (`?orderStyleId=…`). Anything unrecognised is ignored rather than refused — a
    stale link should open the screen, not an error. */
export default async function IntakePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  /*
   * The copilot's off-switch, honoured (plan 6.1).
   *
   * `MARBIM_ENABLED` had zero runtime consumers, so with it off this screen opened and
   * every question hard-failed against a provider that was never registered. A factory
   * should be told the copilot is not available rather than shown one that does not work.
   */
  if (!env.MARBIM_ENABLED) return <LockedState what="document intake" />

  /*
   * The same rule as the wall, never the raw list. This page offered all of `INTAKE_KINDS`,
   * including the eight form-filling kinds `readDocument` refuses for everybody — so "a
   * supplier proforma" sat here as a chip whose submit could only ever be refused (and, the
   * throw being masked in production, refused as React #441). Those kinds are read from
   * their own screens; the proforma's home is the procurement quote dialog.
   */
  const kinds = intakeKindsFor(ctx.roles, await activeModuleIds(ctx))

  /*
   * A kind from the URL is honoured only if it is one of THIS person's kinds. The chip
   * list is already the role ∩ activation answer, so checking against it means a link
   * cannot open a door somebody's roles do not hold — the wall stays in the actions
   * either way, but a screen that lit an unreachable chip would be lying about it.
   */
  const params = await searchParams
  const asString = (value: string | string[] | undefined): string | null =>
    typeof value === 'string' && value.trim() ? value : null

  const requestedKind = asString(params.kind)
  const initialKind = kinds.some((k) => k.id === requestedKind) ? requestedKind : null

  const initialContext: Record<string, string> = {}
  const chosenKind = kinds.find((k) => k.id === initialKind)
  for (const field of chosenKind?.context ?? []) {
    const value = asString(params[field.field])
    if (value) initialContext[field.field] = value
  }

  const recent = await withTenantRead(ctx, (tx) =>
    tx
      .select({
        id: extractionJobs.id,
        moduleId: extractionJobs.moduleId,
        targetTable: extractionJobs.targetTable,
        extractorName: extractionJobs.extractorName,
        status: extractionJobs.status,
        attempts: extractionJobs.attempts,
        error: extractionJobs.error,
        pendingChangeId: extractionJobs.pendingChangeId,
        createdAt: extractionJobs.createdAt,
      })
      .from(extractionJobs)
      .orderBy(desc(extractionJobs.createdAt))
      .limit(10),
  )

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs trail={[{ label: 'MARBIM', href: '/marbim' }, { label: 'Read a document' }]} />
      </div>

      <PageHeader
        back={{ href: '/marbim', label: 'MARBIM' }}
        eyebrow="MARBIM · document intake"
        title="Give MARBIM something to read"
        meta={`${kinds.length} kinds it knows how to file`}
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 30 }}>
        <IntakeClient
          initialKind={initialKind}
          initialContext={initialContext}
          kinds={kinds.map((k) => ({
            id: k.id,
            label: k.label,
            hint: k.hint,
            moduleId: k.moduleId,
            targetTable: k.targetTable,
            needsContext: (k.context?.length ?? 0) > 0,
          }))}
        />

        {recent.length > 0 ? (
          <section>
            <SectionHeading eyebrow="what MARBIM has been asked to read">
              Recent extractions
            </SectionHeading>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {recent.map((job) => (
                <div
                  key={job.id}
                  style={{
                    display: 'flex',
                    gap: 14,
                    alignItems: 'center',
                    flexWrap: 'wrap',
                    padding: '12px 18px',
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                  }}
                >
                  <Badge tone={STATUS_TONE[job.status] ?? 'neutral'}>{job.status}</Badge>
                  <span style={{ font: "500 13.5px/1.3 var(--fx-font-sans)" }}>
                    {job.extractorName}
                  </span>
                  <span
                    style={{
                      font: "400 12px/1.3 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    → {job.moduleId}/{job.targetTable}
                    {job.attempts > 1 ? ` · attempt ${job.attempts}` : ''}
                  </span>

                  <span style={{ marginLeft: 'auto', display: 'flex', gap: 10, alignItems: 'center' }}>
                    {job.pendingChangeId ? (
                      <span
                        style={{
                          font: "400 12px/1.3 var(--fx-font-mono)",
                          color: 'var(--fx-text-secondary)',
                        }}
                      >
                        drafted — waiting in the approve inbox
                      </span>
                    ) : null}
                    {/* Shown, not swallowed. An extraction that failed is a document
                        somebody still has to type by hand, and they need to know now. */}
                    {job.error ? (
                      <span
                        style={{
                          font: "400 12px/1.3 var(--fx-font-mono)",
                          color: 'var(--fx-danger)',
                          maxWidth: 360,
                        }}
                      >
                        {/* `error` is a structured jsonb object — a reason plus whatever
                            facts the extractor had. Rendered as its message when there is
                            one, so the row stays readable. */}
                        {typeof job.error?.message === 'string'
                          ? job.error.message
                          : 'extraction failed'}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          </section>
        ) : null}
      </div>
      {ctx.roles.some((r) => r === 'merchandiser' || r === 'commercial') ? (
        <FloorTabs
          tabs={[
            { href: '/home', label: 'My work' },
            { href: '/orders', label: 'Orders' },
            { href: '/marbim/intake', label: 'Capture' },
          ]}
        />
      ) : null}
    </>
  )
}
