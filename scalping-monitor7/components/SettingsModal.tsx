"use client";

import { useState, useCallback } from "react";
import { useMonitorContext } from "@/lib/monitorContext";
import { getT, LANGUAGES, type Lang } from "@/lib/i18n";
import { type AppSettings } from "@/lib/settingsStore";
import { cn } from "@/lib/utils";

// ── useT hook — exported so other components can import it ──────────────────
export function useT() {
  const { language } = useMonitorContext();
  return getT((language ?? "fi") as Lang);
}

// ── Toggle switch component ─────────────────────────────────────────────────
function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors flex-shrink-0",
        checked ? "bg-blue" : "bg-bg3"
      )}
    >
      <span
        className={cn(
          "inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-4" : "translate-x-1"
        )}
      />
    </button>
  );
}

// ── Setting row with label + toggle ────────────────────────────────────────
function ToggleRow({ label, desc, checked, onChange }: {
  label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-border last:border-0">
      <div>
        <div className="text-sm text-text">{label}</div>
        {desc && <div className="text-[11px] text-text2 mt-0.5">{desc}</div>}
      </div>
      <Toggle checked={checked} onChange={onChange} />
    </div>
  );
}

// ── Slider row ──────────────────────────────────────────────────────────────
function SliderRow({
  label, value, min, max, step, onChange, format,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div className="py-2 border-b border-border last:border-0">
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-text">{label}</span>
        <span className="font-semibold text-blue">{format ? format(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 appearance-none rounded cursor-pointer accent-blue"
      />
      <div className="flex justify-between text-[10px] text-text3 mt-0.5">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  );
}

// ── Tabs definition ─────────────────────────────────────────────────────────
type TabId = "language" | "api" | "display" | "notifications";

const TABS: { id: TabId; icon: string; labelFi: string; labelEn: string }[] = [
  { id: "language",      icon: "🌐", labelFi: "Kieli",             labelEn: "Language" },
  { id: "api",           icon: "🔑", labelFi: "API-avaimet",       labelEn: "API Keys" },
  { id: "display",       icon: "📊", labelFi: "Näyttöasetukset",   labelEn: "Display" },
  { id: "notifications", icon: "🔔", labelFi: "Ilmoitukset",       labelEn: "Notifications" },
];

const TIMEFRAMES = ["1min", "3min", "5min", "15min", "30min", "1hour", "4hour", "1day"];

// ── Main SettingsModal ──────────────────────────────────────────────────────
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { language, setLanguage, appSettings, setAppSettings } = useMonitorContext();
  const t = getT((language ?? "fi") as Lang);

  const [activeTab, setActiveTab] = useState<TabId>("language");
  const [draft, setDraft] = useState<AppSettings>({ ...appSettings });
  const [apiSaved, setApiSaved] = useState(false);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSave = useCallback(() => {
    setAppSettings(draft);
    if (draft.language !== language) {
      setLanguage(draft.language);
    }
    onClose();
  }, [draft, language, setAppSettings, setLanguage, onClose]);

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectLanguage = useCallback((lang: "fi" | "en") => {
    update("language", lang);
    setLanguage(lang);
  }, [update, setLanguage]);

  const handleSaveApiKeys = useCallback(() => {
    setAppSettings(draft);
    setApiSaved(true);
    setTimeout(() => setApiSaved(false), 3000);
  }, [draft, setAppSettings]);

  const handleRequestNotificationPermission = useCallback(async () => {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    if (result === "granted") {
      update("browserNotifications", true);
    }
  }, [update]);

  const isFi = language === "fi";

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d1117] border border-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border flex-shrink-0">
          <h2 className="text-base font-semibold text-text">{t("settings.title")}</h2>
          <button
            onClick={handleCancel}
            className="text-text2 hover:text-text text-lg leading-none px-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">

          {/* Sidebar */}
          <div className="w-44 flex-shrink-0 border-r border-border py-3 space-y-0.5 px-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
                  activeTab === tab.id
                    ? "bg-blue/15 text-blue font-semibold"
                    : "text-text2 hover:bg-bg3 hover:text-text"
                )}
              >
                <span>{tab.icon}</span>
                <span>{isFi ? tab.labelFi : tab.labelEn}</span>
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 py-4">

            {/* ── Language Tab ── */}
            {activeTab === "language" && (
              <div className="space-y-4">
                <div className="text-xs text-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.language")}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {(Object.entries(LANGUAGES) as [Lang, string][]).map(([lang, label]) => (
                    <button
                      key={lang}
                      onClick={() => handleSelectLanguage(lang)}
                      className={cn(
                        "flex flex-col items-center gap-2 py-6 rounded-xl border-2 transition-all",
                        draft.language === lang
                          ? "border-blue bg-blue/10 text-blue"
                          : "border-border bg-bg2 text-text2 hover:border-blue/40 hover:text-text"
                      )}
                    >
                      <span className="text-3xl">{lang === "fi" ? "🇫🇮" : "🇬🇧"}</span>
                      <span className="text-sm font-semibold">{label}</span>
                      {draft.language === lang && (
                        <span className="text-[10px] bg-blue/20 text-blue rounded px-2 py-0.5">
                          {isFi ? "Valittu" : "Selected"}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* ── API Tab ── */}
            {activeTab === "api" && (
              <div className="space-y-4">
                <div className="text-xs text-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.api_keys")}
                </div>

                <div className="space-y-3">
                  {[
                    { key: "apiKey" as const, label: t("settings.api_key"), type: "text" },
                    { key: "apiSecret" as const, label: t("settings.api_secret"), type: "password" },
                    { key: "apiPassphrase" as const, label: t("settings.api_passphrase"), type: "password" },
                  ].map(({ key, label, type }) => (
                    <div key={key}>
                      <label className="text-xs text-text2 block mb-1">{label}</label>
                      <input
                        type={type}
                        value={draft[key] as string}
                        onChange={(e) => update(key, e.target.value)}
                        className="w-full bg-bg2 border border-border rounded px-3 py-2 text-sm text-text focus:outline-none focus:border-blue"
                        placeholder={label}
                        autoComplete="off"
                      />
                    </div>
                  ))}
                </div>

                <ToggleRow
                  label={t("settings.sandbox")}
                  checked={draft.sandboxMode}
                  onChange={(v) => update("sandboxMode", v)}
                />

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleSaveApiKeys}
                    className="flex-1 py-2 rounded text-sm font-semibold bg-blue/10 text-blue border border-blue/30 hover:bg-blue/20 transition-colors"
                  >
                    {apiSaved ? `✓ ${t("settings.api_saved")}` : t("app.save")}
                  </button>
                </div>

                <div className="text-[11px] text-text2 bg-bg2 border border-border rounded px-3 py-2 mt-2">
                  ℹ️ {t("settings.api_info")}
                </div>
              </div>
            )}

            {/* ── Display Tab ── */}
            {activeTab === "display" && (
              <div className="space-y-1">
                <div className="text-xs text-text2 uppercase tracking-wide font-semibold mb-3">
                  {isFi ? "Näyttöasetukset" : "Display Settings"}
                </div>
                <div className="py-2 border-b border-border">
                  <label className="text-sm text-text block mb-1.5">
                    {t("settings.default_timeframe")}
                  </label>
                  <select
                    value={draft.defaultTimeframe}
                    onChange={(e) => update("defaultTimeframe", e.target.value)}
                    className="w-full bg-bg2 border border-border rounded px-2 py-1.5 text-sm text-text focus:outline-none focus:border-blue"
                  >
                    {TIMEFRAMES.map((tf) => (
                      <option key={tf} value={tf}>{tf}</option>
                    ))}
                  </select>
                </div>
                <SliderRow
                  label={t("settings.min_score")}
                  value={draft.minSignalScore}
                  min={2} max={10} step={1}
                  onChange={(v) => update("minSignalScore", v)}
                  format={(v) => `${v}/12`}
                />
              </div>
            )}

            {/* ── Notifications Tab ── */}
            {activeTab === "notifications" && (
              <div className="space-y-1">
                <div className="text-xs text-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.notifications")}
                </div>
                <ToggleRow
                  label={t("settings.sound")}
                  desc={isFi ? "Toistaa äänen signaalin ilmetessä" : "Plays a sound when a signal occurs"}
                  checked={draft.soundAlerts}
                  onChange={(v) => update("soundAlerts", v)}
                />
                <ToggleRow
                  label={t("settings.browser_notify")}
                  desc={isFi ? "Lähettää selain-ilmoituksen signaalin tapahtuessa" : "Sends a browser notification when a signal occurs"}
                  checked={draft.browserNotifications}
                  onChange={(v) => update("browserNotifications", v)}
                />
                {!draft.browserNotifications && (
                  <div className="pt-2">
                    <button
                      onClick={handleRequestNotificationPermission}
                      className="text-sm px-3 py-2 rounded bg-bg2 border border-border text-text2 hover:text-text hover:bg-bg3 transition-colors"
                    >
                      {isFi ? "Pyydä selainlupa" : "Request Permission"}
                    </button>
                  </div>
                )}
              </div>
            )}

          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border flex-shrink-0">
          <div className="text-[11px] text-text3">
            {isFi
              ? "⚠ Huom: Kryptovaluuttakauppa sisältää merkittävän tappioriskin."
              : "⚠ Warning: Crypto trading carries substantial risk of loss."}
          </div>
          <div className="flex gap-2 flex-shrink-0 ml-4">
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 rounded text-sm text-text2 border border-border hover:bg-bg2 transition-colors"
            >
              {t("app.cancel")}
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 rounded text-sm font-semibold bg-blue text-bg hover:bg-blue/90 transition-colors"
            >
              {t("app.save")}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
