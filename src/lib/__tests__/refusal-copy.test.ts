/**
 * A refusal reaches the person as words, not as field names.
 *
 * ## The bug this exists to stop coming back
 *
 * In production Next.js masks the message of anything a server action throws, so of an
 * `AppError` only two things survive the boundary: the `messageKey`, and the `reason` string
 * the service composed (see `lib/action-failure.ts`). The `details` — the free balance, the
 * roll numbers, the shortfall — are gone by the time `actionErrorMessage` resolves copy.
 *
 * So a catalogue entry written as "Free balance is {free} {unit}" reaches the floor as
 * literally that: braces, field names and all. Found on the live box during the Nordkap §5
 * walk, where the new BTB funding gate refused a purchase order with "{btbNumber} is
 * {creditValue} {currency} … short by {shortfall}". The UD, 4-point and LC-date gates all
 * carried the same flaw, unfired.
 *
 * A service that wants to name figures composes the sentence and passes it as `reason`. Not
 * a workaround — the only mechanism that survives, and it puts the wording beside the
 * numbers it describes.
 *
 * ## What this can and cannot prove
 *
 * Two populations, both unambiguous: everything in the `gates.` namespace, which exists only
 * to refuse; and every key handed literally to `new AppError(...)`. Notification templates
 * and violation codes are deliberately NOT checked — those are rendered where their facts
 * still exist, and interpolation is correct for them.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MESSAGES } from '../i18n'

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

/** Comments are prose about copy, not references to it. */
const withoutComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ')

const SERVER_SOURCE = sourceFiles('src/modules')
  .map((path) => withoutComments(readFileSync(path, 'utf8')))
  .join('\n')

/** Keys handed straight to the error that carries them across the boundary. */
const THROWN = new Set(
  [...SERVER_SOURCE.matchAll(/AppError\(\s*'[a-z_]+'\s*,\s*'([a-z][a-z0-9_.]+\.[a-z0-9_.]+)'/g)].map(
    (m) => m[1]!,
  ),
)

/** Everything a gate can answer with. The namespace exists for nothing else. */
const GATE_KEYS = new Set(
  [...SERVER_SOURCE.matchAll(/'(gates\.[a-z0-9_.]+)'/g)].map((m) => m[1]!),
)

const REFUSAL_KEYS = [...new Set([...THROWN, ...GATE_KEYS])].sort()

const braces = (copy: unknown): string[] =>
  [...String(copy).matchAll(/\{(\w+)\}/g)].map((m) => m[1]!)

describe('a refusal reaches the person as words, not field names', () => {
  it('1 · the population under test is not empty', () => {
    // A scan that silently matches nothing passes forever and protects nothing.
    expect(REFUSAL_KEYS.length).toBeGreaterThan(20)
  })

  it('2 · no refusal copy interpolates — English', () => {
    const offenders = REFUSAL_KEYS.filter((key) => key in MESSAGES.en)
      .filter((key) => braces(MESSAGES.en[key]).length > 0)
      .map((key) => `${key} → {${braces(MESSAGES.en[key]).join('}, {')}}`)

    expect(
      offenders,
      'these render their braces to a real person. Compose the sentence in the service and ' +
        `pass it as \`reason\`:\n${offenders.join('\n')}`,
    ).toEqual([])
  })

  it('3 · no refusal copy interpolates — Bangla', () => {
    // The floor screens are Bangla-first, so a storekeeper is the likeliest person in the
    // building to meet a raw brace. The two catalogues drift independently.
    const bn = MESSAGES.bn ?? {}
    const offenders = REFUSAL_KEYS.filter((key) => key in bn)
      .filter((key) => braces(bn[key]).length > 0)
      .map((key) => `${key} → {${braces(bn[key]).join('}, {')}}`)

    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('4 · every refusal key has copy behind it at all', () => {
    /*
     * The other half of the same failure, found in the same sweep: `decideUdDraw` returns
     * five reason keys and not one of them had an entry. The copy written for the bonded
     * overdraw sat under `gates.ud_balance.insufficient`, which nothing throws — so the
     * hardest block in the building fell through to whatever generic fallback the calling
     * screen happened to pass.
     */
    const missing = REFUSAL_KEYS.filter((key) => !(key in MESSAGES.en))

    expect(
      missing,
      `named as refusals with no copy behind them:\n${missing.join('\n')}`,
    ).toEqual([])
  })
})
