// node scripts/cli.ts check                 → validate config/config.yaml + prompt_template.md
// node scripts/cli.ts prodcheck             → pass/fail list of everything that must be true before real users get links
// node scripts/cli.ts preview [--prompt]    → opening/closing/screen copy for the sample users
// node scripts/cli.ts seed [--port 3100]    → load samples/users.yaml, start the demo chats fresh,
//                                             and print links (localhost + this Mac's Wi-Fi address for phones/teammates)

import { readFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { parse } from "yaml";
import { load, buildContext, newSession, openingBubbles, closingBubbles, buildSystemPrompt, uiText, handoffUrl } from "../src/engine/engine.ts";
import type { UserInput } from "../src/engine/engine.ts";
import { getStore } from "../src/lib/store.ts";

async function main() {
  const cmd = process.argv[2] ?? "check";
  const L = load();
  if (cmd === "check") {
    console.log(`config OK · ${L.cfg.experiment.id} · ${L.cfg.experiment.prompt_version} · hash ${L.configHash}`);
    console.log(`arms: ${L.cfg.experiment.arms.map((a) => `${a.id} ${a.weight}% (${a.insight_level})`).join(", ")}`);
    const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || "";
    const keyState = !key ? "NOT set → local chats use canned replies"
      : /^PASTE|REPLACE|YOUR_/i.test(key) || key.length < 20 ? "is still a placeholder → replace it in .env.local"
      : "set";
    console.log(`model: ${L.cfg.model.name} (thinking: ${L.cfg.model.thinking ?? "default"}) · GEMINI_API_KEY ${keyState}`);
    const override = process.env.GEMINI_MODEL?.trim();
    if (override && !/^gemini-[\w.-]+$/.test(override))
      console.warn("⚠ GEMINI_MODEL in .env.local is not a model id (is the key pasted there by mistake?). It is ignored; clear that line.");
    for (const k of ["deeplink_with_balance", "deeplink_no_balance"] as const)
      if (/REPLACE_ME|play\.google\.com/.test(L.cfg.handoff[k]))
        console.warn(`⚠ handoff.${k} is the Play Store stand-in. Swap in Yatharth's deep link before the pilot send.`);
    console.log(`cohorts: ${Object.keys(L.cfg.cohorts ?? {}).join(", ") || "none"} (default ${L.cfg.default_cohort ?? "–"})`);
    return;
  }
  if (cmd === "prodcheck") {
    // Values are never printed, only whether each requirement holds.
    const env = process.env;
    const key = env.GEMINI_API_KEY ?? "";
    const rawConfig = readFileSync("config/config.yaml", "utf8");
    const checks: [boolean, string][] = [
      [!!env.DATABASE_URL, "DATABASE_URL is set (Postgres; the container refuses to run without it)"],
      [key.length >= 30 && !/^PASTE|REPLACE|YOUR_/i.test(key), "GEMINI_API_KEY is a real key (and a rotated one: the old key was shared in chat)"],
      [(env.ADMIN_PASSWORD ?? "").length >= 12, "ADMIN_PASSWORD is strong (12+ characters)"],
      [env.ADMIN_PUBLIC === "1", "ADMIN_PUBLIC=1 so /admin opens on the real domain"],
      [(env.TOKEN_SECRET ?? "").length >= 16, "TOKEN_SECRET is set (16+ characters; never change it mid-pilot)"],
      [!!env.REDASH_API_KEY, "REDASH_API_KEY is set where the daily sync runs (Devtron cron)"],
      [L.cfg.source?.links?.require_signature === true, "source.links.require_signature is on (otherwise a user_id in a link can be changed by hand)"],
      [!env.MOCK_LLM, "MOCK_LLM is empty"],
      ...(["deeplink_with_balance", "deeplink_no_balance"] as const).map((k): [boolean, string] =>
        [!/REPLACE_ME|play\.google\.com/.test(L.cfg.handoff[k]), `handoff.${k} is Yatharth's deep link, not the Play Store stand-in`]),
      [!/TODO/.test(rawConfig), "no TODO left in config.yaml (e.g. offer copy to confirm)"],
    ];
    for (const [ok, what] of checks) console.log(`${ok ? "✓" : "✗"} ${what}`);
    const failed = checks.filter(([ok]) => !ok).length;
    console.log(failed ? `\n${failed} to fix before the pilot send.` : "\nReady for real users.");
    process.exitCode = failed ? 1 : 0;
    return;
  }
  const users = parse(readFileSync("samples/users.yaml", "utf8")) as UserInput[];
  if (cmd === "seed") {
    const all = users;
    await getStore().upsertUsers(all);
    await getStore().resetSessions(all.map((u) => u.token));
    const port = process.argv.includes("--port") ? process.argv[process.argv.indexOf("--port") + 1] : "3100";
    const lan = Object.values(networkInterfaces()).flat().find((n) => n && n.family === "IPv4" && !n.internal)?.address;
    const host = lan ? `http://${lan}:${port}` : `http://localhost:${port}`;
    console.log(`${all.length} test chats reset. Links (${lan ? "same Wi-Fi" : "this Mac only"}):`);
    for (const u of all) console.log(`  ${host}/c/${u.token}   ${u.name}${u.last_topic ? ` · ${u.last_topic}` : ""}${u.tob ? "" : " · no birth time"}`);
    console.log(`Admin: ${host}/admin`);
    return;
  }
  if (cmd === "preview") {
    for (const u of users) {
      const ctx = buildContext(L.cfg, u);
      const ui = uiText(L.cfg, ctx);
      console.log(`\n══ ${u.name} · arm ${ctx.arm.id} ══`);
      console.log("DETAILS  →", ui.details_message.replace(/\n/g, " / "));
      console.log("OPENING  →", openingBubbles(L.cfg, ctx).join("  |  "));
      console.log("CLOSING  →", closingBubbles(L.cfg, ctx).join("  |  "));
      console.log("CARD     →", ui.card_text);
      console.log("LINK     →", handoffUrl(L, u.token));
      if (process.argv.includes("--prompt")) console.log("\n" + buildSystemPrompt(L, ctx, newSession(ctx)));
    }
    return;
  }
  console.log("usage: node scripts/cli.ts check | prodcheck | preview [--prompt] | seed");
}

main().then(() => process.exit(0)).catch((e) => { console.error((e as Error).message); process.exit(1); });
