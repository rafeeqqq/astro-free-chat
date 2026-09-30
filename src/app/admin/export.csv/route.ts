import { getStore } from "@/lib/store";
import { config } from "@/lib/chat";
import { analyse, toCsv } from "@/lib/analytics";

export const dynamic = "force-dynamic";

// Every chat as one CSV row (same filters as /admin), for joining with Astrolokal recharges on token.
// Protected by the same password as /admin (src/proxy.ts matches /admin/*).
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const store = getStore();
  const [sessions, turns, events] = await Promise.all([store.recentSessions(50000), store.recentTurnLogs(200000), store.events(200000)]);
  const r = analyse(config().cfg, sessions, turns, events, {
    version: q.get("v") || undefined, cohort: q.get("c") || undefined, includeTests: q.get("tests") === "1",
  });
  const day = new Date().toISOString().slice(0, 10);
  return new Response(toCsv(r.chats), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="ai_free_chat_${day}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
