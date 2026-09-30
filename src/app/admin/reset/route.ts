import { getStore, isTestToken } from "@/lib/store";

export const dynamic = "force-dynamic";

// Resets internal test chats so the team can go again. Protected by the same password as /admin (src/proxy.ts).
// Only test tokens (t_team_… / t_demo_…) can ever be reset, never a real pilot user.
export async function POST(req: Request) {
  const form = await req.formData();
  const store = getStore();
  const token = String(form.get("token") ?? "");
  const tokens = token === "all" ? (await store.testUsers()).map((u) => u.token) : isTestToken(token) ? [token] : [];
  if (tokens.length) await store.resetSessions(tokens);
  // Relative redirect: stays on whatever address the tester used (Wi-Fi IP, domain), never "localhost".
  return new Response(null, { status: 303, headers: { Location: "/admin#test-links" } });
}
