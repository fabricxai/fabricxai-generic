import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Breadcrumbs, StatTile } from '@/components/fx/data'
import { EmptyState, InlineAlert } from '@/components/fx/feedback'
import { Figure, Ident } from '@/components/fx/format'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { sampleLibrary, type LibraryFilter, type SampleType } from '@/modules/sampling/queries'

import { LibrarySearch } from './library-search'

/**
 * 2.3 Sample library.
 *
 * The board answers "what is in the room now". This answers the question asked before a new
 * sample is cut: **have we made this before, and what did the buyer say?** A factory that
 * cannot answer it remakes the same collar three seasons running and is corrected on it
 * three times — and pays for each sample.
 *
 * **The search reads the buyer's comments, not just style codes.** Somebody chasing a fabric
 * problem searches `puckering`; somebody who has never heard of SHRT-4410 cannot search for
 * it. Identifiers alone would return nothing for the query most worth asking.
 *
 * **Rejections are the point of the archive, so they are never buried.** A rejected sample
 * is the expensive lesson; an approved one is a receipt. The counts above the results say
 * how many of each matched, and a search that found only approvals says so rather than
 * looking like a clean record.
 */
export const dynamic = 'force-dynamic'

const TYPES: readonly SampleType[] = ['proto', 'fit', 'sms', 'pp', 'top', 'shipment']

export default async function SampleLibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: string; outcome?: string }>
}) {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const params = await searchParams

  // Read from the query string, but only values this module actually defines — a `type` of
  // anything else would silently filter everything out and read as "we have never made one".
  const type = TYPES.includes(params.type as SampleType) ? (params.type as SampleType) : undefined
  const outcome = (['approved', 'rejected', 'undecided'] as const).includes(
    params.outcome as 'approved',
  )
    ? (params.outcome as LibraryFilter['outcome'])
    : undefined
  const query = params.q?.trim() ?? ''

  const hits = await sampleLibrary(ctx, { query, type, outcome })

  // Any round the buyer rejected, not just the last one. A sample rejected twice and
  // approved on the third has a history, and the history is why somebody opened this.
  const rejected = hits.filter((h) => h.rejectedRounds > 0)
  const undecided = hits.filter((h) => h.finalVerdict === null)
  const unreadable = hits.reduce((sum, h) => sum + h.unreadableComments, 0)
  const searched = query !== '' || type !== undefined || outcome !== undefined

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[{ label: 'Sampling room', href: '/sampling' }, { label: 'Library' }]}
        />
      </div>

      <PageHeader
        back={{ href: '/sampling', label: 'Sampling' }}
        eyebrow="Sampling · library"
        title={
          searched
            ? `${hits.length} ${hits.length === 1 ? 'sample' : 'samples'} match`
            : 'Every sample this factory has made'
        }
        meta={
          rejected.length > 0
            ? `${rejected.length} ${rejected.length === 1 ? 'was' : 'were'} rejected at least once`
            : undefined
        }
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 26 }}>
        <LibrarySearch query={query} type={type} outcome={outcome} types={TYPES} />

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
            gap: 14,
          }}
        >
          <StatTile
            label="Rejected at least once"
            value={<Figure value={rejected.length} />}
            // The expensive ones. An approved sample is a receipt; a rejected one is the
            // thing worth reading before cutting the next.
            basis={
              rejected.length > 0
                ? 'read these before making the style again'
                : 'nothing in this result was rejected'
            }
            status={rejected.length > 0 ? 'at-risk' : undefined}
          />
          <StatTile
            label="Never came back"
            value={<Figure value={undecided.length} />}
            basis={
              undecided.length > 0
                ? 'sent, and no verdict was ever recorded'
                : 'every sample has a verdict'
            }
          />
          <StatTile
            label="Comments on file"
            value={<Figure value={hits.reduce((sum, h) => sum + h.comments.length, 0)} />}
            basis="what the buyer actually said, searchable"
          />
        </div>

        {/* Counted, never dropped. A rejection nobody can read is a sample nobody can
            remake correctly, and pretending the comment is not there hides that. */}
        {unreadable > 0 ? (
          <InlineAlert tone="warning">
            {unreadable} buyer {unreadable === 1 ? 'comment' : 'comments'} could not be read —
            they were recorded in a shape the current schema no longer accepts. They are still
            on the sample; they are just not searchable from here.
          </InlineAlert>
        ) : null}

        <section>
          <SectionHeading eyebrow="newest first">
            {searched ? 'What matched' : 'Everything on file'}
          </SectionHeading>

          {hits.length === 0 ? (
            <EmptyState
              title={searched ? 'Nothing matches that' : 'No samples yet'}
              body={
                searched
                  ? 'No style code, request number, buyer or buyer comment contains those words. The search is literal — it finds what contains the words rather than what resembles them, so a near miss returns nothing rather than something close.'
                  : 'Samples appear here as soon as they are requested, and carry their buyer feedback with them.'
              }
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {hits.map((hit) => (
                <div key={hit.id} style={row}>
                  <div style={{ display: 'flex', gap: 13, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Ident size={13}>{hit.styleCode}</Ident>
                    <Badge tone="neutral">{hit.type}</Badge>

                    {hit.finalVerdict === 'rejected' ? (
                      <Badge tone="danger">rejected</Badge>
                    ) : hit.finalVerdict === 'approved' ? (
                      <Badge tone="success">approved</Badge>
                    ) : hit.finalVerdict === 'approved_with_comments' ? (
                      // Distinct from a clean approval on purpose: the buyer accepted it AND
                      // asked for changes, and the changes are what the next maker needs.
                      <Badge tone="success">approved with comments</Badge>
                    ) : (
                      <Badge tone="warning">no verdict</Badge>
                    )}

                    {/* An approved sample that took three goes is not the same as one that
                        passed first time, and the rounds are where the lesson is. */}
                    {hit.rejectedRounds > 0 && hit.finalVerdict !== 'rejected' ? (
                      <Badge tone="warning">
                        rejected {hit.rejectedRounds}× first
                      </Badge>
                    ) : null}
                    {hit.rounds > 1 ? <Badge tone="neutral">{hit.rounds} rounds</Badge> : null}

                    {hit.buyerName ? (
                      <span
                        style={{
                          font: "400 13px/1.3 var(--fx-font-sans)",
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {hit.buyerName}
                        {hit.poNumber ? ` · ${hit.poNumber}` : ''}
                      </span>
                    ) : null}

                    <span
                      style={{
                        marginLeft: 'auto',
                        display: 'flex',
                        gap: 12,
                        alignItems: 'center',
                      }}
                    >
                      {hit.photos > 0 ? (
                        <span
                          style={{
                            font: "400 12px/1.3 var(--fx-font-mono)",
                            color: 'var(--fx-text-tertiary)',
                          }}
                        >
                          {hit.photos} {hit.photos === 1 ? 'photo' : 'photos'}
                        </span>
                      ) : null}
                      <span
                        style={{
                          font: "400 12px/1.3 var(--fx-font-mono)",
                          color: 'var(--fx-text-tertiary)',
                        }}
                      >
                        {hit.requestNo} · {hit.requestedOn}
                      </span>
                      <Link
                        href={`/sampling/${hit.id}`}
                        style={{
                          font: "400 13px/1.4 var(--fx-font-sans)",
                          color: 'var(--fx-text-secondary)',
                        }}
                      >
                        Open →
                      </Link>
                    </span>
                  </div>

                  {/* The comments ARE the archive. Showing the style code alone would make
                      this a list of things that happened rather than a record of what was
                      learned. */}
                  {hit.comments.length > 0 ? (
                    <ul
                      style={{
                        margin: '10px 0 0',
                        paddingLeft: 18,
                        font: "400 13px/1.65 var(--fx-font-sans)",
                        color: 'var(--fx-text-secondary)',
                      }}
                    >
                      {hit.comments.slice(0, 4).map((comment, i) => (
                        <li key={`${comment.round}-${i}`}>
                          <strong style={{ fontWeight: 500 }}>{comment.area}:</strong>{' '}
                          {comment.comment}
                          <span style={{ color: 'var(--fx-text-tertiary)' }}>
                            {' '}
                            — round {comment.round}, {comment.recordedOn}
                          </span>
                        </li>
                      ))}
                      {hit.comments.length > 4 ? (
                        <li style={{ color: 'var(--fx-text-tertiary)' }}>
                          {hit.comments.length - 4} more on the sample
                        </li>
                      ) : null}
                    </ul>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}

const row: React.CSSProperties = {
  background: 'var(--fx-bg-surface)',
  border: '1px solid var(--fx-border-subtle)',
  borderRadius: 'var(--fx-radius-md)',
  padding: '13px 18px',
}
