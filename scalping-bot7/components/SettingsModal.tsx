"use client";

import { useState, useCallback, useEffect } from "react";
import { useTradingContext } from "@/lib/context";
import { getT, LANGUAGES, type Lang } from "@/lib/i18n";
import { type AppSettings } from "@/lib/settingsStore";
import { cn } from "@/lib/utils";
import { APP_VERSION, BUILD_DATE } from "@/lib/version";

// ── useT hook — exported so other components can import it ──────────────────
export function useT() {
  const { language } = useTradingContext();
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
        checked ? "bg-tv-blue" : "bg-tv-bg3"
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
function ToggleRow({ label, desc, checked, onChange }: { label: string; desc?: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 border-b border-tv-border last:border-0">
      <div>
        <div className="text-sm text-tv-text">{label}</div>
        {desc && <div className="text-[11px] text-tv-text2 mt-0.5">{desc}</div>}
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
    <div className="py-2 border-b border-tv-border last:border-0">
      <div className="flex justify-between text-sm mb-1.5">
        <span className="text-tv-text">{label}</span>
        <span className="font-semibold text-tv-blue">{format ? format(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 appearance-none rounded cursor-pointer accent-tv-blue"
      />
      <div className="flex justify-between text-[10px] text-tv-text3 mt-0.5">
        <span>{format ? format(min) : min}</span>
        <span>{format ? format(max) : max}</span>
      </div>
    </div>
  );
}

// ── Tabs definition ─────────────────────────────────────────────────────────
type TabId = "language" | "api" | "trading" | "bot" | "notifications";

const TABS: { id: TabId; icon: string; labelFi: string; labelEn: string }[] = [
  { id: "language",      icon: "🌐", labelFi: "Kieli",          labelEn: "Language" },
  { id: "api",           icon: "🔑", labelFi: "API-avaimet",    labelEn: "API Keys" },
  { id: "trading",       icon: "📊", labelFi: "Kaupankäynti",   labelEn: "Trading" },
  { id: "bot",           icon: "🤖", labelFi: "Botti",          labelEn: "Bot" },
  { id: "notifications", icon: "🔔", labelFi: "Ilmoitukset",    labelEn: "Notifications" },
];

const TIMEFRAMES = ["1min", "3min", "5min", "15min", "30min", "1hour", "4hour", "1day"];

// ── Main SettingsModal ──────────────────────────────────────────────────────
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { language, setLanguage, appSettings, setAppSettings } = useTradingContext();
  const t = getT((language ?? "fi") as Lang);

  const [activeTab, setActiveTab] = useState<TabId>("language");
  const [draft, setDraft] = useState<AppSettings>({ ...appSettings });
  const [apiSaved, setApiSaved] = useState(false);
  const [testingConnection, setTestingConnection] = useState(false);
  const [connectionResult, setConnectionResult] = useState<string | null>(null);

  const isFi = language === "fi";

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  // On open, pull real credentials from the server so the form is always
  // pre-populated — even if the user edited api-config.json directly.
  useEffect(() => {
    fetch("/api/trading/config")
      .then(r => r.json())
      .then((cfg: { apiKey?: string; apiSecret?: string; apiPassphrase?: string; sandboxMode?: boolean }) => {
        setDraft(prev => ({
          ...prev,
          apiKey:        cfg.apiKey        || prev.apiKey,
          apiSecret:     cfg.apiSecret     || prev.apiSecret,
          apiPassphrase: cfg.apiPassphrase || prev.apiPassphrase,
          sandboxMode:   cfg.sandboxMode   ?? prev.sandboxMode,
        }));
      })
      .catch(() => {/* silently ignore — draft stays as loaded from localStorage */});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // run once on mount

  const handleSave = useCallback(async () => {
    setAppSettings(draft);
    if (draft.language !== language) {
      setLanguage(draft.language);
    }
    // Also persist API keys to server when saving
    await fetch("/api/trading/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey: draft.apiKey,
        apiSecret: draft.apiSecret,
        apiPassphrase: draft.apiPassphrase,
        sandboxMode: draft.sandboxMode,
      }),
    }).catch(() => null);
    onClose();
  }, [draft, language, setAppSettings, setLanguage, onClose]);

  const handleCancel = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleSelectLanguage = useCallback((lang: "fi" | "en") => {
    update("language", lang);
    // Immediately update context language so UI reflects immediately
    setLanguage(lang);
  }, [update, setLanguage]);

  const handleTestConnection = useCallback(async () => {
    // Trim whitespace — pasted keys often have invisible leading/trailing spaces
    const trimKey        = draft.apiKey.trim();
    const trimSecret     = draft.apiSecret.trim();
    const trimPassphrase = draft.apiPassphrase.trim();

    // Pre-validate: show exactly which field is missing
    const missing = [
      !trimKey        && (isFi ? "API Key"     : "API Key"),
      !trimSecret     && (isFi ? "API Secret"  : "API Secret"),
      !trimPassphrase && (isFi ? "Passphrase"  : "Passphrase"),
    ].filter(Boolean) as string[];
    if (missing.length > 0) {
      setConnectionResult(`❌ ${isFi ? "Kenttä puuttuu" : "Missing field(s)"}: ${missing.join(", ")}`);
      return;
    }

    // Sandbox warning
    if (draft.sandboxMode) {
      setConnectionResult(
        isFi
          ? "⚠️ Sandbox-tila on päällä. Varmista että käytät KuCoin sandbox-avaimia, ei tuotantoavaimia."
          : "⚠️ Sandbox mode is ON. Make sure you are using KuCoin sandbox credentials, not production keys."
      );
    }

    setTestingConnection(true);
    try {
      // Save trimmed credentials first
      const saveRes = await fetch("/api/trading/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey:        trimKey,
          apiSecret:     trimSecret,
          apiPassphrase: trimPassphrase,
          sandboxMode:   draft.sandboxMode,
        }),
      });
      if (!saveRes.ok) {
        setConnectionResult(`❌ ${isFi ? "Asetusten tallennus epäonnistui" : "Failed to save credentials to server"}`);
        setTestingConnection(false);
        return;
      }

      // Also update draft with trimmed values so the form stays in sync
      update("apiKey",        trimKey);
      update("apiSecret",     trimSecret);
      update("apiPassphrase", trimPassphrase);

      // Now test the authenticated endpoint
      const res  = await fetch("/api/trading/balance");
      const data = await res.json();
      if (res.ok && data.accounts) {
        const usdt = Array.isArray(data.accounts)
          ? data.accounts.find((a: { currency: string }) => a.currency === "USDT")?.available ?? "0"
          : "?";
        setConnectionResult(`✅ ${isFi ? `Yhteys toimii! USDT saldo: ${usdt}` : `Connected! USDT balance: ${usdt}`}`);
      } else {
        const reason = data.error ?? (isFi ? "tuntematon virhe" : "unknown error");
        const hint = draft.sandboxMode
          ? (isFi ? " (Sandbox-tila päällä — käytä sandbox-avaimia)" : " (Sandbox mode ON — use sandbox credentials)")
          : "";
        setConnectionResult(`❌ ${isFi ? `Autentikointi epäonnistui: ${reason}${hint}` : `Auth failed: ${reason}${hint}`}`);
      }
    } catch {
      setConnectionResult(`❌ ${isFi ? "Verkkovirhe" : "Network error"}`);
    }
    setTestingConnection(false);
  }, [draft, isFi, update]);

  const handleSaveApiKeys = useCallback(async () => {
    // Always trim before saving — pasted values often carry invisible whitespace
    const trimmed = {
      ...draft,
      apiKey:        draft.apiKey.trim(),
      apiSecret:     draft.apiSecret.trim(),
      apiPassphrase: draft.apiPassphrase.trim(),
    };
    setAppSettings(trimmed);
    setDraft(trimmed);
    await fetch("/api/trading/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        apiKey:        trimmed.apiKey,
        apiSecret:     trimmed.apiSecret,
        apiPassphrase: trimmed.apiPassphrase,
        sandboxMode:   trimmed.sandboxMode,
      }),
    }).catch(() => null);
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

  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center p-4">
      <div className="bg-[#0d0d14] border border-tv-border rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-tv-border flex-shrink-0">
          <h2 className="text-base font-semibold text-tv-text">{t("settings.title")}</h2>
          <button
            onClick={handleCancel}
            className="text-tv-text2 hover:text-tv-text text-lg leading-none px-1"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex flex-1 overflow-hidden">

          {/* Sidebar */}
          <div className="w-44 flex-shrink-0 border-r border-tv-border py-3 space-y-0.5 px-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  "w-full text-left flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors",
                  activeTab === tab.id
                    ? "bg-tv-blue/15 text-tv-blue font-semibold"
                    : "text-tv-text2 hover:bg-tv-bg3 hover:text-tv-text"
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
                <div className="text-xs text-tv-text2 uppercase tracking-wide font-semibold mb-3">
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
                          ? "border-tv-blue bg-tv-blue/10 text-tv-blue"
                          : "border-tv-border bg-tv-bg2 text-tv-text2 hover:border-tv-blue/40 hover:text-tv-text"
                      )}
                    >
                      <span className="text-3xl">{lang === "fi" ? "🇫🇮" : "🇬🇧"}</span>
                      <span className="text-sm font-semibold">{label}</span>
                      {draft.language === lang && (
                        <span className="text-[10px] bg-tv-blue/20 text-tv-blue rounded px-2 py-0.5">
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
                <div className="text-xs text-tv-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.api_keys")}
                </div>

                {/* Sandbox warning — prominent, shown whenever sandbox is ON */}
                {draft.sandboxMode && (
                  <div className="text-xs bg-tv-amber/10 border border-tv-amber/40 text-tv-amber rounded px-3 py-2 font-semibold">
                    ⚠️ {isFi
                      ? "Sandbox-tila ON — käytä KuCoin sandbox-avaimia. Tuotantoavaimet eivät toimi sandbox-palvelimella."
                      : "Sandbox mode ON — use KuCoin sandbox credentials. Production keys will NOT work here."}
                  </div>
                )}

                {/* Three credential fields with per-field status */}
                <div className="space-y-3">
                  {([
                    { key: "apiKey"        as const, label: t("settings.api_key"),        type: "text"     },
                    { key: "apiSecret"     as const, label: t("settings.api_secret"),     type: "password" },
                    { key: "apiPassphrase" as const, label: t("settings.api_passphrase"), type: "password" },
                  ] as const).map(({ key, label, type }) => {
                    const val = (draft[key] as string).trim();
                    return (
                      <div key={key}>
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-xs text-tv-text2">{label}</label>
                          {val
                            ? <span className="text-[10px] text-tv-green font-semibold">✓ {isFi ? "Asetettu" : "Set"}</span>
                            : <span className="text-[10px] text-tv-red  font-semibold">✗ {isFi ? "Puuttuu" : "Missing"}</span>}
                        </div>
                        <input
                          type={type}
                          value={draft[key] as string}
                          onChange={(e) => update(key, e.target.value)}
                          className={cn(
                            "w-full bg-tv-bg2 border rounded px-3 py-2 text-sm text-tv-text focus:outline-none focus:border-tv-blue transition-colors",
                            val ? "border-tv-green/40" : "border-tv-red/40"
                          )}
                          placeholder={label}
                          autoComplete="off"
                        />
                      </div>
                    );
                  })}
                </div>

                <ToggleRow
                  label={t("settings.sandbox")}
                  checked={draft.sandboxMode}
                  onChange={(v) => update("sandboxMode", v)}
                />

                <div className="flex gap-2 mt-2">
                  <button
                    onClick={handleSaveApiKeys}
                    className="flex-1 py-2 rounded text-sm font-semibold bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20 transition-colors"
                  >
                    {apiSaved ? `✓ ${t("settings.api_saved")}` : t("app.save")}
                  </button>
                  <button
                    onClick={handleTestConnection}
                    disabled={testingConnection}
                    className="flex-1 py-2 rounded text-sm font-semibold bg-tv-bg2 text-tv-text2 border border-tv-border hover:bg-tv-bg3 transition-colors disabled:opacity-50"
                  >
                    {testingConnection
                      ? (isFi ? "Testataan..." : "Testing...")
                      : (isFi ? "Testaa yhteys" : "Test Connection")}
                  </button>
                </div>

                {connectionResult && (
                  <div className={cn(
                    "text-sm rounded px-3 py-2 border",
                    connectionResult.startsWith("✅")
                      ? "bg-tv-green/10 border-tv-green/30 text-tv-green"
                      : connectionResult.startsWith("❌")
                        ? "bg-tv-red/10 border-tv-red/30 text-tv-red"
                        : "bg-tv-amber/10 border-tv-amber/30 text-tv-amber"
                  )}>
                    {connectionResult}
                  </div>
                )}

                <div className="text-[11px] text-tv-text2 bg-tv-bg2 border border-tv-border rounded px-3 py-2 mt-2">
                  ℹ️ {t("settings.api_info")}
                </div>
              </div>
            )}

            {/* ── Trading Tab ── */}
            {activeTab === "trading" && (
              <div className="space-y-1">
                <div className="text-xs text-tv-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.trading")}
                </div>
                <SliderRow
                  label={t("settings.trade_amount")}
                  value={draft.tradeAmountUSDT}
                  min={10} max={1000} step={10}
                  onChange={(v) => update("tradeAmountUSDT", v)}
                  format={(v) => `$${v}`}
                />
                <SliderRow
                  label={t("settings.min_score")}
                  value={draft.minSignalScore}
                  min={2} max={7} step={1}
                  onChange={(v) => update("minSignalScore", v)}
                  format={(v) => `${v}/7`}
                />
                <SliderRow
                  label={t("settings.sl_multiplier")}
                  value={draft.slMultiplier}
                  min={0.5} max={3.0} step={0.25}
                  onChange={(v) => update("slMultiplier", v)}
                  format={(v) => `${v.toFixed(2)}×ATR`}
                />
                <SliderRow
                  label={t("settings.tp_multiplier")}
                  value={draft.tpMultiplier}
                  min={1.5} max={5.0} step={0.25}
                  onChange={(v) => update("tpMultiplier", v)}
                  format={(v) => `${v.toFixed(2)}×`}
                />
                <SliderRow
                  label={t("settings.max_positions")}
                  value={draft.maxPositions}
                  min={1} max={5} step={1}
                  onChange={(v) => update("maxPositions", v)}
                />
                <div className="py-2 border-b border-tv-border last:border-0">
                  <label className="text-sm text-tv-text block mb-1.5">{t("settings.default_timeframe")}</label>
                  <select
                    value={draft.defaultTimeframe}
                    onChange={(e) => update("defaultTimeframe", e.target.value)}
                    className="w-full bg-tv-bg2 border border-tv-border rounded px-2 py-1.5 text-sm text-tv-text focus:outline-none focus:border-tv-blue"
                  >
                    {TIMEFRAMES.map((tf) => (
                      <option key={tf} value={tf}>{tf}</option>
                    ))}
                  </select>
                </div>
              </div>
            )}

            {/* ── Bot Tab ── */}
            {activeTab === "bot" && (
              <div className="space-y-1">
                <div className="text-xs text-tv-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.bot")}
                </div>
                <ToggleRow
                  label={t("settings.kelly")}
                  desc={isFi ? "Skaalaa positiokoon historiallisen suorituskyvyn mukaan" : "Scales position size based on historical performance"}
                  checked={draft.kellyEnabled}
                  onChange={(v) => update("kellyEnabled", v)}
                />
                <ToggleRow
                  label={t("settings.auto_optimizer")}
                  desc={isFi ? "Optimoi parametrit automaattisesti 80 yhdistelmällä" : "Automatically optimizes parameters across 80 combinations"}
                  checked={draft.autoOptimizerEnabled}
                  onChange={(v) => update("autoOptimizerEnabled", v)}
                />
                <ToggleRow
                  label={t("settings.feedback_loop")}
                  desc={isFi ? "Käynnistää optimoinnin automaattisesti suorituskykyongelmien ilmetessä" : "Triggers re-optimization automatically when performance issues detected"}
                  checked={draft.feedbackLoopEnabled}
                  onChange={(v) => update("feedbackLoopEnabled", v)}
                />
              </div>
            )}

            {/* ── Notifications Tab ── */}
            {activeTab === "notifications" && (
              <div className="space-y-1">
                <div className="text-xs text-tv-text2 uppercase tracking-wide font-semibold mb-3">
                  {t("settings.notifications")}
                </div>
                <ToggleRow
                  label={t("settings.sound")}
                  desc={isFi ? "Toistaa äänen kaupan avautuessa tai sulkeutuessa" : "Plays a sound when a trade opens or closes"}
                  checked={draft.soundAlerts}
                  onChange={(v) => update("soundAlerts", v)}
                />
                <ToggleRow
                  label={t("settings.browser_notify")}
                  desc={isFi ? "Lähettää selain-ilmoituksen kaupan tapahtuessa" : "Sends a browser notification when a trade occurs"}
                  checked={draft.browserNotifications}
                  onChange={(v) => update("browserNotifications", v)}
                />
                {!draft.browserNotifications && (
                  <div className="pt-2">
                    <button
                      onClick={handleRequestNotificationPermission}
                      className="text-sm px-3 py-2 rounded bg-tv-bg2 border border-tv-border text-tv-text2 hover:text-tv-text hover:bg-tv-bg3 transition-colors"
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
        <div className="flex items-center justify-between px-5 py-3 border-t border-tv-border flex-shrink-0">
          <div className="space-y-0.5">
            <div className="text-[11px] text-tv-text3">
              {t("settings.risk_warning")}
            </div>
            <div className="text-[10px] text-tv-text3/60 font-mono">
              v{APP_VERSION} · {BUILD_DATE}
            </div>
          </div>
          <div className="flex gap-2 flex-shrink-0 ml-4">
            <button
              onClick={handleCancel}
              className="px-4 py-1.5 rounded text-sm text-tv-text2 border border-tv-border hover:bg-tv-bg2 transition-colors"
            >
              {t("app.cancel")}
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-1.5 rounded text-sm font-semibold bg-tv-blue text-white hover:bg-tv-blue/90 transition-colors"
            >
              {t("app.save")}
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
