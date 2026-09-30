// Run with `npm test` from the project root. Every edit to config.yaml or prompt_template.md should keep this green.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import {
  load, validateConfig, assignArm, buildContext, newSession, buildSystemPrompt,
  openingBubbles, closingBubbles, chartLine, route, guardReply, runTurn, uiText, handoffUrl, cardText, bubblesFor, forCohort, cohortOf,
} from "../src/engine/engine.ts";
import type { UserInput, Config, LLMFn } from "../src/engine/engine.ts";

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
  assert.match(openingBubbles(L.cfg, fresh(rafeeq).ctx)[2], /Shaadi/);
  assert.match(openingBubbles(L.cfg, fresh(sunita).ctx)[2], /\?/);
  assert.match(openingBubbles(L.cfg, fresh(sunita).ctx)[0], /Sunita ji/); // lower-case name capitalised
  assert.equal(openingBubbles(L.cfg, fresh(sunita).ctx).length, 3);
});

test("prompt handles unknown birth time and has no unfilled placeholders", () => {
  const { ctx, st } = fresh(sunita);
  const p = buildSystemPrompt(L, ctx, st);
  assert.match(p, /Lagna: unknown\. Don't mention lagna/);
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
  const r = g("Shaadi ka yog achha hai || Par ek graha ka prabhav hai");
  assert.equal(r.bubbles.length, 2); assert.deepEqual(r.flags, []);
});

test("guard lets Omkar echo the user's past, and joins a bubble cut mid-sentence", () => {
  assert.deepEqual(g("Itni mehnat, 2 saal se lage hain.").bubbles, ["Itni mehnat, 2 saal se lage hain."]);
  assert.deepEqual(g("Aap mehnati hain, par||Shani rok raha hai.").bubbles, ["Aap mehnati hain, par Shani rok raha hai."]);
  assert.equal(g("Yog tay hai.").bubbles.length, 0);
  for (const ok of ["Shani ki mahadasha chal rahi hai.", "Ketu ka antardasha hai.", "Shani dasha mein sabr chahiye.", "Rashi Tula, dasha Shani ki."])
    assert.equal(g(ok).bubbles.length, 1, `their own dasha is fine: ${ok}`);
});

test("guard drops what the AI must never say", () => {
  const cases: [string, string][] = [
    ["Shaadi 2027 mein hogi", "date_or_year"],
    ["Pukhraj pehniye, sab theek hoga", "remedy"],
    ["Agle saal shaadi ke yog hain", "relative_time"],
    ["2 mahine mein naukri lagegi", "relative_time"],
    ["Recharge karke pandit ji se baat karein", "money"],
    ["Main ek AI hoon", "ai_mention"],
    ["Aap par kisi ki nazar hai", "fear"],
    ["Shaadi pakka hogi", "guarantee"],
    ["Shaadi pakki hogi", "guarantee"],
    ["Main aapki celestial blueprint dekh raha hoon", "filler"],
    ["Aapki rashi Meen hai", "wrong_rashi"],
    ["Abhi Rahu ki mahadasha chal rahi hai", "wrong_dasha"],
    ["Surya dasha se naye avsar milenge", "wrong_dasha"],
    ["Rahu ka antardasha chal raha hai", "wrong_dasha"],
    ["Ketu ki mahadasha hai", "wrong_dasha"],
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
  const r = g("Ek || Do || Teen || Char");
  assert.equal(r.bubbles.length, 3); assert.ok(r.flags.includes("trimmed_extra_bubbles"));
  const { ctx, st } = fresh(rafeeq);
  assert.equal(guardReply(L, ctx, st, "Ek || Do || Teen", 1).bubbles.length, 1, "per-turn limit (first answer)");
  const LL = { ...L, cfg: clone() }; LL.cfg.style.question_budget = 1;
  const c = buildContext(LL.cfg, rafeeq);
  const q = guardReply(LL, c, newSession(c), "Aap kya jaanna chahte hain? || Shaadi ya naukri?");
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

// ── Screen copy, hand-off link, closing ──
test("ui copy renders for every sample user (no unfilled placeholders)", () => {
  for (const u of users) {
    const ui = uiText(L.cfg, fresh(u).ctx);
    for (const [k, v] of Object.entries(ui)) assert.doesNotMatch(v, /\{[a-z_]+\}/, `${u.name}: ui.${k}`);
  }
  assert.match(uiText(L.cfg, fresh(sunita).ctx).details_message, /Birth time not known/);
  assert.match(uiText(L.cfg, fresh(rafeeq).ctx).details_message, /5 Nov 2002/);
});

test("hand-off link carries token + version, never personal data", () => {
  const url = handoffUrl(L, rafeeq.token);
  assert.match(url, /^https:\/\//);
  assert.match(url, /utm_term=t_demo_shaadi_01/);
  assert.doesNotMatch(url, /Rohan|2002|Guntur/);
});


test("model gets recent history plus the new message", async () => {
  let seen = 0;
  const llm: LLMFn = async ({ messages }) => { seen = messages.length; return "Achha sanket hai"; };
  const { ctx, st } = fresh(rafeeq);
  const history = Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? "ai" : "user") as "ai" | "user", text: `m${i}` }));
  await runTurn(L, ctx, st, "shaadi kab hogi", 90, llm, history);
  assert.equal(seen, 9);
});

// ── Persona photo ──
test("persona.avatar_url: accepts a public file, an https link or nothing; rejects anything else", () => {
  for (const ok of ["", "/persona/omkar.jpg", "https://cdn.astrolokal.com/omkar.webp"]) {
    const c = clone(); c.persona.avatar_url = ok;
    assert.deepEqual(validateConfig(c, L.template), [], ok);
  }
  for (const bad of ["omkar.jpg", "http://insecure.com/a.jpg", "/persona/omkar.gif", "javascript:alert(1)"]) {
    const c = clone(); c.persona.avatar_url = bad;
    assert.match(validateConfig(c, L.template).join(), /avatar_url/, bad);
  }
});

test("persona.avatar_url pointing to a missing file fails the config check", async () => {
  const { mkdtempSync, mkdirSync, cpSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "fc-cfg-"));
  try {
    mkdirSync(join(root, "config"));
    cpSync("config/prompt_template.md", join(root, "config", "prompt_template.md"));
    const yaml = readFileSync("config/config.yaml", "utf8").replace('avatar_url: "/persona/omkar.jpg"', 'avatar_url: "/persona/nobody.jpg"');
    writeFileSync(join(root, "config", "config.yaml"), yaml);
    assert.throws(() => load(join(root, "config")), /public\/persona\/nobody\.jpg does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Gemini message shape ──
test("messages sent to Gemini start with the user and alternate turns", async () => {
  const { toGeminiMessages } = await import("../src/lib/llm.ts");
  const out = toGeminiMessages([
    { role: "ai", text: "Namaste" }, { role: "ai", text: "Tula rashi" },
    { role: "user", text: "shaadi?" }, { role: "user", text: "kab?" }, { role: "ai", text: "Yog hai" },
  ]);
  assert.deepEqual(out.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(out[1].content, "Namaste\nTula rashi");
  assert.equal(out[2].content, "shaadi?\nkab?");
});

test("model settings are validated", () => {
  const c = clone(); c.model.name = "gpt-4o";
  assert.match(validateConfig(c, L.template).join(), /Gemini model id/);
  const d = clone(); d.model.thinking = "max";
  assert.match(validateConfig(d, L.template).join(), /model.thinking/);
});

test("Omkar never repeats a line he already said (case and punctuation ignored)", () => {
  const { ctx, st } = fresh(rafeeq);
  const r = guardReply(L, ctx, st, "Prem vivah ke yog hain || Shani ka asar hai", 3, ["prem vivah ke yog hain."]);
  assert.deepEqual(r.bubbles, ["Shani ka asar hai"]);
  assert.ok(r.flags.includes("dropped:repeat"));
});

test("each reply has a job: answer the first question, then engage, then one open thread", () => {
  const { ctx, st } = fresh(rafeeq);
  assert.match(buildSystemPrompt(L, ctx, st, 2, 110), /first question\. ANSWER it/);
  const shown = { ...st, chartShown: true, answered: true };
  assert.match(buildSystemPrompt(L, ctx, shown, 3, 90), /Keep them talking[\s\S]*ONE short, personal question/);
  assert.match(buildSystemPrompt(L, ctx, { ...shown, lastAsked: true }, 3, 90), /No question this time/, "never two questions in a row");
  assert.match(buildSystemPrompt(L, ctx, { ...shown, questionsAsked: L.cfg.style.question_budget }, 3, 90), /No question this time/);
  assert.match(buildSystemPrompt(L, ctx, shown, 3, 30), /ONE open thread/);
  assert.match(buildSystemPrompt(L, ctx, st, 2, 90, true), /gone quiet[\s\S]*Start the reading yourself/);
  assert.match(buildSystemPrompt(L, ctx, { ...shown, answered: false }, 3, 90), /first question\. ANSWER it/,
    "if Omkar opened the chart himself, their first question still gets the real answer");
});

test("2–3 bubbles like a person: short first answer, full early replies, then it varies", () => {
  const st = { ...fresh(rafeeq).st };
  assert.equal(bubblesFor(L, st, "t"), L.cfg.style.first_answer_bubbles);
  const counts: number[] = [];
  for (let turns = 1; turns <= 12; turns++) counts.push(bubblesFor(L, { ...st, chartShown: true, turns }, "t_x"));
  assert.deepEqual(counts.slice(0, L.cfg.style.early_replies), Array(L.cfg.style.early_replies).fill(L.cfg.style.max_bubbles));
  const later = counts.slice(L.cfg.style.early_replies);
  assert.ok(later.every((n) => L.cfg.style.later_bubbles.includes(n)));
  assert.ok(new Set(later).size > 1, "later replies vary");
});

test("the AI never points away from the chat (pandit ji, next time)", () => {
  assert.equal(g("Shaadi ka faisla pandit ji batayenge.").bubbles.length, 0);
  assert.equal(g("Baaki baad mein bataunga.").bubbles.length, 0);
});

test("the hand-off card uses the generic hook; per-topic hooks stay optional", () => {
  assert.match(cardText(L.cfg, fresh(rafeeq).ctx, "shaadi"), /Rohan ji, aapki kundli ki sabse zaroori baat abhi batani baaki hai/);
  const t = clone(); t.card_text_by_topic = { shaadi: "{name} ji, shaadi" };
  assert.equal(cardText(t, fresh(rafeeq).ctx, "shaadi"), "Rohan ji, shaadi");
  const c = clone(); c.card_text_by_topic = { cricket: "x" };
  assert.match(validateConfig(c, L.template).join(), /not a topic/);
});

test("message pacing is validated", () => {
  const a = clone(); a.pacing.typing_min_ms = 2000; a.pacing.typing_max_ms = 1000;
  assert.match(validateConfig(a, L.template).join(), /typing_min_ms must not exceed/);
  const b = clone(); b.pacing.system_note_ms = -5;
  assert.match(validateConfig(b, L.template).join(), /pacing.system_note_ms must be 0–5000/);
});

test("cohorts: each changes only what's different; the CTA link follows the wallet balance", () => {
  const low = forCohort(L, "low_balance");
  assert.notEqual(low.cfg.ui.card_offer, L.cfg.ui.card_offer);
  assert.equal(low.cfg.ui.cta_label, L.cfg.ui.cta_label, "untouched keys come from the main config");
  assert.equal(forCohort(L, "lapsed"), L, "an empty cohort is the main config");
  assert.equal(cohortOf(L.cfg, { cohort: "nonsense" }), L.cfg.default_cohort);
  const c = clone(); c.handoff.deeplink_with_balance = "https://x.test/chat"; c.handoff.deeplink_no_balance = "https://x.test/recharge";
  const LL = { ...L, cfg: c };
  assert.match(handoffUrl(LL, "tok", { wallet_balance: 50, cohort: "low_balance" }), /^https:\/\/x\.test\/chat\?.*cohort=low_balance.*bal=yes/);
  assert.match(handoffUrl(LL, "tok", { wallet_balance: 0 }), /^https:\/\/x\.test\/recharge\?.*cohort=lapsed.*bal=no/);
});

test("a broken cohort stops the config from loading", () => {
  const dir = mkdtempSync(join(tmpdir(), "fc-cfg-"));
  try {
    mkdirSync(join(dir, "config"));
    cpSync("public", join(dir, "public"), { recursive: true });
    writeFileSync(join(dir, "config", "prompt_template.md"), L.template);
    const yaml = readFileSync("config/config.yaml", "utf8").replace("  lapsed: {}", "  lapsed: { experiment: { id: x } }");
    writeFileSync(join(dir, "config", "config.yaml"), yaml);
    assert.throws(() => load(join(dir, "config")), /cohorts\.lapsed cannot change "experiment"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("missing data is skipped cleanly: no name, no gender, uncertain rashi/dasha", () => {
  const u = { ...rafeeq, name: "", gender: null, tob: null, moon_certain: false, dasha_certain: false };
  const { ctx, st } = fresh(u);
  assert.equal(openingBubbles(L.cfg, ctx)[0], "Namaste ji 🙏");
  assert.equal(closingBubbles(L.cfg, ctx)[0], "Ek aur zaroori baat dikh rahi hai…");
  const ui = uiText(L.cfg, ctx);
  assert.equal(ui.kundli_caption, "Your Kundli");
  assert.doesNotMatch(ui.details_message, /·\s*·|^\s*·|·\s*$/m, "no empty separators on the details card");
  assert.equal(cardText(L.cfg, ctx, null), "Aapki kundli ki sabse zaroori baat abhi batani baaki hai 👀");
  assert.equal(chartLine(L.cfg, ctx), "", "rashi not certain → no chart line");
  const p = buildSystemPrompt(L, ctx, st);
  assert.match(p, /Their name isn't known/);
  assert.match(p, /Rashi: not certain/);
  assert.match(p, /Dasha: not certain/);
  assert.doesNotMatch(p, /Name: /);
  assert.doesNotMatch(p, /\{[a-z_]+\}/);
  assert.equal(g("Tula rashi mein prem yog hai.", u).bubbles.length, 0, "any rashi claim is dropped when it isn't certain");
  const rashiOnly = fresh({ ...rafeeq, tob: null, dasha_certain: false }).ctx;
  assert.equal(chartLine(L.cfg, rashiOnly), "Rashi Tula hai aapki.");
});

test("one question per reply at most", () => {
  const r = g("Aapko kya lagta hai?||Kahan rukawat lagti hai?||Shani ka asar hai.");
  assert.deepEqual(r.bubbles, ["Aapko kya lagta hai?", "Shani ka asar hai."]);
  assert.ok(r.flags.includes("dropped:second_question"));
});
