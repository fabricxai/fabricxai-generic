# FabricXAI — UI/UX Build Plan (from the role audit)

**Created:** 2026-08-12, from `docs/UI-UX-ROLE-AUDIT.md` (finding IDs S1–S8 and the per-role
friction list are defined there; this plan does not restate the evidence).
**Scope:** everything the audit raised — desk convenience, structural UX, the last AI doors, and
the mobile programme. **Not in scope and still outranking all of it:** the five leaked API keys
(GL-1, unrotated), `RATE_LIMIT_DISABLED=1` in production, and the shared test password — those are
go-live gates, not UX work, and nothing below should ship to a real factory before them.
**How to use:** phases are ordered by value-per-effort; tasks inside a phase are sized to roughly
one working session unless marked ⏳ (multi-session). Tick tasks here and note the commit, same
convention as `PRODUCTION-READINESS-PLAN.md`. **Do not start until told to** — this document is
the agreement about what to build, not the start of building it.

Legend: 🅗 high · 🅜 medium · 🅛 low · ⏳ multi-session

**Standing conventions for every task below** (stated once, assumed everywhere):
- Local gate before each commit: `npx tsc --noEmit && pnpm lint && pnpm test && pnpm build`;
  integration suite when a module's service/queries change. No CI runs until a deploy is wanted.
- Ratchets that will catch this work: `nav-copy` (any new/renamed nav entry needs en+bn+locked),
  `error-copy` (any new thrown key needs a sentence, no placeholders), `AWAITING_BANGLA` (only
  shrinks), `design-tokens` (no invented tokens), `access.test.ts` route sweep (any new route
  needs a NAV entry). Satisfy with real content, never by suppressing.
- No JSON, no raw identifiers, no bare UUIDs anywhere a user reads (standing rule).
- Screens change here, not module contracts — no HANDOFF needed for Phases 1–3. Phase 4's mobile
  shell is new surface area and gets its own written contract before build (see 4.0).

---

## Phase 1 — The morning ritual and the two bad landings (audit P1)

The highest-leverage fix in the audit: six desks have no composed home, three have an empty shell.
The pattern already exists (`src/app/(app)/home/desk-sections.ts` composes store's queue); this
phase is replication with each desk's own signals, not invention.

- [x] **1.1 🅗 Desk home: procurement.** ✅ (this commit) — Compose from existing queries: urgent PRs
  (`daysToNeeded ≤ 7`), overdue POs (`daysToDelivery < 0`), quotes awaiting comparison on quoted
  PRs, GRN receipts pending against issued POs. Add `procurement` to `deskRoleFor` and give the
  role `/home` in `nav.ts` (landing stays `/procurement`).
  *Verify:* signs in as procurement → `/home` shows the three queues with live counts; empty
  tenant shows the calm state with links, not a shell. Browser test in `__tests__/browser/`
  asserting section presence per role.
- [x] **1.2 🅗 Desk home: planner.** ✅ — Queues: runs starting today (allocations with
  `startDate = today`, status `planned`), lines idle tomorrow (working calendar day with zero
  committed), orders confirmed but unallocated (the picker's own filter, reused).
  *Verify:* as 1.1.
- [x] **1.3 🅗 Desk home: cutting.** ✅ — Queues: orders newly cuttable (PP flipped, rolls issued,
  no open lay), lays open past N days, cut reports awaiting correction approval.
  *Verify:* as 1.1.
- [x] **1.4 🅜 Desk home: maintenance.** ✅ — Queues: unclaimed tickets (line-down first), PM overdue,
  tickets claimed by me. This is also the skeleton the mobile ticket app reuses (4.4).
  *Verify:* as 1.1.
- [x] **1.5 🅜 Desk home: hr + compliance.** ✅ — HR: payroll run state (which door of the four is
  next), attendance import gaps (days with no device rows), gazette awaiting activation.
  Compliance: CAPs by deadline, findings with no CAP, audits with no findings logged.
  *Verify:* as 1.1. One commit per desk.
- [x] **1.6 🅗 Fill the three empty homes.** ✅ — narrower than planned, honestly: all three already composed real sections and the audit had caught their CALM state. Commercial already carried every signal 1.6 named (headroom, countdowns, discrepants). Added quality's genuinely missing one — finished-and-never-inspected, powered by the new finishedQty. Shipment's two existing sections (no-EXP, closing dates) judged sufficient; a stalled-stage queue folds into 2.2's pipeline instead. These roles HAVE
  `/home` and it renders a pointer. Commercial: LC date countdowns (≤7d), BTB headroom below
  threshold, submissions in `preparing`, realizations unposted past N days. Quality: lots newly
  inspectable (finished > 0, never inspected), failed finals awaiting re-inspection, DHU above
  target yesterday. Shipment: shipments by pipeline stage with the stalled one flagged, EXP
  missing on confirmed ex-factory.
  *Verify:* none of the three shows "Nothing waiting" when their board has live work.
- [x] **1.7 🅜 Viewer → order book; member told they're waiting.** ✅ —
  `resolveLanding` (or the redirect in `(app)/layout.tsx`): viewer → `/orders`; member keeps
  `/marbim` but the empty surface says *"You don't have a desk yet — ask your admin to assign
  one"* with the admin's name when resolvable.
  *Verify:* both roles' landing asserted in the access/landing test; copy en+bn.
- [x] **1.8 🅜 Floor tap targets to ≥44px.** ✅ — fixed at the Button component: minHeight follows the density token at EVERY size, not only lg. Re-measured at 390px: 0 sub-44px buttons on quality/final, maintenance, store/receive. The audited counts: `/quality/final` (6 <38px —
  the Inspect/Re-inspect ghosts), `/maintenance` (3 — ticket row actions), owner `/home` "See
  all"/"Open →" links (11 — acceptable on desktop, but the same component serves mobile).
  Fix at the component level (`Button variant="ghost"` minimum hit area via padding, not font),
  so every consumer inherits it.
  *Verify:* re-run the 390px sweep from the audit method; counts drop to 0 on the two floor
  screens. No visual regression on desktop (`test:e2e` axe pass still green).

---

## Phase 2 — Structural UX (audit P2)

- [x] **2.1 🅗 ⏳ One owner morning (S2).** ✅ — plus one standing-rule violation fixed in passing: the buyer scorecard printed `buyerId.slice(0,8)`, a truncated uuid; buyers now show their names. Merge `/dashboard` into `/home` for owner/admin:
  home keeps its queue sections and gains a figures strip (OTD, DHU, efficiency, cash — each with
  denominator and as-of, exactly as the dashboard renders them); `/dashboard` becomes a redirect.
  Nav loses one entry. **Decision recorded here so it isn't relitigated:** home wins because the
  queues are actionable and figures are context — an owner acts first, reads second.
  *Verify:* owner nav has one morning entry; `/dashboard` 307s to `/home`; the figures strip
  renders the same numbers the dashboard did (snapshot the four values in a browser test);
  exceptions still read as sentences.
- [ ] **2.2 🅗 Shipment board → pipeline (S6-adjacent, the audit's shipment finding).** Render
  each shipment as a row moving left-to-right through pack → ex-factory → EXP → docs → bank;
  the ten operations become stage-local actions on the row instead of a wall of doors. No service
  changes — this is layout over the existing actions.
  *Verify:* every operation still reachable (browser test enumerates the ten action names);
  a shipment mid-pack shows pack expanded and bank greyed with the reason.
- [x] **2.3 🅜 Costing lands on the sheet list (S4a).** ✅ — the studio sits behind a "Cost a style" door; an RFQ seed still opens it expanded, because a deep link into a door in front of a door helps nobody. `/costing` shows existing sheets +
  "Cost a style" as an action; the 31-input form moves behind it (same component, new route or
  dialog state). Deep links that land in the form today keep working.
  *Verify:* landing shows the list; the merchandiser's two paths (new sheet, open existing) are
  each one click.
- [x] **2.4 🅜 Settings gets per-module jump nav (S4b).** ✅ — eleven anchors: the six top sections plus the five policy concerns. Left-rail anchor list (module names)
  over the existing single page — no data changes, no per-module routes yet. 58 inputs stay,
  findable.
  *Verify:* clicking a module name scrolls/focuses its section; keyboard reachable.
- [x] **2.5 🅜 Trim production's rail (S5).** ✅ — new `railHiddenFor` on NavItem, presentation-only; four unit cases pin that access is untouched, an owner still sees everything, and a production+planner keeps the union. Keep: this hour, endline, plan day, line tracking,
  maintenance (they raise tickets), MARBIM, settings. Move orders/sampling/planning/store/quality/
  setup out of the rail for this role — they keep ACCESS (routes stay open; `canSee` unchanged)
  but the rail shows a "More…" group or drops them. **Not an access change** — nav presentation
  only, so no role-gate tests move.
  *Verify:* production's rail ≤8 entries; every removed route still opens by URL for the role
  (access sweep unchanged); nav-copy ratchet clean.
- [x] **2.6 🅜 The approve inbox teaches (S8).** ✅ — derived from the tenant's own active rules + the intake registry; supervisors are told about the fallback; no rules at all is said plainly with the settings link. Empty state lists the 2–3 draft kinds that
  route to THIS role's queue (derived from `approval_rules` + intake kinds), each with the door
  that raises one. No rules configured → says that, with the settings link for owner/admin.
  *Verify:* per-role browser test: commercial's empty inbox names UD overrides and LC drafts;
  a viewer's names nothing and says why.
- [ ] **2.7 🅜 Per-role friction sweep (the audit's small ones, one commit each or batched):**
  - ~~2.7a~~ already satisfied — the register rows carry the used % with over-limit colouring (the audit sweep itself recorded "39.8%"). BTB headroom on the LC register rows (free amount + % as a chip; red under
    threshold). *Verify:* row shows the same number the credit detail computes.
  - [x] **2.7b** ✅ signposted — the roster heading links to setup's worker door; a second copy of the form would drift from the first. HR gets the worker door on `/workforce` (reuse setup's worker panel; grant stays
    as-is — HR already holds it via setup).
  - [x] **2.7c** ✅ — chips appear only when more than one group exists. Rolls list filters by shade group; the shade-mix warning's group names become
    filter links.
  - ~~2.7d~~ already satisfied — the LockedState has said "Payroll is HR and the owner only" since day-one finding D2. Admin's `/workforce` states why payroll doors are absent ("Payroll needs the hr
    role — supervision doesn't cover pay", en+bn).
  - [x] **2.7e** ✅ — URL-param chips (sendable to the CAP's owner), shown only past two rows. CAP list filter: needs-evidence / waiting-closure / overdue.
  - ~~2.7f~~ void — 2.5 dropped planning from production's rail. Planner's read-only `/planning` render for production role gets a "view only"
    eyebrow instead of looking broken; or drop it from production's rail in 2.5 (decide there —
    if 2.5 drops it, 2.7f is void).
  - [x] **2.7g** ✅ — "gates cutting on <PO> →" on every pending PP card. Also fixed in passing: the sample order picker printed `row.id.slice(0,8)`. Sampling → the order's TNA milestone: a "gates cutting on <order>" link on the
    sample card.
  - [x] **2.7h** ✅ via 1.8 (re-measured 0). Store receive's two <38px links (remove/replace on the attached photo) — covered
    by 1.8's component fix; verify here specifically.

---

## Phase 3 — The last two AI doors (S7)

Both follow the `fillsFormOnly` pattern established this week (schema → intake kind → TARGET_NOTES
→ ReadIntoForm in the dialog → verify against a real document). The blocker for both is fixture
data, not code — do the fixtures first.

- [ ] **3.0 🅜 Fixtures: a bank submission and a measurement spec in Test Textile.** Drive the
  kit's shipment SHP-2044-1 far enough through the real services that a submission exists in
  `preparing`/`submitted` (packing → ex-factory → EXP → docs → submission), and confirm the
  measurement chart kind (`measurement_chart`, already queued-path) has a target order. Extend
  `seed-kit-materials.ts` behind an existence guard, same idempotency style as the rest.
  *Verify:* re-runnable; `doc_submissions` has one row for the kit shipment.
- [ ] **3.1 🅜 Finance: the bank realization advice.** `realization_from_advice_v1` draft schema
  (realized amount, value date, charges/deductions as stated-only fields — never zeroed, same
  `stated()` rule as the proforma), intake kind `bank_advice` (`fillsFormOnly`, roles finance +
  commercial), TARGET_NOTES for the advice's shape (the credited figure vs the invoice figure;
  deductions are the bank's own line items; the shortfall reason stays HUMAN — `postRealization`
  requires it above the policy threshold and a model must not draft an explanation of a dispute).
  Dialog on the submission row. Test against the kit's `16-bank-realization-advice-EBL.pdf`.
  *Verify:* the kit advice fills amount + date; shortfall reason field stays empty and required
  when the gap exceeds policy; the same hourly limit + ledger row as every reading.
- [ ] **3.2 🅜 Quality: the measurement chart, inline.** The queued kind exists; add the inline
  door on `/quality/measurements` — "load the spec off the chart" filling the spec editor
  (points, spec values, tolerances with the fold-across rule the zod already has). Test against
  `19-measurement-sheet-PP-PHOTO.jpg`.
  *Verify:* the photo fills ≥ the chart's stated points; symmetric "Tol ±" folds to both columns;
  a size column the chart lacks stays absent.
- [ ] **3.3 🅛 Drive the two untested doors end-to-end (cutting sheet, packing list).** Blocked
  on fixtures the same way: an open lay for `LAY-32` (cutting) and the 3.0 shipment mid-pack.
  Not new code — the audit's honest caveat closed.
  *Verify:* kit photo `09-cutting-sheet-LAY-32-PHOTO.jpg` fills the report's actual column;
  `14-packing-list-SHP-2044-1-draft.pdf` packs cartons through the over-pack gate.

---

## Phase 4 — The mobile programme (audit P3) ⏳

Sequenced so each step ships value alone; stop-anywhere is safe. The audit's platform decision
stands: **one codebase, role skins** — start as an installable PWA over the existing responsive
screens (proven: zero horizontal scroll), graduate to React Native only if push/camera limits
demand it. **Push is the long pole** — nothing in 4.2+ lands without 4.1.

- [ ] **4.0 🅗 The mobile contract, written before build.** One document (`docs/05-owner-app/` is
  the precedent folder): per-skin screen list from audit §3, the offline write set (exactly the
  existing `offline_key` operations, no new ones), push event list per role, and what is
  DELIBERATELY absent (settings, role grants, policy edits, document assembly). This is the
  HANDOFF-equivalent for new surface area — the audit's §3 is the draft; this makes it the
  agreement.
  *Verify:* reviewed and ticked here before any 4.x code.
- [ ] **4.1 🅗 ⏳ PWA base + push infrastructure.** Manifest + service worker + install prompt
  (cache-first shell, network-first data); web-push subscription storage (per user+device,
  tenant-scoped table, ⚖ not needed — it's addressing, not money) and a `notifications`-to-push
  bridge in the worker (the in-app notification table already exists and is read by `/home` —
  push is a second delivery channel for the same rows, not a new event system).
  *Verify:* installable on Android Chrome (Lighthouse PWA pass); a seeded notification reaches a
  subscribed device; unsubscribed devices get nothing; k6 unaffected.
- [ ] **4.2 🅜 ⏳ Floor skin 1: production ("the hour app").** Role-keyed mobile home (current
  hour card, their lines only, number pad, downtime long-press). Push: run-rate slip, ticket
  claimed. The existing screens already work at 390px — this is a mobile-first re-layout of the
  hourly client behind a viewport/installed-app check, not a fork.
  *Verify:* the audit's mobile sweep on the new layout (0 hscroll, 0 <44px taps); hour save →
  offline queue → sync round-trip on airplane-mode toggle.
- [ ] **4.3 🅜 Floor skin 2: store ("the truck app").** Receive/Issue two-button home; challan
  photo flow is already built — the work is layout + the UD-balance pill during bonded issues +
  shade colour-coding on roll cards (2.7c's filter reused).
  *Verify:* as 4.2; a bonded issue on mobile shows the balance pill and the gate refusal
  full-screen.
- [ ] **4.4 🅜 Floor skins 3–5: quality, maintenance, cutting.** In that order (tap volume).
  Quality: defect-tile walk with live DHU dial. Maintenance: ticket claim/resolve with photo —
  reuses 1.4's queue. Cutting: queue cards with gate state, lay + report.
  *Verify:* per-skin as 4.2. One session each once 4.2's pattern exists.
- [ ] **4.5 🅛 Shipment skin ("the carton app") + desk/pulse skins.** Carton: packing floor with
  packed-vs-finished bar (over-pack gate full-screen). Desk (merchandiser/commercial): order book
  + capture + confirm-reading. Pulse (owner/admin): exceptions + approve + figures cards; the one
  write is approve/reject. All three are thin over existing screens.
  *Verify:* per-skin as 4.2; pulse app's approve round-trips a real draft.

---

## Sequencing notes and dependencies

- Phase 1 has no dependencies and every task is independently shippable — it can interleave with
  anything.
- 2.5 before 2.7f (one may void the other). 2.1 is the only structural task that changes owner
  navigation — do it in a quiet window, it retrains the most important user's habit.
- 3.0 gates 3.1 and 3.3; 3.2 is independent.
- 4.0 gates all of Phase 4; 4.1 gates 4.2–4.5. Phases 1–3 do not wait for Phase 4 and vice versa.
- The go-live gates (key rotation, rate limiting, password reset, `day0-run.log` cleanup) are not
  in this plan and remain ahead of all of it for any real-factory deployment.

**Estimated shape:** Phase 1 ≈ 8 sessions · Phase 2 ≈ 8–10 · Phase 3 ≈ 4–5 · Phase 4 ≈ 12–15.
Phases 1–3 together are roughly the size of the AI-doors programme just completed.
