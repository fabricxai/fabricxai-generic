# Handover readiness — Barakah Fashions and factories like it

**Date:** 2026-08-10 · **Audited:** full codebase at `a6def46`, the production VPS, and the
nine-phase live test's own ledger (`docs/runbooks/live-test-barakah.md` #12–#33).
**Method:** four independent read-only sweeps (incompleteness, security/ops, module
completeness, correctness risk) folded together with the live-test findings. Nothing in
this document has been fixed; it is the honest bill of what remains.

## The verdict, first

**Fit today for:** a supervised, floor-first pilot at one factory — which is exactly what
the Barakah live test was, and it passed: every server-side gate held, all nine phases ran
end to end, and the twenty-plus missing doors found during the test were built and shipped.

**Not fit today for:** unattended production custody of a real factory's money, wages and
customs exposure, or a second factory that is not a Bangladesh knit/woven exporter shaped
exactly like the seed assumptions. The reasons are almost entirely operational and
contractual, not code quality — and they are enumerated below with file references.

Severity model: **BLOCKER** = do not hand over custody of real data until done ·
**HIGH** = fix before or during the first weeks of real operation · **MEDIUM** = fix
before scaling past one factory or one quarter · **LOW** = rolling debt, tracked.

---

## 1 · Go-live blockers

| ID | Item | Where |
|----|------|-------|
| GL-1 | **Rotate the five leaked credentials.** Anthropic, OpenAI, two Gemini keys, the GitHub token and the Resend key were exposed in working transcripts during the build and are still live. Nothing else in this file matters while these stand. | provider dashboards |
| GL-2 | **Backups cannot run: the `backup` service does not exist.** `scripts/backup.sh:54` and `docs/runbooks/deploy.md:138` both invoke a compose service that no compose file defines; `docker/backup/pgbackrest.conf` is mounted by nothing. Every documented backup step fails at its first command. | `docker-compose.prod.yml` |
| GL-3 | **WAL archives to a no-op — RPO is unbounded.** `archive_command=true` reports success and Postgres recycles WAL believing it is archived. No PITR, no base backup exists. The restore-rehearsal log is empty and the stated RTO ≤4h / RPO ≤15min are aspirational. | `docker-compose.prod.yml:242-246`, `docs/runbooks/restore.md:226` |
| GL-4 | **The restore rehearsal has never been executed.** "A backup nobody has restored is a belief" — the audit's own words. Blocks handover regardless of GL-2/3 being fixed. | `docs/runbooks/restore.md` |
| GL-5 | **Payroll has never been parallel-run.** The go-live gate the CLAUDE.md calls non-negotiable: one month against the factory's own sheet, every net to zero or explained. Never run. | `scripts/payroll-parallel-run.ts`, `HANDOFF-10-1` §8 |
| GL-6 | **`pnpm demo` and three seed scripts have no production guard.** `scripts/demo.ts` connects via the RLS-bypassing direct client, picks a company by itself when `DEMO_COMPANY_ID` is unset, and would write a fake order book into a live factory. `seed-day0.ts`, `seed-pretest.ts`, `seed-fabricxai-fashion.ts` are equally unguarded (`src/db/seed/guard-boot.ts` is imported only by `seed/index.ts`). Two lines per script. | `scripts/*.ts` |
| GL-7 | **Day-0 one-time passwords live in a plaintext file on the VPS.** `~/day0-run.log` holds 18 credentials; nothing expires them or forces change-on-first-login, and `seed-day0.ts:504` force-sets `emailVerified: true`, bypassing the verification gate. Rotate all, delete the log, add change-on-first-login. | `scripts/seed-day0.ts:801` |
| GL-8 | **Auth rate limiting is non-atomic and mis-keyed.** (a) The Redis `secondaryStorage` lacks `increment`, so Better Auth falls back to read-decide-write — concurrent attempts bypass the limit, and the 40-line comment claiming otherwise is wrong (`src/lib/auth.ts:69-136`). (b) No `trustedProxies` is set; behind Caddy an attacker-supplied `X-Forwarded-For` collapses everyone into one shared bucket — escaping their own limit or locking the whole factory out of sign-in. (c) There is **no per-account lockout at all**: keys are IP+path, never the email. ~15 lines to fix all three. | `src/lib/auth.ts` |
| GL-9 | **Nothing pages a human.** With `SENTRY_DSN` optional and unset, the complete alerting inventory is in-app email (requires the worker and Postgres to be healthy — cannot report the failures that matter) plus two optional backup webhooks. `HEALTH_TOKEN` is optional and unset, and the worker's compose healthcheck is deliberately disabled in its favour — so a dead worker alerts nobody. Make `HEALTH_TOKEN` mandatory in production env validation; stand up an external monitor on `/api/ready` and `/api/health/jobs`. | `docker-compose.prod.yml:191`, `src/app/api/health/jobs/route.ts:69`, `src/lib/env.ts` |
| GL-10 | **Deployment wiring is half-connected.** The prod compose healthcheck and Caddy upstream still point at the old endpoint, not `/api/ready` (built, consumed by nothing); the S3 proxy is unfinished; there is no CI deploy job (every deploy this test was a manual ssh). | `docker-compose.prod.yml`, `docker/caddy/Caddyfile` |

---

## 2 · Data-loss and correctness bugs

| ID | Sev | Item |
|----|-----|------|
| DL-1 | HIGH | **A role refusal permanently destroys floor work, silently.** The server deliberately does not persist role refusals (`offline-sync.ts:139` — "replayed after roles are fixed must apply") but the client marks every `rejected` terminal (`queue.ts:166`), filters it from `pending()` forever, and the only exit deletes it. A misconfigured role turns a storekeeper's counted GRN into work gone from the device *and* absent from the server's reconciliation report — the report is structurally blind to the whole class. Proven live in Phase 9 (runbook #27). Also: `offline_keys` has no `user_id`/`device_id`, so a refused challan on a shared tablet cannot be traced to who captured it. |
| DL-2 | HIGH | **The outbox relay can wedge permanently behind poison, with zero surfacing.** Parked rows (attempts ≥ 10) stay `published_at NULL`, but `app.lock_outbox_batch` selects by `occurred_at LIMIT 100` with no attempts filter — 100 poison events at the head starve every batch forever. Both code comments promise an admin/runbook screen that does not exist; no dead-letter queue, no parked count, no alert; `/api/health/jobs` never reads the outbox. | 
| DL-3 | HIGH | **`NotReadyYet` swallows transient failures permanently.** The consumer marks such events processed with only a `console.warn`. A `finance.realized` arriving before its invoice is visible means a **bank realization silently never posts to the receivable** — marked done, no trace a person will meet. (`src/worker/processors/consumers.ts:599`) |
| DL-4 | HIGH | **Seven per-module UTC "days until" helpers mis-date countdowns for six hours a night.** Duplicated `daysUntil` computing "today" in UTC in procurement, finance, commercial (LC **and** UD), sampling, rfq, buyers queries. Between 00:00–05:59 Dhaka every overdue/aging/expiry badge is a day out — and UD validity and LC latest-shipment are dates banks and customs count. The lint rule misses the hoisted-variable form. Related singles: supplier on-time-delivery decided on a UTC date (`procurement/service.ts:926`); the owner dashboard's 30-day window and the 8-week cash timeline UTC-anchored; night-shift inline checks default `checkedOn` to yesterday (`quality/service.ts:221`). `formatFactoryDate` exists with exactly three call sites — adoption owed everywhere else. |
| DL-5 | HIGH | **The 4-point fabric inspection has no offline path and no idempotency key.** The one floor screen still posting straight to a server action — at the fabric receiving bay, statistically the worst connectivity in the building. A double-tap or retry files duplicate inspections with no `offline_key` ledger entry. (`quality/fabric-client.tsx:13`) |
| DL-6 | MED | **Offline queue robustness set:** every operation opens a fresh IndexedDB handle and never closes it (unbounded over a shift); `DB_VERSION=1` with no `onblocked` handler makes the schema effectively unmigratable; concurrent flushes can resurrect just-deleted entries (self-heals via server dedupe, but SyncPill over-reports queue depth against its own stated contract); `crypto.randomUUID()` throws on plain-HTTP origins — capture, the one thing that "never fails", fails; no `QuotaExceededError` handling. (`src/lib/offline/queue.ts`) |
| DL-7 | MED | **Money-lint blind spots.** All ~40 inline disables checked and legitimate — but the rule's `files` glob excludes `scripts/*.ts` entirely, so `payroll-parallel-run.ts` (a payroll reconciliation script) is unlinted for float money; `__tests__/**` is also exempt, so a test asserting a float-derived money value passes silently; and 12 files still carry private money helpers (payroll, store, procurement, shipment among them) — 12 independent rounding conventions, correctly ratcheted but open. |
| DL-8 | MED | **Self-approval has never been prevented.** `approve()` checks role and counts distinct approvers but never compares `ctx.userId` to the draft's creator — a control the approvals action's own docs once claimed existed. (`STUBS.md` L13, `HANDOFF-X-1` §8) |
| DL-9 | MED | **Values that are always wrong** (each a report a manager will read as truth): `wip_snapshots.cut/finished` always 0; supplier `qualityRejectPct` computed from zero rejects (the QC→GRN→PO reject chain does not exist); `priceIndex` always null; `responsivenessPct` mis-counts; `receivables.part_realized` never set; `caps.milestones` stored but never checked; buyer scorecards have no quality component. (STUBS L57, L70-72, L100, L138, L142) |
| DL-10 | MED | **An order born from a won RFQ carries a placeholder PO number and no breakdown** — downstream everything (cutting gate, packing grid) hangs off both. (STUBS L111-112) |
| DL-11 | LOW | **Ten missing foreign keys** catalogued in STUBS (L39, L48, L52-56, L75-78, L84, L93-95) — orphanable references in downtime→machine, worker→line, GRN→PO among others. |
| DL-12 | LOW | **Env-coupled test:** the scheduler MARBIM-off integration test fails on any machine whose `.env` sets `MARBIM_ENABLED=true` and will read as a scheduler regression to the next person. Make the test pin its own env. (`scheduler.integration.test.ts:152`) |

---

## 3 · Security hardening (beyond the blockers)

| ID | Sev | Item |
|----|-----|------|
| SEC-1 | HIGH | **No 2FA anywhere.** The owner account controls payroll, LC values and bonded exposure behind a password alone. No TOTP, no passkeys, no step-up for sensitive operations. |
| SEC-2 | HIGH | **Uploads: content never validated, quarantine is dead code.** Only the client-declared MIME string and size are checked; nothing inspects bytes; nothing ever sets `status='quarantined'` (the download-side check guards a state no code produces); no AV scan on 25MB uploads from shared floor tablets, served same-origin. (`src/modules/core/documents.ts:63`) |
| SEC-3 | HIGH | **The app holds MinIO root credentials** — an app compromise yields object-storage admin, defeating bucket versioning. Needs a scoped service account. (`docker-compose.prod.yml:52`) |
| SEC-4 | MED | **Server Actions have no rate limiting.** `consume()` protects exactly six endpoints; every other write in the product — payroll runs, LC opens, approve commits — is unthrottled behind Caddy's body cap. |
| SEC-5 | MED | **Sliding 7-day sessions never expire on a daily-used shared tablet** (`updateAge` refresh-on-use); no idle timeout, no re-auth for sensitive ops. Password policy is length-only (min 10): no breach check, no lockout on failures. |
| SEC-6 | MED | **The worker's consumers run as `roles: ['owner']`** (STUBS L102) and the QC waiver is role-gated in code rather than routed through `pending_changes` (L94); RFQ role scoping is unenforced (L110). |
| SEC-7 | MED | **Wall-1 tenancy predicate coverage is ~40 of 60+ query files.** The lint allowlist exempts analytics, marbim, settings and several core files — those rely on RLS alone, the single-wall condition the second wall was built to end. Honest ratchet, open ledger. (`eslint.config.mjs:164-222`) |
| SEC-8 | LOW | Rate limiter fails open on Redis outage **including the auth path**; `/api/documents` GET is the one unauthenticated non-health route; 37 raw `console.*` calls bypass pino/Sentry — including company-provisioning failures and limiter-down, the two events most worth alerting; CSP retains `'unsafe-inline'` script-src (relevant given SEC-2). |

---

## 4 · Functional completeness — doors still missing

Product-reachable machinery with no way in, after the live test built twenty-plus:

- **Seven actions with no screen** (the reachability ratchet, current):
  `compliance/logTraining`, `compliance/saveCertificate` (→ the certificate expiry ladder
  — fire licence, boiler, bond — can never alert because nothing can file a certificate),
  `maintenance/reportMachine` (a broken machine cannot be reported from the floor),
  `memory/findSimilarStyles` (the "seed the next quote" card has no surface),
  `procurement/updatePoStatus` (a PO cannot move through its own lifecycle),
  and two superseded quality actions to delete or wire.
- **Payables have no entry door** — `requestPayablePayment` can update one, nothing can create one (live-test finding, Phase 8).
- **The entire PDF layer is absent**: `lib/pdf.ts` is a type union with no renderer and the `renderPdf` queue is deliberately unrouted. Nine documents a garment factory prints daily cannot be produced: PO PDF, packing list, payslips/disbursement export, quote PDF, buyer report pack, UD reconciliation, audit pack, Tally export, full-company export. (STUBS L32-49, L86-137)
- **Store returns/inspection flow** not built (L54); attendance arrives only via the CSV import built in Phase 9 — no device integration (L50).
- **Unwired events**: sample due-date reminders, allocation↔TNA links, `planning.sewing_window.changed` has no consumer, supplier reject quantities never fed from QC. (STUBS L64-89)
- **Requisitions cannot be cancelled** (live-test finding, Phase 5 — duplicate PR-1102 is still open in the tenant).

---

## 5 · Generalization — what blocks "other factories of this type"

The single-factory assumptions that must become configuration before a second, differently
shaped factory:

| ID | Item |
|----|------|
| GEN-1 | **Currency literals.** `'USD'` hardcoded in the close-consumer accrual (`consumers.ts:438` — flat literal, no fallback), the cash-shortfall scheduler, and ~10 client defaults; `'BDT'` sentinel in maintenance; `.default('USD'/'BDT')` baked into 10+ table schemas. `company_profiles.baseCurrency` exists and is not read by any of them. |
| GEN-2 | **Timezone duplications.** Two re-implementations of factory-time outside `lib/dates` (`scheduler.ts:66`, `commercial/jobs.ts:46`), both ignoring `company_profiles.timezone`, which every helper's docblock says to pass. |
| GEN-3 | **Policy defaults are industry norms, not the factory's numbers** (STUBS L117) — and policy is read by the *caller*, not fetched inside services (L116), so a call-site literal silently wins. Two different shift-length assumptions coexist (production tools default 10h, planning policy 480min). |
| GEN-4 | **AQL machinery is seeded narrow**: levels 2.5/4.0 only, inspection level II only, Z1.4 arrows resolved one way, 4-point per-linear-yard cap not applied. A buyer on 1.5/level I cannot be represented. (STUBS L80-83) |
| GEN-5 | **Four product types have TNA templates**; lead times and defect severities are judgement values marked "before pilot". (STUBS L113-115) |
| GEN-6 | **i18n is binary by department**: 5 floor route-trees translated, 20 desk trees hardcoded English (~90 screen files, zero resolver calls) — including `/approve`, where floor drafts get signed, and `/maintenance`. 141 desk refusal keys await Bangla (accurately ratcheted). A second factory wanting Bangla desks gets half a product. |
| GEN-7 | **Wage machinery is Bangladesh-statutory by construction** (2× OT, ÷208, gazette grades, festival bonuses) — correct for the market, but it is the *only* wage model; even a BD factory with different allowances needs the gazette door built in Phase 9, which covers grades but not rule variants. |
| GEN-8 | **`dd/mm/yyyy` display and viewer price redaction** each cover three screens and one desk respectively — both need their sweeps finished (Phase 9 rollout notes). |

---

## 6 · Contracts, tests and verification

| ID | Sev | Item |
|----|-----|------|
| VER-1 | HIGH | **15 of 23 modules have no HANDOFF contract** — including six ⚖ money/legal modules (costing, UD, shipment, compliance, commercial-finance) and the flagship order desk. The 8 that exist are retroactive and say so. `handoff-contract.test.ts` verifies only those 8. |
| VER-2 | HIGH | **Verification depth is inverted relative to risk**: `costing` — ⚖, margin-floor gate, a live precision bug found in plan 2.9 — has the thinnest test suite in the repo (501 lines). Unit coverage functions metric: 20.17%. Three `.tsx` component-test files exist for ~200 components. |
| VER-3 | HIGH | **The declared release gate does not exist.** `mixed_day` k6 is named by `testing-and-pressure.md` as *the* release gate; it is not built. The three baselines that exist were recorded on a developer laptop and say so; `production_burst` at 10 VUs on one cookie mostly measures the rate limiter. Three floor scenarios missing. |
| VER-4 | MED | **The e2e suite exercises no business transaction** — four tests proving sign-in, two role gates, and one board render, plus a five-screen a11y sweep. No GRN, no inspection, no approve→commit, no LC, no shipment travels end to end under Playwright. |
| VER-5 | MED | **The tracker documents have drifted behind the ratchets in both directions.** PROGRESS.md's module rows are false in six places (understating what shipped, including "handoffs/ is empty" with 8 files present); three documents still say 13 unwired actions where the ratchet says 7; the deploy runbook §6 claims protections don't exist that do. The *mechanisms* (reachability, i18n, coverage, drift tests) are trustworthy; the narrative isn't. |
| VER-6 | MED | **MARBIM has never called a live model.** The three vendor adapters, the tool loop and the fail-closed walls are built and well-tested against a mock that is honestly rule-based — but the SDK call bodies are unexercised, and one Anthropic tool-result path substitutes a placeholder. First live-key session must be supervised. |

---

## 7 · Operational readiness (beyond blockers)

- **Resource limits partial**: memory-only, none on caddy/pgbouncer/migrate; no CPU limits;
  no reservations — under pressure the OOM-killer chooses, and Postgres is the largest target.
- **All volumes are single-host local** — with backups unresolved, host loss is total loss.
  A full disk stalls the Redis queue silently.
- **Migrations take no advisory lock** despite two comments claiming they do (DB-M3);
  `audit_log` append-only rests on a single GRANT with no trigger backstop (DB-M6);
  the hourly-partition recovery path cannot work as written (DB-H3).
- **Seed covers 14 of 23 modules / ~39 of 143 tables** — a fresh factory starts with most
  screens legitimately empty, which the empty-states handle, but demos and training need
  the wider seed.
- **The deploy pipeline is manual** (CI builds and publishes; a human ssh-and-seds the
  digest). Fine while the builder is the operator; not a handover posture.
- Frontend platform debt from the audit ledger: design tokens defined but unused (812 raw
  px, 620 hardcoded fonts — Bengali's 1.4× expansion breaks in 620 places), no charting
  library (every specified sparkline/waterfall/trend missing), `DataTable` not virtualized.

---

## 8 · What is genuinely solid

For the reader deciding what to trust: the tenancy pattern (two walls, `SET LOCal` scoping,
boot-refusal of superuser/bypass roles), env validation, container hardening (non-root,
read-only FS, cap-drop, correct PID 1), security headers set in the app not the proxy,
secrets hygiene (clean history, gitleaks in CI), money discipline in `src/` (exact decimal
strings, ~30 correct `FOR UPDATE` sites, no unlocked balance read-modify-write found),
offline idempotency by `offline_key` on all 15 registered handlers, the state-machine and
gate patterns (every gate the live test poked held server-side), the honest self-labelling
culture (STUBS.md, retroactive handoffs that say so, coverage ratchets that only shrink),
and the mock provider that refuses rather than invents. The live test's conclusion stands:
the machinery is real; the gaps are doors, contracts and operations.

---

## 9 · Suggested sequencing

**Before any real factory data (days):** GL-1 keys · GL-6 script guards · GL-7 day-0
credentials · GL-8 auth fixes · GL-2/3/4 backups + rehearsal · GL-9 monitoring token +
external uptime check.

**Before Barakah runs unattended (weeks):** GL-5 payroll parallel-run · DL-1 offline
refusal contract (persist role refusals server-side, stamp capture identity, stop client
terminal-marking) · DL-2/3 outbox surfacing + dead-letter · DL-4 the UTC helper sweep ·
DL-5 fabric offline path · SEC-1 2FA for owner/admin/finance/hr · SEC-2 upload validation
· VER-1 handoffs for the six ⚖ modules · the PDF layer's first three documents (packing
list, payslip, PO) · GL-10 deploy wiring.

**Before a second factory (a quarter):** GEN-1..8 · VER-3 `mixed_day` on VPS-class
hardware · VER-4 transactional e2e · remaining doors (§4) · i18n desk sweep · VER-5 bring
the trackers back to truth and keep them there.

**Rolling:** DL-6..12, SEC-4..8, §7 items, the ratcheted lists (money files, wall-1
allowlist, AWAITING_BANGLA, NO_SCREEN_YET) — each already enforced shrink-only in CI.
