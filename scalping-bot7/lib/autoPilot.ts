"use client";
import { useEffect, useState, useCallback } from "react";
import { useTradingContext } from "@/lib/context";

const OPTIMIZER_STORAGE_KEY = "scalping_optimizerState";
const AUTO_START_DELAY_MS = 3000;

export interface AutoPilotState {
  phase: "idle" | "optimizing" | "backtesting" | "validated" | "trading" | "error";
  message: string;
  shouldAutoOptimize: boolean;        // signal to AutoOptimizer to start
  shouldAutoBacktest: boolean;        // signal to Backtester to start
  clearAutoOptimize: () => void;
  clearAutoBacktest: () => void;
}

export function useAutoPilot(): AutoPilotState {
  const { botConfig, botStatus, language } = useTradingContext();
  const isFi = language === "fi";

  const [phase, setPhase] = useState<AutoPilotState["phase"]>("idle");
  const [message, setMessage] = useState("");
  const [shouldAutoOptimize, setShouldAutoOptimize] = useState(false);
  const [shouldAutoBacktest, setShouldAutoBacktest] = useState(false);

  // On mount: check if we need to auto-start optimizer
  useEffect(() => {
    const savedOptimizer = localStorage.getItem(OPTIMIZER_STORAGE_KEY);
    const hasOptimizerResult = savedOptimizer ? !!JSON.parse(savedOptimizer).best : false;

    if (!botConfig.backtestValidated && !hasOptimizerResult) {
      // No validated params and no optimizer results — schedule auto-optimize
      const timer = setTimeout(() => {
        setPhase("optimizing");
        setMessage(isFi
          ? "🔬 Aloitetaan automaattinen optimointi..."
          : "🔬 Starting automatic optimization...");
        setShouldAutoOptimize(true);
      }, AUTO_START_DELAY_MS);
      return () => clearTimeout(timer);
    } else if (!botConfig.backtestValidated && hasOptimizerResult) {
      // Have optimizer results but not backtested — auto-backtest
      setPhase("backtesting");
      setMessage(isFi
        ? "📊 Optimointitulokset ladattu — ajetaan historiatesti..."
        : "📊 Optimizer results loaded — running backtest...");
      setShouldAutoBacktest(true);
    } else if (botConfig.backtestValidated) {
      setPhase("validated");
      setMessage(isFi ? "✅ Parametrit vahvistettu — botti valmis" : "✅ Parameters validated — bot ready");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Watch bot status
  useEffect(() => {
    if (botStatus === "RUNNING") {
      setPhase("trading");
      setMessage(isFi ? "📈 Botti käynnissä" : "📈 Bot running");
    } else if (botStatus === "STOPPED" && phase === "trading") {
      setPhase("validated");
      setMessage(isFi ? "✅ Botti pysäytetty — parametrit yhä voimassa" : "✅ Bot stopped — parameters still valid");
    }
  }, [botStatus, isFi, phase]);

  // Watch backtestValidated
  useEffect(() => {
    if (botConfig.backtestValidated && phase === "backtesting") {
      setPhase("validated");
      setMessage(isFi ? "✅ Historiatesti läpäisty — botti valmis käynnistettäväksi" : "✅ Backtest passed — bot ready to start");
    }
  }, [botConfig.backtestValidated, phase, isFi]);

  const clearAutoOptimize = useCallback(() => setShouldAutoOptimize(false), []);
  const clearAutoBacktest = useCallback(() => setShouldAutoBacktest(false), []);

  return { phase, message, shouldAutoOptimize, shouldAutoBacktest, clearAutoOptimize, clearAutoBacktest };
}
