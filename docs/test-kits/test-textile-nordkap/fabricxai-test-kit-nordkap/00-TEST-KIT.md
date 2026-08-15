# Test kit · Test Textile Ltd — a brand-new buyer, end to end

A complete order from a buyer this tenant has **never traded with**, walked through every
department as the person who would actually do the work, with the paper that person would
actually be holding — buyer PO and tech pack as PDFs, roll lists and packing lists as
spreadsheets, challans and hourly sheets as **photographs of paper**, the UD and the EXP as
**scans of stamped forms**, and a machine nameplate as a photo of a metal plate.

Nothing here is pre-seeded. **You build this order from nothing**, starting with a buyer who
does not exist yet, and the platform has to survive it.

> **Companion kit.** `docs/test-kits/test-textile/` walks the *already-seeded* orders on the
> same tenant (Bestseller, H&M, Primark) and meets five refusals that are armed and waiting.
> This kit is the other half: nothing is waiting, everything is created. Run either first.
> They do not collide — the only shared, tenant-wide document here is the wage gazette, and
> §12 says when to skip it.

**Read `01-ORDER-STORY.md` next.** It is every number in the order on two pages, and it is
what you check the screens against.

---

## 0 · Before you start

**App** `https://baraka.fabricxai.com` · **logins** `<role>@testtextile.test`, one shared
password (ask the owner).

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

**MARBIM must be on** and the worker running, or the intake doors queue jobs that never
finish. Extractions are processed by the worker, not the web request.

**Where the intake door is.** `/marbim` → **"Have a document to read?"**. That link is the
intake; the chat's ＋attach button is *not*. Written below as `/marbim/intake` for short.
Some doors are not there at all — a challan, a cut sheet, an hourly sheet, a proforma, a
packing list, a nameplate and a bank advice fill a **form on their own screen** and are
saved by the person holding the paper, because a receipt is not a thing to approve after the
fact. Those are noted at each scene.

### The three ways paper enters this product

Learn these before scene 1 — they decide how you test, and the kit gives you all three:

1. **Attach the file, paste nothing.** PDFs, JPEGs and PNGs are read by the extract model
   directly — it sees the pages. Per-field confidence then measures the whole journey from
   pixels to value.
2. **Paste the text.** Every document here ships a `.paste.txt`. A human transcription is
   deliberate, so pasted text is read *instead* of the file. Spreadsheets (`.xlsx`) can only
   go this way — the model cannot open them.
3. **Type it.** Some documents have no door at all and are meant to be typed. They are
   marked *manual* in the manifest and they are not lesser tests: they are how you check
   that the screen can do the job without the AI.

**Run paths 1 and 2 on the same document and compare the confidence maps.** That difference
is a feature, not noise. A scan that comes back at 1.000 on every field has not been read.

### Ground rules

- **Two roles side by side** = one normal window + one incognito window.
- **Paste, don't type passwords** — a typo is indistinguishable from a real refusal.
- **A refusal that names its rule is a PASS.** A silent failure, a raw identifier, a bare
  UUID or a JSON blob on screen is a finding. Log it (§16).
- Every `expected.json` is the ground truth for its document. **The test is a field-by-field
  diff between the approve-inbox draft and that file.** Keys starting with `_` are notes.

### Exit check, before anything else

Sign in as `viewer@`: no Settings, no payroll in the nav, no approve inbox, no intake chips.
If a viewer can see money controls, stop and report — nothing else matters until that does.

---

## 1 · What is in the box

28 documents (30 files — the tech pack carries its flat sketch, the measurement chart comes
both ways) in 7 department folders. Format is chosen the way a real factory receives it.

### `documents/01-merchandising/`

| File | Format | Door | Tests |
|---|---|---|---|
| `01-buyer-enquiry-NKA-ENQ-4471.pdf` | PDF | **buyer_enquiry** → rfqs | an enquiry with **no style code** — the extractor must not invent one |
| `02-buyer-po-NKA-PO-70318.pdf` | PDF | **buyer_po** → orders | one style, a **15-cell colour × size grid**, three colours with different ratios |
| `03-order-grid-and-delivery-schedule.xlsx` | Excel | manual | the 3-shipment plan; shipment 3 falls past the L/C date on purpose |
| `04-tech-pack-ST-2815.pdf` | PDF + flat sketch | **tech_pack** → boms | 12 BOM lines across all four groups; consumption vs wastage kept separate |
| `05-po-amendment-AMD-01.pdf` | PDF | manual | moves ex-factory past 44C — the L/C conflict |

### `documents/02-commercial/`

| File | Format | Door | Tests |
|---|---|---|---|
| `06-master-lc-7712-mt700-advice.pdf` | PDF | **lc_swift** → lcs | three **six-digit SWIFT dates**, a 5/5 tolerance pair, 6 documents required |
| `07-btb-credits-7712-01-and-02.pdf` | PDF | manual | the two back-to-backs and the headroom arithmetic |
| `08-ud-2026-058-scan.pdf` | **scan** | **ud_scan** → uds | bilingual customs form; 3 items, 2 units; sets the bonded balance |
| `09-bank-realization-advice.pdf` | PDF | **bank_advice** → doc_submissions | **net vs gross** — the advice states both |

### `documents/03-procurement-and-store/`

| File | Format | Door | Tests |
|---|---|---|---|
| `10-fabric-proforma-HL-PI-26-0914.pdf` | PDF | **supplier_proforma** | lead time in prose; duty% **absent** and must stay absent |
| `11-trims-quotation-DTH-Q-2026-337.pdf` | PDF | **supplier_proforma** | priced in **BDT**, not USD — five lines |
| `12-mill-packing-list-roll-wise.xlsx` | Excel | manual | 60 rolls, shade groups, 3 failed rolls |
| `13-fabric-challan-ZJH-DC-8842.jpg` | **photo** | **delivery_challan** | bilingual, handwritten, **bonded**; row 2 is not a second material |
| `14-trims-challan-DTH-4512.jpg` | **photo** | **delivery_challan** | 4 lines, general store, 86,520 as a digit-slip trap |

### `documents/04-quality/`

| File | Format | Door | Tests |
|---|---|---|---|
| `15-measurement-chart-ST-2815.pdf` / `.xlsx` | PDF + Excel | **measurement_chart** | 10 POMs × 5 sizes = **50 points**, one Tol ± column |
| `16-fabric-4point-inspection.pdf` | PDF | manual | 12 rolls, 3 fail, lot accepted with segregation |
| `17-inline-qc-dhu-tally.xlsx` | Excel | manual | hourly defect tally, DHU 5.48% over threshold |
| `18-final-inspection-AQL-report.pdf` | PDF | manual | ISO 2859-1 sample size the machine must compute |

### `documents/05-floor-cutting-production-maintenance/`

| File | Format | Door | Tests |
|---|---|---|---|
| `19-cutting-sheet-LAY-41.jpg` | **photo** | **cut_sheet** | three numeric rows — only **ACTUAL CUT** is the answer |
| `20-hourly-sheet-L3.jpg` | **photo** | **hourly_sheet** | 9 hours not 10 (lunch is ruled through), plus a downtime table |
| `21-machine-nameplate-flatlock.jpg` | **photo** | **machine_nameplate** | a metal plate at an angle; `03/2026` as a date |

### `documents/06-shipment-and-finance/`

| File | Format | Door | Tests |
|---|---|---|---|
| `22-packout-sheet-pallet-1.pdf` | PDF | **packing_list** | 40 cartons, one content line each; the TOTAL row is not a carton |
| `23-packing-list-shipment-1.xlsx` | Excel | manual | all 500 cartons + size summary — the bank's copy |
| `24-commercial-invoice-TT-INV-2815-1.pdf` | PDF | manual | the bank set |
| `25-exp-form-certified.pdf` | **scan** | manual | the EXP number the bank-document gate wants |

### `documents/07-hr-and-compliance/`

| File | Format | Door | Tests |
|---|---|---|---|
| `26-attendance-and-overtime-L3.xlsx` | Excel | manual | 68 workers × 5 days, OT over the 2-hour cap |
| `27-wage-gazette-SRO-2026-11.pdf` | **scan** | **wage_gazette** | 7 grades; **tenant-wide — see §12 before filing** |
| `28-buyer-audit-report.pdf` | PDF | **audit_report** | 8 findings, 4 severities; the CAP table is not findings |

Each door document also ships `.paste.txt` (the text to paste) and `.expected.json` (the
ground truth to diff against).

---

## 2 · Merchandising — a buyer who does not exist yet

Sign in as `merchandiser@`.

**2a — create the buyer, the way the desk actually does.** `/buyers` → new lead → Nordkap
Apparel AB, Sweden → convert to buyer with code `NKA`. Expected: a buyer row with a lead
behind it. **A buyer created with no lead is a shape the product should not offer** — if
there is a "create buyer" button that skips the lead, note it.

**2b — the enquiry through the door.** `/marbim/intake` → kind **A buyer enquiry** → buyer
picker: Nordkap → paste `01-buyer-enquiry-NKA-ENQ-4471.paste.txt` and attach the PDF.
Expected in the approve inbox: 42,000 pcs, target USD 8.40, ratio 1:2:3:2:1, deadline
2026-08-27 — and **no style code**, because the paper does not carry one. A confident
`ST-2815` here is an invention and a finding.

> **Finding #1, found by this kit and now fixed.** This door failed on every document ever
> filed through it — `openai returned a value the schema rejects: buyerId Invalid UUID;
> targetPrice expected a money amount`, three attempts, every time. `buyer_enquiry` pointed
> at `rfqPayload`, the *manual-entry* schema: a required `buyerId` UUID that no document
> contains, and a string-only `targetPrice` that a model returns as a number. The buyer
> picker could not save it — `contextValues` are merged *after* the provider has validated.
> Fixed with `rfq_from_enquiry_v1`, the document-shaped twin `buyer_po` and `lc_swift`
> already had. If you see that error again, the regression guard is
> `docs/__tests__/test-kit-fixtures.test.ts`.

Approve it. Quote the enquiry back at USD 8.95 and mark the RFQ won.

**2c — the PO.** `/marbim/intake` → **A buyer's purchase order** → buyer Nordkap → paste
`02-buyer-po-NKA-PO-70318.paste.txt`, attach the PDF. Then, **before approving**, do the
diff: one style (not three, not fifteen), 42,000 pcs, USD 8.95, USD 375,900.00, ex-factory
2027-01-28, and a 15-cell breakdown whose cells **sum to 42,000**. Off White must read
1200/2400/3600/2700/1500 — if it mirrors Charcoal's ratio, the order is 44,100 pieces and
the approve inbox is the last place to catch it.

Approve. The order appears in the book **created by you**, not silently by the machine.

**2d — now run it the other way.** Reject nothing, but file the same PO again with the file
attached and **nothing pasted**. Compare the two confidence maps. Both should be plausible
and per-field; neither should be uniform.

**2e — the tech pack.** Intake → **A tech pack** → paste `04-tech-pack-ST-2815.paste.txt`,
attach the PDF. Expected: 12 lines, all four `lineGroup` values present, `0.560 kg` with
`8.00%` wastage **separate** (0.6048 in consumption means the model did arithmetic nobody
asked for, and costing will then double-count). Check `TRM-THR-40` came in as **145 m**, not
145 pcs. Approve → the BOM should be able to seed a cost sheet.

**2f — the grid and the TNA.** Open `03-order-grid-and-delivery-schedule.xlsx`. Enter the
three-shipment delivery plan on the order. Generate the TNA. Note the sheet's own warning:
shipment 3 is planned for 2027-02-18, past the L/C's latest shipment. Does anything on
screen notice yet? (It cannot — the L/C does not exist. Come back to this at §4.)

---

## 3 · Compliance — the audit that gates the order

Sign in as `compliance@`. The buyer audited this factory **before** placing the order, and
placed it conditionally.

**3a — create the audit.** `/compliance` → new audit: regime **buyer**, standard *Nordkap
Supplier Code of Conduct v6 (2025)*, auditor Vertas Assurance Ltd, date 2026-08-26.

**3b — file the report.** Intake → **A compliance audit report** → audit picker: the one you
just made → paste `28-buyer-audit-report.paste.txt`, attach the PDF. Expected: **8 findings**
— 1 critical, 3 major, 3 minor, 1 observation — with severities mapped onto the enum
(*"Critical (zero tolerance)"* is still `critical`). The **corrective action plan** at the
end of the report is seven instructions, not seven findings; if 15 findings arrive, the CAP
table was swallowed.

**3c — the critical finding should have teeth.** Close findings 2–8 with dates. Leave the
fire-exit critical open. Then check what the order screen says about a buyer order placed
against a facility with an open critical CoC finding. If nothing anywhere connects the two,
that is worth reporting — the buyer's own PO makes it a condition.

**3d — role wall.** As `merchandiser@`, try to reach the audit-report intake chip. It must
not be offered, and the server must refuse it if you get there anyway.

---

## 4 · Commercial — the credit, the ceiling, and the customs paper

Sign in as `commercial@`.

**4a — the master credit through the door.** Intake → **A letter of credit** → buyer picker:
Nordkap → paste `06-master-lc-7712-mt700-advice.paste.txt`, attach the PDF.

This is the highest-value extraction in the kit. Check the three dates:

| Field | SWIFT | Must be |
|---|---|---|
| 31C issue | `260915` | 2026-09-15 |
| **44C latest shipment** | `270210` | **2027-02-10** |
| 31D expiry | `270225` | 2027-02-25 |

A 44C that arrives as 2026-02-10 or 2027-10-02 is the single most expensive bug this
document can catch. Also: 32B is **375900.00** (that comma is thousands), 39A `5/5` becomes
tolerance **5**, and `docsRequired` is **6 entries** — the `:47A:` conditions are not
documents. Approve.

**4b — the two back-to-backs.** From `07-btb-credits-7712-01-and-02.pdf`, open `BTB-7712-01`
(Zhejiang Hualing, **USD 123,190.00**) and `BTB-7712-02` (Shantou Weiye, **USD 26,400.00**)
under `LC-7712`. The screen should show the ceiling as you go: 70% × 375,900 = **263,130**,
used **149,590**, free **113,540**.

**4c — REFUSAL ① · the third back-to-back.** Open `BTB-7712-03` for **USD 118,500.00**.
The headroom is 113,540 — it is over by **4,960**, small enough that a person eyeballing it
waves it through. **Expected: refused at the counter with the headroom figure in the
refusal.** This must never be discovered at the bank. If it saves quietly, that is critical.

**4d — the UD.** Intake → **A customs Utilization Declaration** → attach
`08-ud-2026-058-scan.pdf` **with nothing pasted** first. It is a scan; the confidence should
visibly pay for that. Then run it again with the paste and compare. Expected: `UD-2026-058`,
2026-09-28 → 2027-03-31, three authorised items in **two different units** (25,400 kg /
2,050 kg / 42,840 pcs). Approve.

That 25,400 kg is now the balance every bonded issue is checked against. Get it right.

**4e — the amendment.** Read `05-po-amendment-AMD-01.pdf`. Change the order's ex-factory to
**2027-02-14**. Expected: the LC detail page and the order should now show the conflict —
ex-factory is **four days past 44C**. This is a countdown, not a fault; it must be visible
without anybody going looking. Then check §14: the bank-document path for a post-2027-02-10
shipment should refuse until an amendment is recorded.

---

## 5 · Procurement — and the import PO with nothing behind it

Sign in as `procurement@`.

**5a — REFUSAL ② · do this one FIRST, before anything else in this section.** Raise a
purchase order to **Zhejiang Hualing Knitting Co., Ltd** (create the supplier: type fabric
mill, origin **import**, currency USD) for `FAB-FLC-280`, 25,400 kg @ 4.85. Attach **no**
back-to-back credit. **Expected: refused at financing** — an import PO must ride a
back-to-back, and the refusal must name the rule. (If you already did §4b the BTB exists;
try assigning a *different* BTB with no headroom, or check the refusal fires when the BTB is
unassigned.)

**5b — the mill's proforma.** `/procurement` → new quote → paste
`10-fabric-proforma-HL-PI-26-0914.paste.txt`, attach the PDF. Expected: `HL-PI-26-0914`,
CFR Chattogram, USD, one line at 25,400 kg @ 4.85, **lead time 35** (read out of the prose
"35 days from receipt of workable L/C"), MOQ 5,000, freight 1,850.00 — and **`dutyPct`
absent**. A zero there is an invention.

**5c — the trims quotation, in taka.** New quote → paste
`11-trims-quotation-DTH-Q-2026-337.paste.txt`. Expected: currency **BDT** across five lines.
If it defaults to USD, a zipper is now priced at USD 34.50 and the costing studio will
believe it. Check 1.15 and 7.20 survive as two-decimal strings.

**5d — raise the POs properly.** Import PO to the mill against `BTB-7712-01`; local PO to
Dhaka Trims House against the quotation. The trims PO needs no BTB — check it is not asked
for one.

---

## 6 · Store — the gate, the bond, and three ways to be told no

Sign in as `store@`. The screens are **Bangla-first** — that is correct, not a bug.

**6a — receive the fabric.** `/store/receive` → drop zone → attach
`13-fabric-challan-ZJH-DC-8842.jpg` (a photograph of the challan, which is how it arrives).
Expected pre-fill: `ZJH-DC-8842`, 2026-11-12, Zhejiang Hualing, **ONE line** —
`FAB-FLC-280`, 1,567.0 kg. Row 2 of the challan restates row 1 as a roll count the way
challan books do; a second "rolls" material is a phantom. The red handwriting *"3 rolls
damaged — see QC"* is a note, not a field.

Mark it **bonded** against `UD-2026-058`. Then type the 60 rolls from
`12-mill-packing-list-roll-wise.xlsx`, with their shade groups. Without them there is no roll
traceability and the shade trap in 6d cannot exist.

**6b — receive the trims.** Same door, `14-trims-challan-DTH-4512.jpg`. Four lines, all pcs,
**general store — nothing bonded**. If the receipt asks for a UD, the bonded default is
wrong. Check 86,520 eyelets did not become 8,652 or 865,200.

**6c — REFUSAL ③ · the customs overdraw.** `/store/issue` → issue **25,600 kg** of
`FAB-FLC-280` against this order. `UD-2026-058` authorises **25,400**. **Expected: a HARD
BLOCK** — this is legal exposure, not a warning. Then, as `owner@` in the incognito window,
walk the **written override** the block offers: it must demand a reason and land in the audit
log. *(Completing the override spends the balance for later testers — once per tenant is
enough. Note it in your findings if you do.)*

**6d — the shade mix (warns, does not block).** Issue rolls `R-F-39` and `R-F-40` (shade
group **B**) to an order whose only issue so far was group A. Expected: a **warning naming
the shade conflict** — a planned shade change is legitimate, so this one warns. Cancel the
issue so the trap stays armed.

**6e — the failed rolls.** Try to issue `R-F-17`, `R-F-44`, `R-F-58` — the three that failed
4-point at the mill and again in §7a. **Expected: not issuable at all**, either not offered
or refused with the inspection result cited.

**6f — the real issue.** Issue rolls `R-F-01` … `R-F-21` (group A) to the order, 521.3 kg,
for `LAY-41`. This is the one that must succeed.

---

## 7 · Quality — before the fabric, during the sewing, after the pack

Sign in as `quality@`.

**7a — the incoming fabric.** `/quality/fabric` → 4-point inspection against the GRN, from
`16-fabric-4point-inspection.pdf`: 12 rolls inspected, `R-F-17` (24 pts), `R-F-44` (27) and
`R-F-58` (22) fail against a 20-point limit. Expected: the three failed rolls change state
and become un-issuable (that is what makes 6e work). Passing a failed roll on re-inspection
should make it issuable again — try it on one, then fail it back.

**7b — the measurement chart.** Intake → **A measurement chart** → paste
`15-measurement-chart-ST-2815.paste.txt`. Expected: **50 points**, not 10 — a graded row is
one point *per size*, named like `A Chest width, 1 cm below armhole — size M`. Ten points
with five values each cannot be stored. The chart prints one `Tol ±` column and the schema
folds it both ways, so `tolPlus` and `tolMinus` should both carry it.

**7c — the negative test that matters.** Take the same `.paste.txt`, join every row into
**one single line**, and file it again. Columns pair with the wrong size at high confidence
— this is a real historical failure mode. The point is not that the model fails; it is that
a human can *see* it fail in the approve inbox. Check that they can. Reject it with a reason
and confirm the rejection is recorded.

**7d — inline, during sewing.** After §9, `/quality/inline` → tap defects against `L-3` from
`17-inline-qc-dhu-tally.xlsx`: 71 defects on 1,295 checked. Expected: **DHU 5.48%** and an
alert, because the threshold for this style is 5.00%. The grid must be semantic
(`BROKEN_STITCH`, `SKIP_STITCH`, `OIL_STAIN`…), not free text.

**7e — final inspection.** `/quality/final` against shipment 1's 12,000 pcs from
`18-final-inspection-AQL-report.pdf`. **The AQL sample size must be computed by the machine,
never typed** — lot 12,000 at level GII is code M, **sample 315**, accept 14 major / 21
minor. Enter 9 major and 18 minor → **PASS**. Then try entering a sample size by hand; if
the field is editable, that is a finding.

---

## 8 · Cutting — the gate, then the lay

Sign in as `cutting@`.

**8a — REFUSAL ④ · cut before PP.** With no approved PP sample on `ST-2815`, try to start a
lay. **Expected: refused, naming the PP gate.** This is the whole point of a PP sample.

**8b — release it.** As `merchandiser@`: `/sampling` → raise `SR-2815-PP`, dispatch it,
record the buyer's verdict **approved**. Back as `cutting@`, the order should now be cuttable
— the gate working in the release direction.

**8c — the lay.** Open `LAY-41`: Charcoal Melange, 96 plies, marker `ST-2815-A`, ratio
XS1 S2 M3 L2 XL1, rolls `R-F-01`–`R-F-21`.

**8d — the cut report through the door.** `/cutting/report` → drop zone → attach
`19-cutting-sheet-LAY-41.jpg`.

**This is the sharpest trap in the kit.** The sheet has three numeric rows and only the
bottom one is the answer:

| | XS | S | M | L | XL | Total |
|---|---:|---:|---:|---:|---:|---:|
| Marker ratio | 1 | 2 | 3 | 2 | 1 | 9 |
| Should cut | 96 | 192 | **288** | 192 | 96 | 864 |
| **ACTUAL CUT** | 96 | 192 | **286** | 192 | 96 | **862** |

"Should cut" differs in exactly one cell. If `M` comes back **288**, two rejected panels have
been manufactured back into existence and the bundle count will not reconcile downstream.
Expected: **862**. File it, and check the bundles appear.

---

## 9 · Production — the hour, and the hour that never happened

Sign in as `production@`.

**9a — live.** `/lines/hourly` → enter this hour's output for `L-3` against `ST-2815`.

**9b — the catch-up door.** Drop zone → attach `20-hourly-sheet-L3.jpg`. Expected:
**nine hours, not ten.** The 13:00–14:00 band is ruled through for lunch; an hour with
`actual: 0` drags the day's efficiency down by a tenth and earns the line a run-rate alert
it did not deserve. Also check:

- `hourSlot` is the 24-hour **start** of the band — `14–15` is **14**, not 2.
- Exactly **two** remarks (hours 8 and 14); the rest absent, not empty strings.
- The `TOTAL` row (1,295) is not a tenth hour.
- The **downtime log** underneath has times in it (09:40 / 14:10 / 16:35) and is a different
  table. Three extra hours with actual 25 / 12 / 6 means it was swallowed.

Expected after saving: efficiency recomputes from SMV × output — 1,295 × 18.6 over 68
operators × 9 h = **65.6%**.

**9c — the offline round-trip, on a phone.** Airplane mode ON → enter an hour → the row
queues with a pending mark → airplane mode OFF → it syncs **once**. A duplicate row is a
critical finding; that is the `offline_key` promise.

---

## 10 · Maintenance — a machine, and a ticket

Sign in as `maintenance@`.

**10a — the nameplate.** `/maintenance` → Machines → the reader door → attach
`21-machine-nameplate-flatlock.jpg`. This one has no useful text path — a nameplate is a
photograph or it is nothing. Expected: Suzuka Sewing Machine Co., `SZ-988-FL`, serial
**`SZ26-204417`** (letters and dash intact — a serial transcribed as `26204417` cannot be
matched to the plate later, which is the entire point of recording it), type in words
(*5-thread flatlock / coverstitch*). `MFG. DATE 03/2026` → 2026-03-01 or absent; **not**
2026-03-26.

**10b — the ticket.** The hourly sheet's downtime log names this machine: *"L-3 flatlock
SZ26-204417 — looper timing, 25 minutes"*. As `production@`, open a ticket against it. As
`maintenance@`, claim → resolve. Both should notify the reporter.

---

## 11 · Planning

Sign in as `planner@`. With the order, the TNA and `L-3`'s output in place:

- Does the capacity plan show `ST-2815` against the line, and does the 3-shipment schedule
  from `03-order-grid-and-delivery-schedule.xlsx` reconcile with the TNA?
- At 1,295 pcs/day on one line, 42,000 pcs is ~33 line-days. Ex-factory is 2027-01-28 (or
  2027-02-14 after the amendment). Does the plan say whether that lands?
- The planner also holds the `hourly_sheet` door. Confirm a planner can file 9b and a
  `quality@` cannot.

---

## 12 · HR and payroll

Sign in as `hr@`.

**12a — attendance and overtime.** Open `26-attendance-and-overtime-L3.xlsx`: 68 workers,
five days, in/out and OT hours. Load a week against `L-3` (however the screen takes it).
Rows showing **2.5 hours** exceed the 2-hour statutory cap and connect straight to the
buyer's audit finding — does anything flag them?

**12b — the payroll arithmetic.** Run a period for these workers. Check by hand on one:
OT = **2 × basic ÷ 208** per hour. Two festival bonuses a year, pro-rated. If the numbers do
not tie to the gazette grades, stop — that is the parallel-run gate, and
`pnpm payroll:parallel-run` exists for exactly this.

**12c — the gazette. READ THIS FIRST.** `27-wage-gazette-SRO-2026-11.pdf` is a **scan** and
it is **tenant-wide, not order-specific**. Approving it changes every payroll on this tenant,
including the other kit's. **Only file it if the tenant has no active gazette**, or file it
and leave it **inactive** — it should land inactive and need a separate activation, and that
two-step is the thing worth verifying. Expected: version `SRO-2026-11`, effective
2026-12-01, **7 grades**. The `Gross` column is the sum of the other five and is not a field;
a basic that comes back as 17,250 has read the gross.

**12d — the walls.** As `admin@`, open Payroll → **bodyless 403**. That refusal is a passing
test (rule 9: hr + owner only). As `production@`, ask MARBIM for payroll numbers → refused,
politely. As `merchandiser@`, try the wage-gazette intake chip → not offered.

---

## 13 · Shipment

Sign in as `shipment@`.

**13a — REFUSAL ⑤ · bank documents with no EXP.** Before recording anything from
`25-exp-form-certified.pdf`, try to open bank documents for shipment 1. **Expected: refused,
naming the EXP-before-bank gate.** Then record EXP `EXP-2027-KMB-041182` (dated 2027-01-14)
and try again — it should open.

**13b — over-packing.** Try to pack more cartons than finishing has produced packable pieces
for. Expected: a **server-side** refusal, not a greyed-out button. Try the same write twice
quickly to be sure the gate is not UI-only.

**13c — the pack-out sheet.** `/shipment` → Pack → drop zone → paste
`22-packout-sheet-pallet-1.paste.txt`. Expected: **40 cartons**, each with exactly **one**
content line (solid colour, solid size, 24 pcs), gross `15.50` and net `14.52` as decimal
strings. The `TOTAL` row is not a carton — 41 cartons, or one numbered `TOTAL`, is the
failure this document is shaped to catch.

**13d — the rest of the shipment.** Load the remaining 460 cartons from
`23-packing-list-shipment-1.xlsx` (500 total, 12,000 pcs, net 7,260.00 kg, gross 7,750.00 kg,
42.000 CBM). Check the size summary matches the carton rows: XS 75 / S 150 / M 225 / L 50
cartons, and **no XL in shipment 1**.

**13e — the amendment bites.** After §4e moved ex-factory to 2027-02-14: try to build the
bank document set for a shipment leaving after **2027-02-10**. Expected: refused or hard-
warned against `LC-7712`'s 44C until an amendment is recorded.

---

## 14 · Finance

Sign in as `finance@`.

**14a — the invoice.** `24-commercial-invoice-TT-INV-2815-1.pdf` — USD 107,400.00 for
12,000 pcs. Check it against the order's money trail.

**14b — the realization advice.** `/lcs` → Submissions → the presentation under `LC-7712` →
drop zone → paste `09-bank-realization-advice.paste.txt`.

**The trap is net versus gross.** The advice states both, and the gross is the larger, more
prominent number:

| | USD |
|---|---:|
| Document value / gross | 107,400.00 |
| Foreign bank charges | 92.50 |
| Courier | 45.00 |
| Negotiation commission 0.25% | 268.50 |
| **Net credited** | **106,994.00** |

`realizedAmount` must be **106,994.00**. Taking the gross silently overstates realized export
proceeds, which is a Bangladesh Bank reporting problem, not a rounding one. Three deductions
— the BDT conversion line at the bottom is not one, it is how the net was split between two
accounts. Post it, then confirm the realization shows against the order.

---

## 15 · Owner and admin — the view from the top

Sign in as `owner@`.

- `/home` should read like a morning briefing: this order in the book, the open critical
  compliance finding, the DHU alert, the L/C date countdown, the approve queue.
- `/approve` — everything this walk queued should have passed through here, **and nothing
  should have auto-approved**. Spot-check three drafts for per-field confidence with a
  measured value, not a constant.
- **Audit log** — the UD override from §6c, the order's creation, the payroll reads. Every
  ⚖ table write should be there with a person's name on it.
- **MARBIM, as different roles**, expecting numbers with links and role walls that hold:
  - as `commercial@`: *"How much headroom is left under LC-7712?"* → the 113,540 story.
  - as `store@`: *"Can I issue 25,600 kg of fleece against NKA-PO-70318?"* → it should warn
    about `UD-2026-058` **before** you ever open the issue screen.
  - as `production@`: *"What was L-3's efficiency on 8 December?"* → 65.6%, with its working.
  - as `viewer@`: anything about payroll → refused, politely.
- **The phone.** Install the PWA as `production@` (bottom tabs *This hour · Endline ·
  Tickets*), enable push, fail a GRN inspection as `store@` and check the buzz. Sign out,
  sign in as `production2@`, re-enable — the device must buzz for the new person only.

---

## 16 · When something refuses — or fails

A refusal that names its rule — the headroom figure, the UD balance, the PP state, the EXP
gate — **is the product working**. Log a finding when you see:

- a silent failure, or a save that should have been refused
- an English-only floor screen (store, cutting, production, quality, maintenance are
  Bangla-first)
- a raw identifier, a bare UUID or a JSON blob where a sentence belongs
- a gate that only exists in the UI — try the same write twice, fast
- numbers that disagree between two screens, or with `01-ORDER-STORY.md`
- an extraction that invented a value the paper does not carry (the `_notes` in each
  `expected.json` name the ones worth watching)

Format, one line each — **phase · login · what you did · expected · got · screenshot**.
Bring the list back; don't debug live.

---

## Regenerating the pack

```bash
cd docs/test-kits/test-textile-nordkap/generate
python3 build.py          # rewrites documents/ and the zip, deterministically
```

Needs `reportlab`, `openpyxl` and Pillow **with raqm** (the bilingual floor documents need
Bangla shaping). Change a number in `generate/_order.py` and every document that mentions it
moves together — that is why the kit is generated rather than written.

---

*Fixture notice: Nordkap Apparel AB, Zhejiang Hualing Knitting Co., Shantou Weiye Textile
Trading, Ashulia Knit & Dyeing, Nordbanken Kommers AB, Karnaphuli Mercantile Bank Ltd,
Dhaka Trims House, Vertas Assurance Ltd, Meghna Freight & Logistics and Suzuka Sewing
Machine Co. are invented for this kit. Any resemblance to a real company is accidental. None
of these documents is real business paper; none carries legal meaning. Every file is stamped
as a test fixture.*
