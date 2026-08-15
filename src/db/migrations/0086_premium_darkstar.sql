ALTER TABLE "supplier_quote_lines" ALTER COLUMN "moq" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ALTER COLUMN "moq" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ALTER COLUMN "freight" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ALTER COLUMN "freight" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ALTER COLUMN "duty_pct" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "supplier_quote_lines" ALTER COLUMN "duty_pct" DROP NOT NULL;