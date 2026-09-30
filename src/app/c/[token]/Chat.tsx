"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import s from "./chat.module.css";
import Confetti from "./Confetti";
import { KundliCard } from "./Kundli";
import type { KundliView } from "./Kundli";

type Msg = { role: "user" | "ai" | "kundli" | "details" | "system"; text: string; at?: string };
type View = {
  status: "invalid" | "active" | "ended";
  justStarted: boolean;
  clockStarted: boolean;
  ui: Record<string, string>;
  persona: { name: string; label: string; avatar: string; verified: boolean };
  messages: Msg[];
  secondsLeft: number;
  freeSeconds: number;
  idleNudgeSeconds: number;
  closingAt: number;
  handoffAt: number;
  ctaCountdown: number;
  handoffUrl: string;
  fallbackUrl: string;
  closed: boolean;
  crisis: boolean;
  chart: { moonSign: string; mahadasha: string; antardasha: string; kundli: KundliView | null } | null;
  pacing: {
    read_delay_ms: number; typing_min_ms: number; typing_ms_per_char: number; typing_max_ms: number;
    between_messages_ms: number; system_note_ms: number; kundli_ms: number;
  };
  canRestart: boolean;
  promptVersion: string;
};
type SendResult = { ok: boolean; error?: string; messages?: Msg[]; view: View };

// Message pacing comes from config.yaml → pacing (sent with the view). These are only used before it arrives.
const DEFAULT_PACING: View["pacing"] = {
  read_delay_ms: 600, typing_min_ms: 800, typing_ms_per_char: 25, typing_max_ms: 1800,
  between_messages_ms: 350, system_note_ms: 1100, kundli_ms: 2600,
};
const TICK_MS = 100;       // timer resolution (drives the smooth bars)

// "typing…" lasts longer for longer messages, like a person typing, within min..max.
const typingMs = (p: View["pacing"], text: string) =>
  Math.min(p.typing_max_ms, Math.max(p.typing_min_ms, p.typing_min_ms + text.length * p.typing_ms_per_char - 200));

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return (await r.json()) as T;
}

// Opens the app. For an app link (astrolokal://…): if the page is still showing after 1.5 s, the app didn't open
// (usually not installed), so go to the fallback (the Play Store). Web links open normally.
function openApp(e: { preventDefault(): void } | null, url: string, fallback: string) {
  if (/^https?:\/\//i.test(url) || !fallback) return; // a normal link: let the browser follow it
  e?.preventDefault();
  let left = false;
  const onHide = () => { if (document.visibilityState === "hidden") left = true; };
  document.addEventListener("visibilitychange", onHide);
  window.addEventListener("pagehide", onHide);
  window.location.href = url;
  setTimeout(() => {
    document.removeEventListener("visibilitychange", onHide);
    window.removeEventListener("pagehide", onHide);
    if (!left && document.visibilityState === "visible") window.location.href = fallback;
  }, 1500);
}

function beacon(token: string, name: string, props: Record<string, unknown> = {}) {
  const body = JSON.stringify({ token, name, props });
  try {
    if (navigator.sendBeacon?.("/api/event", body)) return;
  } catch { /* fall through */ }
  void fetch("/api/event", { method: "POST", body, keepalive: true }).catch(() => undefined);
}


const fmt = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec) % 60).padStart(2, "0")}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const buzz = () => { try { navigator.vibrate?.(12); } catch { /* not supported */ } };

export default function Chat({ token }: { token: string }) {
  const [view, setView] = useState<View | null>(null);
  const [shown, setShown] = useState<Msg[]>([]);
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msLeft, setMsLeft] = useState(0);
  const [loadError, setLoadError] = useState(false);
  const [sendError, setSendError] = useState(false);
  const [cardAt, setCardAt] = useState<number | null>(null); // when the hand-off card appeared (starts the button countdown)
  const [now, setNow] = useState(0);

  const endsAt = useRef<number | null>(null); // null until the first message starts the clock
  const cardLogged = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pacing = useRef<View["pacing"]>(DEFAULT_PACING);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const userScrollAt = useRef(0);
  const msLeftRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const sending = useRef(false); // synchronous guard: state updates are too slow to stop a double tap
  const revealing = useRef(0);     // messages still being revealed
  const nudging = useRef(false);
  const closingAsked = useRef(false);
  const lastActivity = useRef(0); // last message shown or key pressed (set when the chat opens): Omkar speaks up after a quiet spell
  const draftRef = useRef("");

  const sync = useCallback((v: View) => {
    setView(v);
    if (v.pacing) pacing.current = v.pacing;
    endsAt.current = v.clockStarted ? Date.now() + v.secondsLeft * 1000 : null;
    msLeftRef.current = v.secondsLeft * 1000;
    setMsLeft(msLeftRef.current);
  }, []);

  // Messages are revealed through one queue, so a reply never interleaves with another.
  // firstAlreadyTyped: the typing dots were already showing while we waited for the server.
  // typedSince: when those dots appeared; the first message still gets its full typing time (a fast model
  // reply shouldn't make Omkar answer instantly).
  const reveal = useCallback((msgs: Msg[], typedSince?: number) => {
    revealing.current += 1;
    queue.current = queue.current.then(async () => {
      for (const [i, m] of msgs.entries()) {
        const p = pacing.current;
        const typed = m.role === "ai" || m.role === "kundli";
        if (typed) {
          setTyping(true);
          const want = m.role === "kundli" ? p.kundli_ms : typingMs(p, m.text);
          await sleep(i === 0 && typedSince ? Math.max(0, want - (Date.now() - typedSince)) : want);
        }
        setTyping(false);
        setShown((prev) => [...prev, m]);
        await sleep(m.role === "system" ? p.system_note_ms : p.between_messages_ms);
      }
    }).finally(() => { revealing.current -= 1; lastActivity.current = Date.now(); });
    return queue.current;
  }, []);

  // Open or resume the chat.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const v = await post<View>("/api/session", { token });
        if (cancelled) return;
        sync(v);
        lastActivity.current = Date.now();
        if (v.status === "invalid") return;
        beacon(token, v.status === "active" ? "link_opened" : "ended_screen_viewed", { seconds_left: v.secondsLeft });
        if (v.justStarted) void reveal(v.messages); // the opening animates once, never on a reload
        else {
          setShown(v.messages);
          requestAnimationFrame(() => listRef.current?.scrollTo({ top: listRef.current.scrollHeight }));
        }
      } catch {
        if (!cancelled) setLoadError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [token, sync, reveal]);

  // Clock: runs only after the first message; the server's number is the truth, this just displays it.
  const clockRunning = !!view?.clockStarted && view.status !== "invalid";
  useEffect(() => {
    if (!clockRunning) return;
    const id = setInterval(() => {
      if (endsAt.current === null) return;
      const ms = Math.max(0, endsAt.current - Date.now());
      msLeftRef.current = ms;
      setMsLeft(ms);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [clockRunning]);

  // Keep the newest message in view, unless the user has scrolled up to read.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [shown, typing]);

  const left = Math.ceil(msLeft / 1000);
  const crisis = !!view?.crisis;
  const active = !!view && view.status !== "invalid";
  const timeUp = left <= 0;
  const locked = !view || view.closed || timeUp;   // input closed
  const showSheet = active && !crisis && !!view?.clockStarted && (left <= view.handoffAt || view.closed);
  const urgent = active && !!view?.clockStarted && !timeUp && left <= view.closingAt;

  useEffect(() => {
    if (!showSheet || cardLogged.current) return;
    cardLogged.current = true;
    const t = Date.now();
    setCardAt(t);
    setNow(t);
    buzz();
    beacon(token, "handoff_card_shown", { seconds_left: Math.ceil(msLeftRef.current / 1000) });
  }, [showSheet, token]);

  // Ticks the button countdown (only while it runs).
  useEffect(() => {
    if (!cardAt) return;
    const end = cardAt + (view?.ctaCountdown ?? 5) * 1000;
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= end) clearInterval(id);
    }, TICK_MS);
    return () => clearInterval(id);
  }, [cardAt, view?.ctaCountdown]);

  // When the chat area changes size (the sheet opens or grows, the keyboard opens), stay on the newest message.
  const hasList = !!view && view.status !== "invalid";
  useEffect(() => {
    const el = listRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [hasList]);

  // The sheet can cover the last message; keep it visible when the sheet opens.
  useEffect(() => {
    if (!showSheet) return;
    stickToBottom.current = true;
    const toBottom = (behavior: ScrollBehavior) => listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior });
    toBottom("smooth");
    const t = setTimeout(() => toBottom("auto"), 650); // settle exactly at the bottom once the sheet is in place
    return () => clearTimeout(t);
  }, [showSheet]);

  // Drop-off: when the user switches away from or closes the page during the free time, note how much time was left.
  // Logged once per visit (the last one counts in analytics); it never interrupts anything.
  const liveChat = active && !crisis && !timeUp;
  useEffect(() => {
    if (!liveChat) return;
    let sent = false;
    const onHide = (e: Event) => {
      if (sent || (e.type === "visibilitychange" && document.visibilityState !== "hidden")) return;
      sent = true;
      beacon(token, "page_hidden", { seconds_left: Math.ceil(msLeftRef.current / 1000) });
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("pagehide", onHide); };
  }, [liveChat, token]);

  // When the user goes quiet, Omkar carries on by himself; at closing time he sends the closing line.
  // The server re-checks the silence, so this timer can't make him talk more than configured.
  const quietWatch = active && !crisis && !!view?.clockStarted && !view.closed;
  useEffect(() => {
    if (!quietWatch || !view) return;
    const idleMs = view.idleNudgeSeconds * 1000;
    const id = setInterval(async () => {
      if (sending.current || nudging.current || revealing.current > 0 || closingAsked.current) return;
      const leftMs = msLeftRef.current;
      if (leftMs <= 0) return;
      const closing = leftMs <= view.closingAt * 1000;
      const quiet = idleMs > 0 && Date.now() - lastActivity.current >= idleMs && !draftRef.current.trim();
      if (!closing && !quiet) return;
      if (closing) closingAsked.current = true;
      nudging.current = true;
      setTyping(true);
      const typedSince = Date.now();
      try {
        const r = await post<SendResult>("/api/nudge", { token });
        if (r.view) sync(r.view);
        if (r.ok && r.messages?.length) await reveal(r.messages, typedSince);
        else setTyping(false);
      } catch {
        setTyping(false);
      } finally {
        lastActivity.current = Date.now();
        nudging.current = false;
      }
    }, 1000);
    return () => clearInterval(id);
  }, [quietWatch, view, token, sync, reveal]);

  const send = async () => {
    const text = draft.trim();
    if (!text || sending.current || locked) return;
    sending.current = true;
    lastActivity.current = Date.now();
    draftRef.current = "";
    setDraft("");
    setSendError(false);
    setBusy(true);
    stickToBottom.current = true;
    setShown((prev) => [...prev, { role: "user", text, at: "" }]);
    try {
      await sleep(pacing.current.read_delay_ms); // a beat before "typing…", like a person reading
      setTyping(true);
      const typedSince = Date.now();
      const r = await post<SendResult>("/api/chat", { token, text });
      if (r.view) sync(r.view);
      if (r.ok) {
        if (r.messages?.length) await reveal(r.messages, typedSince);
        else setTyping(false);
      } else {
        // Not accepted (e.g. time ran out): show exactly what the server has.
        setTyping(false);
        if (r.view?.messages) setShown(r.view.messages);
      }
    } catch {
      // Network failure: take the message back so the user can resend it.
      setTyping(false);
      setShown((prev) => prev.slice(0, -1));
      setDraft(text);
      draftRef.current = text;
      setSendError(true);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };

  // Local development only: wipe this chat and open it fresh.
  const restart = async () => {
    await post<View>("/api/session", { token, restart: true });
    window.location.reload();
  };

  if (loadError) {
    return (
      <Shell>
        <Empty title="Slow network" text="Please open the link again in a moment." />
      </Shell>
    );
  }
  if (!view) return <Shell><Skeleton /></Shell>;

  if (view.status === "invalid") {
    return (
      <Shell>
        <Empty title={view.ui.invalid_title} text={view.ui.invalid_text} />
        <div className={s.footer}>
          <a className={s.cta} href={view.handoffUrl} onClick={(e) => openApp(e, view.handoffUrl, view.fallbackUrl)}><span className={s.ctaLabel}>{view.ui.cta_label}</span></a>
        </div>
      </Shell>
    );
  }

  const ui = view.ui;
  // Once the hand-off card is up the chat is over (no more input), so the header says so too: one clock, not two.
  const over = timeUp || showSheet;
  const timeFrac = over ? 0 : Math.min(1, Math.max(0, msLeft / (view.freeSeconds * 1000)));
  // The button counts down ctaCountdown seconds from the moment the card appears, then stays as "Talk to astrologer →".
  const ctaMs = (view.ctaCountdown ?? 5) * 1000;
  const ctaLeftMs = cardAt && ctaMs > 0 ? Math.min(ctaMs, Math.max(0, ctaMs - (now - cardAt))) : 0;
  const ringFrac = ctaMs > 0 ? ctaLeftMs / ctaMs : 0;
  const ctaSeconds = Math.ceil(ctaLeftMs / 1000);

  return (
    <Shell>
      <header className={s.header}>
        <button
          type="button"
          className={s.back}
          aria-label="Back"
          onClick={() => {
            // Back if there's somewhere to go; inside WhatsApp (first page) open the app instead of doing nothing.
            if (window.history.length > 1) window.history.back();
            else {
              beacon(token, "back_to_app", { seconds_left: left }); // leaving, not a CTA decision: counted separately
              if (/^https?:\/\//i.test(view.handoffUrl) || !view.fallbackUrl) window.location.href = view.handoffUrl;
              else openApp(null, view.handoffUrl, view.fallbackUrl);
            }
          }}
        >
          <BackIcon />
        </button>
        <div className={s.avatarWrap}>
          <Avatar persona={view.persona} className={s.avatar} />
          {!over && !crisis ? <span className={s.onlineDot} aria-hidden /> : null}
        </div>
        <div className={s.who}>
          <div className={s.name}>
            {view.persona.name}
            {view.persona.verified ? <VerifiedIcon /> : null}
          </div>
          <div className={`${s.label} ${typing && !over ? s.labelTyping : ""} ${!over && !typing ? s.labelOnline : ""}`}>
            {over ? ui.time_up_status : typing ? ui.status_typing : [view.persona.label, ui.status_online].filter(Boolean).join(" · ")}
          </div>
        </div>
        {crisis ? null : <div className={`${s.timer} ${urgent && !over ? s.timerUrgent : ""} ${over ? s.timerDone : ""}`} aria-live="off">
          {over ? (
            <span>{ui.time_up}</span>
          ) : (
            <>
              <ClockIcon />
              <span className={s.timerNum}>{fmt(left)}</span>
              <span className={s.timerFree}>free</span>
            </>
          )}
        </div>}
        {crisis ? null : (
          <div className={s.timeTrack} aria-hidden>
            <div className={`${s.timeBar} ${urgent && !over ? s.timeBarUrgent : ""}`} style={{ transform: `scaleX(${timeFrac})` }} />
          </div>
        )}
      </header>

      {crisis ? null : (
        <div className={`${s.strip} ${showSheet ? s.stripWin : ""}`} key={showSheet ? "win" : "gift"}>
          <span className={s.stripIcon} aria-hidden>{showSheet ? "🎉" : "🎁"}</span>
          <span className={s.stripText}>{showSheet ? ui.strip_reveal.replace(/^🎉\s*/, "") : ui.strip_during.replace(/^🎁\s*/, "")}</span>
          {showSheet ? (
            <a className={s.stripCta} href={view.handoffUrl} onClick={(e) => { beacon(token, "cta_tapped", { seconds_left: left, from: "strip" }); openApp(e, view.handoffUrl, view.fallbackUrl); }}>
              {ui.strip_cta}
            </a>
          ) : null}
        </div>
      )}

      <div
        className={`${s.list} ${showSheet ? s.listUnderSheet : ""}`}
        ref={listRef}
        aria-live="polite"
        onTouchMove={() => { userScrollAt.current = Date.now(); }}
        onWheel={() => { userScrollAt.current = Date.now(); }}
        onScroll={(e) => {
          // Only the user's own scrolling decides whether we follow new messages.
          if (Date.now() - userScrollAt.current > 800) return;
          const el = e.currentTarget;
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={s.dayChip}>{ui.day_chip}</div>
        {shown.map((m, i) => {
          const next = shown[i + 1];
          const lastOfGroup = !next || next.role !== m.role;
          if (m.role === "details") return <DetailsCard key={i} text={m.text} />;
          if (m.role === "system") return <div key={i} className={s.systemNote}>{m.text}</div>;
          if (m.role === "kundli") {
            return (
              <KundliCard
                key={i}
                title={m.text}
                subtitle={view.chart?.kundli?.basis === "moon" ? ui.kundli_moon_chart : ui.kundli_lagna_chart}
                kundli={view.chart?.kundli ?? null}
                facts={view.chart ? [
                  { label: ui.moon_sign_label, value: view.chart.moonSign },
                  { label: ui.dasha_label, value: [view.chart.mahadasha, view.chart.antardasha].filter(Boolean).join(" · ") },
                ].filter((f) => f.value) : []}
              />
            );
          }
          if (m.role === "user") return <div key={i} className={`${s.bubble} ${s.user} ${lastOfGroup ? s.tailUser : ""}`}>{m.text}</div>;
          return (
            <div key={i} className={s.aiRow}>
              <Avatar
                persona={view.persona}
                className={s.miniAvatar}
                style={{ visibility: lastOfGroup && !(typing && !next) ? "visible" : "hidden" }}
              />
              <div className={`${s.bubble} ${s.ai} ${lastOfGroup ? s.tailAi : ""}`}>{m.text}</div>
            </div>
          );
        })}
        {typing ? (
          <div className={s.aiRow}>
            <Avatar persona={view.persona} className={s.miniAvatar} />
            <div className={`${s.bubble} ${s.ai} ${s.tailAi} ${s.typing}`} aria-label={`${view.persona.name} likh rahe hain`}>
              <i /><i /><i />
            </div>
          </div>
        ) : null}
      </div>

      <Confetti fire={showSheet && left > 0} />  {/* the live reveal only, not when reopening an ended chat */}
      {showSheet ? (
        <section className={s.sheet} aria-label={ui.cta_label}>
          <div className={s.handle} aria-hidden />
          <div className={s.sheetHead}>
            <Avatar persona={view.persona} className={s.sheetAvatar} />
            <div>
              <p className={s.sheetText}>{ui.card_text}</p>
              <span className={s.offer}>🎁 {ui.card_offer}</span>
            </div>
          </div>
          <a
            className={`${s.cta} ${ctaSeconds > 0 ? s.ctaUrgent : s.ctaDone}`}
            href={view.handoffUrl}
            onClick={(e) => { beacon(token, "cta_tapped", { seconds_left: left, from: "sheet" }); openApp(e, view.handoffUrl, view.fallbackUrl); }}
          >
            <span className={s.ctaLabel}>{ui.cta_label}</span>
            {ctaSeconds > 0 ? <CountdownRing frac={ringFrac} seconds={ctaSeconds} /> : <ArrowIcon />}
          </a>
          <p className={s.sheetSub}><VerifiedIcon className={s.sheetSubTick} />{ui.cta_subtext}</p>
          {view.canRestart && timeUp ? (
            <button type="button" className={s.restart} onClick={() => void restart()}>Restart chat (local testing only)</button>
          ) : null}
        </section>
      ) : !locked ? (
        <form className={s.composer} onSubmit={(e) => { e.preventDefault(); void send(); inputRef.current?.focus(); }}>
          {sendError ? <p className={s.sendError} role="alert">{ui.send_error}</p> : null}
          <label htmlFor="message" className={s.srOnly}>{ui.input_placeholder}</label>
          <input
            id="message"
            ref={inputRef}
            className={s.input}
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              draftRef.current = e.target.value;
              lastActivity.current = Date.now(); // typing counts as not quiet
              if (sendError) setSendError(false);
            }}
            placeholder={ui.input_placeholder}
            maxLength={500}
            autoComplete="off"
            enterKeyHint="send"
          />
          <button className={s.send} type="submit" disabled={busy || !draft.trim()} aria-label="Send">
            <SendIcon />
          </button>
        </form>
      ) : (
        <div className={s.endedBar}>
          {ui.ended_title}
          {view.canRestart ? (
            <button type="button" className={s.restart} onClick={() => void restart()}>Restart chat (local testing only)</button>
          ) : null}
        </div>
      )}
    </Shell>
  );
}

// ── Pieces ───────────────────────────────────────────────────────────────────

function Shell({ children }: { children: React.ReactNode }) {
  return <main className={s.shell}>{children}</main>;
}

// The persona's photo (persona.avatar_url in config), or their initial if there is none or it fails to load.
function Avatar({ persona, className, style }: { persona: View["persona"]; className: string; style?: React.CSSProperties }) {
  const [failed, setFailed] = useState(false);
  const initial = persona.name.trim().slice(0, 1).toUpperCase();
  return (
    <div className={className} style={style} aria-hidden>
      {persona.avatar && !failed ? (
        // eslint-disable-next-line @next/next/no-img-element -- tiny avatar, may be a remote URL from config
        <img src={persona.avatar} alt="" className={s.avatarImg} onError={() => setFailed(true)} draggable={false} />
      ) : (
        initial
      )}
    </div>
  );
}

function Empty({ title, text }: { title: string; text: string }) {
  return (
    <div className={s.empty}>
      <div className={s.emptyIcon} aria-hidden>✨</div>
      <h1 className={s.emptyTitle}>{title}</h1>
      <p className={s.emptyText}>{text}</p>
    </div>
  );
}

function Skeleton() {
  return (
    <div className={s.skeleton} aria-label="Loading" role="status">
      <div className={s.skHeader} />
      <div className={s.skBody}>
        <div className={`${s.sk} ${s.skRight}`} />
        <div className={`${s.sk} ${s.skCard}`} />
        <div className={s.sk} />
        <div className={`${s.sk} ${s.skShort}`} />
      </div>
    </div>
  );
}

// "Meri details:\nName · Gender · DOB\nTime · Place" → a tidy card on the user's side.
function DetailsCard({ text }: { text: string }) {
  const [title, ...lines] = text.split("\n");
  return (
    <div className={`${s.detailsCard} ${s.appear}`}>
      <div className={s.detailsTitle}>{title.replace(/:$/, "")}</div>
      {lines.map((l, i) => <div key={i} className={s.detailsLine}>{l}</div>)}
    </div>
  );
}

function BackIcon() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 5l-7 7 7 7" />
    </svg>
  );
}

function VerifiedIcon({ className = s.verified }: { className?: string }) {
  return (
    <svg className={className} width="16" height="16" viewBox="0 0 24 24" role="img" aria-label="Verified">
      <path fill="#22c55e" d="M12 1.5l2.6 1.9 3.2-.1 1 3 2.6 1.9-1 3 1 3-2.6 1.9-1 3-3.2-.1L12 22.5l-2.6-1.9-3.2.1-1-3L2.6 15.8l1-3-1-3 2.6-1.9 1-3 3.2.1z" />
      <path d="M8 12.2l2.6 2.6L16.2 9" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

function SendIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      <path d="M3.4 20.4 21 12 3.4 3.6l.1 6.5L15 12l-11.5 1.9z" />
    </svg>
  );
}

// The seconds left, inside a ring that empties smoothly (100 ms ticks + a short CSS transition).
// The number pops on each new second, so the last seconds are felt without anything flashing.
function CountdownRing({ frac, seconds }: { frac: number; seconds: number }) {
  const R = 15, C = 2 * Math.PI * R;
  return (
    <span className={s.ring} aria-label={`${seconds} seconds left`}>
      <svg width="38" height="38" viewBox="0 0 38 38" aria-hidden>
        <circle cx="19" cy="19" r={R} className={s.ringTrack} />
        <circle cx="19" cy="19" r={R} className={s.ringArc} strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <span key={seconds} className={s.ringNum}>{seconds}</span>
    </span>
  );
}

function ArrowIcon() {
  return (
    <svg className={s.ctaArrow} width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
