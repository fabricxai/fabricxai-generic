# Live test · Barakah Fashions Ltd — what is prepared, and where reality differs from the kit

The kit's `00-LIVE-TEST-RUNBOOK.md` stays the script. This page is the local knowledge:
what is already loaded on `https://baraka.fabricxai.com`, who signs in as whom, and the
places where the platform's real shape differs from what the runbook assumes. Read this
once before Phase 1; keep the runbook open while testing.

## Accounts

- **Owner is `arif007lotus@gmail.com`** with the password chosen at signup. The kit's
  `owner@barakah.test` from the credential sheet **does not exist** — deliberately; the
  real signup owner replaced the fixture. Every runbook step that says "owner" is Arif.
- The other 17 (`admin@barakah.test` … `viewer@barakah.test`) exist, are verified, and use
  the one-time passwords from the day-0 run (`~/day0-run.log` on the VPS — ignore its
  first line, that account is gone). Passwords are long and random: **paste, don't type**.
- Side-by-side accounts: use one normal window + one incognito, or two browsers. Ten
  sign-ins per 5 minutes per IP is the limiter — an office full of testers sharing one IP
  can trip it; that reads as "login broken" and is not.

## Already loaded (do not re-enter)

| Phase 0 item | State |
|---|---|
| Company profile, factory tree, 18 users, roles+scopes | ✔ seeded day-0 (knit-composite; U1 L1–L6, U2 L7–L8, KM-01..03) |
| Approval rules, TNA templates ×2, wage grades 1–4, consumption polo 255 g/pc, margin floor 10% | ✔ |
| Defect codes | ✔ — but **semantic names**, see deviations |
| Buyers **Bestseller A/S (BSL)** and **H&M (HM)** | ✔ — created through the real lead→convert path, as Rashida and Imran |
| Workers BF-0001…BF-0040 (grades 2–4, lines L1/L2/L3/L7/L8) | ✔ |
| Machines OV-3-114 (overlock, L3), SN-1-021 (single needle, L1), KM-01..03 | ✔ |
| Store items YRN-30-1, GRG-PIQ, FAB-PIQ-180, FAB-DEN-12, TRM-PLK, TRM-ZIP | ✔ |

Phase 0's **exit check still applies**: sign in as `viewer@barakah.test` → no Settings, no
payroll in the nav, prices masked. Start there.

## Where the platform differs from the runbook — expected, not failures

1. **"Drop the PDF → draft appears" is really "intake: say what it is, paste the text".**
   There is no OCR and no PDF parser — by design today, `readDocument` requires the text
   and keeps the file as provenance. Intake is its own screen at
   `https://baraka.fabricxai.com/marbim/intake` — the **"Have a document to read?"** link
   at the top of the MARBIM chat. It is NOT the chat's ＋attach button (that attaches to
   the conversation), and typing about a document in chat queues nothing — the trace
   saying "no tools run" is the tell. So for every document step: MARBIM → the intake
   link → pick the kind → **paste the document's text** (open the PDF, select-all, copy)
   → attach the file → queue. The extraction pipeline behind it is real: per-field confidence is
   measured (OpenAI logprobs), the low-confidence field shows orange, and the draft lands
   in the Approve inbox on the five-minute cycle — allow up to 5 minutes, it is a
   schedule, not a click. Photo steps (challan JPG, hourly-report photo, measurement
   photo) cannot be machine-read at all: type the values, attach the photo.
2. **Defect codes are semantic, not D-numbered.** The tap grid shows `BROKEN_STITCH`,
   `SKIP_STITCH`, `OIL_STAIN`… The kit's `D-04 broken stitch` = `BROKEN_STITCH`,
   `D-11 skip stitch` = `SKIP_STITCH`. The kit's D-19/D-20/D-21 have no equivalent — pick
   the nearest semantic code and note it.
3. **Role names differ.** manager→**admin** (Sultana approves as admin), storekeeper→
   **store**, supervisor→**production** (line scope enforced: Shilpi L1/L2, Rina L7/L8),
   qc→**quality**, packing→**shipment**, mechanic→**maintenance**, accounts→**finance**.
4. **Two of the approval rules are enforced differently than the sheet says.**
   Below-floor costing → owner is enforced **in the costing service via the 10% policy**,
   not as an inbox rule — the trap still works, test it as written. Breakdown-after-
   production-start routes **all** breakdowns to admin/owner (stricter than asked, because
   rule conditions are not evaluated). Payroll run is hard-gated to hr+owner in code; the
   quiet locked card in Phase 9 is exactly that gate.
5. **Yarn and greige appear as kind "fabric"** in the store (the item-kind enum has no
   yarn/greige yet; the truth is kept in the item's spec). Receiving against them works.
6. **MARBIM answers only from tools.** Barakah's order book is empty until Phase 2 books
   one — the copilot refusing to invent an order is correct behaviour, not a failure.
7. **Phase 2, tech pack: two intake passes, then a seeded studio.** Run the tech pack
   through intake TWICE — "a tech pack" (pages 1–2, the BOM) and "a measurement chart"
   (page 3). Pasting it into MARBIM *chat* is refused by design: chat drafts carry no
   measured confidence, and the model now says so and points at intake. After the BOM
   draft is approved, open it under Costing → bills of materials and click **"Cost this
   style — open the studio seeded from these lines"**: consumption and wastage arrive
   from the BOM, rates start at zero for Rashida to price.
8. **Phase 2, PO drop: the breakdown grid is typed, not extracted.** The PO intake drafts
   the order header and styles (total 36,000); the colour×size grid is entered on the
   order page afterwards (Breakdown → correction). The runbook's "grid sums 36,000" check
   applies there.
9. **Phase 2, TNA: generated from a button, not automatically.** A PO-born order opens
   with an empty schedule and a "Generate the schedule" control on the Time-and-action
   tab: pick the template and the 15 Nov ship date, every milestone plans backward from
   it. An RFQ-won order gets its TNA automatically ONLY when the enquiry's product type
   matches a template's (`knit`, `woven`, …) — the Bestseller enquiry says "Men's polo
   shirt, short sleeve, 3-button placket", which matches nothing, so the order arrives
   without a schedule and the same button covers it (pick "Knit — 90 day"; a polo is
   knit).
10. **Tables want their layout.** A browser's select-all flattens a POM chart into one
    line, and the extractor can then pair a size with its neighbour's column — the first
    live chart came out shifted one size with XXL dropped, at high confidence, and was
    approved before anyone compared it to the page. Confidence is per FIELD, and the whole
    grid is one field — it measures how sure the model was of what it wrote, not whether
    the columns line up. For any tabular document: compare a few drafted values against
    the page before signing. That comparison is what the approve step is.
11. **Phase 2, PO revision: not an intake kind.** Drop-the-revision-PDF has no intake
    tile. The diff draft exists and routes through the inbox all the same — either paste
    the amendment text into MARBIM chat (it drafts `Navy/L +600, White/S −600` via
    `orders.propose_breakdown_revision`), or use the order page's Breakdown → "buyer
    amendment" path. Both produce the Rev 2 + history the runbook checks.
12. **Phase 2, Mark won asks for winning terms.** The enquiry email deliberately states
    no firm ship date ("mid-November window") and no size ratio — those arrive with the
    PO. But the win is what creates the order and its TNA, so `markWon` refuses without
    them. The drawer now asks for whichever is missing right in the "Won or lost"
    section: a ship date picker and a ratio field (`S:1 M:2 L:2 XL:1`). Before this, the
    refusal existed with no way to satisfy it — and surfaced as "Minified React error
    #441", because production masks anything a server action THROWS. RFQ actions now
    return refusals as values (`lib/action-failure.ts`), so the floor gate, "no live
    quote" and the winning-terms refusal all read as sentences. Other modules still
    throw — expect #441 there until the pattern is adopted module by module.

13. **Phase 2, the buyer PO on an RFQ-won order: reject the intake draft.** The
    "buyer's purchase order" intake kind drafts a NEW order — right for a PO that
    arrives cold, wrong for one whose order already exists from Mark won: approving it
    would book the same 36,000 pcs twice. Reject the draft (reason: order already
    exists), then type the colour × size grid on the order itself via "Edit the
    breakdown". The PO numbers (PO-BF-2044 + 4711-88-2044) were attached to the won
    order by hand in the database — the product has NO surface for renaming an order
    from its RFQ placeholder to the buyer's real PO number, which is a genuine gap:
    every RFQ-won order will face it the day the paper PO lands. Also noted: the
    extractor captured only the buyer's PO number, not the supplier ref line.

14. **Phase 3, LCs arrive by hand, not by drop.** There is no LC intake kind (six kinds,
    SWIFT is not one), so both credits are entered via LC register → "New LC" with the
    values in `structured-data/03-commercial/lcs.json` — tick LC-4471's six document
    kinds in the checklist. The register stores no 44E port field, and NOTHING in the
    codebase compares B/L port spelling to the LC — Phase 7's Chattogram/Chittagong
    "discrepancy card" is a human writing discrepancy notes, not an automated catch.
15. **Phase 3, the order comes before the credit.** PO-BF-2051 does not exist (only the
    Bestseller flow was run); create it manually first — Order desk → New order: H&M,
    ST-2712, 12,000 pcs at 16.50 USD, ex-factory 2026-11-16. Then LC detail →
    "Orders this credit covers" → Cover it. That section is NEW: `order_lcs` was read
    by the conflict detector and the countdown job and written by nothing, so every
    conflict the module can detect was unreachable until now. The float shows on the
    covered row (LC-5120's latest shipment 11-17 vs ex-factory 11-16 → 1 day).
16. **Phase 3, the BTB limit is company policy, not per-LC.** The kit assigns 75% to
    LC-4471 and 70% to LC-5120; the platform has ONE `btbLimitPct` for the factory
    (Settings → Policy → commercial, default 75). Set it to 70 before the BTB step so
    the 5120-02 trap fires (ΣBTB 140,900 > 138,600) — LC-4471's 44,300 stays far
    inside 70% of 244,800 either way.

17. **Phase 3, neither an LC nor a UD can be corrected from a screen.** Deliberate once
    the record is in use (a customs paper, a bank instrument) — but a transcription
    typo BEFORE first use has no door either: LC-4471's docs checklist and
    UD-2026-031's item name ("0/1" for "30/1") were both corrected by hand in the
    database. A "correct before first draw/presentation" affordance is owed; until it
    exists, typos in these two registers are an operator-with-psql job.

18. **Phase 4, the procurement chain needed both missing links built.** A requisition
    could not be raised (action existed, no screen, no MARBIM tool) and a quote could
    not be entered (`recordQuote` was on the unreachable list) — so the requisition
    page compared quotes that could not exist. Both doors landed during the test:
    "New requisition" on /procurement, "Record a quote" on the requisition page.
    Also: NOBODY in the tenant holds the `procurement` role — grant it to Karim from
    Settings → Who can do what (itself a real product path) or run the desk as
    Tanvir (commercial), who the actions also accept.
19. **Phase 4, bonded receipts name the UD; issues draw it.** The receive screen used
    to refuse ALL bonded receipts (no picker existed); it now offers the live
    declarations whenever the location is bonded. The balance moves at ISSUE, not at
    receipt. The kit's UD balances (13,440 kg / 1,200 yds) assume pre-test
    consumption; that history was staged as dated `ud_consumptions` rows so the
    workbench shows the runbook's numbers and the ISS-118 overdraw trap is real.
20. **Phase 4, SPO-1105's trap fires differently.** The platform's financing gate
    requires an import PO to NAME a BTB and re-verifies the MASTER's ceiling under a
    lock at issue — but it does not sum PO values against the named BTB's own value,
    so "top-up exceeds the BTB" as the kit scripts it has no implementation (gap,
    worth the report). The demonstrable refusal is an import PO with no BTB.

21. **Phase 4, the store had no locations and no way to make one.** The day-0 load
    seeded items but not racks, and NOTHING creates a location — no screen, no
    action, no MARBIM tool — so the receive form's "Into" box was empty and no goods
    could ever arrive. GEN-01 (general), BND-01 (bonded) and FLR-01 (floor) were
    seeded by hand; a location-management surface is owed, and any new tenant hits
    this wall on day one. Also owed from this phase: procurement's actions still
    throw (a double-click on "Issue the purchase order" masks its refusal as React
    #441), and a requisition has a cancelled state with no cancel button.

22. **Phase 4 ran, and found the phase's severity-1.** A bonded issue left the
    warehouse with NO customs draw recorded — the service drew only when the client
    named the UD on the line, and the screen never did; the banner's "recorded but not
    validated" text was stale copy confessing it. Fixed at the root (the roll's
    declaration resolves through its GRN server-side; the ledger is written in the
    declaration's vocabulary via alias matching; the escaped 6,000-yd draw was
    backfilled and tied to its issue). The shade-mix warning also only saw the current
    pick — one B roll after 6,000 yds of A passed silently; it now remembers the
    order's history. Both traps then fired live: the warning named A and B, and the
    overdraw block refused 3,000 against 1,000 with nothing written. Owed: the offline
    queue reports a refusal as "1 write the server refused" without the gate's own
    sentence — the shortfall numbers exist server-side and deserve the banner. The
    trap arithmetic was restaged (UD-2026-044 history 14,000, not the kit's 22,800):
    the kit's numbers are self-inconsistent (23,500 yds received under 1,200 of
    headroom) and whole-roll picking cannot issue under a 1,200-yd balance at all.

23. **Phase 5 ran end to end.** The sample-request door was built during the test
    (raiseSampleRequest had an action and no screen, and no MARBIM tool despite
    sample_requests being a pending target — the PP gate's chain started at a record
    nothing could create). Both gate flavours were exhibited: `no_sample` before, and
    `rejected` for 2051 after the H&M verdict — the gate distinguishes "nobody asked"
    from "the buyer said no". The marker travelled chat → draft → inbox → approve.
    Deviations from the kit's script: the cut report validates each lay against its
    MARKER plan (order-level cells appear as the cumulative "order needs" column, and
    a colour/size with no breakdown cell shows "—" rather than vanishing); over
    tolerance FLAGS and records with the variance stored, it does not demand an
    override to save — deliberate, "the pieces are already cut". The style-code
    prefill in the new-sample modal was fixed mid-test (it kept the previous order's
    code; the PP gate matches on order + style code, so a stale code is a gate that
    never opens). Multi-tenant caught one tester: fabricxai@gmail.com belongs to a
    different company, and its approve inbox is empty of Barakah's drafts by design.

24. **Phase 6, two foundations were missing.** `daily_line_plans` — the record every
    floor write hangs off (hourly outputs take their orderId from it, the board its
    targets, the day-close its SMV) — was written only by the seed; "Plan the day"
    on /lines is the door built for it. And role SCOPES were stored and never read:
    Shilpi's `{"lines": ["L1","L2"]}` sat in the roles table while she saw all eight
    lines. `ctx.lineScope` now carries the union of scoped roles (any unscoped role
    widens to the whole floor) and the board, hourly grid, stoppage list and endline
    counter filter by it. OWED: write-side enforcement — the offline batch handlers
    do not yet refuse an entry for a line outside the device user's scope, so the
    screens are the first wall, not the only one.

25. **Phase 6 ran end to end, and found two bugs on one screen.** The hourly entry read
    `new Date().getHours()` — the SERVER's hour, UTC — so on a Dhaka floor the screen
    opened on 8:00 every evening and the 10:00 count would have silently corrected 8:00
    (`factoryHour()` now reads the factory clock). And `downtimes.machine_id` had
    existed since 6.1 with no picker in the stoppage dialog, so every machine stoppage
    reached maintenance as "machine not identified" — the one fact the mechanic needed.
    Both fixed mid-test. Everything else held: the auto-raised ticket ("a supervisor
    with a dead line should not have to file paperwork twice"), Sabbir's claim
    ("nobody else will walk to this machine"), the resolve closing the line's stoppage
    with it, DHU 6.67 / pass 95% derived-never-stored, and the run-rate card reaching
    397 sewn · 132.33/day with "one day of output only" stated rather than a
    confident-looking projection from one morning.

26. **Phase 7, quality: the AQL machinery is right, and the terms had no door.** The
    final-inspection desk refused every lot fail-closed — correct — but `upsertTerms`,
    the versioned rows the gate reads, had a service and no action and no screen, and
    the refusal leaked its `{buyer}` placeholder raw. Both fixed (775aeb7): the buyers
    desk gained "Buyer terms" (each save a new version from its valid-from date), and
    the computed plans then matched ANSI Z1.4 exactly — 36,000 pcs → code N → 500
    pull, Ac 21/Re 22 at AQL 2.5; 12,000 → M → 315/14, the kit's own figure derived
    from Bestseller's terms rather than typed. The critical-defect exhibit took three
    attempts and taught the most: the first submission PASSED honestly because the
    needle tile was back at 0 by submit time (the server row proved only 4 majors
    arrived — every layer from tile to verdict transmits faithfully); the clean probe
    FI-PO-BF-2044-2 came back FAIL on `critical_defect found 1, accept 0`, and the
    quality landing then warned "a failed lot does not ship until it is re-inspected."

27. **The session trap, named.** Logging in as another tester replaces the session for
    the WHOLE browser, and the offline queue is per-browser, not per-account — so an
    inspection captured on Mitu's screen posts under whoever is logged in when the
    queue drains. Two re-inspections died this way as `sync_role_forbidden`. Role
    refusals are deliberately not persisted server-side (a verdict on the caller, not
    the row — replay after a role fix should apply), but the device marks them
    terminal and the banner says only "2 checks the server refused. Dismiss Dismiss" —
    no reason, no identity, and nothing in /refused either. OWED: the refusal banner
    carries the gate's sentence (`errorKey` is already on the device); the queue
    should stamp who captured a write and refuse to post it under someone else.

28. **Phase 7, shipment: every gate held; only the telling failed.** The packing floor
    existed with no signpost (the sidebar is one entry per module and the board never
    linked it — 1768efb adds the link), and its grid was built from finished ∪ packed
    with the "+24 finished" button INSIDE a cell, so the first finishing report was
    impossible — chicken-and-egg resolved by seeding cells from the order's own
    breakdown revision, ordered quantity shown per cell (9c778fa). The over-pack
    block then exhibited cleanly (White|S 24 of 24, the second carton dead at the tap
    with the sentence; the server enforces it independently). On the desk, three
    React #441s in one walkthrough, decoded from server logs: two were the
    commercial-only bank handoff masking a 403 at Jahid, one was the final-inspection
    gate refusing "Confirm ex-factory" on the failed lot — with its outbox trail
    `shipment.final_inspection.blocked` carrying the reasons, the inspection number
    and attemptedBy. The machinery was perfect; the person saw an error number. All
    shipment actions now return refusals as values with requireRole inside the
    boundary (592e9de). The close: EXP-2026-118845 recorded, checklist derived from
    LC-4471 itself (SIX kinds — settling the Phase 5 "5 vs 6" question: the list is
    whatever the credit demands), all six attached and submitted under the EXP.
    Noted, not fixed: the EXP-missing trail (`shipment.exp.missing`) never fired live
    because the number was recorded before any commercial-role attempt — integration
    tests cover it; locking the packing list auto-accepts breakdown mismatches
    (`acceptMismatches: true` hardcoded — 6 shortfall cells accepted in one click
    that never showed them); the card's facts column collapses one-word-per-line on
    wide screens; B/L port-of-loading vs LC wording (Chattogram/Chittagong) remains a
    human comparison.

29. **Phase 8, scoped before clicking: the money had FIVE missing first links.** An order
    could not be moved through its own lifecycle (`setOrderStatus` had a state machine and
    no screen — closing, the phase's centrepiece, was impossible); an invoice could not be
    raised (`invoices` was a pending target with a commit handler, a zod and an audit mark
    that nothing proposed — no invoice, no receivable, nothing to realize); the waterfall
    was never computed (`accrueOrderCosts`/`orderPnl` had no caller but the seed); the
    presentation's invoiced amount was "filled in later" by a comment with no mechanism
    (`finance.invoice.drafted` now carries the shipmentId and commercial fills its own row,
    rule 11); and the GRN unit price — accepted by the zod since 3.1 — had no field on the
    receive screen, so every accrual the module ever ran was blind and the first frozen
    waterfall honestly reported actual margin 100% on actuals of zero. All five built
    (f25358f, fc8efd4, a4a19cb); existing GRN lines were restaged with prices and the close
    replayed by inserting a fresh outbox event — the consumer's own upsert idempotency is
    what made that safe.

30. **Phase 8 ran end to end, and the chain held.** Invoice drafted by finance, signed by
    the owner, invoice + receivable born together with expectedAt +30 days from the policy
    default; the new wire filled the presentation's invoiced amount the moment the invoice
    existed; the realization of 150.00 against 166.80 (10.07% short) was REFUSED without a
    written reason and posted with one; the receivable settled with the shortfall stored;
    and the outbox reads like the design doc — invoice.drafted → order_costs.accrued →
    margin.erosion → finance.realized → receivable.realized. The re-frozen waterfall names
    fabric: materials actual 151.58/pc against 5.09 quoted (+146.49), margin −2081.01% —
    the magnitude is the staging (a full fabric issue over 24 shipped pieces), stated on
    the record rather than smoothed. The outcome card compiled honestly ("compiled
    without: efficiency", consumption flagged "issued over pieces produced") and the
    close-out note sealed: fabric ran 262 g/pc against 255 quoted. Bank-desk repairs
    mid-phase (77ad5df): status moves were commercial-only while the realization always
    allowed finance — Salma could post the money but not record that the documents went;
    the shortfall gate's own sentence masked as React #441; and the docs line rendered
    "[object Object]" because two writers store two shapes and the page assumed one.
    Deviations, recorded not simulated: the order was closed before invoicing (harmless —
    the money legs are status-independent); the tester's shortfall reason went in as
    "Problem a", which is precisely what free-text invites and exactly what the record
    preserves; payables still have no entry door; the similar-order card has no screen
    (owed list); the bank advice is typed, not extracted, by the module's stated
    philosophy; and one "Server Action was not found" was deployment skew from shipping
    mid-session — a reload cures it, and live-deploying under an open tab is the
    operational reality it documents.

31. **Phase 9, the doors: payroll had none at either end, compliance had none at all.**
    The gazette actions existed with no screen while the page said "payroll cannot be
    computed without one" (this tenant's gazette turned out to be seeded — the door was
    still owed); attendance was deliberately not a pending target ("a drafted attendance
    row is a drafted wage") and had no human door either, so the table held zero rows
    and a run could never compute. Built (0d3418b): the gazette recorded-and-activated in
    one gesture, and the device CSV parsed at the screen — punches verbatim, P-LATE and
    P-MISS arriving as exceptions a person resolves, OT computed from the punches, an
    unknown employee number refusing the whole file bilingually. Compliance's audit modal
    and per-finding CAP button landed the same commit — and the audit door FAILED ON
    FIRST USE: the action had always accepted a findings array that recordAudit's zod
    silently stripped, so the success banner counted findings the server never kept
    (ae1653a fixes it through commitFindingsBatch, the approve inbox's own path). The
    payroll run then walked the kit's chain: import → exceptions named → computed against
    the gazette → approve grey for hr, signed by the owner, "figures fixed from here."
    Deviations recorded: the kit's export covers 10 employees so its BF-0023 OT outlier
    cannot appear; a day with no attendance row is NOT-RECORDED rather than absent, so
    one day of punches paid the full month to 40 people — silence does not dock pay, and
    a factory should know that is the rule; the grade-3 net vector assumes a full month;
    certificates and training still have no door (the 60/30-day expiry ladder could not
    be staged).

32. **Phase 9, the sweep: the walls held, and the one leak was the viewer's.** Every
    direct-URL probe came back locked — the read wall lives in the shared layout,
    checked against the same rule the nav uses, so hidden and locked cannot drift apart
    (a better design than the tester's own prediction, which had the money book leaking).
    Both admins got payroll's quiet card, exactly as 10.1 promises — including the copy
    quirk of telling an admin to "ask an owner or admin". Production reading the store
    shelf it cannot move is nav's own stated design. The viewer's MARBIM announced
    "answers only, no draft tools" — and then the order detail showed the unit price in
    clear: the ••• redaction the role promises existed NOWHERE in the product (the only
    redaction in the codebase scrubs secrets from MARBIM prompts). 1c1d4ec redacts unit
    price and order value server-side on the order desk for viewer/member-only accounts —
    the figure never reaches the browser — with the sweep of other money fields recorded
    as rollout.

33. **Phase 9, the race: one signature won, and the loser heard about it in the wrong
    language.** Two browsers as the same admin raced Approve on one pending tolerance
    exception. The first committed; the second was refused with the typed 409 this inbox
    exists to throw — pending_change_not_pending, the winning status attached — and the
    refusal reached the screen as React #441. The approve and reject actions were the
    LAST unsurfaced desk in the product (361e926): the second manager now reads "That
    draft has already been decided." The exhibit stands as the kit wrote it: same item,
    two hands, one decision.

## Honest status of the traps

The gates the runbook pokes (PP blocks cutting, UD overdraw block, BTB headroom, EXP
before bank, offline dedupe, AQL 315/14 computed, over-pack block, tolerance override,
409 on concurrent approve) are all **built and server-side** — but most have never been
exercised on this host. That is what this test is FOR. Log every miss in the runbook's
format (phase, user, action, expected vs got, screenshot); each maps to a module contract.

## When something fails

Real candidates, in likelihood order: a screen missing a write path (the buyers desk was
read-only until this week), a contract mismatch between modules, an i18n gap on floor
screens (most are English; Bangla covers store/receive). Collect, don't debug live —
bring the list back.
