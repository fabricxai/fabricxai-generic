import { EntityRef } from '@/components/shell/entity-drawer'
import { FACTORY_TIMEZONE } from '@/lib/dates'
import type { OrderFileRef } from '@/modules/orders/queries'

/**
 * The order's papers, grouped by kind (specs/order-centric-core.md §2).
 *
 * `order_files` has registered order↔document since the schema shipped and nothing
 * ever showed it, so "where is the buyer's PO for this order" was a question with an
 * answer in the database and no answer in the product. The mailroom (X-5) and
 * fulfilled document requests (X-4) file in here automatically once they land, which
 * is why the grouping is by the document's own kind rather than by who filed it.
 *
 * Each row peeks rather than downloads: a filename tells you nothing, and the peek
 * carries the type, the size and the way to open it.
 */
const day = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: FACTORY_TIMEZONE,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(at)

export function OrderDocuments({ files }: { files: readonly OrderFileRef[] }) {
  if (files.length === 0) {
    return (
      <p style={{ font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
        No papers are filed against this order yet. Documents read through MARBIM intake
        and those the mailroom receives are filed here.
      </p>
    )
  }

  // A file whose kind was never classified is not an error — it is a paper somebody
  // filed by hand, and it belongs in the list under its own heading rather than hidden.
  const groups = new Map<string, OrderFileRef[]>()
  for (const file of files) {
    const key = file.kind ?? 'unfiled'
    groups.set(key, [...(groups.get(key) ?? []), file])
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {[...groups.entries()].map(([kind, group]) => (
        <div key={kind} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div
            style={{
              font: '500 11px/1 var(--fx-font-mono)',
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            {kind}
          </div>
          {group.map((file) => (
            <div
              key={file.documentId}
              style={{
                display: 'flex',
                gap: 14,
                justifyContent: 'space-between',
                alignItems: 'baseline',
                padding: '11px 16px',
                background: 'var(--fx-bg-surface)',
                border: '1px solid var(--fx-border-subtle)',
                borderRadius: 'var(--fx-radius-md)',
                minHeight: 'var(--fx-row-height)',
              }}
              className="fx-stack-tablet"
            >
              <span style={{ font: '400 13.5px/1.4 var(--fx-font-sans)' }}>
                <EntityRef kind="document" reference={file.documentId}>
                  {file.label ?? file.filename}
                </EntityRef>
                {file.label ? (
                  <span style={{ color: 'var(--fx-text-tertiary)' }}> · {file.filename}</span>
                ) : null}
              </span>
              <span
                data-mono
                style={{ font: '400 12px/1.4 var(--fx-font-mono)', color: 'var(--fx-text-tertiary)' }}
              >
                {day(file.filedAt)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
