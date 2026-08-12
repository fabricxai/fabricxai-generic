# FabricXAI Mobile — the contract (build plan 4.0)

**Created:** 2026-08-12, from `docs/UI-UX-ROLE-AUDIT.md` §3. This is the agreement about what
the mobile programme builds — the HANDOFF-equivalent for new surface area. No 4.x code lands
before this is reviewed and the tick below carries a name.

**Platform decision (standing):** one codebase, shipped as an installable PWA over the existing
Next.js app — manifest + service worker + role-skin layouts. Not React Native, not an app store,
until push or camera limits force it (revisit at 4.2 if they do). The responsive base already
holds: zero horizontal scroll on all twelve floor screens at 390px, tap targets ≥44px, offline
queue live on the floor writes.

---

## 1 · Non-regression: what mobile is FORBIDDEN from changing

The desktop app is the product; the mobile programme is a second door into it. By construction:

- **No service, gate, schema or action changes.** A mobile skin calls exactly the writes the
  desktop calls, through the same role walls. If a skin needs a new shape, that is a desktop
  feature first, contracted separately.
- **The service worker never cache-firsts data.** Shell assets (JS/CSS/fonts) cache-first;
  every fetch to a route or action network-first. A stale stock figure is worse than a slow
  one, and a floor tablet showing yesterday's UD balance is the exact failure this product
  exists to prevent. The SW also never intercepts POSTs — the offline queue already owns
  write-retry semantics with `offline_key` idempotency, and two retry layers would double-fire.
- **Shared components serve both surfaces.** Changes ride the density token (`--fx-tap-min`),
  as the tap-target fix already proved: floor 48px, desk 36px, desktop layout shift ≤4px.
  Any component change that would visibly alter desktop goes through the normal review, not
  under a mobile flag.
- **Skins are additive routes/layouts.** `/m/<skin>` (or an installed-display-mode check on
  the existing routes — decided at 4.2, whichever diffs smaller). Deleting the entire mobile
  surface must leave the desktop app byte-identical in behaviour.
- **Push is a delivery channel, not an event system.** It fans out rows from the existing
  in-app `notifications` table. No new event producers; a notification that doesn't exist
  in-app cannot exist as push.

## 2 · Shared platform (built once, in 4.1)

- **Manifest + install prompt** — name, icons, standalone display, per-skin start URL.
- **Service worker** — per §1; versioned, update-on-reload, kill-switch env var.
- **Push** — `push_subscriptions` table (tenant-scoped, per user+device; addressing, not ⚖),
  subscribe/unsubscribe actions, a worker bridge from `notifications` rows to web-push,
  per-role event list below. Failure to deliver push never blocks the in-app notification.
- **Camera → drop zone** — already built (`ReadIntoForm`); mobile adds `capture="environment"`
  affordance only.
- **Offline** — exactly the existing `offline_key` operations, no new ones:
  `receive_grn · issue_stock · create_lay · record_cut_report · record_hourly_outputs ·
  record_endline_count · open_downtime · close_downtime · inline_check · final_inspection ·
  measurement_set · finishing_output · pack_carton`. Anything not on this list requires
  connectivity and says so.
- **Copy** — Bangla-first on floor skins via the existing `tui` catalogue; every new key en+bn.

## 3 · The skins

Each skin = a home tab set + push list. Everything else (dialogs, gates, refusal copy) is the
existing product.

| Skin | Roles | Home tabs | Primary writes (all existing) | Push events |
|---|---|---|---|---|
| **Truck** | store | Receive · Issue | receive_grn, issue_stock | GRN inspection result; requisition raised |
| **Hour** | production | This hour · Endline · Stoppages | record_hourly_outputs, record_endline_count, open/close_downtime | run-rate slip vs day plan; my ticket claimed/resolved |
| **Walk** | quality | Line walk · 4-point · Final | inline_check, final_inspection, measurement_set | lot newly inspectable; repeat-defect on my lines |
| **Table** | cutting | Queue · Lay · Report | create_lay, record_cut_report | PP flipped cuttable; tolerance override decided |
| **Ticket** | maintenance | Tickets · PM · Registry | claim/resolve (online), nameplate reader | new ticket (line-down loud); PM overdue |
| **Carton** | shipment | Pipeline · Packing | pack_carton, finishing_output | packable threshold crossed; LC countdown 3d/1d |
| **Desk** | merchandiser, commercial (+ hr/compliance/finance/planner ride along) | Order book · Capture · Confirm | none offline — capture + raiser-confirm only | merch: PP verdicts, TNA slips; commercial: LC countdowns, headroom crossings, realization landed |
| **Pulse** | owner, admin | What's wrong · Approve · Figures | approve/reject only | high exceptions; drafts aging; payroll awaiting approval; UD overdraw approved |

**Deliberately absent everywhere:** settings, role grants, policy edits, factory-type change,
document assembly / bank submission (two-monitor work), payroll computation, approval-rule
editing. Changing the rules of the factory is desk work.

**No skin:** viewer, member — the web is enough for read-only.

## 4 · Order of work and verify gates

1. **4.1 PWA base + push** — Lighthouse PWA pass; a seeded notification reaches a subscribed
   device and not an unsubscribed one; SW kill-switch proven; desktop e2e suite green
   unchanged (the non-regression gate, run before and after).
2. **4.2 Hour** → 3. **4.3 Truck** → 4. **4.4 Walk, Ticket, Table** → 5. **4.5 Carton, Desk,
   Pulse.** Each skin: the audit's 390px sweep (0 hscroll, 0 <44px), an airplane-mode
   round-trip on its offline writes, and one real document through its camera path where it
   has one.

## 5 · Sign-off

- [ ] Contract reviewed — *(name, date)* — 4.x code may start.
