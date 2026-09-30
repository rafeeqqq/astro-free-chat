# Astrolokal AI free chat → real astrologer

The web chat for the WhatsApp reactivation pilot.
A lapsed payer gets a WATI message → opens a 2-minute AI reading of their own kundli → in the last seconds a card hands them to a real astrologer in the Astrolokal app (random connect).

**PRD:** [Confluence · ProductAst 1852997895](https://getlokalapp.atlassian.net/wiki/spaces/ProductAst/pages/1852997895)
**Owner:** Rafeeq

## Run it locally

```bash
npm install
cp .env.example .env.local        # add GEMINI_API_KEY
npm run gemini-test               # one real Gemini call: confirms the key + model work
npm run seed                      # loads 3 sample users and starts their chats fresh
npm run dev                       # http://localhost:3100/c/t_demo_shaadi_01 (real Gemini, 2-minute chat)
npm run dev:mock                  # same, but 40 seconds and canned replies (no key needed)
```

`/admin` shows the funnel per prompt version × cohort, the team's test chats and the latest transcripts.


## You change the experience in `config/`, not in code

| File | What |
|---|---|
| `config/config.yaml` | Timing, persona (name, photo), bubbles per reply, message length, pacing, when Omkar speaks up, how much the AI reveals, scripted lines, topics, guardrails, the two hand-off links, assets (kundli, last chat), **cohorts**, **every word on the screen** |
| `config/prompt_template.md` | The system prompt; `{placeholders}` are filled per user |

**Every change:**
1. Edit the file.
2. Bump `experiment.prompt_version`.
3. Run `npm run verify`.
4. Deploy.

In development, config edits apply on the next message without a restart.

| Command | Does |
|---|---|
| `npm run check` | Validates config (weights, placeholders, regexes, and that scripted lines pass your own guardrails) |
| `npm run preview` | Shows opening, closing, card and link for the sample users (`-- --prompt` for the full system prompt) |
| `npm run replay -- "msg" - "msg"` | Plays a whole chat through the live prompt with real Gemini (`-` = the user stays quiet). Judge prompt changes on full chats |
| `npm test` | 64 checks: engine (guardrails, stages, bubbles, cohorts, links), chart maths, analytics, the full server flow (open, resume, send, quiet, crisis, closing, limits, events) |
| `npm run verify` | check + test + types + lint. Run before every deploy |
| `npm run prodcheck` | ✓/✗ list of everything that must be true before real users get links (env, deep links, TODOs). Never prints secret values |

## How a chat works

The goal: the user enjoys it, feels their kundli is really being read, and leaves wanting more.

1. **Opening (scripted, no AI):** details card → "Connecting you to Astro Omkar…" → "has joined" → a short greeting that asks their question (by last topic). The 2-minute clock starts when the page opens.
2. **First question → answered.** "Aapki kundli dekh raha hoon…" → kundli card → "Rashi X, dasha Y ki." → a real answer (direction + the planet behind it, never a date). 2 bubbles.
3. **Then keep them talking.** Replies react to what they said, add one small personal insight, and ask a question at most every other reply. New where/who/when questions are not answered ("Haan, yeh kundli mein saaf dikh raha hai… aapko kya lagta hai?"). 3 bubbles for the next 2 replies, then 2 or 3, like a person.
4. **Last ~40 s: one open thread** ("Partner ke baare mein ek khaas baat dikh rahi hai…"). Omkar never mentions pandit ji or "baad mein" (a guardrail drops it); only the card hands over.
5. **Quiet user:** after 25 s without typing, Omkar carries on by himself (if nobody asked yet, he starts the reading). The server re-checks the silence. At 15 s left he sends the closing line, unless he already left an open thread.
6. **Hand-off:** at 10 s (or at close) the card slides up with confetti, "🎉 You've won 100% cashback!", the hook and **Talk to astrologer** with a countdown ring. The link depends on wallet balance: `deeplink_with_balance` (straight into a chat) or `deeplink_no_balance` (recharge first). Every tap carries token, version, cohort, arm and balance.
7. **Routing before the AI:** distress → Tele-MANAS 14416, chat closes, no sales card · "are you AI?" → the disclosure line · health → doctor line.
8. **Every Gemini reply is checked:** dates, future timing, remedies, money, AI mentions, fear, guarantees (pakka/pakki/tay hai), pandit/"baad mein", filler, or a rashi/dasha that isn't theirs → dropped. Bubbles cut mid-sentence are joined. Nothing left → one retry → fallback line.
9. **One chat per link.** Reopening shows the finished chat. Locally, a "Restart chat" button appears (never in production).

**Cohorts** (`cohorts:` in config): lapsed / low_balance / zero_balance. A cohort overrides only what differs (hook, offer, assets, even prompt pieces); everything else comes from the main config. A broken cohort stops the config from loading.

## Daily sync and the WATI link

```
Redash query 20605 (daily) ─► npm run sync (Devtron cron) ─► database (users + their kundli)
WATI message: https://<chat domain>/u/{{user_id}} ─► tap ─► that user's chat, already filled in ─► "Talk to astrologer"
```

- **The user never types anything.** The link carries their `user_id`; `/u/<user_id>` opens the chat made for them by today's sync (or the last 2 days', `source.links.lookback_days`), with their details and kundli.
- **Cohorts are decided on the business side** (Tejaswi, from the free coins). The query's cohort column (`rc_bucket` today) is carried through for analytics and optional per-cohort overrides.
- A `user_id` that isn't in a recent sync (or isn't a number) gets the friendly "link isn't working" page with a button to the app.

**The query** (column names are mapped in `config.yaml → source.columns`; it has `user_id`, `rc_bucket`, `DOB`, `TOB`, `POB`):

| Needed | Status |
|---|---|
| `user_id`, `DOB`, `TOB`, `POB`, cohort | ✓ in the query (TOB is empty for ~half the users → Moon chart) |
| `name` | optional, not in the query yet. Without it: "Namaste ji", "aap", "Your Kundli" |
| `gender` | optional, not in the query yet (left off the details card) |
| one profile per user | ~570 users/day have several kundli profiles; the most complete one is used (a primary-profile flag in the query would be exact) |
| optional: birth-place lat/lon | exact lagna for everyone (today only city-level matches get a lagna) |
| optional: stored rashi / dasha | more reliable than recomputing for users without a birth time |

**Link safety:** a plain `/u/<user_id>` link can be changed by hand to open another synced user's chat (their name and birth details). Set `source.links.require_signature: true` and have the query output `s` (`sha256("<TOKEN_SECRET>:sig:" || user_id)`, first 10 hex characters) to make that impossible. The link is then `/u/{{user_id}}?s={{s}}`. `npm run prodcheck` flags it while it's off.

**The cron** (daily, after the query refreshes and before the WATI send):

```
command:  npm run sync
env:      DATABASE_URL, TOKEN_SECRET (same as the web app), REDASH_API_KEY (the query's own key), CHAT_BASE_URL
```

It prints a report (synced, skipped with reasons, Lagna vs Moon charts, places not matched, cohort counts), saves it to `out/sync_<day>_report.txt`, and **exits with an error if nothing synced or over 20% of rows were skipped**. Try it with `npm run sync -- --dry-run` (saves nothing) or `npm run sync -- --inspect` (shows the query's columns and formats, never the values).

**Missing data never blocks a chat.** Only `user_id` and a valid `DOB` are required. No name → "Namaste ji" and "aap". No birth time → Moon chart, and the rashi/dasha is only stated when it's the same at every hour of that day (otherwise no kundli card, and the prompt tells Omkar not to name it). Unmatched place → Moon chart.

**Kundli accuracy:** computed here (Lahiri ayanamsa, Vimshottari dasha); it matched a real Astrolokal chart exactly.

## Running the pilot

```bash
# 1. The list from analytics (see header of scripts/import-users.ts for the columns)
TOKEN_SECRET=... DATABASE_URL=... npm run import -- lapsed_payers.csv --seed pilot-sep26 --base-url https://chat.astrolokal.com
```

Writes to `out/`. **This folder is private and git-ignored. Never share it.**
- `wati_pilot.csv`: phone, name, token, link. Upload to WATI.
- `pilot_map.csv`: user_id → token, cohort. Joins web events to recharges.
- `holdout.csv`: user_id, cohort: the control group. **Never message these users.** Compare per cohort.
- `import_report.txt`: counts, the share of users with a last topic, and skipped rows with reasons.

Optional list columns: `cohort` (unknown → default cohort, noted in the report) and `wallet_balance` (> 0 → the CTA goes straight to a chat).

**Kundli card:** houses are numbered from the user's lagna, with Asc and the Moon placed from data we already have. Other planets appear only if the list has a `planets` column from the Omkar wrapper (`Su:Mesh 12.4;Ma:Kark 3.1;…`). Without birth time the card shows a Moon chart. Bad planet entries are listed in `import_report.txt` and left off the chart.

The split is deterministic (same seed → same groups). Tokens are stable (same `TOKEN_SECRET` → same links), so re-running is safe.

**Read the result:**
- **Primary:** recharge within 7 days per targeted user, pilot vs holdout, from Astrolokal data joined via `pilot_map.csv`.
- **Funnel and quality:** `/admin` (below), the CSV export, or the `fc_turns` / `fc_events` tables.

## Analytics (`/admin`)

Real users only by default (tick "Include team tests" to see team chats). Filter by version and cohort.

| Section | What it tells you |
|---|---|
| Tiles + funnel | **Opened → Spoke → Stayed to the offer → Tapped the CTA**, with the rate at each step. "Engaged (3+ messages)" shows depth |
| Where they stopped | Opened but never typed · left after 1–2 messages · left after 3+ · saw the offer but didn't tap · tapped |
| What they talked about | Main topic per chat (from their own messages), its share and its tap rate |
| Where taps came from | Offer card button, "Claim" in the gift strip, or the back arrow |
| Chat quality | Messages per chat, how often Omkar spoke up on silence, fallback rate, guardrail drops, model speed, distress cases |
| By version · cohort, by day | The same funnel per prompt version × cohort, and per day (IST) |
| Download CSV | One row per chat: token, cohort, version, messages, topics, stayed, tapped (and from where), seconds left when they tapped or left. Join to recharges on token via `out/pilot_map.csv` |

Events the page sends: `link_opened`, `handoff_card_shown`, `cta_tapped` (with `from`), `page_hidden` (seconds left when they switched away or closed), `ended_screen_viewed`.

## Deploy (Devtron)

One Docker image (`Dockerfile`) runs both parts:

| App | Command | Notes |
|---|---|---|
| Web | default (`next start -p 3000`) | Health/readiness probe: `GET /api/health` (checks config + database) |
| Daily cron | `npm run sync` | Same image, same env |

| Env var | Web | Cron | Why |
|---|---|---|---|
| `DATABASE_URL` | ✓ | ✓ | Postgres. Tables `fc_*` are created on first use. The container refuses to run without it |
| `TOKEN_SECRET` | ✓ | ✓ | Links chats to users. 16+ random characters, the same in both, never changed mid-pilot |
| `GEMINI_API_KEY` | ✓ | | The model (settings in `config.yaml → model`) |
| `ADMIN_PASSWORD`, `ADMIN_PUBLIC=1` | ✓ | | `/admin` on the real domain, behind a strong password |
| `REDASH_API_KEY`, `CHAT_BASE_URL` | | ✓ | The query's own API key; the chat domain |

Config changes (`config/`) go through git → a new deploy. Point a short company domain (e.g. `chat.astrolokal.com`) at the web app; random-looking domains read as spam on WhatsApp.

## Before the first real send

- [ ] `handoff.deeplink_with_balance` and `deeplink_no_balance` are Yatharth's action deep links, working after a fresh install on Android and iOS, with our utm saved on the recharge (`npm run check` warns while they're the Play Store stand-in)
- [ ] Cohort definitions agreed with Vandana; the list has `cohort` and `wallet_balance`
- [ ] Offer per cohort confirmed (the low_balance offer copy is a placeholder), with a backend-enforced expiry
- [ ] WATI template approved, with a dynamic URL button `…/u/{{1}}` (user_id)
- [ ] Deployed on Devtron (web + daily sync cron) with Postgres and a real domain; `npm run prodcheck` all ✓
- [ ] The dry run syncs over 80% of rows (ideally the query also has name, gender, lat/lon and a primary-profile flag)
- [ ] QA inside WhatsApp's in-app browser on Android and iOS
- [ ] First 100 per cohort go out; read those chats in `/admin` before sending the rest

## Code map

```
config/                 what you edit
src/engine/engine.ts    prompt, routing, guard, turn logic (no framework, runs under plain Node)
src/lib/chat.ts         server-side chat service (clock, sessions, events)
src/lib/store.ts        Postgres in production, JSON file locally
src/lib/chart.ts        moon sign / lagna / dasha / planets from birth details
src/lib/places.ts       birth place text → coordinates (city, else state)
src/lib/sync.ts         query rows → chat users (+ Redash fetch)
src/lib/llm.ts          the single model call (Google Gemini direct, or MOCK_LLM locally)
src/app/c/[token]/      the chat screen (Chat, Kundli, Confetti)
src/app/api/*           session · chat · nudge · event · health
src/app/u/[uid]/        the WATI link: user_id → that user's chat
src/app/admin/          analytics dashboard + CSV export (Basic auth via src/proxy.ts)
src/lib/analytics.ts    funnel, drop-off, topics, quality (pure functions, tested)
scripts/                sync (daily), import-users, cli (check / prodcheck / preview / seed), replay, gemini-test
tests/                  engine tests + full server-flow tests
```
