import js from '@eslint/js'
import next from 'eslint-config-next'
import globals from 'globals'
import tseslint from 'typescript-eslint'

import analyticsNoWrites from './eslint-rules/analytics-no-writes.js'
import noFloatMoney from './eslint-rules/no-float-money.js'
import noInventedConfidence from './eslint-rules/no-invented-confidence.js'
import noLocalMoneyHelpers from './eslint-rules/no-local-money-helpers.js'
import requireTenantPredicate from './eslint-rules/require-tenant-predicate.js'

/**
 * The custom rules below are not style preferences — they are the only automated
 * enforcement behind CLAUDE.md rules 2, 3, 4 and 9. Everything else in this file is
 * conventional; these are the reason it exists.
 */
const fabricxai = {
  rules: {
    'no-float-money': noFloatMoney,
    'no-invented-confidence': noInventedConfidence,
    'analytics-no-writes': analyticsNoWrites,
    'require-tenant-predicate': requireTenantPredicate,
    'no-local-money-helpers': noLocalMoneyHelpers,
  },
}

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'src/db/migrations/**',
      'coverage/**',
      'dist/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,

  {
    languageOptions: {
      globals: { ...globals.node, ...globals.browser },
    },
    plugins: { fabricxai },
  },

  {
    // TypeScript rules apply to TypeScript. The lint rules themselves are plain JS.
    //
    // Deliberately NOT using typed linting (`parserOptions.project`): it needs a full
    // type-check per lint run, roughly doubling CI time, and `pnpm typecheck` already
    // runs tsc over the same files. Syntactic rules here, types there.
    files: ['**/*.{ts,tsx}'],
    rules: {
      // The service layer is where a silent `any` becomes a production bug.
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },

  // ── CLAUDE.md rule 4 · money is never a float ─────────────────────────────
  {
    // `src/lib` and `src/components` were outside this for months, and they are where money
    // is FORMATTED — `fx/format.tsx`, `fx/tna.tsx` — so the one layer that turns an exact
    // string into something a person reads was the one layer unchecked (audit TEST-M11).
    files: [
      'src/modules/**/*.ts',
      'src/app/**/*.{ts,tsx}',
      'src/db/**/*.ts',
      'src/worker/**/*.ts',
      'src/lib/**/*.ts',
      'src/components/**/*.{ts,tsx}',
    ],
    rules: { 'fabricxai/no-float-money': 'error' },
  },
  {
    // The two files allowed to convert, and only to display. Off here rather than disabled
    // inline so the whole exemption is one visible list rather than scattered comments.
    files: ['src/lib/money.ts', 'src/lib/quantity.ts'],
    rules: { 'fabricxai/no-float-money': 'off' },
  },

  // ── CLAUDE.md rule 4 · one implementation of scaled-BigInt money ──────────
  //
  // `lib/money.ts` and `lib/quantity.ts` are the sanctioned conversions. Fifteen files
  // carry a private copy of the same two functions (audit BE-M8) — each individually
  // exact, none sharing the tests, none carrying a currency, and all of them a place to
  // miss when a rounding convention changes.
  //
  // A SHRINK-ONLY list, like the tenant-predicate ratchet: converting twenty files is
  // module-by-module work, but a sixteenth is banned from today. Removing a file from this
  // list is the definition of progress; adding one is the thing this exists to stop.
  {
    files: ['src/**/*.ts'],
    ignores: [
      'src/lib/money.ts',
      'src/lib/quantity.ts',
      'src/modules/commercial/ud.ts',
      'src/modules/procurement/procurement.ts',
      'src/modules/procurement/service.ts',
      'src/modules/quality/service.ts',
      'src/modules/shipment/service.ts',
      'src/modules/shipment/shipment.ts',
      // Caught only once this became a real rule: these are arrow-function copies, which
      // the selector version could not see. Same debt, five more files.
      'src/modules/commercial/lc-conflicts.ts',
      'src/modules/planning/service.ts',
      'src/modules/store/service.ts',
      'src/modules/workforce/service.ts',
      '**/__tests__/**',
    ],
    rules: { 'fabricxai/no-local-money-helpers': 'error' },
  },

  // ── The factory's today is not UTC's (audit INFRA-H2) ─────────────────────
  //
  // `new Date().toISOString().slice(0,10)` answers YESTERDAY between 00:00 and 05:59 in
  // Dhaka — the night shift, and every nightly cron. Four modules had each written their
  // own Intl workaround; `lib/dates.ts` is that function once. Seeds and tests are exempt:
  // their calendar day carries no meaning, and a fixture is allowed to be arbitrary.
  {
    files: ['src/modules/**/*.ts', 'src/app/**/*.{ts,tsx}', 'src/components/**/*.{ts,tsx}', 'src/worker/**/*.ts'],
    ignores: ['**/__tests__/**', 'src/db/seed/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          // Only the argument-less `new Date()` — "now". Date arithmetic on an explicit
          // UTC-anchored calendar string (`new Date(\`${d}T00:00:00Z\`)`) is timezone-
          // neutral and correct; `lib/dates.ts` does exactly that internally. Banning it
          // too would be telling people off for the right thing.
          selector:
            "CallExpression[callee.property.name='slice'][callee.object.callee.property.name='toISOString'][callee.object.callee.object.callee.name='Date'][callee.object.callee.object.arguments.length=0]",
          message:
            "`new Date().toISOString().slice(0,10)` is UTC, and the factory is UTC+6 — it answers yesterday for the whole night shift. Use factoryToday() from @/lib/dates.",
        },
      ],
    },
  },

  // ── CLAUDE.md rule 2 · the query names its company (wall 1) ───────────────
  //
  // An ADOPTION RATCHET, and it is now nearly complete. Rule 2 says RLS is "the second wall,
  // never the only wall", and it was the only wall: eight incidental company predicates
  // across 466 query sites (audit BE-B1).
  //
  // Converted module by module rather than in one pass — a single mechanical diff across
  // money and payroll is one nobody could review honestly. Workforce went first because it
  // is the 🔒 module, then the ⚖ set, then the floor, then the desks, then core.
  //
  // A file appears here once its queries carry the predicate, and then cannot regress. Two
  // tables are permanently outside it and say so at the call site: `aql_tables` (the ISO
  // 2859-1 sampling plans, identical for every factory on earth) and `users` (a person can
  // belong to more than one). Both are REFUSED by `scoped()` at compile time rather than
  // being a judgement somebody has to remember.
  //
  // Test fixtures are outside it too: a suite asserting cross-tenant isolation has to be
  // able to look at both companies.
  {
    files: [
      'src/modules/workforce/service.ts',
      'src/modules/workforce/queries.ts',
      'src/modules/commercial/service.ts',
      'src/modules/commercial/queries.ts',
      'src/modules/commercial/ud-queries.ts',
      'src/modules/finance/service.ts',
      'src/modules/finance/queries.ts',
      'src/modules/approvals/service.ts',
      'src/modules/approvals/queries.ts',
      'src/modules/store/service.ts',
      'src/modules/store/queries.ts',
      'src/modules/production/service.ts',
      'src/modules/production/queries.ts',
      'src/modules/cutting/service.ts',
      'src/modules/cutting/queries.ts',
      'src/modules/sampling/service.ts',
      'src/modules/sampling/queries.ts',
      'src/modules/quality/service.ts',
      'src/modules/quality/queries.ts',
      'src/modules/orders/service.ts',
      'src/modules/orders/queries.ts',
      'src/modules/shipment/service.ts',
      'src/modules/shipment/queries.ts',
      'src/modules/procurement/service.ts',
      'src/modules/procurement/queries.ts',
      'src/modules/maintenance/service.ts',
      'src/modules/maintenance/queries.ts',
      'src/modules/rfq/service.ts',
      'src/modules/rfq/queries.ts',
      'src/modules/planning/service.ts',
      'src/modules/planning/queries.ts',
      'src/modules/buyers/service.ts',
      'src/modules/buyers/queries.ts',
      'src/modules/costing/service.ts',
      'src/modules/costing/queries.ts',
      'src/modules/compliance/service.ts',
      'src/modules/compliance/queries.ts',
      'src/modules/memory/service.ts',
      'src/modules/memory/queries.ts',
      // BullMQ processors query too, and they run on a SystemCtx with no request behind
      // them — the one context where a missing scope has nobody to notice it.
      'src/modules/quality/jobs.ts',
      'src/modules/orders/jobs.ts',
      'src/modules/memory/jobs.ts',
      'src/modules/commercial/jobs.ts',
      // Core's own query surface. Named file by file like every other module rather than by
      // glob: `__tests__` legitimately queries unscoped — a fixture asserting cross-tenant
      // isolation has to be able to look at both companies.
      'src/modules/core/pending-changes.ts',
      'src/modules/core/documents.ts',
      'src/modules/core/notifications.ts',
      'src/modules/core/delivery.ts',
      'src/modules/core/offline-sync.ts',
      'src/modules/core/job-runs.ts',
      // Seed scripts run on a direct connection, which in production may carry BYPASSRLS —
      // the exact case where the predicate in the SQL is the only wall left. The kit's
      // document numbers exist in more than one tenant, so an unscoped read here picked
      // the wrong tenant's rows.
      'scripts/seed-kit-materials.ts',
      'scripts/seed-running-factory.ts',
    ],
    rules: { 'fabricxai/require-tenant-predicate': 'error' },
  },

  // ── CLAUDE.md rule 3 · confidence is measured, never typed ────────────────
  //
  // "Confidence is per-field and comes from the extractor — constants are forbidden" had
  // one runtime check behind it, and that check only catches every field scoring the SAME
  // (`assertExtractionConfidence`). Eight modules defeated it with varied per-field
  // constants — `qtyDelta: 0.62`, the same 0.62 on every draft forever — which look more
  // like measurement than a flat 0.8 does, and which drove inbox order, the auto-approve
  // floor and the correction-rate report (audit AI-B2).
  //
  // Repo-wide from the start, not a ratchet: unlike the tenant predicate there was nothing
  // to convert. The eight sites are deleted, and computed confidence — the mock provider's
  // match-quality table, memory's `seededLineConfidence` — was never the target.
  //
  // Tests and seeds are exempt. A fixture's job is to BE a plausible extraction result, and
  // the seeded approve inbox needs a confidence spread or it demonstrates nothing.
  {
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['**/__tests__/**', 'src/db/seed/**'],
    rules: { 'fabricxai/no-invented-confidence': 'error' },
  },

  // ── CLAUDE.md rule 9 · analytics is read-only ─────────────────────────────
  //
  // Scoped to what the module SHIPS. Its integration tests have to seed the rows the
  // dashboard then reads — an analytics test that could not write could not test anything —
  // and the guarantee rule 9 makes is about the code that runs in production, not about the
  // fixtures that prove it works.
  {
    files: ['src/modules/analytics/**/*.ts'],
    ignores: ['src/modules/analytics/__tests__/**'],
    rules: { 'fabricxai/analytics-no-writes': 'error' },
  },

  // ── CLAUDE.md rule 1 · actions, routes and components never touch `db` ────
  //
  // The glob used to be `src/app/actions/**` + `src/app/api/**`, which between them held
  // one real file: the sixteen `'use server'` action files live at `src/modules/*/
  // actions.ts` and were never covered (audit BE-H1). Nor was `src/components/`, and that
  // is not hypothetical — the top-bar search shipped as a server action in
  // `src/components/shell/search/` querying six modules' raw schemas, which is exactly
  // what this rule exists to stop, from the one directory nobody had pointed it at.
  {
    files: [
      'src/app/actions/**/*.ts',
      'src/app/api/**/*.ts',
      'src/modules/*/actions.ts',
      'src/components/**/*.{ts,tsx}',
    ],
    ignores: [
      // Better Auth owns its own boundary.
      //
      // `src/app/api/health/**` used to be here too, and the audit noted that the exemption
      // compounded the problem beside it: the route allowed to query the database directly
      // was also the one printing raw exception strings to the internet. Plan 7.5 moved those
      // queries into `modules/core/probes.ts`, where every other module's live, and the
      // exemption went with them — three health routes would have meant widening it to three.
      'src/app/api/auth/**',
    ],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@/db/client',
              message:
                'Actions, route handlers and components are thin: auth → zod → service. All db access lives in modules/<m>/service.ts (CLAUDE.md rule 1).',
            },
          ],
          patterns: [
            {
              // Reaching a table directly is the same violation one level down, and it is
              // the shape both real breaches took: search imported six modules' schemas,
              // and shipment/actions.ts dynamically imported drizzle and its own. Cross-
              // module reads go through the owner's queries.ts (rule 11).
              group: ['@/modules/*/schema', '**/schema', 'drizzle-orm'],
              message:
                'Do not query tables from an action, route or component. Read through the owning module\'s queries.ts (CLAUDE.md rules 1 and 11).',
            },
          ],
        },
      ],
    },
  },

  // k6 scenarios run inside k6's own runtime, not Node: `__ENV`, `__VU` and `__ITER` are
  // injected by it. Declaring them keeps `no-undef` doing its job here rather than being
  // switched off for the whole directory.
  {
    files: ['k6/**/*.js'],
    languageOptions: {
      globals: { __ENV: 'readonly', __VU: 'readonly', __ITER: 'readonly' },
    },
  },

  // Tests reach into fixtures and raw SQL on purpose.
  {
    files: ['**/__tests__/**/*.ts', 'eslint-rules/**/*.js', 'scripts/**/*.mjs'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'fabricxai/no-float-money': 'off',
    },
  },
)
