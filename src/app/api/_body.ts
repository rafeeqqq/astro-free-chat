// Small helper: read a JSON body safely (size-capped, never throws).
export async function readJson(req: Request, maxBytes = 4096): Promise<Record<string, unknown>> {
  try {
    const raw = await req.text();
    if (raw.length > maxBytes) return {};
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export const noStore = { headers: { "Cache-Control": "no-store" } };
