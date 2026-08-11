/**
 * The ⚖ registry, read by something at last (audit BE-B5).
 *
 * `registerAuditedTables` was write-only: seventeen modules called it and `isAudited` and
 * `listAuditedTables` had zero callers anywhere in the repo. A registry nothing reads is a
 * list of intentions — it cannot make a table audited, and it cannot notice when one that
 * claims to be is not.
 *
 * These are source assertions rather than runtime ones, deliberately. Proving a write is
 * audited at runtime means driving every ⚖ operation through a database, which the module
 * suites already do one by one; what nothing checked was the SET — that every table rule 10
 * names is registered, and that every registered table has a `recordChange` naming it. That
 * is a question about the whole repo, and the whole repo is only visible from here.
 */
import { readFileSync, readdirSync } from 'node:fs'

import { describe, expect, it } from 'vitest'


const MODULES_ROOT = 'src/modules'

/** Every module source file, concatenated — where a `recordChange` could legitimately live. */
function moduleSources(): string {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__') continue
      const path = `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(path)
      else if (entry.name.endsWith('.ts')) files.push(path)
    }
  }
  walk(MODULES_ROOT)
  return files.map((f) => readFileSync(f, 'utf8')).join('\n')
}

const SOURCES = moduleSources()

/**
 * The registered set, read from the source rather than from the loaded registry.
 *
 * Importing `@/modules/registry` would pull in `db/client` and therefore the whole
 * environment, turning a question about text into a test that needs a database. The
 * registration calls are literals, so the source is the same answer more cheaply.
 */
const REGISTERED = [...SOURCES.matchAll(/registerAuditedTables\(([^)]*)\)/g)]
  .flatMap((match) => [...match[1]!.matchAll(/'([a-z_]+)'/g)].map((t) => t[1]!))

describe('the ⚖ registry', () => {
  it('is populated once the modules are loaded', () => {
    // Guards the guard: importing the registry is what fills the set, and a test that
    // forgot to would assert nothing while passing.
    expect(REGISTERED.length).toBeGreaterThan(10)
  })

  it('contains every table CLAUDE.md rule 10 names', () => {
    // The rule lists these by hand: "orders, lcs, pending commits, payroll, adjustments,
    // compliance, shipments, finance". `lcs` was the one that was neither registered nor
    // audited on create, which is how a credit could appear with no before/after row.
    const named = [
      'orders',
      'lcs',
      'payroll_runs',
      'stock_adjustments',
      'shipments',
      'invoices',
      'uds',
    ]

    expect(named.filter((table) => !REGISTERED.includes(table))).toEqual([])
  })

  /**
   * Registered tables whose trail is written under something else, and why.
   *
   * Auditing a child row against its aggregate is legitimate and often better — an
   * amendment belongs to the credit's history, not to a history of its own — but it has to
   * be STATED, or "registered" and "audited" drift apart with nothing to notice. Anything
   * not on this list must carry its own row.
   */
  const TRAIL_LIVES_ELSEWHERE: Record<string, string> = {
    lc_amendments: 'lcs — an amendment is part of the credit it amends',
    order_revisions: 'order_breakdowns — the revision IS the breakdown change',
    // `workers` left this list when `upsertWorker` gave it a real writer. The note it used
    // to carry — "nothing writes workers outside the seed yet" — was true, and was also
    // finding D1 of the day-one walkthrough sitting in a test file, unread, describing a
    // factory that could not register a single employee.
  }

  it('has a recordChange naming every table it registers', () => {
    // A table can be registered and never audited — exactly what the registry could not
    // tell anyone before, because nothing read it. This is the read.
    const unwritten = REGISTERED.filter(
      (table) =>
        !SOURCES.includes(`targetTable: '${table}'`) && !(table in TRAIL_LIVES_ELSEWHERE),
    )

    expect(unwritten).toEqual([])
  })

  it('does not carry a stale exemption', () => {
    // The exemption list is the part that rots: a table that gains its own recordChange
    // should leave it, or the next reader trusts a note that is no longer true.
    const stale = Object.keys(TRAIL_LIVES_ELSEWHERE).filter((table) =>
      SOURCES.includes(`targetTable: '${table}'`),
    )

    expect(stale).toEqual([])
  })
})
