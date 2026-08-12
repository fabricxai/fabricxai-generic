# Test kit · Test Textile Ltd — `baraka.fabricxai.com`

A scripted walk through the whole platform on the **test-textile** tenant, as the roles that
would do the work, with realistic paper to feed the AI doors. The tenant was seeded to this
kit's exact numbers on 2026-08-12 (v1.0.3): every scene below either meets data that is
already there or fires a gate that is armed and waiting.

**Every company in the document pack except the buyers is fictitious** (Square Yarns Ltd,
Foshan Denim Mills, Dhaka Trims House, CleanWash BD, Karnaphuli Mercantile Bank, Suzuka
Sewing Machine Co.). Buyer names appear as plain data because the tenant's seeded orders
carry them. None of these documents is real business paper — they are test fixtures.

---

## 0 · Signing in

`https://baraka.fabricxai.com/login` — one login per role, **`<role>@testtextile.test`**,
one shared password (the standing test password; ask the owner if you don't have it).

| login | role | login | role |
|---|---|---|---|
| `owner@` | owner | `cutting@` | cutting |
| `admin@` / `manager@` | admin | `production@` / `production2@` | production |
| `merchandiser@` / `merchandiser2@` | merchandiser | `quality@` | quality |
| `commercial@` | commercial | `shipment@` | shipment |
| `planner@` | planner | `maintenance@` | maintenance |
| `store@` | store | `hr@` | hr |
| `procurement@` | procurement | `compliance@` | compliance |
| `finance@` | finance | `member@`, `viewer@` | member, viewer |

Ground rules:

- **Two roles side by side** = one normal window + one incognito window (or two browsers).
- **Paste, don't type** — a mistyped password is indistinguishable from a real refusal.
- **The AI doors read text, not pixels.** Every drop zone wants the document's TEXT pasted
  (open the HTML file → select-all → copy) and keeps the attached file as provenance.
  Photo-only steps (challan, hourly sheet, nameplate) work the real way: **print the sheet,
  photograph it with your phone, attach the photo, type the values.**
- A refusal with a sentence explaining itself is a PASS. A silent failure, a raw code, or a
  JSON blob on screen is a finding — log it (see §6).

### Exit check before anything else

Sign in as `viewer@testtextile.test`: no Settings, no payroll in the nav, no approve inbox.
If a viewer can see money controls, stop and report — nothing else matters until that does.

---

## 1 · What is already loaded — do not re-enter

| Thing | State |
|---|---|
| **JKT-2210** (Bestseller jackets) | confirmed · PP sample `SR-2210-PP` **dispatched, verdict pending → cutting blocked** |
| **POLO-2244** (H&M polos) | in production · four days of hourly output on two lines |
| **DENIM-2251** (Primark denim) | shipped partial · 35 cartons gone, EXP set |
| **4711-88-2044 / PO-BF-2044** (Bestseller polo, ST-2610, 36,000 pcs) | confirmed · PP `SR-2610-PP` **approved → cutting open** · **LAY-32 spread (White, 118 plies), waiting for its cut report** |
| **PO-BF-2051** (H&M denim jacket, ST-2712, 12,000 pcs) | confirmed · ships 2026-11-16, one day inside LC-5120's latest shipment |
| **LC-4471** (Bestseller, $244,800) | covers 4711-88-2044 · carries BTB-4471-01 ($34,500) + BTB-4471-02 ($9,800) |
| **LC-5120** (H&M, $198,000) | covers PO-BF-2051 · latest shipment 2026-11-17 · carries BTB-5120-01 ($78,900) — **free headroom $59,700 at the 70% ceiling** |
| **UD-2026-031** (30/1 yarn, 42,000 kg) | 28,560 drawn · **13,440 kg free** |
| **UD-2026-044** (12oz denim, 24,000 yds) | 22,800 drawn · **1,200 yds free** — while 23,500 yds sit in the bonded store |
| Bonded store | Foshan denim R-D-01…R-D-21 · **R-D-19/20/21 failed 4-point** (3 of 21) |
| General store | piqué R-P-01…R-P-18 · **R-P-01…11 shade A, R-P-12…18 shade B** · PO-BF-2044 already issued shade A only (ISS-114) |
| Bank | presentation under LC-4471 · **USD 122,400 · accepted, awaiting realization** |

---

## 2 · The files in this pack

| File | Feeds | Used in scene |
|---|---|---|
| `01-buyer-po-PRM-2088.html` | Orders → New order drop zone | 3 |
| `02-quote-square-yarns.html` | Procurement → New quote drop zone | 4 |
| `03-challan-DTH-4409.html` | Store → Receive drop zone (print + photo) | 6 |
| `04-realization-advice.html` | LCs → Submissions drop zone | 5 |
| `05-tech-pack-ST-2610.html` | MARBIM intake (tech pack) | 11 |
| `06-hourly-sheet-L2.html` | Lines → Hourly day-catchup (print + photo) | 8 |
| `07-nameplate-overlock.html` | Maintenance → Machines registry (print + photo) | 10 |

Open any of them in a browser; they print clean on A4.

---

## 3 · Scene 1–3 · The desk opens the day

**Scene 1 — owner, five minutes.** Sign in as `owner@`. `/home` should read like a morning
briefing: what needs you, the approve queue, the order book. Open `/approve` — anything a
scene below creates through an AI door lands here. Don't approve anything yet.

**Scene 2 — merchandiser closes the PP loop.** As `merchandiser@` → `/sampling` →
`SR-2210-PP` (JKT-2210). The sample was dispatched on AWB `7412 9930 226`; the buyer's
answer never got recorded. Record the verdict: **approved**, dated today. Expected: the
sample closes, and **cutting for JKT-2210 unblocks** — verify as `cutting@` later that
JKT-2210 is now cuttable. This is the PP-gate working in the release direction.

**Scene 3 — merchandiser books a new order through the door.** Still `merchandiser@` →
`/orders` → New order → the drop zone. Open **`01-buyer-po-PRM-2088.html`**, select-all,
copy, paste into the zone (attach the file too). Expected: the form pre-fills — buyer
Primark, PO `PRM-2088`, style `ST-2610` repeat, 24,000 pcs @ 5.95, ex-factory 2027-01-15 —
with **per-field confidence shading**; anything the paper doesn't state stays EMPTY (a
guessed zero is a finding). Review, correct anything orange, save. The order appears in the
book as a draft/confirmed order created by you — not silently by the machine.

---

## 4 · Scene 4 · Procurement, and the first two refusals

Sign in as `procurement@` → `/procurement`.

**4a — a quote arrives.** New quote → drop zone → paste **`02-quote-square-yarns.html`**'s
text. Expected pre-fill: Square Yarns Ltd, `SQ-2026-118`, 30/1 combed cotton yarn
(`YRN-30-1`), 12,000 kg @ USD 3.05/kg, validity 2026-09-30, BTB LC 90 days. Save it.

**4b — TRAP ② · the import PO with no credit behind it.** Raise a purchase order:
supplier **Foshan Denim Mills** (an IMPORT supplier), item `FAB-DEN-12` 12oz stretch denim,
**5,000 yds @ 3.35** (call it `SPO-1105`). Do **not** attach any BTB.
**Expected: the platform refuses at financing** — an import PO must ride a back-to-back
credit, and there is none with headroom assigned to this. The refusal must name the rule,
not just say no. If it saves quietly, that's a critical finding.

---

## 5 · Scene 5 · Commercial — the ceiling, and the money landing

Sign in as `commercial@` → `/lcs`.

**5a — TRAP ① · the fourth BTB that doesn't fit.** Open **LC-5120** → open a new
back-to-back: **`BTB-5120-02` · Foshan Denim Mills · USD 62,000**.
The arithmetic: ceiling 70% × 198,000 = 138,600; already carried 78,900; free **59,700**.
62,000 is **2,300 over** — small enough that a human eyeballing it would wave it through.
**Expected: refused at the counter**, with the headroom figure in the refusal. This must
never reach "discovered at the bank".

**5b — the realization advice.** `/lcs` → Submissions → the accepted **USD 122,400**
presentation under LC-4471 → drop zone → paste **`04-realization-advice.html`**'s text.
Expected pre-fill: invoice `BF-INV-2044-1`, gross 122,400.00, charges 313.60, **net
122,086.40**, value date. Post it. Then as `finance@`, confirm the realization shows
against the order's money trail. (Also check LC-5120's detail page: the one-day float
against PO-BF-2051's ex-factory should be visible — that is a countdown, not a fault.)

---

## 6 · Scene 6 · The store — one receipt and three refusals

Sign in as `store@` (screens are Bangla-first — that is correct, not a bug).

**6a — receive the trims challan.** Print **`03-challan-DTH-4409.html`**, photograph the
print with your phone. `/store/receive` → drop zone → paste the challan text + attach your
photo. Expected pre-fill: Dhaka Trims House, challan `DTH-4409`, `TRM-ZIP` YKK jacket
zipper **12,400 pcs**, general store (nothing bonded). Save the GRN.

**6b — TRAP ④ · the shade mix.** `/store/issue` → issue to order **4711-88-2044**
(PO-BF-2044): pick piqué rolls **R-P-12 and R-P-13** (shade **B**). The order has only ever
been cut in shade A (ISS-114). **Expected: a WARNING naming the shade conflict** — this one
warns rather than blocks, because a planned shade change is legitimate. Cancel the issue
(don't confirm it) so the trap stays armed for the next tester.

**6c — TRAP ⑤ · the failed rolls.** Same screen: try to issue **R-D-19, R-D-20, R-D-21**
(the three the mill's own packing list flagged; they failed 4-point at 20/100 sq yd).
**Expected: not issuable at all** — they should either not be offered or be refused with
the inspection result cited.

**6d — TRAP ③ · the customs overdraw.** Issue **1,450 yds** of `FAB-DEN-12` (bonded)
against **PO-BF-2051** — any passing rolls. UD-2026-044 has **1,200 yds free**.
**Expected: HARD BLOCK** — drawing 1,450 against 1,200 is legal exposure, not a warning.
Then, as `owner@` in the incognito window, exercise the **written override** path the block
offers; the override must demand a reason and land in the audit trail. (If you complete the
override, note that UD-2026-044's balance is now spent for later testers — completing 6d
once per tenant is enough.)

---

## 7 · Scene 7 · Cutting closes LAY-32

Sign in as `cutting@` → `/cutting` (queue) → LAY-32 should be sitting open on
4711-88-2044 · White · 118 plies · marker `ST-2610-A` (ratio S1 M2 L2 XL1).
`/cutting/report` → file the report: **S 118 · M 236 · L 236 · XL 118 = 708 pcs**, fabric
used ≈ 417.6 kg (rolls R-P-04 + R-P-05), note 2 damaged panels if you want a variance.
Expected: the lay closes and the bundles appear downstream. Also verify JKT-2210 became
cuttable after Scene 2 — and that starting a lay on an order whose PP is NOT approved is
refused (that gate is the whole point of PP).

---

## 8 · Scene 8 · Production — the hour, on the floor

Sign in as `production@` → `/lines/hourly`. POLO-2244 is four days into sewing on two lines.

- Enter this hour's output for **L1** and **L2** live (targets are on screen).
- **The catch-up door:** print **`06-hourly-sheet-L2.html`**, photograph it, open the
  day-catchup door on `/lines/hourly`, attach the photo and type the sheet's numbers in.
- **Offline round-trip (phone):** airplane mode ON → enter an hour → the row queues with a
  pending mark → airplane OFF → it syncs, once (no duplicate row). This is the
  `offline_key` promise; a double row is a critical finding.

Expected everywhere: efficiency recomputes from SMV × output, and a line an hour behind
plan raises the run-rate slip (owner gets the push if subscribed — see Scene 13).

---

## 9 · Scene 9 · Quality walks the line

Sign in as `quality@` → `/quality/inline` — tap defects against POLO-2244's lines (the grid
is semantic: `BROKEN_STITCH`, `SKIP_STITCH`, `OIL_STAIN`…). DHU should move as you tap.
`/quality/fabric` shows the Foshan 4-point history (18 passed, 3 failed) — re-inspecting a
failed roll is allowed; passing it should change its issuability (that unlocks Trap ⑤'s
rolls, so leave them failed unless that's what you're testing). `/quality/final` — run a
final inspection against DENIM-2251's remaining quantity; the AQL sample size must be
computed by the machine, never typed.

---

## 10 · Scene 10 · Maintenance meets a machine

Sign in as `maintenance@` → `/maintenance` → Machines registry → the reader door.
Print **`07-nameplate-overlock.html`**, photograph the plate, attach it and type the
nameplate values (Suzuka SZ-757-D4, serial SZ24-118826, 550 W, 2024-11). Expected: the
machine lands in the registry with the photo as provenance. Then open a ticket on it as
`production@` ("machine down, L2"), and as `maintenance@` claim → resolve it; the claim
and resolution should notify the reporter.

---

## 11 · Scene 11 · MARBIM reads the tech pack, and answers questions

Sign in as `merchandiser@` → `/marbim` → **"Have a document to read?"** (that link is the
intake — the chat's ＋attach button is NOT it). Kind: tech pack. Paste the text of
**`05-tech-pack-ST-2610.html`** and attach the file. Expected: a draft lands in `/approve`
within ~5 minutes (it is a schedule, not a click), fields carry measured confidence, and
the consumption line (255 g/pc + wastage) can seed the costing studio.

Then ask MARBIM, as different roles, and expect answers with numbers and links — and role
walls to hold:

- as `commercial@`: *"How much headroom is left under LC-5120?"* → $59,700 story.
- as `store@`: *"Can I issue 1,450 yards of denim against PO-BF-2051?"* → it should warn
  about UD-2026-044 **before** you ever touch the issue screen.
- as `production@` (or viewer): ask for payroll numbers → **refused**, politely.

---

## 12 · Scene 12 · Shipment and the paperwork wall

Sign in as `shipment@` → `/shipment`. DENIM-2251 sits shipped-partial (35 cartons, EXP
set). Check the pipeline reads that honestly. Then try to open **bank documents for an
order with no EXP number** — expected: refused (the EXP-before-bank gate). Packing more
cartons against POLO-2244 should refuse until finishing has produced packable pieces —
the over-pack block is server-side, not a greyed button.

---

## 13 · Scene 13 · The phone (new in v1.0.3)

On a phone (or DevTools mobile viewport):

1. Open `baraka.fabricxai.com`, sign in as `production@` → browser offers **install**
   (PWA). Installed, the app opens standalone with bottom tabs: *This hour · Endline ·
   Tickets*. Each floor role gets its own tab set (store: Receive · Issue · Rolls; quality:
   Walk · 4-point · Final; owner: What needs you · Approve · Orders…).
2. **Push:** in the app, enable notifications for this device. Then fire an event that
   deserves a buzz — e.g. as `store@` fail a GRN inspection, or let a line run an hour
   behind. The buzz is a courtesy; the in-app bell row is the record.
3. **Shared tablet check:** sign out, sign in as `production2@`, re-enable push — the
   device must now buzz for the new person only.
4. The offline round-trip of Scene 8, on the installed app.

---

## 14 · When something refuses — or fails

A refusal that names its rule (headroom figure, UD balance, PP state) is the product
working. Log a **finding** when you see: a silent failure, an English-only floor screen, a
raw identifier/JSON where a sentence belongs, a gate that only exists in the UI (try the
same write twice fast), or numbers that disagree between two screens.

Format, one line each — phase · login · what you did · expected · got · screenshot.
Bring the list back; don't debug live.

---

*Fixture notice: Karnaphuli Mercantile Bank Ltd., Suzuka Sewing Machine Co., Square Yarns
Ltd., Foshan Denim Mills, Dhaka Trims House and CleanWash BD are invented for this kit. Any
resemblance to a real company is accidental. Buyer names are seeded data on a test tenant.*
