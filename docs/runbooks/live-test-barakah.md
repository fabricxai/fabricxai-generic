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
