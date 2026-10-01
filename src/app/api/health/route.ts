import { getStore } from "@/lib/store";
import { config } from "@/lib/chat";

export const dynamic = "force-dynamic";

// For Devtron's liveness/readiness probes: the config loads and the database answers. No personal data.
// A failure is also written to the pod log (at most once a minute per reason), so the cause shows up in Devtron → Logs.
let lastLogged = { reason: "", at: 0 };
const HINT: [RegExp, string][] = [
  [/relation ".*" does not exist/, "run the migration: node scripts/migrate.ts (CD pre-deployment stage)"],
  [/DATABASE_URL is not set/, "attach the secret with DATABASE_URL to this environment"],
  [/ECONNREFUSED|ENOTFOUND|timeout|ETIMEDOUT/i, "the database isn't reachable: check the host in DATABASE_URL and the network"],
  [/password authentication|role .* does not exist/i, "wrong user or password in DATABASE_URL"],
];

export async function GET() {
  try {
    const L = config();
    await getStore().ping(); // fails until `npm run db:migrate` has run: the pod stays out of the load balancer
    return Response.json({ ok: true, version: L.cfg.experiment.prompt_version }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const reason = (err as Error).message.split("\n")[0];
    if (reason !== lastLogged.reason || Date.now() - lastLogged.at > 60_000) {
      lastLogged = { reason, at: Date.now() };
      const hint = HINT.find(([re]) => re.test(reason))?.[1];
      console.error(`health check failing: ${reason}${hint ? ` → ${hint}` : ""}`);
    }
    return Response.json({ ok: false, error: (err as Error).message.split("\n")[0] }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
