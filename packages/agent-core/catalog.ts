/**
 * The providers the extension can talk to, and what each one needs.
 *
 * Every entry is a plain HTTPS endpoint the service worker calls directly with
 * the user's own key, so `kind` is the only thing that varies at runtime: two
 * wire formats cover all of them. Anything that speaks the OpenAI Chat
 * Completions API — OpenAI, OpenRouter, Groq, vLLM, LM Studio, Ollama — is the
 * same adapter with a different base URL.
 */

/** Which wire format an endpoint speaks. */
export type ProviderKind = "anthropic" | "openai";

export interface ProviderSpec {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Empty for `custom`, where the user supplies the whole URL. */
  baseUrl: string;
  /**
   * Model ids to offer as autocomplete. Intentionally short: model names move
   * faster than this repo does, so the field stays free text and this list is
   * only a nudge.
   */
  models: string[];
  modelPlaceholder: string;
  /**
   * Whether a key must be present before a build can run. It stays *editable*
   * either way — any endpoint can sit behind a gateway that wants a Bearer
   * token, including a local one.
   */
  needsKey: boolean;
  /** Ollama and self-hosted servers are the user's own URL to get wrong. */
  editableBaseUrl: boolean;
  keyHint: string;
  keyUrl?: string;
}

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    kind: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
    modelPlaceholder: "claude-sonnet-5-5",
    needsKey: true,
    editableBaseUrl: false,
    keyHint: "sk-ant-...",
    keyUrl: "https://console.anthropic.com",
  },
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    baseUrl: "https://api.openai.com/v1",
    models: ["gpt-4o", "gpt-4o-mini"],
    modelPlaceholder: "gpt-4o-mini",
    needsKey: true,
    editableBaseUrl: false,
    keyHint: "sk-...",
    keyUrl: "https://platform.openai.com/api-keys",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    models: [],
    modelPlaceholder: "anthropic/claude-sonnet-4",
    needsKey: true,
    editableBaseUrl: false,
    keyHint: "sk-or-...",
    keyUrl: "https://openrouter.ai/keys",
  },
  {
    id: "groq",
    label: "Groq",
    kind: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    models: [],
    modelPlaceholder: "llama-3.3-70b-versatile",
    needsKey: true,
    editableBaseUrl: false,
    keyHint: "gsk_...",
    keyUrl: "https://console.groq.com/keys",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    kind: "openai",
    baseUrl: "http://localhost:11434/v1",
    models: [],
    modelPlaceholder: "llama3.1",
    needsKey: false,
    editableBaseUrl: true,
    keyHint: "",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    kind: "openai",
    baseUrl: "",
    models: [],
    modelPlaceholder: "model-name",
    needsKey: false,
    editableBaseUrl: true,
    keyHint: "",
  },
];

export const DEFAULT_PROVIDER_ID = "anthropic";

export function getProvider(id: string): ProviderSpec {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]!;
}

/** The model to prefill when the provider changes, if we can suggest one. */
export function defaultModelFor(spec: ProviderSpec): string {
  return spec.models[0] ?? "";
}
