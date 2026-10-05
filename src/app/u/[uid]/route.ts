import { getStore } from "@/lib/store";
import { config } from "@/lib/chat";
import { resolveUserLink, linkAllowed } from "@/lib/sync";
import { lookupUser } from "@/lib/lookup";

export const dynamic = "force-dynamic";

// The WATI link: /u/<user_id>. Opens that user's chat for their latest send day (today, else the last few days).
// No chat yet → the user is looked up in the Redash query right now (src/lib/lookup.ts), their chat is built and opened.
// Not in the query → the friendly "link isn't working" page with a button to the app.
// Optional ?s=<signature> (source.links.require_signature).
export async function GET(req: Request, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  const url = new URL(req.url);
  let token: string | null = null;
  try {
    const store = getStore();
    const L = config();
    const secret = process.env.TOKEN_SECRET ?? "";
    const sig = url.searchParams.get("s");
    token = await resolveUserLink((t) => store.getUser(t), secret, uid, sig, L.cfg.source?.links);
    if (!token && linkAllowed(secret, uid, sig, L.cfg.source?.links)) {
      token = await lookupUser(L, store, uid, {
        redashUrl: process.env.REDASH_URL ?? "https://analytics.getlokalapp.com",
        apiKey: process.env.REDASH_API_KEY ?? "",
        secret,
      });
    }
  } catch (err) {
    console.error("user link failed:", (err as Error).message.split("\n")[0]); // e.g. database down: friendly page, not an error
  }
  const keep = new URLSearchParams(url.search);
  for (const k of ["s", "user_id", "uid", "id"]) keep.delete(k); // the user_id never travels into the chat address
  const q = keep.size ? `?${keep}` : "";
  // Relative redirect: stays on the domain the user opened; never cached (the target changes by day).
  return new Response(null, { status: 302, headers: { Location: token ? `/c/${token}${q}` : `/c/unknown${q}`, "Cache-Control": "no-store" } });
}
