import { describe, expect, test } from "bun:test";
import { STORAGE_KEYS, runHomepageBuild, type BrowserBridge, type PageFile } from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";
import { FakeProvider, MemoryKVStore, allResults, resultsFor, storedPage } from "./test-doubles";

/**
 * The loop used to live on Anthropic's side; these tests are what replaced the
 * paid end-to-end run. A scripted provider drives real tool execution, real
 * persistence and real resume, with no network.
 */

const COMPONENT = `import React from "react";
export default function PersonalizedHomepage() { return <div>hi</div>; }`;

const PAGE_PATH = "/pages/news_test_0.html";
const PAGE_TEXT = "Kernel 6.9 <https://news.test/k>\nSecond line";

function bridgeFor(pages: Record<string, string> = { "https://news.test/": PAGE_TEXT }): BrowserBridge {
  return {
    getHistory: async () => {
      const sites = fixtureHistory();
      return { sites, totalSitesSeen: sites.length };
    },
    getPageHtml: async ({ urls }) => ({
      pages: urls.map((url) => ({
        url,
        finalUrl: url,
        title: "Fixture",
        text: pages[url] ?? "nothing here",
      })),
      failed: [],
    }),
  };
}

const writeStep = { tools: [{ name: "write", input: { path: "/homepage.tsx", content: COMPONENT } }] };

describe("runHomepageBuild", () => {
  test("runs the tool loop and delivers what write stored", async () => {
    const provider = new FakeProvider([
      { tools: [{ name: "getHistory" }] },
      { tools: [{ name: "getPageHtml", input: { urls: ["https://news.test/"] } }] },
      writeStep,
      { text: "Built a page." },
    ]);

    const result = await runHomepageBuild({
      provider,
      bridge: bridgeFor(),
      store: new MemoryKVStore(),
    });

    expect(result.code).toBe(COMPONENT);
    expect(result.source).toBe("write-tool");
    expect(result.steps).toBe(4);
    expect(provider.requests).toHaveLength(4);

    // The page is addressable by the path the tool reported, not by its URL.
    const pages = resultsFor(provider.lastRequest, "getPageHtml");
    expect(pages[0].pages[0]).toMatchObject({ url: "https://news.test/", path: PAGE_PATH });
  });

  test("makes scraped pages greppable and readable, with absolute links", async () => {
    const provider = new FakeProvider([
      { tools: [{ name: "getPageHtml", input: { urls: ["https://news.test/"] } }] },
      { tools: [{ name: "grep", input: { pattern: "Kernel" } }] },
      { tools: [{ name: "read", input: { path: PAGE_PATH, offset: 2, limit: 1 } }] },
      writeStep,
      { text: "done" },
    ]);

    await runHomepageBuild({ provider, bridge: bridgeFor(), store: new MemoryKVStore() });

    const grep = resultsFor(provider.lastRequest, "grep")[0];
    expect(grep.matches).toEqual([{ path: PAGE_PATH, line: 1, text: PAGE_TEXT.split("\n")[0]! }]);

    const read = resultsFor(provider.lastRequest, "read")[0];
    expect(read.startLine).toBe(2);
    expect(read.text).toBe("2\tSecond line");
    expect(read.totalLines).toBe(2);
  });

  test("rejects a path the agent made up instead of failing the run", async () => {
    const provider = new FakeProvider([
      { tools: [{ name: "read", input: { path: "/pages/not-a-page.html" } }] },
      writeStep,
      { text: "done" },
    ]);

    const result = await runHomepageBuild({ provider, bridge: bridgeFor(), store: new MemoryKVStore() });

    const failure = allResults(provider.lastRequest).find((r) => r.name === "read");
    expect(failure?.isError).toBe(true);
    expect(failure?.content).toContain("No page at /pages/not-a-page.html");
    expect(result.code).toBe(COMPONENT);
  });

  test("turns unparseable tool arguments into a result the model can react to", async () => {
    const provider = new FakeProvider([
      { tools: [{ name: "grep", inputError: "tool arguments were not valid JSON" }] },
      writeStep,
      { text: "done" },
    ]);

    const result = await runHomepageBuild({ provider, bridge: bridgeFor(), store: new MemoryKVStore() });

    const failure = allResults(provider.lastRequest).find((r) => r.name === "grep");
    expect(failure?.isError).toBe(true);
    expect(result.code).toBe(COMPONENT);
  });

  test("falls back to a fenced component when write was never called", async () => {
    const provider = new FakeProvider([
      { tools: [{ name: "getHistory" }] },
      { text: `Here you go:\n\n\`\`\`tsx\n${COMPONENT}\n\`\`\`\n` },
    ]);

    const result = await runHomepageBuild({ provider, bridge: bridgeFor(), store: new MemoryKVStore() });
    expect(result.source).toBe("message-fence");
    expect(result.code).toContain("PersonalizedHomepage");
  });

  test("gives up on an agent that never delivers", async () => {
    const provider = new FakeProvider([{ tools: [{ name: "glob", input: {} }] }]);
    await expect(
      runHomepageBuild({ provider, bridge: bridgeFor(), store: new MemoryKVStore(), maxSteps: 3 }),
    ).rejects.toThrow(/no homepage in 3 step/);
  });

  test("an aborted run throws and leaves nothing behind", async () => {
    const controller = new AbortController();
    const store = new MemoryKVStore();
    const provider = new FakeProvider([{ tools: [{ name: "glob", input: {} }] }], {
      onRequest: (_req, step) => {
        if (step >= 1) controller.abort();
      },
    });

    await expect(
      runHomepageBuild({ provider, bridge: bridgeFor(), store, signal: controller.signal }),
    ).rejects.toThrow("aborted");

    expect(store.data.has(STORAGE_KEYS.activeRun)).toBe(false);
    expect(store.data.has(STORAGE_KEYS.runPages)).toBe(false);
  });

  test("clears the persisted run once it delivers", async () => {
    const store = new MemoryKVStore();
    const provider = new FakeProvider([
      { tools: [{ name: "getPageHtml", input: { urls: ["https://news.test/"] } }] },
      writeStep,
      { text: "done" },
    ]);

    await runHomepageBuild({ provider, bridge: bridgeFor(), store });

    // Privacy: the transcript holds every domain and page body the agent read,
    // and it has no reason to outlive the build.
    expect(store.data.has(STORAGE_KEYS.activeRun)).toBe(false);
    expect(store.data.has(STORAGE_KEYS.runPages)).toBe(false);
  });
});

describe("reattaching to an interrupted run", () => {
  /** A run killed the instant the model asked for a page, with nobody to answer. */
  function interruptedStore(): MemoryKVStore {
    const store = new MemoryKVStore();
    void store.set(STORAGE_KEYS.activeRun, {
      runId: "run-interrupted",
      startedAt: new Date().toISOString(),
      turns: [
        { role: "user", text: "Build today's homepage." },
        {
          role: "assistant",
          text: "",
          toolCalls: [{ id: "orphan", name: "getPageHtml", input: { urls: ["https://news.test/"] } }],
        },
      ],
      deliverable: null,
      steps: 1,
      providerId: "fake",
    });
    return store;
  }

  test("answers the orphaned call before asking the model anything", async () => {
    const store = interruptedStore();
    const logs: string[] = [];
    const provider = new FakeProvider([writeStep, { text: "done" }]);

    const result = await runHomepageBuild({
      provider,
      bridge: bridgeFor(),
      store,
      resume: true,
      callbacks: { onLog: (line) => logs.push(line) },
    });

    expect(logs.some((line) => line.includes("re-answering 1 orphaned"))).toBe(true);

    // The transcript the model sees already has the answer in it.
    const transcript = provider.requests[0]!.turns;
    expect(transcript.map((turn) => turn.role)).toEqual(["user", "assistant", "tool_results"]);
    expect(allResults(provider.requests[0]!).find((r) => r.name === "getPageHtml")?.isError).toBeUndefined();

    expect(result.code).toBe(COMPONENT);
    expect(result.runId).toBe("run-interrupted");
  });

  test("restores scraped pages so a resumed read still works", async () => {
    const store = interruptedStore();
    await store.set(STORAGE_KEYS.runPages, [
      storedPage(PAGE_PATH, "https://news.test/", PAGE_TEXT) satisfies PageFile,
    ]);

    const provider = new FakeProvider([
      { tools: [{ name: "read", input: { path: PAGE_PATH } }] },
      writeStep,
      { text: "done" },
    ]);

    await runHomepageBuild({ provider, bridge: bridgeFor(), store, resume: true });

    const read = resultsFor(provider.lastRequest, "read")[0];
    expect(read.text).toContain("Kernel 6.9");
  });

  test("starts fresh when asked to resume with nothing to resume", async () => {
    const store = new MemoryKVStore();
    const provider = new FakeProvider([writeStep, { text: "done" }]);

    const result = await runHomepageBuild({ provider, bridge: bridgeFor(), store, resume: true });

    // A new kickoff message, not an attempt to continue a missing transcript.
    expect(provider.requests[0]!.turns[0]!.role).toBe("user");
    expect(result.runId).not.toBe("run-interrupted");
  });
});
