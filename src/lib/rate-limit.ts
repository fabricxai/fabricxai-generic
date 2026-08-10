/**
 * Redis token buckets for the endpoints a client can hammer.
 *
 * Three doors had no limit of any kind (audit INFRA-H7):
 *
 *  - **auth.** Nothing throttled password guessing against `/api/auth/sign-in/email`, and
 *    nothing throttled sign-up — where each attempt runs `provisionCompany`, writing
 *    calendars and taxonomies, i.e. an expensive write reachable without a session.
 *  - **`/api/sync`.** The one door every floor write goes through. The only ceiling was
 *    200 rows per batch, with no limit on batches.
 *  - **`/api/documents`.** Presign issuance. A compromised tablet session could mint
 *    unlimited 25MB upload grants against the factory's object storage.
 *
 * Redis, not in-memory: the app and worker are separate processes and a deploy replaces
 * both, so an in-process counter is neither shared nor durable — it resets at exactly the
 * moment an attacker would notice it had.
 *
 * ## Why a fixed window and not a sliding log
 *
 * `INCR` + `EXPIRE` is two commands and one key. A sliding-window log is more precise at
 * the boundary — a client can burst 2× the limit across a window edge — and that
 * precision buys nothing here: these limits exist to stop brute force and runaway
 * clients, not to meter a paid API. The imprecision is bounded and understood, which is
 * worth more than exactness nobody can debug at 3am.
 *
 * ## Failing OPEN, deliberately
 *
 * If Redis is unreachable, requests are allowed. The alternative — failing closed —
 * means a Redis blip locks a factory floor out of recording production, and the floor
 * cannot wait: cloth is being cut whether or not the ERP is available. Redis being down
 * is already a loud problem (BullMQ stops, `/api/health` reports it); it should not also
 * become a data-loss problem. This is the one place in this codebase that fails open, and
 * it is a considered exception to how the gates work.
 */
import { getRedis } from './redis'

/**
 * Whether Better Auth's limiter runs at all, as a function so it can be read and tested
 * rather than inferred from a boolean expression inside a config object.
 *
 * Three states, in precedence order:
 *   · `RATE_LIMIT_DISABLED=1` — off, even in production. A test tenant being walked
 *     through by several people from one office trips ten-per-five-minutes long before a
 *     role sweep is done, and the login form reports that 429 in the same words it uses
 *     for a wrong password. Explicit off must beat everything, or it is not an escape
 *     hatch; it is a suggestion.
 *   · `RATE_LIMIT_ENFORCE=1` — on anywhere, so the limits can be exercised outside
 *     production instead of being discovered in it.
 *   · otherwise, on in production only.
 */
export function authRateLimitEnabled(input: {
  nodeEnv: string
  /** `RATE_LIMIT_DISABLED`, validated by `env.ts` and forwarded by the compose file. */
  disabled?: string | undefined
  /** `RATE_LIMIT_ENFORCE` — a CI-only lever, so it stays a bare process variable. */
  enforce?: string | undefined
}): boolean {
  if (input.disabled === '1') return false
  return input.nodeEnv === 'production' || input.enforce === '1'
}

export interface RateLimit {
  /** Requests allowed per window. */
  limit: number
  /** Window length in seconds. */
  windowSeconds: number
}

export interface RateLimitResult {
  ok: boolean
  /** Requests left in this window. Zero when refused. */
  remaining: number
  /** Seconds until the window resets — what a Retry-After header should say. */
  resetSeconds: number
}

/**
 * The limits, in one place so they can be read together rather than discovered one route
 * at a time. Each number is chosen against what the legitimate client actually does.
 */
export const LIMITS = {
  /**
   * Sign-in attempts per identifier. A storekeeper mistypes a password twice; ten in five
   * minutes is not a person remembering.
   */
  signIn: { limit: 10, windowSeconds: 300 },

  /**
   * Sign-up. Each one provisions a company, so this is the most expensive unauthenticated
   * write in the product. A real factory signs up once.
   */
  signUp: { limit: 3, windowSeconds: 3600 },

  /** Password reset / verification resend — enough for a genuinely confused user. */
  authRecovery: { limit: 5, windowSeconds: 900 },

  /**
   * Offline sync batches per user. A tablet reconnecting after a shift drains its queue in
   * bursts of up to 200 rows; 60 batches a minute is 12,000 rows a minute, far above any
   * real floor and far below what would hurt.
   */
  sync: { limit: 60, windowSeconds: 60 },

  /**
   * Presign issuance per user. A storekeeper photographs a challan, a QC inspector
   * attaches a few defect photos; thirty a minute is generous for a human and stops a
   * loop from minting grants.
   */
  documents: { limit: 30, windowSeconds: 60 },

  /**
   * Command-bar searches per user. Each one fans out to up to six modules, and it fires
   * from a debounced keystroke — so the honest ceiling is "a person typing fast", not
   * "a person clicking". Sixty a minute is one every second, which no human sustains and
   * which stops a stuck client from turning a search box into a load generator.
   */
  search: { limit: 60, windowSeconds: 60 },

  /**
   * Hourly output posts per user.
   *
   * The real shape is a burst, not a stream: fifty supervisors hit submit within a minute
   * of 17:00 and then nothing happens for an hour. Each post carries up to 600 cells, so
   * this is a ceiling on REQUESTS and the batch size is the ceiling on rows. Sized above
   * a whole shift's catch-up after an outage and well below anything that hurts.
   */
  productionWrite: { limit: 120, windowSeconds: 60 },

  /**
   * Board reads per user. Twenty tablets and a TV poll this through a shift; a poll every
   * two seconds per client is far faster than any of them refresh, and it stops a stuck
   * dashboard turning into a load generator against a partitioned table.
   */
  productionBoard: { limit: 180, windowSeconds: 60 },
} as const satisfies Record<string, RateLimit>

/**
 * Consume one token for `key`.
 *
 * `key` must already identify the subject — `rl:sync:<userId>`, `rl:signin:<email>`.
 * Callers build it, because only the caller knows whether the right subject is the user,
 * the company or the IP.
 */
export async function consume(key: string, { limit, windowSeconds }: RateLimit): Promise<RateLimitResult> {
  try {
    const redis = getRedis()

    // Pipelined so this is one round trip. INCR then EXPIRE-if-new: setting the TTL only
    // on the first hit is what makes it a fixed window rather than a sliding one that
    // never expires while a client keeps knocking.
    const [count, ttl] = (await redis
      .multi()
      .incr(key)
      .expire(key, windowSeconds, 'NX')
      .ttl(key)
      .exec()
      .then((replies) => [replies?.[0]?.[1] as number, replies?.[2]?.[1] as number])) as [
      number,
      number,
    ]

    // A missing TTL (-1) would be a key that never expires; repair it rather than leak.
    const resetSeconds = ttl > 0 ? ttl : windowSeconds
    if (ttl < 0) await redis.expire(key, windowSeconds)

    return {
      ok: count <= limit,
      remaining: Math.max(0, limit - count),
      resetSeconds,
    }
  } catch (error) {
    // See the header: fails open on purpose. Logged so a silently-unlimited endpoint is
    // still visible in the logs rather than only in an attacker's traffic.
    console.error('[rate-limit] redis unavailable, allowing request:', error)
    return { ok: true, remaining: limit, resetSeconds: windowSeconds }
  }
}

/** A 429 with the headers a well-behaved client honours. */
export function tooManyRequests(result: RateLimitResult): Response {
  return Response.json(
    {
      error: {
        code: 'rate_limited',
        // The i18n key, like every other error the UI may show.
        messageKey: 'errors.rate_limited',
        details: { retryAfterSeconds: result.resetSeconds },
      },
    },
    {
      status: 429,
      headers: {
        'Retry-After': String(result.resetSeconds),
        'X-RateLimit-Remaining': '0',
      },
    },
  )
}
