-- Attach hours that were recorded against no order to the order planned for their day.
--
-- Two screens wrote orphaned cells (§9, F44): the day catch-up took the order from TODAY's
-- plan while writing a PAST day, and the board's hour edit sent no order at all. The service
-- now resolves the order from `daily_line_plans` for the day being written, which repairs
-- anything re-entered — but nobody re-enters a day that already looks saved, and until then
-- those pieces are invisible to the order they were sewn for and to `wip_snapshots`, which
-- counts only rows carrying one.
--
-- Repaired from the plan for THAT day and nothing else. A row whose day has no plan stays
-- null: there is no evidence of what it belonged to, and inventing one — the nearest day's
-- order, the line's usual order — would put pieces against a buyer's order on a guess. A
-- blank is recoverable; a wrong attribution is believed.
--
-- Deliberately not touching rows that already name an order. Where a wrong order was written
-- it is indistinguishable here from a deliberate one, and this migration's evidence is no
-- better than what is already recorded. Re-entering the day through the screen corrects
-- those, which is now the documented repair.
UPDATE "hourly_outputs" AS h
SET "order_id" = p."order_id"
FROM "daily_line_plans" AS p
WHERE h."order_id" IS NULL
  AND p."line_id" = h."line_id"
  AND p."plan_date" = h."produced_on"
  AND p."company_id" = h."company_id";
