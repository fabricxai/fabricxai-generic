/**
 * The production-only boot assertions (plan 6.4, audit AI-B1).
 *
 * These exist so a misconfigured deployment dies at startup rather than at 3am, which means
 * their entire value is in firing. An assertion nobody has ever seen fire is decoration —
 * the same argument that put the custom lint rules under a RuleTester — and the MARBIM one
 * in particular guards a state this codebase has shipped in before: the copilot enabled,
 * every surface mounted, and nothing behind it (plan 6.1).
 */
import { describe, expect, it } from 'vitest'

/**
 * Imported dynamically, after `process.env` is populated.
 *
 * `env.ts` validates the real environment at MODULE LOAD — that is the whole design, so app,
 * worker and build all die at startup rather than on the first request that needs a key —
 * which means a static import here would throw before a single case ran. The vitest project
 * is `environment: 'node'` with no dotenv step, so nothing has filled these in.
 *
 * `NODE_ENV` is deliberately left alone: the production rules are exercised by handing
 * `envSchema` an object that says `production`, not by pretending this process is one.
 */
Object.assign(process.env, {
  APP_URL: 'https://test.invalid',
  DATABASE_URL: 'postgres://u:p@localhost:5432/x',
  DIRECT_DATABASE_URL: 'postgres://u:p@localhost:5432/x',
  REDIS_URL: 'redis://localhost:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY_ID: 'k',
  S3_SECRET_ACCESS_KEY: 's',
  S3_BUCKET: 'b',
})

const { envSchema } = await import('../env')

/** A deployment that boots. Each case below breaks exactly one thing. */
const PRODUCTION = {
  NODE_ENV: 'production',
  APP_URL: 'https://factory.example.com',
  DATABASE_URL: 'postgres://app:pw@pgbouncer:6432/fabricxai',
  DIRECT_DATABASE_URL: 'postgres://app:pw@pg:5432/fabricxai',
  REDIS_URL: 'redis://redis:6379',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  S3_ENDPOINT: 'http://minio:9000',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
  S3_BUCKET: 'fabricxai',
  RESEND_API_KEY: 're_test',
} as const

const problems = (overrides: Record<string, unknown>): string[] => {
  const result = envSchema.safeParse({ ...PRODUCTION, ...overrides })
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'))
}

describe('production boot · the copilot cannot be half-configured', () => {
  it('1 · the baseline deployment boots', () => {
    // Guards the guard. If this ever fails, every case below is passing for the wrong reason.
    expect(problems({})).toEqual([])
  })

  it('2 · MARBIM off needs no model keys at all', () => {
    // The honest default. A factory that has not bought the copilot ships without one and
    // without three vendor accounts — the state audit INFRA-H8 was about.
    expect(problems({ MARBIM_ENABLED: 'true' })).not.toEqual([])
    expect(problems({ MARBIM_ENABLED: 'false' })).toEqual([])
  })

  it('3 · MARBIM on with no keys at all is refused', () => {
    expect(problems({ MARBIM_ENABLED: 'true' })).toContain('MARBIM_ENABLED')
  })

  it('4 · MARBIM on with only an extraction key is STILL refused', () => {
    /*
     * The case the older "at least one key" rule let through, and the one that matters.
     * `MARBIM_ENABLED` puts the assistant button on every screen and opens `/marbim`, and
     * both do exactly one thing: ask the REASON model. A Gemini-only deployment renders a
     * perfect copilot that fails on every question.
     */
    expect(problems({ MARBIM_ENABLED: 'true', GEMINI_API_KEY: 'gem' })).toContain(
      'ANTHROPIC_API_KEY',
    )
  })

  it('5 · a reasoning key is enough — the other two roles may be absent', () => {
    /*
     * Deliberately NOT requiring all three. A factory that bought the copilot but not
     * document intake is a real deployment: it answers questions and refuses to read a PO,
     * naming GEMINI_API_KEY at the point of use. Demanding three vendor accounts to ship one
     * feature is what INFRA-H8 was.
     */
    expect(problems({ MARBIM_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant' })).toEqual([])
  })

  it('6 · the mock is refused in production whatever else is set', () => {
    // Serving a factory deterministic fixtures under a real model's name is the worst of the
    // available failures: it looks like it works.
    expect(
      problems({ MARBIM_MOCK: 'true', MARBIM_ENABLED: 'true', ANTHROPIC_API_KEY: 'sk-ant' }),
    ).toContain('MARBIM_MOCK')
  })

  it('7 · none of this applies outside production', () => {
    // A fresh clone boots against docker-compose alone. Requiring vendor keys in dev would
    // mean nobody could run the app without buying an Anthropic account first.
    expect(
      problems({ NODE_ENV: 'development', MARBIM_ENABLED: 'true', MARBIM_MOCK: 'true' }),
    ).toEqual([])
  })

  it('8 · the model ids default rather than being required', () => {
    // Models by ROLE, and the roles have working defaults — nobody should have to know a
    // model id to deploy. Overriding one is a single variable.
    const parsed = envSchema.safeParse({ ...PRODUCTION, ANTHROPIC_API_KEY: 'sk-ant' })

    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect(parsed.data.MARBIM_MODEL_EXTRACT).toBe('gemini-2.5-flash')
    expect(parsed.data.MARBIM_MODEL_REASON).toBe('claude-sonnet-5')
    expect(parsed.data.MARBIM_MODEL_REASON_LARGE).toBe('claude-opus-4')
    expect(parsed.data.MARBIM_MODEL_EMBED).toBe('text-embedding-3-small')
  })
})

/**
 * The mail path — now enforced HERE and nowhere else.
 *
 * `docker-compose.prod.yml` used to demand `SMTP_HOST` with `:?`, so a correct Resend-only
 * deployment could not start: compose refused before the app validated anything, and blamed
 * a missing SMTP server on a deployment that does not use one. Removing that made this rule
 * the only thing standing between a deploy and a factory nobody can log into — verification
 * email is required to sign in — so it is worth proving both routes and the gap.
 */
describe('production boot · mail, by either route', () => {
  const RESEND_ONLY = { RESEND_API_KEY: 're_test', SMTP_HOST: undefined }
  const SMTP_ONLY = { RESEND_API_KEY: undefined, SMTP_HOST: 'smtp.resend.com', SMTP_PORT: '587' }

  it('9 · a Resend key alone is a working deployment', () => {
    expect(problems(RESEND_ONLY)).toEqual([])
  })

  it('10 · an SMTP host alone is a working deployment', () => {
    // The configuration the compose file describes. It was briefly the ONLY one that
    // could start, which is the opposite of what env.ts has always said.
    expect(problems(SMTP_ONLY)).toEqual([])
  })

  it('11 · neither is refused, and the message names both ways out', () => {
    const result = envSchema.safeParse({
      ...PRODUCTION,
      RESEND_API_KEY: undefined,
      SMTP_HOST: undefined,
    })

    expect(result.success).toBe(false)
    if (result.success) return
    const message = result.error.issues.map((i) => i.message).join(' ')
    expect(message).toContain('SMTP_HOST')
    expect(message).toContain('RESEND_API_KEY')
  })

  it('12 · outside production a deployment with no mail path still boots', () => {
    // Dev sends to Mailpit over the SMTP defaults in mailer.ts; requiring a vendor account
    // to run the app locally would be the INFRA-H8 mistake in another costume.
    expect(problems({ NODE_ENV: 'development', RESEND_API_KEY: undefined })).toEqual([])
  })
})
