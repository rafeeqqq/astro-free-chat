// Same as /u/<user_id>, for tools that put the id in a parameter: /u?user_id=123 (also ?uid= or ?id=).
// Everything else on the link (utm tags, the optional signature) is passed through.
import { GET as byPath } from "./[uid]/route";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const uid = (q.get("user_id") ?? q.get("uid") ?? q.get("id") ?? "").trim();
  return byPath(req, { params: Promise.resolve({ uid }) });
}
