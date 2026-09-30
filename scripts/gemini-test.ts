// npm run gemini-test → one real Gemini call with the live prompt, to confirm the key and model work.
// Prints the raw reply, what the guard keeps, and how long it took. Uses the first sample user.

import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { load, buildContext, newSession, openingBubbles, runTurn } from "../src/engine/engine.ts";
import type { UserInput } from "../src/engine/engine.ts";
import { callModel, isMock } from "../src/lib/llm.ts";

const L = load();
if (isMock()) {
  console.error("GEMINI_API_KEY is not set (add it to .env.local). Nothing was sent.");
  process.exit(1);
}
const [user] = parse(readFileSync("samples/users.yaml", "utf8")) as UserInput[];
const ctx = buildContext(L.cfg, user);
const st = newSession(ctx);
const history = openingBubbles(L.cfg, ctx).map((text) => ({ role: "ai" as const, text }));
const question = process.argv[2] ?? "shaadi kab hogi?";

let raw = "";
const spy: typeof callModel = async (args) => (raw = await callModel(args));
const { bubbles, log } = await runTurn(L, ctx, st, question, 90, spy, history);

console.log(`model     ${L.cfg.model.name} (thinking: ${L.cfg.model.thinking ?? "default"})`);
console.log(`question  ${question}`);
console.log(`raw       ${raw || "(no reply)"}`);
console.log(`shown     ${bubbles.join("  |  ")}`);
console.log(`flags     ${log.flags.join(", ") || "none"}${log.used_fallback ? " · FALLBACK USED" : ""}`);
console.log(`latency   ${log.latency_ms} ms`);
process.exit(log.flags.includes("llm_error") || log.flags.includes("llm_timeout") ? 1 : 0);
