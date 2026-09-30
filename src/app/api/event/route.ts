import { recordEvent } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";

// Funnel events from the chat page (also sent with navigator.sendBeacon, so it accepts text bodies).
export async function POST(req: Request) {
  const body = await readJson(req);
  const props = body.props && typeof body.props === "object" ? (body.props as Record<string, unknown>) : {};
  const ok = await recordEvent(String(body.token ?? ""), String(body.name ?? ""), props);
  return Response.json({ ok }, { ...noStore, status: ok ? 200 : 400 });
}
