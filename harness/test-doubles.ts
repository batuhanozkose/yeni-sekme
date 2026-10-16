/**
 * Test doubles for the agent loop.
 *
 * The loop no longer talks to a hosted orchestrator, so a scripted provider can
 * drive a whole build — tool calls, reattach, deliverable — with no network and
 * no API key. That is the point of these: everything the old harness needed
 * credits to prove is now a unit test.
 */
import type {
  KVStore,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  ToolCall,
  ToolResult,
  Turn,
} from "@homepage/agent-core";

export interface FakeToolCall {
  name: string;
  input?: Record<string, unknown>;
  /** Simulate a provider that streamed unparseable arguments. */
  inputError?: string;
}

export interface FakeStep {
  text?: string;
  tools?: FakeToolCall[];
  /** Fail the model call itself, e.g. to test an aborted or erroring run. */
  error?: string;
}

/** A provider that replays a script, recording every request it was given. */
export class FakeProvider implements ModelProvider {
  readonly id = "fake";
  readonly requests: ModelRequest[] = [];
  private step = 0;

  constructor(
    private readonly steps: FakeStep[],
    private readonly hooks: { onRequest?: (req: ModelRequest, step: number) => void } = {},
  ) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const index = this.step++;
    this.requests.push(req);
    this.hooks.onRequest?.(req, index);

    // Past the end of the script, keep repeating the last step: a looping agent
    // should hit the step budget rather than run off the end of the array.
    const step = this.steps[Math.min(index, this.steps.length - 1)] ?? {};
    if (step.error) throw new Error(step.error);

    const tools = step.tools ?? [];
    return {
      text: step.text ?? "",
      toolCalls: tools.map(
        (tool, i): ToolCall => ({
          id: `call-${index}-${i}`,
          name: tool.name,
          input: tool.input ?? {},
          ...(tool.inputError ? { inputError: tool.inputError } : {}),
        }),
      ),
      stopReason: tools.length ? "tool_use" : "end_turn",
    };
  }

  /** The request the loop made last, i.e. the transcript as of the final step. */
  get lastRequest(): ModelRequest | undefined {
    return this.requests[this.requests.length - 1];
  }
}

/** Every tool result present anywhere in a request's transcript. */
export function allResults(req: ModelRequest | undefined): ToolResult[] {
  if (!req) return [];
  return req.turns.flatMap((turn: Turn) => (turn.role === "tool_results" ? turn.results : []));
}

/** Parsed results for one tool name, oldest first. */
export function resultsFor(req: ModelRequest | undefined, name: string): any[] {
  return allResults(req)
    .filter((result) => result.name === name)
    .map((result) => {
      try {
        return JSON.parse(result.content);
      } catch {
        return result.content;
      }
    });
}

export class MemoryKVStore implements KVStore {
  readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

/** A page as `getPageHtml` would have stored it, for resume tests. */
export function storedPage(path: string, url: string, text: string) {
  return { path, url, title: url, text };
}
