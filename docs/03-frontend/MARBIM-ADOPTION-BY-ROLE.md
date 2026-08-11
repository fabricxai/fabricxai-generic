# MARBIM as the daily assistant — a role-by-role adoption audit

**The goal is a habit, and a habit has a shape:** a cue (the moment the person's work gets
annoying), an action that is *easier than the old way*, and a reward that lands where the
work continues. Every suggestion below is built on that loop. If MARBIM shows up as a
button beside the work, it stays a demo. If it shows up **inside the annoying moment** and
saves the person a walk, a re-type, or a phone call, it becomes how they work — and every
use feeds the knowledge base back: corrections score the extractors, questions shape the
primers, close-out notes build order memory.

This document is the companion to `UX-AUDIT-BY-ROLE.md` (the general screen audit). This
one answers a narrower question: **for each role, where exactly does MARBIM belong in
their day, and what do we build so they meet it there?**

What already exists and is live: the panel on every screen (⌘K / the FAB), role-scoped
intake chips, file-native reading of PDF/photo/Word/Excel/CSV, human-code lookups
(`B-04501`, `PO-BF-2044`, `L1`), per-field measured confidence, the approve inbox with
in-draft editing, and correction telemetry per extractor version. Most of what follows is
*placement*, not machinery.

---

## The four habit rules (apply to every role)

1. **First question free.** Every screen's panel already carries role-specific suggestion
   chips. Sharpen them per screen so the first tap answers something the person was about
   to compute by hand. Nobody types a first question into an empty box; everybody taps a
   chip that reads their mind.
2. **The reward lands in the work, not in the chat.** Every MARBIM answer that names a
   record links to its screen; every draft ends with "waiting in the approve inbox".
   The chat is a corridor, never a destination.
3. **Refusals recruit.** When a screen refuses somebody (gate, tolerance, balance), the
   refusal toast should offer the question: *"Ask MARBIM why"* — pre-filled. A person who
   just got blocked is the most motivated learner in the building.
4. **Never let MARBIM be slower than the old way twice.** The first bad experience is
   forgiven, the second one ends the habit. This is why intake refuses what it cannot
   read *in words*, and why ambiguous lookups refuse rather than guess — a wrong answer
   costs more trust than fifty right ones earn.

---

## Merchandiser — `merchandiser@` (Rashida, Imran)

**Their day:** enquiries in, quotes out, orders booked, buyers chased, tech packs
dissected, PP samples pushed. The busiest desk and the most paper-fed one.

**The friction:** everything arrives as a document — enquiry emails, POs, tech packs,
amendment mails — and today's habit is re-typing them.

**Where MARBIM belongs:**
- **Intake as the default door, not the alternative.** Their chips already cover buyer
  enquiry, buyer PO, tech pack, measurement chart. Make the *New order* and *New RFQ*
  buttons offer "…or drop the buyer's document" inline, so the manual form is the
  fallback rather than the habit.
- **The amendment reflex.** A buyer's "make Navy/L +600" email pasted into chat already
  drafts a breakdown revision. Put a "paste the buyer's mail" affordance on the order
  page's Breakdown tab — that's the moment they have the email open.
- **Buyer questions by code.** They can now ask "what are B-04501's terms on the order
  date?" and "who do I chase at Bestseller?" — seed those as chips on the buyer page.
- **Before quoting, the memory question.** On the costing studio: chip *"have we made
  something like this before, and what did it actually cost?"* — `memory.find_similar_orders`
  answers with the compiled outcome (the 262 g/pc vs 255 lesson lives there). This is the
  chip that saves them from repeating last year's margin mistake.

**What they teach MARBIM:** the highest correction volume in the factory — every field
they fix on a PO or tech-pack draft tunes extractor trust; every close-out note they seal
becomes the answer to the next merchandiser's memory question.

---

## Commercial — `commercial@` (Tanvir)

**Their day:** LCs, BTB headroom, UDs, bank presentations, discrepancies. High-stakes,
date-driven, and every crisis is about two dates.

**Where MARBIM belongs:**
- **The LC arrives by drop.** The `lc_swift` intake kind is live — the MT700 attached in
  the sidebar drafts the credit, both dates, the docs checklist. Habituate it by putting
  "read a SWIFT message" beside "New LC" on the register.
- **Countdown questions.** Chips: *"which credits have under 15 days to latest
  shipment?"*, *"how much BTB headroom is left on LC-4471?"* — questions Tanvir currently
  answers by opening three screens.
- **The discrepancy drafting.** When a submission goes discrepant, offer *"draft the
  discrepancy note"* in chat — the human still decides (the Chattogram/Chittagong
  comparison stays a human's), but the prose is assistant work.
- **Refusal recruitment at the BTB gate.** The headroom refusal (140,900 > 138,600)
  should offer "ask MARBIM to show the arithmetic" — the gate becomes the teacher.

**What they teach MARBIM:** date corrections on SWIFT drafts (the six-digit forms), and
which document kinds each buyer's credits actually demand — vocabulary the presentation
checklist reuses.

---

## Planner — `planner@` (Nazmul)

**Their day:** line plans, allocation, capacity questions, "can we take this order?"

**Where MARBIM belongs:**
- **The feasibility question.** Chip on the planning board: *"if L3 runs ST-2610 at the
  current efficiency, when does it finish?"* — run-rate tools now accept `L3` and the PO
  number directly.
- **Plan-the-day pre-fill.** "Plan the day" demands target/manpower/SMV; MARBIM can
  propose them from yesterday's actuals as a *draft* the planner adjusts — the planner
  stays the author, the assistant does the arithmetic.
- **The clash question.** *"Which orders' TNAs collide with their LC latest-shipment
  dates?"* — data exists across two modules; the copilot is the only surface that can
  answer it in one sentence.

**What they teach MARBIM:** the gap between planned and actual capacity per line — the
raw material of a future scheduling primer.

---

## Store — `store@` (Karim)

**Their day:** GRNs against challans, bonded receipts against UDs, issues with shade
discipline. Tablet, warehouse wifi, gloves.

**Where MARBIM belongs:**
- **The challan photo, typed for him.** Photos are model-readable. Offer "read this
  challan" on the receive screen: photo in → lines, lots, quantities pre-filled →
  Karim checks against the paper → save. He is the reviewer, not the typist. This is
  the single biggest habituation win on the floor.
- **Balance questions in his words.** *"How much is left on UD-2026-044?"* — chip on the
  issue screen. He currently opens the UD workbench to answer it.
- **Refusal recruitment on the overdraw block:** the ISS-118 refusal should carry "ask
  MARBIM what this UD has left and why this is blocked" — bonded law explained at the
  moment it bites, in Bangla.
- **Bangla first.** His screens are the best-translated in the product; his chips must be
  Bangla-first or the habit never starts.

**What they teach MARBIM:** item-name aliases ("30/1 combed yarn" ↔ YRN-30-1) — exactly
the vocabulary the UD alias matcher needs; every challan correction extends it.

---

## Procurement — `procurement@`

**Their day:** requisitions, quote comparison, POs, the BTB financing gate.

**Where MARBIM belongs:**
- **Quote intake.** Supplier quotes arrive as emails and PDFs; the kind was removed
  because it demanded UUIDs no paper carries — **rebuild it with context pickers**
  (requisition, supplier) the way audit findings did. Until then: paste-into-chat
  drafting with the requisition picked in-screen.
- **The landed-cost question.** *"Compare the quotes on PR-1103 including freight and
  duty"* — the comparison exists; the chip makes it conversational.
- **Lead-time memory.** *"How late is Foshan usually?"* — supplier OTD data exists in
  queries; wire a read tool and this desk gets its most-asked question answered.

**What they teach MARBIM:** supplier naming vocabulary and real lead times — the
foundation of a procurement primer that can warn "this supplier has never hit 21 days".

---

## Cutting — `cutting@` (Rafiq)

**Their day:** markers, lays, cut reports, bundles; the PP gate governs his morning.

**Where MARBIM belongs:**
- **Marker by sentence.** The marker-proposal chat flow exists ("propose a marker: ratio
  S:1 M:2 L:2 XL:1, lay 6.2m…"). Put it as a button on the lay screen: "describe the
  marker to MARBIM". Cutting maths, narrated back before it routes to approval.
- **The gate explainer.** "PP ✗" on his queue should offer *"ask why this order is
  locked"* — the answer names the sample and its verdict, and points at sampling instead
  of at a locked card.
- **Consumption sanity chip:** *"at this marker's efficiency, how much fabric does the
  order need vs what's issued?"*

**What they teach MARBIM:** marker efficiency actuals per style family — future costing
knowledge nobody currently records.

---

## Production supervisors — `production@`, `production2@` (Shilpi, Rina)

**Their day:** hourly counts, stoppages, endline QC. The 60-second-per-line discipline.

**Where MARBIM belongs — carefully:** this is the one desk where the assistant must NOT
sit inside the capture loop; the tap grid is already faster than any conversation.
- **The end-of-shift question.** Chip on the board: *"summarise L1's day — output vs
  target, stoppages, DHU"* — the narrative she currently assembles in her head for the
  production meeting. MARBIM writes the handover note; she edits and owns it.
- **The "why" of the number.** *"Why is efficiency down on L2 this week?"* — cross-reads
  output, downtime and manning; the answer cites its rows.
- **Bangla chips, floor vocabulary.**

**What they teach MARBIM:** stoppage-reason vocabulary and what a "normal" day looks like
per line — the baseline every anomaly question needs.

---

## Quality — `quality@` (Mitu)

**Their day:** inline taps, measurement charts, AQL finals. Statistics she should never
have to compute.

**Where MARBIM belongs:**
- **The chart from the tech pack** is her intake kind already — habituate at the
  measurement screen: "the spec came from page 3? drop it here."
- **The AQL explainer.** The computed plan (500/Ac 21) should offer *"ask MARBIM why
  these numbers"* — ANSI tables explained once, trusted forever. Same for a FAIL verdict:
  the critical-defect rule explained at the moment it stings.
- **The defect-pattern question:** *"which defect is trending on PO-BF-2044 this week?"*
  — inline data exists; this is the question her manager asks her daily.

**What they teach MARBIM:** measurement-point vocabulary and defect patterns per buyer —
the raw material of a quality primer that can one day warn at cutting, not at final.

---

## Shipment — `shipment@` (Jahid)

**Their day:** cartons, packing lists, EXP gate, bank handoff.

**Where MARBIM belongs:**
- **The gate narrator.** His desk threw three React #441s in one live-test walkthrough
  (now sentences). Every gate sentence should end with "ask MARBIM what's missing before
  this can ship" — the answer is a checklist: inspection PASS?, EXP recorded?, docs
  attached against the LC's own list?
- **The packing question:** *"what's left to pack on PO-BF-2044, by colour and size?"* —
  the grid knows; the chip saves him counting cells.
- **B/L draft check.** Paste the draft B/L into chat: MARBIM compares names, ports and
  quantities against the LC and the packing list *as prose*, flags differences, and
  writes the discrepancy note for a human to sign — the comparison stays human, the
  clerical work doesn't.

**What they teach MARBIM:** which documents each buyer's bank actually bounces — the
discrepancy patterns worth warning about at presentation time.

---

## Maintenance — `maintenance@` (Sabbir)

**Their day:** tickets arrive from the floor; he walks, fixes, resolves.

**Where MARBIM belongs:**
- **Machine history at the machine.** *"What has OV-3-114 needed in the last six
  months?"* — chip on the ticket. Repair history is the diagnosis half he currently
  carries in his memory.
- **The resolve note, drafted.** He types "looper timing reset" — MARBIM can expand it
  into the structured record from a sentence, keeping the ledger useful without slowing
  him down.

**What they teach MARBIM:** failure-mode vocabulary per machine type — the seed of
predictive maintenance questions later.

---

## HR — `hr@` (Farzana)

**Their day:** attendance, exceptions, payroll runs, the gazette.

**Where MARBIM belongs:**
- **The gazette is her intake kind** — the government notification drafted into the
  versioned table, owner signs. Habituate at the payroll screen, not in the sidebar.
- **The exception explainer.** Each P-MISS/late exception should offer *"ask MARBIM what
  this means for their pay"* — OT rules, gazette grades and the not-recorded-≠-absent
  rule explained per case, in Bangla.
- **The pre-approval question:** *"which nets moved more than 10% vs last month, and
  why?"* — the anomaly sweep she does by eye today.

**What they teach MARBIM:** the factory's own attendance-device dialect and pay-rule
edge cases — payroll knowledge that is factory-specific by nature.

---

## Compliance — `compliance@` (Rumi)

**Their day:** audits, findings, CAPs, certificate expiries.

**Where MARBIM belongs:**
- **The audit report is her intake kind** — findings with severities drafted from the
  auditor's own document. Habituate on the audit page ("have the report? drop it").
- **The deadline question:** *"what's due before the next BSCI window?"* — CAP deadlines,
  certificate expiries (once certificates get their door), training gaps, one answer.
- **CAP evidence prose:** she writes what was fixed; MARBIM structures it against the
  finding, and the submitter-cannot-close rule stays intact.

**What they teach MARBIM:** regime vocabulary (BSCI/Sedex clause language) — the primer
that lets findings route to the right severity without correction.

---

## Finance — `finance@` (Salma)

**Their day:** invoices, realizations, shortfalls, the waterfall.

**Where MARBIM belongs:**
- **The shortfall arithmetic.** The refusal ("10.07% short needs a reason") should offer
  *"ask MARBIM to break down invoice vs advice"* — charges named, deduction candidates
  listed, the reason field pre-drafted for her judgment.
- **The margin question:** *"why did PO-BF-2044's margin erode?"* — the waterfall knows
  (materials +146.49); the chip turns the frozen table into a sentence with the fabric
  named.
- **The receivable sweep:** *"what's expected in the next 30 days, and what's overdue?"*

**What they teach MARBIM:** the factory's own deduction vocabulary ("EBL charges", buyer
discounts) — realization knowledge that makes the next shortfall's draft reason smarter.

---

## Admin / Manager — `admin@`, `manager@` (Sultana)

**Their day:** the approve inbox, mostly — signing what the factory drafted.

**Where MARBIM belongs:**
- **The reviewer's second opinion.** On any draft: *"summarise what this changes and
  what's unusual about it"* — confidence lows named, comparisons to the last similar
  draft, the thing to check before signing. The inbox is where trust in MARBIM is won or
  lost, because it's where MARBIM's own work is judged.
- **The routing question:** *"what's been waiting longest, and on whom?"*

**What they teach MARBIM:** every approval and every in-draft correction — the trust
telemetry itself. Sultana's corrections are the single highest-value training signal in
the building.

---

## Owner (Arif)

**Their day:** minutes, not hours, in the product. Decisions, signatures, exposure.

**Where MARBIM belongs:**
- **The morning question.** One chip: *"what needs me today?"* — payroll awaiting
  signature, below-floor costings, UD overrides, credits inside 15 days. The composed
  answer is the owner's whole relationship with the product.
- **The exposure question:** *"what's our open LC exposure and BTB usage right now?"*
- **Voice-of-the-factory summaries:** weekly digest drafted by MARBIM from outcomes,
  refusals and corrections — what the factory learned this week.

**What they teach MARBIM:** which alerts an owner acts on vs ignores — the signal for
tuning severity before alert fatigue sets in.

---

## Member / Viewer

**Read-only, answers-only — and that's the pitch:** *"ask anything; I can't change
records and neither can you."* A safe sandbox where new staff learn the factory by
questioning it. Chips: "explain this screen", "what does DHU mean?", "who approves
what?". The habituation nursery for every future role-holder.

---

## The knowledge-base flywheel (why habituation pays twice)

| Usage | What it feeds |
|---|---|
| In-draft corrections at approve | extractor trust per version — auto-approve thresholds later |
| Questions that miss (no tool ran) | the primer backlog — every miss is a primer line or a tool to build |
| Close-out notes | order memory — the answers to next season's costing questions |
| Alias fixes (item names, defect names) | the matching vocabulary UD draws and defect grids run on |
| Refusal → "ask why" taps | which gates confuse people — UX copy priorities, ranked by real confusion |

**Instrument the misses.** The single most valuable addition: log every question where
no tool ran (the trace already knows), grouped weekly. That list *is* the roadmap.

---

## Build order (highest habit-value first)

1. **Refusal → "Ask MARBIM why" pre-filled** on the five server gates + toasts. Small,
   universal, recruits at the moment of motivation.
2. **Per-screen chip sharpening** — replace generic suggestions with the specific
   questions above; Bangla-first on floor roles.
3. **Challan-photo reading on the receive screen** — the floor's flagship habituation
   moment.
4. **"Summarise this draft" in the approve inbox** — wins the reviewers, who are the
   trust engine.
5. **The owner's "what needs me today?"** — smallest audience, loudest advocate.
6. **Supplier-quote intake rebuilt with context pickers** — procurement's door.
7. **No-tool-ran telemetry report** — the flywheel's instrument panel.

*Written 2026-08-12, against the code as of `7a61ad3`. Companion to
`UX-AUDIT-BY-ROLE.md`; where the two overlap, that file covers screens, this one covers
the assistant.*
