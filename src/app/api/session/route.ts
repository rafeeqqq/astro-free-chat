import { startOrResume } from "@/lib/chat";
import { readJson, noStore } from "../_body";

export const dynamic = "force-dynamic";

// Opens (or resumes) the free chat for a token. `restart: true` only works in local development.
export async function POST(req: Request) {
  const body = await readJson(req);
  const view = await startOrResume(String(body.token ?? ""), body.restart === true);
  return Response.json(view, { ...noStore, status: view.status === "invalid" ? 404 : 200 });
}
