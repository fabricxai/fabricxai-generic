# Findings — §6 Store, Nordkap kit

Walked 2026-08-16 against **baraka.fabricxai.com** as `store@` and `quality@`, driving the
real screens. Company `Test Textile Ltd` (`a94a2baa-…`, factory type **knit-composite**).
Every claim was checked twice: once through the UI, once against the rows the UI wrote.

**Verdict: cloth that failed inspection was issued to the cutting floor.** The scene §6 exists
to prove — *these rolls are not issuable* — does not hold, and the reason is not the gate. The
gate is sound and wired. It is handed the wrong facts, by a screen two modules away.

| Scene | Result |
|---|---|
| 6a · receive the fabric | **Pass**, after two defects found and fixed mid-walk (F21, F22) |
| 6b · receive the trims | **Blocked** — a trims delivery cannot be received at all (F23) |
| 6c · the customs overdraw | **Unreachable** as written (F26); the gate itself verified working |
| 6d · the shade mix | **Pass** — warns, does not block, names both groups |
| 6e · the failed rolls | **Fail — critical** (F27) |
| 6f · the real issue | **Pass** — 21 rolls, 552.50 kg, drawn against `UD-2026-058` |

---

## F27 · CRITICAL — rolls that failed 4-point inspection were issued to production

`R-F-44` (27 points per 100 yd²) and `R-F-58` (22 points, against a 20-point limit) were both
recorded as **FAIL** by the quality desk, then offered on the store's issue screen with
nothing marking them, with the button enabled, and both went out. `R-F-17` (24 points) went
out too. The rows say so: `status = issued`, latest inspection `fail`.

The kit's expectation is *"not issuable at all, either not offered or refused with the
inspection result cited."*

**The gate is not broken — it is exempted.** `checkFabricInspection` is wired into the issue
path, fails closed with no provider, and is called before anything is written. Quality's
provider then filters the rolls it will judge:

```ts
// modules/quality/service.ts
if (knitsItsOwn && !r.supplierPoId) return false
```

with the comment: *"Own cloth in a knit house: knitted here, graded on the machine, no 4-point
sheet to wait for. Bought cloth is gated whatever the factory type, because somebody else made
it and the sheet that says whether it is good came in the box with it."*

The reasoning is exactly right. The discriminator is what fails: **`/store/receive` never
records which supplier PO a delivery arrived against**, so `grns.supplier_po_id` is null on
every receipt made through the screen — including this one, an imported, bonded, back-to-back
funded delivery from a Chinese mill. Test Textile is `knit-composite`, so `knitsItsOwn` is
true, and every bought roll it receives looks exactly like cloth it knitted itself.

The seeded GRN `FS-INV-7741` *does* carry a PO link, which is why this never showed before: it
was planted by a script, not received through the door.

**Fix, in two parts.**
1. `/store/receive` must ask which purchase order the delivery is against — the PO is how a
   receipt becomes a receipt rather than a note, and it is what closes the PO line, feeds the
   supplier scorecard and, here, decides whether the cloth is somebody else's work.
2. Until it does, the provider's assumption is unsafe in the other direction. A roll whose
   origin is *unknown* is not the same as a roll the factory knitted; the exemption should
   require positive evidence of own manufacture (an own-production GRN, a dye-lot from the
   factory's own dyeing), not the mere absence of a link.

Both are needed. Part 2 alone would gate the factory's own cloth; part 1 alone leaves every
historical receipt exempt.

## F23 · HIGH — a trims delivery cannot be received at all

`/store/receive` will not submit without at least one roll:

```ts
const complete = challanNo.trim() !== '' && … && rolls.length > 0 && !mismatch && Boolean(item)
```

Zippers, drawcords, eyelets and labels are counted in pieces and arrive in cartons; they are
not on rolls. So §6b — 42,840 zippers, 43,260 drawcords, 86,520 eyelets, 42,840 labels — has
no path through the screen. The button reads "Receive" and stays disabled with no explanation
beyond a caption that reads as advice: *"stock is roll-level — a receipt with no rolls creates
stock nobody can issue."*

The server does not agree with the screen: `grnReceipt`'s `rolls` is `z.array(...).default([])`
— a roll-less receipt is valid, and the seed contains one (`DTH-4402`).

That caption does describe something real, though: `stock()` reads the `rolls` table, so a
material with no rolls has no stock and cannot be issued. So this is not only a disabled
button — **the store has no stock model for anything not on a roll**, and every trim in the
kit is such a thing. Deciding whether trims get roll rows (one per carton) or the stock model
grows a non-roll path is a design call, not a patch.

## F24 · HIGH — every receipt starts bonded, because the bond sorts first

`useState(locations[0]?.id ?? '')`. On this tenant `locations[0]` is `BOND-1`, so the receive
screen opens claiming the delivery is bonded and demands a Utilization Declaration for it.

The kit says of the trims: *"all general store — nothing bonded, so the receipt must NOT ask
for a UD. If it does, the bonded test in the store has the wrong default."* It does.

This is the same shape as the back-to-back credit picker (F2, §5): a consequential choice
defaulted to whatever sorts first. Here the cost is customs exposure — general trims received
into the bond against a declaration that has nothing to do with them — created by a dropdown
nobody touched.

## F25 · MEDIUM — the screen's instruction for a multi-material challan leads into a wall

Reading the trims challan fills the first of four materials and says: *"It lists 4 different
materials. The first is filled in — receive it, then repeat for the rest."*

Repeating is impossible. `uniqueIndex('grns_company_challan_key').on(companyId, challanNo)` —
one GRN per challan, enforced in the database, and the screen's own eyebrow says *"one GRN per
challan"*. The second material would collide.

`grn_lines` is a table; a GRN is already multi-line in the schema. Only the form is single-line.
Either it grows lines, or the instruction is wrong and should say so.

## F26 · MEDIUM — the customs overdraw cannot be attempted through the screen

§6c asks for an issue of 25,600 kg against a UD authorising 25,400. The issue screen has no
quantity field — issuing is picking rolls — and the kit's own tranche 1 is 60 rolls, 1,567.0 kg.
So the overdraw cannot be asked for, and §6's headline refusal cannot be demonstrated to a
factory being sold the system.

The screen is honest about the shortfall, which is the redeeming half:

> Only 1567.00 kg of the 25401.60 kg asked for can be drawn. Issue what is here and hold the
> lay, or have merchandising re-size the order.

> Bonded rolls are picked — this issue draws on its Utilization Declaration in the same
> transaction, and the balance gate can refuse it under the lock. What the workbench shows is
> a guide; the lock decides.

**The gate itself is fine.** Run against production data it refuses correctly and now names
its figures (fixed earlier today):

> UD-2026-031 has 200.00 kg free for "30/1 combed cotton yarn" and this asks for 400.00 —
> 200.00 kg more than the declaration allows. An owner can approve a deliberate overdraw.

What is missing is a way to *reach* it: either the kit ships a second tranche, or the walk
should overdraw a UD whose balance the delivered stock can actually exceed.

## F21 · HIGH — one restatement row threw away the whole challan · FIXED

The fabric challan restates its single material on a second row as a roll count, which is how
challan books are written and which the kit flags as the trap. The model returned that row
with an empty name, `itemName: z.string().min(1)` rejected it, and the entire reading went
with it — *"That document could not be read"* and a blank form, for the document the kit ships
as the expected case.

Fixed in `8fe9217` / `e5c7cec`: rows are parsed loosely and judged by `challanMaterials`, which
drops rows carrying no material identity. A genuine second material still arrives whole.

## F22 · MEDIUM — a `.transform()` in a read schema breaks reading entirely · FIXED

The first attempt at F21 filtered inside the zod. That schema is handed to the extract model as
JSON Schema, and the provider refused it outright: *"openai: Transforms cannot be represented
in JSON Schema."* Reading stopped working altogether until it was moved out.

Worth knowing as a rule: **a read schema is a description of the paper's shape, not a
pipeline.** Anything that judges, filters or rewrites belongs one layer up. Nothing in the
codebase said so before this.

## F28 · LOW — the kit's own numbers disagree with its packing list

- §6f says issue `R-F-01`…`R-F-21`, 521.3 kg. Those 21 rolls sum to **552.5 kg** on the mill's
  packing list. Excluding the failed `R-F-17` gives 527.1 — still not 521.3.
- §6f's range **contains `R-F-17`**, which §6e declares must never be issuable. The two scenes
  contradict each other, and a tester following the kit in order issues a failed roll on
  purpose.

## F29 · LOW — a failed roll's quality history is one row deep on screen

Re-grading works and is the kit's stated path (§7a: *"passing a failed roll on re-inspection
should make it issuable again"*). The screen shows only the latest verdict, though, so a roll
that failed at 27 points and passed on re-inspection reads exactly like one that always passed.
For a mill claim — which is what a re-inspection usually settles — the earlier result is the
evidence.

---

## State left on the tenant

- GRN `ZJH-DC-8842` — bonded against `UD-2026-058`, 60 rolls, 1,567.00 kg
- Material requisition for `NKA-PO-70318` · `FAB-FLC-280` · 25,401.60 kg
- One issue: 21 rolls, 552.50 kg, drawn against `UD-2026-058`
- A second issue of `R-F-44` + `R-F-58` (51.20 kg) — **this is F27's evidence**; those rolls
  failed inspection and should not have left the store
- Fabric inspections: `R-F-17` fail (24), `R-F-44` fail (27), `R-F-58` fail (22) — the kit's
  three. `R-F-01`, `R-F-02`, `R-F-45`, `R-F-60` read pass (2) after a walker's mis-click was
  corrected through the Re-grade path.
