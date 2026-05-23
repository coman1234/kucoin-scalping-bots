"use client";

/**
 * TradingWorkflow — server-driven pipeline UI.
 *
 * The pipeline runs automatically on the server (lib/serverPipeline.ts).
 * This component just shows the status and collapsible result sections.
 *
 *  Step 1 🔬  OPTIMIZE  — runs on server, 576 combos across 20 pairs
 *  Step 2 🔍  VALIDATE  — cross-pair batch validation (server)
 *  Step 3 📊  CONFIRM   — BTC-USDT confirmation gate (server)
 *  Step 4 🖥  MONITOR   — Trade Journal + Activity Log
 */

import { useState } from "react";
import PipelineStatus from "@/components/PipelineStatus";
import TradeJournal   from "@/components/TradeJournal";
import ActivityLog    from "@/components/ActivityLog";
import Backtester     from "@/components/Backtester";
import DataStorePanel from "@/components/DataStorePanel";
import { useTradingContext } from "@/lib/context";
import { cn } from "@/lib/utils";

export default function TradingWorkflow() {
  const { language } = useTradingContext();
  const isFi = language === "fi";

  const [backtestOpen, setBacktestOpen]     = useState(false);
  const [dataStoreOpen, setDataStoreOpen]   = useState(false);
  const [journalOpen, setJournalOpen]       = useState(true);
  const [logOpen, setLogOpen]               = useState(true);

  return (
    <div className="space-y-2 pb-3">

      {/* ── Server pipeline status ──────────────────────────────────────────── */}
      <PipelineStatus />

      {/* ── Historical Data Store ────────────────────────────────────────────── */}
      <CollapsibleSection
        num={0}
        icon="📦"
        labelEn="Data Store (2y history)"
        labelFi="Datavarasto (2v historia)"
        open={dataStoreOpen}
        onToggle={() => setDataStoreOpen(v => !v)}
        isFi={isFi}
      >
        <DataStorePanel />
      </CollapsibleSection>

      {/* ── Backtester ──────────────────────────────────────────────────────── */}
      <CollapsibleSection
        num={0}
        icon="📈"
        labelEn="Backtester"
        labelFi="Backtestaaja"
        open={backtestOpen}
        onToggle={() => setBacktestOpen(v => !v)}
        isFi={isFi}
      >
        <Backtester />
      </CollapsibleSection>

      {/* ── Step 4: Monitor ─────────────────────────────────────────────────── */}
      <CollapsibleSection
        num={4}
        icon="🖥"
        labelEn="Trade Journal"
        labelFi="Kauppaloki"
        open={journalOpen}
        onToggle={() => setJournalOpen(v => !v)}
        isFi={isFi}
      >
        <TradeJournal />
      </CollapsibleSection>

      <CollapsibleSection
        num={4}
        icon="📋"
        labelEn="Activity Log"
        labelFi="Toimintaloki"
        open={logOpen}
        onToggle={() => setLogOpen(v => !v)}
        isFi={isFi}
      >
        <ActivityLog />
      </CollapsibleSection>

    </div>
  );
}

// ── CollapsibleSection ────────────────────────────────────────────────────────

function CollapsibleSection({
  num, icon, labelEn, labelFi, open, onToggle, isFi, children,
}: {
  num: number;
  icon: string;
  labelEn: string;
  labelFi: string;
  open: boolean;
  onToggle: () => void;
  isFi: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="border-l-2 border-l-tv-border pl-2.5 space-y-1.5">
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-1.5 text-left group"
      >
        <span className="flex-shrink-0 inline-flex items-center justify-center w-4 h-4 rounded-full text-[8px] font-bold bg-tv-bg3 text-tv-text3">
          {num}
        </span>
        <span className="text-[9px] font-bold uppercase tracking-wide text-tv-text2 group-hover:text-tv-text transition-colors">
          {icon} {isFi ? labelFi : labelEn}
        </span>
        <span className={cn(
          "ml-auto text-[9px] text-tv-text3 transition-transform",
          open ? "rotate-90" : ""
        )}>
          ›
        </span>
      </button>
      {open && children}
    </div>
  );
}
