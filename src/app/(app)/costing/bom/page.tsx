import Link from 'next/link'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'

import { Breadcrumbs } from '@/components/fx/data'
import { EmptyState } from '@/components/fx/feedback'
import { Ident } from '@/components/fx/format'
import { Badge } from '@/components/fx/primitives'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'
import { getCtx } from '@/modules/core/session'
import { bomLibrary } from '@/modules/costing/queries'

import { BomBuilder } from './bom-builder'

/**
 * 1.5 Bill of materials.
 *
 * A BOM arrives three ways: extracted from a tech pack, seeded from a past order, or typed.
 * The first two land as drafts in the approve inbox and were the only two that existed —
 * which left a factory quoting a style nobody has made before, from a tech pack that is a
 * photograph, with no way in at all.
 *
 * **Everything built here is `planned`.** The builder never offers a consumption basis,
 * because `actual` means measured against what was really issued on a real order, and 1.6
 * Order Memory reads it as evidence when seeding the next quote. A typed number is an
 * estimate however sure the person typing it is; letting them label it `actual` would be
 * the single most misleading thing this screen could do.
 *
 * **No prices.** A BOM is what the garment is made OF; a cost sheet is what it costs today.
 * The studio joins them, and rates belong there — the same fabric is quoted at two prices
 * six weeks apart, and burying one in the BOM makes the older sheet unexplainable.
 */
export const dynamic = 'force-dynamic'

const SOURCE_LABEL: Record<string, string> = {
  manual: 'typed',
  tech_pack_extract: 'from a tech pack',
  seeded: 'seeded from a past order',
}

export default async function BomPage() {
  const ctx = await getCtx(await headers())
  if (!ctx) redirect('/login')

  const boms = await bomLibrary(ctx)
  const measured = boms.filter((b) => b.hasMeasured)

  return (
    <>
      <div style={{ marginBottom: 18 }}>
        <Breadcrumbs
          trail={[{ label: 'Costing studio', href: '/costing' }, { label: 'Bills of materials' }]}
        />
      </div>

      <PageHeader
        back={{ href: '/costing', label: 'Costing studio' }}
        eyebrow="Costing · bill of materials"
        title={
          boms.length === 0
            ? 'No bills of materials yet'
            : `${boms.length} bill${boms.length === 1 ? '' : 's'} of materials`
        }
        meta={
          measured.length > 0
            ? `${measured.length} carrying measured consumption`
            : 'all consumption estimated'
        }
        ownsAmber
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        <BomBuilder />

        <section>
          <SectionHeading eyebrow="newest first">The library</SectionHeading>

          {boms.length === 0 ? (
            <EmptyState
              title="Nothing here yet"
              body="Build one above, or let MARBIM read a tech pack — either way it lands here, and the costing studio prices it."
            />
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {boms.map((bom) => (
                <Link
                  key={bom.id}
                  href={`/costing/bom/${bom.id}`}
                  style={{
                    background: 'var(--fx-bg-surface)',
                    border: '1px solid var(--fx-border-subtle)',
                    borderRadius: 'var(--fx-radius-md)',
                    padding: '13px 18px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    flexWrap: 'wrap',
                    minHeight: 'var(--fx-row-height)',
                    color: 'var(--fx-text-primary)',
                    textDecoration: 'none',
                  }}
                >
                  <Ident size={13}>{bom.styleCode}</Ident>
                  <Badge>{SOURCE_LABEL[bom.source] ?? bom.source}</Badge>

                  {/* The distinction that decides whether to trust the number: measured on
                      a real order, or somebody's estimate. */}
                  {bom.hasMeasured ? (
                    <Badge tone="success">measured</Badge>
                  ) : (
                    <Badge tone="neutral">estimated</Badge>
                  )}

                  {bom.usedByApprovedSheet ? (
                    <Badge tone="info">a live quote rests on this</Badge>
                  ) : null}

                  <span
                    data-numeric
                    style={{
                      marginLeft: 'auto',
                      font: "400 13px/1.3 var(--fx-font-mono)",
                      color: 'var(--fx-text-tertiary)',
                    }}
                  >
                    {bom.lineCount} {bom.lineCount === 1 ? 'line' : 'lines'}
                  </span>
                </Link>
              ))}
            </div>
          )}
        </section>
      </div>
    </>
  )
}
