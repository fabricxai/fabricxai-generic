ALTER TYPE "public"."pending_status" ADD VALUE 'drafted' BEFORE 'pending';--> statement-breakpoint
ALTER TABLE "pending_changes" ADD COLUMN "draft_corrections" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "pending_changes" ADD COLUMN "submitted_at" timestamp with time zone;