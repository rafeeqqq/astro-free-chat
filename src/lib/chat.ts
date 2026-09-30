// Chat service: everything the API routes do, in one place.
//
// The clock: by default the free time starts when the chat page opens (timing.clock_starts: open), which gives
// the AT-style urgency; "first_message" starts it at the first question instead. The server owns the clock;
// the browser only displays it.
// Omkar replies to every message, and when the user goes quiet (timing.idle_nudge_seconds) he carries on by himself,
// until the closing line at closing_at_seconds_left. Nothing is ever sent after the chat has ended.

import {
  load, buildContext, newSession, openingBubbles, chartIntro, chartLine, runTurn, runNudge, bubblesFor, forCohort, cohortOf, uiText, cardText, handoffUrl, fallbackUrl, MAX_USER_CHARS,
} from "../engine/engine.ts";
import type { Loaded, Context, ChatMessage, TurnLog } from "../engine/engine.ts";
import { statSync } from "node:fs";
import { join } from "node:path";
import { getStore } from "./store.ts";
import type { Session, StoredMessage } from "./store.ts";
import { callModel } from "./llm.ts";
import { buildKundli } from "./kundli.ts";
import type { KundliView } from "./kundli.ts";

export const MAX_USER_MESSAGES = 15;
const DUPLICATE_WINDOW_MS = 5000; // same text again within this window = a double tap or a retry, not a new question
export const EVENT_NAMES = ["link_opened", "handoff_card_shown", "cta_tapped", "ended_screen_viewed", "page_hidden", "back_to_app"] as const;
export type EventName = (typeof EVENT_NAMES)[number];

const isDev = () => process.env.NODE_ENV !== "production";

// Config is re-read whenever config.yaml or prompt_template.md changes on disk, so edits apply to the next
// message without a restart. A broken edit is refused (the last good config keeps running, and the error is logged).
// On Vercel the files only change with a deploy.
let cached: { L: Loaded; stamp: string } | null = null;
function configStamp(): string {
  const dir = join(process.cwd(), "config");
  return ["config.yaml", "prompt_template.md"].map((f) => { try { return statSync(join(dir, f)).mtimeMs; } catch { return 0; } }).join(":");
}
export function config(): Loaded {
  if (isDev()) {
    const L = load();
    // Local testing only: DEV_FREE_SECONDS=30 shortens the chat so the hand-off can be tried quickly.
    const dev = Number(process.env.DEV_FREE_SECONDS);
    if (dev > L.cfg.timing.closing_at_seconds_left) L.cfg.timing.free_seconds = dev;
    return L;
  }
  const stamp = configStamp();
  if (!cached || cached.stamp !== stamp) {
    try {
      cached = { L: load(), stamp };
    } catch (err) {
      if (!cached) throw err;
      console.error(`config edit refused, still running ${cached.L.cfg.experiment.prompt_version}:`, (err as Error).message);
      cached = { ...cached, stamp }; // don't re-read the broken file on every request; the next save is tried again
    }
  }
  return cached.L;
}

export type View = {
  status: "invalid" | "active" | "ended";
  justStarted: boolean;        // true only on the very first open: the page animates the opening once
  clockStarted: boolean;       // with clock_starts: first_message, false until the first question
  ui: Record<string, string>;
  persona: { name: string; label: string; avatar: string; verified: boolean };
  messages: StoredMessage[];
  secondsLeft: number;
  freeSeconds: number;
  idleNudgeSeconds: number;    // 0 = Omkar never speaks first
  closingAt: number;
  handoffAt: number;
  ctaCountdown: number;        // seconds the button counts down once the card appears
  handoffUrl: string;
  fallbackUrl: string;         // app link didn't open (app not installed) → this, e.g. the Play Store
  closed: boolean;
  crisis: boolean;
  chart: { moonSign: string; mahadasha: string; antardasha: string; kundli: KundliView | null } | null;
  pacing: Loaded["cfg"]["pacing"];
  canRestart: boolean;         // local development only
  promptVersion: string;
};

export type OutMessage = Pick<StoredMessage, "role" | "text">;
export type SendResult = { ok: true; messages: OutMessage[]; view: View } | { ok: false; error: string; view: View };

const now = () => new Date().toISOString();
const TOKEN_RX = /^[A-Za-z0-9_-]{6,64}$/;

function secondsLeft(L: Loaded, s: Session): number {
  if (!s.clock_started_at) return L.cfg.timing.free_seconds;
  const elapsed = (Date.now() - new Date(s.clock_started_at).getTime()) / 1000;
  return Math.max(0, Math.ceil(L.cfg.timing.free_seconds - elapsed));
}

function view(L: Loaded, ctx: Context | null, s: Session | null, token: string, justStarted = false): View {
  const base = {
    persona: {
      name: L.cfg.persona.name, label: L.cfg.persona.header_label, avatar: L.cfg.persona.avatar_url ?? "",
      verified: L.cfg.persona.verified_badge === true,
    },
    freeSeconds: L.cfg.timing.free_seconds,
    idleNudgeSeconds: L.cfg.timing.idle_nudge_seconds,
    closingAt: L.cfg.timing.closing_at_seconds_left,
    handoffAt: L.cfg.timing.handoff_card_at_seconds_left,
    ctaCountdown: L.cfg.timing.cta_countdown_seconds ?? 5,
    handoffUrl: handoffUrl(L, token, ctx?.user),
    fallbackUrl: fallbackUrl(L),
    promptVersion: L.cfg.experiment.prompt_version,
    pacing: L.cfg.pacing,
    canRestart: isDev(),
  };
  if (!ctx || !s) {
    const strip = (t: string) => t.replace(/\{[a-z_]+\}\s*/g, "").trim();
    return {
      ...base, status: "invalid", justStarted: false, clockStarted: false, messages: [], secondsLeft: 0,
      closed: true, crisis: false, chart: null,
      ui: { invalid_title: strip(L.cfg.ui.invalid_title), invalid_text: strip(L.cfg.ui.invalid_text), cta_label: strip(L.cfg.ui.cta_label) },
    };
  }
  const left = secondsLeft(L, s);
  return {
    ...base,
    status: left > 0 && !s.state.crisis ? "active" : "ended",
    justStarted,
    clockStarted: !!s.clock_started_at,
    ui: { ...uiText(L.cfg, ctx), card_text: cardText(L.cfg, ctx, s.state.currentTopic ?? ctx.user.last_topic ?? null) },
    messages: s.messages,
    secondsLeft: left,
    closed: s.state.closed || left <= 0,
    crisis: s.state.crisis,
    chart: {
      moonSign: ctx.user.moon_sign,
      mahadasha: ctx.user.dasha_certain === false ? "" : ctx.user.mahadasha,
      antardasha: ctx.user.dasha_certain === false ? "" : ctx.user.antardasha,
      kundli: buildKundli({
        lagna: ctx.user.lagna, tobKnown: !!ctx.user.tob?.trim(), moonSign: ctx.user.moon_sign, planets: ctx.user.planets,
      }),
    },
  };
}

/** The user and the config as their cohort sees it (cohorts override parts of config.yaml). */
async function userConfig(token: string): Promise<{ L: Loaded; ctx: Context | null }> {
  const base = config();
  if (!TOKEN_RX.test(token)) return { L: base, ctx: null };
  const user = await getStore().getUser(token);
  if (!user) return { L: base, ctx: null };
  const L = forCohort(base, cohortOf(base.cfg, user));
  return { L, ctx: buildContext(L.cfg, user) };
}

/**
 * Opens the chat. The first visit writes the opening, like an astrologer joining:
 * the user's details → "Connecting you to Astro Omkar…" → "Astro Omkar has joined" → a short greeting that asks
 * their question. The kundli comes later, with the first answer. Later visits simply resume.
 * `restart` (local development only) wipes the chat so it can be tried again.
 */
export async function startOrResume(token: string, restart = false): Promise<View> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return view(L, null, null, token);
  const store = getStore();
  if (restart && isDev()) await store.resetSessions([token]);

  let created = false;
  const session = await store.withSession<Session>(token, async (existing) => {
    if (existing) return { session: null, result: existing };
    created = true;
    const ui = uiText(L.cfg, ctx);
    const at = now();
    const s: Session = {
      token, started_at: at, clock_started_at: L.cfg.timing.clock_starts === "open" ? at : null,
      arm: ctx.arm.id, cohort: ctx.vars.cohort, prompt_version: L.cfg.experiment.prompt_version, config_hash: L.configHash,
      state: newSession(ctx),
      messages: [
        { role: "details", text: ui.details_message, at },
        { role: "system", text: ui.joining, at },
        { role: "system", text: ui.joined, at },
        ...openingBubbles(L.cfg, ctx).map((text) => ({ role: "ai" as const, text, at })),
      ],
      handoff_shown_at: null, cta_tapped_at: null,
    };
    return { session: s, result: s };
  });
  // "Just started" also covers an immediate second request (React dev mode, a quick reload), so the opening
  // animation still plays once; it never replays after that.
  const fresh = created || (!session.messages.some((m) => m.role === "user") && Date.now() - new Date(session.started_at).getTime() < 4000);
  return view(L, ctx, session, token, fresh);
}

type TurnOutcome = {
  error: "not_started" | "empty" | "chat_over" | "too_many_messages" | "duplicate" | "not_quiet" | null;
  s: Session | null;
  messages?: OutMessage[];
  log?: TurnLog;
};

/**
 * One user message → Omkar's reply (always prompted by the user), persisted with a turn log.
 * First real answer: "kundli dekh raha hoon…" + kundli card + chart line + a 1-line answer.
 * After that: up to 3 short lines.
 */
export async function sendMessage(token: string, rawText: string): Promise<SendResult> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return { ok: false, error: "invalid_token", view: view(L, null, null, token) };
  const text = String(rawText ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_USER_CHARS);
  const store = getStore();

  const out = await store.withSession<TurnOutcome>(token, async (s) => {
    if (!s) return { session: null, result: { error: "not_started", s: null } };
    if (!text) return { session: null, result: { error: "empty", s } };
    if (s.state.closed || secondsLeft(L, s) <= 0) return { session: null, result: { error: "chat_over", s } };
    const lastUser = [...s.messages].reverse().find((m) => m.role === "user");
    if (lastUser && lastUser.text === text && Date.now() - new Date(lastUser.at).getTime() < DUPLICATE_WINDOW_MS)
      return { session: null, result: { error: "duplicate", s } };
    if (s.messages.filter((m) => m.role === "user").length >= MAX_USER_MESSAGES)
      return { session: null, result: { error: "too_many_messages", s } };

    const at = now();
    if (!s.clock_started_at) s.clock_started_at = at; // the free time starts with the first question
    const left = secondsLeft(L, s);
    const history: ChatMessage[] = s.messages
      .filter((m): m is StoredMessage & { role: "user" | "ai" } => m.role === "user" || m.role === "ai")
      .map((m) => ({ role: m.role, text: m.text }));
    s.messages.push({ role: "user", text, at });

    const firstAnswer = !s.state.chartShown;
    const { bubbles, log } = await runTurn(L, ctx, s.state, text, left, callModel, history, bubblesFor(L, s.state, token));
    const reply = withChart(L, ctx, s, firstAnswer && log.route === "llm", bubbles);
    return { session: s, result: { error: null, s, messages: reply, log } };
  });

  if (out.error) return { ok: false, error: out.error, view: view(L, ctx, out.s, token) };
  // Logged after the session lock is released (the file store serialises all writes).
  if (out.log) await store.addTurnLog(out.log);
  return { ok: true, messages: out.messages ?? [], view: view(L, ctx, out.s, token) };
}

/** The first real answer brings the kundli: "kundli dekh raha hoon…" → card → chart line → the answer. Stores the reply. */
function withChart(L: Loaded, ctx: Context, s: Session, firstAnswer: boolean, bubbles: string[]): OutMessage[] {
  const reply: OutMessage[] = [];
  if (firstAnswer) {
    s.state.chartShown = true;
  }
  if (firstAnswer && L.cfg.assets?.kundli !== false) {
    const intro = chartIntro(L.cfg, ctx);
    if (intro) reply.push({ role: "ai", text: intro });
    // The card and the chart line only when we're sure of the rashi (no birth time can make it uncertain).
    if (ctx.user.moon_certain !== false) reply.push({ role: "kundli", text: uiText(L.cfg, ctx).kundli_caption });
    const line = chartLine(L.cfg, ctx);
    if (line) reply.push({ role: "ai", text: line });
  }
  reply.push(...bubbles.map((b) => ({ role: "ai" as const, text: b })));
  const at = now();
  for (const m of reply) s.messages.push({ ...m, at });
  return reply;
}

/**
 * The user has been quiet for timing.idle_nudge_seconds: Omkar carries on by himself (if he hasn't read the chart
 * yet, he starts the reading). At closing_at_seconds_left he sends the closing line instead. The server checks the
 * silence itself, so a page can't make Omkar talk faster than configured.
 */
export async function nudge(token: string): Promise<SendResult> {
  const { L, ctx } = await userConfig(token);
  if (!ctx) return { ok: false, error: "invalid_token", view: view(L, null, null, token) };
  const store = getStore();
  const idleMs = L.cfg.timing.idle_nudge_seconds * 1000;

  const out = await store.withSession<TurnOutcome>(token, async (s) => {
    if (!s || !s.clock_started_at) return { session: null, result: { error: "not_started", s } };
    const left = secondsLeft(L, s);
    if (s.state.closed || s.state.crisis || left <= 0) return { session: null, result: { error: "chat_over", s } };
    const closing = left <= L.cfg.timing.closing_at_seconds_left;
    const lastAt = Math.max(...s.messages.map((m) => new Date(m.at).getTime()).filter(Number.isFinite), 0);
    // A little slack for the page's own timer; without it a nudge could be refused by a second.
    if (!closing && (idleMs === 0 || Date.now() - lastAt < idleMs - 3000)) return { session: null, result: { error: "not_quiet", s } };

    const history: ChatMessage[] = s.messages
      .filter((m): m is StoredMessage & { role: "user" | "ai" } => m.role === "user" || m.role === "ai")
      .map((m) => ({ role: m.role, text: m.text }));
    const firstAnswer = !s.state.chartShown && !closing;
    const { bubbles, log } = await runNudge(L, ctx, s.state, left, callModel, history, bubblesFor(L, s.state, token));
    if (!bubbles.length && !s.state.closed) return { session: null, result: { error: "chat_over", s } };
    const reply = withChart(L, ctx, s, firstAnswer, bubbles);
    return { session: s, result: { error: null, s, messages: reply, log } };
  });

  if (out.error) return { ok: false, error: out.error, view: view(L, ctx, out.s, token) };
  if (out.log) await store.addTurnLog(out.log);
  return { ok: true, messages: out.messages ?? [], view: view(L, ctx, out.s, token) };
}

/** Funnel events from the page. Unknown names are ignored. */
export async function recordEvent(token: string, name: string, props: Record<string, unknown> = {}): Promise<boolean> {
  if (!TOKEN_RX.test(token) || !(EVENT_NAMES as readonly string[]).includes(name)) return false;
  const L = config();
  const store = getStore();
  if (!(await store.getUser(token))) return false;
  const safeProps = Object.fromEntries(
    Object.entries(props).filter(([, v]) => ["string", "number", "boolean"].includes(typeof v)).slice(0, 10),
  );
  await store.addEvent({
    token, name, at: now(),
    props: { ...safeProps, prompt_version: L.cfg.experiment.prompt_version, config_hash: L.configHash },
  });
  if (name === "handoff_card_shown" || name === "cta_tapped") {
    await store.withSession<null>(token, async (s) => {
      if (!s) return { session: null, result: null };
      if (name === "handoff_card_shown" && !s.handoff_shown_at) s.handoff_shown_at = now();
      else if (name === "cta_tapped" && !s.cta_tapped_at) s.cta_tapped_at = now();
      else return { session: null, result: null };
      return { session: s, result: null };
    });
  }
  return true;
}
