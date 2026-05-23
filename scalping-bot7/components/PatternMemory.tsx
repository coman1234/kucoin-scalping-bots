"use client";

import { useState, useEffect, useCallback } from "react";
import { useTradingContext } from "@/lib/context";
import {
  loadPatterns,
  findSimilarPatterns,
  exportPatterns,
  importPatterns,
  getPatternCount,
  buildFingerprint,
} from "@/lib/patternMemory";
import type { PatternAnalysis } from "@/lib/patternMemory";
import { cn } from "@/lib/utils";
import { useT } from "@/components/SettingsModal";

export default function PatternMemory() {
  const { selectedSymbol, selectedTimeframe, currentSignal, language } = useTradingContext();
  const t = useT();
  const isFi = language === "fi";
  const [open, setOpen]             = useState(false);
  const [patternCount, setPatternCount] = useState(0);
  const [analysis, setAnalysis]     = useState<PatternAnalysis | null>(null);

  const refresh = useCallback(() => {
    const count = getPatternCount(selectedSymbol, selectedTimeframe);
    setPatternCount(count);

    if (currentSignal && currentSignal.direction !== "NEUTRAL" && currentSignal.indicators) {
      const fp = buildFingerprint(
        currentSignal.indicators,
        {
          open: currentSignal.entryPrice,
          high: currentSignal.entryPrice,
          low: currentSignal.entryPrice,
          close: currentSignal.entryPrice,
          volume: 0,
        },
        currentSignal.score,
        currentSignal.direction as "BUY" | "SELL",
        currentSignal.conditionsMet,
        selectedSymbol,
        selectedTimeframe
      );
      const a = findSimilarPatterns(fp.indicators, selectedSymbol, selectedTimeframe, currentSignal.direction as "BUY" | "SELL");
      setAnalysis(a);
    }
  }, [selectedSymbol, selectedTimeframe, currentSignal]);

  useEffect(() => { refresh(); }, [refresh]);

  const handleExport = useCallback(() => {
    const json = exportPatterns(selectedSymbol, selectedTimeframe);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `patterns_${selectedSymbol}_${selectedTimeframe}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [selectedSymbol, selectedTimeframe]);

  const handleImport = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>, crossTimeframe = false) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const data = ev.target?.result as string;
        const result = importPatterns(data, selectedSymbol, selectedTimeframe, crossTimeframe);
        if (result.warning) alert(result.warning);
        else alert(`Tuotu ${result.imported} kaavaa`);
        refresh();
      };
      reader.readAsText(file);
    },
    [selectedSymbol, selectedTimeframe, refresh]
  );

  const LEARNING_THRESHOLD = 30;

  const confidenceColor =
    analysis?.confidence === "HIGH"   ? "text-tv-green" :
    analysis?.confidence === "MEDIUM" ? "text-tv-amber" :
    analysis?.confidence === "LOW"    ? "text-tv-red"   : "text-tv-text2";

  const recColor =
    analysis?.recommendation === "PROCEED" ? "text-tv-green" :
    analysis?.recommendation === "CAUTION" ? "text-tv-amber" : "text-tv-red";

  return (
    <div className="panel">
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-sm font-semibold text-tv-text uppercase tracking-wide"
      >
        <span>🧠 {t("pattern.title")}</span>
        <span className="text-tv-text2">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 space-y-3">
          <div className="flex justify-between text-xs">
            <span className="text-tv-text2">{selectedSymbol} {selectedTimeframe}</span>
            <span className="text-tv-text font-semibold">{patternCount} {isFi ? "kaavaa tallennettu" : "patterns saved"}</span>
          </div>

          {patternCount < LEARNING_THRESHOLD && (
            <div className="text-xs bg-tv-blue-dim border border-tv-blue/30 text-tv-blue rounded px-2 py-1.5">
              {isFi ? `🧠 Opetustila: rakennetaan kaavamuistia... (${patternCount}/${LEARNING_THRESHOLD} kauppaa tarvitaan)` : `🧠 Learning mode: building pattern memory... (${patternCount}/${LEARNING_THRESHOLD} trades needed)`}
            </div>
          )}

          {/* Nykyisen signaalin vastaavuus */}
          {analysis && (
            <div className="space-y-2">
              <div className="text-xs text-tv-text2 uppercase tracking-wide border-b border-tv-border pb-1">
                {isFi ? "Nykyisen signaalin vastaavuus" : "Current signal match"}
              </div>

              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-tv-bg2 rounded px-2 py-1.5">
                  <div className="text-tv-text2 text-[10px]">{isFi ? "Samankaltaiset kaavat" : "Similar patterns"}</div>
                  <div className="font-semibold text-tv-text">{analysis.matchCount}</div>
                </div>
                <div className="bg-tv-bg2 rounded px-2 py-1.5">
                  <div className="text-tv-text2 text-[10px]">{isFi ? "Historiallinen osumisprosentti" : "Historical win rate"}</div>
                  <div className={cn("font-semibold", analysis.winRate >= 60 ? "text-tv-green" : analysis.winRate >= 45 ? "text-tv-amber" : "text-tv-red")}>
                    {analysis.matchCount > 0 ? `${analysis.winRate.toFixed(1)}%` : "—"}
                  </div>
                </div>
                <div className="bg-tv-bg2 rounded px-2 py-1.5">
                  <div className="text-tv-text2 text-[10px]">{isFi ? "Keskim. P&L" : "Avg P&L"}</div>
                  <div className={cn("font-semibold font-mono", analysis.avgPnlPct >= 0 ? "text-tv-green" : "text-tv-red")}>
                    {analysis.matchCount > 0 ? `${analysis.avgPnlPct >= 0 ? "+" : ""}${analysis.avgPnlPct.toFixed(2)}%` : "—"}
                  </div>
                </div>
                <div className="bg-tv-bg2 rounded px-2 py-1.5">
                  <div className="text-tv-text2 text-[10px]">{isFi ? "Keskim. kesto" : "Avg duration"}</div>
                  <div className="font-semibold text-tv-text">
                    {analysis.matchCount > 0 ? `${analysis.avgDurationMinutes.toFixed(0)} min` : "—"}
                  </div>
                </div>
              </div>

              {/* Luottamuspalkki */}
              {analysis.matchCount > 0 && (
                <div>
                  <div className="flex justify-between text-[10px] mb-1">
                    <span className="text-tv-text2">{isFi ? "Luottamus" : "Confidence"}</span>
                    <span className={confidenceColor}>{analysis.confidence}</span>
                  </div>
                  <div className="h-2 bg-tv-bg3 rounded-full overflow-hidden">
                    <div
                      className={cn(
                        "h-full rounded-full transition-all",
                        analysis.confidence === "HIGH"   ? "bg-tv-green" :
                        analysis.confidence === "MEDIUM" ? "bg-tv-amber" :
                        analysis.confidence === "LOW"    ? "bg-tv-red" : "bg-tv-text3"
                      )}
                      style={{
                        width:
                          analysis.confidence === "HIGH"   ? "90%" :
                          analysis.confidence === "MEDIUM" ? "60%" :
                          analysis.confidence === "LOW"    ? "30%" : "10%"
                      }}
                    />
                  </div>
                </div>
              )}

              {/* Suositus */}
              <div className={cn(
                "rounded p-2 text-xs border",
                analysis.recommendation === "PROCEED"
                  ? "bg-tv-green-dim border-tv-green/30"
                  : analysis.recommendation === "CAUTION"
                  ? "bg-tv-amber-dim border-tv-amber/30"
                  : "bg-tv-red-dim border-tv-red/30"
              )}>
                <div className={cn("font-bold mb-0.5", recColor)}>
                  {analysis.recommendation === "PROCEED" ? (isFi ? "✅ JATKA" : "✅ PROCEED") :
                   analysis.recommendation === "CAUTION" ? (isFi ? "⚠️ VAROITUS" : "⚠️ CAUTION") : (isFi ? "🚫 OHITA" : "🚫 SKIP")}
                </div>
                <div className="text-tv-text2">{analysis.recommendationReason}</div>
              </div>

              {/* Paras / Huonoin */}
              {analysis.matchCount >= 2 && (
                <div className="grid grid-cols-3 gap-2 text-xs">
                  <div className="bg-tv-bg2 rounded px-2 py-1">
                    <div className="text-tv-text2 text-[10px]">{isFi ? "Paras" : "Best"}</div>
                    <div className="text-tv-green font-mono">+{analysis.bestOutcome.toFixed(2)}%</div>
                  </div>
                  <div className="bg-tv-bg2 rounded px-2 py-1">
                    <div className="text-tv-text2 text-[10px]">{isFi ? "Huonoin" : "Worst"}</div>
                    <div className="text-tv-red font-mono">{analysis.worstOutcome.toFixed(2)}%</div>
                  </div>
                  <div className="bg-tv-bg2 rounded px-2 py-1">
                    <div className="text-tv-text2 text-[10px]">{t("signal.exit")}</div>
                    <div className="text-tv-text">{analysis.commonExitReason}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Vie / Tuo */}
          <div className="border-t border-tv-border pt-3 space-y-2">
            <div className="text-xs text-tv-text2 uppercase tracking-wide">{isFi ? "Varmuuskopio / Palautus" : "Backup / Restore"}</div>
            <div className="flex gap-2">
              <button
                onClick={handleExport}
                disabled={patternCount === 0}
                className="flex-1 text-xs py-1.5 rounded bg-tv-bg2 text-tv-text hover:bg-tv-bg3 border border-tv-border transition-colors disabled:opacity-40"
              >
                ↓ {isFi ? "Vie JSON" : "Export JSON"}
              </button>
              <label className="flex-1 text-xs py-1.5 rounded bg-tv-bg2 text-tv-text hover:bg-tv-bg3 border border-tv-border transition-colors cursor-pointer text-center">
                ↑ {isFi ? "Tuo JSON" : "Import JSON"}
                <input type="file" accept=".json" className="hidden" onChange={(e) => handleImport(e)} />
              </label>
            </div>
            <label className="block w-full text-xs py-1.5 rounded bg-tv-bg2 text-tv-text2 border border-tv-border border-dashed transition-colors cursor-pointer text-center hover:bg-tv-bg3">
              ↑ {isFi ? "Tuo eri aikaväliltä (varoituksella)" : "Import from different timeframe (with warning)"}
              <input type="file" accept=".json" className="hidden" onChange={(e) => handleImport(e, true)} />
            </label>
          </div>
        </div>
      )}
    </div>
  );
}
