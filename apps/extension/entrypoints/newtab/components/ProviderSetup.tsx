import { useState } from "react";
import { getProvider } from "@homepage/agent-core";
import { useT } from "@/lib/i18n";
import type { ProviderBlock } from "@/lib/storage";
import { ProviderFields, type ProviderDraft } from "./ProviderFields";
import { btn } from "./ui";

/**
 * First run: nothing works until a provider is chosen and (usually) a key is
 * entered, so this screen is only ever about that.
 */
export function ProviderSetup({
  initial,
  byProvider,
  onSave,
}: {
  initial: ProviderDraft;
  byProvider: Record<string, ProviderBlock>;
  onSave: (next: ProviderDraft) => void;
}) {
  const t = useT();
  const [draft, setDraft] = useState<ProviderDraft>(initial);
  const spec = getProvider(draft.provider);

  const ready =
    (!spec.needsKey || draft.apiKey.trim().length > 0) &&
    draft.model.trim().length > 0 &&
    draft.baseUrl.trim().length > 0;

  return (
    <div style={{ maxWidth: 520, margin: "12vh auto", padding: 24, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 24 }}>{t("setup.title")}</h1>
      <p style={{ color: "#555", lineHeight: 1.6 }}>{t("setup.blurb")}</p>

      <ProviderFields value={draft} byProvider={byProvider} onChange={setDraft} />

      <button
        style={{ ...btn, marginTop: 20, opacity: ready ? 1 : 0.5 }}
        disabled={!ready}
        onClick={() => onSave(draft)}
      >
        {t("setup.save")}
      </button>
    </div>
  );
}
