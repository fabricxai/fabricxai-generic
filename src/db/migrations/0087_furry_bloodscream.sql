CREATE TYPE "public"."grn_source" AS ENUM('supplier', 'own_production');--> statement-breakpoint
ALTER TABLE "grns" ADD COLUMN "source" "grn_source" DEFAULT 'supplier' NOT NULL;
--> statement-breakpoint
-- Backfill for receipts recorded before the question existed.
--
-- The column defaults to 'supplier', which is the safe direction for anything new: an
-- unanswered question must gate, not exempt. But applying that to history would newly block
-- a knit house's own greige — cloth nobody ever issues a 4-point sheet for — and the
-- storekeeper's only escape would be to file a fictional inspection, which is the failure
-- the exemption exists to prevent.
--
-- So history is read with the one piece of positive evidence those rows carry: BONDED.
-- Duty-free material is imported under a customs declaration by definition — a factory does
-- not bond cloth it knitted itself — so a bonded receipt is a supplier delivery whatever its
-- purchase-order link says. Everything else with no PO behind it is treated as own
-- production, which is exactly how the gate read those rows yesterday: nothing becomes newly
-- blocked, and nothing bought stays exempt.
UPDATE "grns"
SET "source" = 'own_production'
WHERE "supplier_po_id" IS NULL
  AND "bonded" = false;
