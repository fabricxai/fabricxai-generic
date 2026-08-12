import Link from 'next/link'

import type { Role } from '@/modules/core/ctx'
import { INTAKE_KINDS } from '@/modules/marbim/intake'
import type { ApprovalRuleRow } from '@/modules/approvals/queries'

/**
 * What WOULD land here, when nothing has (plan 2.6, audit S8).
 *
 * Every role saw "Nothing waiting" and a paragraph about rules, and a new factory runs for
 * days before the first draft routes anywhere — so nobody learned what the inbox was FOR
 * until something aged in it. The empty state now names the kinds of thing that route to
 * this role's queue, each with the door that raises one.
 *
 * Derived, not hardcoded: the tenant's own active rules name the roles they route to, and
 * the intake registry knows which door raises a draft for a table. A rule whose table has
 * no intake kind still teaches — it names the module whose screens propose into it. With no
 * rules configured at all, drafts fall back to owner/admin (core's default), and that is
 * said too rather than left as a mystery.
 */

const TABLE_LABELS: Record<string, string> = {
  orders: 'an order read off a purchase order',
  rfqs: 'an enquiry read off a buyer email',
  uds: 'a customs declaration from a scan',
  lcs: 'a letter of credit from a SWIFT advice',
  boms: 'a bill of materials from a tech pack',
  wage_gazettes: 'a wage gazette from the notification',
  findings: 'audit findings from a report',
  measurement_specs: 'a measurement spec from a chart',
  stock_adjustments: 'a stock correction with its reason',
  cut_reports: 'a correction to a filed cut report',
  supplier_quotes: 'a supplier quote',
  suppliers: 'a new supplier',
  purchase_requisitions: 'a purchase requisition',
  allocations: 'a planning scenario being applied',
  payables: 'a payable being settled',
  tolerance_override: 'a shipment tolerance exception',
}

const MODULE_DOORS: Record<string, string> = {
  orders: '/orders',
  rfq: '/rfq',
  commercial: '/lcs',
  costing: '/costing',
  workforce: '/workforce',
  compliance: '/compliance',
  quality: '/quality',
  store: '/store',
  cutting: '/cutting',
  procurement: '/procurement',
  planning: '/planning',
  finance: '/finance',
  shipment: '/shipment',
}

export function WhatArrivesHere({
  roles,
  rules,
}: {
  roles: readonly Role[]
  rules: readonly ApprovalRuleRow[]
}) {
  const supervisory = roles.some((role) => role === 'owner' || role === 'admin')

  // The rules that route to THIS person. Supervisors also catch the fallback: a draft no
  // rule claims lands with owner/admin, so for them every registered kind is en route.
  const mine = rules.filter((rule) =>
    rule.requiredRoles.some((role) => roles.includes(role as Role)),
  )

  const teach = new Map<string, { label: string; door: string | null }>()
  for (const rule of mine) {
    const table = rule.targetTable === '*' ? null : rule.targetTable
    if (!table) continue
    const kind = INTAKE_KINDS.find((k) => k.targetTable === table && !k.fillsFormOnly)
    teach.set(table, {
      label: TABLE_LABELS[table] ?? `a ${table.replace(/_/g, ' ')} draft`,
      door: kind ? '/marbim/intake' : (MODULE_DOORS[rule.moduleId] ?? null),
    })
  }

  if (teach.size === 0 && supervisory) {
    // No rules name them specifically, but the fallback does — teach the three most common
    // arrivals rather than a blank.
    for (const table of ['orders', 'stock_adjustments', 'wage_gazettes']) {
      const kind = INTAKE_KINDS.find((k) => k.targetTable === table && !k.fillsFormOnly)
      teach.set(table, {
        label: TABLE_LABELS[table]!,
        door: kind ? '/marbim/intake' : null,
      })
    }
  }

  const entries = [...teach.entries()].slice(0, 4)

  return (
    <div
      style={{
        background: 'var(--fx-bg-surface)',
        border: '1px solid var(--fx-border-subtle)',
        borderRadius: 'var(--fx-radius-md)',
        padding: '20px 22px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      }}
    >
      {entries.length === 0 ? (
        <p style={{ margin: 0, font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
          No approval rule routes anything to your role yet, so drafts you raise go to an
          owner or admin, and nothing arrives here for you to sign.
          {supervisory ? (
            <>
              {' '}
              Routing lives in{' '}
              <Link href="/settings#routing" style={{ color: 'var(--fx-text-primary)' }}>
                Settings → Approval routing
              </Link>
              .
            </>
          ) : null}
        </p>
      ) : (
        <>
          <p style={{ margin: 0, font: '400 14px/1.6 var(--fx-font-sans)', color: 'var(--fx-text-secondary)' }}>
            {supervisory
              ? 'Nothing waits right now. Drafts land here when somebody raises one — and anything no rule claims falls back to you. The kinds of thing that arrive:'
              : 'Nothing waits right now. When somebody raises one of these, it lands in this queue for your role to sign:'}
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {entries.map(([table, entry]) => (
              <li
                key={table}
                style={{
                  display: 'flex',
                  alignItems: 'baseline',
                  gap: 10,
                  font: '400 13.5px/1.5 var(--fx-font-sans)',
                  color: 'var(--fx-text-primary)',
                }}
              >
                <span style={{ color: 'var(--fx-text-tertiary)' }}>·</span>
                <span style={{ flex: 1 }}>{entry.label}</span>
                {entry.door ? (
                  <Link
                    href={entry.door}
                    style={{ font: '500 12.5px/1 var(--fx-font-sans)', color: 'var(--fx-text-secondary)', whiteSpace: 'nowrap' }}
                  >
                    where one is raised →
                  </Link>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
