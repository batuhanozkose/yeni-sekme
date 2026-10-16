/**
 * The tools the agent can call, and the code that runs them.
 *
 * All of them execute in this process — the browser tools reach into
 * `chrome.history` / `chrome.tabs` through the bridge, and the file tools read
 * pages the browser just scraped. This is what used to be a remote sandbox; with
 * the sandbox gone, the only thing that leaves the machine is the model call.
 *
 * Every path out of `runTool` returns a `ToolResult`. A throw becomes an
 * `isError` result rather than an unanswered call, because a model that never
 * hears back has no way to correct itself.
 */
import { buildHistoryDigest, slugifyUrl } from "./history-digest";
import { grepText } from "./page-text";
import {
  DEFAULTS,
  GET_HISTORY_SCHEMA,
  GET_PAGE_HTML_SCHEMA,
  GLOB_SCHEMA,
  GREP_SCHEMA,
  OUTPUT_PATH,
  PAGE_DIR,
  READ_SCHEMA,
  WRITE_SCHEMA,
} from "./schemas";
import { isAllowedUrl, isBlocked } from "./site-filter";
import type {
  BrowserBridge,
  GetHistoryResult,
  GetPageHtmlResult,
  PageFile,
  PageRef,
  RunPhase,
  ToolCall,
  ToolDefinition,
  ToolResult,
} from "./types";

export interface Emit {
  phase(phase: RunPhase, detail?: string): void;
  text(chunk: string): void;
  log(line: string): void;
}

/** Mutable state one tool call can observe and change for the next. */
export interface ToolContext {
  bridge: BrowserBridge;
  /** Path → page, filled by `getPageHtml` and read by `glob`/`grep`/`read`. */
  pages: Map<string, PageFile>;
  /** Re-read before every call, so a list saved mid-build applies immediately. */
  blockedSites(): Promise<string[]>;
  /** Set by `write`. The orchestrator reads it after each step. */
  deliverable: { path: string; code: string } | null;
  emit: Emit;
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "getHistory",
    description:
      "Returns a ranked digest of the user's most-visited domains over a recent " +
      "window: visit counts, unique page counts, last-visit timestamps, relevance " +
      "scores, and a few sample page titles per domain. Call this first, once.",
    input_schema: GET_HISTORY_SCHEMA,
  },
  {
    name: "getPageHtml",
    description:
      "Loads URLs in the user's real, logged-in browser, renders each page to " +
      "readable text, and makes it available to glob/grep/read at the returned " +
      "path. Returns a path and byte count per page plus a list of failures. " +
      "Prefer this over any web fetch: it sees authenticated, JavaScript-rendered " +
      "pages that an anonymous fetch cannot.",
    input_schema: GET_PAGE_HTML_SCHEMA,
  },
  {
    name: "glob",
    description: "Lists the pages available to read, with their paths and byte counts.",
    input_schema: GLOB_SCHEMA,
  },
  {
    name: "grep",
    description:
      "Searches page text line by line with a regular expression. Returns matching " +
      "lines with their line numbers. Use it to find the region worth reading " +
      "before spending a read on the whole page.",
    input_schema: GREP_SCHEMA,
  },
  {
    name: "read",
    description:
      "Reads lines from one page, numbered. Use the line numbers grep reported.",
    input_schema: READ_SCHEMA,
  },
  {
    name: "write",
    description:
      "Writes a file. This is the only way to deliver the finished homepage — " +
      `it must be written to ${OUTPUT_PATH}.`,
    input_schema: WRITE_SCHEMA,
  },
];

/** The tool by name, or undefined for a call we do not serve. */
export function findTool(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name);
}

/** JSON numbers, and the occasional string a model sends instead. */
function asInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "string" ? Number.parseInt(value, 10) : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

const asString = (value: unknown): string => (typeof value === "string" ? value : "");

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const fail = (message: string): ToolResult => ({
    toolCallId: call.id,
    name: call.name,
    content: message,
    isError: true,
  });

  // The provider could not parse the arguments; hand that back so the model can
  // fix its own call instead of losing the whole run.
  if (call.inputError) return fail(`${call.inputError} (tool: ${call.name})`);
  if (!findTool(call.name)) return fail(`Unknown tool: ${call.name}`);

  try {
    const output = await dispatch(call, ctx);
    return { toolCallId: call.id, name: call.name, content: JSON.stringify(output) };
  } catch (err) {
    ctx.emit.log(`tool ${call.name} failed: ${String(err)}`);
    return fail(err instanceof Error ? err.message : String(err));
  }
}

async function dispatch(call: ToolCall, ctx: ToolContext): Promise<unknown> {
  switch (call.name) {
    case "getHistory":
      return getHistory(call, ctx);
    case "getPageHtml":
      return getPageHtml(call, ctx);
    case "glob":
      return glob(call, ctx);
    case "grep":
      return grep(call, ctx);
    case "read":
      return read(call, ctx);
    case "write":
      return write(call, ctx);
    default:
      throw new Error(`Unknown tool: ${call.name}`);
  }
}

// ---------------------------------------------------------------------------
// browser-backed
// ---------------------------------------------------------------------------

async function getHistory(call: ToolCall, ctx: ToolContext): Promise<GetHistoryResult> {
  const daysToAnalyze = asInt(call.input.daysToAnalyze, DEFAULTS.daysToAnalyze, 1, 90);
  const maxResults = asInt(call.input.maxResults, DEFAULTS.maxResults, 1, 50);

  ctx.emit.phase("history", `${daysToAnalyze}d`);
  const { sites, totalSitesSeen } = await ctx.bridge.getHistory({ daysToAnalyze, maxResults });

  const blockedSites = await ctx.blockedSites();
  const allowed = sites.filter((site) => !isBlocked(site.domain, blockedSites));
  // Blocked domains are dropped from the count too: the model is never told they exist.
  const digest = buildHistoryDigest(allowed, {
    daysToAnalyze,
    maxResults,
    totalSitesSeen: totalSitesSeen - (sites.length - allowed.length),
  });
  ctx.emit.log(`history: ${digest.sites.length} of ${digest.totalSitesSeen} domains`);
  return digest;
}

async function getPageHtml(call: ToolCall, ctx: ToolContext): Promise<GetPageHtmlResult> {
  const requested = Array.isArray(call.input.urls) ? call.input.urls.map(asString).filter(Boolean) : [];
  if (!requested.length) throw new Error("getPageHtml needs at least one url");

  // The schema states this cap in front of the model; enforce it here too. A
  // provider that does not validate tool inputs would otherwise let one call
  // open dozens of tabs in the user's browser, each with its own settle delay.
  const urls = requested.slice(0, DEFAULTS.maxPages);
  const loadDelayMs = asInt(call.input.loadDelayMs, DEFAULTS.loadDelayMs, 0, 30_000);

  ctx.emit.phase("scraping", `${urls.length} pages`);
  const blockedSites = await ctx.blockedSites();

  const allowed: string[] = [];
  const failed: GetPageHtmlResult["failed"] = requested
    .slice(DEFAULTS.maxPages)
    .map((url) => ({ url, reason: `only ${DEFAULTS.maxPages} pages can be opened per call` }));
  for (const url of urls) {
    // Match on the URL the browser will load; malformed URLs never reach the signed-in browser.
    if (isAllowedUrl(url, blockedSites)) allowed.push(url);
    else failed.push({ url, reason: "blocked by the user's settings" });
  }

  // Skip the bridge entirely when nothing is left, so no scraper window opens.
  const scraped = allowed.length
    ? await ctx.bridge.getPageHtml({ urls: allowed, loadDelayMs })
    : { pages: [], failed: [] };
  failed.push(...scraped.failed);

  // A redirect can land on a blocked host; drop what it read before it becomes readable.
  const pages = scraped.pages.filter((page) => {
    if (!page.finalUrl || isAllowedUrl(page.finalUrl, blockedSites)) return true;
    failed.push({ url: page.url, reason: "blocked by the user's settings" });
    return false;
  });
  // Counted after the redirect check, so the number covers both the URLs we were
  // asked for and the ones that quietly landed somewhere else.
  const blockedCount = failed.filter((f) => f.reason === "blocked by the user's settings").length;
  if (blockedCount) ctx.emit.log(`blocked: ${blockedCount} url(s)`);

  const refs: PageRef[] = [];
  for (const page of pages) {
    if (!page.text.trim()) {
      failed.push({ url: page.url, reason: "page had no readable text" });
      continue;
    }
    // The index keeps two pages from the same domain from colliding.
    const path = `${PAGE_DIR}/${slugifyUrl(page.url)}_${refs.length}.html`;
    ctx.pages.set(path, { path, url: page.url, title: page.title, text: page.text });
    refs.push({ url: page.url, title: page.title, path, bytes: page.text.length });
    ctx.emit.log(`page ${page.url} -> ${path} (${page.text.length}b)`);
  }

  return { pages: refs, failed };
}

// ---------------------------------------------------------------------------
// page-backed
// ---------------------------------------------------------------------------

function resolvePage(path: string, ctx: ToolContext): PageFile {
  const page = ctx.pages.get(path);
  if (page) return page;
  const known = [...ctx.pages.keys()];
  throw new Error(
    `No page at ${path}. Use a path exactly as getPageHtml returned it${known.length ? `: ${known.join(", ")}` : ""}`,
  );
}

function glob(call: ToolCall, ctx: ToolContext) {
  const pattern = asString(call.input.pattern).trim().toLowerCase();
  const files = [...ctx.pages.values()]
    .filter((page) => !pattern || page.path.toLowerCase().includes(pattern))
    .map((page) => ({ path: page.path, title: page.title, url: page.url, bytes: page.text.length }));
  return { files, total: files.length };
}

function grep(call: ToolCall, ctx: ToolContext) {
  const pattern = asString(call.input.pattern);
  if (!pattern) throw new Error("grep needs a pattern");
  const ignoreCase = call.input.ignoreCase === true;
  const path = asString(call.input.path).trim();

  const targets = path ? [resolvePage(path, ctx)] : [...ctx.pages.values()];
  if (!targets.length) throw new Error("No pages are loaded. Call getPageHtml first.");

  const matches: Array<{ path: string; line: number; text: string }> = [];
  let totalMatches = 0;
  for (const page of targets) {
    const found = grepText(page.text, pattern, {
      ignoreCase,
      maxResults: DEFAULTS.grepMaxResults - matches.length,
      maxLineLength: DEFAULTS.grepMaxLineLength,
    });
    totalMatches += found.totalMatches;
    for (const match of found.matches) {
      matches.push({ path: page.path, line: match.line, text: match.text });
    }
    if (matches.length >= DEFAULTS.grepMaxResults) break;
  }

  return {
    matches,
    totalMatches,
    truncated: totalMatches > matches.length,
    searched: targets.map((page) => page.path),
  };
}

function read(call: ToolCall, ctx: ToolContext) {
  const page = resolvePage(asString(call.input.path).trim(), ctx);
  const lines = page.text.split("\n");
  const offset = asInt(call.input.offset, 1, 1, Math.max(1, lines.length));
  const limit = asInt(call.input.limit, DEFAULTS.readLines, 1, DEFAULTS.readMaxLines);

  let slice = lines.slice(offset - 1, offset - 1 + limit);
  // Keep one wide range from flooding the context, even inside the line cap.
  let chars = 0;
  let kept = 0;
  for (const line of slice) {
    if (kept > 0 && chars + line.length > DEFAULTS.readMaxChars) break;
    chars += line.length;
    kept++;
  }
  const truncated = kept < slice.length || offset - 1 + slice.length < lines.length;
  slice = slice.slice(0, kept);

  return {
    path: page.path,
    url: page.url,
    title: page.title,
    startLine: offset,
    endLine: offset + slice.length - 1,
    totalLines: lines.length,
    truncated,
    text: slice.map((line, i) => `${offset + i}\t${line}`).join("\n"),
  };
}

function write(call: ToolCall, ctx: ToolContext) {
  const path = asString(call.input.path).trim();
  const content = asString(call.input.content);
  if (!path) throw new Error("write needs a path");
  if (!content.trim()) throw new Error("write needs content");

  if (/\.(tsx|jsx)$/.test(path)) {
    ctx.deliverable = { path, code: content };
    ctx.emit.phase("writing");
    ctx.emit.log(`deliverable written to ${path} (${content.length}b)`);
    return { path, bytes: content.length, delivered: true, expected: path === OUTPUT_PATH };
  }

  // Anything else is scratch. There is no real filesystem behind this, and no
  // other tool reads files back, so say so rather than pretending.
  return {
    path,
    bytes: content.length,
    delivered: false,
    note: `Stored ${path}, but only a .tsx/.jsx file is delivered as the homepage.`,
  };
}
