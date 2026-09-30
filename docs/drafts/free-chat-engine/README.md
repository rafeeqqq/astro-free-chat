# Astrolokal AI free chat engine

The logic behind the 2-minute AI free chat → hand-off to a real astrologer.
**You control everything from `config.yaml`.** The web chat calls this engine; the engine calls the LLM.

```
npm install        # once
npm run check      # validates config.yaml + prompt_template.md
npm run preview    # shows opening/closing lines for the sample users (add -- --prompt to see the full system prompt)
npm test           # 18 checks: guardrails, routing, timeouts, arm split — must stay green
```

## Files

| File | What it is | Who edits |
|---|---|---|
| `config.yaml` | Every knob: arms, timing, persona, style, scripted lines, topics, guardrails | **You** |
| `prompt_template.md` | The system prompt, with `{placeholders}` the engine fills | You, rarely |
| `engine.ts` | Loads config, assigns arms, builds the prompt, routes messages, guards replies, logs | Dev |
| `samples/users.yaml` | Fake users for preview and tests. **Never put real user data here** | You |
| `test.ts` | Safety net for your edits | Dev |

## How a chat runs

1. **Opening is scripted, not AI:** name, rashi and dasha, then a hook from the last topic. Instant and never wrong.
2. **User types →** the engine routes it:
   - **distress** → helpline reply, chat closes, **no sales card**
   - **"are you AI?"** → your exact disclosure line
   - **health** → doctor line
   - **≤15 sec left** → scripted closing
   - **anything else** → the LLM
3. **Every LLM reply is checked:**
   - Bubbles that mention a date, remedy, money, AI, fear, a guarantee, filler, a wrong rashi or a wrong dasha are dropped.
   - Too many bubbles are trimmed, and so are questions over the budget.
   - If nothing survives, the engine retries once, then sends `fallback_reply`.
   - A slow model (> `llm_timeout_ms`) also gets `fallback_reply`.
4. **At ≤10 sec left** the app shows the pandit ji card, unless the user was in distress.

## Knobs you'll actually turn

| Knob | Default | What it changes |
|---|---|---|
| `experiment.prompt_version` | free_chat_v0.4 | **Bump on every edit.** Logged with every message |
| `experiment.arms` | one arm `pilot`, 100% | The whole cohort gets the same experience; the control is the WATI holdout. Set `insight_level` and `allow` here |
| `insight_levels.*` | minimal / specific | How much the AI gives away |
| `timing.free_seconds` | 120 | Length of the free chat |
| `timing.handoff_card_at_seconds_left` | 10 | When the CTA card with countdown appears |
| `style.max_bubbles` / `max_words_per_bubble` | 2 / 12 | Message rhythm (AT-style short bubbles) |
| `style.question_budget` | 1 | Max questions the AI may ask in the whole chat |
| `persona.header_label` | "AI Astro Sahayak" | The label under the name. `""` hides it |
| `scripted.topic_hook.*` | per topic | The hook line from the user's last chat |
| `monthly_line` | "" | One line for the whole pilot (a festival or a big transit) |
| `guardrails.banned` | 10 rules | Add a regex when you see the AI say something it shouldn't |

**Experiment rules:** the cohort is fixed, so compare **versions over time** against the holdout, not arms side by side. Change one thing per version. Read 20 chats per version by hand before judging. Keep the WATI holdout untouched.

## What the engine needs per user (from the lapsed-payer list + Omkar wrapper)

| Field | Source | Why |
|---|---|---|
| `token` | generated, random | Identifies the user in the WATI link. **Never a phone number or user ID in the URL** |
| `name`, `gender`, `dob`, `tob`, `pob`, `language` | user profile | Opening, address, language; unknown `tob` changes the prompt |
| `moon_sign`, `mahadasha`, `antardasha`, `lagna` | **computed by the wrapper** | The only chart facts the AI may use (the guard rejects any others) |
| `last_topic` | last consult, classified to shaadi/naukri/paisa/parivaar/pyaar | The hook, and the biggest difference from AT |
| `last_summary` | last consult summary (Sitara memory already produces these) | Makes replies feel personal |
| `last_consult_date`, `consult_count` | bookings | Sets tone for returning vs. one-time users |
| `windows.{topic}` | wrapper (optional) | Used only by the `specific` arm |

## What gets logged (one row per turn)

`session_token, experiment_id, arm, prompt_version, config_hash, model, turn, seconds_left, route, user_text, bubbles, flags, latency_ms, used_fallback, retried, show_handoff`

Add from the web page: `link_opened, first_message_sent, handoff_card_shown, cta_tapped`. Add from Astrolokal data: `recharged_7d, revenue_14d`. That's the full funnel, per arm and per prompt version.

## Not handled here (by design)

- The LLM call itself (pass any `(system, user) → text` function).
- The chat UI, timers and the hand-off card (web app).
- The holdout (it's decided when the WATI list is built, and never reaches this engine).
