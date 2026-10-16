import { useCallback, useEffect, useState } from "react";
import { DEFAULT_REBUILD_INTERVAL_HOURS } from "@/lib/auto-rebuild";
import { useT, LanguageProvider } from "@/lib/i18n";
import { BUILD_STEPS } from "@/lib/protocol";
import {
  KEYS,
  extensionStore,
  loadHomepage,
  loadSettings,
  missingSetup,
  saveAutoRebuild,
  saveLanguage,
  savePromptAndBlockedSites,
  saveProvider,
  saveProviderBlock,
  saveRebuildInterval,
  type Settings,
} from "@/lib/storage";
import { toRenderable } from "@/lib/transpile";
import { BuildProgress } from "./components/BuildProgress";
import { HomepagePreview } from "./components/HomepagePreview";
import { ProviderSetup } from "./components/ProviderSetup";
import type { ProviderDraft } from "./components/ProviderFields";
import { SettingsModal, type SettingsDraft } from "./components/SettingsModal";
import { btn, errorBox } from "./components/ui";
import { useHomepageBuild } from "./useHomepageBuild";

export default function App() {
  const [settings, setSettings] = useState<Settings | null>(null);

  useEffect(() => {
    void loadSettings().then(setSettings);
  }, []);

  // Language-neutral while loading: the setting that decides the language is
  // what we are waiting for.
  if (!settings) {
    return <div style={{ padding: 40, textAlign: "center", color: "#bbb", fontFamily: "system-ui" }}>●</div>;
  }

  return (
    <LanguageProvider language={settings.language}>
      <Home settings={settings} onSettingsChange={setSettings} />
    </LanguageProvider>
  );
}

function Home({
  settings,
  onSettingsChange,
}: {
  settings: Settings;
  onSettingsChange: (next: Settings) => void;
}) {
  const t = useT();
  /** Transpiled homepage, ready for Sandpack. */
  const [renderedCode, setRenderedCode] = useState<string | null>(null);
  /** A run left mid-flight, offered as "Resume interrupted build". */
  const [resumable, setResumable] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /** Expand the full progress view over an existing homepage. */
  const [viewProgress, setViewProgress] = useState(false);
  /** The error the user dismissed, so a stale banner doesn't linger. */
  const [dismissedError, setDismissedError] = useState<string | null>(null);

  const { state, build, cancel } = useHomepageBuild((code) => setRenderedCode(toRenderable(code)));

  useEffect(() => {
    document.documentElement.lang = settings.language;
  }, [settings.language]);

  // Once a build finishes, drop back to the homepage view.
  useEffect(() => {
    if (!state.running) setViewProgress(false);
  }, [state.running]);

  // Scheduled rebuilds are driven by the worker's alarm, not by opening a tab;
  // useHomepageBuild surfaces any build already in flight.
  useEffect(() => {
    (async () => {
      const [homepage, run] = await Promise.all([
        loadHomepage(),
        extensionStore.get<unknown>(KEYS.activeRun),
      ]);
      if (homepage?.code) setRenderedCode(toRenderable(homepage.code));
      setResumable(Boolean(run));
    })();
  }, []);

  const saveProviderSetup = useCallback(
    async (draft: ProviderDraft) => {
      await Promise.all([saveProvider(draft.provider), saveProviderBlock(draft.provider, draft)]);
      onSettingsChange(await loadSettings());
    },
    [onSettingsChange],
  );

  const saveSettings = useCallback(
    async (draft: SettingsDraft) => {
      await Promise.all([
        savePromptAndBlockedSites(draft.systemPrompt, draft.blockedSites),
        saveProvider(draft.provider.provider),
        saveProviderBlock(draft.provider.provider, draft.provider),
        saveLanguage(draft.language),
      ]);
      onSettingsChange(await loadSettings());
      setShowSettings(false);
      setRenderedCode(null);
      build();
    },
    [build, onSettingsChange],
  );

  // These persist immediately; the worker reads them on its next heartbeat or build.
  const changeAutoRebuild = useCallback(
    async (next: boolean) => {
      await saveAutoRebuild(next);
      onSettingsChange(await loadSettings());
    },
    [onSettingsChange],
  );
  const changeInterval = useCallback(
    async (next: number) => {
      await saveRebuildInterval(next);
      onSettingsChange(await loadSettings());
    },
    [onSettingsChange],
  );

  // Rendered once and reused: both the "no homepage yet" screen and the
  // finished-homepage view can open settings.
  const settingsModal = showSettings && (
    <SettingsModal
      settings={settings}
      intervalHours={settings.rebuildIntervalHours ?? DEFAULT_REBUILD_INTERVAL_HOURS}
      onChangeAutoRebuild={changeAutoRebuild}
      onChangeInterval={changeInterval}
      onClose={() => setShowSettings(false)}
      onSave={saveSettings}
    />
  );

  // Nothing works without a provider, so this screen comes before anything else.
  if (missingSetup(settings)) {
    return (
      <ProviderSetup
        initial={{
          provider: settings.provider,
          apiKey: settings.apiKey,
          model: settings.model,
          baseUrl: settings.baseUrl,
        }}
        byProvider={settings.byProvider}
        onSave={saveProviderSetup}
      />
    );
  }

  // With no homepage to fall back to, a running build takes over the tab.
  if (state.running && (!renderedCode || viewProgress)) {
    return (
      <BuildProgress
        state={state}
        onCancel={cancel}
        onBack={renderedCode ? () => setViewProgress(false) : undefined}
      />
    );
  }

  if (!renderedCode) {
    return (
      <div style={{ maxWidth: 560, margin: "14vh auto", padding: 24, fontFamily: "system-ui" }}>
        <h1 style={{ fontSize: 26 }}>{t("app.buildTitle")}</h1>
        <p style={{ color: "#555", lineHeight: 1.6 }}>{t("app.buildBlurb")}</p>
        {state.error && (
          <div style={{ ...errorBox, margin: "16px 0", padding: 12, borderRadius: 4 }}>{state.error}</div>
        )}
        <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
          <button style={btn} onClick={() => build()}>
            {t("app.buildCta")}
          </button>
          {resumable && (
            <button style={{ ...btn, backgroundColor: "#555" }} onClick={() => build({ resume: true })}>
              {t("app.buildResume")}
            </button>
          )}
          <button
            style={{ ...btn, backgroundColor: "white", color: "#333", border: "1px solid #ddd" }}
            onClick={() => setShowSettings(true)}
            title={t("app.settingsTitle")}
          >
            {t("app.settings")}
          </button>
        </div>
        {showSettings && settingsModal}
      </div>
    );
  }

  const showError = state.error && dismissedError !== state.error;

  return (
    <div style={{ height: "100vh", width: "100vw" }}>
      <div style={{ position: "fixed", top: 20, right: 20, zIndex: 999, display: "flex", gap: 8 }}>
        {state.running ? (
          // A build is running in the background (from here, another tab, or the
          // scheduled rebuild). Let the user watch it without losing this page.
          <button
            style={{ ...btn, backgroundColor: "#0a7", display: "flex", alignItems: "center", gap: 8 }}
            onClick={() => setViewProgress(true)}
            title={t("app.progressTitle")}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: "white",
                animation: "hb-pulse 1.2s ease-in-out infinite",
              }}
            />
            {t("app.building", { step: Math.min(state.stepIndex + 1, BUILD_STEPS.length), total: BUILD_STEPS.length })}
          </button>
        ) : (
          <button style={btn} onClick={() => build()} title={t("app.rebuildNowTitle")}>
            {t("app.rebuild")}
          </button>
        )}
        <button style={btn} onClick={() => setShowSettings(true)} title={t("app.settingsTitle")}>
          {t("app.settings")}
        </button>
      </div>

      {showError && (
        <div
          style={{
            ...errorBox,
            position: "fixed",
            top: 20,
            left: 20,
            right: 260,
            zIndex: 999,
            padding: "10px 14px",
            borderRadius: 6,
            display: "flex",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          <span style={{ flex: 1 }}>
            <b>{t("app.failed")}</b> {state.error}
          </span>
          <button style={{ ...btn, padding: "4px 10px", backgroundColor: "#a02620" }} onClick={() => build()}>
            {t("app.retry")}
          </button>
          <button
            onClick={() => setDismissedError(state.error)}
            style={{
              background: "transparent",
              border: "none",
              color: "#a02620",
              cursor: "pointer",
              fontSize: 16,
              lineHeight: 1,
            }}
            title={t("app.dismiss")}
          >
            ✕
          </button>
        </div>
      )}

      <HomepagePreview code={renderedCode} />

      {settingsModal}
    </div>
  );
}
