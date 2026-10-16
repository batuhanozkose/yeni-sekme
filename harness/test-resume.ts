/**
 * The one unrecoverable failure mode, and the proof that reattach handles it.
 *
 * If the host dies while a tool call is pending, the transcript on disk ends with
 * an assistant turn nobody ever answered — and no amount of replaying it will
 * make the model continue. This is a tab close, a browser quit, or an MV3 worker
 * killed at the worst possible moment.
 *
 * Phase "crash": start a real build, answer getHistory, then hard-exit the
 * instant getPageHtml is requested, without answering it.
 *
 * Phase "resume": reattach. It must load the transcript, notice the orphaned
 * call, answer it, and finish the build.
 *
 * Run: pnpm agent:resume-test
 *
 * No API key: a scripted provider stands in for the model, so the only thing
 * under test is whether the run survived a process death.
 */
import { STORAGE_KEYS, runHomepageBuild, type BrowserBridge } from "@homepage/agent-core";
import { FileKVStore, STATE_PATH, fixtureHistory } from "./node-bridge";
import { FakeProvider } from "./test-doubles";

const store = new FileKVStore(STATE_PATH);
const PAGE_TEXT = "Kernel 6.9 released <https://news.test/k>";

const COMPONENT = `import React from "react";
export default function PersonalizedHomepage() { return <div>resumed</div>; }`;

function workingBridge(): BrowserBridge {
  return {
    getHistory: async () => {
      const sites = fixtureHistory();
      return { sites, totalSitesSeen: sites.length };
    },
    getPageHtml: async ({ urls }) => ({
      pages: urls.map((url) => ({ url, finalUrl: url, title: "Fixture", text: PAGE_TEXT })),
      failed: [],
    }),
  };
}

async function crash(): Promise<never> {
  await store.remove(STORAGE_KEYS.activeRun);

  const provider = new FakeProvider([
    { tools: [{ name: "getHistory" }] },
    { tools: [{ name: "getPageHtml", input: { urls: ["https://news.test/"] } }] },
  ]);

  await runHomepageBuild({
    provider,
    store,
    callbacks: { onLog: (line) => console.log(`  · ${line}`) },
    // The bridge is the moment of death: the page request is already persisted,
    // and this process never gets to answer it.
    bridge: {
      ...workingBridge(),
      getPageHtml: async () => {
        console.log("[crash] getPageHtml requested — DYING WITHOUT ANSWERING");
        process.exit(0);
      },
    },
  });

  throw new Error("[crash] the build finished; getPageHtml was never requested");
}

async function resume() {
  const before = await store.get<{ runId: string; turns: unknown[] }>(STORAGE_KEYS.activeRun);
  if (!before) throw new Error("no run in progress — the crash phase did not run");
  console.log(`[resume] reattaching to ${before.runId} with ${before.turns.length} turns on disk`);

  let reAnswered = false;
  const result = await runHomepageBuild({
    provider: new FakeProvider([
      { tools: [{ name: "write", input: { path: "/homepage.tsx", content: COMPONENT } }] },
      { text: "done" },
    ]),
    store,
    bridge: workingBridge(),
    resume: true,
    callbacks: {
      onLog: (line) => {
        if (line.includes("re-answering")) reAnswered = true;
        console.log(`  · ${line}`);
      },
    },
  });

  const sameRun = result.runId === before.runId;
  const delivered = result.code === COMPONENT;

  console.log("\n========== RESUME RESULT ==========");
  console.log(`${reAnswered ? "✅" : "❌"} orphaned tool call was re-answered`);
  console.log(`${sameRun ? "✅" : "❌"} continued the same run (no restart)`);
  console.log(`${delivered ? "✅" : "❌"} deliverable recovered (${result.code.length}b)`);

  if (!reAnswered || !sameRun || !delivered) process.exit(1);
}

const phase = process.argv[2];
if (phase === "crash") await crash();
else if (phase === "resume") await resume();
else throw new Error("usage: test-resume.ts crash|resume");
