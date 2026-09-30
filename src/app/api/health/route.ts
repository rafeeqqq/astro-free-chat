import { getStore } from "@/lib/store";
import { config } from "@/lib/chat";

export const dynamic = "force-dynamic";

// For Devtron's liveness/readiness probes: the config loads and the database answers. No personal data.
export async function GET() {
  try {
    const L = config();
    await getStore().getUser("healthcheck-probe");
    return Response.json({ ok: true, version: L.cfg.experiment.prompt_version }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return Response.json({ ok: false, error: (err as Error).message.split("\n")[0] }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
