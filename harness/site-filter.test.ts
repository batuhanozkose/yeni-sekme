import { expect, test } from "bun:test";
import {
  STORAGE_KEYS,
  isBlocked,
  normalizeBlockList,
  runHomepageBuild,
  type BrowserBridge,
  type ToolResult,
} from "@homepage/agent-core";
import { fixtureHistory } from "./node-bridge";
import { FakeProvider, MemoryKVStore, resultsFor } from "./test-doubles";

/**
 * The block list is enforced in the tool handlers, not in the prompt, and the
 * pages it excluded must never reach the model — not in a tool result, not in
 * the transcript that gets persisted for a resume, nowhere.
 */

test("normalizes pasted hosts and URLs", () => {
  expect(normalizeBlockList([" HTTPS://WWW.Google.COM/path ", "", " # comment", "*.Example.COM", "google.com"])).toEqual(["google.com", "*.example.com"]);
});

test("matches hosts and subdomains without matching lookalikes", () => {
  for (const host of ["google.com", "mail.google.com", "https://WWW.GOOGLE.COM./path"]) {
    expect(isBlocked(host, ["google.com"])).toBe(true);
  }
  expect(isBlocked("deep.sub.example.com", ["*.example.com"])).toBe(true);
  expect(isBlocked("example.com", ["*.example.com"])).toBe(true);
  for (const url of ["https:/mail.google.com", "https:\\mail.google.com", "HTTPS://user:pw@Mail.Google.com:443/x"]) {
    expect(isBlocked(url, ["google.com"])).toBe(true);
  }
  expect(isBlocked("localhost:3000", ["localhost"])).toBe(true);
  expect(isBlocked("notgoogle.com", ["google.com"])).toBe(false);
  expect(isBlocked("google.com.evil.test", ["google.com"])).toBe(false);
});

test("always blocks loopback, private and local-network hosts", () => {
  for (const url of [
    "http://localhost:5173", "http://127.0.0.2/", "http://0.0.0.0:8080", "http://2130706433/",
    "http://[::1]:3000/", "http://[::ffff:127.0.0.1]/", "http://[fd12::1]/", "http://[fe80::1]/",
    "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data",
    "http://100.100.1.1/", "http://router/", "http://printer.local/", "https://wiki.corp.internal/",
    "http://nas.lan/", "http://box.home.arpa/",
  ]) {
    expect(isBlocked(url, [])).toBe(true);
  }
  for (const url of ["https://8.8.8.8/", "https://172.32.0.1/", "https://192.169.0.1/", "https://news.ycombinator.com/", "https://[2606:4700::1111]/"]) {
    expect(isBlocked(url, [])).toBe(false);
  }
});

const WRITE_STEP = {
  tools: [{ name: "write", input: { path: "/homepage.tsx", content: "export default function PersonalizedHomepage() {}" } }],
};

interface RunToolsOptions {
  blockedSites?: string[] | (() => Promise<string[]>);
  resume?: boolean;
  scrape?: BrowserBridge["getPageHtml"];
  /** Fires when the loop is about to make model call #n. */
  atStep?: (step: number) => void;
}

/** Drive real tool dispatch and real persistence, without a browser or a network. */
async function runTools(urls: string[], opts: RunToolsOptions = {}) {
  const calls: string[][] = [];
  const logs: string[] = [];
  const store = new MemoryKVStore();

  const steps = [
    { tools: [{ name: "getHistory", input: { maxResults: 1 } }] },
    { tools: [{ name: "getPageHtml", input: { urls } }] },
    WRITE_STEP,
    { text: "done" },
  ];

  const provider = new FakeProvider(opts.resume ? steps.slice(1) : steps, {
    onRequest: (_req, step) => opts.atStep?.(opts.resume ? step + 1 : step),
  });

  const bridge: BrowserBridge = {
    getHistory: async () => {
      const sites = fixtureHistory();
      return { sites, totalSitesSeen: sites.length };
    },
    getPageHtml:
      opts.scrape ??
      (async ({ urls: requested }) => {
        calls.push(requested);
        return { pages: [], failed: requested.map((url) => ({ url, reason: "unavailable" })) };
      }),
  };

  if (opts.resume) {
    // A run killed the instant the page request went out, with nobody to answer it.
    await store.set(STORAGE_KEYS.activeRun, {
      runId: "resumed-run",
      startedAt: new Date().toISOString(),
      turns: [
        { role: "user", text: "kickoff" },
        { role: "assistant", text: "", toolCalls: [{ id: "pages", name: "getPageHtml", input: { urls } }] },
      ],
      deliverable: null,
      steps: 1,
      providerId: "fake",
    });
  }

  await runHomepageBuild({
    provider,
    store,
    bridge,
    blockedSites: opts.blockedSites,
    resume: opts.resume,
    callbacks: { onLog: (line) => logs.push(line) },
  });

  const transcript: ToolResult[] = provider.requests.flatMap((req) =>
    req.turns.flatMap((turn) => (turn.role === "tool_results" ? turn.results : [])),
  );

  return {
    calls,
    logs,
    store,
    transcript,
    digest: resultsFor(provider.lastRequest, "getHistory")[0],
    pageResult: resultsFor(provider.lastRequest, "getPageHtml")[0],
  };
}

test("filters history before capping and excludes blocked sites from the count", async () => {
  const { digest } = await runTools([], { blockedSites: ["news.ycombinator.com"] });
  expect(digest.totalSitesSeen).toBe(fixtureHistory().length - 1);
  expect(digest.sites).toHaveLength(1);
  expect(JSON.stringify(digest)).not.toContain("news.ycombinator.com");
});

test("uses newly saved blocked sites for the next tool call in an active build", async () => {
  let savedSites: string[] = [];
  const { digest, calls, pageResult } = await runTools(["https://news.ycombinator.com"], {
    blockedSites: async () => savedSites,
    // The user saves the list while the build is running.
    atStep: (step) => {
      if (step === 1) savedSites = ["news.ycombinator.com"];
    },
  });

  // History was taken before the save, so it still carries the domain…
  expect(JSON.stringify(digest)).toContain("news.ycombinator.com");
  // …and the very next tool call already respects it, without opening a window.
  expect(calls).toEqual([]);
  expect(pageResult).toEqual({
    pages: [],
    failed: [{ url: "https://news.ycombinator.com", reason: "blocked by the user's settings" }],
  });
});

test("never forwards blocked or non-http URLs, including on resume", async () => {
  const urls = ["https://bank.test", "https://sub.bank.test", "https:/bank.test", "https:\\bank.test", "file:///secret", "chrome://settings", "javascript:alert(1)", "not a url"];
  for (const resume of [false, true]) {
    const { calls, logs, pageResult } = await runTools(urls, { blockedSites: ["bank.test"], resume });
    expect(calls).toEqual([]);
    expect(pageResult).toEqual({ pages: [], failed: urls.map((url) => ({ url, reason: "blocked by the user's settings" })) });
    expect(logs).toContain("blocked: 8 url(s)");
  }
});

test("only forwards allowed URLs in mixed batches", async () => {
  const { calls, pageResult } = await runTools(["https://bank.test", "https://public.test"], { blockedSites: ["bank.test"] });
  expect(calls).toEqual([["https://public.test"]]);
  expect(pageResult.failed).toEqual([
    { url: "https://bank.test", reason: "blocked by the user's settings" },
    { url: "https://public.test", reason: "unavailable" },
  ]);
});

test("uses defaults when unset and honors an explicitly empty list", async () => {
  expect((await runTools(["https://mail.google.com"])).calls).toEqual([]);
  expect((await runTools(["https://mail.google.com"], { blockedSites: [] })).calls).toEqual([["https://mail.google.com"]]);
});

test("drops pages that redirected to a blocked host, and keeps their text out of everything", async () => {
  const redirector = "https://www.google.com/url?q=https://mail.google.com/";
  const { pageResult, transcript, store } = await runTools([redirector, "https://public.test/"], {
    blockedSites: ["mail.google.com"],
    scrape: async ({ urls }) => ({
      pages: [
        { url: urls[0]!, finalUrl: "https://mail.google.com/mail/u/0/", title: "Inbox", text: "Subject: quarterly numbers" },
        { url: urls[1]!, finalUrl: "https://public.test/", title: "Public", text: "Public news" },
      ],
      failed: [],
    }),
  });

  expect(pageResult.pages.map((page: any) => page.url)).toEqual(["https://public.test/"]);
  expect(pageResult.failed).toEqual([{ url: redirector, reason: "blocked by the user's settings" }]);

  // The redirect target's content never reaches the model, the transcript, or
  // the storage a crash would resume from.
  const everywhere = JSON.stringify({ pageResult, transcript, persisted: [...store.data.values()] });
  expect(everywhere).not.toContain("quarterly numbers");
});
