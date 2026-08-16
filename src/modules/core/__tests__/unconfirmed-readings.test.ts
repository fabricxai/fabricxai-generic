/**
 * A reading nobody has checked follows the person, not the screen.
 *
 * An extraction raised on somebody's behalf lands in `drafted` and belongs to that person
 * until they confirm it — nobody else can see it, deliberately, because an approver who does
 * not have the document cannot check it for them. So the confirm box is the one thing on
 * screen that is blocking itself, and where it is mounted decides whether it is ever seen.
 *
 * It used to be mounted per page: home, store, cutting, maintenance. A quality inspector
 * signing in lands on `/quality/inline`, so the chart they had just filed was not on the
 * screen they arrived at, and a merchandiser's chart sat unconfirmed for three days that way
 * (Nordkap §7, F34). Mounted once in the shell it is wherever they are.
 *
 * A source scan, because the question is about the whole app and the whole app is only
 * visible from here — the same reason `action-reachability` and `audited-tables` are scans.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      if (entry !== '__tests__' && entry !== 'node_modules') sourceFiles(path, out)
    } else if (/\.tsx?$/.test(entry)) {
      out.push(path)
    }
  }
  return out
}

const SHELL_LAYOUT = 'src/app/(app)/layout.tsx'

const mounts = sourceFiles('src/app')
  .concat(sourceFiles('src/components'))
  .filter((path) => !path.endsWith('pending-readings.tsx'))
  .filter((path) => /<PendingReadings\s*\/>/.test(readFileSync(path, 'utf8')))
  .sort()

describe('the unconfirmed reading is mounted where the person is', () => {
  it('1 · the shell mounts it', () => {
    // If this fails the box is nowhere, and a filed document waits in a queue its own
    // raiser cannot reach.
    expect(mounts).toContain(SHELL_LAYOUT)
  })

  it('2 · nothing else mounts it', () => {
    /*
     * Not tidiness. A second mount renders the same drafts twice on the pages that have one
     * and keeps the old per-page habit alive — the next screen somebody adds inherits the
     * gap this closed, because the pattern says "remember to add it here too".
     */
    const extra = mounts.filter((path) => path !== SHELL_LAYOUT)

    expect(
      extra,
      `mounted outside the shell — the shell already covers every screen:\n${extra.join('\n')}`,
    ).toEqual([])
  })
})
