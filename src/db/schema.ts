// The database schema: the single source of truth for migrations.
// Change a table here → `npm run db:generate` writes a new SQL migration in drizzle/ → commit it → it runs once on deploy.
// Never edit an applied migration; add a new one.
import { pgTable, text, jsonb, timestamp, bigserial, index } from "drizzle-orm/pg-core";

/** One row per user link: their details and chart (the user_id itself is never stored). */
export const fcUsers = pgTable("fc_users", {
  token: text("token").primaryKey(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
});

/** One row per chat: messages, state and the hand-off timestamps. */
export const fcSessions = pgTable("fc_sessions", {
  token: text("token").primaryKey(),
  data: jsonb("data").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("fc_sessions_started_at").on(t.startedAt)]);

/** One row per AI reply: route, guard flags, latency (for quality analysis). */
export const fcTurns = pgTable("fc_turns", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  token: text("token").notNull(),
  data: jsonb("data").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("fc_turns_token").on(t.token)]);

/** Page events (opened, card shown, CTA tapped, left…). */
export const fcEvents = pgTable("fc_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  token: text("token").notNull(),
  name: text("name").notNull(),
  props: jsonb("props").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow(),
}, (t) => [index("fc_events_token").on(t.token)]);
