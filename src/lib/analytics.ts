// Pilot analytics, computed from what the app already stores (sessions, turn logs, page events).
// Pure functions: the admin page and the CSV export use the same numbers, and tests pin the definitions.
//
// One chat = one user link. The funnel (each step is a subset of the one before):
//   Opened  → the chat page loaded
//   Spoke   → the user sent at least one message
//   Stayed  → the user was still on the page when the offer card appeared
//   Tapped  → the user tapped "Talk to astrologer" or "Claim"   ← the web conversion
// The back arrow (which also opens the app) is NOT a tap: it's counted separately as "left via back arrow".
// The real conversion, a recharge, happens in the app: join the CSV to recharges on token (out/pilot_map.csv).

import { detectTopic } from "../engine/engine.ts";
import type { Config, TurnLog } from "../engine/engine.ts";
import { isTestToken } from "./store.ts";
import type { Session, EventRow } from "./store.ts";

export type Filter = { version?: string; cohort?: string; includeTests?: boolean };
export type Funnel = { opened: number; spoke: number; stayed: number; tapped: number };

export type ChatRow = {
  token: string;
  cohort: string;
  version: string;
  opened_at: string;
  user_messages: number;
  topic: string;              // what the user talked about most ("none" if they never named a topic)
  spoke: boolean;
  stayed: boolean;
  tapped: boolean;
  tapped_on: string;          // "button" (offer card) or "claim" (gift strip)
  back_arrow: boolean;        // left to the app via the back arrow
  left_at_seconds: number | null; // free seconds left when they switched away or closed the page
  omkar_spoke_on_silence: boolean;
  crisis: boolean;
};

export type Report = {
  funnel: Funnel;
  topics: { topic: string; chats: number; tapped: number }[];
  byGroup: { version: string; cohort: string; funnel: Funnel }[];
  daily: { day: string; funnel: Funnel }[];
  health: { avgMessages: number | null; silenceShare: number; backArrow: number; fallbackShare: number; avgReplySec: number | null; crisis: number };
  chats: ChatRow[];
  versions: string[];
  cohorts: string[];
};

const TAP_ON: Record<string, string> = { sheet: "button", strip: "claim" };

/** One row per chat: the unit the pilot is judged on, and exactly what the CSV contains. */
export function chatRows(cfg: Config, sessions: Session[], turns: TurnLog[], events: EventRow[]): ChatRow[] {
  const eventsBy = groupBy(events, (e) => e.token);
  const quiet = new Set(turns.filter((t) => t.route === "quiet").map((t) => t.session_token));
  return sessions.map((s) => {
    const texts = s.messages.filter((m) => m.role === "user").map((m) => m.text);
    const evs = eventsBy.get(s.token) ?? [];
    const tap = evs.find((e) => e.name === "cta_tapped" && e.props.from !== "back"); // old builds logged the back arrow as a tap
    const hidden = evs.filter((e) => e.name === "page_hidden").at(-1);
    const tapped = !!tap;
    return {
      token: s.token,
      cohort: s.cohort || "–",
      version: s.prompt_version,
      opened_at: s.started_at,
      user_messages: texts.length,
      topic: mainTopic(cfg, texts),
      spoke: texts.length > 0,
      stayed: !!s.handoff_shown_at || tapped,
      tapped,
      tapped_on: tap ? TAP_ON[String(tap.props.from)] ?? "button" : "",
      back_arrow: evs.some((e) => e.name === "back_to_app" || (e.name === "cta_tapped" && e.props.from === "back")),
      left_at_seconds: hidden && typeof hidden.props.seconds_left === "number" ? hidden.props.seconds_left : null,
      omkar_spoke_on_silence: quiet.has(s.token),
      crisis: !!s.state.crisis,
    };
  });
}

export function analyse(cfg: Config, sessions: Session[], turns: TurnLog[], events: EventRow[], filter: Filter = {}): Report {
  const all = chatRows(cfg, sessions.filter((s) => filter.includeTests || !isTestToken(s.token)), turns, events);
  const chats = all.filter((c) => (!filter.version || c.version === filter.version) && (!filter.cohort || c.cohort === filter.cohort));
  const tokens = new Set(chats.map((c) => c.token));
  const replies = turns.filter((t) => tokens.has(t.session_token) && (t.route === "llm" || t.route === "quiet"));
  const latencies = replies.map((t) => t.latency_ms).filter((n): n is number => typeof n === "number");

  const topics = new Map<string, { chats: number; tapped: number }>();
  for (const c of chats) {
    const t = topics.get(c.topic) ?? { chats: 0, tapped: 0 };
    t.chats++;
    if (c.tapped) t.tapped++;
    topics.set(c.topic, t);
  }

  return {
    funnel: funnel(chats),
    topics: [...topics].map(([topic, v]) => ({ topic, ...v })).sort((a, b) => b.chats - a.chats),
    byGroup: [...groupBy(chats, (c) => `${c.version}\u0000${c.cohort}`)]
      .map(([k, cs]) => { const [version, cohort] = k.split("\u0000"); return { version, cohort, funnel: funnel(cs) }; })
      .sort((a, b) => b.version.localeCompare(a.version) || b.funnel.opened - a.funnel.opened),
    daily: [...groupBy(chats, (c) => istDay(c.opened_at))]
      .map(([day, cs]) => ({ day, funnel: funnel(cs) }))
      .sort((a, b) => b.day.localeCompare(a.day)),
    health: {
      avgMessages: chats.length ? round1(chats.reduce((n, c) => n + c.user_messages, 0) / chats.length) : null,
      silenceShare: share(chats.filter((c) => c.omkar_spoke_on_silence).length, chats.length),
      backArrow: chats.filter((c) => c.back_arrow).length,
      fallbackShare: share(replies.filter((t) => t.used_fallback).length, replies.length),
      avgReplySec: latencies.length ? round1(latencies.reduce((a, b) => a + b, 0) / latencies.length / 1000) : null,
      crisis: chats.filter((c) => c.crisis).length,
    },
    chats,
    versions: [...new Set(all.map((c) => c.version))].sort().reverse(),
    cohorts: [...new Set(all.map((c) => c.cohort))].sort(),
  };
}

export function funnel(chats: ChatRow[]): Funnel {
  return {
    opened: chats.length,
    spoke: chats.filter((c) => c.spoke).length,
    stayed: chats.filter((c) => c.stayed).length,
    tapped: chats.filter((c) => c.tapped).length,
  };
}

/** CSV of every chat, for joining with Astrolokal recharges (token → user_id via out/pilot_map.csv). */
export function toCsv(rows: ChatRow[]): string {
  const cols: (keyof ChatRow)[] = [
    "token", "cohort", "version", "opened_at", "user_messages", "topic", "spoke", "stayed", "tapped", "tapped_on",
    "back_arrow", "left_at_seconds", "omkar_spoke_on_silence", "crisis",
  ];
  const cell = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

/** The topic named most often in the user's own messages (ties: the first one named). */
function mainTopic(cfg: Config, texts: string[]): string {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const topic = detectTopic(cfg, t);
    if (topic) counts.set(topic, (counts.get(topic) ?? 0) + 1);
  }
  let best = "none", n = 0;
  for (const [t, c] of counts) if (c > n) { best = t; n = c; }
  return best;
}

function groupBy<T>(xs: T[], key: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k)!.push(x); }
  return m;
}

const share = (a: number, b: number) => (b ? a / b : 0);
const round1 = (n: number) => Math.round(n * 10) / 10;
const istDay = (iso: string) => new Date(new Date(iso).getTime() + 5.5 * 3600_000).toISOString().slice(0, 10);
