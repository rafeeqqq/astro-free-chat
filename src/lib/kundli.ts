// Builds the North-Indian chart shown in the chat from the user's real data. Nothing is invented:
//   - houses are numbered from the lagna (or from the moon sign when birth time is unknown: Chandra kundli)
//   - "Asc" and the Moon are always placed (we know lagna + moon sign)
//   - other planets appear only if the wrapper supplied them (user.planets)
// Pure module: used on the server, the result is sent to the chat screen ready to draw.

export const SIGNS: string[][] = [
  ["mesh", "mesha", "aries"], ["vrishabh", "vrishabha", "vrish", "taurus"], ["mithun", "mithuna", "gemini"],
  ["kark", "karka", "cancer"], ["singh", "simha", "leo"], ["kanya", "virgo"], ["tula", "libra"],
  ["vrishchik", "vrishchika", "scorpio"], ["dhanu", "dhanus", "sagittarius"], ["makar", "makara", "capricorn"],
  ["kumbh", "kumbha", "aquarius"], ["meen", "meena", "pisces"],
];

// Short labels in the order astrologers usually list them.
export const PLANETS: Record<string, string[]> = {
  Su: ["su", "sun", "surya"], Mo: ["mo", "moon", "chandra"], Ma: ["ma", "mars", "mangal"], Me: ["me", "mercury", "budh"],
  Ju: ["ju", "jupiter", "guru", "brihaspati"], Ve: ["ve", "venus", "shukra"], Sa: ["sa", "saturn", "shani"],
  Ra: ["ra", "rahu"], Ke: ["ke", "ketu"],
};

/** 0–11, or -1 if the name isn't a sign. */
export function signIndex(name: string | null | undefined): number {
  const n = (name ?? "").trim().toLowerCase();
  return SIGNS.findIndex((aliases) => aliases.includes(n));
}

export type PlanetPos = { abbr: string; sign: number; deg: number | null };

/**
 * Accepts either an object {Su: "Mesh 12.4", Ma: "Kark"} (YAML/JSON) or the CSV form
 * "Su:Mesh 12.4;Ma:Kark". Unknown planets or signs are skipped (and reported).
 */
export function parsePlanets(input: unknown): { planets: PlanetPos[]; problems: string[] } {
  const entries: [string, string][] =
    typeof input === "string"
      ? input.split(";").map((p) => p.split(":").map((x) => x.trim()) as [string, string]).filter(([k, v]) => k && v)
      : input && typeof input === "object"
        ? Object.entries(input as Record<string, unknown>).map(([k, v]) => [k, String(v)])
        : [];
  const planets: PlanetPos[] = [];
  const problems: string[] = [];
  for (const [rawName, rawPos] of entries) {
    const abbr = Object.keys(PLANETS).find((k) => PLANETS[k].includes(rawName.toLowerCase()));
    const [signName, degText] = rawPos.split(/\s+/);
    const sign = signIndex(signName);
    if (!abbr) { problems.push(`unknown planet "${rawName}"`); continue; }
    if (sign < 0) { problems.push(`${abbr}: unknown sign "${signName}"`); continue; }
    const deg = degText !== undefined && !Number.isNaN(Number(degText)) ? Number(degText) : null;
    planets.push({ abbr, sign, deg: deg !== null && deg >= 0 && deg < 30 ? deg : null });
  }
  return { planets, problems };
}

export type KundliView = {
  basis: "lagna" | "moon";     // which sign sits in house 1
  houses: { sign: number; items: string[] }[]; // 12 houses; sign is 1–12; items like "Asc", "Mo 19.5°"
};

export function buildKundli(opts: {
  lagna?: string | null; tobKnown: boolean; moonSign: string; planets?: unknown;
}): KundliView | null {
  const moon = signIndex(opts.moonSign);
  if (moon < 0) return null;
  const lagna = opts.tobKnown ? signIndex(opts.lagna) : -1;
  const basis: KundliView["basis"] = lagna >= 0 ? "lagna" : "moon";
  const first = basis === "lagna" ? lagna : moon;

  const houses = Array.from({ length: 12 }, (_, i) => ({ sign: ((first + i) % 12) + 1, items: [] as string[] }));
  const houseOf = (sign: number) => (sign - first + 12) % 12;
  const label = (p: PlanetPos) => (p.deg === null ? p.abbr : `${p.abbr} ${p.deg.toFixed(1)}°`);

  if (basis === "lagna") houses[0].items.push("Asc");
  const { planets } = parsePlanets(opts.planets);
  const moonGiven = planets.find((p) => p.abbr === "Mo");
  // The moon sign we were given is the source of truth; a supplied Mo entry only adds its degree.
  const all = [
    { abbr: "Mo", sign: moon, deg: moonGiven && moonGiven.sign === moon ? moonGiven.deg : null },
    ...planets.filter((p) => p.abbr !== "Mo"),
  ];
  for (const p of all) houses[houseOf(p.sign)].items.push(label(p));
  return { basis, houses };
}
