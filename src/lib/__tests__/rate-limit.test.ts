/**
 * Which of the three switches wins.
 *
 * The limiter's own behaviour is proved by `auth-rate-limit.integration.test.ts`, against a
 * running server. What is easy to get wrong is not the counting — it is the precedence, and
 * a boolean expression inside a config object is exactly where a mistake hides: the two
 * environment flags read as symmetrical and are not.
 *
 * `RATE_LIMIT_DISABLED` has to beat everything. An escape hatch that a leftover
 * `RATE_LIMIT_ENFORCE=1` can override is not an escape hatch, and the person reaching for
 * it is mid-test with eighteen accounts to sign into and no appetite for finding out which
 * flag the code preferred.
 */
import { describe, expect, it } from 'vitest'

import { authRateLimitEnabled } from '@/lib/rate-limit'

describe('the auth limiter runs when it should', () => {
  it('is on in production and off everywhere else, by default', () => {
    expect(authRateLimitEnabled('production', {})).toBe(true)
    expect(authRateLimitEnabled('development', {})).toBe(false)
    expect(authRateLimitEnabled('test', {})).toBe(false)
  })

  it('can be turned on outside production, to exercise the limits', () => {
    // How the integration job proves the numbers refuse anything at all.
    expect(authRateLimitEnabled('test', { RATE_LIMIT_ENFORCE: '1' })).toBe(true)
  })

  it('can be turned off inside production, for a tenant holding test data', () => {
    expect(authRateLimitEnabled('production', { RATE_LIMIT_DISABLED: '1' })).toBe(false)
  })

  it('lets an explicit off beat an ambient on', () => {
    // The precedence that matters: a stale ENFORCE in the environment must not quietly
    // re-arm the limiter for somebody who has deliberately disabled it.
    expect(
      authRateLimitEnabled('test', { RATE_LIMIT_ENFORCE: '1', RATE_LIMIT_DISABLED: '1' }),
    ).toBe(false)
    expect(
      authRateLimitEnabled('production', { RATE_LIMIT_ENFORCE: '1', RATE_LIMIT_DISABLED: '1' }),
    ).toBe(false)
  })

  it('takes only an exact 1 as the word for off', () => {
    // `RATE_LIMIT_DISABLED=false` and `=0` are what somebody types when they mean ON.
    // Truthiness on a string would read both as "disable", which is the opposite.
    for (const value of ['0', 'false', 'no', '', 'true']) {
      expect(authRateLimitEnabled('production', { RATE_LIMIT_DISABLED: value })).toBe(true)
    }
  })
})
