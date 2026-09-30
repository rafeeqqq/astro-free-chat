// Turns the analytics list into a pilot.
//
//   node scripts/import-users.ts <list.csv> --seed <any-text> [--pilot-share 50] [--base-url https://chat.astrolokal.com]
//
// Input CSV columns (header row required):
//   user_id, phone, name, gender, dob (YYYY-MM-DD), tob (HH:MM or empty), pob, language,
//   moon_sign, mahadasha, antardasha, lagna, last_topic, last_summary, last_consult_date, consult_count,
//   planets (optional, from the wrapper: "Su:Mesh 12.4;Ma:Kark 3.1;..." — drawn on the kundli card),
//   cohort (optional: lapsed | low_balance | zero_balance … see config.cohorts; empty = default_cohort),
//   wallet_balance (optional number: > 0 sends the CTA straight to a chat, else to recharge)
//
// What it does:
//   1. Validates every row; skips bad ones and says why.
//   2. Splits users into PILOT and HOLDOUT, deterministically from --seed (same seed → same split).
//   3. Gives each pilot user an unguessable token (HMAC of user_id with TOKEN_SECRET, so re-running the
//      import gives the same token) and saves only chat fields to the store (no phone, no user_id).
//   4. Writes to ./out (git-ignored, keep private):
//        wati_pilot.csv   phone, name, token, link  → upload to WATI
//        pilot_map.csv    user_id, token, cohort    → join web events to recharges
//        holdout.csv      user_id, cohort           → the control group, never messaged (compare per cohort)
//        import_report.txt

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash, createHmac } from "node:crypto";
import { load } from "../src/engine/engine.ts";
import type { UserInput } from "../src/engine/engine.ts";
import { getStore } from "../src/lib/store.ts";
import { parsePlanets, signIndex } from "../src/lib/kundli.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : fallback;
}

export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [], field = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') q = false;
      else field += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim() !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== "")) rows.push(row);
  const [header, ...data] = rows;
  const keys = header.map((h) => h.trim().toLowerCase());
  return data.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

async function main() {
  const file = process.argv[2];
  const seed = arg("seed");
  const pilotShare = Number(arg("pilot-share", "50"));
  const baseUrl = (arg("base-url", "https://chat.astrolokal.com") ?? "").replace(/\/$/, "");
  if (!file || !seed) {
    console.error("usage: node scripts/import-users.ts <list.csv> --seed <text> [--pilot-share 50] [--base-url URL]");
    process.exit(1);
  }

  const secret = process.env.TOKEN_SECRET;
  if (!secret || secret.length < 16) {
    console.error("Set TOKEN_SECRET (16+ random characters) in .env. Keep it private and never change it mid-pilot.");
    process.exit(1);
  }
  const { cfg } = load();
  const rows = parseCsv(readFileSync(file, "utf8"));
  const skipped: string[] = [];
  const seen = new Set<string>();
  const pilot: { row: Record<string, string>; user: UserInput }[] = [];
  const holdout: [string, string][] = [];

  for (const [i, r] of rows.entries()) {
    const line = `row ${i + 2}`;
    const id = r.user_id || r.phone;
    const missing = ["user_id", "phone", "name", "dob", "moon_sign", "mahadasha", "antardasha"].filter((k) => !r[k]);
    if (missing.length) { skipped.push(`${line}: missing ${missing.join(", ")}`); continue; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r.dob)) { skipped.push(`${line}: dob must be YYYY-MM-DD`); continue; }
    if (r.tob && !/^\d{1,2}:\d{2}$/.test(r.tob)) { skipped.push(`${line}: tob must be HH:MM or empty`); continue; }
    if (seen.has(id) || seen.has(r.phone)) { skipped.push(`${line}: duplicate user`); continue; }
    seen.add(id); seen.add(r.phone);

    // Deterministic split: same seed + user → same group, every time.
    const bucket = createHash("sha256").update(`${seed}:${id}`).digest().readUInt32BE(0) % 100;
    const cohort = r.cohort && cfg.cohorts?.[r.cohort] ? r.cohort : cfg.default_cohort ?? "";
    if (r.cohort && cohort !== r.cohort) skipped.push(`${line}: unknown cohort '${r.cohort}' (kept, treated as ${cohort})`);
    if (bucket >= pilotShare) { holdout.push([r.user_id, cohort]); continue; }

    if (signIndex(r.moon_sign) < 0) { skipped.push(`${line}: moon_sign "${r.moon_sign}" is not a rashi`); continue; }
    if (r.planets) for (const p of parsePlanets(r.planets).problems) skipped.push(`${line}: planets: ${p} (skipped on chart)`);
    const topic = r.last_topic && cfg.topics[r.last_topic] ? r.last_topic : null;
    if (r.last_topic && !topic) skipped.push(`${line}: unknown last_topic '${r.last_topic}' (kept, generic hook)`);
    pilot.push({
      row: r,
      user: {
        token: createHmac("sha256", secret).update(`${cfg.experiment.id}:${id}`).digest("base64url").slice(0, 16),
        name: r.name, gender: r.gender || null, dob: r.dob, tob: r.tob || null, pob: r.pob || null,
        language: r.language || null, moon_sign: r.moon_sign, mahadasha: r.mahadasha, antardasha: r.antardasha,
        lagna: r.lagna || null, last_topic: topic, last_summary: r.last_summary || null,
        last_consult_date: r.last_consult_date || null, consult_count: r.consult_count ? Number(r.consult_count) : null,
        planets: r.planets || null,
        cohort: cohort || null,
        wallet_balance: r.wallet_balance && Number.isFinite(Number(r.wallet_balance)) ? Number(r.wallet_balance) : null,
      },
    });
  }

  await getStore().upsertUsers(pilot.map((p) => p.user));

  mkdirSync("out", { recursive: true });
  writeFileSync("out/wati_pilot.csv", toCsv([["phone", "name", "token", "link", "topic"],
    ...pilot.map((p) => [p.row.phone, p.user.name.split(" ")[0], p.user.token, `${baseUrl}/c/${p.user.token}`, p.user.last_topic ?? "default"])]));
  writeFileSync("out/pilot_map.csv", toCsv([["user_id", "token", "cohort"], ...pilot.map((p) => [p.row.user_id, p.user.token, p.user.cohort ?? ""])]));
  writeFileSync("out/holdout.csv", toCsv([["user_id", "cohort"], ...holdout]));
  const withTopic = pilot.filter((p) => p.user.last_topic).length;
  const report = [
    `experiment: ${cfg.experiment.id} · prompt ${cfg.experiment.prompt_version} · seed "${seed}" · pilot share ${pilotShare}%`,
    `rows read: ${rows.length}`,
    `pilot: ${pilot.length} (with last_topic: ${withTopic}, ${pilot.length ? Math.round((withTopic / pilot.length) * 100) : 0}%)`,
    `holdout: ${holdout.length}`,
    `by cohort (pilot / holdout): ${[...new Set([...pilot.map((p) => p.user.cohort ?? ""), ...holdout.map((h) => h[1])])]
      .map((c) => `${c || "none"} ${pilot.filter((p) => (p.user.cohort ?? "") === c).length}/${holdout.filter((h) => h[1] === c).length}`).join(" · ")}`,
    `skipped / notes: ${skipped.length}`,
    ...skipped.map((s) => `  - ${s}`),
  ].join("\n");
  writeFileSync("out/import_report.txt", report + "\n");
  console.log(report);
  process.exit(0);
}

if (import.meta.filename === process.argv[1]) void main();
