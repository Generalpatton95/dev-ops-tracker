CREATE TYPE "public"."environment" AS ENUM('preview', 'production');--> statement-breakpoint
CREATE TYPE "public"."role" AS ENUM('owner', 'member', 'guest');--> statement-breakpoint
CREATE TYPE "public"."spec_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."task_link_kind" AS ENUM('branch', 'commit', 'pr', 'check', 'deploy');--> statement-breakpoint
CREATE TYPE "public"."task_size" AS ENUM('s', 'm', 'l');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('todo', 'doing', 'review', 'done');--> statement-breakpoint
CREATE TABLE "account" (
	"user_id" uuid NOT NULL,
	"type" text NOT NULL,
	"provider" text NOT NULL,
	"provider_account_id" text NOT NULL,
	"refresh_token" text,
	"access_token" text,
	"expires_at" integer,
	"token_type" text,
	"scope" text,
	"id_token" text,
	"session_state" text,
	CONSTRAINT "account_pkey" PRIMARY KEY("provider","provider_account_id"),
	CONSTRAINT "account_no_tokens" CHECK (num_nonnulls("account"."refresh_token", "account"."access_token", "account"."expires_at", "account"."token_type", "account"."scope", "account"."id_token", "account"."session_state") = 0)
);
--> statement-breakpoint
CREATE TABLE "activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"change" jsonb NOT NULL,
	"actor" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cycle" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"starts_on" date NOT NULL,
	"ends_on" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cycle_dates" CHECK ("cycle"."ends_on" >= "cycle"."starts_on")
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"user_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"role" "role" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_pkey" PRIMARY KEY("user_id","workspace_id")
);
--> statement-breakpoint
CREATE TABLE "project" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"repo" text,
	"next_task_number" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "project_workspace_id_key_unique" UNIQUE("workspace_id","key"),
	CONSTRAINT "project_key_format" CHECK ("project"."key" ~ '^[A-Z]{2,5}$'),
	CONSTRAINT "project_next_task_number_positive" CHECK ("project"."next_task_number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "requirement_version" (
	"requirement_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"rule" text NOT NULL,
	"acceptance" text[] DEFAULT '{}'::text[] NOT NULL,
	"changed_by" uuid,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_version_pkey" PRIMARY KEY("requirement_id","version")
);
--> statement-breakpoint
CREATE TABLE "requirement" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"spec_id" uuid NOT NULL,
	"ref" text NOT NULL,
	"rule" text NOT NULL,
	"acceptance" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_spec_id_ref_unique" UNIQUE("spec_id","ref"),
	CONSTRAINT "requirement_acceptance_is_array" CHECK (jsonb_typeof("requirement"."acceptance") = 'array')
);
--> statement-breakpoint
CREATE TABLE "session" (
	"session_token" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "spec" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"status" "spec_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_link" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"kind" "task_link_kind" NOT NULL,
	"url" text NOT NULL,
	"state" text,
	"environment" "environment",
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_link_task_id_kind_url_unique" UNIQUE("task_id","kind","url"),
	CONSTRAINT "task_link_environment_only_for_deploy" CHECK ("task_link"."environment" is null or "task_link"."kind" = 'deploy')
);
--> statement-breakpoint
CREATE TABLE "task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"requirement_id" uuid,
	"built_on_version" integer,
	"title" text NOT NULL,
	"status" "task_status" DEFAULT 'todo' NOT NULL,
	"assignee_id" uuid,
	"size" "task_size",
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"cycle_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_project_id_number_unique" UNIQUE("project_id","number"),
	CONSTRAINT "task_number_positive" CHECK ("task"."number" >= 1)
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"github_id" bigint NOT NULL,
	"avatar_url" text,
	"email" text,
	"email_verified" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_github_id_unique" UNIQUE("github_id"),
	CONSTRAINT "user_no_email" CHECK ("user"."email" is null and "user"."email_verified" is null)
);
--> statement-breakpoint
CREATE TABLE "verification_token" (
	"identifier" text NOT NULL,
	"token" text NOT NULL,
	"expires" timestamp with time zone NOT NULL,
	CONSTRAINT "verification_token_pkey" PRIMARY KEY("identifier","token")
);
--> statement-breakpoint
CREATE TABLE "workspace" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"invite_token" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity" ADD CONSTRAINT "activity_actor_user_id_fk" FOREIGN KEY ("actor") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cycle" ADD CONSTRAINT "cycle_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_id_workspace_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspace"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_version" ADD CONSTRAINT "requirement_version_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement_version" ADD CONSTRAINT "requirement_version_changed_by_user_id_fk" FOREIGN KEY ("changed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirement" ADD CONSTRAINT "requirement_spec_id_spec_id_fk" FOREIGN KEY ("spec_id") REFERENCES "public"."spec"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "spec" ADD CONSTRAINT "spec_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_link" ADD CONSTRAINT "task_link_task_id_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_requirement_id_requirement_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."requirement"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_assignee_id_user_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task" ADD CONSTRAINT "task_cycle_id_cycle_id_fk" FOREIGN KEY ("cycle_id") REFERENCES "public"."cycle"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "account_user_id_idx" ON "account" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_entity_entity_id_idx" ON "activity" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "activity" USING btree ("actor");--> statement-breakpoint
CREATE INDEX "cycle_project_id_idx" ON "cycle" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "membership_workspace_id_idx" ON "membership" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "requirement_version_changed_by_idx" ON "requirement_version" USING btree ("changed_by");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "spec_project_id_idx" ON "spec" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "task_project_id_status_idx" ON "task" USING btree ("project_id","status");--> statement-breakpoint
CREATE INDEX "task_assignee_id_idx" ON "task" USING btree ("assignee_id");--> statement-breakpoint
CREATE INDEX "task_requirement_id_idx" ON "task" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "task_cycle_id_idx" ON "task" USING btree ("cycle_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_invite_token_unique" ON "workspace" USING btree ("invite_token") WHERE "workspace"."invite_token" is not null;