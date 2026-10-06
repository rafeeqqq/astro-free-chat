import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/engine/engine.ts";
import type { UserInput } from "../src/engine/engine.ts";
import type { Store } from "../src/lib/store.ts";
import { lookupUser, resetLookupCache } from "../src/lib/lookup.ts";
import { linkToken, istDay } from "../src/lib/sync.ts";

const L = load();
const secret = "s".repeat(20);
const rows = [
  { rc_bucket: "RC1", user_id: 501, DOB: "2002-11-05", TOB: "03:10:00", POB: "Guntur, Andhra Pradesh, India" },
  { rc_bucket: "RC2", user_id: 502, DOB: "1978-11-21", TOB: null, POB: "Patna, Bihar, India" },
  { rc_bucket: "RC2", user_id: 502, DOB: "2015-01-01", TOB: null, POB: "Patna, Bihar, India" }, // a second profile
];
let calls = 0;
const fakeFetch = (async () => {
  calls++;
  await new Promise((r) => setTimeout(r, 20));
  return new Response(JSON.stringify({ query_result: { retrieved_at: new Date().toISOString(), data: { rows } } }));
}) as typeof fetch;
function memStore() {
  const users = new Map<string, UserInput>();
  return { users, store: { upsertUsers: async (us: UserInput[]) => { for (const u of us) users.set(u.token, u); } } as unknown as Store };
}
const env = { redashUrl: "https://r.test", apiKey: "k", secret, fetchFn: fakeFetch };

beforeEach(() => { resetLookupCache(); calls = 0; });

test("a clicked user_id in the query gets a chat built on the spot, with the same token the daily sync would make", async () => {
  const { users, store } = memStore();
  const token = await lookupUser(L, store, "501", env);
  assert.equal(token, linkToken(secret, "501", istDay()));
  const u = users.get(token!)!;
  assert.deepEqual([u.moon_sign, u.lagna, u.cohort], ["Tula", "Kanya", "rc1"]);
  assert.equal(await lookupUser(L, store, "999", env), null, "not in the query → no chat");
});

test("several profiles → the most complete one; no birth time → Moon chart", async () => {
  const { users, store } = memStore();
  const token = await lookupUser(L, store, "502", env);
  assert.equal(users.get(token!)!.dob, "1978-11-21");
  assert.equal(users.get(token!)!.lagna, null);
});

test("clicks share one Redash call (cached, and concurrent clicks wait for the same request)", async () => {
  const { store } = memStore();
  await Promise.all(["501", "502", "999", "501"].map((id) => lookupUser(L, store, id, env)));
  await lookupUser(L, store, "502", env);
  assert.equal(calls, 1);
});

test("switched off, or no Redash key → no lookup", async () => {
  const { store } = memStore();
  assert.equal(await lookupUser(L, store, "501", { ...env, apiKey: "" }), null);
  const off = { ...L, cfg: { ...L.cfg, source: { ...L.cfg.source!, on_click: { enabled: false } } } };
  assert.equal(await lookupUser(off, store, "501", env), null);
  assert.equal(calls, 0);
});

test("the list is due at 08:30 IST: before that, yesterday's 08:30 counts", async () => {
  const { lastListReadyAt } = await import("../src/lib/lookup.ts");
  const ist = (d: string) => Date.parse(`${d}+05:30`);
  assert.equal(lastListReadyAt("08:30", ist("2026-10-06T09:00:00")), ist("2026-10-06T08:30:00"));
  assert.equal(lastListReadyAt("08:30", ist("2026-10-06T07:00:00")), ist("2026-10-05T08:30:00"));
});

test("yesterday's stored result + a user added today: the query is re-run and the user gets their chat", async () => {
  const ist = (d: string) => Date.parse(`${d}+05:30`);
  const now = ist("2026-10-06T15:17:00");
  const yesterday = [{ rc_bucket: "RC1", user_id: 601, DOB: "2002-11-05", TOB: "03:10:00", POB: "Guntur, Andhra Pradesh, India" }];
  const today = [...yesterday, { rc_bucket: "RC2", user_id: 602, DOB: "1990-06-10", TOB: "05:30:00", POB: "Kanpur, Uttar Pradesh, India" }];
  const seen: string[] = [];
  const redash = (async (url: string, init?: RequestInit) => {
    seen.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    if (init?.method === "POST") return new Response(JSON.stringify({ query_result: { data: { rows: today } } })); // the re-run
    return new Response(JSON.stringify({ query_result: { retrieved_at: new Date(ist("2026-10-05T13:43:00")).toISOString(), data: { rows: yesterday } } }));
  }) as typeof fetch;
  const { store, users } = memStore();
  const e = { ...env, fetchFn: redash, now };
  const token = await lookupUser(L, store, "602", e);
  assert.ok(token, "found after the re-run");
  assert.equal(users.get(token!)!.cohort, "rc2");
  assert.deepEqual(seen, ["GET /api/queries/20605/results.json", "POST /api/queries/20605/results"], "one stored read, one re-run");
  assert.ok(await lookupUser(L, store, "601", e));
  assert.equal(seen.length, 2, "later clicks use the fresh result");
});

test("a fresh result (after today's 08:30) is never re-run; a missing user just gets the friendly page", async () => {
  const ist = (d: string) => Date.parse(`${d}+05:30`);
  const seen: string[] = [];
  const redash = (async (url: string, init?: RequestInit) => {
    seen.push(init?.method ?? "GET");
    return new Response(JSON.stringify({ query_result: { retrieved_at: new Date(ist("2026-10-06T08:45:00")).toISOString(), data: { rows } } }));
  }) as typeof fetch;
  const { store } = memStore();
  assert.equal(await lookupUser(L, store, "999", { ...env, fetchFn: redash, now: ist("2026-10-06T15:00:00") }), null);
  assert.deepEqual(seen, ["GET"]);
});
