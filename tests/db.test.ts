// Database tests against a real Postgres engine (PGlite, in-process) over the normal Postgres protocol:
// the migrations apply once, a second run is a no-op, the schema matches src/db/schema.ts, and the app's store works on it.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const run = promisify(execFile);
let pg: PGlite, server: PGLiteSocketServer, url: string;

before(async () => {
  pg = await PGlite.create();
  const port = 15000 + Math.floor(Math.random() * 20000);
  server = new PGLiteSocketServer({ db: pg, port, maxConnections: 4 });
  await server.start();
  url = `postgres://postgres@127.0.0.1:${port}/postgres`;
});
after(async () => { await server.stop(); await pg.close(); });

const migrate = () => run("node", ["scripts/migrate.ts"], { env: { ...process.env, DATABASE_URL: url, DB_POOL_MAX: "1" } });

test("the health check fails before migrations, the migration runs once, a second run does nothing", async () => {
  const { createSql } = await import("../src/db/client.ts");
  const sql = createSql(url, { max: 1 });
  await assert.rejects(sql`select 1 from fc_users limit 1`, "no tables before the migration");
  assert.match((await migrate()).stdout, /migrations: 1 applied, 1 total/);
  assert.match((await migrate()).stdout, /migrations: 0 applied, 1 total/, "already applied → skipped");
  const tables = (await sql`select table_name from information_schema.tables where table_schema = 'public' order by 1`).map((r) => r.table_name);
  assert.deepEqual(tables, ["fc_events", "fc_sessions", "fc_turns", "fc_users"]);
  const idx = (await sql`select indexname from pg_indexes where schemaname = 'public' and indexname like 'fc_%' and indexname not like '%_pkey' order by 1`).map((r) => r.indexname);
  assert.deepEqual(idx, ["fc_events_token", "fc_sessions_started_at", "fc_turns_token"]);
  await sql.end();
});

test("the app's store works on the migrated database (users, chats with locking, logs, events)", async () => {
  process.env.DATABASE_URL = url;
  process.env.DB_POOL_MAX = "1";
  const { getStore } = await import("../src/lib/store.ts");
  const store = getStore();
  await store.ping();
  const user = { token: "tok_db_1", name: "Rohan", dob: "2002-11-05", moon_sign: "Tula", mahadasha: "Shani", antardasha: "Ketu" };
  await store.upsertUsers([user]);
  assert.equal((await store.getUser("tok_db_1"))?.name, "Rohan");
  const out = await store.withSession<number>("tok_db_1", async (s) => {
    assert.equal(s, null);
    return {
      session: { token: "tok_db_1", started_at: new Date().toISOString(), clock_started_at: null, arm: "pilot", prompt_version: "v", config_hash: "h",
        state: { questionsAsked: 0, currentTopic: null, crisis: false, closed: false, turns: 0 }, messages: [], handoff_shown_at: null, cta_tapped_at: null },
      result: 7,
    };
  });
  assert.equal(out, 7);
  assert.equal((await store.getSession("tok_db_1"))?.arm, "pilot");
  await store.addEvent({ token: "tok_db_1", name: "link_opened", props: { a: 1 }, at: new Date().toISOString() });
  assert.equal((await store.events(10))[0].name, "link_opened");
  assert.equal((await store.recentSessions(10)).length, 1);
  // A whole day's list goes in batches (and re-saving it is harmless)
  const many = Array.from({ length: 1200 }, (_, i) => ({ ...user, token: `bulk_${i}`, name: `U${i}` }));
  await store.upsertUsers(many);
  await store.upsertUsers(many);
  assert.equal((await store.getUser("bulk_1199"))?.name, "U1199");
  const { createSql } = await import("../src/db/client.ts");
  const sql = createSql(url, { max: 1 });
  const [{ n }] = await sql`select count(*)::int as n from fc_users where token like 'bulk_%'`;
  assert.equal(n, 1200);
  await sql.end();
});

test("every schema change has a migration (schema.ts and drizzle/ agree)", async () => {
  const dir = `.drizzle-check-${process.pid}`; // drizzle-kit wants a folder inside the project
  try {
    cpSync("drizzle", dir, { recursive: true });
    const { stdout } = await run("npx", ["drizzle-kit", "generate", "--dialect", "postgresql", "--schema", "./src/db/schema.ts", "--out", dir]);
    assert.match(stdout, /No schema changes/, "schema.ts changed without a migration: run `npm run db:generate` and commit it");
    assert.equal(readdirSync(dir).filter((f) => f.endsWith(".sql")).length, readdirSync("drizzle").filter((f) => f.endsWith(".sql")).length);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
