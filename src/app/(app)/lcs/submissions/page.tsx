import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { desc, eq } from 'drizzle-orm'

import { Breadcrumbs } from '@/components/fx/data'
import { EmptyState } from '@/components/fx/feedback'
import { PageHeader } from '@/components/shell/page-shell'
import { buyers } from '@/modules/buyers/schema'
import { docSubmissions, lcs } from '@/modules/commercial/schema'
import { agingDiscrepancies, type BankDocsPolicy } from '@/modules/commercial/service'
import { getCtx } from '@/modules/core/session'
import { withTenantRead } from '@/modules/core/tenancy'
import { getPolicy } from '@/modules/settings/service'

import { SubmissionsClient } from './submissions-client'
import { factoryToday } from '@/lib/dates'

/**
 * 2.1 Commercial · documents at the bank (canvas P3).
 *
 * Everything the factory has done — the fabric, the sewing, the inspection — turns into
 * money at exactly one point: a set of documents accepted by a bank. This screen is that
 * point, and it is built around the two ways it goes wrong.
 *
 * **A discrepancy is a clock, not a status.** The bank raises one and the factory's money
 * sits there until somebody fixes it. So the age is on the row, in days, and the escalation
 * job counts from the same date.
 *
 * **A realization is not "accepted with an amount".** Money landing is its own event with
 * its own date, and the shortfall against the invoice is computed and stored rather than
 * inferred — bank charges come off before crediting, and a receivable derived from the
 * invoice alone stays open by the deduction forever.
 */
export const dynamic = 'force-dynamic'

export default async function SubmissionsPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const today = factoryToday()
  const policy = await getPolicy<BankDocsPolicy>(ctx, 'commercial')

  const [rows, aging] = await Promise.all([
    withTenantRead(ctx, (tx) =>
      tx
        .select({
          id: docSubmissions.id,
          lcId: docSubmissions.lcId,
          lcNumber: lcs.number,
          buyerName: buyers.name,
          bankStatus: docSubmissions.bankStatus,
          docs: docSubmissions.docs,
          invoicedAmount: docSubmissions.invoicedAmount,
          realizedAmount: docSubmissions.realizedAmount,
          currency: docSubmissions.currency,
          submittedAt: docSubmissions.submittedAt,
          discrepantSince: docSubmissions.discrepantSince,
          discrepancyNotes: docSubmissions.discrepancyNotes,
          realizedAt: docSubmissions.realizedAt,
          shortfallReason: docSubmissions.shortfallReason,
        })
        .from(docSubmissions)
        .innerJoin(lcs, eq(lcs.id, docSubmissions.lcId))
        .leftJoin(buyers, eq(buyers.id, lcs.buyerId))
        .orderBy(desc(docSubmissions.createdAt)),
    ),
    agingDiscrepancies(ctx, { today }, policy),
  ])

  const openLcs = await withTenantRead(ctx, (tx) =>
    tx
      .select({ id: lcs.id, number: lcs.number, currency: lcs.currency, buyerName: buyers.name })
      .from(lcs)
      .leftJoin(buyers, eq(buyers.id, lcs.buyerId))
      .where(eq(lcs.status, 'active')),
  )

  const discrepant = rows.filter((r) => r.bankStatus === 'discrepant').length

  if (openLcs.length === 0) {
    return (
      <>
        <PageHeader eyebrow="Commercial · submissions" title="No live credits" ownsAmber />
        <EmptyState
          title="Nothing to present against"
          body="Documents are presented against a letter of credit. Record one on the register first."
        />
      </>
    )
  }

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[{ label: 'LC register', href: '/lcs' }, { label: 'Documents at the bank' }]}
        />
      </div>

      <PageHeader
        eyebrow="Commercial · submissions"
        title="Documents at the bank"
        meta={
          discrepant > 0
            ? `${discrepant} discrepant · escalates after ${policy.discrepancyEscalateAfterDays} days`
            : undefined
        }
        ownsAmber
      />

      <SubmissionsClient
        today={today}
        lcs={openLcs}
        submissions={rows.map((r) => ({
          ...r,
          /*
           * Two shapes live in this column: the human door stores plain kind strings,
           * the 8.1 worker stores `{ kind, status }` objects — and `map(String)` rendered
           * the latter as "[object Object]" (live-test finding, Phase 8). Read the kind
           * from either shape rather than assuming one writer.
           */
          docs: Array.isArray(r.docs)
            ? (r.docs as unknown[])
                .map((d) =>
                  typeof d === 'string' ? d : String((d as { kind?: unknown }).kind ?? ''),
                )
                .filter(Boolean)
            : [],
          // The service already knows which of these have aged past the threshold; matching
          // by id keeps one definition of "escalated" rather than two that drift.
          escalated: aging.some(
            (a) => (a as { submissionId?: string }).submissionId === r.id,
          ),
        }))}
        escalateAfterDays={policy.discrepancyEscalateAfterDays}
      />
    </>
  )
}
