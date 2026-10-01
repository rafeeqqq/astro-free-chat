CREATE TABLE "fc_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"name" text NOT NULL,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fc_sessions" (
	"token" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fc_turns" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "fc_users" (
	"token" text PRIMARY KEY NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "fc_events_token" ON "fc_events" USING btree ("token");--> statement-breakpoint
CREATE INDEX "fc_sessions_started_at" ON "fc_sessions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "fc_turns_token" ON "fc_turns" USING btree ("token");