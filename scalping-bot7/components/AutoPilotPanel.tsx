"use client";

import { useEffect } from "react";
import { useAutoPilot } from "@/lib/autoPilot";
import { cn } from "@/lib/utils";
import { useTradingContext } from "@/lib/context";

interface Props {
  onAutoOptimize?: () => void;   // called when AutoPilot wants to run optimizer
  onAutoBacktest?: () => void;   // called when AutoPilot wants to run backtester
}

export default function AutoPilotPanel({ onAutoOptimize, onAutoBacktest }: Props) {
  const { language } = useTradingContext();
  const isFi = language === "fi";
  const pilot = useAutoPilot();

  // Trigger callbacks when autopilot requests actions
  useEffect(() => {
    if (pilot.shouldAutoOptimize && onAutoOptimize) {
      pilot.clearAutoOptimize();
      onAutoOptimize();
    }
  }, [pilot.shouldAutoOptimize, onAutoOptimize, pilot]);

  useEffect(() => {
    if (pilot.shouldAutoBacktest && onAutoBacktest) {
      pilot.clearAutoBacktest();
      onAutoBacktest();
    }
  }, [pilot.shouldAutoBacktest, onAutoBacktest, pilot]);

  const phaseConfig = {
    idle:        { color: "bg-tv-bg2 border-tv-border text-tv-text2",          icon: "⏸" },
    optimizing:  { color: "bg-tv-purple/10 border-tv-purple/30 text-tv-purple", icon: "🔬" },
    backtesting: { color: "bg-tv-blue/10 border-tv-blue/30 text-tv-blue",       icon: "📊" },
    validated:   { color: "bg-tv-green/10 border-tv-green/30 text-tv-green",    icon: "✅" },
    trading:     { color: "bg-tv-green/15 border-tv-green/40 text-tv-green",    icon: "📈" },
    error:       { color: "bg-tv-red/10 border-tv-red/30 text-tv-red",          icon: "❌" },
  };
  const cfg = phaseConfig[pilot.phase];

  return (
    <div className={cn("rounded border px-3 py-2 flex items-center gap-2 text-xs", cfg.color)}>
      <span className="text-base flex-shrink-0">{cfg.icon}</span>
      <div className="flex-1 min-w-0">
        <span className="font-semibold">
          {isFi ? "AutoPilot: " : "AutoPilot: "}
        </span>
        <span>{pilot.message || (isFi ? "Odottaa..." : "Idle...")}</span>
      </div>
      {(pilot.phase === "optimizing" || pilot.phase === "backtesting") && (
        <div className="w-2 h-2 rounded-full bg-current animate-pulse flex-shrink-0" />
      )}
    </div>
  );
}
