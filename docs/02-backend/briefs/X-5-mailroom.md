# X.5 Mailroom — Inbound Buyer Email

**Department:** MERCHANDISING (worked by merchandisers; module is cross-cutting infrastructure)
**Companions:** `PLAYBOOK.md` (process) · `docs/handoffs/HANDOFF-X-5-mailroom.md` (the contract — pre-build, locked 2026-08-22) · `CLAUDE.md` (repo rules)

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

- A transport and a triage desk, **never an extractor**: `receiveInboundEmail` stores the
  .eml + attachments as core documents (quarantine pipeline applies), dedupes by RFC 5322
  `message_id` per company, matches the sender against buyer contacts (via buyers'
  `queries.ts`), auto-assigns via `buyers.owner_user_id` (the handling merchandiser —
  a separate buyers-module PR). `stageAttachment` is the only AI-adjacent act and it
  DELEGATES to `modules/marbim` intake: the person confirms the kind (`mayFileKind`
  enforced; a classifier's `suggested_kind` only pre-selects a chip), intake proposes to
  `pending_changes`. The mailroom writes no business row and registers NO pendingTargets.
- Transport (locked): factory Outlook **redirect** rule (redirect preserves `From:`) →
  per-tenant `orders-<slug>@in.fabricxai.com` → inbound-parse provider (Postmark, behind
  an adapter) → signature-verified webhook route → `receiveInboundEmail`. Fast-ack:
  anything slow is queued. A Microsoft Graph connector may become a second transport
  later; the seam does not care.
- Two tables: `inbound_emails` (status machine: received → triaged → staged → filed,
  with rejected/archived exits) and `inbound_email_attachments`
  (document_id, suggested/confirmed kind, pending_change_id once staged).
- `linkToOrder` files attachments into `order_files` in the same transaction; auto-called
  when a staged `buyer_po` draft commits into a new order.
- v1 scope: buyer mail only; body-only amendments out (readable in the peek drawer).
  Schema deliberately not buyer-specific.
- Events: `mailroom.received` / `mailroom.staged` / `mailroom.filed`; notifications to
  the assigned merchandiser via core `notify`.

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
