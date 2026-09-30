// The one place the app talks to a model: Google Gemini, directly (Gemini API key).
//
//   GEMINI_API_KEY   the key from Google AI Studio (GOOGLE_GENERATIVE_AI_API_KEY also works)
//   model settings   config/config.yaml → model: (name, thinking, temperature, max_output_tokens)
//
// Locally, MOCK_LLM=1 (or no key) gives canned replies so the flow can be tested offline.
// In production there is never a mock: a missing key is an error, the engine sends its fallback
// line, and /admin shows "llm_error".

import { generateText } from "ai";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LLMFn, ChatMessage } from "../engine/engine.ts";

const MOCK_LINES = [
  "Aapki kundli mein is baat ke achhe sanket hain || Par ek graha ka prabhav hai, use dhyaan se dekhna hoga",
  "Yeh detail mein dekhne wali baat hai",
  "Kundli ke hisaab se aage achha samay hai || Ek graha ka asar zaroor dekhna chahiye",
];

function apiKey(): string | undefined {
  return process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || undefined;
}

export function isMock(): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return process.env.MOCK_LLM === "1" || !apiKey();
}

let provider: ReturnType<typeof createGoogleGenerativeAI> | null = null;
function gemini() {
  const key = apiKey();
  if (!key) throw new Error("GEMINI_API_KEY is not set");
  if (!provider) provider = createGoogleGenerativeAI({ apiKey: key });
  return provider;
}

// Gemini wants the conversation to start with the user and to alternate turns.
// Our chat opens with scripted AI lines, so: add a neutral first user turn, and merge back-to-back
// bubbles from the same side into one turn.
export function toGeminiMessages(messages: ChatMessage[]) {
  const out: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    const role = m.role === "ai" ? "assistant" : "user";
    const last = out[out.length - 1];
    if (last && last.role === role) last.content += "\n" + m.text;
    else out.push({ role, content: m.text });
  }
  if (out[0]?.role !== "user") out.unshift({ role: "user", content: "Namaste" });
  return out;
}

// Gemini 2.5 uses a token budget for thinking; Gemini 3+ uses a level. A short chat reply needs little.
function thinkingOptions(modelId: string, level: string | undefined) {
  if (!level) return undefined;
  if (modelId.startsWith("gemini-2.5")) return { thinkingBudget: level === "minimal" ? 0 : 1024 };
  return { thinkingLevel: level as "minimal" | "low" | "medium" | "high" };
}

export const callModel: LLMFn = async ({ system, messages, model, timeoutMs }) => {
  if (isMock()) {
    await new Promise((r) => setTimeout(r, Number(process.env.MOCK_LLM_DELAY_MS ?? 600)));
    return MOCK_LINES[messages.length % MOCK_LINES.length];
  }
  // GEMINI_MODEL is an optional override for quick tests; anything that isn't a Gemini model id is ignored.
  const override = process.env.GEMINI_MODEL?.trim();
  const modelId = override && /^gemini-[\w.-]+$/.test(override) ? override : model.name;
  const thinkingConfig = thinkingOptions(modelId, model.thinking);
  const { text } = await generateText({
    model: gemini()(modelId),
    instructions: system,
    messages: toGeminiMessages(messages),
    temperature: model.temperature,
    maxOutputTokens: model.max_output_tokens,
    maxRetries: 0, // the engine does its own single retry within the time budget
    timeout: timeoutMs,
    providerOptions: thinkingConfig ? { google: { thinkingConfig } } : undefined,
  });
  return text;
};
