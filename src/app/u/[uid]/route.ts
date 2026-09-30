import { getStore } from "@/lib/store";
import { config } from "@/lib/chat";
import { resolveUserLink } from "@/lib/sync";

export const dynamic = "force-dynamic";

// The WATI link: /u/<user_id>. Opens that user's chat for their latest send day (today, else the last few days),
// already filled with their details and kundli from the daily sync. Anyone not in a recent sync gets the friendly
// "link isn't working" page with a button to the app. Optional ?s=<signature> (source.links.require_signature).
export async function GET(req: Request, { params }: { params: Promise<{ uid: string }> }) {
  const { uid } = await params;
  const url = new URL(req.url);
  let token: string | null = null;
  try {
    const store = getStore();
    token = await resolveUserLink(
      (t) => store.getUser(t), process.env.TOKEN_SECRET ?? "", uid, url.searchParams.get("s"), config().cfg.source?.links,
    );
  } catch (err) {
    console.error("user link failed:", (err as Error).message.split("\n")[0]); // e.g. database down: friendly page, not an error
  }
  const keep = new URLSearchParams(url.search);
  keep.delete("s");
  const q = keep.size ? `?${keep}` : "";
  // Relative redirect: stays on the domain the user opened; never cached (the target changes by day).
  return new Response(null, { status: 302, headers: { Location: token ? `/c/${token}${q}` : `/c/unknown${q}`, "Cache-Control": "no-store" } });
}
