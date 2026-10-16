/**
 * The agent loop.
 *
 * This used to be a remote orchestrator: create a session, hold an SSE stream,
 * answer the tool calls it emitted. Now the loop itself is here, so the only
 * thing that crosses the network is the model call. That removes a server but
 * adds one obligation the remote version handled for us: a run must survive the
 * MV3 service worker being torn down mid-flight, so the transcript is persisted
 * after every model call and every batch of tool results.
 *
 * Resuming works off one invariant: an assistant turn whose tool calls have no
 * `tool_results` turn behind them was interrupted, so those calls get re-run
 * before the loop continues. Every path out of `runTool` returns a result, so a
 * transcript never stays in that state by choice.
 */
import { buildKickoffMessage, HOMEPAGE_SYSTEM_PROMPT } from "./prompt";
import { DEFAULT_BLOCKED_SITES, normalizeBlockList } from "./site-filter";
import { DEFAULTS, OUTPUT_PATH } from "./schemas";
import { TOOL_DEFINITIONS, runTool, type Emit, type ToolContext } from "./tools";
import type {
  BrowserBridge,
  HomepageBuildResult,
  KVStore,
  Language,
  ModelProvider,
  PageFile,
  RunCallbacks,
  ToolCall,
  ToolResult,
  Turn,
} from "./types";

/** The keys this package persists, so a crash can resume a run. */
export const STORAGE_KEYS = {
  /** The transcript and progress: small, written after every step. */
  activeRun: "activeRun",
  /**
   * Scraped page bodies: megabytes, written only when the page set changes.
   * Keeping them apart means the frequent write stays cheap.
   */
  runPages: "runPages",
} as const;

/**
 * A run that has not produced a homepage in this many model calls is looping,
 * not working. Roughly 4x what a healthy build uses (history, scrape, a handful
 * of reads, write, summary).
 */
const DEFAULT_MAX_STEPS = 32;

/** What `runHomepageBuild` persists between model calls. Page bodies live under their own key. */
export interface PersistedRun {
  runId: string;
  startedAt: string;
  turns: Turn[];
  deliverable: string | null;
  steps: number;
  providerId: string;
}

export interface RunOptions {
  /** The model call. Everything else happens in this process. */
  provider: ModelProvider;
  bridge: BrowserBridge;
  store: KVStore;
  userSystemPrompt?: string;
  /**
   * Hosts the tools must never read. A getter is re-read before every tool call,
   * so a list saved mid-build applies to the rest of that build.
   */
  blockedSites?: string[] | (() => Promise<string[]>);
  /** Language of the interface and of the page's own copy. Defaults to English. */
  language?: Language;
  callbacks?: RunCallbacks;
  signal?: AbortSignal;
  now?: Date;
  /** Continue the persisted run in `store` instead of starting a new one. */
  resume?: boolean;
  maxSteps?: number;
  maxTokens?: number;
}

export async function runHomepageBuild(opts: RunOptions): Promise<HomepageBuildResult> {
  const { provider, bridge, store, callbacks, signal } = opts;
  const language: Language = opts.language ?? "en";
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const emit: Emit = {
    phase: (p, d) => callbacks?.onPhase?.(p, d),
    text: (t) => callbacks?.onText?.(t),
    log: (l) => callbacks?.onLog?.(l),
  };

  emit.phase("setup");

  const resumed = opts.resume ? await store.get<PersistedRun>(STORAGE_KEYS.activeRun) : undefined;
  const run: PersistedRun = resumed ?? {
    runId: crypto.randomUUID(),
    startedAt: (opts.now ?? new Date()).toISOString(),
    turns: [
      {
        role: "user",
        text: buildKickoffMessage({
          now: opts.now ?? new Date(),
          userSystemPrompt: opts.userSystemPrompt,
          language,
        }),
      },
    ],
    deliverable: null,
    steps: 0,
    providerId: provider.id,
  };
  emit.log(`${resumed ? "resumed" : "new"} run=${run.runId} provider=${provider.id}`);

  const resumedPages = resumed ? ((await store.get<PageFile[]>(STORAGE_KEYS.runPages)) ?? []) : [];
  const pages = new Map(resumedPages.map((page) => [page.path, page]));
  const ctx: ToolContext = {
    bridge,
    pages,
    blockedSites: async () =>
      normalizeBlockList(
        (typeof opts.blockedSites === "function" ? await opts.blockedSites() : opts.blockedSites) ??
          DEFAULT_BLOCKED_SITES,
      ),
    deliverable: run.deliverable ? { path: OUTPUT_PATH, code: run.deliverable } : null,
    emit,
  };

  /** The transcript and progress. Small enough to write after every step. */
  const persist = async () => {
    run.deliverable = ctx.deliverable?.code ?? null;
    await store.set(STORAGE_KEYS.activeRun, run);
  };

  /** Page bodies, written only when `getPageHtml` actually added some. */
  let persistedPageCount = pages.size;
  const persistPages = async () => {
    if (pages.size === persistedPageCount) return;
    persistedPageCount = pages.size;
    await store.set(STORAGE_KEYS.runPages, [...pages.values()]);
  };

  /** Tools run in order: `getPageHtml` opens a scraper window per call. */
  const answer = async (calls: ToolCall[]): Promise<ToolResult[]> => {
    const results: ToolResult[] = [];
    for (const call of calls) {
      emit.phase("analyzing", call.name);
      emit.log(`tool:${call.name}`);
      results.push(await runTool(call, ctx));
    }
    return results;
  };

  let source: HomepageBuildResult["source"] = "write-tool";

  try {
    await persist();

    // A tool call left hanging by a crash: answer it before asking the model for
    // anything, or its transcript has an assistant turn nothing ever replied to.
    const pending = pendingToolCalls(run.turns);
    if (pending.length) {
      emit.log(`re-answering ${pending.length} orphaned tool call(s)`);
      run.turns.push({ role: "tool_results", results: await answer(pending) });
      await persistPages();
      await persist();
    }

    while (run.steps < maxSteps) {
      if (signal?.aborted) throw new Error("aborted");
      run.steps++;

      emit.phase("thinking");
      const response = await provider.complete({
        system: HOMEPAGE_SYSTEM_PROMPT,
        // A copy: the orchestrator owns the transcript, and a provider that
        // appended to this array would silently rewrite the persisted run.
        turns: [...run.turns],
        tools: TOOL_DEFINITIONS,
        maxTokens: opts.maxTokens ?? DEFAULTS.maxTokens,
        signal,
      });
      if (response.text.trim()) emit.text(response.text);

      run.turns.push({ role: "assistant", text: response.text, toolCalls: response.toolCalls });
      await persist();

      if (!response.toolCalls.length) {
        emit.log(`model stopped: ${response.stopReason || "no tool calls"}`);
        break;
      }

      run.turns.push({ role: "tool_results", results: await answer(response.toolCalls) });
      await persistPages();
      await persist();

      if (ctx.deliverable) emit.log(`deliverable: ${ctx.deliverable.code.length}b`);
    }

    emit.phase("writing");
    let code = ctx.deliverable?.code ?? "";
    if (!code) {
      // Fallback: the model sometimes answers with the component inline instead
      // of (or as well as) writing it. Better than failing the run outright.
      const fenced = allAssistantText(run.turns).match(CODE_FENCE);
      if (fenced && fenced[1]!.includes("PersonalizedHomepage")) {
        emit.log("deliverable recovered from message fence");
        code = fenced[1]!.trim();
        source = "message-fence";
      } else {
        throw new Error(
          `Agent produced no homepage in ${run.steps} step(s). Expected a file at ${OUTPUT_PATH}. ` +
            `Last message: ${allAssistantText(run.turns).slice(-400)}`,
        );
      }
    }

    emit.phase("done");
    return { code, runId: run.runId, steps: run.steps, source };
  } finally {
    // Privacy: the transcript holds every domain, title and page body the agent
    // read. There is no remote copy to delete any more, but there is a local one,
    // and it has no reason to outlive the build.
    emit.phase("cleanup");
    pages.clear();
    await Promise.allSettled([
      store.remove(STORAGE_KEYS.activeRun),
      store.remove(STORAGE_KEYS.runPages),
    ]);
  }
}

/** The calls on a trailing assistant turn, if nobody answered them. */
function pendingToolCalls(turns: Turn[]): ToolCall[] {
  const last = turns[turns.length - 1];
  return last && last.role === "assistant" ? last.toolCalls : [];
}

function allAssistantText(turns: Turn[]): string {
  return turns
    .filter((turn): turn is Extract<Turn, { role: "assistant" }> => turn.role === "assistant")
    .map((turn) => turn.text)
    .join("\n");
}

const CODE_FENCE = /```(?:tsx|jsx|ts|js)?\s*\n([\s\S]*?)```/;
