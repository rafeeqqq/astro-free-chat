// On-click lookup: when a /u/<user_id> link has no chat yet, find the user in the Redash query's latest result,
// build their chat (kundli included) and save it, so the link works without waiting for the daily sync.
//
// - Reads the query's stored result (no re-run per click) and keeps it in memory for cache_minutes, so a burst of
//   WhatsApp clicks is one Redash call per pod, not one per click. Concurrent clicks share the same request.
// - If that stored result is older than refresh_if_older_hours, a re-run is started in the background (once);
//   the click is served from what's there.
// - Only users in the query get a chat. Anyone else gets the friendly "link isn't working" page.
import type { Loaded } from "../engine/engine.ts";
import type { Store } from "./store.ts";
import { fetchRedash, fetchRedashLatest, rowsToUsers, istDay, linkToken } from "./sync.ts";
import type { SyncRow } from "./sync.ts";

type Cache = { byUser: Map<string, SyncRow[]>; retrievedAt: string; loadedAt: number };
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
let refreshing = false;

export type LookupEnv = { redashUrl: string; apiKey: string; secret: string; fetchFn?: typeof fetch; now?: number };

async function rows(L: Loaded, env: LookupEnv): Promise<Cache> {
  const src = L.cfg.source!;
  const ttl = (src.on_click?.cache_minutes ?? 10) * 60_000;
  const now = env.now ?? Date.now();
  if (cache && now - cache.loadedAt < ttl) return cache;
  if (!loading) {
    loading = (async () => {
      const { rows, retrievedAt } = await fetchRedashLatest(env.redashUrl, src.redash_query_id, env.apiKey, env.fetchFn);
      const byUser = new Map<string, SyncRow[]>();
      const idCol = src.columns.user_id;
      for (const r of rows) {
        const id = String(r[idCol] ?? r[idCol.toLowerCase()] ?? "").trim();
        if (!id) continue;
        if (!byUser.has(id)) byUser.set(id, []);
        byUser.get(id)!.push(r);
      }
      cache = { byUser, retrievedAt, loadedAt: env.now ?? Date.now() };
      maybeRefresh(L, env, retrievedAt);
      return cache;
    })().finally(() => { loading = null; });
  }
  return loading;
}

// The stored result is stale (the query didn't run today): re-run it once in the background for the next clicks.
function maybeRefresh(L: Loaded, env: LookupEnv, retrievedAt: string) {
  const maxAge = (L.cfg.source!.on_click?.refresh_if_older_hours ?? 26) * 3_600_000;
  if (refreshing || Date.now() - new Date(retrievedAt).getTime() < maxAge) return;
  refreshing = true;
  console.log(`redash result is from ${retrievedAt}; re-running query ${L.cfg.source!.redash_query_id} in the background`);
  fetchRedash(env.redashUrl, L.cfg.source!.redash_query_id, env.apiKey, env.fetchFn)
    .then(() => { cache = null; }) // next click loads the fresh result
    .catch((err) => console.error(`redash re-run failed: ${(err as Error).message}`))
    .finally(() => { refreshing = false; });
}

/** Builds and saves today's chat for this user from the query, and returns its token; null if they aren't in it. */
export async function lookupUser(L: Loaded, store: Store, uid: string, env: LookupEnv): Promise<string | null> {
  const src = L.cfg.source;
  if (!src || src.on_click?.enabled === false || !env.apiKey || !env.secret) return null;
  const { byUser } = await rows(L, env);
  const mine = byUser.get(uid);
  if (!mine?.length) return null;
  const day = istDay(0, env.now);
  const { users } = rowsToUsers(L.cfg, src, mine, { secret: env.secret, day });
  const user = users[0]?.user;
  if (!user) return null; // e.g. no valid date of birth
  user.token = linkToken(env.secret, uid, day); // the same token the daily sync would make, so both paths agree
  await store.upsertUsers([user]);
  return user.token;
}

/** For tests. */
export function resetLookupCache() { cache = null; loading = null; refreshing = false; }
