import { test } from "node:test";
import assert from "node:assert/strict";
import { load } from "../src/engine/engine.ts";
import type { TurnLog } from "../src/engine/engine.ts";
import { analyse, toCsv } from "../src/lib/analytics.ts";
import type { Session, EventRow } from "../src/lib/store.ts";

const L = load();
const at = (min: number) => new Date(Date.UTC(2026, 8, 30, 6, min)).toISOString();

function session(token: string, userTexts: string[], opts: Partial<Session> = {}): Session {
  return {
    token, started_at: at(0), clock_started_at: at(0), arm: "pilot", cohort: "lapsed", prompt_version: "v1", config_hash: "x",
    state: { questionsAsked: 0, currentTopic: null, crisis: false, closed: false, turns: 0 },
    messages: userTexts.flatMap((text) => [{ role: "user" as const, text, at: at(1) }, { role: "ai" as const, text: "ok", at: at(1) }]),
    handoff_shown_at: null, cta_tapped_at: null, ...opts,
  };
}

const sessions: Session[] = [
  session("real_a", []),                                                        // opened, never typed
  session("real_b", ["shaadi kab hogi"]),                                       // spoke, left early
  session("real_c", ["naukri kab", "job change?", "ok"], { handoff_shown_at: at(2) }), // engaged, saw offer
  session("real_d", ["shaadi?", "rishta kab", "love"], { handoff_shown_at: at(2), cta_tapped_at: at(2), cohort: "zero_balance" }),
  session("t_team_x", ["test"], { cta_tapped_at: at(2) }),                      // team test: excluded by default
];
const events: EventRow[] = [
  { token: "real_d", name: "cta_tapped", props: { from: "strip", seconds_left: 8 }, at: at(2) },
  { token: "real_b", name: "page_hidden", props: { seconds_left: 70 }, at: at(1) },
  { token: "real_b", name: "back_to_app", props: { seconds_left: 70 }, at: at(1) },
  { token: "real_c", name: "cta_tapped", props: { from: "back", seconds_left: 30 }, at: at(1) }, // old builds: back arrow logged as a tap
  { token: "t_team_x", name: "cta_tapped", props: { from: "sheet" }, at: at(2) },
];
const turns = [
  { session_token: "real_c", route: "quiet", flags: [], used_fallback: false, latency_ms: 1000 },
  { session_token: "real_c", route: "llm", flags: [], used_fallback: true, latency_ms: 2000 },
] as unknown as TurnLog[];

test("funnel: opened → spoke → stayed → tapped; real users only; each step within the one before", () => {
  const r = analyse(L.cfg, sessions, turns, events);
  assert.deepEqual(r.funnel, { opened: 4, spoke: 3, stayed: 2, tapped: 1 });
  assert.equal(analyse(L.cfg, sessions, turns, events, { includeTests: true }).funnel.tapped, 2);
  assert.deepEqual(analyse(L.cfg, sessions, turns, events, { cohort: "zero_balance" }).funnel, { opened: 1, spoke: 1, stayed: 1, tapped: 1 });
  const f = r.funnel;
  assert.ok(f.opened >= f.spoke && f.spoke >= f.stayed && f.stayed >= f.tapped);
});

test("the back arrow is not a tap (old or new logging)", () => {
  const r = analyse(L.cfg, sessions, turns, events);
  const c = r.chats.find((x) => x.token === "real_c")!;
  assert.equal(c.tapped, false);
  assert.equal(c.back_arrow, true);
  assert.equal(r.health.backArrow, 2);
});

test("topics come from what the user typed; health numbers", () => {
  const r = analyse(L.cfg, sessions, turns, events);
  assert.deepEqual(r.topics.find((t) => t.topic === "shaadi"), { topic: "shaadi", chats: 2, tapped: 1 });
  assert.deepEqual(r.topics.find((t) => t.topic === "none"), { topic: "none", chats: 1, tapped: 0 });
  assert.equal(r.health.avgMessages, 1.8);
  assert.equal(r.health.silenceShare, 0.25);
  assert.equal(r.health.fallbackShare, 0.5);
  assert.equal(r.health.avgReplySec, 1.5);
  assert.equal(r.chats.find((x) => x.token === "real_b")!.left_at_seconds, 70);
});

test("CSV export: one row per chat, with a header", () => {
  const csv = toCsv(analyse(L.cfg, sessions, turns, events).chats).trim().split("\n");
  assert.equal(csv.length, 5);
  assert.match(csv[0], /^token,cohort,version,opened_at,user_messages,topic,spoke,stayed,tapped,tapped_on/);
  assert.ok(csv.some((l) => l.startsWith("real_d,zero_balance") && l.includes(",true,true,true,claim,")));
});
