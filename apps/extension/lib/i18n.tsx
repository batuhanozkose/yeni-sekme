import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { Language } from "@homepage/agent-core";

export type { Language };

/**
 * Every string the extension itself shows. `chrome.i18n` is the usual answer,
 * but it is pinned to the browser's UI language and cannot be changed while the
 * extension runs — and this app already has a settings screen, so the choice
 * belongs there.
 *
 * The generated homepage is a separate concern: its own copy follows this
 * setting, while the headlines it quotes stay in whatever language it found
 * them in (see `buildKickoffMessage`).
 */
const STRINGS = {
  en: {
    "app.loading": "Loading…",
    "app.buildTitle": "Build your homepage",
    "app.buildBlurb":
      "The agent reads your browsing history, opens the pages you actually follow, and writes a homepage from what it finds today.",
    "app.buildCta": "Build today's homepage",
    "app.buildResume": "Resume interrupted build",
    "app.building": "Building… {step}/{total}",
    "app.rebuild": "↻ Rebuild",
    "app.settings": "⚙️ Settings",
    "app.failed": "Build failed.",
    "app.retry": "Retry",
    "app.dismiss": "Dismiss",
    "app.rebuildNowTitle": "Rebuild now",
    "app.settingsTitle": "Customize homepage",
    "app.progressTitle": "View build progress",

    "setup.title": "Connect your model provider",
    "setup.blurb":
      "The agent runs inside this extension and calls your model provider directly — there is no server in between. Your key is stored in chrome.storage.local on this machine and is never sent anywhere else.",
    "setup.provider": "Provider",
    "setup.model": "Model",
    "setup.apiKey": "API key",
    "setup.baseUrl": "Server URL",
    "setup.apiKeyOptional": "API key (optional)",
    "setup.runsLocally": "Runs on this machine; needs no API key.",
    "setup.calls": "Calls",
    "setup.save": "Save",

    "progress.title": "Building your homepage",
    "progress.cancel": "Cancel",
    "progress.back": "← Back to homepage",
    "progress.agent": "Agent",
    "progress.log": "Activity log",
    "progress.warming": "Warming up — reading what you've been browsing…",

    "step.prepare": "Preparing agent",
    "step.history": "Reading your history",
    "step.scraping": "Opening pages in your browser",
    "step.analyzing": "Analyzing pages",
    "step.writing": "Writing your homepage",

    "settings.title": "Customize your homepage",
    "settings.blurb": "Standing instructions applied to every build.",
    "settings.promptPlaceholder":
      "e.g. 'Focus on tech news and Rust releases', 'Always surface unread GitHub PRs first'",
    "settings.blocked": "Sites the agent never reads",
    "settings.blockedHelp": "One per line. Subdomains are included. Use *.example.com for wildcards.",
    "settings.provider": "Provider",
    "settings.model": "Model",
    "settings.apiKey": "API key",
    "settings.apiKeyHelp": "Stored in chrome.storage.local; anyone with access to this browser profile can read it.",
    "settings.baseUrl": "Server URL",
    "settings.language": "Language",
    "settings.autoRebuild": "Rebuild automatically",
    "settings.every": "Every",
    "settings.hours": "{hours} hours",
    "settings.hoursDaily": "24 hours (daily)",
    "settings.autoRebuildHelp":
      "When on, the extension rebuilds in the background once your homepage is this old, so your next tab shows a fresh one (uses your API key).",
    "settings.cancel": "Cancel",
    "settings.save": "Save & rebuild",

    "error.noCredentials": "No API key found for {provider}. Add one and try again.",
    "notify.failed": "Homepage build failed",
  },
  tr: {
    "app.loading": "Yükleniyor…",
    "app.buildTitle": "Kendi ana sayfanı oluştur",
    "app.buildBlurb":
      "Ajan tarama geçmişine bakar, gerçekten takip ettiğin sayfaları açar ve bugün bulduklarından bir ana sayfa yazar.",
    "app.buildCta": "Bugünün ana sayfasını oluştur",
    "app.buildResume": "Yarıda kalan oluşturmayı sürdür",
    "app.building": "Oluşturuluyor… {step}/{total}",
    "app.rebuild": "↻ Yenile",
    "app.settings": "⚙️ Ayarlar",
    "app.failed": "Oluşturma başarısız oldu.",
    "app.retry": "Yeniden dene",
    "app.dismiss": "Kapat",
    "app.rebuildNowTitle": "Şimdi yenile",
    "app.settingsTitle": "Ana sayfayı özelleştir",
    "app.progressTitle": "Oluşturma ilerlemesini gör",

    "setup.title": "Model sağlayıcını bağla",
    "setup.blurb":
      "Ajan bu eklentinin içinde çalışır ve model sağlayıcına doğrudan bağlanır — arada sunucu yok. Anahtarın bu makinede, chrome.storage.local içinde saklanır ve başka hiçbir yere gönderilmez.",
    "setup.provider": "Sağlayıcı",
    "setup.model": "Model",
    "setup.apiKey": "API anahtarı",
    "setup.baseUrl": "Sunucu adresi",
    "setup.apiKeyOptional": "API anahtarı (isteğe bağlı)",
    "setup.runsLocally": "Bu makinede çalışır; API anahtarı gerekmez.",
    "setup.calls": "Çağrı adresi",
    "setup.save": "Kaydet",

    "progress.title": "Ana sayfan oluşturuluyor",
    "progress.cancel": "İptal",
    "progress.back": "← Ana sayfaya dön",
    "progress.agent": "Ajan",
    "progress.log": "Etkinlik günlüğü",
    "progress.warming": "Isınıyor — neleri gezdiğine bakıyor…",

    "step.prepare": "Ajan hazırlanıyor",
    "step.history": "Tarama geçmişin okunuyor",
    "step.scraping": "Sayfalar tarayıcında açılıyor",
    "step.analyzing": "Sayfalar inceleniyor",
    "step.writing": "Ana sayfan yazılıyor",

    "settings.title": "Ana sayfanı özelleştir",
    "settings.blurb": "Her oluşturmada uygulanan kalıcı talimatlar.",
    "settings.promptPlaceholder":
      "örn. 'Teknoloji haberlerine ve Rust sürümlerine odaklan', 'Önce okunmamış GitHub PR'larını göster'",
    "settings.blocked": "Ajanın asla okumayacağı siteler",
    "settings.blockedHelp": "Her satıra bir tane. Alt alan adları dahildir. Joker için *.example.com kullan.",
    "settings.provider": "Sağlayıcı",
    "settings.model": "Model",
    "settings.apiKey": "API anahtarı",
    "settings.apiKeyHelp":
      "chrome.storage.local içinde saklanır; bu tarayıcı profiline erişebilen herkes okuyabilir.",
    "settings.baseUrl": "Sunucu adresi",
    "settings.language": "Dil",
    "settings.autoRebuild": "Otomatik yenile",
    "settings.every": "Her",
    "settings.hours": "{hours} saat",
    "settings.hoursDaily": "24 saat (günlük)",
    "settings.autoRebuildHelp":
      "Açıkken ana sayfan bu kadar eskiyince eklenti arka planda yeniden oluşturur, böylece yeni sekmen güncel olur (API anahtarını kullanır).",
    "settings.cancel": "Vazgeç",
    "settings.save": "Kaydet ve yenile",

    "error.noCredentials": "{provider} için API anahtarı bulunamadı. Bir anahtar ekleyip tekrar dene.",
    "notify.failed": "Ana sayfa oluşturulamadı",
  },
} as const;

export type StringKey = keyof (typeof STRINGS)["en"];

export type Translate = (key: StringKey, vars?: Record<string, string | number>) => string;

/** Anything starting with `tr` is Turkish; everything else is English. */
export function detectLanguage(browserLanguage: string | undefined): Language {
  return browserLanguage?.toLowerCase().startsWith("tr") ? "tr" : "en";
}

export function translate(language: Language, key: StringKey, vars?: Record<string, string | number>): string {
  // A key present in one table but not the other would be a type error; this is
  // only about which table wins.
  const template: string = STRINGS[language][key] ?? STRINGS.en[key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

export function makeT(language: Language): Translate {
  return (key, vars) => translate(language, key, vars);
}

const LanguageContext = createContext<Translate>(makeT("en"));

export function LanguageProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo(() => makeT(language), [language]);
  return <LanguageContext.Provider value={value}>{children}</LanguageContext.Provider>;
}

export function useT(): Translate {
  return useContext(LanguageContext);
}
