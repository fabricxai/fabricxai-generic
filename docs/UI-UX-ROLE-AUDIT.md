# UI/UX audit, role by role — and a mobile app shape for each

**Date:** 2026-08-12 · **Tenant:** Test Textile Ltd (seeded mid-flight factory + live-test-kit data)
**Method:** every one of the 17 roles signed in through the real UI (Playwright against `next dev`,
real services, real data). For each role: the landing page, the full navigation as that role sees
it, every reachable screen visited, its affordances counted. A second pass at 390×844 with touch
for the floor roles. Nothing in this document is inferred from code alone — every claim was seen
on a screen.

This document **records**. Fixes belong to their own commits; the findings here that already have
one are marked ✅ with the hash.

---

## 1 · The systemic findings (before any single role)

### S1 — The morning ritual is inconsistent across desks
"Your work" (`/home`) is the composed to-do queue, and whether a role gets one is accidental:

| Gets a composed home | Gets an **empty** home | Gets **no** home at all |
|---|---|---|
| owner, admin, merchandiser, store | commercial, quality, shipment (an empty state pointing at their board) | procurement, planner, cutting, hr, compliance, maintenance |

A commercial officer opens "Your work" and is told to go to the LC register; a procurement officer
does not have the page in their nav at all. Either every desk deserves a composed morning queue
(drafts to confirm + exceptions on their tables + documents waiting) or none does — the half-state
teaches people the page is furniture. **Recommendation:** compose the four missing desk queues the
way `desk-sections.ts` already does for store, and drop the empty-shell variant.

### S2 — Owner has two overlapping mornings
`/home` ("Your work") and `/dashboard` ("Today") both open with the exceptions feed; the dashboard
adds figures, home adds drafts and alerts. Two screens claiming to be the start of the day split
the habit. **Recommendation:** one owner morning screen — the dashboard's figures folded into home
as a strip, or home's queues folded into the dashboard. Keep only one in the nav's first section.

### S3 — Landing pages are the strongest single UX decision in the product
Nearly every role lands where their day actually starts, and this is worth protecting:
store → **/store/receive**, production → **/lines/hourly**, quality → **/quality/inline**,
commercial → /lcs, planner → /planning, cutting → /cutting. Two miss:
- **viewer** lands on `/marbim` (a chat box) when its only other capability is reading the order
  book — the order book is its natural home.
- **member** (no department yet) gets MARBIM + Settings and no explanation. The landing should say
  plainly: *"You don't have a desk yet — ask your admin to assign one"* instead of offering a
  copilot over an empty world.

### S4 — Two screens are walls of inputs
- `/costing` **lands** in "Cost a style" with **31 inputs** on screen. The costing studio is the
  destination for one task, not a board; landing inside the form means the merchandiser's most
  common visit (checking an existing sheet) starts in the wrong place.
- `/settings` is one page with **58 inputs** across every module's policy. It works for the
  once-a-quarter visit, but finding "cut tolerance" means scrolling past payroll. Sections exist;
  they need jump navigation or per-module pages.

### S5 — Production's nav is a supervisor drowning in doors
13 nav entries — orders, sampling, planning, store, cutting, quality, maintenance, setup… A line
supervisor's world is: **this hour, endline, downtime, and yesterday**. Compare cutting's tight 4.
Everything else is a read they need twice a month, not a rail item. The role-scoping *inside*
screens is right (their `/lines` shows only L1–L2); the rail hasn't had the same care.

### S6 — Mobile web is already respectable, and stops at "respectable"
At 390px: **zero horizontal scroll on all 12 screens tested** (the overflow containers hold), the
offline queue works on the floor writes, drop zones accept camera capture. What's missing for real
floor use: small tap targets in list rows (quality/final has 6 under 38px, owner home 11 — ghost
buttons and "See all" links), the sidebar nav pattern eats width, there's no install/home-screen
path (no PWA manifest), and nothing but the four floor writes survives a dead network. That gap is
what §3 (mobile apps) is for.

### S7 — The AI doors are now wide but two desks still type from paper
Eleven dialogs read documents (PO, SWIFT, UD, challan, gazette, audit report, proforma, hourly
sheet, cut sheet, packing list, nameplate). Still typing from paper: **finance** (bank realization
advice → `postRealization`; needs a bank submission to exist, untestable in this tenant today) and
**quality's measurement spec** (the chart → `measurement_spec` exists as a queued kind, but the
measurements screen itself has no inline door). Both are small, deferred deliberately, and should
follow the `fillsFormOnly` pattern.

### S8 — The approve inbox doesn't teach
Every role sees "Nothing waiting" with a paragraph about rules. New factories run for days before
the first draft routes anywhere, and nobody learns what *would* arrive. The empty state should show
the three kinds of thing that land here for *this* role, each with the door that raises one.

---

## 2 · Role by role

Format: **world** (nav size → what it holds) · **operations** (what they actually do) ·
**convenience** (how many steps to their most frequent action, and what got in the way) ·
**friction** (specific, observed).

### Owner — 26 nav entries
- **World:** everything. Landing `/home` with exceptions, drafts, alerts, desk summaries.
- **Operations:** read exceptions → decide; approve drafts; occasionally do any desk's work.
- **Convenience:** exceptions now read as sentences naming the PO (✅ `bfb831d`). Approving is one
  click from home. Good.
- **Friction:** S2 (two mornings). 26 rail items means the rail is a directory, not a map —
  grouping headers help but an owner mostly lives in 4 of them. `/memory` ("Nothing compiled yet")
  and `/refused` (empty) are permanent rail residents for screens that matter rarely — candidates
  for burying under Oversight until non-empty (badge them instead).

### Admin — 26 entries, owner's twin
- **Operations:** setup, roles, policies; covers any desk.
- **Convenience:** same as owner. The one difference observed: `/workforce` shows the floor but
  **no payroll doors** — correctly, payroll is hr+owner (rule 9). The screen doesn't say *why* the
  buttons are absent; an admin covering for HR will think it's broken. One sentence would fix it.

### Merchandiser — 13 entries
- **World:** orders, sampling, RFQ, buyers, costing, planning (read), shipment.
- **Operations:** book orders (AI-fillable ✅), breakdowns, schedules, cost sheets, samples, quotes.
- **Convenience:** the busiest desk and mostly 1–2 clicks. New order reads the PO off the paper.
- **Friction:** S4 — `/costing` lands inside the 31-input form. The sampling room's "2 samples"
  list is fine but offers no path from a sample to its order's TNA milestone (the PP gate it
  controls) — you go via the order desk. The RFQ drawer is dense (10 state hooks) but matches the
  job.

### Commercial — 14 entries
- **World:** LC register (landing), UD workbench, bank docs, finance, procurement, shipment, orders.
- **Operations:** record credits (AI ✅), BTBs, UDs (AI ✅), submissions, realizations.
- **Convenience:** landing on the register with the two working credits and float visible is
  right. Recording a credit off the SWIFT is now the fastest data entry in the product.
- **Friction:** empty "Your work" (S1). The register rows don't show BTB headroom until you open
  the credit — the number that decides whether the next BTB can open belongs on the row. 14 nav
  entries is wide; finance + procurement are reads they need, but "Buyer & lead desk" and "RFQ"
  are merchandising's.

### Procurement — 6 entries (tight, good)
- **World:** procurement (landing), store (read), setup.
- **Operations:** requisitions, quotes (screen + AI built this session ✅ `740ae91`), POs behind
  the BTB gate, receipts, scorecard.
- **Convenience:** everything on one board; quote comparison ranks on landed cost.
- **Friction:** no morning queue (S1) — overdue POs and urgent PRs are computed on the board but
  nothing pushes them. The BTB-gate refusal on an import PO is server-side only; the PO form
  doesn't show remaining headroom *before* submit.

### Store — 9 entries
- **World:** lands **directly on receive** — the single best landing in the app. Issue, rolls,
  UD workbench, procurement (read).
- **Operations:** receive (challan photo AI ✅ `8786127`), issue against requisitions (UD gate,
  shade warning), adjustments via approval.
- **Convenience:** receive is one screen, one drop, check, save. Issue is requisition-driven with
  the reason explained when empty.
- **Friction:** the rolls list doesn't filter by shade group — the shade-mix warning names groups
  the storekeeper then hunts for manually. Mobile: two <38px taps on receive (remove/replace links).

### Planner — 9 entries
- **World:** planning board (landing), lines, cutting, orders (read).
- **Operations:** working week, allocations with overload arithmetic, SMV capture, moves —
  all built this session (✅ `b1fbf3b`).
- **Convenience:** was zero-capability before; now book-a-line is one dialog with the run
  previewed. Good.
- **Friction:** the board is read-heavy on mobile (14 columns × 8 lines); fine on desktop. No
  morning queue (S1): "which runs start today / which lines are idle tomorrow" is computed but
  not surfaced as a to-do.

### Cutting — 4 entries (the tightest, and right)
- **World:** cutting queue (landing), lay, report, wastage.
- **Operations:** start lays behind the PP gate, file cut reports (sheet-photo AI wired ✅
  `217d17d`, not yet driven end-to-end — no open lay in this tenant), corrections via approval.
- **Convenience:** queue → lay → report is linear and matches the physical flow. Refusals (PP ✗,
  no issued rolls) are explained in sentences on the card.
- **Friction:** none observed beyond the untested AI door. This role's shape should be the template
  for the other floor roles.

### Production — 13 entries (S5: too many)
- **World:** lands on **this hour** (right); endline, downtime, plan-day; then a long tail of
  other departments' screens.
- **Operations:** hourly output (now also whole-day sheet catch-up ✅ `c6f4395`), downtime →
  auto-ticket, endline counts.
- **Convenience:** the hourly screen is genuinely fast — line rows, one box each, save. Line
  scoping works (supervisor sees only L1/L2).
- **Friction:** S5. Also `/planning` in their nav renders the board with zero action buttons — a
  read-only screen that looks broken rather than deliberate; label it or drop it from the rail.

### Quality — 8 entries
- **World:** lands on inline walk (right); fabric 4-point, final inspection, measurements.
- **Operations:** inline defect taps against DHU targets, 4-point sheets, AQL final inspections
  (lot now sized from *finished* goods ✅ `59a3014`), measurement records.
- **Convenience:** inline is tap-first and fast. Final inspection explains its plan.
- **Friction:** mobile — 6 tap targets under 38px on `/quality/final` (the Inspect/Re-inspect ghost
  buttons in rows); an inspector holds a phone in one hand. The measurement spec still enters by
  typing (S7).

### Shipment — 5 entries
- **World:** one board holding **ten operations** (open, pack, packing list, ex-factory, EXP,
  doc checklist, bank submission, tolerance exception, late-shipment acceptance).
- **Operations:** everything order-to-vessel-to-bank.
- **Convenience:** complete — and crowded. The board is a wall of doors with no sequence; the
  operations have a natural order (pack → ex-factory → EXP → docs → bank) the layout doesn't show.
- **Friction:** empty "Your work" (S1). Packing-list AI wired ✅ (`217d17d`) but not driven — no
  shipment mid-pack in this tenant. **Recommendation:** render the board as the pipeline it is,
  each shipment a row moving left-to-right through those stages.

### Finance — 6 entries
- **World:** finance board (landing), costing (read), LC register (read).
- **Operations:** invoices (from shipments), payments, accruals; realizations live on the LC side.
- **Convenience:** raise-invoice correctly picks from shipments, not orders.
- **Friction:** the one desk with **no AI door at all** (S7 — realization advice deferred). No
  morning queue; overdue receivables are on the board but nothing ranks "chase today".

### HR — 5 entries
- **World:** workforce (landing) with the four payroll doors in sequence.
- **Operations:** gazette (AI ✅), device-CSV attendance import, compute → approve payroll runs.
- **Convenience:** the four doors are labelled as a sequence — the best "guided flow" in the app.
- **Friction:** worker registry lives in `/setup` (admin's screen) while HR's own screen has
  "Add worker" only via setup access — the door is one nav item away from where an HR officer
  would look. The attendance import correctly refuses to guess punches.

### Compliance — 5 entries
- **World:** compliance board (landing), UD workbench (read).
- **Operations:** audits + findings (report AI ✅ `8786127`), CAPs with owners/deadlines, evidence.
- **Convenience:** log-audit dialog reads the findings out of the report; CAPs stay human. Right.
- **Friction:** minor — the CAP list mixes "needs evidence" and "waiting on closure" without a
  filter; at 2 items it's fine, at 30 it won't be.

### Maintenance — 4 entries
- **World:** tickets (landing), PM schedule, registry.
- **Operations:** claim/resolve tickets (auto-raised from downtime), PM completions, machine
  registry (nameplate-photo AI ✅ `217d17d`).
- **Convenience:** ticket loop closes fast; downtime → ticket → claim is the product's best
  cross-module handshake.
- **Friction:** 3 small taps on mobile in the ticket rows. PM overdue state is visible but not
  pushed anywhere (no morning queue, S1).

### Viewer — 3 entries
- **World:** MARBIM (landing), orders (read), settings.
- **Friction:** S3 — lands on chat instead of the order book, which is the only thing it can
  actually browse. A buying-house guest given viewer access sees an input box, not the factory.

### Member — 2 entries
- **World:** MARBIM + settings. A person awaiting a role.
- **Friction:** S3 — nothing tells them they're waiting for a desk assignment. One sentence on
  the landing would prevent every "my account is broken" message.

---

## 3 · The mobile app, per role

**Platform recommendation first:** one codebase (React Native or a thin installable PWA over the
existing screens — the responsive work already holds, see S6), shipped as **role skins**: the
same shell, offline queue, camera pipeline and push plumbing, with each role getting its own home
tab set and nothing else. Not seventeen apps — **five floor skins, two desk skins, one owner skin**,
and two roles that deliberately get no app. The floor skins matter most: they are used standing
up, one-handed, on factory Wi-Fi that drops.

What every skin shares: offline-first writes through the existing `offline_key` queue, camera →
drop-zone pipeline (already proven on challan/nameplate/hourly sheet), Bangla-first copy, push on
the role's own exceptions, and **no** settings/admin surface (that stays on desktop).

### 3.1 Store — "the truck app"
- **Home:** two buttons: **Receive** and **Issue**. Nothing else above the fold.
- **Core loop:** photograph challan → fields fill → check → save (already works on mobile web);
  issue = scan/pick requisition → pick rolls (large row cards, shade group color-coded) → gate
  verdicts as full-screen interrupts (UD block, shade warning).
- **Mobile-specific:** barcode/QR scan on roll numbers; UD balance as a persistent pill while
  issuing bonded stock.
- **Offline:** full — receive and issue both queue today.
- **Push:** GRN inspection results; requisition raised against the store.

### 3.2 Production supervisor — "the hour app"
- **Home:** the current hour's card for *their* lines only. One number pad. Swipe left = previous
  hours of today (the paper-sheet replacement, aiming to retire the 7pm catch-up).
- **Core loop:** hour → per-line count → save; long-press a line = downtime with reason chips;
  the auto-ticket confirmation shows *who claimed it* when maintenance responds.
- **Mobile-specific:** the wallboard as a landscape mode; end of day = photograph the paper sheet
  (already built) for lines still on clipboards.
- **Offline:** full (hourly + endline already queue).
- **Push:** run-rate slipping vs the day plan; their downtime ticket claimed/resolved.

### 3.3 Quality — "the walk app"
- **Home:** the line walk. Big defect-category tiles (taxonomy-driven), tap = one defect, the DHU
  dial updates live. This is the screen most worth native feel — an inspector taps hundreds of
  times a day.
- **Core loop:** inline walk; secondary tabs: 4-point (roll photo → points), final inspection
  (AQL plan stated, tally counter UI), measurement spec capture by chart photo (build the S7 door
  first).
- **Mobile-specific:** fix the six small taps on final; tally counters must be thumb-sized.
- **Offline:** full for inline; final inspection can queue.
- **Push:** a lot became inspectable (finished qty crossed sample size); repeat-defect alert on a
  line they walk.

### 3.4 Cutting — "the table app"
- **Home:** the queue as cards, gate state front and centre (PP ✗ = grey with the reason, ready =
  amber). Tap = lay form with marker math live.
- **Core loop:** start lay → report cut (sheet photo already wired) → bundle QR printing handed to
  a desk printer.
- **Offline:** lay + report queue.
- **Push:** PP approval flipped an order cuttable; cut-tolerance override approved.

### 3.5 Maintenance — "the ticket app"
- **Home:** open tickets sorted by line-down first. Claim with one tap; resolve with a photo.
- **Core loop:** push arrives (downtime auto-ticket) → claim → machine card (history, PM due) →
  resolve. Registry additions by nameplate photo (already wired).
- **Mobile-specific:** this role barely needs the desktop at all — the app *is* the product for
  them. PM checklist as swipe-to-complete.
- **Offline:** claims/resolutions queue; the registry needs connectivity (reads the fleet).
- **Push:** new ticket (line down = loud), PM overdue.

### 3.6 Shipment — "the carton app"
- **Home:** the active shipment as a pipeline (pack → ex-factory → EXP → docs → bank), current
  stage expanded.
- **Core loop:** packing floor with a running packed-vs-finished bar and the over-pack gate as a
  full-screen stop; packing-list photo import (wired); EXP + ex-factory as single-field actions.
  Document assembly and bank submission stay on desktop — they're two-monitor work.
- **Offline:** pack_carton queues (already).
- **Push:** finished goods crossed a packable threshold; LC latest-shipment countdown (3/1-day).

### 3.7 Merchandiser + Commercial — "the desk app" (one skin, two tabs configs)
Their real work (costing, breakdowns, TNA templates, bank docs) is desktop work. The phone version
is for the parts of their day that happen *away* from the desk:
- **Home:** their order book with health chips; tap = the order's TNA and run-rate.
- **Capture:** the camera → intake pipeline for whatever paper reaches them first (PO, SWIFT,
  proforma) so the document is in the system before they're back at the desk; the reading waits
  in "Your work" to confirm on desktop.
- **Confirm:** the raiser-confirm dialog (already mobile-clean) — check a reading from anywhere.
- **Push:** merchandiser — PP verdicts, TNA slips on their orders; commercial — LC countdowns,
  BTB headroom crossings, realization landed.

### 3.8 Owner / Admin — "the pulse app"
Read-mostly, decision-sometimes:
- **Home:** the exceptions feed exactly as now worded (subjects + sentences), then approvals.
- **Approve:** full approve/reject with corrections — the one write this app has.
- **Figures:** the dashboard tiles (OTD, DHU, efficiency, cash) as swipeable cards; every number
  carries its denominator and as-of, same as desktop.
- **Push:** high-severity exceptions, drafts aging past the escalation window, payroll run awaiting
  approval, UD overdraw approved (the audit-worthy one).
- **Deliberately absent:** settings, role grants, policy edits — changing the rules of the factory
  is desk work.

### 3.9 HR / Compliance / Finance / Planner — no dedicated skin (yet)
Monthly-cadence (payroll), evidence-heavy (compliance), two-monitor (finance), and wide-canvas
(planning board) work respectively. The desk app's capture + confirm + push covers their mobile
needs. Revisit HR if attendance-device photos become an import path, and compliance for
evidence-photo capture against CAPs — that one is a natural phone job and the first candidate to
graduate to its own skin.

### Viewer / Member — no app
The web is enough for read-only access, and member has nothing to do anywhere yet.

---

## 4 · Priorities

**P1 — worth doing before more feature work**
1. S1: compose the missing desk homes (procurement, planner, cutting, hr, compliance, maintenance)
   and fill the three empty ones. One pattern exists; it's replication.
2. S3: viewer lands on the order book; member's landing explains the wait.
3. Quality/final + maintenance tap targets to ≥44px (the two floor screens with real counts).

**P2 — structural, scheduled**
4. S2: merge the owner's two mornings.
5. Shipment board → pipeline layout.
6. S4: costing lands on the sheet list; settings gets per-module jump nav.
7. S5: trim production's rail to its four working screens + "everything else" group.
8. S7: the last two AI doors (finance realization advice, measurement chart inline).

**P3 — the mobile programme**
9. PWA manifest + install prompt as the cheapest first step (the responsive base already holds).
10. Floor skins in the order of daily write volume: production → store → quality → maintenance →
    cutting → shipment.
11. Desk and pulse skins after push infrastructure exists.

---

*Audit artifacts: `role-audit.json` (per-role screen inventory) in the session scratchpad;
screenshots under `shots3/`. The sweep scripts were temporary and deleted; the method is described
at the top so it can be re-run.*
