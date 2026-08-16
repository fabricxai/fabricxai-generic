# Findings — §7 Quality, Nordkap kit

Walked 2026-08-16 against **baraka.fabricxai.com** as `quality@` and `owner@`, driving the
real screens. Every claim checked twice: once through the UI, once against the rows it wrote.

**Verdict: the quality module holds up. Its arithmetic is right and its refusals are
readable.** The one defect that matters is a filing error — a measurement chart committed
under a style code nobody will ever search for, which makes it invisible to the style it
belongs to.

| Scene | Result |
|---|---|
| 7a · incoming fabric | **Pass** — three rolls failed, and the re-inspection round trip works both ways |
| 7b · measurement chart | **Pass on the reading** — 50 points, not 10. Filed under the wrong style code (F33) |
| 7c · the negative test | **Premise did not reproduce**; the mechanism it exists to check does work |
| 7d · inline DHU | **Blocked** — needs §9's production output |
| 7e · final inspection | **Blocked** on screen — no finished lot; the plan itself is exactly right |

---

## 7a — the incoming fabric · PASS

`R-F-17` (24 points per 100 yd²), `R-F-44` (27) and `R-F-58` (22) recorded against a 20-point
limit. The preview computes the rate as you type and says which side of the line it lands —
*"POINTS / 100 YD² 27.00 · THRESHOLD ≤ 20 · WOULD BE fail"* — and the screen is careful to
say the server recomputes it: what is shown is a preview, not the verdict.

**The round trip works in both directions**, which is what §6e depends on:

| Roll | Re-inspected as | Gate says |
|---|---|---|
| `R-F-44` | pass, 2 points | issuable again |
| `R-F-58` | left failed at 22 | refused · `fabric_inspection.failed` |

Then failed back to the mill's 27, and the refusal returned with it. A graded roll offers
**Re-grade** rather than disappearing, so a claim settled by re-inspection has a path.

## F33 · HIGH — a measurement chart is filed under a style code nobody will search for

The chart's header line reads `ST-2815 · NK-90455 · Rev 2` — style, buyer article, revision.
The extractor took **the whole line** as `styleCode`, and it committed that way:

```
style_code                 | version | points | unit
ST-2815 · NK-90455 · Rev 2 |       1 |     50 | cm
ST-2815                    |       1 |      5 | pcs      ← an earlier chart, filed correctly
```

Specs are matched to an order by exact string:

```ts
const spec = row.styleCode ? specs.find((s) => s.styleCode === row.styleCode) : undefined
```

The order's style is `ST-2815`. So this chart — 50 correct points, approved by an owner,
sitting in the table — will never be found for the style it describes, and the measurement
screen reads `points: []`: a style with a chart on file looks like a style with none.

Worth noting the same extractor produced a clean `ST-2815` on 2026-08-13, so this is not
deterministic. Two fixes, and the first is not optional:

1. Normalise on the way in. The commit handler knows it is filing against a style; a code
   with a separator in it is a header line, not a code.
2. Say so in the read schema's description, which is what the model is actually reading.

## 7b — the chart itself · PASS

Everything the kit asks for:

- **50 points, not 10.** A graded row became one point per size.
- Named as the kit specifies — `A Chest width, 1 cm below armhole — size XS`.
- The single `Tol ±` column **folded both ways**: `tolPlus` and `tolMinus` both `1.5`.
- Unit `cm`, values correct end to end (XS 51.0, M 56.0, XL pocket 17.5).

The confirm step shows all fifty with every field editable — *"ITEM 11 OF 50"* — under the
right heading: *"Check it against the paper before it goes for approval. Nobody else can see
these yet — an approver who does not have the document cannot check it for you."*

## 7c — the negative test · premise did not reproduce

Re-filed with every row joined into one line, exactly as the kit describes. The reading came
back **correct**: 50 points, XS 51.0, S 53.5, confidence 0.949. The historical mispairing did
not happen with this model on this document.

The kit's actual point still stands and was tested: *can a human see it fail?* They can. All
fifty values are shown before anything is sent, and the approve inbox shows the draft with its
confidence and its reference. Rejecting it asks for a reason from a fixed list — *wrong figure
read from the source · not what the buyer confirmed · no capacity · needs commercial or LC
action first · duplicate of another pending item* — plus an optional note, with the button
disabled until one is chosen. The rejection is recorded with the reviewer, the timestamp, the
code and the note, and the screen says where it goes: *"goes back to whoever drafted it, with
your reason attached. No row is written."*

## F34 · MEDIUM — the reading waiting for you is not on the screen you land on

An extraction raised on somebody's behalf lands in `drafted` and belongs to the raiser until
they confirm it — sound, and the copy explains it well. But the confirm box is mounted on
`/home`, `/store`, `/cutting` and `/maintenance`, and a quality inspector signing in lands on
`/quality/inline`. So the one item the product itself calls *"the item on this screen that is
blocking itself"* is not on the screen they arrive at. It is reachable through **Your work**,
which is how I found it — but only if you know to look.

A merchandiser's chart from 2026-08-13 has been sitting in `drafted` ever since, which is what
that gap looks like after three days.

## F35 · LOW — the intake promises the approve inbox, and sends it somewhere else

`/marbim/intake` confirms with *"it will appear in the approve inbox, not in the module, until
somebody signs it."* For an extraction raised on your behalf that is not what happens: it goes
to **your own** queue first, and only reaches the approve inbox after you confirm it. The
copy predates the raiser-check step and now describes the wrong pipeline.

## 7e — the AQL plan · correct, but the screen cannot be reached

Every **Inspect** button is disabled with *"nothing finished yet"* — a final inspection needs
finished pieces, which §9 produces. So 7d and 7e both wait on production.

The arithmetic underneath is exactly what the kit specifies, resolved from the factory's own
stored standard rather than typed:

| Lot | Level | AQL | Sample | Accept | Reject |
|---|---|---|---|---|---|
| 12,000 | II | 2.5 major | **315** | **14** | 15 |
| 12,000 | II | 4.0 minor | **315** | **21** | 22 |

So 9 major and 18 minor would pass, as the kit says. The sample size is looked up from
`aql_tables`, which is the answer to *"must be computed by the machine, never typed"* — though
the screen itself could not be opened to confirm the field is uneditable.

## F36 · LOW — the stored standard calls the level `II` where the kit says `GII`

`aql_tables` holds `inspection_level = 'II'`; the kit, and most buyer AQL clauses, write
**GII** for General Inspection Level II. A lookup with the buyer's own wording resolves
nothing. Worth accepting both, or storing the name buyers actually print.

---

## State left on the tenant

- `R-F-17`, `R-F-44`, `R-F-58` — failed at 24, 27 and 22 points; `R-F-44` was passed and
  failed back as the kit's round trip asks
- `measurement_specs` — one committed chart, 50 points, under the style code F33 describes
- One rejected chart (the one-line re-file), with reason *duplicate of another pending item*
- `R-F-01` — returned to the rack through the new screen, its bonded draw given back
