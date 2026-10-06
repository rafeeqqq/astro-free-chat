// On-click lookup: when a /u/<user_id> link has no chat yet, find the user in the Redash query's result, build their
// chat (kundli included) and save it, so the link works without waiting for the daily sync.
//
// - Reads the query's stored result (no re-run per click) and keeps it in memory for cache_minutes, so a burst of
//   WhatsApp clicks is one Redash call per pod, not one per click. Concurrent clicks share the same request.
// - The list changes every morning (the retargeting journeys run 8:00–8:30 IST), so a stored result from before
//   today's list_ready_at (IST) is stale: the query is re-run once in the background (about 30 s).
// - A user who isn't in a stale result waits for that re-run (up to wait_on_miss_seconds) and is looked up again,
//   so someone added to today's list still gets their chat instead of the "link isn't working" page.
// - Only users in the query get a chat. Anyone else gets the friendly page.
import type { Loaded } from "../engine/engine.ts";
import type { Store } from "./store.ts";
import { fetchRedash, fetchRedashLatest, rowsToUsers, istDay, linkToken } from "./sync.ts";
import type { SyncRow } from "./sync.ts";

type Cache = { byUser: Map<string, SyncRow[]>; retrievedAt: string; loadedAt: number };
let cache: Cache | null = null;
let loading: Promise<Cache> | null = null;
let refreshing: Promise<Cache | null> | null = null;

export type LookupEnv = { redashUrl: string; apiKey: string; secret: string; fetchFn?: typeof fetch; now?: number };

/** The most recent moment the list was due to be ready (today at list_ready_at IST, or yesterday's if earlier). */
export function lastListReadyAt(listReadyAt: string, now = Date.now()): number {
  const [h, m] = listReadyAt.split(":").map(Number);
  const IST = 5.5 * 3_600_000;
  const istMidnight = Math.floor((now + IST) / 86_400_000) * 86_400_000 - IST;
  const today = istMidnight + (h * 60 + m) * 60_000;
  return now >= today ? today : today - 86_400_000;
}

const isStale = (L: Loaded, retrievedAt: string, now: number) =>
  new Date(retrievedAt).getTime() < lastListReadyAt(L.cfg.source!.on_click?.list_ready_at ?? "08:30", now);

function index(L: Loaded, rows: SyncRow[], retrievedAt: string, now: number): Cache {
  const byUser = new Map<string, SyncRow[]>();
  const idCol = L.cfg.source!.columns.user_id;
  for (const r of rows) {
    const id = String(r[idCol] ?? r[idCol.toLowerCase()] ?? "").trim();
    if (!id) continue;
    if (!byUser.has(id)) byUser.set(id, []);
    byUser.get(id)!.push(r);
  }
  return { byUser, retrievedAt, loadedAt: now };
}

async function rows(L: Loaded, env: LookupEnv): Promise<Cache> {
  const src = L.cfg.source!;
  const ttl = (src.on_click?.cache_minutes ?? 10) * 60_000;
  const now = env.now ?? Date.now();
  if (cache && now - cache.loadedAt < ttl) return cache;
  if (!loading) {
    loading = (async () => {
      const { rows, retrievedAt } = await fetchRedashLatest(env.redashUrl, src.redash_query_id, env.apiKey, env.fetchFn);
      cache = index(L, rows, retrievedAt, now);
      if (isStale(L, retrievedAt, now)) void refresh(L, env);
      return cache;
    })().finally(() => { loading = null; });
  }
  return loading;
}

/** Re-runs the query once (shared by every caller) and swaps the fresh result in. */
function refresh(L: Loaded, env: LookupEnv): Promise<Cache | null> {
  if (!refreshing) {
    console.log(`redash result is from before today's list (${L.cfg.source!.on_click?.list_ready_at ?? "08:30"} IST); re-running query ${L.cfg.source!.redash_query_id}`);
    refreshing = fetchRedash(env.redashUrl, L.cfg.source!.redash_query_id, env.apiKey, env.fetchFn, env.now ? 1 : 2000)
      .then((fresh) => (cache = index(L, fresh, new Date(env.now ?? Date.now()).toISOString(), env.now ?? Date.now())))
      .catch((err) => { console.error(`redash re-run failed: ${(err as Error).message}`); return null; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

/** Builds and saves today's chat for this user from the query, and returns its token; null if they aren't in it. */
export async function lookupUser(L: Loaded, store: Store, uid: string, env: LookupEnv): Promise<string | null> {
  const src = L.cfg.source;
  if (!src || src.on_click?.enabled === false || !env.apiKey || !env.secret) return null;
  let current = await rows(L, env);
  let mine = current.byUser.get(uid);
  // Not in a result from before today's list: wait for the re-run (bounded) and look again.
  if (!mine?.length && isStale(L, current.retrievedAt, env.now ?? Date.now())) {
    const waitMs = (src.on_click?.wait_on_miss_seconds ?? 45) * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fresh = await Promise.race([refresh(L, env), new Promise<null>((r) => { timer = setTimeout(() => r(null), waitMs); })]);
    clearTimeout(timer);
    if (fresh) { current = fresh; mine = current.byUser.get(uid); }
  }
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
export function resetLookupCache() { cache = null; loading = null; refreshing = null; }
