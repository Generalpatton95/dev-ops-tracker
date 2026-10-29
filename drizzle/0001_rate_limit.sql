CREATE TABLE "rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	CONSTRAINT "rate_limit_key_is_hmac" CHECK ("rate_limit"."key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "rate_limit_count_positive" CHECK ("rate_limit"."count" >= 1)
);
--> statement-breakpoint
CREATE INDEX "rate_limit_window_start_idx" ON "rate_limit" USING btree ("window_start");