"use client";

import { useState, useCallback } from "react";
import { useTradingContext } from "@/lib/context";
import { SUPPORTED_TIMEFRAMES } from "@/lib/kucoinPublic";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";

export default function SetupWizard() {
  const { setBotConfig, botConfig, setSetupComplete, setCredentialsValid, language } =
    useTradingContext();
  const t = useT();
  const isFi = language === "fi";

  const STEPS = [
    t("setup.step_api"),
    t("setup.step_pair"),
    t("setup.step_backtest"),
    t("setup.step_amount"),
    t("setup.step_risk"),
  ];
  const [step, setStep]             = useState(0);
  const [apiKey, setApiKey]         = useState("");
  const [apiSecret, setApiSecret]   = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [testResult, setTestResult] = useState<"idle" | "testing" | "ok" | "fail">("idle");
  const [testBalanceUSDT, setTestBalanceUSDT] = useState<string | null>(null);
  const [pair, setPair]             = useState("BTC-USDT");
  const [timeframe, setTimeframe]   = useState("5min");
  const [amount, setAmount]         = useState(100);
  const [backtestDone, setBacktestDone] = useState(false);
  const [backtestPF, setBacktestPF]     = useState(0);
  const [riskAck, setRiskAck]           = useState(false);

  const testConnection = useCallback(async () => {
    setTestResult("testing");
    try {
      // Save the entered credentials to the server first
      await fetch("/api/trading/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey, apiSecret, apiPassphrase: passphrase, sandboxMode: false }),
      });
      // Then test with an authenticated endpoint
      const res  = await fetch("/api/trading/balance");
      const data = await res.json();
      if (res.ok && data.accounts) {
        const usdt = Array.isArray(data.accounts)
          ? data.accounts.find((a: { currency: string }) => a.currency === "USDT")?.available ?? "?"
          : "?";
        setTestBalanceUSDT(String(usdt));
        setTestResult("ok");
        setCredentialsValid(true);
      } else {
        setTestBalanceUSDT(null);
        setTestResult("fail");
      }
    } catch {
      setTestResult("fail");
    }
  }, [apiKey, apiSecret, passphrase, setCredentialsValid]);

  const runSetupBacktest = useCallback(async () => {
    const endAt   = Math.floor(Date.now() / 1000);
    const startAt = endAt - 14 * 24 * 3600;
    const res  = await fetch(
      `/api/trading/candles?symbol=${pair}&timeframe=${timeframe}&startAt=${startAt}&endAt=${endAt}`
    );
    const data = await res.json();
    if (!data.candles || data.candles.length < 60) {
      alert(isFi ? "Kynttilädataa ei ole riittävästi" : "Not enough candle data");
      return;
    }
    const { runBacktest } = await import("@/lib/backtester");
    const results = runBacktest(data.candles, {
      symbol: pair, timeframe,
      tradeAmountUSDT: amount,
      minSignalScore: 4,
      takeProfitMultiplier: 2.5,
      stopLossAtrMultiplier: 1.5,
      partialExitEnabled: true,
    });
    setBacktestPF(results.profitFactor);
    setBacktestDone(true);
  }, [pair, timeframe, amount]);

  const complete = useCallback(() => {
    setBotConfig({
      ...botConfig,
      tradingPair: pair,
      timeframe,
      tradeAmountUSDT: amount,
      backtestValidated: backtestPF >= 1.2,
    });
    localStorage.setItem("setupComplete", "true");
    setSetupComplete(true);
  }, [botConfig, pair, timeframe, amount, backtestPF, setBotConfig, setSetupComplete]);

  return (
    <div className="min-h-screen bg-tv-bg2 flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        {/* Otsikko */}
        <div className="text-center mb-8">
          <div className="text-4xl mb-2">⚡</div>
          <h1 className="text-2xl font-bold text-tv-text">KuCoin Scalping Bot</h1>
          <p className="text-tv-text2 text-sm mt-1">{t("setup.subtitle")}</p>
        </div>

        {/* Vaihe-indikaattori */}
        <div className="flex items-center justify-between mb-6">
          {STEPS.map((s, i) => (
            <div key={i} className="flex items-center">
              <div className={cn(
                "w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold",
                i < step  ? "bg-tv-green text-white" :
                i === step ? "bg-tv-blue text-white" : "bg-tv-bg3 text-tv-text2"
              )}>
                {i < step ? "✓" : i + 1}
              </div>
              {i < STEPS.length - 1 && (
                <div className={cn("flex-1 h-0.5 mx-1 w-8", i < step ? "bg-tv-green" : "bg-tv-border")} />
              )}
            </div>
          ))}
        </div>

        {/* Vaiheen sisältö */}
        <div className="bg-white rounded-xl p-6 border border-tv-border shadow-md space-y-4">
          <h2 className="text-lg font-semibold text-tv-text">{STEPS[step]}</h2>

          {/* Step 0: API credentials */}
          {step === 0 && (
            <div className="space-y-3">
              <p className="text-xs text-tv-text2">
                {t("setup.api_intro").split("General + Trade")[0]}<strong>General + Trade</strong>{t("setup.api_intro").split("General + Trade")[1]}
              </p>
              <Input label={t("settings.api_key")}        value={apiKey}      onChange={setApiKey}      placeholder={t("settings.api_key")} />
              <Input label={t("settings.api_secret")}      value={apiSecret}   onChange={setApiSecret}   type="password" placeholder={t("settings.api_secret")} />
              <Input label={t("settings.api_passphrase")}  value={passphrase}  onChange={setPassphrase}  type="password" placeholder={t("settings.api_passphrase")} />
              <button
                onClick={testConnection}
                className="w-full py-2 rounded bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20 text-sm font-semibold transition-colors"
              >
                {testResult === "testing" ? t("setup.api_testing") : t("setup.test_connection")}
              </button>
              {testResult === "ok" && (
                <div className="text-xs text-tv-green bg-tv-green-dim rounded px-2 py-1.5">
                  {t("setup.api_connected")}{testBalanceUSDT !== null ? ` — USDT: ${testBalanceUSDT}` : ""}
                </div>
              )}
              {testResult === "fail" && (
                <div className="text-xs text-tv-red bg-tv-red-dim rounded px-2 py-1.5">
                  {t("setup.api_failed")}
                </div>
              )}
              <p className="text-[10px] text-tv-text3">
                {t("setup.api_env_hint")}
              </p>
            </div>
          )}

          {/* Step 1: Trading pair */}
          {step === 1 && (
            <div className="space-y-3">
              <div>
                <label className="text-xs text-tv-text2 block mb-1">{t("setup.pair_label")}</label>
                <input
                  value={pair}
                  onChange={(e) => setPair(e.target.value.toUpperCase())}
                  className="w-full bg-tv-bg2 border border-tv-border rounded px-3 py-2 text-sm text-tv-text"
                  placeholder="BTC-USDT"
                />
              </div>
              <div>
                <label className="text-xs text-tv-text2 block mb-1">{t("setup.timeframe_label")}</label>
                <div className="grid grid-cols-4 gap-1.5">
                  {SUPPORTED_TIMEFRAMES.map((tf) => (
                    <button
                      key={tf.value}
                      onClick={() => setTimeframe(tf.value)}
                      className={cn(
                        "py-1.5 rounded text-xs font-semibold transition-colors",
                        timeframe === tf.value
                          ? "bg-tv-blue/20 text-tv-blue border border-tv-blue/40"
                          : "bg-tv-bg2 text-tv-text2 border border-tv-border hover:border-tv-blue/40"
                      )}
                    >
                      {tf.label}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-xs text-tv-text2">
                {t("setup.timeframe_hint")}
              </p>
            </div>
          )}

          {/* Step 2: Backtest */}
          {step === 2 && (
            <div className="space-y-3">
              <p className="text-xs text-tv-text2">
                {t("setup.backtest_intro")} ({pair}, {timeframe})
              </p>
              <button
                onClick={runSetupBacktest}
                className="w-full py-2 rounded bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20 text-sm font-semibold transition-colors"
              >
                ▶ {t("backtest.last_3d")}
              </button>
              {backtestDone && (
                <div className={cn(
                  "rounded px-3 py-2 text-sm",
                  backtestPF >= 1.2
                    ? "bg-tv-green-dim border border-tv-green/30 text-tv-green"
                    : "bg-tv-amber-dim border border-tv-amber/30 text-tv-amber"
                )}>
                  {backtestPF >= 1.2
                    ? t("setup.backtest_pass").replace("{pf}", backtestPF.toFixed(2))
                    : t("setup.backtest_fail").replace("{pf}", backtestPF.toFixed(2))}
                </div>
              )}
            </div>
          )}

          {/* Step 3: Trade amount */}
          {step === 3 && (
            <div className="space-y-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-tv-text2">{t("setup.amount_label")}</span>
                  <span className="text-tv-text font-bold">${amount}</span>
                </div>
                <input
                  type="range" min={10} max={500} step={10} value={amount}
                  onChange={(e) => setAmount(parseInt(e.target.value))}
                  className="w-full h-2 appearance-none rounded cursor-pointer"
                />
                <div className="flex justify-between text-[10px] text-tv-text3 mt-1">
                  <span>$10</span>
                  <span>{t("setup.amount_max")}</span>
                </div>
              </div>
              <div className="bg-tv-bg2 rounded p-3 space-y-1 text-xs">
                <div className="flex justify-between">
                  <span className="text-tv-text2">{t("setup.max_loss_per_trade")}</span>
                  <span className="text-tv-red font-mono">-€{(amount * 0.008).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-tv-text2">{t("setup.target_profit_per_trade")}</span>
                  <span className="text-tv-green font-mono">+€{(amount * 0.02).toFixed(2)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-tv-text2">{t("setup.daily_loss_limit")}</span>
                  <span className="text-tv-amber font-mono">-€{(amount * 10 * 0.05).toFixed(2)}</span>
                </div>
              </div>
            </div>
          )}

          {/* Step 4: Risk assessment */}
          {step === 4 && (
            <div className="space-y-3">
              <div className="bg-tv-amber-dim border border-tv-amber/30 rounded p-3 text-xs text-tv-amber space-y-1">
                <div className="font-bold">{t("setup.risk_title")}</div>
                <p>{t("setup.risk_text")}</p>
              </div>
              <div className="space-y-2 text-xs text-tv-text2">
                <p className="font-semibold text-tv-text">{t("setup.safety_title")}</p>
                <ul className="space-y-1 list-disc list-inside">
                  <li>{t("setup.safety_1")}</li>
                  <li>{t("setup.safety_2")}</li>
                  <li>{t("setup.safety_3")}</li>
                  <li>{t("setup.safety_4")}</li>
                  <li>{t("setup.safety_5")}</li>
                  <li>{t("setup.safety_6")}</li>
                  <li>{t("setup.safety_7")}</li>
                </ul>
              </div>
              <label className="flex items-start gap-2 text-xs text-tv-text2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={riskAck}
                  onChange={(e) => setRiskAck(e.target.checked)}
                  className="mt-0.5"
                />
                {t("setup.risk_ack")}
              </label>
            </div>
          )}

          {/* Navigointi */}
          <div className="flex gap-2 pt-2">
            {step > 0 && (
              <button
                onClick={() => setStep((s) => s - 1)}
                className="flex-1 py-2 rounded bg-tv-bg2 text-tv-text2 border border-tv-border hover:bg-tv-bg3 text-sm transition-colors"
              >
                ← {t("app.back")}
              </button>
            )}
            {step < STEPS.length - 1 ? (
              <button
                onClick={() => setStep((s) => s + 1)}
                disabled={step === 0 && testResult !== "ok"}
                className={cn(
                  "flex-1 py-2 rounded text-sm font-semibold transition-colors",
                  (step === 0 && testResult !== "ok")
                    ? "bg-tv-bg3 text-tv-text3 cursor-not-allowed"
                    : "bg-tv-blue/10 text-tv-blue border border-tv-blue/30 hover:bg-tv-blue/20"
                )}
              >
                {t("app.next")} →
              </button>
            ) : (
              <button
                onClick={complete}
                disabled={!riskAck}
                className={cn(
                  "flex-1 py-2 rounded text-sm font-bold transition-colors",
                  riskAck
                    ? "bg-tv-green/10 text-tv-green border border-tv-green/30 hover:bg-tv-green/20"
                    : "bg-tv-bg3 text-tv-text3 cursor-not-allowed"
                )}
              >
                {t("setup.complete")} ⚡
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Input({
  label, value, onChange, type = "text", placeholder,
}: {
  label: string; value: string; onChange: (v: string) => void;
  type?: string; placeholder?: string;
}) {
  return (
    <div>
      <label className="text-xs text-tv-text2 block mb-1">{label}</label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-tv-bg2 border border-tv-border rounded px-3 py-2 text-sm text-tv-text placeholder:text-tv-text3 focus:border-tv-blue focus:outline-none transition-colors"
      />
    </div>
  );
}
