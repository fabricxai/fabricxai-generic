# HANDOFF-X-5-mailroom — Inbound Buyer Email

> **Pre-build.** Written before the module exists, per the PLAYBOOK rule this repo finally
> intends to honour. `docs/__tests__/handoff-contract.test.ts` begins checking §5/§6/§7
> against code the moment `src/modules/mailroom` appears.
>
> **Status: DRAFT until §8 is resolved** — §8 currently holds the transport decision, which
> only the owner can make. Once resolved, answers move into the body, §8 empties, the build
> may start. The brief (`docs/02-backend/briefs/X-5-mailroom.md`) is owed before the build.

**Module:** `src/modules/mailroom` · **Brief:** owed — to be written before build

## §1 · Purpose & roles

Buyers send orders by email: a PO sheet and a tech pack as attachments, sometimes an
amendment in the body text. Today the platform's document intake (`modules/marbim/intake.ts`,
15 kinds including `buyer_po` and `tech_pack`) starts at a screen — a person who already
downloaded the attachment uploads it back. The mailroom removes that hop: the email arrives
IN the platform, its attachments are already documents, and the merchandiser's job shrinks
to confirming what each one is.

What this module is **not**: an extractor or an auto-creator of orders. It is a transport
and a triage desk. Every draft still goes through the existing intake pipeline —
`readDocument` → `pending_changes` with per-field confidence → a human approves (rule 3).
The mailroom itself never writes a business row.

Roles: `merchandiser` works the triage desk (scoped to buyers they own); `owner`/`admin`
see all. Other roles have no standing here — an email from a supplier or a bank is out of
scope for v1 (§8).

## §2 · Screens

- **Mailroom inbox** — unprocessed emails, each card showing matched buyer (or "unknown
  sender"), subject, attachment chips with suggested kinds. Filters: mine / unmatched / all.
- **Email peek drawer** — the message body, headers, attachments; actions per attachment
  ("stage as buyer PO", "stage as tech pack" — the chips come from `intakeKindsFor`, so a
  person is only offered kinds they may file).
- **Staging flow** — confirming a kind opens the same context-field picker the intake
  screen uses (e.g. `buyer_po` requires the buyer — pre-selected when the sender matched).
- **Order file** — once linked, the email and its attachments appear in the order's
  documents tab and timeline, from minute zero.

## §3 · Queries (`queries.ts`)

| query | returns |
|---|---|
| `inboundEmailsList` | Triage desk: id, status, from_address, matched buyer, subject, received_at, attachment count, assigned merchandiser. Filterable by status/mine/unmatched. |
| `inboundEmailById` | One email whole: body text, raw .eml document ref, attachments each with document_id, suggested/confirmed kind, pending_change_id once staged. |
| `unprocessedCounts` | The badge: emails in `received`/`triaged` for the caller's scope. |
| `emailsForOrder` | Emails linked to one order — the order file's correspondence view. |

## §4 · Entities

`inbound_emails`: `id`, `company_id`, `message_id` (RFC 5322, unique per company — the
idempotency key; a webhook retry or a re-poll must not duplicate), `from_address`,
`buyer_id` (nullable — matched against `buyer_contacts` emails via the buyers module's
queries; unmatched is a triage state, not an error), `assigned_to` (nullable user),
`subject`, `body_text`, `raw_document_id` (the full .eml stored via core documents),
`order_id` (nullable — linked at filing), `status`, `received_at`, `created_at`.

`inbound_email_attachments`: `id`, `company_id`, `email_id`, `document_id` (core documents
row — the quarantine pipeline applies to mailed files exactly as to uploaded ones),
`filename`, `mime`, `suggested_kind` (nullable — a cheap-tier classifier's hint, never
acted on), `confirmed_kind` (nullable — what the person said it is), `pending_change_id`
(nullable — set when staged and the intake job proposed).

Indexes: unique `(company_id, message_id)`; `(company_id, status)`; `(company_id, order_id)`.

## §5 · Operations

Every name below will be exported from `src/modules/mailroom/service.ts`.

| operation | what it does |
|---|---|
| `receiveInboundEmail` | The transport entry (webhook route or poller job calls it). Idempotent by `message_id`: stores the .eml and attachments via core documents, matches the sender to a buyer contact, auto-assigns per buyer ownership, notifies, emits `mailroom.received`. Fast — anything slow (classification) is queued, not inline. |
| `matchBuyer` | Manual override when auto-match failed or matched wrong. |
| `assignEmail` | Hand the email to a merchandiser. |
| `stageAttachment` | The person confirms a kind; validates via `mayFileKind` and the kind's context fields, then queues the existing MARBIM read — this is where the mailroom hands off to intake and stops. Records `pending_change_id` when the job proposes. |
| `linkToOrder` | Files the email against an order: writes `order_files` rows for its attachments in the same transaction. Auto-called when a staged `buyer_po` draft commits into a new order. |
| `rejectEmail` | Spam, a wrong address, not a buyer. Terminal, with reason. |
| `archiveEmail` | Done with, nothing (more) to stage. |

## §6 · State machines

`inboundEmailMachine`, a `defineStateMachine` on field `status`:

```
received → triaged · rejected
triaged  → staged · archived · rejected
staged   → filed · archived
filed    → (terminal)
archived → (terminal)
rejected → (terminal)
```

`received → triaged` happens automatically when buyer match + assignment succeed at
receive time; the machine exists so the manual path takes the same legal steps. Illegal
transitions are the typed 409.

## §7 · Gates & cross-module contract

- **The mailroom never proposes.** Its one AI-adjacent act, `stageAttachment`, delegates
  to `modules/marbim` intake, which owns `pending_changes` proposal, per-field confidence,
  and role checks. A mailroom that extracted directly would be a second door around rule 3.
- **Suggested kind is a suggestion.** `intake.ts`'s header rule stands: the person holding
  the document says what it is. The classifier (Haiku-tier, queued) only pre-selects a
  chip; nothing is ever queued from a suggestion alone.
- **Attachments are core documents** — MinIO storage, mime/size limits, quarantine
  pipeline. A mailed virus meets the same wall as an uploaded one.
- **Buyer matching reads buyers' `queries.ts`** (rule 11), never `buyer_contacts` raw.
- **Module activation:** mailroom requires the orders module active; staging offers only
  kinds whose owning module is active for this tenant (core spec).
- Events: `mailroom.received` / `mailroom.staged` / `mailroom.filed` via outbox;
  notifications to the assigned merchandiser via core `notify`.

## §8 · Open questions

*To be resolved in review; this section must be empty before the build starts.*

1. **Transport** (the owner's call — Resend, our outbound provider, does not do inbound):
   - **A. Inbound webhook provider** (Postmark inbound / SES + SNS / Cloudflare Email
     Routing → worker): per-tenant address `orders-<slug>@in.fabricxai.com`, push
     delivery, signature-verified route. Cleanest; adds a vendor.
   - **B. IMAP polling** of the factory's own existing mailbox via a BullMQ repeat job:
     no new vendor, works with the address buyers already write to; polling lag, one
     credential per tenant to hold.
   - Either way the transport is an adapter in `jobs.ts`/an API route; `receiveInboundEmail`
     is the seam and does not care.
2. **Buyer→merchandiser ownership** — auto-assignment needs "who owns this buyer"
   recorded. Buyers module has no owner field today; add `buyers.owner_user_id`, or derive
   from who created the buyer's recent orders? Leaning: explicit field (a buyers-module
   change, its own PR).
3. **Body-only amendments** — an email with no attachment ("increase style X to 5,000
   pcs") — v1 scope? Leaning: out; the body is readable in the peek drawer and the person
   acts manually. An `email_body` intake kind can come later.
4. **Non-buyer mail** (suppliers' proformas, bank advices — both already intake kinds):
   one shared mailroom with role-scoped desks, or buyer-mail only for v1? Leaning: buyer
   mail only, schema deliberately not buyer-specific.

## §9 · Non-functional

The webhook route must acknowledge fast (store-and-queue; classification and any reading
happen in the worker). Dedupe by `message_id` is the idempotency invariant — provider
retries are normal, duplicated drafts in an approve inbox are not. Unmatched-sender mail
must age visibly (triage desk sort), never silently pile up. Attachment storage counts
toward the same limits as uploads.

## §10 · Seed

Two inbound emails against seeded buyers: one fully walked (matched, staged `buyer_po`,
pending change proposed, linked to the order it created — the demo path), one unmatched
sender sitting in triage. One rejected spam row. Attachment fixtures reuse the intake
kinds' existing sample documents.
