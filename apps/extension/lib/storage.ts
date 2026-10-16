import {
  DEFAULT_BLOCKED_SITES,
  DEFAULT_PROVIDER_ID,
  PROVIDERS,
  STORAGE_KEYS as AGENT_KEYS,
  getProvider,
  type KVStore,
  type Language,
  type ProviderSpec,
} from "@homepage/agent-core";
import { detectLanguage } from "./i18n";

/**
 * Everything the extension persists, in one place. All of it lives in
 * chrome.storage.local — including the API keys, which anyone with access to the
 * browser profile can read. Fine for a tool you run yourself; not for one you
 * distribute (see ARCHITECTURE.md → Privacy).
 *
 * Keys, models and base URLs are stored per provider, so switching provider and
 * switching back does not lose the other one's key.
 */
export const KEYS = {
  ...AGENT_KEYS,
  homepage: "homepageData",
  systemPrompt: "systemPrompt",
  blockedSites: "blockedSites",
  provider: "provider",
  apiKeys: "apiKeys",
  models: "models",
  baseUrls: "baseUrls",
  language: "language",
  autoRebuild: "autoRebuild",
  /** ISO timestamp of the last auto-build *attempted* (success or not). */
  lastAutoBuildAttempt: "lastAutoBuildAttempt",
  rebuildIntervalHours: "autoRebuildIntervalHours",
  /** Throttled mirror of the live build state, for tabs that open while the worker sleeps. */
  buildSnapshot: "buildSnapshot",
} as const;

export interface Homepage {
  /** The agent's raw TSX source. */
  code: string;
  /** ISO timestamp of when it was built. */
  timestamp: string;
}

export interface ProviderBlock {
  apiKey: string;
  model: string;
  baseUrl: string;
}

export interface Settings {
  provider: string;
  /** The active provider's spec, so callers never re-resolve it. */
  spec: ProviderSpec;
  /** The active provider's key. Empty for local servers that take none. */
  apiKey: string;
  /** The active provider's base URL: the stored override, else the spec's. */
  baseUrl: string;
  model: string;
  /** Every provider's stored values, so switching provider in the UI can prefill. */
  byProvider: Record<string, ProviderBlock>;
  systemPrompt: string;
  blockedSites: string[];
  language: Language;
  /** Unset means on — auto-rebuild is opt-out. */
  autoRebuild: boolean;
  rebuildIntervalHours: number | null;
}

/** The `KVStore` agent-core persists its run through. */
export const extensionStore: KVStore = {
  async get<T>(key: string): Promise<T | undefined> {
    const result = await browser.storage.local.get(key);
    return result[key] as T | undefined;
  },
  async set(key: string, value: unknown): Promise<void> {
    await browser.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await browser.storage.local.remove(key);
  },
};

/** Whether this provider can run a build at all. Local servers need no key. */
export function hasCredentials(settings: Settings): boolean {
  return !settings.spec.needsKey || Boolean(settings.apiKey.trim());
}

/** Whether the build can actually be described as ready to go. */
export function missingSetup(settings: Settings): string | null {
  if (settings.spec.needsKey && !settings.apiKey.trim()) return "apiKey";
  if (!settings.model.trim()) return "model";
  if (!settings.baseUrl.trim()) return "baseUrl";
  return null;
}

function asRecord(value: unknown): Record<string, string> {
  return value && typeof value === "object" ? (value as Record<string, string>) : {};
}

export async function loadSettings(): Promise<Settings> {
  const s = await browser.storage.local.get([
    KEYS.provider,
    KEYS.apiKeys,
    KEYS.models,
    KEYS.baseUrls,
    KEYS.systemPrompt,
    KEYS.blockedSites,
    KEYS.language,
    KEYS.autoRebuild,
    KEYS.rebuildIntervalHours,
  ]);

  // A stored provider that no longer exists falls back rather than breaking.
  const storedProvider = s[KEYS.provider] as string | undefined;
  const spec = PROVIDERS.some((p) => p.id === storedProvider)
    ? getProvider(storedProvider!)
    : getProvider(DEFAULT_PROVIDER_ID);

  const keys = asRecord(s[KEYS.apiKeys]);
  const models = asRecord(s[KEYS.models]);
  const baseUrls = asRecord(s[KEYS.baseUrls]);

  const byProvider: Record<string, ProviderBlock> = {};
  for (const provider of PROVIDERS) {
    byProvider[provider.id] = {
      apiKey: keys[provider.id] ?? "",
      model: models[provider.id] ?? provider.models[0] ?? "",
      baseUrl: baseUrls[provider.id] ?? provider.baseUrl,
    };
  }

  const active = byProvider[spec.id]!;

  return {
    provider: spec.id,
    spec,
    apiKey: active.apiKey,
    baseUrl: active.baseUrl,
    model: active.model,
    byProvider,
    systemPrompt: (s[KEYS.systemPrompt] as string | undefined) ?? "",
    blockedSites: (s[KEYS.blockedSites] as string[] | undefined) ?? [...DEFAULT_BLOCKED_SITES],
    language: (s[KEYS.language] as Language | undefined) ?? detectLanguage(navigator.language),
    autoRebuild: s[KEYS.autoRebuild] !== false,
    rebuildIntervalHours: (s[KEYS.rebuildIntervalHours] as number | undefined) ?? null,
  };
}

/** Persist one provider's credentials, model and URL together. */
export async function saveProviderBlock(providerId: string, block: ProviderBlock): Promise<void> {
  const stored = await browser.storage.local.get([KEYS.apiKeys, KEYS.models, KEYS.baseUrls]);
  const keys = asRecord(stored[KEYS.apiKeys]);
  const models = asRecord(stored[KEYS.models]);
  const baseUrls = asRecord(stored[KEYS.baseUrls]);
  keys[providerId] = block.apiKey;
  models[providerId] = block.model;
  baseUrls[providerId] = block.baseUrl;
  await browser.storage.local.set({
    [KEYS.apiKeys]: keys,
    [KEYS.models]: models,
    [KEYS.baseUrls]: baseUrls,
  });
}

export const saveProvider = (id: string) => browser.storage.local.set({ [KEYS.provider]: id });
export const saveLanguage = (language: Language) => browser.storage.local.set({ [KEYS.language]: language });
export const saveAutoRebuild = (on: boolean) => browser.storage.local.set({ [KEYS.autoRebuild]: on });
export const saveRebuildInterval = (hours: number) =>
  browser.storage.local.set({ [KEYS.rebuildIntervalHours]: hours });

export async function savePromptAndBlockedSites(systemPrompt: string, blockedSites: string[]): Promise<void> {
  await browser.storage.local.set({ [KEYS.systemPrompt]: systemPrompt, [KEYS.blockedSites]: blockedSites });
}

export async function loadHomepage(): Promise<Homepage | undefined> {
  return extensionStore.get<Homepage>(KEYS.homepage);
}

export async function saveHomepage(code: string): Promise<void> {
  const homepage: Homepage = { code, timestamp: new Date().toISOString() };
  await extensionStore.set(KEYS.homepage, homepage);
}
