ALTER TABLE "ud_consumptions" ADD COLUMN "reversed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ud_consumptions" ADD COLUMN "reversed_reason" text;