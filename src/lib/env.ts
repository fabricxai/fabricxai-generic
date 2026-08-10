/**
 * Boot-time environment validation (dev-plan §3, §6 "Zod at every boundary … env at boot").
 *
 * Importing this module validates `process.env` once and throws with EVERY missing or
 * malformed key listed — not just the first one. It is imported by `next.config.ts`,
 * `src/instrumentation.ts` and `src/worker/index.ts`, so app, worker and build all fail
 * fast rather than dying on the first request that happens to need a key.
 *
 * Keys that only matter in production (model providers, email, Sentry) are optional in
 * development so a fresh clone boots against docker-compose alone, and required in
 * production so a deploy can never go out half-configured.
 */
import { z } from 'zod'

if (typeof window !== 'undefined') {
  throw new Error('src/lib/env.ts is server-only — never import it from a client component')
}

const bool = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1')

const baseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.url(),

  // Postgres: the app goes through PgBouncer (transaction mode); migrations MUST bypass
  // it — prepared statements and session state do not survive a transaction pooler.
  DATABASE_URL: z.string().min(1).startsWith('postgres'),
  DIRECT_DATABASE_URL: z.string().min(1).startsWith('postgres'),

  REDIS_URL: z.string().min(1).startsWith('redis'),

  // Better Auth — session cookie signing. Rotation documented in docs/runbooks.
  BETTER_AUTH_SECRET: z.string().min(32, 'BETTER_AUTH_SECRET must be at least 32 chars'),
  BETTER_AUTH_URL: z.url().optional(),

  // Object storage: MinIO in dev/prod, any S3 API later — all code uses @aws-sdk/client-s3.
  S3_ENDPOINT: z.url(),
  /**
   * Browser-facing object-storage base, used ONLY to sign presigned URLs.
   *
   * `S3_ENDPOINT` is the server's route to storage — on a compose deployment that is
   * `http://minio:9000`, which a floor tablet cannot resolve. SigV4 signs the Host
   * header and the path, so a URL signed for the internal name cannot be rewritten in
   * the browser: without this split every upload and download fails in production
   * (audit INFRA-H1). Optional, and falls back to `S3_ENDPOINT`, because in dev the two
   * are genuinely the same address.
   */
  S3_PUBLIC_ENDPOINT: z.url().optional(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_FORCE_PATH_STYLE: bool.default(true),

  // Model providers — routed by task type in the model registry (PLAYBOOK §6a).
  // Modules never name a model; only the registry reads these.
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  OPENAI_API_KEY: z.string().min(1).optional(),
  /**
   * The model serving each ROLE (plan 6.4). Never a provider id in module code — modules ask
   * for `extract` / `reason` / `embed` and the registry routes it, which is what makes
   * swapping a vendor an env change rather than a refactor.
   *
   * The defaults are the intended production mix, one vendor per role for a reason:
   *
   *  - **extract → whichever vendor this model id names.** `gemini-*` routes to Gemini,
   *    `gpt-*` / `o*` to OpenAI; `providers/by-role.ts` resolves it, and the matching key is
   *    the one it will ask for. The requirement is unchanged and non-negotiable: the model
   *    must return per-token log-probabilities, because without them an extraction has no
   *    measured per-field confidence to carry (rule 3, plan 6.3) and it fails loudly.
   *
   *    **The default below is known-dead for new Google accounts.** As of August 2026 no
   *    Gemini model on AI Studio returns logprobs — twenty-six were checked; thirteen answer
   *    "Logprobs is not enabled for this model" and the rest are retired, gated to new users,
   *    or lack JSON mode. A new deployment wanting document intake should set
   *    `MARBIM_MODEL_EXTRACT=gpt-4o-mini` and an `OPENAI_API_KEY`. The default is left alone
   *    so an existing deployment that still has Gemini access is not silently moved to
   *    another vendor's bill.
   *  - **reason → Anthropic**, because the department primers are the product and this is the
   *    model that reads nineteen of them to answer a merchandiser.
   *  - **embed → OpenAI**, into the `vector(1536)` column 1.6 searches. `text-embedding-3-small`
   *    is natively 1536, so the width is exact rather than truncated; `-3-large` is a better
   *    embedding and a one-variable upgrade if the similarity results warrant the cost.
   */
  MARBIM_MODEL_EXTRACT: z.string().min(1).default('gemini-2.5-flash'),
  MARBIM_MODEL_REASON: z.string().min(1).default('claude-sonnet-5'),
  MARBIM_MODEL_EMBED: z.string().min(1).default('text-embedding-3-small'),
  /** Serve MARBIM from fixtures — no provider calls. Dev/test only. */
  MARBIM_MOCK: bool.default(false),
  /**
   * Whether the copilot is offered at all.
   *
   * Off by default, and off is the honest setting today: no real provider is registered,
   * so an enabled MARBIM hard-fails every question while its extraction poller silently
   * accumulates unread documents (audit AI-B1). A factory should be told the copilot is
   * not available rather than shown one that does not work.
   */
  MARBIM_ENABLED: bool.default(false),

  // Email: transactional only, never self-hosted SMTP in prod. Dev uses Mailpit.
  RESEND_API_KEY: z.string().min(1).optional(),
  SMTP_HOST: z.string().min(1).optional(),
  SMTP_PORT: z.coerce.number().int().positive().optional(),
  EMAIL_FROM: z.email().default('no-reply@fabricxai.local'),

  /**
   * Bearer token for `/api/health/jobs` (plan 7.5, audit INFRA-M1).
   *
   * That route names every scheduled task and reports raw failure text — a map of what this
   * deployment runs and what is currently broken in it, which is reconnaissance rather than
   * a status page. Unauthenticated it was reachable by anyone who could reach the app.
   *
   * Optional, and the route REFUSES when it is unset rather than falling open. An operator
   * who has not set a token has not decided to publish their schedule.
   */
  HEALTH_TOKEN: z.string().min(16, 'HEALTH_TOKEN must be at least 16 chars').optional(),

  SENTRY_DSN: z.string().optional(),

  /**
   * `1` stands the auth rate limiter down — sign-in included — even in production.
   *
   * For a tenant holding TEST data walked through by several people at once: the sign-in
   * limit is ten per five minutes per IP, an office shares one address, and the login form
   * reports the resulting 429 in the same words it uses for a wrong password.
   *
   * Declared here rather than read as a bare `process.env` so it passes the compose ↔ env
   * contract: a variable the compose file forwards and the schema has never heard of is
   * indistinguishable from a typo, and one nothing forwards is documentation for a switch
   * that does nothing. Only an exact `1` disables; `false`, `0` and blank all leave the
   * limiter running, because those are what somebody types when they mean ON.
   */
  RATE_LIMIT_DISABLED: z.string().optional(),

  /** BullMQ default per-queue concurrency in the worker process. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
})

/**
 * Exported so the production-only rules can be exercised without a production process.
 *
 * They are boot ASSERTIONS — the whole value is that a misconfigured deploy dies at startup
 * instead of at 3am — and an assertion nothing has ever been seen to fire is decoration, the
 * same argument that put the four custom lint rules under a RuleTester.
 */
export const envSchema = baseSchema.superRefine((env, ctx) => {
  if (env.NODE_ENV !== 'production') return

  // ── A working mail path, by either route ────────────────────────────────────
  //
  // Verification email is required to SIGN IN, so a deployment with no mail path is a
  // deployment nobody can log into. This used to demand RESEND_API_KEY specifically,
  // which was wrong in both directions: it failed a perfectly good SMTP deployment (the
  // one docker-compose.prod.yml actually describes) and would have passed a Resend key
  // with no sender configured.
  if (!env.RESEND_API_KEY && !env.SMTP_HOST) {
    ctx.addIssue({
      code: 'custom',
      path: ['SMTP_HOST'],
      message:
        'production needs a mail path: set SMTP_HOST (with SMTP_PORT) or RESEND_API_KEY. ' +
        'Email verification is required to sign in, so without one nobody can log in.',
    })
  }

  // ── MARBIM ─────────────────────────────────────────────────────────────────
  //
  // This used to require ANTHROPIC_API_KEY *and* GEMINI_API_KEY *and* OPENAI_API_KEY —
  // three unrelated vendor accounts — while no real provider was registered, so a
  // deployment had to buy and configure all three and then still got a hard failure the
  // moment anybody asked MARBIM a question (audit INFRA-H8).
  //
  // Now it is a flag. Off (the default) means the copilot is honestly absent. On means at
  // least one provider key must be present, because a MARBIM that is enabled and cannot
  // reach a model is the worst of the three states: it looks available and fails per use.
  if (env.MARBIM_ENABLED && !env.ANTHROPIC_API_KEY && !env.GEMINI_API_KEY && !env.OPENAI_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['MARBIM_ENABLED'],
      message:
        'MARBIM_ENABLED is set but no provider key is configured — set at least one of ' +
        'ANTHROPIC_API_KEY, GEMINI_API_KEY, OPENAI_API_KEY, or unset MARBIM_ENABLED.',
    })
  }

  if (env.MARBIM_MOCK) {
    ctx.addIssue({
      code: 'custom',
      path: ['MARBIM_MOCK'],
      message: 'MARBIM_MOCK must be off in production',
    })
  }

  // The reason role specifically, not just "any key" (plan 6.4). MARBIM_ENABLED puts two
  // surfaces in front of every user — the assistant button on every screen and `/marbim` —
  // and both of them do exactly one thing: ask the REASON model a question. A production
  // deployment with a Gemini key and no Anthropic key therefore ships a copilot that renders
  // perfectly and fails on every question, which is the state 6.1 was written to end.
  //
  // Extraction and embedding are different: those are features that can be absent. A factory
  // that has not bought document intake gets a copilot that answers questions and refuses to
  // read a PO, and says so at the point of use.
  if (env.MARBIM_ENABLED && !env.ANTHROPIC_API_KEY) {
    ctx.addIssue({
      code: 'custom',
      path: ['ANTHROPIC_API_KEY'],
      message:
        'MARBIM_ENABLED is set in production but there is no reasoning model — set ' +
        'ANTHROPIC_API_KEY, or unset MARBIM_ENABLED. Every question asked of the copilot ' +
        'goes to the reason role, so without it the panel opens and nothing works.',
    })
  }

  // SENTRY_DSN is deliberately NOT required. It is now actually read
  // (`lib/observability.ts`), and a single-factory pilot on a VPS with no Sentry account
  // is a legitimate deployment — it should ship logs and know that is what it has, rather
  // than refusing to boot over a monitoring tool. Its absence is warned about at startup.
})

export type Env = z.infer<typeof baseSchema>

/**
 * Every variable the application reads, and each one's field schema — exported for the
 * deploy-contract test.
 *
 * Five deployment defects in one week shared a single shape: a variable one file declares
 * that another file does not honour. `MARBIM_MODEL_EXTRACT` was settable in .env.production
 * and forwarded by nothing; `EMAIL_FROM`'s example value failed this file's own `z.email()`.
 * None were visible to a test of either file alone — the contract lives BETWEEN files, and
 * `deploy-contract.test.ts` is where it is now enforced. This export is what makes that test
 * possible without duplicating the key list, which would itself drift.
 */
export const ENV_FIELDS: Readonly<Record<string, z.ZodType>> = baseSchema.shape

/**
 * `.env` files spell "not configured yet" as `KEY=` — an empty string, not an absent
 * key. Strip those before parsing so `.optional()` and `.default()` behave the way the
 * file reads, instead of every blank placeholder failing as "too small".
 */
function withoutBlanks(source: NodeJS.ProcessEnv): Record<string, string> {
  const cleaned: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') cleaned[key] = value
  }
  return cleaned
}

/**
 * `next build` imports every route module to collect page data, which reaches this file.
 * A build is NOT a boot: production secrets are not available when an image is built and
 * must not be, or CI needs the real keys and the image ends up carrying placeholders.
 *
 * So during a production build the validation is skipped and whatever happens to be set
 * is passed through. Nothing should read a connection string at build time anyway —
 * `src/db/client.ts` is lazy for exactly this reason — and if something does, it gets
 * `undefined` and fails loudly at that point rather than being quietly papered over.
 *
 * The real gate is unchanged: `src/instrumentation.ts` and `src/worker/index.ts` validate
 * on every server boot, so a misconfigured deployment dies immediately at startup.
 */
const isNextBuild = process.env.NEXT_PHASE === 'phase-production-build'

function loadEnv(): Env {
  const source = withoutBlanks(process.env)
  const parsed = envSchema.safeParse(source)

  if (!parsed.success) {
    if (isNextBuild) return source as unknown as Env

    const lines = parsed.error.issues.map((i) => `  • ${i.path.join('.') || '(root)'}: ${i.message}`)
    throw new Error(
      `Invalid environment (${lines.length} problem${lines.length === 1 ? '' : 's'}):\n` +
        `${lines.join('\n')}\n\n` +
        `Copy .env.example to .env and fill it in — values matching docker-compose.dev.yml are already there.`,
    )
  }

  return parsed.data
}

export const env: Env = loadEnv()

export const isProduction = env.NODE_ENV === 'production'
export const isDevelopment = env.NODE_ENV === 'development'
