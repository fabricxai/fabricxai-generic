# Findings — §5 Procurement, Nordkap kit

Walked 2026-08-16 against **baraka.fabricxai.com** (image `da49a62a`, commit `7997e39`) as
`procurement@testtextile.test`, driving the real screens. Company `Test Textile Ltd`
(`a94a2baa-…`). Every claim below was checked twice: once through the UI, once against the
rows the UI wrote.

**Verdict: the reading works, the money gate does not.** MARBIM read both papers close to
the letter — the trims quotation came back in taka with all five lines and its awkward
decimals intact, which is the thing §5c exists to catch. But an import purchase order for
USD 123,190 was accepted against a back-to-back credit worth USD 34,500, silently, and that
is the failure §5a was written to provoke.

---

## What passed

| Kit step | Result |
|---|---|
| §5b · proforma read | `HL-PI-26-0914`: quoted-on, valid-until, USD, CFR Chattogram, item matched to `FAB-FLC-280`, 4.85, **lead time 35 read out of the prose**, MOQ 5,000. Freight missed (F7). |
| §5c · trims quotation | `DTH-Q-2026-337`: **BDT held** across all five lines, every item matched, `1.15` and `7.20` survived as two-decimal strings, lead times and MOQs all correct. |
| §5d · local PO | The trims PO asks for no back-to-back credit. Correct — a local purchase is not financed from one. |
| Landed-cost comparison | Fabric ranked at **4.92 USD/kg** landed (4.85 + 1,850 ÷ 25,400), "arrives 2026-10-19", cheapest flagged and not pre-selected. |
| Stated exchange rate | A BDT quote refuses to rank until a rate is stated, then ranks with the rate carried in the URL (`?rate=0.0083`) so the decision can be reconstructed. This is right. |
| Requisition detail page | Renders its empty-comparison state as a sentence. (This was React #441 until `7997e39` earlier today.) |

---

## F1 · CRITICAL — an import PO is never checked against the credit funding it

`PO-2815-F`, **USD 123,190.00**, was issued against **`BTB-4471-01`, value USD 34,500.00**,
and saved without complaint. The credit is short by USD 88,690 — and it belongs to
`LC-4471`, a master credit from an unrelated order, not to `LC-7712` which covers this one.

The gate (`modules/procurement/service.ts:514`) asserts two things: that a BTB id was
supplied, and — via `checkBtbHeadroomIn` (`modules/commercial/service.ts:439`) — that the
BTB *credits themselves* sum to no more than `limitPct`% of their master LC. Neither
compares the purchase order's value to the credit's. It structurally cannot: `totalValue`
is not computed until line 543, **after** the gate has already passed.

So the rule the product states everywhere — "an import PO must ride a back-to-back" — is
enforced as *a BTB must be attached*, not as *the BTB must fund it*.

**Fix:** after `totalValue` is known, refuse when `totalValue + already-committed POs on
this BTB > BTB value`, with the shortfall named in the refusal. Separately, refuse a BTB
whose master LC is not the credit behind the order the requisition belongs to — funding a
Nordkap PO from `LC-4471` should never be offerable.

## F2 · HIGH — the BTB picker has no "none", and defaults to whatever is first

`requisition-client.tsx:73` seeds the selection with `btbs[0]?.id`, and line 449 offers an
empty option *only when the list is empty*. Consequences, both live:

- §5a's stated refusal — an import PO with **no** credit attached — cannot be produced by a
  person through this screen at all. The server would refuse it (`gates.btb_headroom.no_btb`);
  nobody can get there.
- A buyer who never touches the dropdown silently attaches the first credit in the list.
  That is exactly how `PO-2815-F` came to sit on `BTB-4471-01`.

**Fix:** no pre-selection. An unchosen credit is an unanswered question, and for an import
supplier the button should stay disabled until it is answered.

## F3 · HIGH — blank duty, freight and MOQ are stored as zero

`modules/procurement/zod.ts:77-79` gives `moq`, `freight` and `dutyPct` a default of `'0'`,
and the dialog omits blank fields — so "nothing stated" becomes a stated zero on the way in.
The recorded proforma line has `duty_pct = 0.00`, and the comparison screen prints
**"0.00 duty"** as though the mill had quoted it.

Both the kit and the product's own copy say the opposite. Kit §5b: *"`dutyPct` absent. A
zero there is an invention."* The dialog, immediately above the fields: *"Left blank they
count as nothing stated, never as zero."*

This one decides money. A landed-cost comparison that treats an unstated duty as 0% ranks an
import quote as cheaper than it is, which is the single thing the comparison exists to
prevent.

**Fix:** drop the defaults; keep the columns nullable; render an unstated duty as "—" and
say so where the two quotes differ in what they stated.

## F4 · HIGH — `validUntil` is read, shown, and then thrown away

The reader extracts it (2026-10-15 for the proforma, 2026-10-31 for the trims), the field
displays it, and `new-quote.tsx:167` never puts it in the payload. The column exists and is
nullable, so both quotes recorded today have `valid_until = NULL`.

A proforma's validity window is what tells a buyer the price is stale. Silently discarding
it makes an expired quote look current forever.

## F5 · HIGH — the paper the model read is not attached to the quote

`ReadFields.document` is ignored by the quote dialog, and `documentId` — accepted by
`supplierQuotePayload`, with a column on `supplier_quotes` — is never sent. `has_doc` is
false on both quotes.

The whole justification for reading a document with a model is that a person can check the
figures against the original. Here the original is uploaded, read, and then unfindable.

## F6 · MEDIUM — the confidence the copy promises is never rendered

The reader says *"the percentages say where to look first"*. No percentage appears anywhere
in this dialog. `new-quote.tsx` ignores `read.confidence` and never renders `ReadMark`,
which `new-order.tsx`, `new-lc.tsx` and `new-ud.tsx` all do.

The kit leans on this ("a scan that comes back at 1.000 on every field has not been read"),
and on this door there is nothing to lean on.

## F7 · MEDIUM — freight was not extracted from the proforma

The paper says `Ocean freight: USD 1,850.00 - included in the CFR price`. The read schema
has the slot (`quoteFromProformaDraft`, `freight: stated(transcribedMoney)`). The field came
back empty and had to be typed. Expected by kit §5b.

## F8 · MEDIUM — extraction ran on `gpt-4o-mini`, and says so to the user

The dialog reports *"read by gpt-4o-mini"*. Two problems: the architecture's extract role is
Gemini (`MARBIM_MODEL_EXTRACT` on the box appears to point elsewhere — worth checking against
what the briefs say), and a raw vendor model id is not something a factory user should be
shown. A sentence like "read by the document reader" carries the same meaning.

## F9 · MEDIUM — no paste box on this door

Kit §5b and §5c both instruct pasting the `.paste.txt`. The inline reader is attach-only
("Drop the proforma or quotation here · or choose a file"). The kit's stated path 2 — and
its instruction to *run both paths and compare the confidence maps* — cannot be followed
here. Either the reader grows a paste box or the kit should say this door is attach-only.

## F10 · MEDIUM — the supplier's own reference has nowhere to live

`HL-PI-26-0914` and `DTH-Q-2026-337` are extracted (`reference` is in the read schema) and
then dropped: no field in the dialog, no column on `supplier_quotes`. A recorded quote
cannot be traced back to the paper by its number, which is how every supplier conversation
actually refers to it.

## F11 · MEDIUM — "Record a quote" vanishes when no requisition is open

`NewQuoteButton` returns `null` when `openRequisitions` is empty, and a requisition drops out
of that list the moment a PO is issued against it (`status = 'ordered'`). So a quote that
arrives after the order — a revised price, a second mill answering late — cannot be recorded
at all, and the button's absence explains nothing.

This is what the user hit before this walk: `PR-2815-F` went to `ordered`, and the button
disappeared with it.

## F12 · LOW — sub-cent landed prices collapse to 0.01

The eyelet at 1.15 BDT lands at 0.009545 USD and displays as **0.01 USD**, as would 1.19 BDT.
Two trims quotes 30% apart are visually identical per unit; only the landed total separates
them. Trims are quoted in fractions of a taka as a matter of course.

## F13 · LOW — a quote line carries no quantity

Kit §5b expects "one line at 25,400 kg @ 4.85". The quote line records price, lead time, MOQ,
freight and duty — the quantity comes from the requisition. That is defensible, but it means
a mill quoting *a different quantity* than requested (a common answer) cannot be recorded as
what it is. Decide which way this goes and correct either the kit or the schema.

## F14 · LOW — `priceTerm` read as "EXW", not "EXW Dhaka"

The fabric proforma's "CFR Chattogram" came back whole; the trims quotation's "EXW Dhaka"
lost its port. Expected `EXW Dhaka`.

## F15 · LOW — nothing distinguishes a supplier code from an item code

`Zhejiang Hualing Knitting Co., Ltd` exists on this tenant with the code **`FAB-FLC-280`** —
an item code, typed into the supplier form. The supplier list now shows a fabric code as a
mill's identity. Worth a format hint or a soft warning when a code collides with an item's.

## F16 · LOW — the empty-comparison sentence reads as a bug

> No quotes have been recorded against this requisition, so there is nothing to compare. —
> quotes come in the currency each supplier works in, and a comparison across two of them is
> only a decision once somebody states the rate it was made at.

A full stop followed by an em dash and a lower-case clause. The two halves are a message and
an eyebrow that were never meant to be read as one sentence.

## F17 · Kit gap — §5 assumes items that no seed creates

`pnpm seed:kit` seeds the older kit's six items (`YRN-30-1`, `FAB-PIQ-180`, `TRM-PLK` …).
Nordkap's `FAB-FLC-280`, `FAB-RIB-1X1`, `TRM-ZIP-OE65`, `TRM-CORD-8`, `TRM-EYELET-8`,
`TRM-LBL-MAIN`, `TRM-LBL-CARE` exist in no script — they must be added by hand at `/setup`
before §5 can start, and the kit never says so. Note also that `TRM-ZIP` (old) and
`TRM-ZIP-OE65` (Nordkap) now sit side by side in every picker.

Add them to `scripts/seed-kit-materials.ts`, or give §5 a precondition line.

---

## State left on the tenant

Created during this walk, all recoverable:

- `PR-2815-T` — trims requisition, 5 lines, now `quoted`
- `PR-2815-F2` — fabric requisition, 25,400 kg, now `quoted`
- Supplier quote · Zhejiang Hualing on `PR-2815-F2` — USD, freight typed by hand
- Supplier quote · Dhaka Trims House on `PR-2815-T` — BDT, 5 lines

Pre-existing and **worth correcting**: `PO-2815-F` (USD 123,190) rides `BTB-4471-01`
(USD 34,500, under `LC-4471`). It is the evidence for F1; once F1 is fixed, cancel it and
re-issue against `BTB-7712-01`.
