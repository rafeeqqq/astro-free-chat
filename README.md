# Astrolokal AI free chat

A lapsed user taps a WhatsApp link → a 2-minute free chat with Astro Omkar (their own kundli) → "Talk to astrologer" opens the app.

## Flow

```
Redash query (daily) → npm run sync → users + kundli saved
WhatsApp link /u/{user_id} → their chat → button → Astrolokal app
```

## Change the experience

Edit `config/config.yaml` (text, timing, offer, button link) or `config/prompt_template.md` (how Omkar talks).
Bump `prompt_version` on every change so `/admin` shows results per version.

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Run locally |
| `npm run verify` | Check config + tests. Run before every push |
| `npm run sync` | Load today's users from Redash (daily cron) |
| `npm run prodcheck` | ✓/✗ list before going live |

## Deploy (Devtron)

One image (`Dockerfile`): the web app (port 3000, health `/api/health`) and a daily cron running `npm run sync`.

Env: `DATABASE_URL`, `TOKEN_SECRET`, `GEMINI_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_PUBLIC=1` (web) · `REDASH_API_KEY`, `CHAT_BASE_URL` (cron). See `.env.example`.

## Analytics

`/admin` (password): opened → spoke → stayed to the offer → tapped, topics, and every chat. Download the CSV to match taps with recharges.
