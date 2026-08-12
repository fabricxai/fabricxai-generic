import Link from 'next/link'

import { ExceptionRow } from '@/components/fx/figures'
import { PendingReadings } from '@/components/shell/pending-readings'
import { EmptyState } from '@/components/fx/feedback'
import { SectionHeading } from '@/components/fx/signature'
import { PageHeader } from '@/components/shell/page-shell'

import { HOME_COPY, type WorkRow } from './home-copy'

export interface HomeSection {
  id: string
  title: string
  eyebrow?: string
  seeAllHref?: string
  more?: number
  empty: string
  rows: WorkRow[]
}

export function HomeView({
  sections,
  calm,
  dayOne = false,
  calmLinks,
}: {
  sections: readonly HomeSection[]
  calm: boolean
  /**
   * The factory has no orders at all — a first morning, not a quiet one (finding D4).
   * Optional so the desk branch, which has no order book to check, keeps its old copy.
   */
  dayOne?: boolean
  /** Links shown when nothing is waiting — role-aware so we never point at a locked desk. */
  calmLinks: readonly { href: string; label: string }[]
}) {
  return (
    <>
      <PageHeader
        eyebrow={HOME_COPY.eyebrow}
        title={HOME_COPY.title}
        meta={calm ? 'All clear' : undefined}
        ownsAmber={!calm}
      />

      {/*
        Above everything, calm or not: a reading nobody has checked is the one item on this
        screen that is blocking itself. It renders nothing when there are none, so a person
        who never uploads a document never sees it.
      */}
      <PendingReadings />

      {calm ? (
        <EmptyState
          title={dayOne ? HOME_COPY.dayOneTitle : HOME_COPY.calmTitle}
          body={dayOne ? HOME_COPY.dayOneBody : HOME_COPY.calmBody}
          action={
            <span style={{ display: 'inline-flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
              {calmLinks.map((link) => (
                <CalmLink key={link.href} href={link.href}>
                  {link.label}
                </CalmLink>
              ))}
            </span>
          }
        />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 36 }}>
          {sections.map((section) => (
            <HomeSectionBlock key={section.id} section={section} />
          ))}
        </div>
      )}
    </>
  )
}

function HomeSectionBlock({ section }: { section: HomeSection }) {
  return (
    <section>
      <SectionHeading
        eyebrow={section.eyebrow}
        action={
          section.seeAllHref ? (
            <Link
              href={section.seeAllHref}
              style={{
                font: '500 13px/1 var(--fx-font-sans)',
                color: 'var(--fx-text-secondary)',
                textDecoration: 'none',
              }}
            >
              {HOME_COPY.seeAll}
              {section.more && section.more > 0 ? ` · +${section.more}` : ''}
            </Link>
          ) : undefined
        }
      >
        {section.title}
      </SectionHeading>

      {section.rows.length === 0 ? (
        <div
          style={{
            background: 'var(--fx-bg-surface)',
            border: '1px solid var(--fx-border-subtle)',
            borderRadius: 'var(--fx-radius-md)',
            padding: '18px 20px',
            font: '400 14px/1.55 var(--fx-font-sans)',
            color: 'var(--fx-text-secondary)',
          }}
        >
          {section.empty}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {section.rows.map((row) => (
            <WorkRowCard key={row.id} row={row} kind={sectionKind(section.id)} />
          ))}
        </div>
      )}
    </section>
  )
}

function WorkRowCard({ row, kind }: { row: WorkRow; kind: string }) {
  return (
    <ExceptionRow
      kind={kind}
      reference={row.title}
      truth={row.why}
      age={row.age ?? '—'}
      severity={row.severity ?? 'low'}
      action={
        <Link
          href={row.href}
          style={{
            font: '500 13px/1 var(--fx-font-sans)',
            color: 'var(--fx-accent-pressed)',
            textDecoration: 'none',
          }}
        >
          {row.cta} →
        </Link>
      }
    />
  )
}

function sectionKind(id: string): string {
  switch (id) {
    case 'decide':
      return 'draft'
    case 'wrong':
      return 'exception'
    case 'alerts':
      return 'alert'
    case 'quiet':
      return 'lead'
    case 'quotes':
      return 'quote'
    case 'orders':
      return 'order'
    case 'pp':
      return 'sample'
    case 'desks':
      return 'desk'
    default:
      return 'item'
  }
}

function CalmLink({ href, children }: { href: string; children: string }) {
  return (
    <Link
      href={href}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 'var(--fx-tap-min)',
        padding: '10px 16px',
        borderRadius: 'var(--fx-radius-md)',
        border: '1px solid var(--fx-border-default)',
        font: '500 13px/1 var(--fx-font-sans)',
        color: 'var(--fx-text-primary)',
        textDecoration: 'none',
        background: 'var(--fx-bg-surface)',
      }}
    >
      {children}
    </Link>
  )
}
