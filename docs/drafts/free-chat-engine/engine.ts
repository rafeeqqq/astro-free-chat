// Astrolokal AI free chat engine.
// Everything the web chat needs besides the LLM call itself: config loading + validation,
// arm assignment, prompt building, scripted lines, message routing, and the reply guard.
// The LLM is passed in as a function, so this file has no provider dependency.

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";

// ── Types ────────────────────────────────────────────────────────────────────

export type UserInput = {
  token: string;              // opaque per-user code from the WATI link (never a phone number)
  name: string;
  gender?: string;
  dob: string;                // YYYY-MM-DD
  tob?: string | null;        // HH:MM, null/"" if unknown
  pob?: string;
  language?: string;          // e.g. "Hinglish", "Hindi", "Telugu"
  moon_sign: string;          // computed by the wrapper
  mahadasha: string;
  antardasha: string;
  lagna?: string | null;
  last_topic?: string | null; // one of config.topics keys
  last_summary?: string | null;
  last_consult_date?: string | null; // YYYY-MM-DD
  consult_count?: number | null;
  windows?: Record<string, string>;  // computed windows per topic, e.g. { shaadi: "..." } (used by 'specific')
};

type Arm = { id: string; weight: number; [k: string]: unknown };
type Pattern = { reason: string; pattern: string };

export type Config = {
  experiment: { id: string; prompt_version: string; arms: Arm[] };
  timing: { free_seconds: number; closing_at_seconds_left: number; handoff_card_at_seconds_left: number; llm_timeout_ms: number };
  model: { name: string; temperature: number; max_output_tokens: number };
  persona: { name: string; header_label: string; voice: string; disclosure_line: string };
  style: { max_bubbles: number; max_words_per_bubble: number; question_budget: number; separator: string };
  insight_levels: Record<string, string>;
  scripted: {
    opening: string[]; topic_hook: Record<string, string>; closing: string[];
    fallback_reply: string; health_reply: string; crisis_reply: string[];
  };
  monthly_line: string;
  topics: Record<string, string[]>;
  guardrails: { banned: Pattern[]; crisis: string[]; injection: string[]; ai_question: string[] };
};

export type Loaded = { cfg: Config; template: string; configHash: string };

export type SessionState = {
  questionsAsked: number;
  currentTopic: string | null;
  crisis: boolean;
  closed: boolean;
  turns: number;
};

export type TurnLog = {
  session_token: string; experiment_id: string; arm: string; prompt_version: string; config_hash: string;
  model: string; turn: number; seconds_left: number; route: string; user_text: string;
  bubbles: string[]; flags: string[]; latency_ms: number | null; used_fallback: boolean; retried: boolean;
  show_handoff: boolean;
};

// ── Loading & validation ─────────────────────────────────────────────────────

const SCRIPT_VARS = ["name", "moon_sign", "mahadasha", "antardasha", "last_topic_label", "persona_name", "monthly_line"];
const INSIGHT_VARS = ["window_for_topic"];

export function load(configPath = "config.yaml", templatePath = "prompt_template.md"): Loaded {
  const raw = readFileSync(configPath, "utf8");
  const template = readFileSync(templatePath, "utf8");
  const cfg = parse(raw) as Config;
  const errors = validateConfig(cfg, template);
  if (errors.length) throw new Error("config.yaml has problems:\n  - " + errors.join("\n  - "));
  return { cfg, template, configHash: createHash("sha256").update(raw + template).digest("hex").slice(0, 12) };
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{([a-z_]+)\}/g)].map((m) => m[1]);
}

export function validateConfig(cfg: Config, template: string): string[] {
  const e: string[] = [];
  const need = (cond: unknown, msg: string) => { if (!cond) e.push(msg); };

  need(cfg?.experiment?.id, "experiment.id is missing");
  need(cfg?.experiment?.prompt_version, "experiment.prompt_version is missing");
  const arms = cfg?.experiment?.arms ?? [];
  need(arms.length > 0, "experiment.arms needs at least one arm");
  const total = arms.reduce((a, x) => a + (Number(x.weight) || 0), 0);
  need(total === 100, `arm weights add up to ${total}, must be 100`);
  need(new Set(arms.map((a) => a.id)).size === arms.length, "arm ids must be unique");
  const reasons = new Set((cfg?.guardrails?.banned ?? []).map((b) => b.reason));
  for (const a of arms) {
    for (const r of (a.allow as string[] | undefined) ?? []) need(reasons.has(r), `arm '${a.id}' allows unknown guard reason '${r}'`);
    const lvl = (a.insight_level as string) ?? "";
    need(cfg.insight_levels?.[lvl], `arm '${a.id}' uses insight_level '${lvl}' which is not defined in insight_levels`);
  }

  const t = cfg.timing ?? ({} as Config["timing"]);
  need(t.free_seconds > t.closing_at_seconds_left, "timing.free_seconds must be greater than closing_at_seconds_left");
  need(t.closing_at_seconds_left >= t.handoff_card_at_seconds_left, "closing lines should start at or before the hand-off card (closing_at >= handoff_card_at)");
  need(t.handoff_card_at_seconds_left >= 0, "timing.handoff_card_at_seconds_left must be >= 0");
  need(t.llm_timeout_ms >= 1000, "timing.llm_timeout_ms looks too low (< 1000)");

  const s = cfg.style ?? ({} as Config["style"]);
  need(s.max_bubbles >= 1 && s.max_bubbles <= 4, "style.max_bubbles should be 1–4");
  need(s.max_words_per_bubble >= 5 && s.max_words_per_bubble <= 25, "style.max_words_per_bubble should be 5–25");
  need(s.question_budget >= 0, "style.question_budget must be >= 0");
  need(s.separator && s.separator.trim().length > 0, "style.separator is empty");

  need(cfg.scripted?.topic_hook?.default, "scripted.topic_hook.default is required");
  const scripted: string[] = [
    ...(cfg.scripted?.opening ?? []), ...Object.values(cfg.scripted?.topic_hook ?? {}), ...(cfg.scripted?.closing ?? []),
    cfg.scripted?.fallback_reply ?? "", cfg.scripted?.health_reply ?? "", ...(cfg.scripted?.crisis_reply ?? []),
    cfg.persona?.disclosure_line ?? "", cfg.monthly_line ?? "",
  ];
  for (const line of scripted) for (const v of placeholders(line))
    need(SCRIPT_VARS.includes(v), `scripted line uses unknown {${v}}: "${line}"`);
  for (const [k, text] of Object.entries(cfg.insight_levels ?? {})) for (const v of placeholders(text))
    need(INSIGHT_VARS.includes(v), `insight_levels.${k} uses unknown {${v}}`);
  for (const v of placeholders(template))
    need(TEMPLATE_VARS.includes(v), `prompt_template.md uses unknown {${v}}`);

  // Scripted lines must pass our own guard, otherwise we would send what we forbid the AI to say.
  const g = cfg.guardrails;
  for (const p of [...(g?.banned ?? [])]) { try { new RegExp(p.pattern, "iu"); } catch { e.push(`bad regex (${p.reason}): ${p.pattern}`); } }
  for (const p of [...(g?.crisis ?? []), ...(g?.injection ?? []), ...(g?.ai_question ?? [])]) {
    try { new RegExp(p, "iu"); } catch { e.push(`bad regex: ${p}`); }
  }
  if (!e.length) {
    const guardable = [...(cfg.scripted.opening), ...Object.values(cfg.scripted.topic_hook), ...cfg.scripted.closing, cfg.scripted.fallback_reply];
    for (const line of guardable) {
      const hit = bannedHit(cfg, line);
      if (hit) e.push(`scripted line breaks guardrail '${hit}': "${line}"`);
    }
  }
  return e;
}

// ── Arm assignment (stable: same token → same arm, forever) ──────────────────

export function assignArm(cfg: Config, token: string): Arm {
  const h = createHash("sha256").update(`${cfg.experiment.id}:${token}`).digest();
  const bucket = h.readUInt32BE(0) % 100;
  let acc = 0;
  for (const a of cfg.experiment.arms) { acc += a.weight; if (bucket < acc) return a; }
  return cfg.experiment.arms[cfg.experiment.arms.length - 1];
}

// ── Context ──────────────────────────────────────────────────────────────────

export type Context = {
  user: UserInput; arm: Arm; insightLevel: string;
  vars: Record<string, string>;
};

const TOPIC_LABEL: Record<string, string> = {
  shaadi: "shaadi", naukri: "naukri / kaam", paisa: "paisa", parivaar: "parivaar", pyaar: "pyaar", sehat: "sehat",
};

function ageBand(dob: string, now: Date): string {
  const d = new Date(dob + "T00:00:00Z");
  if (isNaN(d.getTime())) return "unknown";
  const age = Math.floor((now.getTime() - d.getTime()) / (365.25 * 864e5));
  if (age < 18) return "under 18";
  if (age < 25) return "18–24"; if (age < 35) return "25–34"; if (age < 45) return "35–44"; if (age < 60) return "45–59";
  return "60+";
}

function daysSince(date: string | null | undefined, now: Date): number | null {
  if (!date) return null;
  const d = new Date(date + "T00:00:00Z");
  return isNaN(d.getTime()) ? null : Math.floor((now.getTime() - d.getTime()) / 864e5);
}

function lapsedBand(days: number | null): string {
  if (days === null) return "unknown";
  if (days < 14) return "under 2 weeks ago"; if (days < 30) return "2–4 weeks ago"; if (days < 60) return "1–2 months ago";
  return "over 2 months ago";
}

function countBand(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  if (n <= 1) return "1"; if (n <= 5) return "2–5"; return "6+";
}

function timeOfDayIST(now: Date): string {
  const h = (now.getUTCHours() + 5 + Math.floor((now.getUTCMinutes() + 30) / 60)) % 24;
  if (h < 5) return "raat (late night)"; if (h < 12) return "subah"; if (h < 17) return "dopahar"; if (h < 21) return "shaam";
  return "raat";
}

export function buildContext(cfg: Config, user: UserInput, now = new Date()): Context {
  const arm = assignArm(cfg, user.token);
  const insightLevel = String(arm.insight_level ?? Object.keys(cfg.insight_levels)[0]);
  const topic = user.last_topic && cfg.topics[user.last_topic] ? user.last_topic : null;
  const vars: Record<string, string> = {
    name: firstName(user.name),
    gender: user.gender || "unknown",
    age_band: ageBand(user.dob, now),
    language: user.language || "Hinglish",
    moon_sign: user.moon_sign,
    mahadasha: user.mahadasha,
    antardasha: user.antardasha,
    last_topic_label: topic ? TOPIC_LABEL[topic] ?? topic : "",
    persona_name: cfg.persona.name,
    monthly_line: cfg.monthly_line || "",
    lapsed_days_band: lapsedBand(daysSince(user.last_consult_date, now)),
    consult_count_band: countBand(user.consult_count),
    time_of_day: timeOfDayIST(now),
  };
  return { user, arm, insightLevel, vars };
}

function firstName(full: string): string {
  const n = (full || "").trim().split(/\s+/)[0] || "";
  return n ? n[0].toUpperCase() + n.slice(1) : "aap";
}

export function newSession(ctx: Context): SessionState {
  const t = ctx.user.last_topic;
  return { questionsAsked: 0, currentTopic: t ?? null, crisis: false, closed: false, turns: 0 };
}

// ── Rendering ────────────────────────────────────────────────────────────────

export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{([a-z_]+)\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`missing value for {${k}}`);
    return vars[k];
  });
}

const TEMPLATE_VARS = [
  "prompt_version", "arm_id", "persona_name", "persona_voice", "free_minutes", "insight_instructions",
  "name", "gender", "age_band", "language", "moon_sign", "mahadasha", "antardasha", "lagna_line",
  "current_topic_label", "last_summary_line", "lapsed_days_band", "consult_count_band", "time_of_day",
  "monthly_line_block", "max_bubbles", "max_words", "separator", "questions_left", "disclosure_line",
];

export function buildSystemPrompt(L: Loaded, ctx: Context, st: SessionState): string {
  const { cfg } = L;
  const topic = st.currentTopic;
  const insight = render(cfg.insight_levels[ctx.insightLevel], {
    window_for_topic: (topic && ctx.user.windows?.[topic]) || "",
  });
  const tobKnown = !!(ctx.user.tob && ctx.user.tob.trim());
  return render(L.template, {
    ...ctx.vars,
    prompt_version: cfg.experiment.prompt_version,
    arm_id: ctx.arm.id,
    persona_name: cfg.persona.name,
    persona_voice: render(cfg.persona.voice, ctx.vars),
    free_minutes: String(Math.round(cfg.timing.free_seconds / 60)),
    insight_instructions: insight,
    lagna_line: tobKnown && ctx.user.lagna
      ? `- Lagna: ${ctx.user.lagna}`
      : "- Birth time not known: do not mention lagna or specific houses.",
    current_topic_label: topic ? TOPIC_LABEL[topic] ?? topic : "not told yet",
    last_summary_line: ctx.user.last_summary?.trim() || "none",
    monthly_line_block: cfg.monthly_line ? `\n- This month: ${render(cfg.monthly_line, ctx.vars)}` : "",
    max_bubbles: String(cfg.style.max_bubbles),
    max_words: String(cfg.style.max_words_per_bubble),
    separator: cfg.style.separator,
    questions_left: String(Math.max(0, cfg.style.question_budget - st.questionsAsked)),
    disclosure_line: render(cfg.persona.disclosure_line, ctx.vars),
  });
}

export function openingBubbles(cfg: Config, ctx: Context): string[] {
  const hookKey = ctx.user.last_topic && cfg.scripted.topic_hook[ctx.user.last_topic] ? ctx.user.last_topic : "default";
  return [...cfg.scripted.opening, cfg.scripted.topic_hook[hookKey]].map((l) => render(l, ctx.vars));
}

export function closingBubbles(cfg: Config, ctx: Context): string[] {
  return cfg.scripted.closing.map((l) => render(l, ctx.vars));
}

// ── Routing a user message ───────────────────────────────────────────────────

export type Route =
  | { kind: "crisis"; bubbles: string[] }
  | { kind: "ai_question"; bubbles: string[] }
  | { kind: "health"; bubbles: string[] }
  | { kind: "closing"; bubbles: string[] }
  | { kind: "closed"; bubbles: string[] }
  | { kind: "llm"; systemPrompt: string; userText: string };

const rx = (p: string) => new RegExp(p, "iu");

export function detectTopic(cfg: Config, text: string): string | null {
  const t = text.toLowerCase();
  for (const [topic, words] of Object.entries(cfg.topics))
    if (words.some((w) => new RegExp(`\\b${w}\\b`, "iu").test(t))) return topic;
  return null;
}

export function route(L: Loaded, ctx: Context, st: SessionState, userText: string, secondsLeft: number): Route {
  const { cfg } = L;
  const text = (userText || "").slice(0, 500); // hard cap on what reaches the model
  if (st.closed) return { kind: "closed", bubbles: [] };
  if (cfg.guardrails.crisis.some((p) => rx(p).test(text))) {
    st.crisis = true; st.closed = true;
    return { kind: "crisis", bubbles: cfg.scripted.crisis_reply.map((l) => render(l, ctx.vars)) };
  }
  if (secondsLeft <= cfg.timing.closing_at_seconds_left) {
    st.closed = true;
    return { kind: "closing", bubbles: closingBubbles(cfg, ctx) };
  }
  if (cfg.guardrails.ai_question.some((p) => rx(p).test(text)))
    return { kind: "ai_question", bubbles: [render(cfg.persona.disclosure_line, ctx.vars)] };
  const topic = detectTopic(cfg, text);
  if (topic) st.currentTopic = topic;
  if (topic === "sehat") return { kind: "health", bubbles: [render(cfg.scripted.health_reply, ctx.vars)] };
  // Injection attempts still go to the model (the prompt tells it to ignore them); the reply guard is the backstop.
  return { kind: "llm", systemPrompt: buildSystemPrompt(L, ctx, st), userText: text };
}

// ── Reply guard ──────────────────────────────────────────────────────────────

const RASHIS: Record<string, string[]> = {
  mesh: ["mesh", "aries"], vrishabh: ["vrishabh", "vrish", "taurus"], mithun: ["mithun"], kark: ["kark", "cancer"],
  singh: ["simha", "leo"], kanya: ["kanya", "virgo"], tula: ["tula", "libra"], vrishchik: ["vrishchik", "scorpio"],
  dhanu: ["dhanu", "sagittarius"], makar: ["makar", "capricorn"], kumbh: ["kumbh", "aquarius"], meen: ["meen", "pisces"],
};
const PLANETS: Record<string, string[]> = {
  shani: ["shani", "saturn"], guru: ["guru", "brihaspati", "jupiter"], shukra: ["shukra", "venus"],
  mangal: ["mangal", "mars"], budh: ["budh", "mercury"], surya: ["surya", "sun"], chandra: ["chandra", "moon"],
  rahu: ["rahu"], ketu: ["ketu"],
};
const canon = (table: Record<string, string[]>, word: string) =>
  Object.keys(table).find((k) => table[k].includes(word.toLowerCase())) ?? null;

export function bannedHit(cfg: Config, bubble: string, allow: string[] = []): string | null {
  for (const b of cfg.guardrails.banned) if (!allow.includes(b.reason) && rx(b.pattern).test(bubble)) return b.reason;
  return null;
}

function chartFactHit(ctx: Context, bubble: string): string | null {
  const lower = bubble.toLowerCase();
  const userRashi = canon(RASHIS, ctx.user.moon_sign) ?? ctx.user.moon_sign.toLowerCase();
  for (const [k, names] of Object.entries(RASHIS))
    if (k !== userRashi && names.some((n) => new RegExp(`\\b${n}\\b`, "iu").test(lower)) && /rashi|sign/.test(lower))
      return "wrong_rashi";
  const allowed = [canon(PLANETS, ctx.user.mahadasha), canon(PLANETS, ctx.user.antardasha)];
  for (const m of lower.matchAll(/\b([a-z]+) ki (maha|antar)?dasha\b/g)) {
    const p = canon(PLANETS, m[1]);
    if (p && !allowed.includes(p)) return "wrong_dasha";
  }
  return null;
}

export type Guarded = { bubbles: string[]; flags: string[]; questions: number };

export function guardReply(L: Loaded, ctx: Context, st: SessionState, raw: string): Guarded {
  const { cfg } = L;
  const flags: string[] = [];
  const parts = String(raw ?? "")
    .split(cfg.style.separator).flatMap((p) => p.split(/\n+/))
    .map((p) => p.replace(/^[\s"'*\-•]+|[\s"'*]+$/g, "").replace(/\s+/g, " "))
    .filter((p) => p.length > 0);

  const kept: string[] = [];
  let questions = 0;
  for (const p of parts) {
    const ban = bannedHit(cfg, p, (ctx.arm.allow as string[] | undefined) ?? []);
    if (ban) { flags.push(`dropped:${ban}`); continue; }
    const fact = chartFactHit(ctx, p);
    if (fact) { flags.push(`dropped:${fact}`); continue; }
    const words = p.split(" ").length;
    if (words > Math.ceil(cfg.style.max_words_per_bubble * 1.5)) { flags.push("dropped:too_long"); continue; }
    if (words > cfg.style.max_words_per_bubble) flags.push("long_bubble");
    const isQuestion = /\?\s*$/.test(p);
    if (isQuestion && st.questionsAsked + questions >= cfg.style.question_budget) { flags.push("dropped:question_over_budget"); continue; }
    if (isQuestion) questions++;
    kept.push(p);
    if (kept.length === cfg.style.max_bubbles) { if (parts.length > kept.length) flags.push("trimmed_extra_bubbles"); break; }
  }
  return { bubbles: kept, flags, questions };
}

// ── One full AI turn: timeout, guard, one retry, fallback ────────────────────

export type LLMFn = (args: { system: string; user: string; model: Config["model"] }) => Promise<string>;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); });
  try { return await Promise.race([p, timeout]); } finally { clearTimeout(t); }
}

export async function runTurn(
  L: Loaded, ctx: Context, st: SessionState, userText: string, secondsLeft: number, llm: LLMFn,
): Promise<{ bubbles: string[]; showHandoff: boolean; log: TurnLog }> {
  const { cfg } = L;
  st.turns++;
  const started = Date.now();
  const r = route(L, ctx, st, userText, secondsLeft);
  const log: TurnLog = {
    session_token: ctx.user.token, experiment_id: cfg.experiment.id, arm: ctx.arm.id,
    prompt_version: cfg.experiment.prompt_version, config_hash: L.configHash, model: cfg.model.name,
    turn: st.turns, seconds_left: secondsLeft, route: r.kind, user_text: userText.slice(0, 500),
    bubbles: [], flags: [], latency_ms: null, used_fallback: false, retried: false,
    show_handoff: false,
  };

  let bubbles: string[];
  if (r.kind !== "llm") {
    bubbles = r.bubbles;
  } else {
    const fallback = [render(cfg.scripted.fallback_reply, ctx.vars)];
    try {
      const raw = await withTimeout(llm({ system: r.systemPrompt, user: r.userText, model: cfg.model }), cfg.timing.llm_timeout_ms);
      let g = guardReply(L, ctx, st, raw);
      log.flags.push(...g.flags);
      if (g.bubbles.length === 0) {
        log.retried = true;
        const reasons = [...new Set(g.flags.map((f) => f.replace("dropped:", "")))].join(", ");
        const retrySystem = r.systemPrompt + `\n\nYour last reply broke the rules (${reasons}). Reply again, shorter, following every rule.`;
        const raw2 = await withTimeout(llm({ system: retrySystem, user: r.userText, model: cfg.model }), cfg.timing.llm_timeout_ms);
        g = guardReply(L, ctx, st, raw2);
        log.flags.push(...g.flags.map((f) => `retry_${f}`));
      }
      if (g.bubbles.length === 0) { bubbles = fallback; log.used_fallback = true; }
      else { bubbles = g.bubbles; st.questionsAsked += g.questions; }
    } catch (err) {
      bubbles = fallback; log.used_fallback = true;
      log.flags.push((err as Error).message === "timeout" ? "llm_timeout" : "llm_error");
    }
  }

  log.latency_ms = Date.now() - started;
  log.bubbles = bubbles;
  // Never show the sales card to someone in distress.
  log.show_handoff = !st.crisis && secondsLeft <= cfg.timing.handoff_card_at_seconds_left;
  return { bubbles, showHandoff: log.show_handoff, log };
}

// ── CLI: `node engine.ts check` · `node engine.ts preview [users.yaml]` ─────

if (import.meta.filename === process.argv[1] || import.meta.filename === (process.argv[1] ?? "") + ".ts") {
  const cmd = process.argv[2] ?? "check";
  try {
    const L = load();
    if (cmd === "check") {
      console.log(`config OK · ${L.cfg.experiment.id} · ${L.cfg.experiment.prompt_version} · hash ${L.configHash}`);
      console.log(`arms: ${L.cfg.experiment.arms.map((a) => `${a.id} ${a.weight}%`).join(", ")}`);
    } else if (cmd === "preview") {
      const users = parse(readFileSync(process.argv[3] ?? "samples/users.yaml", "utf8")) as UserInput[];
      for (const u of users) {
        const ctx = buildContext(L.cfg, u);
        const st = newSession(ctx);
        console.log(`\n══ ${u.name} · token ${u.token} · arm ${ctx.arm.id} ══`);
        console.log("OPENING  →", openingBubbles(L.cfg, ctx).join("  |  "));
        console.log("CLOSING  →", closingBubbles(L.cfg, ctx).join("  |  "));
        if (process.argv.includes("--prompt")) console.log("\n" + buildSystemPrompt(L, ctx, st));
      }
    } else {
      console.log("usage: node engine.ts check | preview [users.yaml] [--prompt]");
    }
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
