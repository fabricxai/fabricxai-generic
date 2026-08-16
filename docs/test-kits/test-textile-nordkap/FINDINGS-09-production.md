# Findings — §9 Production, Nordkap kit

Walked 2026-08-16 against **baraka.fabricxai.com** as `production@`, driving the real
screens. Every claim checked twice: once through the UI, once against the rows it wrote.

**Verdict: the reading is excellent and the arithmetic is wrong.** The hourly sheet carries
four traps and the extraction cleared all four — nine hours not ten, the afternoon read as
14 rather than 2, exactly two remarks, no TOTAL row and no downtime log. Then the day is
saved, and three things happen to it that nobody is told about: the remarks are dropped, the
whole day is attached to no order, and the day-close measures a nine-hour day as eight and
reports **73.80%** where the floor did **65.60%**.

| Scene | Result |
|---|---|
| 9a · this hour, live | **Pass** — saved, counted, re-entry corrects rather than doubles |
| 9b · the sheet | **Reading passed; saving did not** — F42, F43, F44 all fixed |
| 9c · offline round-trip | **Pass** — queued, synced once, no duplicate under a double tap |
| — · line scope | **Fixed** — F45 (wall now server-side), F46 (a screen sets it) |

The kit's own expected figure is the one that exposes F42. §9 says *"efficiency recomputes
from SMV × output — 1,295 × 18.6 over 68 operators × 9 h = 65.6%"*. The system computed
73.80%, and it is not a rounding disagreement: it divided by 8 hours.

---

## 9a — this hour, live · PASS

`production@` is scoped to **L1/L2**, so the kit's L-3 was not on the board at all (F46).
Walked on L1 instead. Entered 132 for the 17:00–18:00 band; the screen answered

> ✓ Counted 1 line · 132 pieces. Sent.

and the row then read *"this hour already counted — entering again corrects it"* — the right
sentence, because a supervisor who types the hour twice is correcting, not adding. Row
confirmed in `hourly_outputs`, one row, `entered_by` the supervisor.

The screen's standing note is exactly the kit's concern, said before the mistake rather than
after it:

> an hour nobody counts stays empty — it is never read as zero

One flaw at this scene: both lines showed **target 0**, because nothing was planned for
today. See F47 — a target of zero is printed as if it were the plan.

## 9b — the sheet · reading PASS, saving FAIL

`20-hourly-sheet-L3.jpg` through the *Catch up a whole day* drop zone, read by
`gpt-4o-mini`. Every trap in the kit cleared:

| Trap | Expected | Read |
|---|---|---|
| lunch band ruled through | nine hours, not ten | **9 hours** — no 13:00 row |
| afternoon in 12-hour form | `14`, not `2` | **2–3 pm** = 14, and 15/16/17 after it |
| remarks | exactly two (hours 8, 14) | **two**, the rest absent |
| `TOTAL` footer | not a tenth hour | **not read as an hour**; 1,295 is the sum of nine |
| downtime log beneath | not hours of output | **not swallowed** — no 25/12/6 rows |

The confirm list prints each band in words — *8–9 am*, *2–3 pm* — which is what makes a
misread afternoon visible on sight rather than after the month closes. And the line mismatch
was said plainly instead of guessed at:

> The sheet says line "L-3", which is not one of yours — pick it below.

Rows written, checked in `hourly_outputs`: nine, 1,295 pieces, target 145 each, no hour 13.
The reading is not the problem. What happens to it at the save button is.

---

## F42 — the day-close measures every day as eight hours · HIGH · FIXED `347bd4c`

`closeDay` takes `workingMinutes` with a default of **480**, and `runDayClose` — the only
caller — never passes anything else. The sheet's day ran **nine** hours, and the system
knows it: nine `hourly_outputs` rows are right there, summed for output and ignored for
available minutes.

Planned L3 for 2026-12-08 through `/lines` → *Plan a line's day* (target 145, manpower 68,
SMV 18.60 — the kit's own numbers), then ran the day-close for that date:

```
 code |  for_date  | earned_minutes | available_minutes | efficiency_pct | output_total
 L3   | 2026-12-08 |       24087.00 |          32640.00 |          73.80 |         1295
```

`earned` is right: 18.60 × 1,295 = 24,087. `available` is 68 × **480** = 32,640, an
eight-hour day. The line worked nine: 68 × 540 = 36,720, and 24,087 / 36,720 = **65.60%** —
the kit's figure exactly.

A line that ran two hours of overtime is credited as if it had run a standard shift, and
reads **12.5% better than it was**. A ten-hour day reads 25% better. A line that stopped at
noon reads better still. Every day that is not exactly eight hours is wrong, and the error
always flatters — which is the direction that does not get questioned.

The fix is not a new input to fill in. Available minutes should come from the hours the line
actually recorded, which the same function already has in hand:
`hours_entered × 60 × manpower`. `workingMinutes` can stay as the override for a factory
that wants to state it.

**Where:** `src/modules/production/service.ts` (`closeDay`, the `workingMinutes ?? 480`
default and the `groupBy` that discards the row count) · `src/modules/production/jobs.ts`
(`runDayClose`).

### Fixed — `347bd4c`

`workedMinutes(hoursRecorded)` in `metrics.ts`, beside `computeEfficiency` so the two callers
cannot drift into disagreeing. `closeDay` now counts the rows it was already summing
(`count(*)` alongside `sum(actual)`) and divides by what it finds. It refuses a day with no
hours rather than falling back to a nominal shift — that would put a 0% against a line that
never ran.

**The same bug was on the wall board, pointing the other way.** `/board` computed live floor
efficiency against the same constant 480, and it is read *mid-shift*: at ten in the morning a
line with two hours on the clipboard was divided by a whole shift and shown at **14.76%**
while it was running at **59.04%**, climbing all day towards the truth and only arriving at
knocking-off time. Fixed in the same change — `row.hours.length` is the count, and a line
with nothing entered yet is left out of the floor figure rather than counted as a zero.

Planning's working-week `shiftMinutes` is untouched: that forecasts capacity, this measures a
day that has already happened.

Deployed and every existing `efficiency_daily` row rebuilt — the table is derived and
idempotent by design, and analytics sums earned/available *across* days, so a period spanning
the deploy would otherwise have mixed two denominators. Live, same day, same rows:

```
       slug       | code |  for_date  | earned  | available | eff_pct | output | hours | men
 test-textile     | L3   | 2026-12-08 | 24087.00|  36720.00 |   65.60 |   1295 |     9 |  68
 barakah-fashions | L1   | 2026-08-09 | 14480.80|  11520.00 |  125.70 |    787 |     4 |  48
 barakah-fashions | L2   | 2026-08-09 | 10414.40|   8280.00 |  125.78 |    566 |     3 |  46
```

L-3 is the kit's 65.60% exactly. **The barakah rows are worth reading twice**: they were
62.85% and 63.51% against the old denominator and are over 125% against the honest one. That
is not the fix misbehaving — those are 4- and 3-hour part-days, and 787 pieces at 18.40 SMV
across 48 operators for four hours *is* 126% of standard. The demo seed's output was chosen
without reference to its own manpower and SMV, and the wrong denominator was flattening the
inconsistency into a plausible-looking number. `computeEfficiency` reports over 100 rather
than capping it for precisely this reason — *"a line that beats its SMV is telling you the SMV
is wrong"* — and it is now telling us about the seed. Filed against the seed, not this fix.

## F43 — the sheet's remarks are read, shown, and then dropped · MEDIUM-HIGH · FIXED `285862e`

`hourlySheetDraft` reads a `remark` per hour and documents why it matters
(*"needle chg SN-1-021", "thread break" — why an hour missed*). The confirm list displays
them. The supervisor checks them and presses save — and they go nowhere.

`submit()` in `day-catchup.tsx` maps each hour to
`{lineId, orderId, producedOn, hourSlot, target, actual}`. No remark. `hourlyOutputEntry`
has no such field, and `hourly_outputs` has no such column.

So hour 8 is stored as 118 against a target of 145 — a 27-piece miss with no cause — when
the sheet said, and the screen showed, *"first hour — feeding, 6 operators short"*. Hour 14
loses *"needle change SN-3-014"*, which is the one that would have told maintenance
something. The line gets a run-rate warning it has no explanation attached to, and the only
record of why is the photograph.

Showing a field for confirmation and then discarding it is worse than never reading it: the
supervisor has been asked to check something, and reasonably believes it was kept.

**Where:** `src/app/(app)/lines/hourly/day-catchup.tsx` (`submit`) ·
`src/modules/production/zod.ts` (`hourlyOutputEntry`) ·
`src/modules/production/schema.ts` (`hourlyOutputs` — needs the column).

### Fixed — `285862e` (migration `0091`)

`hourly_outputs` gains a nullable `remark`. Null for the ordinary hour: most hours have
nothing to say, and a column of empty strings is worse than a column of blanks.

**The upsert deliberately does not take `excluded.remark`.** The hourly keypad enters one
number per line and has no remark field, so that would blank the sheet's own words every time
an hour was corrected — the same silent discard, one layer down. Three states instead, all
expressible in a single `set` clause so the batch stays one statement:

| The entry says | What happens |
|---|---|
| nothing — key absent | this write has no opinion; the existing remark stands |
| `''` | clear it, said deliberately by the box that asks |
| text | set it |

**Read as well as written**, or the discard would only have moved into the database. The
board's hour box shows the remark, opens holding it, and is where it is corrected — so the
field is not write-only-from-a-photograph. A cell carrying one is marked with a dot; the dot
is decorative, so the reason goes in the button's accessible name, or a screen-reader user
has no way to know an hour was explained. Copy in `en` and `bn`.

Live, the kit's own sheet through the real screen:

```
 hour | actual | target | remark
    8 |    118 |    145 | first hour - feeding, 6 operators short
    9 |    141 |    145 | (null)
   10 |    149 |    145 | (null)
   11 |    152 |    145 | (null)
   12 |    147 |    145 | (null)
   14 |    138 |    145 | needle change SN-3-014
   15 |    151 |    145 | (null)
   16 |    156 |    145 | (null)
   17 |    143 |    145 | (null)
```

Two remarks, on hours 8 and 14, the rest absent rather than empty — which is what §9 asked
for and what the reading had been getting right all along.

## F44 — a back-dated day is booked against today's order · HIGH · FIXED `487566e` `3b73580`

The catch-up dialog exists to enter a **past** day. It takes the order to book that day
against from `dailyLinePlans` for **today**:

```ts
// page.tsx — planRows is built with eq(dailyLinePlans.planDate, today)
lines={rows.map((row) => ({ …, orderId: planByLine.get(row.lineId)?.orderId ?? null }))}
```

The day it writes is `producedOn`, read off the sheet — 2026-12-08. The order comes from
16 August. Two ways that goes wrong, and the second is worse:

- Nothing planned today ⇒ the whole day is booked against **no order**. That is what
  happened here: 1,295 pieces sitting in `hourly_outputs` with `order_id` null, attributable
  to nothing. `snapshotWip` only counts rows `where h.order_id is not null`, so the day is
  invisible to WIP as well.
- A *different* order planned today ⇒ the back-dated day is silently attached to the
  **wrong order**, and an order's sewn quantity is overstated while another's is short.

Proven rather than reasoned: after planning L3 for 2026-12-08 *with* NKA-PO-70318 and
re-running the catch-up, `order_id` was still null on all nine rows. The plan for the right
day exists and the screen does not look at it.

The order should be resolved for `producedOn` — the day being entered — not for today, and
when no plan exists for that day the screen should say so before saving rather than write a
day that belongs to nobody.

**Where:** `src/app/(app)/lines/hourly/page.tsx:161-166` (the `DayCatchupButton` props) ·
`src/app/(app)/lines/hourly/day-catchup.tsx` (`submit`).

### Fixed — `487566e`, backfilled `3b73580`

**Neither client decides this any more.** `daily_line_plans` is the record of what a line ran
on a date, so `recordHourlyOutputsIn` resolves the order from the plan for `producedOn` — one
query per batch, keyed on line-day, before the insert. The caller's own `orderId` survives
only as a fallback for a day with no plan, so seeds and `/api/production/outputs` keep
naming theirs; this narrows what is trusted rather than widening it.

**The board's hour edit had the other half of the same defect** and is fixed by the same
change: `board-client.tsx` sent no order at all, so every cell corrected through that dialog
was orphaned. Found while fixing this, not in the walk.

The dialog now says what the day attaches to, resolved for the date on the sheet — and the
old note that *"output is booked against whatever this line is running"* is gone, because it
described the bug:

> This day goes against **NKA-PO-70318 · ST-2815** — what L3 was planned to run on 2026-12-08.

Switching the picker to a line with no plan for that day says so rather than saving in
silence, which was the second half of the complaint:

> Nothing was planned for L1 on 2026-12-08, so these hours will be recorded against no order
> — the pieces will not count towards one. Plan that day on the line board first if they
> should.

The lookup is keyed on the line-day it asked about, so an answer for L3 cannot sit on screen
after the supervisor picks L4 — verified live by switching between them.

**Migration `0090` repairs what was already written** — 2,251 pieces across three live
line-days. Two deliberate limits, both stated in the SQL: a row whose day has no plan stays
null (there is no evidence of what it belonged to, and the nearest day's order would be a
guess written where a buyer's order looks at it — a blank is recoverable, a wrong attribution
is believed), and rows already naming an order are untouched, since a wrong one is
indistinguishable here from a deliberate one. Re-entering the day through the screen corrects
those; `order_id` is set from `excluded` on conflict, which is what makes that work.

Live after deploy — L-3's nine hours, all attributed:

```
 hours | with_order | pieces
     9 |          9 |   1295
```

and the three line-days that genuinely have no plan (test-textile L2 14 Aug, L1/L2 16 Aug)
correctly stayed null.

## F45 — line scope is a UI-only wall · MEDIUM · FIXED `ee6926b`

`ctx.lineScope` is built in `session.ts` and enforced in exactly four places, every one a
render-time filter in a page component:

```
src/app/(app)/lines/hourly/page.tsx:97   src/app/(app)/lines/endline/page.tsx:65
src/app/(app)/lines/page.tsx:71          src/app/(app)/lines/page.tsx:74
```

No service, query or sync handler checks it. `recordHourlyOutputsIn` inserts whatever
`lineId` it is handed.

Probed as `production@` (scoped L1/L2), posting L3's uuid through the screen's own queue
endpoint:

```
POST /api/sync  →  200  {"status":"applied"}
L3 | 2026-08-16 | hour 6 | target 145 | actual 999 | entered_by day0-…-production
```

Written and applied. (Row and offline key deleted afterwards; the tenant is clean.)

This is the shape rule 8 exists to forbid — *"Gates are server-side and structured … Never
UI-only."* The severity is bounded: it is an authenticated user of the same role in the same
company, so nothing leaks across tenants. But a scope that says "you supervise L1 and L2"
and does not hold is a claim the system cannot make. The same hole covers endline counts and
stoppages, which run through the same unchecked handlers.

**Where:** `src/modules/production/service.ts` (`recordHourlyOutputsIn` and the sync handler
registrations) — the check belongs beside the tenancy one, not in the page.

### Fixed — `ee6926b`

`assertLinesInScope` guards the hourly batch, stoppages open **and** close, endline counts and
the day plan. Closing a stoppage resolves the line from the row, because that call names only
a downtime id — checking the input would have checked nothing.

A batch that smuggles one line in among allowed ones **fails whole**. A partial write would
leave the supervisor believing every row landed, which is worse than a refusal.

It costs nothing for the unscoped, which is nearly everybody: no `lineScope` on the ctx means
no query at all. A scoped caller pays one indexed read of an eight-row table. Jobs carry no
scope and are not narrowed.

The decision itself is pure and lives in `production/scope.ts`, tested without a database —
including the case the first draft missed, an id belonging to no line of this company, which
is now refused rather than let through to surface as a foreign-key error where a permission
answer belongs.

**The same probe from the walk, re-run against the deployed fix** — same endpoint, same shape,
a line outside the supervisor's scope:

```
POST /api/sync  →  200
{"status":"rejected","errorKey":"production.errors.line_out_of_scope",
 "details":{"lines":["L4"],"scope":["L1","L2","L3"]}}
```

No row written. The refusal names the line by **code**, not uuid — a supervisor knows their
floor by the number painted on it.

One thing worth noting about the copy: `AppError.details` does not survive a **server action**,
so the message string carries no placeholders and reads on its own — *"That line is not one of
yours. You can enter only the lines you supervise — ask the office to widen them."* The
structured `details` above survive because the offline queue returns JSON rather than crossing
that boundary. The repo has a test for the placeholder rule, and it caught the first draft.

## F46 — no screen assigns a line to a supervisor · MEDIUM · FIXED `6bd140d`

`roles.scope.lines` is stored, read and enforced on every line screen, and can be set by
nothing but SQL. `/settings` has role controls and no line control; no action or tool writes
`scope`.

On this tenant `production@` holds L1/L2 and `production2@` holds L7/L8, so **L3–L6 belong
to no supervisor at all** — including L-3, the line the kit's sheet is for. §9 as written
cannot be walked by the account it names. A line chief moving from one line to another needs
a developer with a database password.

Worked around to finish the walk by adding L3 to `production@`'s scope directly in the
database. **That change is still in place** — it is the state the kit needs, but it was made
by SQL, which is the finding.

**Where:** `src/app/(app)/settings/` (no control exists) · `src/modules/core/session.ts:80`
(the reader) · seed: `pnpm seed:kit` should give the kit's supervisor the kit's line.

### Fixed — `6bd140d`

`setLineScope`, an owner/admin act, on the role matrix that already grants and revokes.
`grantRole` has always accepted a `scope`; nothing ever passed one.

Two rules that are easy to get wrong and unfindable afterwards, so both live in a pure
`settings/line-scope.ts` with tests:

- **an empty list means the whole floor and REMOVES the key**, rather than storing `[]`.
  `session.ts` reads a role with no `lines` array as unnarrowed, so an empty array would leave
  the difference between "everywhere" and "nowhere" resting on how one reader happens to treat
  `[].every(...)`;
- **every other key in the scope survives.** The picker owns one key.

Codes are checked against the company's real lines: a typo'd `L9` stored quietly narrows
somebody to a line that does not exist, which reads exactly like a permissions bug and cannot
be diagnosed from the screen.

The screen also says the thing that is otherwise unexplainable — **one unscoped role widens all
the others**, so narrowing `production` for somebody who also holds `admin` changes nothing at
all. It says so on the row where it is true, rather than leaving an admin wondering why the
setting did not take.

**Verified as a round trip through the product**, which is the only way to prove both findings
at once. Narrowed `production@` to L1/L2 by clicking L3 off and pressing *Save lines*:

```
{"lines": ["L1", "L2"]}                          ← written by the screen
POST /api/sync (L3) → "rejected"  line_out_of_scope, scope ["L1","L2"]
```

then clicked L3 back on and saved:

```
{"lines": ["L1", "L2", "L3"]}
POST /api/sync (L3) → "applied"
```

The L3 grant this kit needs is now set **through the product**. The SQL used during the walk
to make §9 walkable at all is no longer the only way it could have happened.

## F47 — "target 0" where there is no plan · LOW

A line with no `daily_line_plans` row for today shows **target 0** on the hourly board, and
the hour saves against it. Downstream, `achievedPct` is null because `target > 0` is false,
and `closeDay` skips the line entirely — correctly, since there is no SMV or manpower to
compute against, but silently.

Zero is not what is true. Nothing is planned, and the screen should say that, the way the
lay screen learned to say what it is waiting for (F38). As it stands a supervisor enters a
day's output believing it is being measured, and no number is ever produced from it.

**Where:** `src/app/(app)/lines/hourly/page.tsx` (`planByLine.get(...)?.targetPerHour ?? 0`)
· `src/app/(app)/lines/hourly/hourly-client.tsx`.

---

## 9c — the offline round-trip · PASS

Airplane mode on, entered 118 for L2, saved. The screen marked it without ceremony:

> offline · 1 saved here

Tapped save a second time while still offline — the thing `offline_key` exists to survive.
Airplane mode off, reloaded: **all sent**, and the board showed the hour counted once.

```
 code | hour_slot | target | actual |             offline_key
 L2   |        17 |      0 |    118 | 3bdec416-827b-4500-b72b-8057b8c1148c
```

One row. No duplicate. Worth noting what actually held it: the second tap queued under a
*different* offline key and was absorbed by the unique index on
`(line_id, produced_on, hour_slot)` with `onConflictDoUpdate`. Both walls did their job, and
the second one is the one that caught it.

---

## F48 — the board does not show the hour it just took · MEDIUM · FIXED `435ef23`

Found while verifying F43 on the live tenant, not during the walk.

Entering an hour from the `/lines` board queued the write and closed the box onto a board
still showing that hour as never counted. The row was in the database, with its remark, and
the cell read **"L1 9:00 — not counted"**. The write had landed; nothing on screen said so,
and the only reasonable conclusion is that it did not work — so the supervisor types it
again. It is idempotent, so nothing breaks; they simply have no way to know that.

The hourly keypad already drains the queue and re-reads, with the reasoning written down
beside it including the offline caveat. The board never got those two lines. Same fix, same
caveat: offline, neither — `router.refresh()` would re-fetch a page the network cannot serve
and tear down the screen the person just saved on.

Sharper after F43 than before it: a remark somebody types and then cannot see is the discard
F43 exists to end, wearing a different hat.

Verified live without a reload — the cell caught up on its own:

```
before: L2 10:00 — not counted
after : L2 10:00 — 137 of 145. bobbin jam, 15 min
```

and re-opening the box holds `"bobbin jam, 15 min"`.

**Where:** `src/app/(app)/lines/board-client.tsx` (`onSave`).

## Observation, not a finding

The order picker on *Plan a line's day* offers
**"RFQ-REQUEST FOR QUOTATION · REQUEST FOR QUOTATION"** — an order created from a document
header during an earlier walk. Tenant noise rather than a defect, but it is the kind of row
that should never have become an order, and it now appears in every order picker in the
product.

---

## Not walked

§9 leaves nothing owed, but the two quality scenes that depend on production output can now
be walked: **§7d** (inline DHU against a line that has run) and **§7e** (final inspection
AQL). Both were blocked on there being output to inspect, and L3 now has a day of it.
