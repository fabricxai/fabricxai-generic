# The order, end to end — NKA-PO-70318

One buyer who has never traded with this factory, one style, one paper trail. Every number
below appears on at least one document in `documents/`, and every document is generated from
one source file (`generate/_order.py`), so the tech pack's consumption, the BTB's value, the
UD's balance and the packing list's carton count cannot disagree. **If a screen shows a
number that is not here, that is the finding.**

---

## The parties

| | |
|---|---|
| **Factory (the tenant)** | Test Textile Ltd · Plot 44–46, Sector 3, Karnaphuli EPZ Road, Ashulia, Savar · BIN 004471003-0201 · BGMEA 3318 · bond licence 18/Cus/Bond/2019 |
| **Buyer — NEW** | **Nordkap Apparel AB** (`NKA`), Lindholmsallén 32, 417 55 Göteborg, Sweden · contact E. Sandberg, Sourcing Manager |
| Fabric mill (import) | Zhejiang Hualing Knitting Co., Ltd — Shaoxing, China |
| Trims (local) | Dhaka Trims House — Tejgaon, Dhaka *(already a supplier on this tenant)* |
| Bank (advising) | Karnaphuli Mercantile Bank Ltd, Gulshan Corporate Branch · SWIFT KRMLBDDH |
| Bank (issuing) | Nordbanken Kommers AB, Stockholm · SWIFT NDKMSESS |
| Auditor | Vertas Assurance Ltd, Dhaka — on behalf of the buyer |

Nordkap is **not in the database**. Neither is Zhejiang Hualing, Ashulia Knit, Nordbanken or
Vertas. Creating them is step one of the walk, and it is a test in its own right.

---

## The style

**ST-2815** · ladies' brushed-fleece full-zip hoodie · buyer article NK-90455 · season AW-27 Core

Two-panel lined hood, kangaroo pocket, 1×1 rib cuff and hem, centre-back 3-colour print,
YKK #5 open-end zipper, brushed back fleece 280 g/m² in 80% cotton / 20% polyester.

## The quantity

| Colour | Code | XS | S | M | L | XL | Total |
|---|---|---:|---:|---:|---:|---:|---:|
| Charcoal Melange | CHM | 1,800 | 3,600 | 5,400 | 3,600 | 1,800 | **16,200** |
| Deep Navy | NVY | 1,600 | 3,200 | 4,800 | 3,200 | 1,600 | **14,400** |
| Off White | OFW | 1,200 | 2,400 | 3,600 | 2,700 | 1,500 | **11,400** |
| **Total** | | **4,600** | **9,200** | **13,800** | **9,500** | **4,900** | **42,000** |

The three colours **do not share a size ratio** — Off White is graded differently. This is
deliberate: a breakdown screen or an extractor that applies one ratio across all three
colours produces 44,100 pieces, and that is a bug worth catching.

## The money

| | |
|---|---:|
| Unit price, FOB Chattogram | USD 8.95 |
| Order value | **USD 375,900.00** |
| Master credit `LC-7712` · 32B | USD 375,900.00 |
| Tolerance (39A) | 5/5 |
| Issue (31C) | 2026-09-15 |
| **Latest shipment (44C)** | **2027-02-10** |
| Expiry (31D) | 2027-02-25 |
| Payment | 120 days from B/L date |
| BTB ceiling at 70% of master | USD 263,130.00 |
| `BTB-7712-01` — Zhejiang Hualing (fleece) | USD 123,190.00 |
| `BTB-7712-02` — Shantou Weiye (rib + trims) | USD 26,400.00 |
| **Free BTB headroom** | **USD 113,540.00** |

## The calendar

| Date | What |
|---|---|
| 2026-08-18 | Enquiry `NKA-ENQ-4471` arrives, target USD 8.40 |
| 2026-08-26 | Buyer's compliance audit — **1 critical finding**, order placed conditionally |
| 2026-09-02 | PO `NKA-PO-70318` |
| 2026-09-05 | Tech pack `ST-2815` **Rev 2** (supersedes Rev 1 of 2026-08-29) |
| 2026-09-14 | Mill proforma `HL-PI-26-0914` |
| 2026-09-15 | Master credit `LC-7712` issued |
| 2026-09-18 | Trims quotation `DTH-Q-2026-337` (BDT) |
| 2026-09-22 / 09-30 | Back-to-backs 01 and 02 |
| 2026-09-28 | **UD-2026-058** issued, valid to 2027-03-31 |
| 2026-11-12 | Fabric tranche 1 at the gate — challan `ZJH-DC-8842` |
| 2026-11-13 | 4-point inspection — **3 rolls fail** |
| 2026-11-18 | Trims challan `DTH-4512` |
| 2026-11-26 | `LAY-41` cut |
| 2026-12-08 | Line `L-3` hourly sheet |
| **2026-12-20** | **PO amendment `AMD-01` — ex-factory moves to 2027-02-14, past 44C** |
| 2027-01-14 | EXP `EXP-2027-KMB-041182` certified |
| 2027-01-18 | Final inspection `FI-2815-01` — PASS |
| 2027-01-22 | Invoice `TT-INV-2815-1`, B/L `MAEU-CTG-771904` |
| 2027-02-18 | Realization advice `KMB/EXP/2027/09117` |

## The materials

Consumption is **per finished piece**; wastage is an allowance added on top, not folded in.

| Material | Cons/pc | Wastage | Booked |
|---|---:|---:|---:|
| `FAB-FLC-280` brushed fleece 280 g/m² | 0.560 kg | 8% | **25,400 kg** |
| `FAB-RIB-1X1` 1×1 rib 240 g/m² | 0.045 kg | 8% | **2,050 kg** |
| `TRM-ZIP-OE65` YKK #5 open-end 65 cm | 1 pc | 2% | 42,840 pcs |
| `TRM-CORD-8` drawcord 8 mm × 130 cm | 1 pc | 3% | 43,260 pcs |
| `TRM-EYELET-8` eyelet 8 mm | 2 pcs | 3% | 86,520 pcs |
| `TRM-LBL-MAIN` / `TRM-LBL-CARE` | 1 pc each | 2% | 42,840 pcs each |
| `TRM-THR-40` thread 40/2 | 145 m | 5% | — |
| `PKG-CTN-5PLY` carton, 24 pcs/carton | 0.0417 pcs | 1% | 1,750 cartons |

**UD-2026-058 authorises** 25,400 kg fleece + 2,050 kg rib + 42,840 zippers. That fleece
figure is the balance every bonded issue is checked against for the life of this order.

## What actually arrived

Fabric tranche 1 — Charcoal Melange only, lot `HL-L1-CHM`:
**60 rolls, 1,567.0 kg**, rolls `R-F-01` … `R-F-60`.

- Shade group **A**: `R-F-01` … `R-F-38` · shade group **B**: `R-F-39` … `R-F-60`
- **Failed 4-point** (>20 pts/100 sq yd): `R-F-17` (24), `R-F-44` (27), `R-F-58` (22)
- 12 rolls inspected (20%), 9 passed, lot **accepted with segregation**

## What the floor did

**`LAY-41`** · 2026-11-26 · Charcoal Melange · 96 plies · marker `ST-2815-A` (XS1 S2 M3 L2 XL1)
· rolls `R-F-01`–`R-F-21` · 521.3 kg

| | XS | S | M | L | XL | Total |
|---|---:|---:|---:|---:|---:|---:|
| Should cut | 96 | 192 | 288 | 192 | 96 | 864 |
| **Actual cut** | **96** | **192** | **286** | **192** | **96** | **862** |

Two M panels rejected for a fabric fault on `R-F-09`. **862 is the answer, not 864.**

**Line `L-3`** · 2026-12-08 · 68 operators · SMV 18.6 · target 145/hr

Nine productive hours (13:00–14:00 is lunch and is ruled through), **1,295 pcs**,
efficiency **65.6%**. Downtime 43 minutes across three stoppages.
Inline QC: 71 defects on 1,295 checked = **DHU 5.48%** — above the 5.00% threshold.

## Shipment 1 of 3

12,000 pcs Charcoal Melange · 500 cartons at 24 pcs, solid colour solid size ·
net 7,260.00 kg · gross 7,750.00 kg · 42.000 CBM · `MAERSK KALMAR / 703W` ·
Chattogram → Gothenburg.

Final inspection: ISO 2859-1, level GII, code M, **sample 315**, AQL 2.5 major / 4.0 minor.
Found 9 major (accept 14) and 18 minor (accept 21) — **PASS**.

Invoice USD 107,400.00 → realized **USD 106,994.00 net** after USD 406.00 of bank
deductions, value 2027-02-18.

---

## The five armed refusals

Each one is set up by the paper and fires from the server, not the UI. A refusal that names
its rule is the product working.

| # | Where | Do this | Must refuse because |
|---|---|---|---|
| ① | Commercial → LCs | Open a third BTB under `LC-7712` for **USD 118,500** | Free headroom is USD 113,540 — over by **4,960** |
| ② | Procurement | Raise the import PO to Zhejiang Hualing **before** `BTB-7712-01` exists | An import PO must ride a back-to-back credit |
| ③ | Store → Issue | Issue **25,600 kg** of `FAB-FLC-280` against this order | UD-2026-058 authorises 25,400 kg — customs exposure, **hard block + owner override** |
| ④ | Cutting | Start `LAY-41` **before** the PP sample is approved | PP approval gates cutting |
| ⑤ | Shipment → Bank docs | Open bank documents before `EXP-2027-KMB-041182` is recorded | EXP-before-bank gate |

Two more that warn rather than block:

- **Shade mix** — issuing `R-F-39`+ (group B) to an order already cut in group A.
- **Failed rolls** — `R-F-17`, `R-F-44`, `R-F-58` must not be issuable at all.

And one that is a *countdown*, not a fault: after the amendment, ex-factory **2027-02-14**
sits four days past 44C **2027-02-10**. The LC detail screen should say so, loudly, and the
bank-document path for any post-2027-02-10 shipment should refuse until an amendment is
recorded.

---

*Fixture notice: Nordkap Apparel AB, Zhejiang Hualing Knitting Co., Shantou Weiye Textile
Trading, Ashulia Knit & Dyeing, Nordbanken Kommers, Karnaphuli Mercantile Bank, Dhaka Trims
House, Vertas Assurance, Meghna Freight & Logistics and Suzuka Sewing Machine Co. are all
invented for this kit. None of these documents is real business paper.*
