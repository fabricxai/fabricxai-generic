# Findings — §8 Cutting, Nordkap kit

Walked 2026-08-16 against **baraka.fabricxai.com** as `cutting@`, `merchandiser@` and
`owner@`, driving the real screens. Every claim checked twice: once through the UI, once
against the rows it wrote.

**Verdict: both gates work, and the sharpest reading in the kit is read correctly. The way
in is what fails.** The PP gate refuses and releases exactly as designed, and the cutting
sheet's three-numeric-row trap came back as 286 rather than the plausible 288. But a marker
can only be created by asking the assistant, and the screen's own order picker leaves the
create button dead with nothing said.

| Scene | Result |
|---|---|
| 8a · cut before PP | **Pass** — refused, gate named, with the reason in a sentence |
| 8b · release it | **Pass** — dispatch, verdict, and cutting opens on the same style |
| 8c · the lay | **Pass**, after F37 and F38 — `LAY-41`, 96 plies, 864 pieces planned |
| 8d · the cut report | **Pass** — the trap read correctly: 286, total 862, 45 bundles |

---

## 8a — cut before PP · PASS

The create button reads **"Blocked — PP approval first"** and is disabled, above a sentence
that explains rather than announces:

> This style cannot be spread yet — the PP gate is holding it. The buyer signs off one garment
> before the factory makes eighty thousand. Nothing below will be accepted until that approval
> is recorded in the sample room.

That is the refusal the kit asks for, and it names where to go next.

## 8b — release it · PASS

`SR-2815-PP` raised against the order, dispatched with courier and airway bill, verdict
**approved**. The sample room says what that means:

> This PP sample is approved — cutting is released for PP on this style. The gate reads it
> directly; nobody has to tell the floor separately.

Back on the cutting screen the PP alert is gone and the button changes to "Create the lay".
The gate works in both directions, which is the point of 8b.

## F38 · HIGH — picking your order leaves the lay screen dead, and silent

The path a cutting master takes — open `/cutting`, press *start a lay*, pick the order from
the list — produces a screen that **cannot be submitted**. Marker released, lay number,
colour and plies filled, twenty-one rolls picked, no warning anywhere, and "Create the lay"
stays disabled. Typing by hand behaves the same as automation, so this is not a harness
artefact.

The cause is `useState(markers[0]?.id ?? '')`. The picker swaps the order **without
remounting** the client, so `markerId` keeps the value it was initialised with — empty,
because the screen first rendered on an order whose style had no marker. The `<select>` then
shows its first option because a browser displays one when the bound value matches nothing,
so the marker *looks* chosen. `marker` is undefined, and with it `complete` and the entire
yield block.

The tell is that nothing computes: no pieces, no consumption line. Mounting the same screen
directly at `/cutting/lay?order=…` fixes it instantly — the yield appears (**864 PIECES**) and
the button enables.

**Fix:** derive the selection rather than seeding it once — fall back to `markers[0]` whenever
`markerId` matches nothing, or key the client on the order so a switch remounts it. And the
button should say what it is waiting for; a disabled control with no sentence is the same
failure as a silent refusal.

## F37 · MEDIUM — a marker can only be created by asking the assistant

`/cutting/lay` refuses without one: *"No marker exists for ST-2815. A lay is spread under a
marker … and CAD releases it before cutting can start."* Correct, and there is no way to
release one. The cutting module has **no `actions.ts` at all**; its two sync handlers are
`create_lay` and `record_cut_report`; `createMarker` exists in the service with a commit
handler and nothing calls it. The one marker on this tenant was seeded.

The only working route is MARBIM's `cutting.propose_marker` draft tool, in conversation. It
does work — asked directly, it raised the draft, the approve inbox showed it as **`ai_chat`,
confidence unscored** (right: a chat-composed draft carries no measurement and never
auto-approves), and approving it committed `ST-2815-A` with the kit's exact ratio.

But a marker is a CAD artefact that arrives as a plan or a file, and "ask the assistant" is a
strange only-door for it. Worth either an intake kind for a marker plan, or a screen.

Two smaller things seen on that path: three identical drafts were raised by asking three
times, with nothing noticing they were the same marker; and the reject dialog's *duplicate of
another pending item* reason cleaned them up correctly.

## F39 · HIGH — cloth that failed inspection can be spread on a table

`R-F-17` (24 points per 100 yd²), `R-F-44` (27) and `R-F-58` (22) — all recorded **FAIL**, all
returned to the rack — are offered in the lay screen's roll picker with nothing marking them.
No badge, no exclusion, no warning. `R-F-17` was spread into `LAY-41` and cut into garments
without a word.

This is F27's sibling and it is not covered by F27's fix. The 4-point gate guards the **issue**
path, where cloth leaves the store. A lay draws on rolls *already issued to the order*, so
material that failed inspection after issue — or was returned and re-picked — reaches the
table by a route the gate never sees.

**Fix:** the same provider the store calls, called again when a lay is created, over the rolls
being spread. Failing that, at minimum mark them in the picker — a cutting master looking at
`R-F-44 · 25.00 kg · SHADE B` has nothing on screen that says quality rejected it.

## 8d — the cut report · PASS

The sharpest trap in the kit, read correctly. The sheet carries three numeric rows and only
the bottom one is the answer:

| | XS | S | M | L | XL | Total |
|---|---:|---:|---:|---:|---:|---:|
| Should cut | 96 | 192 | 288 | 192 | 96 | 864 |
| **Read as ACTUAL** | 96 | 192 | **286** | 192 | 96 | **862** |

The screen showed **864 planned · 862 actual · −2** before saving, filed it, closed the lay,
and generated **45 bundles totalling 862 pieces** across the five sizes, each with its QR
token. Nothing had to be typed.

## F40 · LOW — the lay screen labels kilograms as metres

*"21 rolls · 552.50 m on the table"* — the rolls are fleece, measured and received in **kg**,
and 552.50 is their weight. The consumption figure beside it (*691.20 m*) genuinely is metres,
being lay length × plies, so the line puts two different units under one label and calls both
metres. A cutting master comparing "552.50 m on the table" against "691.20 m consumed" reads a
shortfall that does not exist in those terms.

## F41 · LOW — a hydration error on the approve inbox

`Minified React error #418` (server-rendered HTML did not match the client) fires on
`/approve` with drafts listed. Nothing visibly breaks, and it is a different fault from the
#441 family fixed earlier today, but it is a real console error on a screen that signs money.

---

## State left on the tenant

- `SR-2815-PP` — dispatched by DHL under `AWB-2815-PP-001`, verdict **approved**; the PP gate
  now reads open for `ST-2815`
- Marker `ST-2815-A` — ratio XS 1 · S 2 · M 3 · L 2 · XL 1, committed from a MARBIM draft;
  two duplicate drafts rejected as duplicates
- `LAY-41` — Charcoal Melange, 96 plies, 21 rolls, status **cut**
- Cut report on `LAY-41` — M recorded as 286, total 862, **45 bundles** generated
- **`R-F-17` is in that lay** and it failed 4-point at 24 points. It is F39's evidence.
