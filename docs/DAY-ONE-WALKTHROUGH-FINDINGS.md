# Day-one walkthrough — Test Textile Ltd, role by role

**Method.** Playwright drove the real app at `localhost:3000` against the **Test Textile**
tenant — a factory provisioned exactly as a new customer's would be: 20 role logins, a
factory tree, wage grades, TNA templates, defect codes, and **nothing else**. Every one of
the 18 roles signed in and visited every screen its own sidebar offers: **155 screens**.
MARBIM ran on the mock provider, so no model spend and no extraction-quality noise.

**What this is not.** A code read. Every line below is something that happened in a browser.

**Status: Phase A (walk) complete. Nothing has been fixed yet** — findings first, by
agreement, so the list is complete before the batches start.

---

## What is already good, and worth not breaking

- **No crashes.** Zero 500s, zero runtime errors, zero screens that failed to load, across
  155 screens and 18 roles.
- **Every landing is correct** (adoption plan 1.1): store → receiving, production → hourly,
  quality → inline, commercial → LC register, hr → payroll. Nobody lands on an empty
  approve inbox.
- **The empty states are unusually good.** Cutting's explains both gates before a lay can be
  spread. The store's explains that stock arrives as a GRN against a challan and that bonded
  fabric is received against a UD. These teach rather than apologise; they should be the
  model for the ones below that do not.
- **The read wall holds.** No screen a role should not see rendered for it.

---

## BLOCKER — a new factory cannot start work at all

### D1 · Nothing in the product creates an item, a location, or a worker

Not an action, not a screen, not a MARBIM tool. Verified by exhaustive search: **zero**
service writers for `items`, `locations`, `workers`. The only writer is the seed script.

What that means for a factory that signed up this morning:

| Desk | What happens |
|---|---|
| **Store** | Cannot receive **anything**, ever. The receive form needs an item and a location; neither can be created. Every downstream flow — issue, cutting, production — is blocked behind this. |
| **HR** | Cannot register a worker. No attendance, no payroll, permanently. `/workforce` says "No workers on file" and offers no way to put one there. |
| **Planning** | `lines` has no service writer either; a factory that adds a sewing line later cannot. |

This is *the* day-one wall, and it is invisible until somebody tries: the screens render
perfectly and simply have nothing to offer. Barakah only worked because `seed-day0` planted
items and lines, and the missing locations were created **by hand in psql during the live
test** (runbook #21 records the location half; the item and worker halves are the same
defect and were never noticed).

> **Fix:** creation doors for `items`, `locations`, `workers` and `lines`. Item and worker
> are the two that stop a factory dead. This is the first batch, before anything cosmetic.

---

## HIGH — gaps that mislead or waste a person's day

### D2 · An admin is told to ask an admin

`/workforce` as `admin` or `manager` renders half the page (Headcount, Roster) and then a
locked card: **"You don't have access to payroll. Ask an owner or admin if you need it."**
The reader *is* an admin. The nav also offers the entry, so the sidebar says yes and the
screen says no — the one place in this product where hidden and locked visibly drift apart.

> **Fix:** name the actual holder ("payroll is owner and HR only"), and either drop the nav
> entry for admin or keep it and drop the contradiction. Payroll being hr+owner is correct
> and should stay; only the copy and the nav promise are wrong.

### D3 · MARBIM's first impression cites an order that does not exist

`/marbim` as viewer or member offers: *"What is the TNA status on **PO-88203**?"*,
*"When is ex-factory for this order?"* — PO-88203 is demo data from a different tenant. A
new factory's first conversation with the assistant is a question about paperwork it has
never seen, and the honest answer is "no such order", which reads as broken.

The screen-scoped chips from adoption plan 1.2 fixed 18 desks; `/marbim` itself has no
scoped set, so it falls through to the role chips — which are hardcoded with fake
references.

> **Fix:** the fallback chips must be answerable on an empty factory ("what can you help me
> with?", "explain this screen", "who approves what?"), and no chip anywhere should name a
> record by a made-up id.

### D4 · Day one has no first step for the desk that starts everything

The merchandiser lands on `/home`: *"Nothing waiting on you… the factory pulse and the order
book are a good place to look."* Both destinations are empty. Nothing says *create your
first buyer*, and the merchandiser is the one role whose action unblocks every other desk —
no buyer, no enquiry, no order, no work anywhere.

The calm copy is written for an established factory having a quiet morning, not for a
factory with nothing in it yet.

> **Fix:** a distinct day-one calm state — when the tenant genuinely has no buyers and no
> orders, say what to do first and link to it.

---

## MEDIUM — friction, redundancy, and half-doors

### D5 · Settings renders policy values as unlabelled buttons
`/settings` as a storekeeper exposes a row of bare values — `10 %`, `48 hours`, `5 days`,
`75 %` — as interactive controls for a role that cannot change them. Read-only should not
look pressable.

### D6 · Sub-page landings are not reflected in the sidebar
Store lands on `/store/receive`, production on `/lines/hourly`, quality on `/quality/inline`
— correct destinations, but the sidebar highlights the module root, so the person's own
screen is not the one shown as current.

### D7 · `/approve` is a dead end for eleven roles
Empty and actionless for everyone who is not currently an approver of something. It sits
near the top of most sidebars. The inbox badge already hides the count when zero; the entry
itself could do the same.

---

## What Phase A did not cover

Screens were visited; **flows were not driven end to end** — no form was submitted, because
D1 blocks the first one a new factory would attempt. Once the creation doors exist, the
second pass drives the kit's actual documents through: challan → GRN → issue → lay → hourly
→ inspection → shipment → invoice, as each role, recording where a real person would stall.

The AI-fill and document-input pass (auto-filling dialogs, accepting a document mid-flow)
is deliberately separate and runs against the **real** models, per the agreed split.

---

*Walked 2026-08-12 against `b5fe530`, tenant `test-textile`, mock provider.*
