# Findings — §5 Procurement, Nordkap kit

Walked 2026-08-16 against **baraka.fabricxai.com** (image `da49a62a`, commit `7997e39`) as
`procurement@testtextile.test`, driving the real screens. Company `Test Textile Ltd`
(`a94a2baa-…`). Every claim below was checked twice: once through the UI, once against the
rows the UI wrote.

> **F1–F6 fixed in `0333cf3`** (2026-08-16). The findings below are left as written — a
> record of what the walk found, not a to-do list to be edited into agreement with the
> code. What each fix changed is noted under the finding it closes. F7–F17 remain open.

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

**Fixed in `0333cf3`.** `totalValue` now precedes the gate; the order is checked against its
credit with every other PO on that credit counted alongside it; a PO in a currency the credit
is not in is refused rather than netted. Three integration tests cover it, including two
orders that each fit alone and overdraw together. The master-LC linkage check is **not** in
this fix and stays open.

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

**Fixed in `0333cf3`**, exactly so.

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

**Fixed in `0333cf3`.** Migration `0086` makes the three columns nullable, the zod no longer
defaults them, and the comparison reports `unstated` per quote — the screen now reads "duty
not stated" and "landed total, without duty". A duty a supplier really quoted as 0% stays a
stated zero; a unit test holds the two apart.

## F4 · HIGH — `validUntil` is read, shown, and then thrown away

The reader extracts it (2026-10-15 for the proforma, 2026-10-31 for the trims), the field
displays it, and `new-quote.tsx:167` never puts it in the payload. The column exists and is
nullable, so both quotes recorded today have `valid_until = NULL`.

A proforma's validity window is what tells a buyer the price is stale. Silently discarding
it makes an expired quote look current forever.

**Fixed in `0333cf3`** — both `validUntil` and `documentId` now travel with the quote.

## F5 · HIGH — the paper the model read is not attached to the quote

`ReadFields.document` is ignored by the quote dialog, and `documentId` — accepted by
`supplierQuotePayload`, with a column on `supplier_quotes` — is never sent. `has_doc` is
false on both quotes.

The whole justification for reading a document with a model is that a person can check the
figures against the original. Here the original is uploaded, read, and then unfindable.

**Fixed in `0333cf3`** — see F4.

## F6 · MEDIUM — the confidence the copy promises is never rendered

The reader says *"the percentages say where to look first"*. No percentage appears anywhere
in this dialog. `new-quote.tsx` ignores `read.confidence` and never renders `ReadMark`,
which `new-order.tsx`, `new-lc.tsx` and `new-ud.tsx` all do.

The kit leans on this ("a scan that comes back at 1.000 on every field has not been read"),
and on this door there is nothing to lean on.

**Fixed in `0333cf3`** — the marks now render on quoted-on, valid-until, currency and price
term, the same way orders, credits and UDs already did.

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

## F18 · HIGH — gate copy interpolates values that never cross the boundary

Found while verifying F1 on the live box. The gate refused correctly and the screen showed:

> This purchase order is larger than the credit funding it. {btbNumber} is {creditValue}
> {currency}, {committed} is already committed to it, and this order is {poValue} — short by
> {shortfall}.

Braces and all. `action-error.ts` documents exactly why: across a server action's boundary
only `messageKey` and `reason` survive, so `details` — every figure — is gone by the time the
copy is resolved. A catalogue string with `{placeholders}` therefore renders literally.

Fixed for the three back-to-back keys in `70551a3`'s follow-up: the services compose the
sentence where the figures exist and pass it as `reason`, the catalogue copy stands alone
without braces as the fallback, and the composition is a pure tested helper because a wrong
sentence about money is a defect about money.

**Still open — the same flaw, other gates.** These keys all carry braces and are thrown the
same way, so each will reach somebody as literal `{free}` or `{rolls}` the moment it fires:

- `gates.ud_balance.*` — `{free} {unit}`, `{requested}` (the bonded overdraw, kit §6)
- `gates.four_point.*` — `{rolls}`, `{pointsPer100SqYd}`, `{found} of {expected}`
- `gates.lc_date.*` — `{plannedExFactoryDate}`, `{daysOver}`, `{latestShipmentDate}`,
  `{expiryDate}`
- `gates.btb_headroom.currency_mismatch` — `{btbCurrency}` against `{masterCurrency}`

Each needs its service to compose a `reason` the way procurement now does. Worth doing before
§6 is walked, since the UD overdraw is one of that section's headline refusals.

## F19 · CRITICAL — the PO was issued at landed cost, in the wrong currency

Found while watching F1's refusal name its figures: the order came to **124,968**, not the
123,190 the proforma totals. The issue-PO call sent `landedUnitCost` as the line's unit
price, reasoning that it was "what the comparison ranked on".

But landed cost is a ranking instrument: it is converted into the comparison's **base**
currency and carries duty and freight — money owed to customs and to a forwarder, neither of
which the mill collects. A purchase order is a promise to pay *this supplier*, in the
currency it invoices, at the price it asked.

Two consequences, and the second is the severe one:

- **Import.** The order overstated the commitment by freight (and would by duty, once anyone
  stated one), so it no longer matched the credit opened for it. `BTB-7712-01` is exactly
  123,190.00 — the proforma total — so with F1's gate now live, the kit's own §5d step would
  have been refused for being 1,778 too big.
- **Local.** The PO is denominated in the *supplier's* currency while the price came from the
  comparison's base currency. A Dhaka Trims zipper quoted at **34.50 BDT** ranks at 0.01 USD
  landed and would have gone onto the purchase order as **0.01 BDT** — a 42,840-piece order
  written for 428 taka.

Fixed: `RankedQuote` now carries `quotedUnitPrice` and `quotedCurrency` beside the landed
figures, and the PO is issued from those. A unit test asserts the two stay distinct — that a
taka quote compared in dollars keeps its 34.50.

## F20 · HIGH — a purchase order cannot be cancelled from any screen

Found when cancelling `PO-2815-F`. `updatePoStatus` exists in the actions layer, the state
machine allows `issued → cancelled` (and `confirmed`/`in_production` too, until goods start
arriving), and `supplier_pos` is a ⚖ table whose every change is audited. But nothing in
`src/app` calls the action — grep returns no caller. So a PO can be issued and never
confirmed, never cancelled, never moved along at all by a person.

That is the whole lifecycle after issue: a mill acknowledges an order, a buyer cancels one
that was raised in error, goods ship — none of it is reachable. And a factory's answer to a
PO raised by mistake becomes "leave it there", which is how a supplier ends up weaving
against an order nobody meant to place.

Cancelling this one needed a one-off container running `setPoStatus` directly. That is the
right *mechanism* — the state machine approved the transition and `recordChange` wrote the
audit row naming the actor, the role and `issued → cancelled` — but it is not something a
procurement officer can do.

**Fix:** a status control on the PO row, at minimum confirm and cancel, with the same
role wall the action already declares.

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

- `PO-2815-F2` — the kit's §5d import PO, **USD 123,190.00** at the mill's own 4.8500,
  against `BTB-7712-01`, the credit opened for exactly that figure. Before F19 it would have
  been written at 124,968 and then refused by F1's gate.

`PO-2815-F` — the order that rode a credit a quarter its size, and the evidence for F1 — is
now **cancelled** (audited: `day0-…-procurement`, `issued → cancelled`). It had no receipts
against it, so the state machine allowed it.
