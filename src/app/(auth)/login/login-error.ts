/**
 * Which sentence a failed sign-in gets.
 *
 * Its own module because getting it wrong is expensive and it got wrong once: the form
 * read `status === 403` as "this account is not verified" and told somebody with a
 * verified account to go and check their inbox. The real 403 was Better Auth refusing the
 * request's ORIGIN — a deployment whose `APP_URL` did not match the address in the browser
 * — so the one person who could have fixed it was sent looking for an email that was never
 * sent, about an account that was never unverified.
 *
 * The lesson generalises: a status code is not a reason. Better Auth returns 403 for
 * several unrelated refusals and only one of them is about the account, so the account
 * message must key off the CODE that names it.
 *
 * Everything unrecognised stays deliberately vague. This form must not become a way to
 * find out which email addresses exist.
 */
export function loginErrorKey(error: { code?: string | undefined; status?: number }): string {
  if (error.code === 'EMAIL_NOT_VERIFIED') return 'ui.auth.unconfirmed'

  // Not vague on purpose: somebody locked out by the brute-force limiter has the right
  // password and would otherwise retype it until the window widened.
  if (error.status === 429) return 'ui.auth.too_many_attempts'

  /*
   * A refusal that is not about the credentials at all — an untrusted origin, a disabled
   * provider. Nothing the person at the keyboard can fix by typing better, so the sentence
   * points at the deployment rather than at them. It reveals nothing about whether the
   * account exists, because the server never got as far as looking.
   */
  if (error.status === 403) return 'ui.auth.refused'

  return 'ui.auth.bad_credentials'
}
