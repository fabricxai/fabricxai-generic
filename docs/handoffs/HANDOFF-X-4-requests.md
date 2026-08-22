# HANDOFF-X-4-requests — Interdepartmental Requests

> **Pre-build.** This is the first handoff written BEFORE its module, the way the PLAYBOOK
> has always demanded and never once received. It is a contract, not a description: nothing
> below exists in `src/` yet, and `docs/__tests__/handoff-contract.test.ts` knows to start
> checking §5/§6/§7 against code the moment `src/modules/requests` appears.
>
> **Status: LOCKED 2026-08-22.** §8's questions were resolved in owner review the same day
> they were asked; the answers live in the body and §8 records only that they were
> answered. The build may start.

**Module:** `src/modules/requests` · **Brief:** `docs/02-backend/briefs/X-4-requests.md`

## §1 · Purpose & roles

A garment order is carried forward by people asking each other for things: a merchandiser
asks procurement for a fabric price before costing can start; commercial asks the
merchandiser for a PI; quality is asked for a test report before a shipment books. Today
those asks live in phone calls and WhatsApp, so the order file never shows WHY an order sat
still for four days.

This module makes the ask a typed row bound to the order: who asked, whom, for what kind of
thing, by when, and — the part that makes it worth building — **what artifact answered it**.
A fulfilled price request points at a real `supplier_quotes` row, not a number retyped from
a message. Chat is not a fallback; a request that cannot name its kind is a conversation and
belongs in MARBIM, not here.

Any role may create and be targeted by requests. Targeting is **by role** (department), not
by person — the department triages its own inbox, and naming individuals would invite the
bypass this module exists to end. Owner/admin see everything.

## §2 · Screens

- **Compose drawer** — opened from wherever the need arises (costing studio, order
  workspace, LC register): order pre-filled from context, kind picked first, kind-specific
  payload fields after. Never a separate page; the person stays where they were.
- **Role inbox** — the department home shows open requests addressed to the caller's
  roles, SLA-sorted, with overdue on top. Same pattern as the Approve Inbox.
- **Request peek drawer** — click a request anywhere (timeline, inbox, notification) and
  see it whole: the ask, the thread of state changes, and the fulfillment artifact as a
  live link into its owning module's drawer.
- **Order file timeline** — every request and its resolution appears in the order's
  timeline (core spec: order workspace).

## §3 · Queries (`queries.ts` — field-for-field, per PLAYBOOK review gate 4)

| query | returns |
|---|---|
| `requestsForOrder` | All requests on one order, newest first: id, kind, status, from_role, to_role, subject, sla_due_at, fulfilled_at, fulfillment_ref. |
| `inboxForRoles` | Open (`requested`/`acknowledged`) requests addressed to any of the caller's roles, overdue first then by sla_due_at. Same fields plus order po_number for display. |
| `inboxCounts` | The badge: open and overdue counts per role the caller holds. |
| `requestById` | One request with its full payload, audit-sourced state history, and resolved fulfillment reference. |
| `overdueOpenRequests` | Open requests past sla_due_at — the escalation job's worklist. |

## §4 · Entities

One table. History is `audit_log` (⚖) and the outbox, not a second table.

`requests`: `id`, `company_id`, `order_id` (nullable — most asks are order-bound and
indexed by it; a general ask like "send me the latest gazette table" is legal), `kind`
(enum: `price_quote` · `document` · `approval` · `info`), `from_user_id`, `from_role`,
`to_role`, `subject`, `body`, `payload` (jsonb, kind-specific shape validated by
`zod.ts` at create — e.g. price_quote: item description, quantity, unit, needed-by),
`status`, `sla_due_at` (defaulted per kind at create — `price_quote` 48h, everything else
24h; fixed in code for v1, Settings-configurable later), `fulfilled_by`, `fulfilled_at`,
`fulfillment_ref` (jsonb `{table, id}` — the typed artifact; see §7), `created_at`,
`updated_at`.

Indexes: `(company_id, to_role, status)` for the inbox; `(company_id, order_id)` for the
timeline; partial on `status IN ('requested','acknowledged')` for overdue scans.

## §5 · Operations

Every name below will be exported from `src/modules/requests/service.ts`.

| operation | what it does |
|---|---|
| `createRequest` | Validates the kind payload, checks the target department's module is active (core spec), writes the row, notifies the target role via core `notify`, emits `request.created`. |
| `acknowledgeRequest` | The target department says "seen, working on it" — the requester stops wondering. |
| `fulfillRequest` | The heart. Records the typed artifact ref, verifies it per kind (§7), transitions to `fulfilled`, notifies the requester, emits `request.fulfilled`. |
| `declineRequest` | With a required reason. A decline is an answer, not a failure. |
| `cancelRequest` | The requester withdraws their own ask. Only the requester (or owner/admin). |
| `expireOverdueRequests` | Job-driven nightly sweep: transitions long-dead requests and emits escalation notifications to owner/admin. Idempotent by event id. |

## §6 · State machines

`requestMachine`, a `defineStateMachine` on field `status`:

```
requested    → acknowledged · fulfilled · declined · cancelled · expired
acknowledged → fulfilled · declined · cancelled · expired
fulfilled    → (terminal)
declined     → (terminal)
cancelled    → (terminal)
expired      → (terminal)
```

`requested → fulfilled` directly is legal — a department that answers immediately should
not be forced through a ceremonial acknowledge. Illegal transitions are the typed 409.

## §7 · Gates & cross-module contract

No money gate of its own. The invariant that plays the gate's role is **fulfillment is an
artifact, never prose** — enforced server-side in `fulfillRequest`, per kind:

- `price_quote` → must reference a `supplier_quotes` row, verified through procurement's
  `queries.ts` (rule 11 — never a raw table read). The quote arrives through procurement's
  own rails — a purchase requisition quoted via `recordSupplierQuote` — not a side door;
  fulfilling a price request with a number that has no requisition behind it is exactly
  the WhatsApp habit this module replaces. Costing then consumes the quote row itself;
  the request is how it was asked for, not where the number lives.
- `document` → must reference a `documents` row (core), which lands in `order_files` when
  the request is order-bound — so answering a document request files it in the order file
  in the same transaction.
- `approval` → delegates to the existing machinery: the ref points at a `pending_changes`
  row or an approvals decision. This module never re-implements approval; it only carries
  the ask to the right inbox.
- `info` → the one prose kind: fulfillment text lives in the payload. Deliberately so —
  forcing an artifact where none exists would push people back to WhatsApp.

Cross-module: `modules/core` for notify/outbox/audit (⚖ table — every transition is
audited); consumers read requests only via this module's `queries.ts`.

**Module activation gates the artifact kinds only.** `price_quote` and `approval` need
their fulfilling machinery (procurement, approvals) active for this tenant — create
refuses server-side, compose says why, and with procurement disabled the costing studio
degrades to a manual price-entry field. `info` and `document` may target any role
regardless of activation: a department exists whether or not the factory bought its
module, and asking it for a paper must never dead-end.

## §8 · Open questions

**None open.** Locked 2026-08-22 after owner review resolved the four drafted questions:
quote fulfillment goes through procurement's requisition rails (§7); SLA defaults are
fixed per kind in code (§4); targeting is role-only (§1); activation gates only the
artifact kinds (§7).

## §9 · Non-functional

Low volume (tens per order, not thousands) — correctness of the artifact refs matters,
throughput does not. The escalation job must be idempotent (dedupe by event id, rule 6).
The inbox query must stay index-only cheap: it renders on every department home load.

## §10 · Seed

Extend `seed:running`'s mid-flight orders: one open `price_quote` from merchandiser →
procurement (aging, near SLA), one fulfilled `price_quote` whose `supplier_quotes` ref
feeds the same order's cost sheet, one fulfilled `document` request filed in
`order_files`, one declined with reason, one expired. The edge rows are the point.
