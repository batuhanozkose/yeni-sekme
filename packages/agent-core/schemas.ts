/**
 * Tool input schemas and the caps that go with them.
 *
 * The caps live in the schema, not just the handler, so the model can see the
 * ceiling it is working against. Every tool here runs in-process: there is no
 * remote sandbox to hand work to.
 */
import type { ToolInputSchema } from "./types";

/** Where the finished component is expected. Also the path `write` watches for. */
export const OUTPUT_PATH = "/homepage.tsx";

/** Pages the agent can read. Matches the getPageHtml batch cap. */
export const PAGE_DIR = "/pages";

/**
 * Every cap in one place, because they appear in three: the schema the model
 * reads, the prose in the prompt, and the handler that has to enforce them.
 */
export const DEFAULTS = {
  daysToAnalyze: 14,
  maxResults: 30,
  loadDelayMs: 8000,
  /**
   * Pages one build may open. Each one is a real tab in the user's browser plus
   * a settle delay, so this is a wall-clock and browser budget, not a context
   * one — the pages are read through grep/read rather than put in the prompt.
   */
  maxPages: 10,
  /** Cap on titles carried per domain in the digest. */
  sampleTitles: 5,
  /** Anthropic requires an output cap; OpenAI-compatible servers choose their own. */
  maxTokens: 8192,
  /** Line-oriented tools report truncation rather than silently cutting results. */
  grepMaxResults: 80,
  grepMaxLineLength: 400,
  readLines: 250,
  readMaxLines: 500,
  /** Characters returned by one `read`. Keeps a wide range from flooding context. */
  readMaxChars: 24_000,
} as const;

export const GET_HISTORY_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    daysToAnalyze: {
      type: "integer",
      minimum: 1,
      maximum: 90,
      description: `How many days of history to analyze. Default ${DEFAULTS.daysToAnalyze}.`,
    },
    maxResults: {
      type: "integer",
      minimum: 1,
      maximum: 50,
      description: `Top N domains by relevance score. Default ${DEFAULTS.maxResults}.`,
    },
  },
  required: [],
};

export const GET_PAGE_HTML_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    urls: {
      type: "array",
      minItems: 1,
      maxItems: DEFAULTS.maxPages,
      items: { type: "string" },
      description:
        "URLs to load in real browser tabs. Authenticated, JS-rendered pages work — " +
        "this is the user's own logged-in browser, not a fetch from a datacenter.",
    },
    loadDelayMs: {
      type: "integer",
      minimum: 0,
      maximum: 30000,
      description: `Extra wait after load, for lazy-rendered content. Default ${DEFAULTS.loadDelayMs}.`,
    },
  },
  required: ["urls"],
};

export const GLOB_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Substring to filter paths by, e.g. 'news'. Omit to list every page.",
    },
  },
  required: [],
};

export const GREP_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    pattern: {
      type: "string",
      description: "Regular expression to search for, matched against single lines.",
    },
    path: {
      type: "string",
      description: "Restrict the search to one page path. Omit to search every page.",
    },
    ignoreCase: { type: "boolean", description: "Case-insensitive match. Default false." },
  },
  required: ["pattern"],
};

export const READ_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    path: {
      type: "string",
      description: "Page path exactly as getPageHtml returned it.",
    },
    offset: {
      type: "integer",
      minimum: 1,
      description: "First line to return, 1-based. Default 1.",
    },
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 500,
      description: `How many lines to return. Default ${DEFAULTS.readLines}.`,
    },
  },
  required: ["path"],
};

export const WRITE_SCHEMA: ToolInputSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: `Where to write. The homepage goes to ${OUTPUT_PATH}.` },
    content: { type: "string", description: "The full file contents." },
  },
  required: ["path", "content"],
};

