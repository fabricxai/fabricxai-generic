# FabricXAI — Full-Stack Deployment-Readiness Audit

**Date:** 2026-08-03 · **Scope:** backend + database + frontend + AI layer + infra/ops + tests, checked against the design pack (`docs/01-design/`, 27 canvases) and the project's own rules (`CLAUDE.md`, PLAYBOOK, dev-plan, briefs).
**Method:** six parallel deep audits (backend architecture rules, database, frontend-vs-design, infra/deployment, tests/quality gates, MARBIM AI layer) plus live runs of `pnpm typecheck`, `pnpm lint`, `pnpm test` (all green: 698 unit tests pass).

> Use this file as the fix tracker: each finding has a checkbox, an ID, evidence, and a suggested fix. Tick items as they are resolved and note the commit next to the ID.

---

## Verdict

**Not ready for a real factory deployment today.** The *engineering discipline* is unusually strong — strict types (zero `any` in the service layer), custom lint gates that actually run, real RLS with a non-bypass app role, a production-grade propose→approve→commit trust spine, honest STUBS ledger. What is missing is almost the entire *production half*: no deploy configuration, no backups, no observability, no real AI provider, no i18n for the Bangla-reading floor, and a handful of latent bugs that only manifest in production (Redis connection leak, auto-approve NOT NULL crash, S3 presign endpoint unreachable from tablets).

### The shortest path to a defensible single-factory pilot
1. **Tenancy actually holding:** DB-B1 (owner-role/RLS privilege model + non-superuser CI job), BE-B1 (boot assertion on the connection role + second-wall predicates), DB-H1 (compose full-profile runs as superuser), DB-H2 (`invitations` has no RLS), BE-H4 (`/api/sync` has no role check — any member can draw a UD or open the PP gate)
2. **Things that crash or die in production:** INFRA-B1 (Redis leak — pilot down in ~2 days), BE-B4 (worker never loads the module registry), AI-H2 (auto-approve NOT NULL crash), INFRA-B6/BE-M5 (renderPdf queue with no worker), DB-H3 (partition repair path can't work)
3. **Production half of the stack:** INFRA-B2 (prod compose+TLS+deploy), INFRA-B3/DB-B2 (backups + a rehearsed restore), INFRA-B4 (PgBouncer scram), INFRA-B5 (Sentry/structured logs), INFRA-H1 (S3 public endpoint — uploads fail from any tablet), INFRA-H5 (migrations in deploy), INFRA-H6/H7 (headers, rate limits)
4. **The floor can actually use it:** FE-B1 (Bangla i18n — floor staff cannot read the screens), FE-B3 (zero error/loading boundaries), FE-H5 (4 floor screens bypass offline sync), BE-B6 (orders/rfq/planning/production have no write surface; k6 can't even run), FE-B2/FE-B4 (flagship TNA and buyers UIs are read-only)
5. **Money & law:** BE-B3 (`Number.parseFloat` bypasses the money lint — sits in FOB pricing and the BTB limit decision), BE-B2/BE-B5 (unaudited `grns` write; `lcs` not audited on create), BE-H2 (LC latest-shipment gate never enforced), INFRA-H2 (UTC "today" wrong for the whole night shift at a UTC+6 factory)
6. **AI: decide, then do:** either feature-flag MARBIM off for the pilot, or AI-B2 → AI-B1 → AI-B3 in that order (computed confidence before a real provider before the tool loop)
7. **Trust but verify:** TEST-B1 (approve inbox has zero tests), TEST-B3 (payroll has no cross-company test), DB-H4 (the seed's "isolation check" proves the opposite of its claim)
8. **Process:** PROC-1/BE-B7 (`docs/handoffs/` is empty — back-fill contracts for the pilot modules), PROC-2 (commit the untracked frontend + 3 migrations)

---

## Fix log

**2026-08-03 (same day as the audit)** — Sprint 1 complete, plus the isolated Sprint-2/3 items:

| Finding | Commit | Note |
|---|---|---|
| INFRA-B1 Redis leak | `076d151` | singleton in all envs; worker shutdown closes the real client |
| BE-B4 worker registry | `74c662c` | registry imported + boot assertion; `unknown_module` now retryable |
| AI-H2 auto-approve crash | `71f3d60` | SystemCtx path in approve(); 2 new integration tests (9c/9d) |
| INFRA-B6 / BE-M5 renderPdf | `d48725e` | routes removed; boot asserts every routed queue has a worker |
| DB-H1 compose superuser | `f8aa247` | app role in compose; app+worker refuse SUPERUSER/BYPASSRLS connections (also BE-B1's runtime half) |
| BE-B2 unaudited grns write | `c50a6f8` | store owns `setGrnInspectionStatus`; quality calls it |
| INFRA-H3 localhost appUrl | `7c3518e` | delivery default reads APP_URL |
| DB-B1 owner privilege model | `c76a75f` | **partial**: decision recorded + enforced at provisioning (owner must BYPASSRLS); the non-superuser-owner CI job is still owed |
| DB-H4 seed isolation check | `e08dda9` | real app-role sweep across all 134 RLS tables on every seed |
| DB-H2 invitations RLS | `410bf50` | migration 0069: FORCE RLS deny-all until X.3 |
| BE-B3 Number.parseFloat hole | `7674da6` | rule extended; FOB/BTB/UD/DHU/OT sites exact; keypad sites carry reasoned disables |
| BE-H4 /api/sync roles | `eaa20f0` | roles required per handler; refusal non-terminal; +1 integration test |
| TEST-B3 payroll tenancy | `b33cb4c` | 4-test cross-company block |
| INFRA-H6 security headers | `76afd5d` | CSP/HSTS/XFO/nosniff/Referrer/Permissions in next.config |

**Second batch, same day** — Sprint 3 (production infrastructure) and the start of Sprint 4:

| Finding | Commit | Note |
|---|---|---|
| INFRA-B4 PgBouncer plaintext auth | `d0a3b9a` | migration 0070: scram + `auth_query` via a NOINHERIT lookup role; refuses superusers and itself; provisioning verifies both directions |
| INFRA-B2 no prod deploy config | `9ded55a` | `docker-compose.prod.yml` + Caddyfile + `.env.production.example`; Caddy holds the only published ports; migrate runs to completion before app/worker |
| INFRA-H1 S3 presign unreachable | `9ded55a` | `S3_PUBLIC_ENDPOINT` + a separate signing client; Caddy proxies `/s3/*` preserving the path SigV4 covers |
| INFRA-H4 worker PID-1 / healthcheck | `9ded55a`, `8a5de28` | dumb-init entrypoint, `healthcheck: disable` on the worker, 60s start-period, `unhandledRejection`/`uncaughtException` handlers |
| INFRA-H5 no migration step in deploy | `9ded55a` | one-shot `migrate` service; app/worker gated on `service_completed_successfully` |
| INFRA-M6/M9/M11 image + Redis + bucket hardening | `9ded55a` | read-only rootfs, `cap_drop: ALL`, memory limits; Redis AOF/noeviction/requirepass; bucket private **and versioned** |
| INFRA-B3 / DB-B2 no backups or restore | `445e4be`, `e0e560b`, _this change_ | pgBackRest to an offsite AES-256 repo — full Sunday / **differential** the other six nights, WAL archived continuously with a forced 5-minute switch; documents synced to offsite object storage **every 15 minutes** (rclone, displaced objects kept under `_replaced/`); `scripts/restore-verify.sh` performs a **real restore into a throwaway instance every Monday** and posts backup age, WAL lag and restore-vs-RTO to monitoring; `scripts/export-tenant.ts` for single-tenant extraction; `RESTORE-RUNBOOK.md` drill + `restore.md` incident procedure — **rehearsal log still empty** |
| INFRA-M7 / TEST-M10 / TEST-L12 CI gaps | `91257ff` | job timeouts, `--max-warnings=0`, `pnpm audit --prod`, gitleaks over full history, trivy on the image, a boot-refusal check, and `:latest` tags pinned |
| INFRA-H7 no rate limiting | `32d19f7` | Redis token buckets on auth/sync/presign; Better Auth on the same Redis; **fails open** so a Redis blip cannot stop a floor recording production |
| INFRA-L3 implicit cookie flags | `32d19f7` | `useSecureCookies` pinned to production |
| INFRA-B5 observability | `8a5de28` | pino structured JSON (redacting wages, prices, LC values) + Sentry wired with replay and PII off; **SENTRY_DSN is now optional** rather than required-and-ignored |
| INFRA-H8 three unused LLM keys required | `8a5de28` | `MARBIM_ENABLED` flag; enabling needs ONE provider key. Mail now needs SMTP **or** Resend, not Resend specifically |
| FE-B3 no route boundaries | `64bd3ff` | error/loading/not-found per group + `global-error`; app boundary resolves thrown AppError keys; board retries itself with no button |
| FE-B1 i18n mechanism | `7e1afb3` | `i18n-ui` catalogue bound to the existing resolver, `requestLocale`, `useT`; parity/blank/orphan/Bengali-script tests |
| FE-B1 floor routes (7 of 12) | `14f8b52`, `af06b48` | store (receive, overview, issue, rolls) + cutting (queue, lay, report, wastage); verified rendering Bangla against a running server |
| PROC-3 stale trackers | `00cc18d` | PROGRESS rewritten to all 23 modules with per-module state; STUBS corrected in both directions |

**Third batch, same day** — the rest of Sprint 4 plus two items pulled forward:

| Finding | Commit | Note |
|---|---|---|
| FE-B1 floor routes (10 of 12) | `0c62d1b` | lines (queue, hourly, endline) + the TV board; and the shared `fx/floor.tsx` sync pill, which every converted screen was still showing in English |
| FE-M5 no language picker | `d2e6164` | the switch, in the account menu, per device — without it every translated string was gated behind the browser's `Accept-Language` |
| FE-H1 no password recovery | `566483e` | reset email, one-hour single-use token, `/forgot-password` + `/reset-password`; enumeration-safe. Verified end to end through Mailpit |
| DB-M4 unindexed cascade FKs | `24d0e52` | 24 indexes; the notification bell went from Seq Scan + Sort to a bare Index Scan (EXPLAIN before/after) |
| DB-M1 (pruning half), DB-M2 unbounded worker tables | `67c8589` | definer prunes for the outbox and dedupe ledger, nightly; verified in a rolled-back transaction that an unpublished event survives a cutoff of now() |
| FE-B1 floor routes (12 of 12) | `397eb6a`, `dfcda25` | quality ×5 and the Bangla error copy the floor reads |

Also fixed in passing, each surfaced by the conversion rather than the audit: a lay badge comparing against a `'closed'` status absent from the enum, so every finished lay looked unfinished; a no-op ternary that was the only consumer of a prop that was in turn the only consumer of an `activeLines()` query, i.e. a database round trip per floor page load feeding nothing; and the refused-writes banner rendering a raw i18n key at the operator.

**Fourth batch, 2026-08-06 → 08-07** — `docs/PRODUCTION-READINESS-PLAN.md`, phases 0–8 complete. That file is the live tracker and carries the reasoning per item; this is the index.

| Findings | Where | Note |
|---|---|---|
| N1 action roles, N2 auth-table RLS, BE-B1 | phases 0–1 | 69 role gates across 16 action files; migration `0073` scope-conditional policies on the five auth tables; **wall 1 now covers every module, every query file and core** — 49 files on the `require-tenant-predicate` ratchet, with `two-walls.integration.test.ts` proving the two walls fail independently |
| BE-H1/H2/H3, BE-M3, BE-M8, INFRA-H2 | phase 2 | money, dates, audit, gates; `lib/dates.ts` real and the UTC ban lint-enforced; **the CM component was computing as ZERO on every sheet priced in taka** (fx rate read at scale 2 against a `numeric(12,6)` column) — found by 2.9's consolidation, fixed, pinned |
| TEST-B1, TEST-H4 | phase 3 | 29 commit targets covered both directions; the approve funnel every ⚖ write passes through |
| FE-H6, FE-S* | phases 4–5 | floor completion, tablet structure, and the desk write surfaces |
| AI-B1/B2/B3, AI-H3–H7, AI-M1/M3/M4/M5 | phase 6 | MARBIM: a real off-switch, the false grounding claims removed, invented confidence deleted and lint-banned, three providers by role with confidence derived from logprobs, the execution loop with role-filtered tools, and the pipeline hardened |
| TEST-B2, TEST-H5, TEST-H8, TEST-M10, INFRA-M1, INFRA-M13 | phase 7 | k6 harness with committed baselines and the row assertion automated; a jsdom project (no `.tsx` was reachable by any test before it) and Playwright + axe, which found three real WCAG defects on the floor screens; coverage ratchet and JUnit; the health endpoint split into liveness / readiness / jobs-behind-a-token |
| PROC-1, PROC-3, BE-B7 | phase 8 | eight retroactive HANDOFFs that say they are retroactive, checked against code by a test; and a drift check so the trackers cannot silently rot |

### Still open

Reconciled 2026-08-07. Every finding this file's Fix log records as complete is now ticked below — twenty-eight were not, which is the inconsistency `docs/__tests__/tracker-drift.test.ts` now fails on. Findings that are PARTLY done carry a ◐ marker with what remains, because a half-closed finding that reads as closed is the thing this reconciliation exists to stop.

**Genuinely open, and none of it is code:**

- **INFRA-B3 / DB-B2** — the layer is now complete and self-checking: offsite encrypted
  repo, real WAL archiving (the `archive_command` was `true` — a command that succeeds
  without archiving anything, which made every prior backup restorable only to the
  instant it ended), a 15-minute document RPO to match the database's, and a weekly
  automated restore that proves it. What is **still open is the human drill**: nobody has
  built a host from these backups, and the credential hunt inside the 4h RTO has never
  been timed. `RESTORE-RUNBOOK.md` §3 is the procedure; §8 is the log, and it is empty.
  A backup nobody has restored is a belief — an automated restore narrows that, it does
  not close it.
- **Deployment wiring** — point the prod compose healthcheck and Caddy's upstream at `/api/ready` (7.5 built it; nothing consumes it), set `HEALTH_TOKEN`, finish the S3 proxy and the CI deploy job. Deliberately outside the plan's scope, and listed in its header.
- **Payroll has never been parallel-run.** `pnpm payroll:parallel-run` is built and proven end to end; it needs a real gazette, a real month of attendance and the factory's own sheet. Non-negotiable before go-live.
- **MARBIM has never called a live model.** Three vendors and the execution loop are wired; no key exists in this environment, so the SDK bodies and the multi-tool round trip are unproven. All fail loudly, so the risk is a dead feature rather than a wrong number.
- **The k6 baselines are from a developer machine** and say so in their own `host.note`. The brief's gate is VPS-class hardware.
- **Tablet legibility** — axe checks contrast and names at 768px; whether a column is readable in Bangla at arm's length needs a person holding one.

**Carried as ratchets** (mechanism in place, adoption ongoing, each in the plan): typed action results (BE-H3), ten more money files (BE-M8), thirteen unwired actions, the settings policy editor, and `mixed_day`.

## Severity index

| Severity | Meaning |
|---|---|
| **BLOCKER** | Will break the pilot, lose data, or make a core promise false. Do before any real factory data. |
| **HIGH** | Will hurt in week one, or is a rule/contract violation with real consequence. |
| **MEDIUM** | Deploy-adjacent debt; schedule before or shortly after pilot. |
| **LOW** | Hygiene, drift, docs. |

---

## 1 · Infrastructure, deployment & operations

### Blockers

- [x] **INFRA-B1 · Production Redis connection leak — pilot dies in ~2 days.**
  `src/lib/redis.ts:8-15` caches the ioredis client only when `NODE_ENV !== 'production'`; in prod every `getRedis()` call opens a new socket that is never closed. `/api/health` (`src/app/api/health/route.ts:134`) is polled by Docker HEALTHCHECK every 30s → ≈5,700 leaked connections/day → Redis `maxclients` (10k) exhausted → BullMQ cannot connect, job system dies. Same bug breaks worker shutdown (`src/worker/index.ts:36` vs `:101` disconnect a *different* client).
  **Fix:** module-level singleton in all environments (keep `globalThis` only as the dev-HMR guard); disconnect the captured instance in shutdown.

- [x] **INFRA-B2 · No production deployment configuration exists at all.**
  Only `docker-compose.dev.yml`. No prod compose, no Caddy/nginx/TLS, no restart policies, no resource limits, no deploy job (`.github/workflows/ci.yml:188-202` builds with `push: false` and stops). The dev-plan explicitly requires all of this (`docs/02-backend/fabricxai-backend-dev-plan.md:116, :32, :35, :118`). `docs/07-rollout/rollout-playbook.md` has zero deployment content.
  **Fix:** `docker-compose.prod.yml` (app + worker + pg + pgbouncer + redis + minio + caddy; `restart: unless-stopped`; memory limits; DB/Redis/MinIO ports not published), Caddyfile with automatic TLS, deploy workflow (build → push GHCR by digest → SSH `compose pull && up -d`).

- [ ] **INFRA-B3 · No backups, no restore path, no DR — against a doc that calls it non-negotiable.**  ◐ **partly done** — the backup layer is built, wired and weekly-verified (see the fixed table above); the **human DR drill on a scratch host has never been executed**, which is the half that proves a person can rebuild this, not just that the bytes are readable.
  dev-plan:34 ("pgBackRest → offsite — non-negotiable before first real factory data"), :192 (RTO ≤4h / RPO ≤15min), :216 (four required runbooks). Reality: `docs/runbooks/` holds one file (`phase-0-exit.md`); no backup script, no WAL archiving, no MinIO replication.
  **Fix:** pgBackRest/wal-g sidecar with offsite repo + WAL archiving; `mc mirror` for MinIO; a `restore-from-backup.md` runbook **executed once against a scratch host** before pilot data lands.

- [x] **INFRA-B4 · PgBouncer ships plaintext password auth; stub deadline was "before first deploy".**
  `docker/pgbouncer/pgbouncer.ini:15-16` (`auth_type = plain` + cleartext `userlist.txt`). Only pgbouncer config in the repo. `docs/STUBS.md` names the exact replacement.
  **Fix:** `scram-sha-256` with `auth_user` + `auth_query` (SECURITY DEFINER lookup fn); remove `userlist.txt` from the prod path.

- [x] **INFRA-B5 · Observability is `console.log`; `SENTRY_DSN` is required in prod but nothing reads it.**
  `src/lib/env.ts:69-85` hard-fails prod boot without `SENTRY_DSN`; `@sentry/nextjs` is not a dependency; `src/instrumentation.ts:4` promises the init that never landed. 34 unstructured `console.*` calls are the whole log strategy.
  **Fix:** install + init Sentry (app `instrumentation.ts` + worker), add pino structured JSON logging with `companyId`/`jobId`/`requestId`; or drop `SENTRY_DSN` from prod-required until wired (don't fail boot on dead config).

- [x] **INFRA-B6 · Two outbox routes target a BullMQ queue with no worker — jobs queue forever, Redis grows unbounded.**
  `src/worker/processors/outbox-relay.ts:79-80` routes `procurement.po.issued` and `shipment.packing_list.approved` to `QUEUE.renderPdf`; `src/worker/index.ts:46-79` starts workers only for `schedule`/`derive`/`notify`. `lib/pdf.ts` is a 13-line stub. With `noeviction` Redis eventually refuses writes. `QUEUE.extract`/`email`/`export` also declared and unconsumed.
  **Fix:** reroute or drop those prefixes until the PDF pipeline exists; add a startup assertion that every `QUEUE_ROUTES` target has a registered worker.

### High

- [x] **INFRA-H1 · Single `S3_ENDPOINT` — presigned URLs unreachable from tablets in prod.**
  `src/lib/s3.ts:14-22` signs presigns with the server-side endpoint (`http://minio:9000` in compose); SigV4 covers the Host header so the browser cannot be redirected. Every upload/download fails in production.
  **Fix:** add `S3_PUBLIC_ENDPOINT` (browser-facing, TLS via Caddy) for presigning; keep `S3_ENDPOINT` server-side; set bucket CORS allowlist.

- [x] **INFRA-H2 · 85 call sites compute "today" in UTC for a UTC+6 factory; `lib/dates.ts` is still a stub.**
  `src/lib/dates.ts` exports only `FACTORY_TIMEZONE`. 85 non-test `toISOString().slice(0, 10)` occurrences (e.g. `src/modules/quality/queries.ts:474`, `quality/jobs.ts:35`, `procurement/queries.ts:60`, `finance/queries.ts:63`). Between 00:00–05:59 Dhaka — the night shift and every nightly cron — UTC "today" is *yesterday*. The correct helper is copy-pasted privately in 4 places (`commercial/service.ts:58`, `worker/processors/consumers.ts:475`, `commercial/jobs.ts:43`, `scheduler.ts:329`).
  **Fix:** implement `lib/dates.ts` (`factoryToday`, `toFactoryDate`, `startOfFactoryDay`), delete the 4 duplicates, migrate the 85 sites, add an ESLint ban on bare `toISOString().slice(0,10)` in `src/modules`.

- [x] **INFRA-H3 · Every notification email deep-links to `http://localhost:3000`.**
  `src/modules/settings/policies.ts:357` is the delivery-policy default consumed by `src/modules/core/delivery.ts:123-127`; no Settings surface exists to change it.
  **Fix:** default `appUrl` to `env.APP_URL`; keep the settings override optional.

- [x] **INFRA-H4 · Worker has no production process story.**
  `worker:start` runs `tsx` (a devDependency) as PID 1 with no init → SIGTERM not reliably forwarded → the (correct) graceful drain never runs; deploys hard-kill in-flight jobs. The image-level HEALTHCHECK (`Dockerfile:59-60`) hits `:3000/api/health`, which the worker doesn't serve → permanently `unhealthy`. No `unhandledRejection` handlers anywhere.
  **Fix:** dumb-init entrypoint; compile the worker or run tsx under init; `HEALTHCHECK NONE` for the worker + a Redis heartbeat the app health endpoint reads; `unhandledRejection` → log + exit non-zero so restart policy fires.

- [x] **INFRA-H5 · No migration step in any deploy path.**
  `src/db/migrate.ts` is correct but nothing invokes it outside CI; no ordering doc, no boot gate against a stale schema (69 migrations incl. RLS + SECURITY DEFINER).
  **Fix:** deploy step `docker compose run --rm app tsx src/db/migrate.ts && pnpm db:setup-roles` (or one-shot migrate service) + boot-time assertion that the newest journal entry is applied.

- [x] **INFRA-H6 · No security headers whatsoever.**
  `next.config.ts:10-20` has no `headers()`, no `poweredByHeader: false`; zero hits repo-wide for CSP/HSTS/X-Frame-Options/Referrer-Policy.
  **Fix:** CSP (nonce), HSTS, `X-Frame-Options: DENY`, `nosniff`, Referrer-Policy, Permissions-Policy; `poweredByHeader: false`.

- [x] **INFRA-H7 · No rate limiting on auth, sync, or upload endpoints.**
  Better Auth has no `rateLimit` block (`src/lib/auth.ts:34-111`) → in-memory defaults, not shared, reset on deploy; nothing throttles sign-in guessing or mass-signup (each signup runs `provisionCompany`). `/api/sync` (`route.ts:43-87`) and `/api/documents` presign issuance are unthrottled. README/.env.example claim Redis rate limits that don't exist.
  **Fix:** Better Auth `rateLimit` with Redis secondaryStorage; Redis token-bucket on `/api/sync`, `/api/documents`, auth routes keyed user+IP.

- [x] **INFRA-H8 · Prod boot demands three LLM API keys that nothing consumes.**
  `env.ts:69-85` requires `ANTHROPIC_API_KEY` + `GEMINI_API_KEY` + `OPENAI_API_KEY` in production and forbids `MARBIM_MOCK`, yet no real provider is registered (see AI-B1) — you must configure three vendors to satisfy a Zod check and still get a hard failure when MARBIM is touched.
  **Fix:** require at least one key behind a `MARBIM_ENABLED` flag; register a real provider or degrade gracefully.

### Medium

- [x] **INFRA-M1** `/api/health` unauthenticated and leaks internals (env, raw exception strings, task names) — `route.ts:117,141-150`. Split public 200/503 vs detail behind a token.
- [ ] **INFRA-M2** Health check omits MinIO and SMTP (`route.ts:132-136`). Add S3 HeadBucket + mail reachability.
- [ ] **INFRA-M3** Stale BullMQ job schedulers never pruned (`scheduler.ts:308-320` upsert-only). Remove ids not in `SCHEDULED_TASKS`.
- [ ] **INFRA-M4** Unbounded request bodies on route handlers (`bodySizeLimit: '4mb'` covers server actions only; `/api/sync` buffers with no ceiling). Enforce Content-Length at proxy + handler.
- [ ] **INFRA-M5** No dead-letter story: failed jobs deleted after 7 days (`queues.ts:41-47`); outbox parks at 10 attempts with no alert (`outbox-relay.ts:29,108`). DLQ or `failed_jobs` table + the `requeue-failed-jobs` runbook.
- [x] **INFRA-M6** Fat unhardened image: no `output: 'standalone'`, runtime carries devDeps + `src/`; no read-only FS/cap_drop/memory limits.
- [x] **INFRA-M7** CI: no `pnpm audit`, no image scan (Trivy), no gitleaks; `minio`/`mc`/`mailpit` float on `:latest` in compose and CI. Pin digests, add scans.
- [ ] **INFRA-M8** k6 never run and not in CI; only 1 of the planned scenarios exists (see TEST-H5).
- [ ] **INFRA-M9** No production Redis config (AOF/noeviction only in dev compose; no `requirepass`/TLS).
- [x] **INFRA-M10** ⚠ Seed with public password `FabricXai-seed-2026` + `emailVerified: true` guarded by a single `NODE_ENV` check (`src/db/seed/core-slice.ts:31,57,72,90`). One careless `pnpm seed` against prod = breach. Refuse non-localhost targets or require an explicit override flag.
- [ ] **INFRA-M11** MinIO bucket bootstrap is dev/CI-only; no prod init, versioning, lifecycle, or replication.
- [ ] **INFRA-M12** `documents.status = 'quarantined'` is checked on download (`documents.ts:207`) but nothing ever sets it — no AV scan on 25 MB uploads from shared floor tablets. ClamAV job or document the accepted risk.
- [x] **INFRA-M13** One health endpoint conflates liveness/readiness/job-health: a quiet scheduler 503s the app probe and Docker restarts the wrong container. Split `/api/health` (liveness) vs `/api/ready` (deps) vs `/api/health/jobs`.

### Low

- [ ] **INFRA-L1** README claims testcontainers for `test:integration` — false (requires externally running services); README status section badly stale ("No business modules yet" vs ~20 modules).
- [ ] **INFRA-L2** `.env.example` missing `MAILPIT_URL`, `INTEGRATION_PORT`, `DEMO_COMPANY_ID`/`DEMO_USER_ID`, future `S3_PUBLIC_ENDPOINT`; no note that `APP_URL`/`BETTER_AUTH_URL` must be `https://` in prod (silently controls secure cookies).
- [x] **INFRA-L3** Better Auth cookie flags all implicit — pin `useSecureCookies: isProduction` explicitly (`src/lib/auth.ts:54-59`).
- [ ] **INFRA-L4** `HEALTHCHECK --start-period=20s` too optimistic for cold Next 16 boot; use 60s.
- [ ] **INFRA-L5** `scheduler.ts:344-352` reads `companies` through the app role with no tenant scope — under RLS returns 0 rows and silently falls back to `new Date()`, so a never-run task always looks brand-new to job-health.

---

## 2 · Database layer

**Measured baseline:** 144 tables · 136 tenant tables with FORCE RLS + a `company_id = app.current_company_id()` policy · 398 FKs · 0 float/real columns anywhere · 69/69 migrations consistent with the journal, none ever edited after commit.

### Blockers

- [x] **DB-B1 · The entire RLS design silently requires the migration/owner role to be SUPERUSER or BYPASSRLS — and the migration comment asserts the opposite.**
  `0002_rls_policies.sql:40` claims FORCE RLS "does not lock the migration runner out of its own tables" — false: FORCE applies RLS to the table owner, and every policy in the schema targets only `fabricxai_app` (verified: zero policies for any other role). Eight SECURITY DEFINER functions run as the owner and read forced tables (`app.memberships_for_user` → `roles`; `app.lock_outbox_batch`/`mark_outbox_published` → `outbox`; `app.scheduler_last_success`/`scheduler_observed_since` → `job_runs`; partition helper). If ops hardens the owner to non-superuser (the standard move, and what `scripts/setup-db-roles.mjs` implies): **login breaks for everyone** (memberships → 0 rows), **outbox delivery stops silently**, health reports the scheduler never ran, seed reads nothing. It only works today because dev/CI owner is the initdb superuser — so CI cannot catch it.
  **Fix:** decide + document the owner privilege model — either grant `BYPASSRLS` explicitly in `setup-db-roles.mjs` and correct `0002:40`, or add owner-scoped policies. Then add a CI job running the suite with a non-superuser, non-BYPASSRLS owner.

- [ ] **DB-B2 · No backup or restore story at all** (same as INFRA-B3, confirmed independently from the DB side: no pgBackRest/pg_dump/WAL archiving; `docs/runbooks/` has one file; `userlist.txt` even points at a runbook that doesn't exist; rollout playbook has zero hits for backup/restore/RTO/RPO). Payroll + LC + bonded-warehouse data cannot go live with undefined RPO/RTO.  ◐ **partly done** — same as INFRA-B3 — the human rehearsal is the open half. RPO is now *measured* rather than asserted: `restore-verify.sh` reads `pg_stat_archiver` weekly and fails if WAL lag exceeds twice the 15-minute budget.

### High

- [x] **DB-H1 · `--profile full` runs app AND worker as the owner/superuser — RLS entirely bypassed.**
  `docker-compose.dev.yml:150-151,174-175` set both URLs to `fabricxai:fabricxai` (the initdb superuser; superusers bypass RLS even with FORCE). Contradicts `.env.example`, the pgbouncer config, and the compose file's own comments.
  **Fix:** point at `fabricxai_app_rw` via pgbouncer; add a boot assertion in `instrumentation.ts`/`worker/index.ts` that the connected role has `rolsuper = false AND rolbypassrls = false` and that `DATABASE_URL` username ≠ `DIRECT_DATABASE_URL` username.

- [x] **DB-H2 · `invitations` is a tenant table with zero tenancy enforcement in either wall.**
  Only table with a company FK and no RLS (`0003_auth.sql:17-27`); column is `organization_id` so convention sweeps miss it; carries a `role` that mints `roles` rows on accept; queried by Better Auth on the pooled handle **outside** `withTenantTx`; has full DML grants. Any IDOR in invite-accept = cross-tenant privilege escalation with nothing behind it. (Note: a naive policy breaks auth since Better Auth sets no `SET LOCAL` — route through a scoped tx or a narrow SECURITY DEFINER token-lookup fn.) Add an integration test that company A cannot read/accept company B's invitation.

- [ ] **DB-H3 · The `hourly_outputs` DEFAULT-partition recovery path cannot work.**
  If the partition window lapses, rows land in DEFAULT (by design), but `app.ensure_hourly_output_partition` then **fails permanently** (Postgres refuses to create a range partition while matching rows sit in DEFAULT), and `production/jobs.ts:41-45` rolls all 13 months in one transaction so the first failure blocks every future month. Result: all writes land in DEFAULT forever; partition pruning gone on the highest-volume table. The `inDefault > 0` notification fires but no repair exists.
  **Fix:** teach the function to detach DEFAULT → create partition → move matching rows → re-attach; one transaction/savepoint per month in the job.

- [x] **DB-H4 · The seed's "wall 2" isolation assertion proves the opposite of its claim.**
  `src/db/seed/index.ts:200-217` runs on the **owner** connection with no scope and throws only if rows are *invisible* — it can never fail for a missing policy while claiming to be the wall-2 smoke test. Worse than no check: a green light labelled "verified".
  **Fix:** open a second client on the app-role URL with no `SET LOCAL` and assert `visible === 0`, per table across all 144 tables (would have caught DB-H2 immediately). Rename the current check `assertSeedWroteSomething`.

- [ ] **DB-H5 · Seed covers 14 of 23 modules; ~39 of 143 tables seeded.**
  Zero slices for buyers, rfq, orders, costing, memory, marbim, settings, analytics — and seeded slices depend on the unseeded ones (`commercial-slice.ts:109-111` selects `orders`, which only exist if `pnpm demo` ran first — an undeclared ordering). `pnpm seed` alone seeds against an empty order set and "succeeds" with near-zero rows (which DB-H4's broken assertion can't notice). The dev-plan's named edge rows (LC latest-shipment conflict, overdrawn UD, 38% line, negative-margin order) are unreachable.
  **Fix:** add the 8 slices; make `SLICES` declare dependencies and fail loudly on 0-row prerequisites; fold `scripts/demo.ts` creation into slices.

### Medium

- [x] **DB-M1** `processed_events`: no `company_id`, no RLS, app role can `DELETE` (any tenant can clear another's dedupe rows → event replay), never pruned. Add company_id + policy, revoke DELETE, nightly prune.
- [x] **DB-M2** `outbox` grows forever (published rows never deleted; app role deliberately lacks DELETE). Add `core.prune_outbox` (30 days, run as owner).
- [ ] **DB-M3** Migrations take no advisory lock despite two comments claiming they do (drizzle's postgres-js migrator uses a plain transaction). Two concurrent `db:migrate` in a rolling deploy race and break the deploy. Wrap in `pg_advisory_lock` in `src/db/migrate.ts`; fix both comments.
- [x] **DB-M4** Eleven `ON DELETE CASCADE` FKs with no covering child index — sharpest: `notifications(user_id)` is also the notification-bell read path and has no user-leading index (every bell load scans). Add `(company_id, user_id, created_at DESC)` + the other ten.
- [ ] **DB-M5** Partition DDL (ACCESS EXCLUSIVE on parent + DEFAULT scan) runs in one transaction at 00:30 Dhaka — mid night-shift; floor writes block. Per-month transactions, `lock_timeout`, move to a real trough.
- [ ] **DB-M6** `audit_log` append-only rests on a single GRANT — no trigger backstop, no test. One careless `GRANT ALL` makes the audit trail mutable silently. Add a `BEFORE UPDATE OR DELETE … RAISE EXCEPTION` trigger + an integration test that `UPDATE audit_log` fails as the app role.
- [ ] **DB-M7** pgvector: global HNSW index + tenant filter under-returns for small tenants (candidates fetched before the filter; default `ef_search` 40; nothing tunes it). `SET LOCAL hnsw.ef_search` in the search tx; consider per-company partial indexes.
- [ ] **DB-M8** 21 of 69 journal entries have no snapshot (hand-written migrations not generated with `--custom`), and the CI drift check diffs only `*.sql`, not `meta/*_snapshot.json`. Use `drizzle-kit generate --custom`; extend the CI diff.
- [ ] **DB-M9** AQL level is free text with no CHECK/FK linking `buyer_terms`/`final_inspections` to `aql_tables` — a typo ("II" vs "Level II") silently breaks the accept/reject lookup that decides whether a shipment ships. Constrain to the seeded Z1.4 value set.

### Low

- [ ] **DB-L1** `src/db/direct.ts` omits the `types.numeric` string override that `client.ts` has — every numeric on the owner connection (seed, demo) is a JS float, exactly where the lint rule can't fire. Copy the types block.
- [ ] **DB-L2** `pg_stat_statements` in the docker init but not in migration `0000` — a fresh prod DB provisioned by `db:migrate` alone lacks it, despite `0000`'s stated goal.
- [ ] **DB-L3** Migrations 0066–0068 + snapshots are untracked/uncommitted (no actual drift verified, but CI has never seen them). Commit them (part of PROC-2).
- [ ] **DB-L4** `meta/_journal.json` lost its trailing newline — spurious diff on next generate.
- [ ] **DB-L5** PgBouncer: no `server_lifetime`/`query_wait_timeout`; pool ceiling 30 vs pg `max_connections=100`; and the plaintext auth (INFRA-B4).
- [ ] **DB-L6** No `updated_at` triggers — ops-level UPDATEs leave it stale on ⚖ tables (`wage_gazettes`, `cost_sheets`, `policy_settings`).

---

## 3 · Frontend vs the design pack

**Design coverage summary:** 27 canvases; 56 app pages implemented; ✅ complete vs pack: LC Register, UD Workbench, Store, Cutting, Quality (exceeds), Approve Inbox, MARBIM surface, TV Board, Commercial Finance. Not started: Marketing Site, LinkedIn Catalog, Social Brand Kit canvases. `docs/PROGRESS.md` "Frontend merged" column is blank for all 23 modules — the frontend was built ahead of the tracked process. **The entire frontend tree (`src/app/(app)`, `(auth)`, `(board)`, `src/components/`) is untracked in git — never committed** (see PROC-2).

### Blockers

- [x] **FE-B1 · No UI i18n layer at all; ~500+ hardcoded English strings.**
  `next-intl` is not a dependency; `src/lib/i18n.ts` is notifications-only (709 lines, imported by exactly 1 of 115 `.tsx` files); `src/app/layout.tsx:46` hardcodes `lang="en"`. ~195 bare JSX text nodes + ~347 string-literal props. Violates CLAUDE.md ("no hardcoded UI strings") and frontend-dev-plan §3. **Floor staff read Bangla — they cannot use these screens.**
  **Fix:** add next-intl, `messages/en.json` + `messages/bn.json`, prioritize the 12 floor routes (`/store/*`, `/cutting/*`, `/lines/*`, `/quality/*`); add the CI grep for bare JSX literals the plan already specifies.

- [x] **FE-B2 · Flagship module 1.3 (Order Desk & TNA) cannot be operated from the UI.**
  `src/modules/orders/` has no `actions.ts`; `actualizeMilestone` is called only by the worker (`consumers.ts:259`); `MilestoneTimeline`'s `onActualize` prop (`src/components/fx/tna.tsx:67`) has no caller, and `tna.tsx` isn't a client component. A merchandiser cannot tick a milestone, record ex-factory, or upload a buyer revision.
  **Fix:** add `orders/actions.ts` (`actualizeMilestone`, `applyRevision`), make the timeline interactive, wire revision upload → diff → approve.

- [x] **FE-B3 · Zero route-level error/loading/not-found boundaries across all 56 routes.**
  `find src -name error.tsx -o -name loading.tsx -o -name not-found.tsx` → 0. No Suspense. `LoadingState`/`ErrorState` primitives exist (`fx/feedback.tsx:387,409`) and are used by nothing. Every page is `force-dynamic` with multiple awaited queries — one failed query = raw Next error screen.
  **Fix:** `error.tsx` + `loading.tsx` at the `(app)`, `(auth)`, `(board)` group roots minimum; `not-found.tsx` for the 8 dynamic routes.

- [x] **FE-B4 · Buyers module actions are completely orphaned.**
  `moveLeadStage`, `logLeadActivity`, `convertLeadToBuyer` exported by `src/modules/buyers/actions.ts`, imported by zero UI files. The pipeline is a static list; a won lead can never become a buyer.
  **Fix:** buyer detail (drawer or route) + 2-step convert dialog + drag-to-stage wiring.

### High

- [x] **FE-H1 · No password reset flow, no verification landing page.**
  `(auth)/` has only login + signup; `requireEmailVerification: true` but no `/verify-email`, `/reset-password`, `/forgot-password`, or resend action. A locked-out owner = a support call.
- [ ] **FE-H2 · Design-token scale defined but never used: 0 uses of `--fx-space-*`/`--fx-text-*` vs 812 raw px gaps/paddings and 620 hardcoded `font:` shorthands.** (Colour discipline is clean — 3 raw hex in 115 files.) The 1.4× Bengali string-length test has 620 places to break. Tokenize `fx/` components first.
- [ ] **FE-H3 · `src/app/theme.css` is a namespace fork of the design-system theme.** 0 shared variable names with `docs/01-design/theme.css`; the `--color-viz-1..7` chart palette has no equivalent in the app. Designers can't diff the app against the canvases; chart colour is undefined. Regenerate the design theme from the app theme (or alias layer) + port the viz palette.
- [ ] **FE-H4 · No charting library; every specified sparkline/trend is missing** (owner-dashboard KPI sparklines, DHU trend, efficiency curve, cash timeline, margin curve/waterfall, plan-vs-actual). Add Recharts + viz palette + a `Sparkline` primitive.
- [x] **FE-H5 · Four floor screens bypass the offline endpoint** and use plain server actions inside `<FloorScreen>`: `store/rolls` (`rolls-client.tsx:169`), `quality/fabric` (`fabric-client.tsx:67`), `quality/final` (`final-client.tsx:70`), `quality/measurements` (`measurements-client.tsx:65`). Dropped wifi = lost entry; retry = double write. Register sync handlers and switch to `capture()`. (9 of 13 floor screens already do this correctly.)
- [ ] **FE-H6 · No responsive handling anywhere:** one `@media` in 500 lines of CSS (`prefers-reduced-motion`), fixed 232px sidebar always rendered, fixed-fraction grids. A 768px-portrait floor tablet keeps 536px for numpad grids. Collapse sidebar under ~900px; audit floor routes at 768×1024 / 1024×768.  ◐ **partly done** — plan 4.4 + 7.2 — structural pass and a WCAG sweep done; a person still has to read a tablet.
- [ ] **FE-H7 · `DataTable` not virtualized; no TanStack Query/Virtual, no Playwright, no axe-core** — all named CI gates in frontend-dev-plan §1/§2/§7/§8. A pilot order book has thousands of PO lines.

### Missing screens vs build pack (each unticked item = build it or explicitly descope)

- [ ] **FE-S1** 1.1 Buyer & Lead Desk: buyer detail drawer, convert-to-buyer dialog, draggable pipeline (3 of 4 screens missing; read-only board).
- [ ] **FE-S2** 1.2 RFQ: RFQ detail page, extraction review split-view, win/loss dialog (no `rfq/actions.ts` at all — no quote entry from UI).
- [ ] **FE-S3** 1.3 Orders: cross-order TNA calendar; buyer revision upload flow.
- [ ] **FE-S4** 1.5 Costing: est-vs-actual waterfall; template library.
- [ ] **FE-S5** 1.6 Order Memory: similar-orders panel not embedded in `/rfq` and `/costing/bom` (lives only on its own page).
- [ ] **FE-S6** 3.2 Procurement: suppliers×items quote-comparison matrix; MARBIM PI-vs-PO discrepancy card.
- [ ] **FE-S7** 4.1 Planning: board is read-only (no drag, no `planning/actions.ts`); what-if scenario mode; plan-vs-actual.
- [ ] **FE-S8** 6.1 Line tracking: dedicated one-tap downtime screen (currently buried in hourly client).
- [ ] **FE-S9** 8.1 Shipment: packing-list review desk screen; B/L discrepancy card.
- [ ] **FE-S10** 9.1 Maintenance: machine detail drawer; nameplate-photo draft.
- [ ] **FE-S11** 10.1 Workforce: attendance-exceptions queue; payslip artifact (bn-first).
- [ ] **FE-S12** 10.2 Compliance: audit detail route (`/compliance/[auditId]`); MARBIM audit-report draft surface.
- [ ] **FE-S13** 11.2 Owner dashboard: KPI sparklines; MARBIM ask bar; phone-first variant.
- [ ] **FE-S14** X.3 Settings: users/roles matrix, module toggles, master-data managers, data export, audit log, localization picker (all absent; `settings-client.tsx:45` hardcodes `locale: 'en'`).
- [ ] **FE-S15** Marketing site / LinkedIn catalog / social brand kit canvases: not started (decide if in scope for pilot).

### Medium / Low

- [ ] **FE-M1** `/dev/components` gallery (plan §2 exit gate) doesn't exist; several named primitives missing (`SmartTable v2`, `CountdownChip`, `WorkflowStepper`, `NumpadInput`, `WeaveLoader`…).
- [ ] **FE-M2** `Drawer` primitive + route-driven `?drawer=` pattern unused (0 call sites) — pack specifies drawers for 1.1/1.4/9.1.
- [ ] **FE-M3** 10+ clients render raw `<input>`/`<select>` bypassing `fx/forms` `Field` (loses wired error/aria handling): `lcs/[lcId]`, `ud/[udId]`, `procurement/*`, `maintenance/*`, `costing/bom`, `quality/final`, `marbim/intake`, `store/receive`.
- [ ] **FE-M4** 26 raw `toLocaleDateString`/`toLocaleString` calls (plan forbids; ties into INFRA-H2 dates work).
- [x] **FE-M5** No language/digit toggle anywhere (`bengaliDigits` prop exists, nothing sets it).
- [x] **FE-M6** No reconciliation report screen for refused offline rows — dismiss is the only option; a rejected GRN is silently discarded (plan §4 requires the report).
- [ ] **FE-L1** Only 1 `aria-live` region (offline queue + toasts not announced); no axe-core in CI. (Otherwise a11y is genuinely clean: zero div-buttons, labels wired.)
- [ ] **FE-L2** No PWA manifest/service worker for floor tablets; `viewport` lacks `maximumScale`/`viewportFit`.

---

## 4 · MARBIM AI layer

**Bottom line:** the *governance* half (propose→approve→commit, double Zod validation, per-field confidence plumbing, extractor telemetry, tenancy, type-level "no tool can write") is production-grade. The *intelligence* half does not exist: no real model, no tool execution, no OCR, no notifications, no cost controls — and the confidence numbers the governance ranks on are hardcoded in nine `tools.ts` files.

### Blockers

- [x] **AI-B1 · No real model provider; in production MARBIM is inert and monitoring stays green.**
  Only `registerProvider` call site is `if (env.MARBIM_MOCK) registerProvider(mockProvider)` (`marbim/register.ts:55-57`); mock is forbidden in prod (`env.ts:87-93`); no vendor SDK is a dependency. Chat hard-fails every turn; the extraction poller skips with `{ skipped }` and `recordRun` closes the job_run **`succeeded`** (`core/job-runs.ts:62-70`) — job-health sees a healthy task while documents pile up `queued` forever.
  **Fix:** implement ≥1 real provider (extract with measured per-field confidence, generate, embed) selected by env; boot assertion in prod (real provider or exit); until then make the skip an alerting condition.

- [x] **AI-B2 · Draft-tool confidence is developer-typed constants in nine modules; the promised lint rule doesn't exist.**
  `fieldConfidence` literals in `orders/tools.ts:131-139`, `store`, `compliance`, `quality`, `cutting`, `shipment`, `sampling`, `procurement` tools. The uniform-constant guard (`marbim.ts:83`) only catches *identical* values, so distinct hardcoded numbers pass. These literals drive approve-inbox ranking and the auto-approve floor (`pending-changes.ts:183,218-222`) — a confidence floor compared against a typed literal is not a control. `docs/04-ai-layer/marbim-implementation.md:76` promises the lint rule; `eslint-rules/` doesn't have it.
  **Fix:** derive confidence from something measured (see the one good example: `memory/memory.ts:352-363`) or mark these as user-draft-class with `fieldConfidence: {}`; add the lint rule (numeric literal inside a `fieldConfidence` object = error). **Fix before AI-B1** — a real provider behind constant confidences makes ranking actively misleading.

- [x] **AI-B3 · The copilot cannot execute any tool; the read/draft contract is dead code end-to-end.**
  `chat` passes tool names to the model and stores `toolCalls` — no execution loop, no second turn (`marbim/service.ts:562-573`). `runDraftTool` ("the only path from a tool to pending_changes") has zero production call sites. ~90 registered tools are prompt text only, while the UI footer still claims "MARBIM states no number it did not read from a tool" (`surface-client.tsx:183`).
  **Fix:** implement the agent loop (model turn → validate+execute tool calls → results back → final turn; cap iterations); until then the surface must not claim tool-grounding.

### High

- [ ] **AI-H1** `extractorVersion` hardcoded `'1'` (`marbim/actions.ts:200-205`) — swapping mock→real or changing prompts pools correction rates the versioned key exists to separate. Derive from prompt semver + provider/model id.
- [x] **AI-H2 · Auto-approve from the worker throws a NOT NULL violation** — `pending-changes.ts:218-227` casts `SystemCtx` (userId: null) to `RequestCtx`; `approve` inserts `approverUserId: ctx.userId` into a `notNull()` column. Any company configuring auto-approve loses every high-confidence extraction (retried, then terminal `rejected`). The covering test uses a real user, so CI can't see it. Skip the approvals insert for system ctx (or make column nullable + record role); add an integration test with `SystemCtx`.
- [x] **AI-H3** Chat has no conversation history — every turn sends only the current question (`service.ts:571`) though `chat_turns` stores history. Follow-ups can't work. Load + budget prior turns.
- [x] **AI-H4** No cost/rate control on chat, no token accounting anywhere — unbounded chat against a metered API is direct financial exposure, and there's no data to price with. Add `chatRequestsPerMinute` + monthly token ceiling in policy, Redis limiter in `ask`, `marbim_call_log` written by the provider wrapper.
- [x] **AI-H5** `MARBIM_EVENTS` declared, never emitted (`events.ts:1-13`); no extraction success/rejection notification — the merchandiser who pastes a tech pack is never told anything; `extractorDrifting` unreachable. Emit from `runExtraction` in the same tx, route + notify.
- [x] **AI-H6** Tool packs handed to the model with no role filtering (comment claims otherwise, `marbim/actions.ts:40-50`); a viewer gets draft tools the moment the loop lands. Filter server-side by role; drop draft tools for read-only roles.
- [x] **AI-H7** Document intake has no role gate — any authenticated member/viewer can queue extractions at 60/hr and fill the approve inbox (`actions.ts:157-165`, `service.ts:219-279`). Require write-capable roles per intake kind.

### Medium / Low

- [x] **AI-M1** No OCR/PDF text path — extraction is paste-the-text; PLAYBOOK sells "photos of handwritten sheets". Also `zod.ts:31-34` still permits a document-only job that would extract from `''`. Wire vision/OCR or require `sourceText` in the schema.
- [ ] **AI-M2** No token budget: full 21-module primer set (~8.3k tokens) + ~90 tool descriptions on every turn; extraction input capped at 200k chars with no chunking. Budget + prompt caching + chunking.
- [x] **AI-M3** Prompt injection unaddressed: untrusted document text passed beside instructions with no delimiters or standing rule; the real mitigations (human approval, re-validation) exist but aren't the declared boundary. Delimit, add a standing rule, document approval as containment.
- [x] **AI-M4** Extraction is a 5-minute poller (batch 10/company), not a real queue — up to 5 min latency, >120 docs/hr never drains, retries wait a full cycle. Emit to outbox → BullMQ job with rate limiter + backoff; keep the poller as reconciler.
- [x] **AI-M5** Extraction rate limit is racy (count-in-transaction, no lock) and counts queued jobs, not model calls (3× budget with retries). Redis counter or advisory lock; count attempts.
- [ ] **AI-M6** Single-field drafts bypass the constant-confidence check (`marbim.ts:83`, `values.length > 1`). Require justification for single-field payloads too.
- [ ] **AI-M7** `docs/04-ai-layer/marbim-implementation.md` describes a much larger system than exists (model registry, prompts@semver, evals + CI gate, streaming, telemetry, budgets — all absent). Add a "what exists today" preface pointing at STUBS.
- [ ] **AI-L1** Stale docs: STUBS says only 2 modules ship toolPacks (all 21 do now); PROGRESS marks X.2 pending.
- [ ] **AI-L2** Chat surface fakes streaming (`surface-client.tsx:195`) over a single server action; no SSE route.
- [ ] **AI-L3** `conversationId`/`turnIndex` are client-supplied; make turn ordering server-authoritative.
- [ ] **AI-L4** `embed` required on the provider interface but no retrieval/RAG exists yet.
- [ ] **AI-L5** Extraction instruction is an ad-hoc template string (`service.ts:343`) — no versioned prompt artifact (concrete form of AI-H1/AI-M7).

---

## 5 · Tests & quality gates

**Scale:** 73 test files, 1,257 cases (663 unit + 594 integration), all green. Zero `any`/`@ts-ignore` in the service layer. Both custom lint rules exist, run as errors, and are themselves unit-tested. Tenancy is tested in 21 of 22 applicable modules. But: no coverage measurement, no frontend tests at all, and the three worst-covered spots are exactly the most sensitive surfaces.

### Blockers

- [x] **TEST-B1 · `approvals` (X.1 Approve Inbox) has zero tests — empty `__tests__/` directory.**
  887 LOC through which *every* AI-proposed change is reviewed; role routing (`approversFor`, `upsertApprovalRule`), aging escalations fired from the scheduler — none tested.
  **Fix:** unit (aging buckets, role resolution, correction-rate math) + integration (tenancy on `inboxRows`/`draftDetail`; no-role → 403; `upsertApprovalRule` audited; `emitAgingEscalations` once per level per company).

- [ ] **TEST-B2 · The ⚡ floor NFR gate cannot run: `k6/production_burst.js` targets routes that don't exist.**  ◐ **partly done** — plan 7.1 — harness + 3 scenarios with baselines; `mixed_day` deferred.
  It posts `/api/production/outputs` and reads `/api/production/board`; neither route exists (`src/app/api/` has only auth/documents/health/me/sync). The 6.1 NFR (write p95<500ms, board p95<800ms, zero lost rows) is unverifiable — **and the floor has no HTTP surface for line tracking at all.**
  **Fix:** ship the two routes, run the scenario on VPS-class hardware against `seed --scale=factory`, commit the baseline; automate the row-count assertion (currently a comment telling a human to run SQL).

- [x] **TEST-B3 · workforce/payroll (🔒 most sensitive module) has no cross-company tenancy test.**
  `payroll.integration.test.ts:36` uses a single `COMPANY` for all ctxs. The one place a leak means reading another factory's wage bill is the only module without the never-skipped test.
  **Fix:** second company fixture; assert 0 rows on runs/lines/gazettes/workers; `computePayrollRun(bCtx, aRunId)` refuses; audit `read` rows per-company.

### High

- [x] **TEST-H4** 9+ modules register pending targets + commit handlers never driven through `approve()` in any test (costing, rfq, finance, quality, sampling, procurement, workforce, cutting; store calls the handler directly). The static registry guard can't catch a handler that inserts the wrong row. Build a shared `proposeApproveCommit` helper + one parameterised test per registered target.
- [ ] **TEST-H5** 7 of 8 documented k6 scenarios don't exist; `mixed_day` — the declared *release gate* (`docs/06-quality/testing-and-pressure.md:42,56`) — is unsatisfiable; 11.2 owner-dashboard (the other ⚡) has no scenario at all. Prioritise `owner_dashboard` + `store_grn`; add a manually-dispatched load workflow that stores baselines.  ◐ **partly done** — plan 7.1 — `production_burst`, `store_grn` and `owner_dashboard` exist with committed baselines; `cutting_lay`, `qc_inline`, `shipment_pack` and `mixed_day` are not built.
- [x] **TEST-H6** sampling registers two offline sync handlers with no replay test, and `sampleRequestMachine` has no illegal-transition assertion — a duplicate `advance_stage` replay would double-advance the sample stage that the PP gate (cutting start) reads.
- [ ] **TEST-H7** shipment (`portStatusMachine`, `packingListMachine`) and cutting machines lack illegal-transition 409 assertions (the second never-skipped test).
- [x] **TEST-H8** No frontend tests of any kind against 115 shipped `.tsx` files — no Playwright golden path, no axe-core, no jsdom project; `vitest.config.ts` can't even pick up `.tsx`. Minimum: one Playwright golden-path spec + axe on the five floor screens + jsdom tests for `use-offline-queue.ts` and `inbox-client.tsx`.

### Medium / Low

- [ ] **TEST-M9** Integration harness is not Testcontainers despite three docs/comments saying it is; 36 files share one mutable DB (isolation by convention); `setupFiles: ['dotenv/config']` means a developer's real `DATABASE_URL` is what tests write to. Fix the comments + add a pre-seed company-absence assertion (or adopt Testcontainers for real).
- [x] **TEST-M10** No coverage instrumentation, no JUnit reporting, no CI `timeout-minutes` (hung integration suite burns 6h), `verify:phase0` never runs in CI though PROGRESS cites it. Add coverage-v8 with a ratchet floor, timeouts, artifacts, and the verify step.
- [ ] **TEST-M11** `no-float-money` doesn't cover `src/components/**` or `src/lib/**` — money formatting lives in `fx/`. Extend the glob.
- [x] **TEST-L12** `lint` lacks `--max-warnings=0` — warn-level rules from `eslint-config-next` can't fail CI.
- [ ] **TEST-L13** `exactOptionalPropertyTypes: false` — the one strictness dial off; `{ note: undefined }` vs "leave column alone" in Drizzle inserts.
- [ ] **TEST-L14** PROGRESS.md drift: 12 of 23 module rows, X.1 row blank despite shipped module+UI, "Frontend merged" empty everywhere, and STUBS still claims the lint rules don't exist (they do, tested, in CI). Bring the trackers up to date — either direction of drift misleads a go-live call.
- [ ] **TEST-I15** 3 of 8 documented test levels have no implementation (contract tests, AI evals + golden sets, E2E/a11y/restore drill). Build or relabel as roadmap so the quality doc stops describing the present falsely.

---

## 6 · Backend architecture-rule compliance (CLAUDE.md rules 1–12)

**Overall:** rules 3 (AI writes via pending_changes), 6 (outbox), 7 (offline idempotency), 9 (analytics read-only / payroll lockout) and 12 (core isolation) are genuinely well executed — see §8. The violations below are specific and mostly small in code terms, but several are high-consequence.

### Blockers

- [x] **BE-B1 · Tenancy has only ONE wall — no service adds a `company_id` predicate; a wrong `DATABASE_URL` removes tenancy entirely.**
  Zero `eq(<table>.companyId, ctx.companyId)` predicates in any of the 21 modules (`companyId` appears only in `.values()` on inserts, never in a `WHERE`). RLS policies are `FOR ALL TO fabricxai_app` only; the owner role bypasses them; nothing at runtime asserts which role the pool connected as (checked at setup time only, `scripts/setup-db-roles.mjs:70`). CLAUDE.md rule 2 says RLS is "never the only wall" — today it is. Combined with DB-H1 (compose full-profile runs as owner), this is live.
  **Fix:** boot assertion in `instrumentation.ts` + `worker/index.ts` refusing to start on an owner/BYPASSRLS connection role; add company predicates via a `scoped(tx, table)` helper + lint rule so wall 1 actually exists.

- [x] **BE-B2 · `quality` writes `store`'s `grns` table directly, unaudited (rules 11 + 10 at once).**
  `quality/service.ts:1336` updates `grns.inspectionStatus` via a dynamic import of store's schema, with no `recordChange`, though `grns` is registered as an audited table by store. (Verified: this is the *only* cross-module write in the repo.)
  **Fix:** add `setGrnInspectionStatus(ctx, tx, …)` to `store/service.ts` (update + audit) and have quality call it.

- [x] **BE-B3 · `no-float-money` is bypassed repo-wide by `Number.parseFloat` — 22 live sites, some money-deciding.**
  The rule matches only bare-identifier `parseFloat`/`Number` (`eslint-rules/no-float-money.js:86,91`); `Number.parseFloat` is a MemberExpression and never matches. Live sites include the **FOB price computation** (`costing/cost-sheet.ts:297-308` — float divisor from a decimal string), `Number.parseFloat(fobPrice.amount) > 0` (`:325`), the **BTB over-limit decision** (`commercial/queries.ts:81-83,170`), and bonded UD quantity compares (`commercial/jobs.ts:101-102`, `service.ts:256`, `ud-queries.ts:110`).
  **Fix:** extend the rule to MemberExpression callees (+ `Math.*` on money); convert `cost-sheet.ts:297-308` to exact `mulDiv`; add justified inline disables where a float compare is genuinely display-only.

- [x] **BE-B4 · The BullMQ worker never imports the module registry — module registration (providers, schemas, primers) doesn't exist in the worker process.**
  `src/worker/index.ts` never imports `@/modules/registry` (only `instrumentation.ts`, `core/session.ts`, and `/api/sync` do). So in the worker `hasProvider()` is always false → `marbim.run_extractions` skips forever. Worse: the moment a real provider is registered without fixing this import path asymmetry, `resolvePendingSchema` throws `unknown_module`, which is classified non-retryable → **every queued extraction is permanently rejected on first pass** — the exact scenario the provider check exists to prevent.
  **Fix:** `import '@/modules/registry'` in `worker/index.ts` + assert `listModules().length > 0` in `main()`; make registry/config `AppError`s retryable rather than terminal in `runExtraction`.

- [x] **BE-B5 · The rule-10 "audit interceptor" is not an interceptor — `registerAuditedTables` is write-only dead code, and `lcs` (named in the rule) is neither registered nor audited on create.**
  `isAudited`/`listAuditedTables` have zero callers. `commercial` registers only `uds`/`ud_consumptions`; `createLc` (`commercial/service.ts:1352-1377`) inserts an LC with no `recordChange`.
  **Fix:** register `lcs`/`btb_lcs`/`lc_amendments` + add `recordChange` to `createLc` now; then make the registry enforcing (test iterating `listAuditedTables()`, or a per-table trigger raising when `audit_log` has no row for the current xid — pairs with DB-M6).

- [x] **BE-B6 · Five modules have no write surface at all — orders, rfq, planning, production, cutting are not operable over HTTP** (`src/app/actions/` holds only `.gitkeep`; production is reachable only via `/api/sync`; cutting likewise). This is the backend half of FE-B2/FE-B4 and the reason TEST-B2's k6 scenario can't run.
  **Fix:** ship `actions.ts` for orders/rfq/planning and the two `/api/production/*` routes k6 already targets (thin: getCtx → zod → service).

- [x] **BE-B7 · `docs/handoffs/` is empty — the stated precondition for all backend work is unmet** (same as PROC-1; consequences enumerated there). Additional concrete fallout found here: `approvals` has **no `register.ts` at all** and is absent from `src/modules/registry.ts` (no domainPrimer, no pending targets, no zod map) — and it's also the only module with zero tests (TEST-B1).

### High

- [x] **BE-H1 · Rule-1 lint guard misses the real action layer.** The `no-restricted-imports` ban on `@/db/client` covers `src/app/actions/**` (empty) and `src/app/api/**` — not `src/modules/*/actions.ts`, where the 16 real `'use server'` files live. Already exercised: `shipment/actions.ts:162-172` runs its own drizzle query in the action. Extend the glob; move the carton query into the service.
- [x] **BE-H2 · `GATES.lcLatestShipment` is declared and never enforced.** Ex-factory computes LC conflicts, records the count, and blocks nothing — a container can leave after the credit's latest-shipment date with no server-side objection (that's the bank refusing the presentation later). Implement as a real waivable gate in `confirmExFactory`, or formally demote it to an alert in CLAUDE.md + STUBS.
- [ ] **BE-H3 · Gate `facts` never survive the server-action boundary** — Next serializes only `Error.message`, so "UD short by 340 m of 1,200 m" degrades to a bare i18n key for all 7 gates (`src/lib/action-error.ts:5-19` documents this). Return typed `{ok:false, error: AppError.toJSON()}` results for `gate_blocked`/`illegal_transition` instead of throwing.  ◐ **partly done** — plan 2.3 — gate copy landed, typed action results owed.
- [x] **BE-H4 · `/api/sync` has no role authorization** — any authenticated company member (any role) can receive GRNs, **issue bonded stock and draw a UD**, and via `sampling:record_feedback` record the buyer verdict that **opens the PP-approval gate for cutting**. Add a `roles` field to `SyncHandler` registration, enforced in `applyRow` before the offline key is claimed. (Complementary to INFRA-H7's rate limiting.)
- [ ] **BE-H5 · 46 cross-module reads go through raw schema tables instead of the owner's `queries.ts`** (rule 11): `shipment/service.ts` reads `lcs` five times; `memory/service.ts` reads ten other modules' tables; nothing lints it (`analytics-no-writes` bans `service.ts` imports only, and only in analytics). Add a lint rule banning `modules/<a>` → `modules/<b>/schema` imports; publish named reads owner-by-owner, starting with `commercial.lcs` and `orders`.
- [x] **BE-H6 · Three source files contain embedded NUL bytes** (`orders/service.ts`, `cutting/cutting.ts`, `quality/quality.ts` use `\0` as a composite-key separator) — grep/ripgrep treat them as binary and **silently skip them**, which corrupted this audit's own first pass and will corrupt any future codemod/CI grep. Replace with `'␟'` or a guarded two-char sentinel; add a CI check that no tracked `.ts` file contains a NUL.

### Medium

- [ ] **BE-M1 · 16 status columns have no state machine and are set by raw updates** — most seriously `uds.status` (a customs declaration lifecycle: `'exhausted'`/`'expired'` set raw), `receivables`/`payables.status` (finance has zero machine asserts), `rolls.status`, `purchase_requisitions.status`, `wage_gazettes.status`, `tna_milestones.status`, `extraction_jobs.status`, etc. Add machines (or document why not) per HANDOFF §6 as those get written.
- [ ] **BE-M2 · `lcs.status` never advances past `active`** — no operation/job sets `expired`/`closed`, yet `detectLcConflicts` reasons over the field. Add an `expireLapsedLcs` scheduled task + machine, or drop the dead enum members.
- [x] **BE-M3 · sampling has two write paths for the same operations, one without idempotency** — `moveSampleStage`/`recordBuyerVerdict` server actions call the same services as the registered offline handlers but with no `offlineKey`; a double-submit double-advances the stage that feeds the PP gate. (Quality documents why fabric inspection is action-only; sampling has no such note.) Route through `/api/sync` or claim an offline key in the action.
- [ ] **BE-M4 · Payroll reads only partially audited** — `recordRead` called in 1 of 4 gated read paths (`getPayrollLines`); `activeGazette`, `payrollRunList` and the third `queries.ts` path gate but never audit. Rule 9 says reads are audited.
- [x] **BE-M5 · Two queues receive routed jobs with no worker attached** (same finding as INFRA-B6, from the routing side): `renderPdf` has no processor and no completes-gracefully fallback like `derive-router` has. Remove the routes or attach a stub worker until the PDF pipeline lands.
- [ ] **BE-M6 · Server components read through `service.ts` instead of `queries.ts`** in 9+ pages (`store/issue`, `ud/[udId]`, `cutting/lay`, 7 pages importing `companyProfile` from settings **service** — settings has no `queries.ts`). Re-export as named reads on `queries.ts`; extend the H5 lint to ban `src/app/**` → `modules/*/service`.
- [ ] **BE-M7 · `/api/health` unauthenticated + echoes raw dependency error strings** (same as INFRA-M1; also the one route exempted from the db-import ban, which compounds it). Split public status-only vs authenticated detail.
- [ ] **BE-M8 · `Money` type largely unadopted: `toMinor`/`fromMinor` reimplemented ~14 times** — finance, commercial, procurement, rfq, shipment, store all import `lib/money` zero times and carry private scaled-BigInt copies. Arithmetic is exact today, but "every amount carries currency" is structurally impossible with bare strings, and a rounding-convention change has 14 places to miss. Sanction `lib/money.ts`+`lib/quantity.ts` only; lint-ban local re-implementations; convert finance first.  ◐ **partly done** — plan 2.9 — 10 of 20 files converted; the costing precision bug it found is fixed.

### Low

- [ ] **BE-L1 · Five gates throw `AppError('gate_blocked')` directly instead of through `assertGate`**, some with string-literal gate ids instead of `GATES` members. Route through the helper so a rename is a type error.
- [ ] **BE-L2 · Three stale STUBS.md entries understate what shipped** (lint rules exist; all 21 modules ship toolPacks; 5 of 7 gates implemented). Mark resolved with commits; add rows for `lcLatestShipment` (BE-H2) and the worker-registry gap (BE-B4).
- [ ] **BE-L3 · `propose` auto-approval runs in a separate transaction from the draft insert** — a crash between them strands a should-have-committed draft in the inbox. Safe direction, but undocumented; add the comment or fold into one tx. (Note AI-H2 means auto-approve currently crashes anyway.)
- [ ] **BE-L4 · The no-constant-confidence check lives only in marbim, not in core `validateConfidence`** — a module calling `propose` directly with `source: 'ai_extraction'` and uniform confidences would be accepted. Latent (no such caller today); move the check into core.

---

## 7 · Process & repo hygiene

- [ ] **PROC-1 · `docs/handoffs/` is empty.** The playbook's hard rule — "Never start backend work on a module without its HANDOFF file with §8 empty" — was bypassed for every module; all were built "backend-first" against briefs. Consequence: queries/actions in several modules await contracts that don't exist, and there is no FINAL per-module contract to audit §5 operations / §6 machines / §7 gates against. Either write the handoffs retroactively (recommended: they become the acceptance checklist per module) or formally retire the process and promote the briefs to contract status.
- [ ] **PROC-2 · ~210 files uncommitted, including the ENTIRE frontend.** `src/app/(app)`, `(auth)`, `(board)`, `src/components/`, three migrations (0066–0068), several seed slices, and the design canvases are untracked; 103 tracked files have ~5.5k uncommitted modified lines. One `git clean` or disk failure loses the frontend. Commit in reviewable slices now.
- [ ] **PROC-3 · Tracker docs are stale in both directions** (see TEST-L14, AI-L1): PROGRESS understates what shipped; STUBS overstates two gaps that are closed. These are the documents a go/no-go decision reads.

---

## 8 · What is genuinely good (keep it that way)

- **Trust spine:** `pending_changes` validates against the module registry whitelist, re-validates with module Zod at propose AND approve, merges reviewer corrections before re-validation, `FOR UPDATE` locking, commit+audit+outbox in one transaction, auto-approved drafts excluded from correction-rate telemetry.
- **Tenancy:** real RLS with a non-owner app role asserted in CI; `SET LOCAL` per transaction (PgBouncer-safe); cross-company tests in 21/22 modules, several at the RLS level.
- **Type safety:** zero `any` in the service layer; 3 justified `@ts-expect-error`s, all in tests; strict TS with nearly every dial on.
- **Custom lint gates that actually run and are themselves tested:** `no-float-money`, `analytics-no-writes`.
- **Offline layer:** single `capture()` API with `offline_key` idempotency, per-row verdicts, replay-is-a-no-op tests through the real `/api/sync` endpoint, "rejected stays rejected" covered.
- **CI:** schema-drift detector, all 69 migrations applied to an empty DB, seed proven idempotent (run twice), RLS-bypass assertion every build.
- **Env validation** (`src/lib/env.ts`): collects all failures, distinguishes build/boot, tightens in production.
- **Document upload flow:** reserve-then-presign, MIME allowlist, ContentLength bound into the signature, HeadObject confirm, soft delete.
- **Outbox relay:** FOR UPDATE SKIP LOCKED, at-least-once + `processed_events` dedupe, multi-worker safe.
- **Job-health design:** expected interval derived from the cron pattern; unrecognised patterns refused; app-process watchdog for the worker.
- **Access control in the shell** is centralized and argued; TV board correctly scoped; empty states near-universal with real domain copy; a11y basics clean.
- **`docs/STUBS.md` culture of honesty** — most of what this audit found was already named there. The work is known; it is simply not done.

---

### Additional verified-good, from the rules audit
- **Rule 3 end-to-end:** unregistered target tables refused, two modules can't claim the same table, Zod runs at insert AND approve, no hardcoded confidence constants in *core* paths (the nine tools.ts literals are AI-B2), every field must clear the auto-approve floor (not an average).
- **Rule 6 is the best-executed rule in the repo:** `emit` takes the caller's tx (dual write structurally impossible); relay ordering correct and explained; SKIP LOCKED multi-worker safe; consumers dedupe inside the handler tx; poison events park visibly.
- **Rule 7:** offline key claimed before the handler runs; rejection remembered as terminal; per-row transactions; batches bounded; all five rule-7 modules register handlers.
- **Rule 8:** both seam gates (PP-approval, fabric inspection) **fail closed with no provider** — the single most important gate-design decision, made correctly. UD balance drawn with exact BigInt inside the issue's own transaction.
- **Rule 5:** 20 machines, transition tables validated at import, every raw status update traced in 9 modules is preceded by a matching `.assert()` (the 16 uncovered columns are BE-M1).
- **Rule 12:** clean across all 53 commits.

---

## Fix-order summary (suggested sprints)

| Sprint | Theme | Items |
|---|---|---|
| 1 (before anything else) | Correctness landmines, ~days | INFRA-B1 · BE-B4 · AI-H2 · INFRA-B6/BE-M5 · DB-H1 · BE-B2 · BE-B3 (lint fix + cost-sheet) · INFRA-H3 |
| 2 | Tenancy hardening | DB-B1 · BE-B1 · DB-H2 · BE-H4 · DB-H4 · TEST-B3 |
| 3 | Production infrastructure | INFRA-B2 · INFRA-B3/DB-B2 · INFRA-B4 · INFRA-B5 · INFRA-H1 · INFRA-H4 · INFRA-H5 · INFRA-H6 · INFRA-H7 |
| 4 | Floor usability | FE-B1 (bn for floor routes) · FE-B3 · FE-H5 · FE-H6 · BE-B6 · FE-H1 |
| 5 | Operate the flagship flows | FE-B2 · FE-B4 · FE-S1–S3 · BE-H2 · BE-H3 · INFRA-H2 (dates) |
| 6 | AI go/no-go | AI-B2 → AI-B1 → AI-B3 · AI-H1 · AI-H5–H7 · BE-B7/PROC-1 handoff back-fill |
| 7 | Verification depth | TEST-B1 · TEST-B2 · TEST-H4–H8 · DB-H3 · DB-H5 · k6 baselines |
| Ongoing | Mediums/Lows by module as touched | everything else above |

---

*Compiled 2026-08-03 from six parallel deep-audit reports (infra/ops, database, frontend-vs-design, backend rules, tests/quality, MARBIM AI layer) plus live gate runs. Local gates at audit time: `pnpm typecheck` ✅ · `pnpm lint` ✅ · `pnpm test` ✅ (698/698). When a finding is fixed, tick it and append the commit hash.*
