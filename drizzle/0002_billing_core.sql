CREATE TABLE "reconciliation_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" "payment_provider" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone NOT NULL,
	"report" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "licenses" ALTER COLUMN "key_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "licenses" ALTER COLUMN "key_hint" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "subscription_transitions" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX "reconciliation_runs_started_idx" ON "reconciliation_runs" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "subscription_transitions_sub_seq_idx" ON "subscription_transitions" USING btree ("subscription_id","seq");