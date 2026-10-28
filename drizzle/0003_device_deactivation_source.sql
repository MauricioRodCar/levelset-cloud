CREATE TYPE "public"."deactivation_source" AS ENUM('device', 'customer', 'support', 'rotation');--> statement-breakpoint
ALTER TABLE "activations" ADD COLUMN "deactivated_by" "deactivation_source";