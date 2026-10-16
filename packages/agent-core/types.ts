/**
 * Contracts shared by every host that can drive the homepage agent.
 *
 * The orchestrator is deliberately ignorant of *where* it runs. The extension
 * supplies a bridge backed by `chrome.history` / `chrome.tabs`; the Node test
 * harness supplies one backed by fixtures and `fetch`. Nothing in this package
 * may import `chrome`, `browser`, or `node:*`.
 *
 * There is no server and no remote sandbox: the agent loop, the files the agent
 * reads, and the model call all live in whichever host is running this. A
 * `ModelProvider` is the only thing that leaves the process.
 */

/** UI and generated-page language. */
export type Language = "en" | "tr";

// ---------------------------------------------------------------------------
// what the browser provides
// ---------------------------------------------------------------------------

/** One domain's worth of browsing history, narrowed to fit in a context window. */
export interface SiteDigest {
  domain: string;
  visits: number;
  pages: number;
  /** ISO 8601 — the model reasons about dates, not epoch milliseconds. */
  lastVisit: string;
  score: number;
  /** Capped. `urls[]` is dropped entirely. */
  sampleTitles: string[];
}

export interface GetHistoryResult {
  windowDays: number;
  /** What the model is *not* seeing. Without this it assumes the digest is exhaustive. */
  totalSitesSeen: number;
  sites: SiteDigest[];
}

/** A scraped page, readable by the agent through `read` / `grep` / `glob`. */
export interface PageFile {
  /** The agent-facing path, e.g. `/pages/news_ycombinator_com_0.html`. */
  path: string;
  url: string;
  title: string;
  /** Sanitized, link-absolutized plain text — never raw HTML. */
  text: string;
}

/** A page now readable by the agent, referenced by path rather than by content. */
export interface PageRef {
  url: string;
  title: string;
  path: string;
  /** Lets the model choose grep-first over read-whole. */
  bytes: number;
}

export interface GetPageHtmlResult {
  pages: PageRef[];
  /** Surfaced, never swallowed: partial failure is information the model needs. */
  failed: Array<{ url: string; reason: string }>;
}

/** Raw per-domain history, as a BrowserBridge returns it — before `buildHistoryDigest` narrows it. */
export interface RawSiteMetadata {
  domain: string;
  totalVisits: number;
  uniquePages: number;
  lastVisitTime: number;
  averageVisitsPerDay: number;
  titles: string[];
  urls: string[];
  relevanceScore: number;
}

export interface ScrapedPage {
  url: string;
  /** Where the page ended up after redirects, when the host can tell. */
  finalUrl?: string;
  title: string;
  /** Rendered text: scripts, styles and markup removed, links absolutized. */
  text: string;
}

/**
 * The two capabilities only a real browser has. Everything else the agent needs
 * (a filesystem, grep, read) is implemented in-process by `tools.ts`.
 */
export interface BrowserBridge {
  getHistory(args: {
    daysToAnalyze: number;
    maxResults: number;
  }): Promise<{ sites: RawSiteMetadata[]; totalSitesSeen: number }>;

  getPageHtml(args: {
    urls: string[];
    loadDelayMs?: number;
  }): Promise<{ pages: ScrapedPage[]; failed: Array<{ url: string; reason: string }> }>;
}

/** Minimal persistence. `chrome.storage.local` in the extension, a JSON file in Node. */
export interface KVStore {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// the model
// ---------------------------------------------------------------------------

/** JSON Schema for a tool's input, shaped to suit both wire formats. */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required: string[];
  [k: string]: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

export interface ToolCall {
  /** Provider-assigned id, echoed back on the result. */
  id: string;
  name: string;
  input: Record<string, unknown>;
  /**
   * Set when the provider streamed arguments that were not valid JSON. The
   * dispatcher turns this into an `is_error` result instead of failing the run,
   * so the model gets one chance to correct itself.
   */
  inputError?: string;
}

export interface ToolResult {
  toolCallId: string;
  name: string;
  /** JSON, or plain text when the tool reports a failure. */
  content: string;
  isError?: boolean;
}

/**
 * The transcript the orchestrator keeps, provider-agnostic. Every provider
 * translates these three shapes into its own wire format, so switching models
 * never changes the loop.
 */
export type Turn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; toolCalls: ToolCall[] }
  | { role: "tool_results"; results: ToolResult[] };

export interface ModelRequest {
  system: string;
  turns: Turn[];
  tools: ToolDefinition[];
  maxTokens: number;
  signal?: AbortSignal;
}

export interface ModelResponse {
  text: string;
  toolCalls: ToolCall[];
  /** Provider-native stop reason, for logging. */
  stopReason: string;
}

/**
 * One provider call. Stateless: the orchestrator owns the transcript, so a run
 * can move between models without any provider holding state.
 */
export interface ModelProvider {
  /** Provider id, for logs and for the persisted run. */
  readonly id: string;
  complete(req: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------------------
// the run
// ---------------------------------------------------------------------------

export type RunPhase =
  | "setup"
  | "thinking"
  | "history"
  | "scraping"
  | "analyzing"
  | "writing"
  | "cleanup"
  | "done"
  | "error";

export interface RunCallbacks {
  onPhase?(phase: RunPhase, detail?: string): void;
  /** Assistant prose, for a progress panel. Arrives a turn at a time. */
  onText?(text: string): void;
  onLog?(line: string): void;
}

export interface HomepageBuildResult {
  code: string;
  /** Local run id — there is no remote session to name. */
  runId: string;
  /** Model calls made. */
  steps: number;
  /** Where the code came from: the `write` tool, or a fenced block in the last message. */
  source: "write-tool" | "message-fence";
}
