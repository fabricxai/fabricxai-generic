# FabricXAI — MARBIM adoption & role-UX plan (code workstreams)

**Created:** 2026-08-12, from three sources reconciled against the code as of `7a61ad3`:
`docs/03-frontend/UX-AUDIT-BY-ROLE.md` (screens), `docs/03-frontend/MARBIM-ADOPTION-BY-ROLE.md`
(the assistant), and Cursor's problem inventory (validated 2026-08-12 — see the validation
notes inline; two of its claims were wrong and are excluded, several were partial and are
scoped to the true remainder).

**Scope:** the habit loop — land on your work, hit friction, ask MARBIM, approve/correct,
teach the system. **Excluded deliberately:** key rotation and ops go-live gates (GL-1..4 in
`HANDOVER-READINESS.md`) — they outrank everything here the moment real factory data is
scheduled, and they are not UX work.

**How to use:** phases ordered by (habit value × cheapness). Tasks sized to roughly one
working session. Do them in order unless a dependency note says otherwise. Tick tasks here
and note the commit, same convention as `PRODUCTION-READINESS-PLAN.md`.

Legend: 🅗 high · 🅜 medium · S/M/L = hours / day / multi-day

---

## Phase 1 — Placement (no new machinery; changes every person's morning)

- [x] **1.1 🅗 S Role-correct landing.** `5f5ca4a` — Every role lands on the screen their day starts
  on, not on whatever the sidebar orders first — a storekeeper currently opens an empty
  approve inbox. Storekeeper → receiving, cutting → lays, line supervisor → hourly,
  quality → inline, shipment → board, maintenance → tickets, hr → payroll, compliance →
  audits, finance → finance, commercial → LC register, planner → planning board;
  owner/admin/merchandiser keep `/home`. One resolver, tested as a function.
  *Verify:* a test walks every role and asserts its landing; no role lands on `/approve`.
- [ ] **1.2 🅗 M Screen-scoped prompt chips.** Replace the generic per-role suggestions
  with per-screen ones from `MARBIM-ADOPTION-BY-ROLE.md` (the specific questions each desk
  computes by hand today). Bangla-first on store/cutting/production/quality screens.
  *Verify:* chips differ between two screens for one role; floor chips render Bangla under
  the bn locale.
- [ ] **1.3 🅗 M "Ask about this row."** One affordance on desk tables/cards (orders,
  buyers, LC register, requisitions, tickets) that opens the panel with the row's code
  pre-filled — "Ask about PO-BF-2044…". Pairs with the shipped ref-resolvers, closing the
  identifier gap at the UI end.
  *Verify:* clicking it on an order row opens the panel with the PO number in the composer.
- [ ] **1.4 🅗 S–M Refusal → "Ask MARBIM why," pre-filled.** The five server gates
  (PP-approval, UD balance, BTB headroom, EXP, LC latest-shipment) and
  `actionErrorMessage` toasts gain a pre-filled ask. A person who just got blocked is the
  most motivated learner in the building.
  *Verify:* triggering the UD overdraw block offers the ask; the pre-filled question names
  the UD.

## Phase 2 — Trust and visibility

- [ ] **2.1 🅗 M Draft-fate strip.** Cutting, maintenance and store raise drafts but hold
  no approve nav — their work vanishes into silence. "My raised drafts" (status, age, who
  it waits on) on those homes; reads `pending_changes` by `created_by`, no new tables.
  *Verify:* a cutting correction shows as pending on the cutting home, then committed.
- [ ] **2.2 🅗 M–L Per-role "Your work."** The composed queue exists for
  owner/admin/merchandiser only. Compose per-role versions from existing queries: store
  (requisitions to issue, GRNs awaiting inspection, low UD balances), quality, shipment,
  commercial. Depends on nothing; 2.1 folds into it.
  *Verify:* `store@` sees a non-empty composed queue naming its own work.
- [ ] **2.3 🅜 S Wire `checkUdBalance` into the issue screen.** The read-only preview was
  built for exactly this and has **no screen caller** (validated 2026-08-12) — the
  storekeeper meets the balance only as a refusal. Show remaining balance when a bonded
  roll is picked.
  *Verify:* picking a bonded roll shows the declaration's remaining quantity before Issue.
- [ ] **2.4 🅜 S Maintenance "claimed" ping.** The resolve loop already closes the line's
  stoppage; the missing half is the moment between — one notification to the reporting
  line when a ticket is claimed ("Sabbir is coming").
  *Verify:* claiming a ticket notifies the stoppage's line role.

## Phase 3 — Decisions required (do deliberately, not in passing)

- [ ] **3.1 🅗 M Self-approval policy.** One person can draft and sign the same
  single-approval change (also `HANDOVER-READINESS` DL-8). Proposed split: forbid
  approving your own draft on ⚖ tables (money, payroll, LCs, UD overrides), allow
  elsewhere so intake's review-your-own-upload flow survives. **Needs owner sign-off on
  the split before building.**
  *Verify:* integration test — proposer's approve on an ⚖ target refuses with a sentence;
  a second admin's approve commits.
- [ ] **3.2 🅗 L Approval-rules UI.** Routing lives in seeds and psql; the owner cannot
  tune who signs what. Settings surface over `approval_rules` (module/target/operation →
  roles, count). **Must not offer `condition`** — the engine reads module/target/operation
  only, and a rule that looks like a gate and is not one is the day-0 script's own recorded
  trap.
  *Verify:* owner edits a rule; the next matching draft routes to the new roles; the form
  offers no condition field.

## Phase 4 — Flagship time-savers (the habituation moments)

- [ ] **4.1 🅗 M Challan-photo → pre-filled GRN.** Photos are model-readable; the receive
  screen gains "read this challan" — photo in, lines/lots/quantities drafted, storekeeper
  reviews against the paper instead of typing. The floor's single biggest habit win.
  *Verify:* a challan photo yields a draft the receive form is seeded from; nothing is
  written without the storekeeper's save.
- [ ] **4.2 🅗 M Supplier-quote intake via context pickers.** The kind was removed because
  quote payloads demand UUIDs no paper carries; the findings kind proved the fix — pickers
  for requisition and supplier at intake. Re-add `supplier_quote` with both.
  *Verify:* a pasted quote drafts against the picked requisition; the extractor never
  invents an id.
- [ ] **4.3 🅗 M "Summarise this draft" in the approve inbox.** One ask per draft: what
  it changes, the low-confidence fields, what to check before signing. The inbox is where
  trust in MARBIM is won or lost.
  *Verify:* the summary names the weakest field of a real draft.
- [ ] **4.4 🅜 M Exception-first payroll approve.** Deltas vs last month, impossible
  attendance, new joiners — surfaced above the signature. Import exceptions are already
  named; this adds the month-over-month sweep.
  *Verify:* a worker whose net moved >10% appears in the exception strip before approve.

## Phase 5 — Composites (build the tool honestly, then give it a chip)

- [ ] **5.1 🅗 M Shipment readiness checklist.** EXP · LC dates · qty-vs-tolerance · docs
  against the credit's own list, as one panel from day one — not discoveries at the door.
  MARBIM narrates it ("what's missing before the bank?").
  *Verify:* a shipment with no EXP shows the checklist red on that row before any submit.
- [ ] **5.2 🅗 L Quality pre-final readiness.** The four inspection screens composed into
  "will this order fail final?" — fabric points, DHU trend, measurement flags, AQL
  posture. New read tool + order-page strip.
  *Verify:* the order that failed the live test's final would have shown red here first.
- [ ] **5.3 🅜 M Discrepancy work-queue.** `agingDiscrepancies` exists (the escalation
  job reads it); give it a screen — age, owner, whose turn.
  *Verify:* a discrepant submission appears with its age; resolving clears it.
- [ ] **5.4 🅜 M CAP cross-department assignment.** A CAP owned by another department
  appears in that person's "Your work" (depends on 2.2).
  *Verify:* a CAP assigned to store shows on `store@`'s composed queue.
- [ ] **5.5 🅗 L Bangla floor sweep.** Burn down the `AWAITING_BANGLA` ratchet (141 keys)
  floor-screens-first: hourly, endline, issue, lays. Incremental; the ratchet only
  shrinks.
  *Verify:* ratchet count strictly lower each slice; hourly renders fully bn.

## Validated and excluded (so nobody re-litigates)

- **"/refused only for some roles" — wrong.** Registered for every floor role plus
  merchandiser, deliberately (`nav.ts` comment); owner/admin via all-access.
- **"MARBIM was off" — stale.** Enabled locally and in production.
- **Read-only "propose what I know" — by design**, not a bug. Changing the viewer/member
  contract is a product decision to make explicitly if ever.
- **Code/ref lookup — already shipped** (`fe220eb`, `ae2287e`): buyer codes, PO numbers,
  line codes resolve; style codes deliberately excluded (unique per order, not per
  company — a search, not a lookup).
- **Policy explanations — largely landed** in `d8b1020` (`policy-copy.ts`); remainder is
  per-number gate linkage, folded into 3.2's neighbourhood rather than tracked alone.
