// One-off: adds the user_id to users saved before it was stored (chats are filed under a code made from
// TOKEN_SECRET + user_id + day, which can't be reversed, so the codes are recreated from the Redash list).
//
//   node scripts/backfill-user-ids.ts [--days 7] [--dry-run]
//
// Env: DATABASE_URL, TOKEN_SECRET (the same as the app), REDASH_API_KEY. Covers everyone in the query's latest
// result, for each of the last --days days. Safe to run again: only rows without a user_id are touched.
import { load } from "../src/engine/engine.ts";
import { createSql } from "../src/db/client.ts";
import { fetchRedashLatest, linkToken, istDay } from "../src/lib/sync.ts";

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i > -1 ? process.argv[i + 1] : d; };
const days = Number(arg("days", "7"));
const dryRun = process.argv.includes("--dry-run");

async function main() {
  const { cfg } = load();
  const src = cfg.source!;
  const secret = process.env.TOKEN_SECRET ?? "";
  if (secret.length < 16) throw new Error("Set TOKEN_SECRET (the same one the app uses).");
  if (!process.env.DATABASE_URL) throw new Error("Set DATABASE_URL.");
  const { rows } = await fetchRedashLatest(process.env.REDASH_URL ?? "https://analytics.getlokalapp.com", src.redash_query_id, process.env.REDASH_API_KEY ?? "");
  const ids = [...new Set(rows.map((r) => String(r[src.columns.user_id] ?? "").trim()).filter(Boolean))];
  const tokens: string[] = [], uids: string[] = [];
  for (const uid of ids) for (let back = 0; back < days; back++) { tokens.push(linkToken(secret, uid, istDay(back))); uids.push(uid); }

  const sql = createSql(process.env.DATABASE_URL, { max: 1 });
  try {
    const [{ n }] = await sql`
      select count(*)::int as n from fc_users u join unnest(${tokens}::text[], ${uids}::text[]) as m(token, uid) on m.token = u.token
      where u.data->>'user_id' is null`;
    console.log(`${ids.length} user ids in the query × ${days} days → ${n} saved users can get their user_id${dryRun ? " (dry run: nothing changed)" : ""}`);
    if (!dryRun && n > 0) {
      const res = await sql`
        update fc_users u set data = jsonb_set(u.data, '{user_id}', to_jsonb(m.uid))
        from unnest(${tokens}::text[], ${uids}::text[]) as m(token, uid)
        where m.token = u.token and u.data->>'user_id' is null`;
      console.log(`updated ${res.count} users`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => { console.error(`backfill failed: ${(err as Error).message}`); process.exit(1); });
