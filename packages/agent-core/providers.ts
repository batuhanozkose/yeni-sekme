/**
 * The two wire formats, and the only place in this package that touches the
 * network.
 *
 * Both adapters are stateless: the orchestrator owns the transcript and passes
 * the whole thing on every call, so a run can move between providers without
 * anything server-side following along. There is no SDK here on purpose — two
 * small JSON calls are less code than the abstractions a client library adds,
 * and neither one needs a Node shim in the extension bundle.
 */
import type { ProviderSpec } from "./catalog";
import { DEFAULTS } from "./schemas";
import type { ModelProvider, ModelRequest, ModelResponse, ToolCall, Turn } from "./types";

export interface ProviderConfig {
  spec: ProviderSpec;
  apiKey: string;
  model: string;
  /** Overrides `spec.baseUrl` — Ollama and self-hosted endpoints. */
  baseUrl?: string;
  /** Anthropic requires one; OpenAI-compatible servers pick their own default. */
  maxTokens?: number;
}

export function resolveBaseUrl(config: { spec: ProviderSpec; baseUrl?: string | null }): string {
  return (config.baseUrl ?? config.spec.baseUrl).trim().replace(/\/+$/, "");
}

/**
 * The URL a build will actually call.
 *
 * Exported so the settings screen can show it back: an OpenAI-compatible base
 * URL has to carry its own `/v1`, and getting that wrong is a 404 that reads
 * like a rejected key.
 */
export function endpointFor(config: { spec: ProviderSpec; baseUrl?: string | null }): string {
  const base = resolveBaseUrl(config);
  return config.spec.kind === "anthropic" ? `${base}/v1/messages` : `${base}/chat/completions`;
}

/** A provider call that failed in a way worth showing the user verbatim. */
export class ProviderError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    // A browser-level failure: CORS, DNS, offline, or a local server that is
    // simply not running. Say which endpoint, since "Failed to fetch" alone
    // sends people looking in the wrong place.
    throw new ProviderError(0, String(err), `Could not reach ${url} (${String(err)})`);
  }

  const raw = await response.text();
  if (!response.ok) {
    throw new ProviderError(
      response.status,
      raw.slice(0, 600),
      `${response.status} ${response.statusText} from ${url}: ${raw.slice(0, 300)}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError(response.status, raw.slice(0, 600), `${url} did not return JSON`);
  }
}

/** Models occasionally emit tool arguments that are not valid JSON. */
function parseArguments(raw: unknown): { input: Record<string, unknown>; inputError?: string } {
  if (raw === undefined || raw === null || raw === "") return { input: {} };
  if (typeof raw === "object") return { input: raw as Record<string, unknown> };
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === "object"
      ? { input: parsed as Record<string, unknown> }
      : { input: {}, inputError: "tool arguments were not a JSON object" };
  } catch (err) {
    return { input: {}, inputError: `tool arguments were not valid JSON: ${String(err)}` };
  }
}

// ---------------------------------------------------------------------------
// Anthropic Messages API
// ---------------------------------------------------------------------------

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean };

function toAnthropicMessages(turns: Turn[]): Array<{ role: "user" | "assistant"; content: AnthropicBlock[] }> {
  return turns.map((turn) => {
    switch (turn.role) {
      case "user":
        return { role: "user", content: [{ type: "text", text: turn.text }] };
      case "assistant": {
        const content: AnthropicBlock[] = [];
        // An empty text block is rejected, so only send one when there is one.
        if (turn.text.trim()) content.push({ type: "text", text: turn.text });
        for (const call of turn.toolCalls) {
          content.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
        }
        return { role: "assistant", content };
      }
      case "tool_results":
        // Tool results ride back on a user turn, one block per call.
        return {
          role: "user",
          content: turn.results.map((result) => ({
            type: "tool_result" as const,
            tool_use_id: result.toolCallId,
            content: result.content,
            ...(result.isError ? { is_error: true } : {}),
          })),
        };
    }
  });
}

function makeAnthropicProvider(config: ProviderConfig): ModelProvider {
  const url = endpointFor(config);
  return {
    id: config.spec.id,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const data = await postJson(
        url,
        {
          "x-api-key": config.apiKey,
          "anthropic-version": "2023-06-01",
          // Without this the API rejects any request whose Origin is a browser.
          // The key lives in the user's own profile; see ARCHITECTURE.md → Privacy.
          "anthropic-dangerous-direct-browser-access": "true",
        },
        {
          model: config.model,
          max_tokens: config.maxTokens ?? DEFAULTS.maxTokens,
          system: req.system,
          tools: req.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.input_schema,
          })),
          messages: toAnthropicMessages(req.turns),
        },
        req.signal,
      );

      const blocks: AnthropicBlock[] = data.content ?? [];
      const toolCalls: ToolCall[] = blocks
        .filter((block): block is Extract<AnthropicBlock, { type: "tool_use" }> => block.type === "tool_use")
        .map((block) => ({ id: block.id, name: block.name, ...parseArguments(block.input) }));

      return {
        text: blocks
          .filter((block): block is Extract<AnthropicBlock, { type: "text" }> => block.type === "text")
          .map((block) => block.text)
          .join(""),
        toolCalls,
        stopReason: String(data.stop_reason ?? ""),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions (OpenAI, OpenRouter, Groq, Ollama, vLLM, LM Studio)
// ---------------------------------------------------------------------------

type OpenAIMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }> }
  | { role: "tool"; tool_call_id: string; content: string };

function toOpenAIMessages(system: string, turns: Turn[]): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [{ role: "system", content: system }];
  for (const turn of turns) {
    switch (turn.role) {
      case "user":
        messages.push({ role: "user", content: turn.text });
        break;
      case "assistant": {
        const message: OpenAIMessage = { role: "assistant", content: turn.text };
        if (turn.toolCalls.length) {
          message.tool_calls = turn.toolCalls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.input) },
          }));
        }
        messages.push(message);
        break;
      }
      case "tool_results":
        // One message per result, addressed by id.
        for (const result of turn.results) {
          messages.push({ role: "tool", tool_call_id: result.toolCallId, content: result.content });
        }
        break;
    }
  }
  return messages;
}

function makeOpenAIProvider(config: ProviderConfig): ModelProvider {
  const url = endpointFor(config);
  return {
    id: config.spec.id,
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const headers: Record<string, string> = {};
      // Local servers (Ollama, LM Studio) take no key at all.
      if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;

      const data = await postJson(
        url,
        headers,
        {
          model: config.model,
          messages: toOpenAIMessages(req.system, req.turns),
          tools: req.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.input_schema,
            },
          })),
          tool_choice: "auto",
          // No token cap on purpose: `max_tokens` and `max_completion_tokens`
          // disagree across these servers, and only one of them is accepted by
          // any given model. The server default is the portable choice.
        },
        req.signal,
      );

      const choice = data.choices?.[0];
      if (!choice) {
        throw new ProviderError(200, JSON.stringify(data).slice(0, 600), `${url} returned no choices`);
      }
      const message = choice.message ?? {};

      const rawCalls: any[] = message.tool_calls ?? [];
      const toolCalls: ToolCall[] = rawCalls.map((call, index) => ({
        // Some local servers omit the id entirely.
        id: String(call.id ?? `call_${index}`),
        name: String(call.function?.name ?? ""),
        ...parseArguments(call.function?.arguments),
      }));

      return {
        text: typeof message.content === "string" ? message.content : "",
        toolCalls,
        stopReason: String(choice.finish_reason ?? ""),
      };
    },
  };
}

/** Build a provider for a resolved config, or throw if the config is incomplete. */
export function createProvider(config: ProviderConfig): ModelProvider {
  if (!config.model.trim()) {
    throw new Error(`No model selected for ${config.spec.label}`);
  }
  if (config.spec.needsKey && !config.apiKey.trim()) {
    throw new Error(`No API key set for ${config.spec.label}`);
  }
  if (!resolveBaseUrl(config)) {
    throw new Error(`No base URL set for ${config.spec.label}`);
  }
  return config.spec.kind === "anthropic" ? makeAnthropicProvider(config) : makeOpenAIProvider(config);
}
