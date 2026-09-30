// Run with `npm test`. Every edit to config.yaml or prompt_template.md should keep this green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  load, validateConfig, assignArm, buildContext, newSession, buildSystemPrompt,
  openingBubbles, route, guardReply, runTurn, type UserInput, type Config, type LLMFn,
} from "./engine.ts";

const L = load();
const users = parse(readFileSync("samples/users.yaml", "utf8")) as UserInput[];
const [rafeeq, sunita] = users;
const fresh = (u: UserInput) => { const ctx = buildContext(L.cfg, u); return { ctx, st: newSession(ctx) }; };
const clone = (): Config => structuredClone(L.cfg);

// ── Config ──
test("config is valid", () => assert.deepEqual(validateConfig(L.cfg, L.template), []));

test("config catches broken edits", () => {
  const c = clone(); c.experiment.arms[0].weight = 80;
  assert.match(validateConfig(c, L.template).join(), /add up to 80, must be 100/);
  const d = clone(); d.scripted.closing[0] = "{nam} ji, aur baatein";
  assert.match(validateConfig(d, L.template).join(), /unknown \{nam\}/);
  const f = clone(); f.scripted.closing.push("Recharge karke baat karein");
  assert.match(validateConfig(f, L.template).join(), /breaks guardrail 'money'/);
  const g = clone(); g.timing.handoff_card_at_seconds_left = 30;
  assert.match(validateConfig(g, L.template).join(), /closing_at >= handoff_card_at/);
});

// ── Arms ──
test("pilot: everyone gets the same arm", () => {
  for (let i = 0; i < 1000; i++) assert.equal(assignArm(L.cfg, `u${i}`).id, "pilot");
});

const twoArms = (): Config => {
  const c = clone();
  c.experiment.arms = [
    { id: "minimal", weight: 50, insight_level: "minimal", allow: [] },
    { id: "specific", weight: 50, insight_level: "specific", allow: ["date_or_year", "relative_time"] },
  ];
  return c;
};

test("if parallel arms are ever used: stable and close to the weights", () => {
  const c = twoArms();
  assert.deepEqual(validateConfig(c, L.template), []);
  assert.equal(assignArm(c, "abc").id, assignArm(c, "abc").id);
  let minimal = 0;
  for (let i = 0; i < 10000; i++) if (assignArm(c, `u${i}`).id === "minimal") minimal++;
  assert.ok(minimal > 4700 && minimal < 5300, `minimal got ${minimal}/10000`);
});

// ── Opening & prompt ──
test("opening uses last topic, falls back to a question", () => {
  assert.match(openingBubbles(L.cfg, fresh(rafeeq).ctx)[2], /shaadi/);
  assert.match(openingBubbles(L.cfg, fresh(sunita).ctx)[2], /\?/);
  assert.match(openingBubbles(L.cfg, fresh(sunita).ctx)[0], /Sunita ji/); // lower-case name capitalised
});

test("prompt handles unknown birth time and has no unfilled placeholders", () => {
  const { ctx, st } = fresh(sunita);
  const p = buildSystemPrompt(L, ctx, st);
  assert.match(p, /Birth time not known/);
  assert.doesNotMatch(p, /\{[a-z_]+\}/);
  assert.match(p, new RegExp(L.cfg.experiment.prompt_version));
});

// ── Routing ──
test("crisis → helpline, closes chat, no sales card", async () => {
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "ab jeene ka mann nahi karta", 5, async () => "should not be called");
  assert.match(out.bubbles.join(" "), /14416/);
  assert.equal(out.showHandoff, false);
  assert.equal(st.closed, true);
});

test("'are you AI' → exact disclosure line, no model call", async () => {
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "aap AI ho kya?", 90, async () => { throw new Error("no"); });
  assert.equal(out.bubbles[0], L.cfg.persona.disclosure_line);
});

test("health question → doctor line", () => {
  const { ctx, st } = fresh(rafeeq);
  assert.equal(route(L, ctx, st, "mera operation kab hoga", 90).kind, "health");
});

test("last seconds → scripted closing, then chat is closed", () => {
  const { ctx, st } = fresh(rafeeq);
  assert.equal(route(L, ctx, st, "aur batao", 12).kind, "closing");
  assert.equal(route(L, ctx, st, "hello?", 8).kind, "closed");
});

test("topic switches mid-chat", () => {
  const { ctx, st } = fresh(sunita);
  route(L, ctx, st, "beta ki naukri kab lagegi", 90);
  assert.equal(st.currentTopic, "naukri");
});

// ── Reply guard ──
const g = (raw: string, u = rafeeq) => { const { ctx, st } = fresh(u); return guardReply(L, ctx, st, raw); };

test("clean reply passes", () => {
  const r = g("Shaadi ka yog aapki kundli mein achha hai || Par ek graha ka prabhav hai, dhyaan se dekhna hoga");
  assert.equal(r.bubbles.length, 2); assert.deepEqual(r.flags, []);
});

test("guard drops what the AI must never say", () => {
  const cases: [string, string][] = [
    ["Shaadi 2027 mein hogi", "date_or_year"],
    ["Pukhraj pehniye, sab theek hoga", "remedy"],
    ["Agle saal shaadi ke yog hain", "relative_time"],
    ["Recharge karke pandit ji se baat karein", "money"],
    ["Main ek AI hoon", "ai_mention"],
    ["Aap par kisi ki nazar hai", "fear"],
    ["Shaadi pakka hogi", "guarantee"],
    ["Main aapki celestial blueprint dekh raha hoon", "filler"],
    ["Aapki rashi Meen hai", "wrong_rashi"],
    ["Abhi Rahu ki mahadasha chal rahi hai", "wrong_dasha"],
  ];
  for (const [text, reason] of cases) {
    const r = g(text);
    assert.equal(r.bubbles.length, 0, `should drop: ${text}`);
    assert.ok(r.flags.includes(`dropped:${reason}`), `${text} → ${r.flags}`);
  }
});

test("an arm's allow list is narrow: specific may give a time window, never a remedy", () => {
  const LL = { ...L, cfg: twoArms() };
  const pick = (id: string) => { for (let i = 0; ; i++) if (assignArm(LL.cfg, `x${i}`).id === id) return { ...rafeeq, token: `x${i}` }; };
  const guard = (raw: string, u: UserInput) => { const ctx = buildContext(LL.cfg, u); return guardReply(LL, ctx, newSession(ctx), raw); };
  const line = "Shaadi ka yog 2027 ki pehli chhamahi mein hai";
  assert.equal(guard(line, pick("specific")).bubbles.length, 1);
  assert.equal(guard(line, pick("minimal")).bubbles.length, 0);
  assert.equal(guard("Pukhraj pehniye", pick("specific")).bubbles.length, 0);
});

test("guard does not over-block normal Hinglish", () => {
  for (const ok of ["Kya hai aapka sawal", "Shani ki dasha dhyaan dene layak hai", "Aapki Chandra rashi Tula hai", "Paisa aane ke sanket hain"])
    assert.equal(g(ok).bubbles.length, 1, ok);
});

test("guard enforces bubble count and question budget", () => {
  const r = g("Ek || Do || Teen");
  assert.equal(r.bubbles.length, 2); assert.ok(r.flags.includes("trimmed_extra_bubbles"));
  const q = g("Aap kya jaanna chahte hain? || Shaadi ya naukri?");
  assert.equal(q.questions, 1); assert.ok(q.flags.includes("dropped:question_over_budget"));
});

// ── Full turn ──
const slow: LLMFn = () => new Promise((r) => { setTimeout(() => r("late"), 10_000).unref(); });

test("timeout → fallback line", async () => {
  const c = clone(); c.timing.llm_timeout_ms = 50;
  const LL = { ...L, cfg: c };
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(LL, ctx, st, "shaadi kab hogi", 90, slow);
  assert.equal(out.bubbles[0], L.cfg.scripted.fallback_reply);
  assert.ok(out.log.flags.includes("llm_timeout"));
});

test("bad reply → one retry → good reply is used", async () => {
  let calls = 0;
  const llm: LLMFn = async () => (++calls === 1 ? "Shaadi 2027 mein pakka hogi" : "Shaadi ka yog achha hai || Ek graha ka prabhav hai");
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "shaadi kab hogi", 90, llm);
  assert.equal(calls, 2); assert.equal(out.log.retried, true); assert.equal(out.bubbles.length, 2);
});

test("model error → fallback, and the log has everything the analysis needs", async () => {
  const { ctx, st } = fresh(rafeeq);
  const out = await runTurn(L, ctx, st, "shaadi kab hogi", 90, async () => { throw new Error("500"); });
  assert.equal(out.log.used_fallback, true);
  for (const k of ["arm", "prompt_version", "config_hash", "route", "flags", "latency_ms", "show_handoff"])
    assert.ok(k in out.log, k);
});
