import { useState } from "react";
import { normalizeBlockList, type Language } from "@homepage/agent-core";
import { REBUILD_INTERVAL_CHOICES } from "@/lib/auto-rebuild";
import { useT } from "@/lib/i18n";
import type { Settings } from "@/lib/storage";
import { ProviderFields, type ProviderDraft } from "./ProviderFields";
import { btn, fieldLabel, hint, input, select, selectInline } from "./ui";

export interface SettingsDraft {
  systemPrompt: string;
  blockedSites: string[];
  provider: ProviderDraft;
  language: Language;
}

const LANGUAGES: Language[] = ["en", "tr"];
const LANGUAGE_LABELS: Record<Language, string> = { en: "English", tr: "Türkçe" };

const divider = { margin: "24px 0 4px", border: "none", borderTop: "1px solid #eee" } as const;

export function SettingsModal({
  settings,
  intervalHours,
  onChangeAutoRebuild,
  onChangeInterval,
  onClose,
  onSave,
}: {
  settings: Settings;
  /** Resolved: the stored value, or the default when unset. */
  intervalHours: number;
  /** These two persist immediately: they decide when a build runs, not what it builds. */
  onChangeAutoRebuild: (next: boolean) => void;
  onChangeInterval: (next: number) => void;
  onClose: () => void;
  onSave: (draft: SettingsDraft) => void;
}) {
  const t = useT();
  const [prompt, setPrompt] = useState(settings.systemPrompt);
  const [blocked, setBlocked] = useState(settings.blockedSites.join("\n"));
  const [language, setLanguage] = useState<Language>(settings.language);
  const [provider, setProvider] = useState<ProviderDraft>({
    provider: settings.provider,
    apiKey: settings.apiKey,
    model: settings.model,
    baseUrl: settings.baseUrl,
  });

  const textarea = { ...input, fontFamily: "inherit", padding: 12, minHeight: 120 } as const;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        style={{
          backgroundColor: "white",
          borderRadius: 8,
          padding: 24,
          width: "90%",
          maxWidth: 600,
          maxHeight: "90vh",
          overflowY: "auto",
        }}
      >
        <h2 style={{ marginTop: 0, color: "#333" }}>{t("settings.title")}</h2>
        <p style={{ color: "#666" }}>{t("settings.blurb")}</p>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={t("settings.promptPlaceholder")}
          style={{ ...textarea, minHeight: 160 }}
        />

        <label style={fieldLabel}>
          {t("settings.blocked")}
          <textarea
            value={blocked}
            onChange={(e) => setBlocked(e.target.value)}
            aria-describedby="blocked-sites-help"
            style={textarea}
          />
        </label>
        <p id="blocked-sites-help" style={hint}>
          {t("settings.blockedHelp")}
        </p>

        <hr style={divider} />

        <ProviderFields value={provider} byProvider={settings.byProvider} onChange={setProvider} />

        <label style={fieldLabel}>
          {t("settings.language")}
          <select style={select} value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
            {LANGUAGES.map((lang) => (
              <option key={lang} value={lang}>
                {LANGUAGE_LABELS[lang]}
              </option>
            ))}
          </select>
        </label>
        <p style={hint}>{t("settings.apiKeyHelp")}</p>

        <hr style={divider} />

        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 16,
            color: "#333",
            fontSize: 14,
            cursor: "pointer",
          }}
        >
          <input
            type="checkbox"
            checked={settings.autoRebuild}
            onChange={(e) => onChangeAutoRebuild(e.target.checked)}
          />
          {t("settings.autoRebuild")}
        </label>
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginTop: 10,
            marginLeft: 24,
            color: settings.autoRebuild ? "#333" : "#aaa",
            fontSize: 14,
          }}
        >
          {t("settings.every")}
          <select
            value={intervalHours}
            disabled={!settings.autoRebuild}
            onChange={(e) => onChangeInterval(Number(e.target.value))}
            style={selectInline}
          >
            {REBUILD_INTERVAL_CHOICES.map((hours) => (
              <option key={hours} value={hours}>
                {hours === 24 ? t("settings.hoursDaily") : t("settings.hours", { hours })}
              </option>
            ))}
          </select>
        </label>
        <p style={hint}>{t("settings.autoRebuildHelp")}</p>

        <div style={{ display: "flex", gap: 12, marginTop: 20, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
          >
            {t("settings.cancel")}
          </button>
          <button
            onClick={() =>
              onSave({
                systemPrompt: prompt,
                blockedSites: normalizeBlockList(blocked.split("\n")),
                provider,
                language,
              })
            }
            style={btn}
          >
            {t("settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
