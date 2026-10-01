# Astrolokal AI free chat

A lapsed user taps a WhatsApp link → a 2-minute free chat with Astro Omkar (their own kundli) → "Talk to astrologer" opens the app.

## Flow

```
Redash query (daily) → npm run sync → users + kundli saved
WhatsApp link /u/{user_id} (or /u?user_id={user_id}) → their chat → button → Astrolokal app
```

## Change the experience

Edit `config/config.yaml` (text, timing, offer, button link) or `config/prompt_template.md` (how Omkar talks).
Bump `prompt_version` on every change so `/admin` shows results per version.

## Commands

| Command | Does |
|---|---|
| `docker compose up --build` | Run everything locally (Postgres + migration + app) on http://localhost:3000 |
| `npm run dev` | Run the app alone (no database needed) |
| `npm run verify` | Check config + tests. Run before every push |
| `npm run sync` | Load today's users from Redash (daily cron) |
| `npm run db:generate` | After changing `src/db/schema.ts`: writes the new migration to `drizzle/` (commit it) |
| `npm run db:migrate` | Applies pending migrations once (deploy step) |
| `npm run prodcheck` | ✓/✗ list before going live |

## Deploy (Devtron)

One image (`Dockerfile`, Node 24), three uses:
1. **Migrate**: `node scripts/migrate.ts` as a pre-deploy job, once per deploy, before new pods start.
2. **Web**: the default command; any number of pods (port 3000, readiness `/api/health`, which fails until migrations ran).
3. **Sync**: daily cron, `node scripts/sync.ts`.

Env: `DATABASE_URL` (any Postgres; add `?sslmode=require` for managed ones), `DB_POOL_MAX`, `TOKEN_SECRET`, `GEMINI_API_KEY`, `ADMIN_PASSWORD`, `ADMIN_PUBLIC=1` (web) · `REDASH_API_KEY`, `CHAT_BASE_URL` (cron). See `.env.example`.

## Analytics

`/admin` (password): opened → spoke → stayed to the offer → tapped, topics, and every chat. Download the CSV to match taps with recharges.
