import { PROVIDERS, endpointFor, getProvider, type ProviderSpec } from "@homepage/agent-core";
import { useT } from "@/lib/i18n";
import type { ProviderBlock } from "@/lib/storage";
import { fieldLabel, hint, input, select } from "./ui";

export interface ProviderDraft extends ProviderBlock {
  provider: string;
}

/**
 * Provider, credentials, model and URL in one block, shared by the first-run
 * screen and Settings. Switching provider pulls that provider's stored values
 * back, so moving between two configured providers does not clear either one.
 */
export function ProviderFields({
  value,
  byProvider,
  onChange,
}: {
  value: ProviderDraft;
  /** Every provider's stored values, for switching. */
  byProvider: Record<string, ProviderBlock>;
  onChange: (next: ProviderDraft) => void;
}) {
  const t = useT();
  const spec: ProviderSpec = getProvider(value.provider);

  const selectProvider = (id: string) => {
    const next = getProvider(id);
    const stored = byProvider[id];
    onChange({
      provider: id,
      apiKey: stored?.apiKey ?? "",
      model: stored?.model ?? next.models[0] ?? "",
      baseUrl: stored?.baseUrl ?? next.baseUrl,
    });
  };

  const modelListId = `models-${spec.id}`;
  const endpoint = endpointFor({ spec, baseUrl: value.baseUrl });

  return (
    <>
      <label style={fieldLabel}>
        {t("setup.provider")}
        <select style={select} value={spec.id} onChange={(e) => selectProvider(e.target.value)}>
          {PROVIDERS.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.label}
            </option>
          ))}
        </select>
      </label>

      {spec.editableBaseUrl && (
        <label style={fieldLabel}>
          {t("setup.baseUrl")}
          <input
            style={{ ...input, fontFamily: "ui-monospace, monospace" }}
            value={value.baseUrl}
            placeholder="https://your-host/v1"
            onChange={(e) => onChange({ ...value, baseUrl: e.target.value })}
          />
        </label>
      )}

      {/* Shown back because the base URL has to carry its own /v1 on an
          OpenAI-compatible endpoint, and a missing one is a 404 that reads like
          a rejected key. */}
      {spec.editableBaseUrl && value.baseUrl.trim() && (
        <p style={{ ...hint, fontFamily: "ui-monospace, monospace", wordBreak: "break-all" }}>
          {t("setup.calls")} {endpoint}
        </p>
      )}

      {/* The field stays available even when a key is not required: any endpoint
          can sit behind a gateway that wants a Bearer token. */}
      <label style={fieldLabel}>
        {spec.needsKey ? t("setup.apiKey") : t("setup.apiKeyOptional")}
        <input
          style={{ ...input, fontFamily: "ui-monospace, monospace" }}
          type="password"
          value={value.apiKey}
          placeholder={spec.keyHint || undefined}
          onChange={(e) => onChange({ ...value, apiKey: e.target.value })}
        />
      </label>
      {spec.id === "ollama" && <p style={hint}>{t("setup.runsLocally")}</p>}
      {spec.keyUrl && (
        <p style={hint}>
          <a href={spec.keyUrl} target="_blank" rel="noreferrer" style={{ color: "#0066cc" }}>
            {spec.keyUrl}
          </a>
        </p>
      )}

      <label style={fieldLabel}>
        {t("setup.model")}
        <input
          style={input}
          value={value.model}
          list={spec.models.length ? modelListId : undefined}
          placeholder={spec.modelPlaceholder}
          onChange={(e) => onChange({ ...value, model: e.target.value })}
        />
      </label>
      {spec.models.length > 0 && (
        <datalist id={modelListId}>
          {spec.models.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      )}
    </>
  );
}
