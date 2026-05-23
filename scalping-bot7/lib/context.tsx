"use client";

import React, { createContext, useContext, useState, useCallback, useEffect } from "react";
import type { BotConfig, PerformanceMetrics, BotStatus, BotDecisionLog, LiveTrade } from "./botEngine";
import type { SignalResult } from "./signalEngine";
import type { BacktestResults } from "./backtester";
import type { KuCoinCandle } from "./kucoinPublic";
import { loadTradeLog, type TradeLogEntry } from "./tradeLogger";
import { loadAppSettings, saveAppSettings, type AppSettings } from "./settingsStore";
import type { MarketRegime } from "./indicators";

// Shared watchlist pair type (produced by Watchlist, consumed by SignalPanel Recommendations)
export interface WatchlistPair {
  symbol:          string;
  price:           number;
  change24h:       number;
  signalScore:     number;
  signalDirection: "BUY" | "SELL" | "NEUTRAL";
  signalLabel:     string;
  volume:          string;
  regime:          MarketRegime;
  tradeable:       boolean;
}

export interface PairStat {
  trades:      number;
  wins:        number;
  losses:      number;
  pnl:         number;
  lastAction:  string;
  lastSignal:  string;
  lastChecked: number;
}

// Exported so components can reference the shape if needed
export interface TradingContextType {
  // Config
  botConfig: BotConfig;
  setBotConfig: (c: BotConfig) => void;

  // Market data
  selectedSymbol: string;
  setSelectedSymbol: (s: string) => void;
  selectedTimeframe: string;
  setSelectedTimeframe: (t: string) => void;
  candles: KuCoinCandle[];
  setCandles: (c: KuCoinCandle[]) => void;
  livePrice: number;
  setLivePrice: (p: number) => void;
  bidAskSpread: number;
  setBidAskSpread: (s: number) => void;

  // Signal
  currentSignal: SignalResult | null;
  setCurrentSignal: (s: SignalResult | null) => void;

  // Single-pair bot
  botStatus: BotStatus;
  setBotStatus: (s: BotStatus) => void;
  openPosition: LiveTrade | null;
  setOpenPosition: (p: LiveTrade | null) => void;
  performance: PerformanceMetrics;
  setPerformance: (p: PerformanceMetrics) => void;
  decisionLog: BotDecisionLog[];
  addDecisionLog: (log: BotDecisionLog) => void;

  // Multi-pair bot
  activePairs: string[];
  setActivePairs: (pairs: string[]) => void;
  multiBotStatus: "STOPPED" | "RUNNING";
  setMultiBotStatus: (s: "STOPPED" | "RUNNING") => void;
  multiPositions: Record<string, LiveTrade | null>;
  setMultiPositions: React.Dispatch<React.SetStateAction<Record<string, LiveTrade | null>>>;
  multiStats: Record<string, PairStat>;
  setMultiStats: React.Dispatch<React.SetStateAction<Record<string, PairStat>>>;

  // Backtest
  backtestResults: BacktestResults | null;
  setBacktestResults: (r: BacktestResults | null) => void;

  // Setup
  setupComplete: boolean;
  setSetupComplete: (v: boolean) => void;
  credentialsValid: boolean;
  setCredentialsValid: (v: boolean) => void;

  // API credentials (for SettingsModal / SetupWizard)
  apiKey: string;
  setApiKey: (v: string) => void;
  apiSecret: string;
  setApiSecret: (v: string) => void;
  passphrase: string;
  setPassphrase: (v: string) => void;

  // Trade log
  tradeLog: TradeLogEntry[];
  setTradeLog: React.Dispatch<React.SetStateAction<TradeLogEntry[]>>;

  // Notifications
  notification: string;
  setNotification: (n: string) => void;

  // Language & App Settings
  language: "fi" | "en";
  setLanguage: (lang: "fi" | "en") => void;
  appSettings: AppSettings;
  setAppSettings: (s: AppSettings) => void;

  // Watchlist pairs — populated by Watchlist component, read by SignalPanel Recommendations
  watchlistPairs: WatchlistPair[];
  setWatchlistPairs: (pairs: WatchlistPair[]) => void;
}

const DEFAULT_CONFIG: BotConfig = {
  tradingPair: "BTC-USDT",
  timeframe: "5min",
  tradeAmountUSDT: 100,
  maxOpenTrades: 1,
  minSignalScore: 4,
  stopLossAtrMultiplier: 1.5,
  takeProfitMultiplier: 2.5,
  partialExitEnabled: true,
  backtestValidated: false,
};

const DEFAULT_PERFORMANCE: PerformanceMetrics = {
  sessionStartBalance: 0,
  currentBalance: 0,
  todayPnL: 0,
  todayPnLPct: 0,
  sessionTrades: 0,
  sessionWins: 0,
  sessionLosses: 0,
  winRate: 0,
  avgWinPct: 0,
  avgLossPct: 0,
  profitFactor: 0,
  expectancy: 0,
  currentStreak: 0,
  maxConsecutiveLosses: 0,
  adaptiveThreshold: 4,
  tpMultiplier: 2.5,
};

const TradingContext = createContext<TradingContextType | null>(null);

export function TradingProvider({ children }: { children: React.ReactNode }) {
  const [botConfig, setBotConfigState]   = useState<BotConfig>(DEFAULT_CONFIG);
  const [selectedSymbol, setSelectedSymbol] = useState("BTC-USDT");
  const [selectedTimeframe, setSelectedTimeframe] = useState("5min");
  const [candles, setCandles]            = useState<KuCoinCandle[]>([]);
  const [livePrice, setLivePrice]        = useState(0);
  const [bidAskSpread, setBidAskSpread]  = useState(0);
  const [currentSignal, setCurrentSignal] = useState<SignalResult | null>(null);
  const [botStatus, setBotStatus]        = useState<BotStatus>("STOPPED");
  const [openPosition, setOpenPosition]  = useState<LiveTrade | null>(null);
  const [performance, setPerformance]    = useState<PerformanceMetrics>(DEFAULT_PERFORMANCE);
  const [decisionLog, setDecisionLog]    = useState<BotDecisionLog[]>([]);
  const [backtestResults, setBacktestResults] = useState<BacktestResults | null>(null);
  const [setupComplete, setSetupComplete] = useState(false);
  const [credentialsValid, setCredentialsValid] = useState(false);
  const [notification, setNotification]  = useState("");

  // API credentials
  const [apiKey, setApiKeyState]         = useState("");
  const [apiSecret, setApiSecretState]   = useState("");
  const [passphrase, setPassphraseState] = useState("");

  // Trade log
  const [tradeLog, setTradeLog] = useState<TradeLogEntry[]>([]);

  // Language & App Settings
  const [language, setLanguageState] = useState<"fi" | "en">("fi");
  const [appSettings, setAppSettingsState] = useState<AppSettings>(() => {
    if (typeof window === "undefined") return {
      language: "fi", apiKey: "", apiSecret: "", apiPassphrase: "",
      sandboxMode: false, tradeAmountUSDT: 100, minSignalScore: 4,
      slMultiplier: 1.5, tpMultiplier: 2.5, maxPositions: 3,
      defaultTimeframe: "5min", kellyEnabled: true,
      autoOptimizerEnabled: true, feedbackLoopEnabled: false,
      soundAlerts: false, browserNotifications: false,
    };
    return loadAppSettings();
  });

  // Watchlist shared data
  const [watchlistPairs, setWatchlistPairs] = useState<WatchlistPair[]>([]);

  // Multi-pair state
  const [activePairs, setActivePairs]       = useState<string[]>([]);
  const [multiBotStatus, setMultiBotStatus] = useState<"STOPPED" | "RUNNING">("STOPPED");
  const [multiPositions, setMultiPositions] = useState<Record<string, LiveTrade | null>>({});
  const [multiStats, setMultiStats]         = useState<Record<string, PairStat>>({});

  useEffect(() => {
    let isMounted = true;
    try {
      // Load language preference
      const savedLang = localStorage.getItem("scalping_lang") as "fi" | "en" | null;
      if (savedLang === "fi" || savedLang === "en") setLanguageState(savedLang);
      else {
        const appSett = loadAppSettings();
        if (appSett.language) setLanguageState(appSett.language);
      }

      const saved = localStorage.getItem("botConfig");
      if (saved) { try { setBotConfigState(JSON.parse(saved)); } catch { /* corrupted */ } }

      const savedResults = localStorage.getItem("backtestResults");
      if (savedResults) { try { setBacktestResults(JSON.parse(savedResults)); } catch { /* corrupted */ } }

      const savedPairs = localStorage.getItem("activePairs");
      if (savedPairs) { try { setActivePairs(JSON.parse(savedPairs)); } catch { /* corrupted */ } }

      const savedStats = localStorage.getItem("multiStats");
      if (savedStats) { try { setMultiStats(JSON.parse(savedStats)); } catch { /* corrupted */ } }

      const savedSymbol = localStorage.getItem("selectedSymbol");
      if (savedSymbol) setSelectedSymbol(savedSymbol);

      const savedTf = localStorage.getItem("selectedTimeframe");
      if (savedTf) setSelectedTimeframe(savedTf);

      if (localStorage.getItem("setupComplete") === "true") setSetupComplete(true);

      // Load API credentials
      const savedKey  = localStorage.getItem("kc_api_key")    ?? "";
      const savedSec  = localStorage.getItem("kc_api_secret") ?? "";
      const savedPass = localStorage.getItem("kc_passphrase") ?? "";
      if (savedKey)  setApiKeyState(savedKey);
      if (savedSec)  setApiSecretState(savedSec);
      if (savedPass) setPassphraseState(savedPass);
      if (savedKey.trim() && savedSec.trim()) setCredentialsValid(true);

      // Re-validate credentials from saved app settings
      const savedCreds = loadAppSettings();
      if (savedCreds.apiKey.trim() && savedCreds.apiSecret.trim()) {
        setCredentialsValid(true);
      }
    } catch { /* ignore */ }

    // Load full trade log from server
    loadTradeLog().then(log => { if (isMounted) setTradeLog(log); }).catch(() => {});

    // Load validated pipeline params if available
    fetch("/api/trading/pipeline-params")
      .then(r => r.ok ? r.json() : null)
      .then((params: {
        minSignalScore?: number;
        stopLossAtrMultiplier?: number;
        takeProfitMultiplier?: number;
        validatedAt?: number;
      } | null) => {
        if (!isMounted || !params || !params.validatedAt) return;
        setBotConfigState(prev => ({
          ...prev,
          minSignalScore:        params.minSignalScore        ?? prev.minSignalScore,
          stopLossAtrMultiplier: params.stopLossAtrMultiplier ?? prev.stopLossAtrMultiplier,
          takeProfitMultiplier:  params.takeProfitMultiplier  ?? prev.takeProfitMultiplier,
          backtestValidated:     true,
        }));
      })
      .catch(() => {});

    return () => { isMounted = false; };
  }, []);

  const setBotConfig = useCallback((c: BotConfig) => {
    setBotConfigState(c);
    localStorage.setItem("botConfig", JSON.stringify(c));
  }, []);

  const setApiKey = useCallback((v: string) => {
    setApiKeyState(v);
    if (v) localStorage.setItem("kc_api_key", v);
  }, []);

  const setApiSecret = useCallback((v: string) => {
    setApiSecretState(v);
    if (v) localStorage.setItem("kc_api_secret", v);
  }, []);

  const setPassphrase = useCallback((v: string) => {
    setPassphraseState(v);
    if (v) localStorage.setItem("kc_passphrase", v);
  }, []);

  const addDecisionLog = useCallback((log: BotDecisionLog) => {
    setDecisionLog((prev) => [log, ...prev].slice(0, 200));
  }, []);

  const setLanguage = useCallback((lang: "fi" | "en") => {
    setLanguageState(lang);
    localStorage.setItem("scalping_lang", lang);
  }, []);

  const setAppSettings = useCallback((s: AppSettings) => {
    setAppSettingsState(s);
    saveAppSettings(s);
    // Keep language in sync
    setLanguageState(s.language);
    localStorage.setItem("scalping_lang", s.language);
  }, []);

  const persistingSetBacktestResults = useCallback((r: BacktestResults | null) => {
    setBacktestResults(r);
    if (r) localStorage.setItem("backtestResults", JSON.stringify(r));
    else localStorage.removeItem("backtestResults");
  }, []);

  const persistingSetActivePairs = useCallback((pairs: string[]) => {
    setActivePairs(pairs);
    localStorage.setItem("activePairs", JSON.stringify(pairs));
  }, []);

  const persistingSetSelectedSymbol = useCallback((s: string) => {
    setSelectedSymbol(s);
    localStorage.setItem("selectedSymbol", s);
  }, []);

  const persistingSetSelectedTimeframe = useCallback((t: string) => {
    setSelectedTimeframe(t);
    localStorage.setItem("selectedTimeframe", t);
  }, []);

  const persistingSetMultiStats: React.Dispatch<React.SetStateAction<Record<string, PairStat>>> = useCallback(
    (action) => {
      setMultiStats((prev) => {
        const next = typeof action === "function" ? action(prev) : action;
        localStorage.setItem("multiStats", JSON.stringify(next));
        return next;
      });
    }, []
  );

  return (
    <TradingContext.Provider value={{
      botConfig, setBotConfig,
      selectedSymbol, setSelectedSymbol: persistingSetSelectedSymbol,
      selectedTimeframe, setSelectedTimeframe: persistingSetSelectedTimeframe,
      candles, setCandles,
      livePrice, setLivePrice,
      bidAskSpread, setBidAskSpread,
      currentSignal, setCurrentSignal,
      botStatus, setBotStatus,
      openPosition, setOpenPosition,
      performance, setPerformance,
      decisionLog, addDecisionLog,
      activePairs, setActivePairs: persistingSetActivePairs,
      multiBotStatus, setMultiBotStatus,
      multiPositions, setMultiPositions,
      multiStats, setMultiStats: persistingSetMultiStats,
      backtestResults, setBacktestResults: persistingSetBacktestResults,
      setupComplete, setSetupComplete,
      credentialsValid, setCredentialsValid,
      apiKey, setApiKey,
      apiSecret, setApiSecret,
      passphrase, setPassphrase,
      tradeLog, setTradeLog,
      notification, setNotification,
      language, setLanguage,
      appSettings, setAppSettings,
      watchlistPairs, setWatchlistPairs,
    }}>
      {children}
    </TradingContext.Provider>
  );
}

export function useTradingContext(): TradingContextType {
  const ctx = useContext(TradingContext);
  if (!ctx) throw new Error("useTradingContext must be inside TradingProvider");
  return ctx;
}
