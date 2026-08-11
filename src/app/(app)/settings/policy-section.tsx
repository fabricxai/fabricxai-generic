'use client'

import { Card } from '@/components/fx/data'
import { SectionHeading } from '@/components/fx/signature'

import { PolicyCard } from './policy-card'
import { POLICY_CONCERNS } from './policy-copy'

export interface PolicySectionItem {
  moduleId: string
  label: string
  effective: Record<string, unknown>
  overrides: Record<string, unknown>
  unresolvable: string | null
}

/**
 * Owner-facing factory rules — plain-language forms, grouped by concern.
 *
 * Every registered module is shown here. Cards use labels and field widgets from
 * `policy-copy.ts`; raw registry keys stay off the primary surface.
 */
export function PolicySection({
  policies,
  canEdit,
}: {
  policies: readonly PolicySectionItem[]
  canEdit: boolean
}) {
  const byId = new Map(policies.map((p) => [p.moduleId, p]))

  const broken = policies.filter((p) => p.unresolvable)
  const overridden = policies.filter(
    (p) => !p.unresolvable && Object.keys(p.overrides).length > 0,
  )
  const defaults = policies.filter(
    (p) => !p.unresolvable && Object.keys(p.overrides).length === 0,
  )

  const groupedIds = new Set(POLICY_CONCERNS.flatMap((c) => c.moduleIds))
  const orphans = policies.filter((p) => !groupedIds.has(p.moduleId))

  return (
    <section>
      <SectionHeading eyebrow={`${policies.length} modules`}>Factory rules</SectionHeading>

      <Card padding="18px 20px" style={{ marginBottom: 20 }}>
        <p
          style={{
            margin: 0,
            font: '400 14.5px/1.55 var(--fx-font-sans)',
            color: 'var(--fx-text-secondary)',
            textWrap: 'pretty',
            maxWidth: '62ch',
          }}
        >
          These numbers decide how gates and dashboards behave — BTB limits, cut
          tolerance, scoring, and the rest. Most factories leave them on the
          recommended defaults. Click a value to change it.
        </p>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 18,
            marginTop: 14,
            font: '500 13px/1.35 var(--fx-font-sans)',
            color: 'var(--fx-text-primary)',
          }}
        >
          <span>
            <span data-numeric>{defaults.length}</span>
            <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}> on defaults</span>
          </span>
          <span>
            <span data-numeric>{overridden.length}</span>
            <span style={{ color: 'var(--fx-text-tertiary)', fontWeight: 400 }}> customised</span>
          </span>
          {broken.length > 0 ? (
            <span style={{ color: 'var(--fx-danger)' }}>
              <span data-numeric>{broken.length}</span>
              <span style={{ fontWeight: 400 }}> will not resolve</span>
            </span>
          ) : null}
        </div>
        {!canEdit ? (
          <p
            style={{
              margin: '12px 0 0',
              font: '400 12.5px/1.4 var(--fx-font-mono)',
              color: 'var(--fx-text-tertiary)',
            }}
          >
            Only an owner or admin can change a rule.
          </p>
        ) : null}
      </Card>

      {broken.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 28 }}>
          <div
            style={{
              font: '500 12px/1 var(--fx-font-mono)',
              letterSpacing: '.06em',
              textTransform: 'uppercase',
              color: 'var(--fx-danger)',
            }}
          >
            Needs attention — will not resolve
          </div>
          {broken.map((p) => (
            <PolicyCard
              key={`broken-${p.moduleId}`}
              moduleId={p.moduleId}
              label={p.label}
              effective={p.effective}
              overrides={p.overrides}
              unresolvable={p.unresolvable}
              canEdit={canEdit}
            />
          ))}
        </div>
      ) : null}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
        {POLICY_CONCERNS.map((concern) => {
          const items = concern.moduleIds
            .map((id) => byId.get(id))
            .filter((p): p is PolicySectionItem => Boolean(p))
            // Broken modules already appear in Needs attention — don't repeat them.
            .filter((p) => !p.unresolvable)

          if (items.length === 0) return null

          return (
            <div key={concern.id} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div>
                <div
                  style={{
                    font: '600 15px/1.3 var(--fx-font-sans)',
                    color: 'var(--fx-text-primary)',
                  }}
                >
                  {concern.label}
                </div>
                <p
                  style={{
                    margin: '6px 0 0',
                    font: '400 13px/1.45 var(--fx-font-sans)',
                    color: 'var(--fx-text-tertiary)',
                    textWrap: 'pretty',
                    maxWidth: '60ch',
                  }}
                >
                  {concern.blurb}
                </p>
              </div>
              {items.map((p) => (
                <PolicyCard
                  key={p.moduleId}
                  moduleId={p.moduleId}
                  label={p.label}
                  effective={p.effective}
                  overrides={p.overrides}
                  unresolvable={p.unresolvable}
                  canEdit={canEdit}
                />
              ))}
            </div>
          )
        })}

        {orphans.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ font: '600 15px/1.3 var(--fx-font-sans)' }}>Other modules</div>
            {orphans.map((p) => (
              <PolicyCard
                key={p.moduleId}
                moduleId={p.moduleId}
                label={p.label}
                effective={p.effective}
                overrides={p.overrides}
                unresolvable={p.unresolvable}
                canEdit={canEdit}
              />
            ))}
          </div>
        ) : null}
      </div>
    </section>
  )
}
