/**
 * The real provider's wiring (plan 6.4, audit AI-B1/AI-H1).
 *
 * What is testable here is everything except the network call itself: which role goes to
 * which vendor, what happens when a key is absent, what the panel is captioned with, and how
 * an extraction identifies the thing that produced it. The three `extract`/`generate`/`embed`
 * bodies are SDK calls and are exercised by nothing in this repo — see docs/STUBS.md.
 *
 * Constructing a client does not open a connection, so building the provider with fake keys
 * is offline and deterministic, which is the property `provider.ts` says every test in this
 * module must have.
 */
import { describe, expect, it } from 'vitest'

import { extractorVersionFor } from '../marbim'
import { byRoleProvider, configuredRoles, type ByRoleConfig } from '../providers/by-role'
import { ProviderError, providerSurfaceLabel } from '../provider'
import { surfaceLabelFor } from '../surface-label'

const MODELS = {
  reason: 'claude-sonnet-5',
  extract: 'gemini-2.5-flash',
  embed: 'text-embedding-3-small',
} as const

const config = (keys: Partial<ByRoleConfig>): ByRoleConfig => ({
  models: { ...MODELS },
  ...keys,
})

const ALL = config({
  anthropicApiKey: 'sk-ant-test',
  geminiApiKey: 'gem-test',
  openAiApiKey: 'sk-test',
})

describe('byRoleProvider · each role goes to the vendor that can serve it', () => {
  it('1 · reports the three roles it can serve', () => {
    expect(configuredRoles(ALL).sort()).toEqual(['embed', 'extract', 'reason'])
  })

  it('2 · is null when no vendor key is configured at all', () => {
    /*
     * Not an error, and not a mock. A dev machine with no keys registers NOTHING, so
     * `hasProvider()` is false, the three screens refuse and the extraction poller records a
     * skip rather than a success (plan 6.1). Falling back to the deterministic provider here
     * would be the silent-plausible-output failure the whole seam exists to prevent.
     */
    expect(byRoleProvider(config({}))).toBeNull()
  })

  it('3 · serves the roles it has keys for and refuses the rest BY NAME', () => {
    // The partial configuration is a real deployment: a factory that bought the copilot but
    // not document intake. It should answer questions and refuse to read a PO — and the
    // refusal has to name the variable that would fix it, because the person reading it is
    // an operator looking at a failed job, not the author of this file.
    const reasonOnly = byRoleProvider(config({ anthropicApiKey: 'sk-ant-test' }))!

    expect(reasonOnly).not.toBeNull()
    expect(configuredRoles(config({ anthropicApiKey: 'x' }))).toEqual(['reason'])

    return Promise.all([
      expect(
        reasonOnly.extract({
          role: 'extract',
          schema: { safeParse: () => ({ success: true, data: {} }) } as never,
          input: 'x',
          instruction: 'x',
        }),
      ).rejects.toThrow(/GEMINI_API_KEY/),
      expect(
        reasonOnly.embed({ role: 'embed', inputs: ['x'], dimensions: 1536 }),
      ).rejects.toThrow(/OPENAI_API_KEY/),
    ])
  })

  it('4 · the refusal is a ProviderError and is not retryable', () => {
    // A missing key will still be missing on the next attempt. Retrying it would burn a
    // BullMQ backoff cycle on a configuration problem and bury the message that says so.
    const embedOnly = byRoleProvider(config({ openAiApiKey: 'sk-test' }))!

    return embedOnly
      .generate({ role: 'reason', system: 's', messages: [{ role: 'user', content: 'q' }] })
      .then(
        () => expect.unreachable('a provider with no reasoner must refuse'),
        (error: unknown) => {
          expect(error).toBeInstanceOf(ProviderError)
          expect((error as ProviderError).retryable).toBe(false)
        },
      )
  })

  it('5 · is captioned with the REASON model, because that is what the panel shows', () => {
    /*
     * `providerId()` captions the assistant panel. `by-role` would tell the reader nothing;
     * `gemini+claude+openai` would be accurate and useless. The panel displays an ANSWER, and
     * answers come from the reason model — the seam's own comment calls a mismatched caption
     * "the exact class of small lie that makes somebody trust the big numbers too".
     */
    expect(byRoleProvider(ALL)!.id).toBe('claude-sonnet-5')
    expect(byRoleProvider(ALL)!.models).toEqual({
      reason: 'claude-sonnet-5',
      extract: 'gemini-2.5-flash',
      embed: 'text-embedding-3-small',
    })
  })

  it('5b · the panel face shows marbim fast / marbim large, not the vendor id', () => {
    // Jobs still record claude-sonnet-5; the header a person reads uses the product name.
    expect(providerSurfaceLabel('claude-sonnet-5')).toBe('marbim fast')
    expect(surfaceLabelFor('claude-sonnet-5')).toBe('marbim fast')
    expect(surfaceLabelFor('claude-opus-4')).toBe('marbim large')
    expect(surfaceLabelFor('mock/deterministic-v1')).toBe('mock/deterministic-v1')
    expect(surfaceLabelFor(null)).toBeNull()
  })

  it('6 · names what it DOES have when there is no reasoner', () => {
    // An extract-only deployment still has to caption itself with something true.
    expect(byRoleProvider(config({ geminiApiKey: 'gem-test' }))!.id).toBe('gemini-2.5-flash')
  })

  it('7 · lists only the roles it can serve, so a caller can ask before it calls', () => {
    const partial = byRoleProvider(config({ anthropicApiKey: 'x', openAiApiKey: 'y' }))!

    expect(Object.keys(partial.models!).sort()).toEqual(['embed', 'reason'])
    expect(partial.models!.extract).toBeUndefined()
  })
})

describe('extractorVersionFor · the correction rate can finally tell two extractors apart', () => {
  it('1 · carries both the prompt version and the model', () => {
    /*
     * It was the literal `'1'` on every extraction ever queued. `extractor_version` is what
     * `correctionRates` groups by — the honest measure X.2's primer tells MARBIM to quote
     * INSTEAD of confidence — so a constant made that report one lifetime average across
     * every prompt and every model the system had run.
     */
    expect(extractorVersionFor({ promptVersion: '1.0.0', model: 'gemini-2.5-flash' })).toBe(
      '1.0.0+gemini-2.5-flash',
    )
  })

  it('2 · separates a prompt rewrite from its predecessor', () => {
    const before = extractorVersionFor({ promptVersion: '1.0.0', model: 'gemini-2.5-flash' })
    const after = extractorVersionFor({ promptVersion: '1.1.0', model: 'gemini-2.5-flash' })

    expect(before).not.toBe(after)
  })

  it('3 · separates a model swap under an unchanged prompt', () => {
    // The case a prompt-only version misses entirely, and the one most likely to happen by
    // accident: somebody changes MARBIM_MODEL_EXTRACT and the numbers pool silently.
    const flash = extractorVersionFor({ promptVersion: '1.0.0', model: 'gemini-2.5-flash' })
    const pro = extractorVersionFor({ promptVersion: '1.0.0', model: 'gemini-2.5-pro' })

    expect(flash).not.toBe(pro)
  })

  it('4 · fits the column, and stays distinct when it cannot fit readably', () => {
    /*
     * The column is 40 characters. Truncating would collide two dated previews —
     * `…preview-04-17` and `…preview-05-20` — which is precisely the pooling this exists to
     * prevent, so a too-long id is hashed instead. Unreadable but distinct; the readable
     * form is on `pending_changes.model`.
     */
    const april = extractorVersionFor({
      promptVersion: '1.0.0',
      model: 'gemini-2.5-flash-preview-04-17-experimental',
    })
    const may = extractorVersionFor({
      promptVersion: '1.0.0',
      model: 'gemini-2.5-flash-preview-05-20-experimental',
    })

    expect(april.length).toBeLessThanOrEqual(40)
    expect(may.length).toBeLessThanOrEqual(40)
    expect(april).not.toBe(may)
  })

  it('5 · is stable for the same input, so two runs group together', () => {
    const model = 'gemini-2.5-flash-preview-04-17-experimental'
    expect(extractorVersionFor({ promptVersion: '1.0.0', model })).toBe(
      extractorVersionFor({ promptVersion: '1.0.0', model }),
    )
  })

  it('6 · still identifies a job queued with no extract model configured', () => {
    // The job will fail. The failure is worth being able to group by later, and `''` or a
    // throw here would lose that.
    expect(extractorVersionFor({ promptVersion: '1.0.0', model: null })).toBe('1.0.0+unconfigured')
  })
})

/**
 * The extract role is no longer Gemini's by definition.
 *
 * It was, and for a stated reason: Gemini was "the only one of the three vendors that returns
 * per-token log-probabilities alongside a schema-constrained JSON response". Both halves of
 * that stopped being true. OpenAI does return them, and as of August 2026 no Gemini model on
 * AI Studio does — twenty-six were checked, thirteen answer "Logprobs is not enabled for this
 * model" and the rest are retired, gated to new accounts, or lack JSON mode.
 *
 * So the role follows `MARBIM_MODEL_EXTRACT`, which already names the model and therefore
 * already names the vendor. What must NOT move is the confidence contract: both extractors
 * derive per-field scores from token logprobs through the same file, and both refuse outright
 * when the tokens are absent. These tests pin the routing; `field-confidence.test.ts` pins the
 * derivation they share.
 */
describe('byRoleProvider · which vendor reads documents', () => {
  const withExtract = (extract: string, keys: Partial<ByRoleConfig>): ByRoleConfig => ({
    models: { ...MODELS, extract },
    ...keys,
  })

  it('7 · a gemini-* model still goes to Gemini, and still asks for GEMINI_API_KEY', () => {
    // The default, and the regression that matters: an existing deployment must not change
    // behaviour because this routing was added.
    const config = withExtract('gemini-2.5-flash', { openAiApiKey: 'sk-test' })

    expect(configuredRoles(config)).not.toContain('extract')

    return expect(
      byRoleProvider(config)!.extract({
        role: 'extract',
        schema: { safeParse: () => ({ success: true, data: {} }) } as never,
        input: 'x',
        instruction: 'x',
      }),
    ).rejects.toThrow(/GEMINI_API_KEY/)
  })

  it('8 · a gpt-* model goes to OpenAI, and names OPENAI_API_KEY when the key is absent', () => {
    /*
     * The misconfiguration this exists to make legible: an operator who set
     * MARBIM_MODEL_EXTRACT=gpt-4o-mini and no OpenAI key used to be told to set
     * GEMINI_API_KEY — advice that would not have fixed it, for a vendor they had chosen not
     * to use.
     */
    // Anthropic is present so the provider exists at all: a config whose ONLY key is a Gemini
    // one, pointed at a gpt model, can serve nothing and is correctly null. The realistic
    // shape of this mistake is a working copilot with extraction misconfigured beside it.
    const config = withExtract('gpt-4o-mini', {
      anthropicApiKey: 'sk-ant-test',
      geminiApiKey: 'gem-test',
    })

    expect(configuredRoles(config)).not.toContain('extract')

    return byRoleProvider(config)!
      .extract({
        role: 'extract',
        schema: { safeParse: () => ({ success: true, data: {} }) } as never,
        input: 'x',
        instruction: 'x',
      })
      .then(
        () => expect.unreachable('an OpenAI extract model with no OpenAI key must refuse'),
        (error: unknown) => {
          expect(error).toBeInstanceOf(ProviderError)
          expect((error as ProviderError).message).toMatch(/OPENAI_API_KEY/)
          expect((error as ProviderError).message).toMatch(/gpt-4o-mini/)
          // A missing key is missing on the next attempt too.
          expect((error as ProviderError).retryable).toBe(false)
        },
      )
  })

  it('9 · an OpenAI key plus a gpt-* model makes extraction available', () => {
    // The configuration this whole change exists to permit: a factory with no usable Gemini
    // model can still read documents, without the confidence rule being touched.
    const config = withExtract('gpt-4o-mini', { openAiApiKey: 'sk-test' })

    expect(configuredRoles(config)).toContain('extract')
    expect(byRoleProvider(config)!.models?.extract).toBe('gpt-4o-mini')
  })

  it('10 · o-series ids route to OpenAI too', () => {
    expect(configuredRoles(withExtract('o4-mini', { openAiApiKey: 'sk-test' }))).toContain('extract')
    expect(configuredRoles(withExtract('o4-mini', { geminiApiKey: 'gem' }))).not.toContain('extract')
  })

  it('11 · configuredRoles and the provider cannot disagree about extraction', () => {
    /*
     * They are read by different surfaces — one captions what the deployment can do, the
     * other refuses at the point of use — and the failure of them drifting is a screen
     * offering a button the seam then rejects. One resolver answers both.
     */
    for (const model of ['gemini-2.5-flash', 'gpt-4o-mini', 'o4-mini']) {
      for (const keys of [{ geminiApiKey: 'g' }, { openAiApiKey: 'o' }, { geminiApiKey: 'g', openAiApiKey: 'o' }]) {
        const config = withExtract(model, keys)
        const claimed = configuredRoles(config).includes('extract')
        const provider = byRoleProvider(config)
        const served = provider !== null && provider.models?.extract !== undefined
        expect(served, `${model} with ${JSON.stringify(keys)}`).toBe(claimed)
      }
    }
  })
})
