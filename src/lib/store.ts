// Storage for pilot users, chat sessions, turn logs and funnel events.
// - DATABASE_URL set  → Postgres (production). Tables are created on first use.
// - otherwise         → a JSON file in ./data (local development only).
// Only what the chat needs is stored: no phone numbers.

import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createSql } from "../db/client.ts";
import type { UserInput, SessionState, TurnLog } from "../engine/engine.ts";

// user/ai = the conversation · details = the auto-sent birth details · kundli = the chart card · system = centred notes ("has joined")
export type StoredMessage = { role: "user" | "ai" | "kundli" | "details" | "system"; text: string; at: string };

export type Session = {
  token: string;
  started_at: string;          // when the link was first opened
  clock_started_at: string | null; // the user's first message: the free time is measured from here
  arm: string;
  cohort?: string;
  prompt_version: string;
  config_hash: string;
  state: SessionState;
  messages: StoredMessage[];
  handoff_shown_at: string | null;
  cta_tapped_at: string | null;
};

/** Internal test links. Only these can be reset from the admin page, never a real pilot user. */
export const isTestToken = (token: string) => /^t_(team|demo)_[\w-]+$/.test(token);

export type EventRow = { token: string; name: string; props: Record<string, unknown>; at: string };

export interface Store {
  /** The database answers and its schema is migrated (health check). */
  ping(): Promise<void>;
  getUser(token: string): Promise<UserInput | null>;
  upsertUsers(users: UserInput[]): Promise<void>;
  /** Internal test users only (tokens starting with t_team_ or t_demo_), for the admin page. */
  testUsers(): Promise<UserInput[]>;
  /** Deletes chats for these tokens (local demos: lets a sample link start fresh). */
  resetSessions(tokens: string[]): Promise<void>;
  getSession(token: string): Promise<Session | null>;
  /** Runs fn with exclusive access to one token's session (no double-sends racing each other). */
  withSession<T>(token: string, fn: (s: Session | null) => Promise<{ session: Session | null; result: T }>): Promise<T>;
  addTurnLog(log: TurnLog): Promise<void>;
  addEvent(e: EventRow): Promise<void>;
  recentSessions(limit: number): Promise<Session[]>;
  turnLogs(token: string): Promise<TurnLog[]>;
  recentTurnLogs(limit: number): Promise<TurnLog[]>;
  events(limit: number): Promise<EventRow[]>;
}

// ── Local JSON file (development) ────────────────────────────────────────────

type FileData = { users: Record<string, UserInput>; sessions: Record<string, Session>; turns: TurnLog[]; events: EventRow[] };

class FileStore implements Store {
  async ping() {}
  private path: string;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(dir = process.env.DATA_DIR || join(process.cwd(), "data")) {
    mkdirSync(dir, { recursive: true });
    this.path = join(dir, "dev-store.json");
  }
  private read(): FileData {
    if (!existsSync(this.path)) return { users: {}, sessions: {}, turns: [], events: [] };
    return JSON.parse(readFileSync(this.path, "utf8")) as FileData;
  }
  private write(d: FileData) {
    writeFileSync(this.path + ".tmp", JSON.stringify(d, null, 1));
    renameSync(this.path + ".tmp", this.path);
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async getUser(token: string) { return this.read().users[token] ?? null; }
  upsertUsers(users: UserInput[]) {
    return this.serial(async () => { const d = this.read(); for (const u of users) d.users[u.token] = u; this.write(d); });
  }
  async testUsers() {
    return Object.values(this.read().users).filter((u) => isTestToken(u.token)).sort((a, b) => a.token.localeCompare(b.token));
  }
  resetSessions(tokens: string[]) {
    return this.serial(async () => {
      const d = this.read();
      for (const t of tokens) delete d.sessions[t];
      d.turns = d.turns.filter((x) => !tokens.includes(x.session_token));
      d.events = d.events.filter((x) => !tokens.includes(x.token));
      this.write(d);
    });
  }
  async getSession(token: string) { return this.read().sessions[token] ?? null; }
  withSession<T>(token: string, fn: (s: Session | null) => Promise<{ session: Session | null; result: T }>) {
    return this.serial(async () => {
      const { session, result } = await fn(this.read().sessions[token] ?? null);
      if (session) { const d = this.read(); d.sessions[token] = session; this.write(d); }
      return result;
    });
  }
  addTurnLog(log: TurnLog) { return this.serial(async () => { const d = this.read(); d.turns.push(log); this.write(d); }); }
  addEvent(e: EventRow) { return this.serial(async () => { const d = this.read(); d.events.push(e); this.write(d); }); }
  async recentSessions(limit: number) {
    return Object.values(this.read().sessions).sort((a, b) => b.started_at.localeCompare(a.started_at)).slice(0, limit);
  }
  async turnLogs(token: string) { return this.read().turns.filter((t) => t.session_token === token); }
  async recentTurnLogs(limit: number) { return this.read().turns.slice(-limit); }
  async events(limit: number) { return this.read().events.slice(-limit); }
}

// ── Postgres (production) ────────────────────────────────────────────────────

// Tables come from migrations (drizzle/, applied by `npm run db:migrate` before deploy); the app never changes the schema.
class PgStore implements Store {
  private sql: postgres.Sql;

  constructor(url: string) {
    this.sql = createSql(url);
  }
  /** For the health check: the database answers and the schema is migrated. */
  async ping() {
    await this.sql`select 1 from fc_users limit 1`;
  }
  async getUser(token: string) {
    const rows = await this.sql`select data from fc_users where token = ${token}`;
    return (rows[0]?.data as UserInput) ?? null;
  }
  async upsertUsers(users: UserInput[]) {
    for (const u of users)
      await this.sql`insert into fc_users (token, data) values (${u.token}, ${this.sql.json(u as unknown as postgres.JSONValue)})
        on conflict (token) do update set data = excluded.data`;
  }
  async testUsers() {
    const rows = await this.sql`select data from fc_users where token like 't\_team\_%' or token like 't\_demo\_%' order by token`;
    return rows.map((r) => r.data as UserInput);
  }
  async resetSessions(tokens: string[]) {
    await this.sql`delete from fc_sessions where token = any(${tokens})`;
    await this.sql`delete from fc_turns where token = any(${tokens})`;
    await this.sql`delete from fc_events where token = any(${tokens})`;
  }
  async getSession(token: string) {
    const rows = await this.sql`select data from fc_sessions where token = ${token}`;
    return (rows[0]?.data as Session) ?? null;
  }
  async withSession<T>(token: string, fn: (s: Session | null) => Promise<{ session: Session | null; result: T }>) {
    return this.sql.begin(async (tx) => {
      // Advisory lock per token: serialises concurrent requests for the same chat, even before the row exists.
      await tx`select pg_advisory_xact_lock(hashtext(${token}))`;
      const rows = await tx`select data from fc_sessions where token = ${token}`;
      const { session, result } = await fn((rows[0]?.data as Session) ?? null);
      if (session)
        await tx`insert into fc_sessions (token, data, started_at) values (${token}, ${tx.json(session as unknown as postgres.JSONValue)}, ${session.started_at})
          on conflict (token) do update set data = excluded.data, updated_at = now()`;
      return result;
    }) as Promise<T>;
  }
  async addTurnLog(log: TurnLog) {
    await this.sql`insert into fc_turns (token, data) values (${log.session_token}, ${this.sql.json(log as unknown as postgres.JSONValue)})`;
  }
  async addEvent(e: EventRow) {
    await this.sql`insert into fc_events (token, name, props, created_at) values (${e.token}, ${e.name}, ${this.sql.json(e.props as postgres.JSONValue)}, ${e.at})`;
  }
  async recentSessions(limit: number) {
    const rows = await this.sql`select data from fc_sessions order by started_at desc limit ${limit}`;
    return rows.map((r) => r.data as Session);
  }
  async turnLogs(token: string) {
    const rows = await this.sql`select data from fc_turns where token = ${token} order by id`;
    return rows.map((r) => r.data as TurnLog);
  }
  async recentTurnLogs(limit: number) {
    const rows = await this.sql`select data from fc_turns order by id desc limit ${limit}`;
    return rows.map((r) => r.data as TurnLog);
  }
  async events(limit: number) {
    const rows = await this.sql`select token, name, props, created_at from fc_events order by id desc limit ${limit}`;
    return rows.map((r) => ({ token: r.token, name: r.name, props: r.props, at: new Date(r.created_at).toISOString() }) as EventRow);
  }
}

let store: Store | null = null;
export function getStore(): Store {
  if (store) return store;
  if (process.env.DATABASE_URL) store = new PgStore(process.env.DATABASE_URL);
  else if (process.env.VERCEL || process.env.REQUIRE_DATABASE === "1")
    throw new Error("DATABASE_URL is not set. The local file store only works on a laptop."); // containers set REQUIRE_DATABASE=1
  else store = new FileStore();
  return store;
}
