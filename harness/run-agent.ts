/**
 * End-to-end build against a real model provider.
 *
 * Exercises the exact loop the extension runs, with a fixture/fetch bridge
 * standing in for chrome.history and chrome.tabs. Verifies: the tool loop, real
 * page scraping, readability of what it scraped, the written deliverable, and
 * that nothing is left on disk afterwards.
 *
 * Run: pnpm agent:run
 *
 * Configuration comes from .env:
 *   HOMEPAGE_PROVIDER   anthropic (default) | openai | openrouter | groq | ollama | custom
 *   HOMEPAGE_MODEL      model id; defaults to the provider's first suggestion
 *   HOMEPAGE_BASE_URL   override, for a self-hosted or local endpoint
 *   HOMEPAGE_LANGUAGE   en (default) | tr
 *   HOMEPAGE_PROMPT     standing instructions, same as the extension's Settings box
 * plus the provider's key: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY,
 * GROQ_API_KEY, or HOMEPAGE_API_KEY for `custom`.
 */
import { createProvider, getProvider, runHomepageBuild } from "@homepage/agent-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { FileKVStore, OUT_DIR, OUT_PATH, STATE_PATH, nodeBridge } from "./node-bridge";

const KEY_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  groq: "GROQ_API_KEY",
  custom: "HOMEPAGE_API_KEY",
  ollama: "",
};

async function main() {
  const spec = getProvider(process.env.HOMEPAGE_PROVIDER ?? "anthropic");
  const keyVar = KEY_ENV[spec.id] ?? "HOMEPAGE_API_KEY";
  const apiKey = keyVar ? (process.env[keyVar] ?? "") : "";
  if (spec.needsKey && !apiKey) throw new Error(`${keyVar} is not set (put it in .env)`);

  const model = process.env.HOMEPAGE_MODEL ?? spec.models[0] ?? "";
  if (!model.trim()) throw new Error(`Set HOMEPAGE_MODEL — there is no default model for ${spec.label}`);

  const provider = createProvider({
    spec,
    apiKey,
    model,
    baseUrl: process.env.HOMEPAGE_BASE_URL || undefined,
  });

  console.log(`provider ${spec.label} · model ${model}`);
  const store = new FileKVStore(STATE_PATH);
  mkdirSync(OUT_DIR, { recursive: true });

  const started = Date.now();
  let lastPhase = "";

  const result = await runHomepageBuild({
    provider,
    bridge: nodeBridge,
    store,
    userSystemPrompt: process.env.HOMEPAGE_PROMPT,
    language: process.env.HOMEPAGE_LANGUAGE === "tr" ? "tr" : "en",
    callbacks: {
      onPhase: (phase, detail) => {
        if (phase !== lastPhase) {
          lastPhase = phase;
          process.stdout.write(`\n\x1b[36m[${phase}]\x1b[0m${detail ? " " + detail : ""}\n`);
        }
      },
      onText: (text) => process.stdout.write(text),
      onLog: (line) => process.stdout.write(`\n\x1b[90m  · ${line}\x1b[0m\n`),
    },
  });

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  writeFileSync(OUT_PATH, result.code);

  console.log("\n\n========== RESULT ==========");
  console.log(`run          : ${result.runId}`);
  console.log(`source       : ${result.source}`);
  console.log(`steps        : ${result.steps} model call(s)`);
  console.log(`code length  : ${result.code.length} bytes`);
  console.log(`elapsed      : ${elapsed}s`);
  console.log(`written to   : ${OUT_PATH}`);

  // Shape checks. The real proof is `pnpm agent:verify`, which
  // transforms, evaluates and server-renders the component.
  const checks: Array<[string, boolean]> = [
    // `export default function PersonalizedHomepage()` and
    // `export default PersonalizedHomepage;` are both valid.
    ["default-exports the component", /export\s+default\s+(function\s+)?PersonalizedHomepage\b/.test(result.code)],
    ["imports React", /import\s+React/.test(result.code)],
    ["no non-React imports", !/from\s+['"](?!react['"])[^'"]+['"]/.test(result.code)],
    ["has real hrefs", /https?:\/\//.test(result.code)],
  ];

  console.log("\n========== CONTRACT ==========");
  let ok = true;
  for (const [label, pass] of checks) {
    console.log(`${pass ? "✅" : "❌"} ${label}`);
    if (!pass) ok = false;
  }
  console.log(`\nNext: pnpm agent:verify && pnpm agent:retention`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error("\n[run-agent] fatal:", err);
  process.exit(1);
});
