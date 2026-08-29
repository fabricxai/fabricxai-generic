/**
 * Which sentence a failed sign-in gets.
 *
 * Written after the form told somebody with a verified account to go and check their
 * inbox. The account was verified; the 403 was Better Auth refusing the request's origin
 * because the deployment's `APP_URL` did not match the address in the browser. Reading a
 * status code as a reason sent the one person who could have fixed it looking for an email
 * that was never sent, about an account that was never unverified.
 */
import { describe, expect, it } from 'vitest'

import { loginErrorKey } from '../login-error'

describe('the sign-in refusal', () => {
  it('names the unverified account only when the server said that is what it was', () => {
    expect(loginErrorKey({ code: 'EMAIL_NOT_VERIFIED', status: 403 })).toBe('ui.auth.unconfirmed')
  })

  it('does NOT read a bare 403 as an unverified account', () => {
    /*
     * The bug, pinned. An untrusted origin, a disabled provider and an unverified email all
     * arrive as 403, and only the last is about the account — so a status-only branch tells
     * two thirds of the people who see it something false and unactionable.
     */
    expect(loginErrorKey({ status: 403 })).toBe('ui.auth.refused')
    expect(loginErrorKey({ code: 'INVALID_ORIGIN', status: 403 })).toBe('ui.auth.refused')
  })

  it('tells somebody who is locked out that they are locked out', () => {
    // Not vague on purpose: their password is right, and staying silent means they retype
    // it until the window widens.
    expect(loginErrorKey({ status: 429 })).toBe('ui.auth.too_many_attempts')
  })

  it('stays vague about anything else, so the form cannot enumerate accounts', () => {
    expect(loginErrorKey({ status: 401 })).toBe('ui.auth.bad_credentials')
    expect(loginErrorKey({ code: 'INVALID_EMAIL_OR_PASSWORD', status: 401 })).toBe(
      'ui.auth.bad_credentials',
    )
    expect(loginErrorKey({})).toBe('ui.auth.bad_credentials')
  })
})
