# Core spec — module activation, the order workspace, and the drawer framework

Design spec for the three CORE changes that make the platform order-centric and
per-tenant modular. These are `modules/core` (and `src/app`) work, so per CLAUDE.md
rule 12 each ships as its own PR, never mixed into a module PR. The two new business
modules that build on them have pre-build handoffs: `HANDOFF-X-4-requests.md` and
`HANDOFF-X-5-mailroom.md`.

Status: LOCKED 2026-08-22 — the ⚑ decisions below were resolved in owner review.

---

## 1 · Per-tenant module activation (`company_modules`)

**Problem.** The platform is sold as module-based — a factory picks what it runs — but
nothing tenant-level gates a module today: every registered module is live for every
company. "Tenant chooses modules" is currently a sentence, not a table.

**Schema (core).** `company_modules`: `company_id`, `module_id` (the `registerModule` id),
`enabled` boolean, `enabled_at`, `enabled_by`. Absence of a row = the default for that
module. Defaults live in the module registration (`registerModule({ ..., defaultEnabled })`)
so a new module can ship dark. `modules/core` is not a module in this sense and cannot be
disabled; `settings` likewise.

**Enforcement — three choke points, server-side first:**

1. **Action boundary.** A helper in core (`assertModuleActive(ctx, moduleId)`) called by
   the thin action layer the same way auth and zod are. A disabled module's actions
   return a typed 403-family error, whatever the UI shows.
2. **MARBIM surface.** `intakeKindsFor` and the tool-pack assembly already filter by
   role; they additionally filter by activation, so MARBIM never offers a tool or an
   intake chip for a module the factory did not buy — and never narrates from a primer of
   a disabled module.
3. **Navigation and screens.** The nav tree and the order workspace tabs (§2) render
   from the same activation query. The UI reflects the gate; it never is the gate.

**Graceful degradation is part of the contract.** A cross-module feature must state what
happens when its counterpart is off. First instance: with procurement disabled, the
costing studio's "ask procurement for a price" compose becomes a manual price-entry field
— the merchandiser flow never dead-ends (see HANDOFF-X-4 §7/§8).

⚑ Decided: **owner only** flips modules — buying and shelving capability is an ownership
act, not administration. Disabling never deletes anything: rows stay, actions refuse,
re-enabling restores. The one refusal is dependency-shaped: a module that an ACTIVE
module's server-side gate depends on cannot be disabled while its dependent runs
(commercial cannot go dark while store still enforces `GATES.udBalance` against it).
Dependencies are declared in `registerModule({ requires: [...] })` so the registry can
check the graph, not a hand-kept list. Open in-flight rows (e.g. procurement with open
POs) get a warning listing them, not a block — the block would just breed support calls
for a decision the owner has already made.

---

## 2 · The order workspace, the Order File, and the Pulse

**Problem.** The order is the thing a garment factory revolves around, but the platform
has no single place where one order is WHOLE — its documents, its money, its milestones,
its blockers, and who is sitting on what.

**The Order File is a read model, not a new store.** Everything already leaves a trace:
`audit_log` (⚖ interceptor), outbox events, `order_files` (order ↔ document registry —
already in the orders schema), `pending_changes`, TNA milestones, and (new) requests.
The Order File aggregates them by `order_id`; nothing writes to it, so it cannot drift.

- **Timeline** — one chronological merge: state transitions, approvals, document
  filings, request lifecycle, TNA milestone completions, revisions. Lives in
  `orders/queries.ts`; cross-module rows come through each owner's `queries.ts`
  (rule 11), never raw tables.
- **Documents** — `order_files`, grouped by kind. The mailroom (X-5) and fulfilled
  document requests (X-4) file into it automatically.

**The Pulse — "the platform drives the user".** A pure function in
`orders/service.ts` (`orderPulse`) over the order aggregate: current state, next TNA
milestone and days to it, the blocking server-side gate if any (PP approval, BTB
headroom, UD, EXP, LC latest-shipment — already structured `GateResult`s, which is why
this is cheap), and open requests with who owes whom. Output is structured facts with
i18n keys, rendered two ways:

1. A strip at the top of `/orders/[id]` — *"Costing blocked: fabric quote requested from
   procurement 2 days ago"*, *"Cutting cannot start: PP approval pending with buyer"*.
2. **Per-role home = task inbox**: requests addressed to your roles + your TNA tasks due
   + drafts awaiting your approval. Computation stays in services; the MARBIM
   `domainPrimer` teaches narration of it, per the register.ts contract.

**Role-scoped, never role-forked.** One route, `/orders/[id]`: Pulse strip, then tabs
(Overview · Timeline · Documents · Costing · Production · Shipping…) where tab visibility
= module activation ∩ role permission. Same data contract per tab, different emphasis per
role — the desktop equivalent of the mobile role skins. No per-role page forks.

⚑ Decided: the timeline query computes live (a union over sources). The read-model shape
makes a materialized projection a later optimization if volume ever demands it, not a
redesign.

---

## 3 · The drawer framework (`EntityDrawer`)

**Problem.** The product promise is "everything extracted and shown in the UI, side
drawers where necessary" — but each drawer today is bespoke. Three recurring shapes
deserve one core primitive:

1. **Entity peek** — click any reference anywhere (a style, an LC, a supplier quote, a
   request) and inspect it without leaving the page. `core/refs` already resolves human
   codes (`B-04501`) to ids; the drawer is the visual half of that same idea.
2. **Draft review** — a MARBIM/intake proposal opens as a field-by-field diff with the
   per-field confidence chips, editable where the role permits, approve/reject in place.
   One component, fed by `pending_changes` — today's approve screens converge on it.
3. **Compose** — kind-first forms raised from context (the X-4 request compose, quick
   document filing), with the origin context pre-filled.

**Mechanism.** `<EntityDrawer kind id />` in core UI; each module contributes a drawer
renderer for its kinds through `register.ts` — the same registration philosophy as
`pendingTargets`, `refResolvers` and tool packs, and filtered by module activation like
everything else. Drawers stack one level (peek from within a peek replaces, not nests).
Data enters through the owning module's `queries.ts`; a drawer never gets private
queries.

---

## 4 · Sequencing and PR discipline

1. **Core PR 1** — `company_modules` + `assertModuleActive` + registration `defaultEnabled`
   + MARBIM surface filtering. (Everything else keys on it.)
2. **Core PR 2** — drawer framework skeleton + refs-driven entity peek for two existing
   kinds (order, document) to prove the registration seam.
3. **Orders module PR** — Order File timeline query + `orderPulse` + the workspace tabs.
   (Orders-module work, not core; touches no other module's tables.)
4. **`requests` module** — HANDOFF-X-4 locked 2026-08-22; brief exists.
5. **Buyers PR** — `buyers.owner_user_id` (the handling merchandiser), small and its own
   slice; the mailroom's auto-assignment depends on it.
6. **`mailroom` module** — HANDOFF-X-5 locked 2026-08-22 (transport: Outlook redirect →
   per-tenant inbound address → webhook adapter); brief exists.
7. Role homes / task inboxes — after 3 and 4 exist to feed them.

The two new modules (4 and 6) follow the PLAYBOOK per-module loop, HANDOFF locked before
kickoff — the gate holds for what is built next.
