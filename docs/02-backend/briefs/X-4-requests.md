# X.4 Interdepartmental Requests ⚖

**Department:** CROSS-CUTTING
**Companions:** `PLAYBOOK.md` (process) · `docs/handoffs/HANDOFF-X-4-requests.md` (the contract — pre-build, locked 2026-08-22) · `CLAUDE.md` (repo rules) · `docs/02-backend/specs/order-centric-core.md` (module activation, drawers)

## Global conventions

**Global conventions (apply to every module):**

- Every table: `id uuid pk`, `company_id uuid not null → companies`, `created_at`, `updated_at`, `created_by → users`. RLS/tenancy scoping on `company_id` at both ORM layer and Postgres RLS (session var).
- Status fields are enums with explicit state machines documented per module; illegal transitions rejected server-side.
- Money: `numeric(14,2)` + `currency char(3)`; never floats. Quantities: `numeric(12,2)` (fabric meters/kg) or `integer` (pieces). Every API response carries currency/unit.
- All AI/junior-drafted writes flow through `pending_changes` (whitelisted `target_table`, per-module Zod payload schema, routing rule for approver role).
- Soft business documents (PDFs, photos) → S3/MinIO, referenced by `documents(id, bucket_key, mime, size, sha256, label)`.
- Events: emitted to an internal outbox table → consumed by BullMQ jobs (notifications, digests, derived computations). Names given per module as `module.event`.
- Audit: append-only `audit_log(actor, action, table, row_id, before, after)` written by the service layer on every mutation of money-bearing or compliance-bearing tables (marked ⚖ below).

## Module brief

- One table, `requests` ⚖ — a typed ask bound (usually) to an order: kind
  (`price_quote` · `document` · `approval` · `info`), from_role → to_role, kind-specific
  zod-validated `payload`, SLA, and a typed `fulfillment_ref {table, id}`. History is
  audit_log + outbox, never a second table.
- **The invariant that matters:** fulfillment is an artifact, not prose. `price_quote`
  must reference a `supplier_quotes` row reached through procurement's requisition rails;
  `document` a `documents` row (filed to `order_files` in the same transaction when
  order-bound); `approval` delegates to pending_changes/approvals; only `info` answers in
  text. Verification of the ref is server-side in `fulfillRequest`, per kind, through the
  owning module's `queries.ts` (rule 11).
- Targeting is role-only. Module activation gates the artifact kinds (`price_quote`,
  `approval`) at create; `info`/`document` reach any role regardless.
- MARBIM: `tools.ts` read + draft only — list my inbox, draft a request (via
  pending_changes? No: requests are human asks; MARBIM may PRE-FILL the compose drawer,
  never create). No pendingTargets for v1 — `pending_changes` has no business writing
  a request, so the whitelist stays empty and `propose` refuses the table.
- Events: `request.created` / `request.acknowledged` / `request.fulfilled` /
  `request.declined` / `request.expired`; nightly `expireOverdueRequests` job, idempotent
  by event id, escalating to owner/admin.

## Implementation checklist (standard — every module)

**Precondition:** `docs/handoffs/HANDOFF-<id>.md` exists with §8 empty. The handoff wins on fields/states; this brief wins on invariants (tenancy, money, gates, audit).

Build order inside the module folder `src/modules/<name>/`:
1. `schema.ts` — drizzle tables from Entities above + handoff §4 deltas; generate migration
2. `zod.ts` — payload schemas incl. every pending_changes payload
3. `service.ts` — Operations above; pure functions where possible; write unit tests alongside
4. `queries.ts` — read models matching handoff §3 exactly (fields, sort, pagination)
5. `actions.ts` — thin: auth → zod → service
6. `events.ts` / `jobs.ts` — outbox events + BullMQ processors from Events/jobs above
7. `tools.ts` — MARBIM read + draft tools only
8. `register.ts` — pendingTargets whitelist, zodMap, approvalDefaults, toolPack, jobs
9. Extend `db/seed` per handoff §10 (include the edge rows)
10. Tests green: unit, tenancy (cross-company ⇒ 0 rows), state machines, pending flow, offline idempotency (if floor module)
11. k6 scenario if module is ⚡ or floor-facing (handoff §9)
12. PR: one module slice, description generated from the handoff diff

**Done means:** every handoff §5 operation exists under the same name; §6 state machines enforced server-side; §7 gates server-side; no `any` in service layer; no float money; audit_log written for ⚖ tables.
