"use client";

/**
 * scalping-day7 dashboard — Bot C autonomous day-trader
 * Styled to match scalping-bot6 (TradingView light theme).
 * Polls /api/dashboard every 5 s.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import type {
  DashboardState, Position, BreakoutSignal, RiskState, ProducerHealth, SimulationStats, ActivityEvent, WalletState,
} from "@/lib/types";
import type { TraderConfig } from "@/lib/traderConfig";

const POLL_MS = 5_000;

// ── Tiny utility: TradingView-style cn helper ──────────────────────────────────
function cn(...cls: (string | undefined | false)[]) { return cls.filter(Boolean).join(" "); }

// ── Format helpers ─────────────────────────────────────────────────────────────
function fmt2(n?: number)    { return n != null ? n.toFixed(2) : "—"; }
function fmtSign(n?: number) { return n != null ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}` : "—"; }
function fmtPct(n?: number)  { return n != null ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "—"; }
function fmtPrice(n?: number) {
  if (n == null) return "—";
  if (n >= 1000) return n.toFixed(1);
  if (n >= 100)  return n.toFixed(2);
  if (n >= 1)    return n.toFixed(4);
  return n.toFixed(6);
}
function fmtAge(ms: number) {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
}
function fmtTime(ms: number) { return new Date(ms).toLocaleTimeString("fi-FI"); }

// ── Colour helpers ─────────────────────────────────────────────────────────────
function pnlCls(v: number)   { return v > 0 ? "text-tv-green" : v < 0 ? "text-tv-red" : "text-tv-text2"; }
function dirCls(d: string)   { return d === "BUY" ? "text-tv-green" : d === "SELL" ? "text-tv-red" : "text-tv-text2"; }
function scoreCls(s: number, max: number) {
  const r = s / max;
  return r >= 0.8 ? "text-tv-green" : r >= 0.5 ? "text-tv-amber" : "text-tv-text2";
}

// ── SVG Cumulative P&L Chart ───────────────────────────────────────────────────
interface EquityPoint { tradeN: number; cumPnl: number; pnl: number; symbol: string; win: boolean; time: number; }

function PnlChart({ trades }: { trades: Position[] }) {
  const closed = [...trades].filter(p => p.state === "CLOSED" && p.pnlUsdt != null)
    .sort((a, b) => (a.exitTime ?? 0) - (b.exitTime ?? 0));

  if (closed.length === 0) {
    return (
      <div className="panel">
        <div className="label mb-3">Cumulative P&L</div>
        <div className="flex items-center justify-center h-32 text-tv-text3 text-sm italic">
          No closed trades yet — chart will appear here
        </div>
      </div>
    );
  }

  // Build equity curve
  const points: EquityPoint[] = [];
  let cum = 0;
  closed.forEach((p, i) => {
    cum += p.pnlUsdt ?? 0;
    points.push({
      tradeN: i + 1,
      cumPnl: cum,
      pnl:    p.pnlUsdt ?? 0,
      symbol: p.symbol.replace("-USDT", ""),
      win:    (p.pnlUsdt ?? 0) > 0,
      time:   p.exitTime ?? 0,
    });
  });

  // Stats
  const totalPnl  = cum;
  const wins      = points.filter(p => p.win).length;
  const winRate   = (wins / points.length * 100).toFixed(1);
  const maxPnl    = Math.max(...points.map(p => p.cumPnl));
  const minPnl    = Math.min(...points.map(p => p.cumPnl));
  // Max drawdown from peak
  let peak = 0; let maxDd = 0;
  for (const pt of points) {
    if (pt.cumPnl > peak) peak = pt.cumPnl;
    const dd = peak - pt.cumPnl;
    if (dd > maxDd) maxDd = dd;
  }

  // SVG layout
  const W = 800; const H = 160; const PAD = { t: 12, r: 16, b: 28, l: 52 };
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;
  const n  = points.length;

  // Y range — add 10% padding, always include zero
  const yMin = Math.min(0, minPnl) * 1.1;
  const yMax = Math.max(0, maxPnl) * 1.1 || 10;
  const yRange = yMax - yMin || 1;

  function xPos(i: number) { return PAD.l + (n === 1 ? iW / 2 : (i / (n - 1)) * iW); }
  function yPos(v: number) { return PAD.t + iH - ((v - yMin) / yRange) * iH; }

  const zeroY = yPos(0);

  // SVG path
  const pathD = points.map((p, i) => `${i === 0 ? "M" : "L"}${xPos(i).toFixed(1)},${yPos(p.cumPnl).toFixed(1)}`).join(" ");

  // Fill area below/above zero
  const areaAbove = points.map((p, i) => {
    const x = xPos(i); const y = yPos(p.cumPnl); const z = zeroY;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${Math.min(y, z).toFixed(1)}`;
  }).join(" ") + ` L${xPos(n - 1).toFixed(1)},${zeroY.toFixed(1)} L${xPos(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  const areaBelow = points.map((p, i) => {
    const x = xPos(i); const y = yPos(p.cumPnl); const z = zeroY;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${Math.max(y, z).toFixed(1)}`;
  }).join(" ") + ` L${xPos(n - 1).toFixed(1)},${zeroY.toFixed(1)} L${xPos(0).toFixed(1)},${zeroY.toFixed(1)} Z`;

  // Y-axis gridlines (3 lines)
  const gridValues = [yMin, (yMin + yMax) / 2, yMax];

  return (
    <div className="panel">
      {/* Header row */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <span className="label">Cumulative P&L — {n} trade{n !== 1 ? "s" : ""}</span>
        <div className="flex items-center gap-4 text-[12px] font-mono">
          <span className={cn("font-bold", pnlCls(totalPnl))}>
            {totalPnl >= 0 ? "+" : ""}{totalPnl.toFixed(2)} USDT
          </span>
          <span className="text-tv-text2">WR <span className={cn("font-bold", parseFloat(winRate) >= 60 ? "text-tv-green" : "text-tv-amber")}>{winRate}%</span></span>
          {maxDd > 0 && <span className="text-tv-text2">MaxDD <span className="font-bold text-tv-red">−{maxDd.toFixed(2)}</span></span>}
          <span className="text-tv-text2">{wins}W / {n - wins}L</span>
        </div>
      </div>

      {/* SVG chart — responsive via viewBox */}
      <div className="w-full overflow-hidden">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full"
          style={{ height: 170 }}
          preserveAspectRatio="xMidYMid meet"
        >
          {/* Grid lines */}
          {gridValues.map((v, i) => (
            <g key={i}>
              <line
                x1={PAD.l} y1={yPos(v)}
                x2={W - PAD.r} y2={yPos(v)}
                stroke="#e0e3eb" strokeWidth="1" strokeDasharray={v === 0 ? "none" : "3,3"}
              />
              <text x={PAD.l - 4} y={yPos(v) + 4} textAnchor="end" fontSize="9" fill="#787b86" fontFamily="monospace">
                {v === 0 ? "0" : (v > 0 ? "+" : "") + v.toFixed(1)}
              </text>
            </g>
          ))}

          {/* Zero line (prominent) */}
          <line
            x1={PAD.l} y1={zeroY}
            x2={W - PAD.r} y2={zeroY}
            stroke="#b2b5be" strokeWidth="1.5"
          />

          {/* Fill areas */}
          <path d={areaAbove} fill="#26a69a" fillOpacity="0.12" />
          <path d={areaBelow} fill="#ef5350" fillOpacity="0.12" />

          {/* Main line */}
          <path d={pathD} fill="none"
            stroke={totalPnl >= 0 ? "#26a69a" : "#ef5350"}
            strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
          />

          {/* Trade dots */}
          {points.map((p, i) => (
            <circle
              key={i}
              cx={xPos(i)} cy={yPos(p.cumPnl)} r={n > 50 ? 1.5 : 3}
              fill={p.win ? "#26a69a" : "#ef5350"}
              stroke="white" strokeWidth="1"
            >
              <title>{`#${p.tradeN} ${p.symbol} ${p.win ? "+" : ""}${p.pnl.toFixed(2)} USDT @ ${fmtTime(p.time)}`}</title>
            </circle>
          ))}

          {/* X-axis labels (first, last, and every ~10 trades) */}
          {points
            .filter((_, i) => i === 0 || i === n - 1 || (n > 5 && i % Math.max(1, Math.floor(n / 6)) === 0))
            .map((p) => (
              <text
                key={p.tradeN}
                x={xPos(p.tradeN - 1)} y={H - 4}
                textAnchor="middle" fontSize="9" fill="#b2b5be" fontFamily="monospace"
              >
                #{p.tradeN}
              </text>
            ))
          }
        </svg>
      </div>
    </div>
  );
}

// ── Mode badge ─────────────────────────────────────────────────────────────────
function ModeBadge({ mode }: { mode: string }) {
  if (mode === "LIVE")
    return <span className="badge bg-tv-green text-white">● LIVE</span>;
  if (mode === "SIM")
    return <span className="badge bg-tv-blue-dim text-tv-blue border border-tv-blue/30">◎ SIM</span>;
  return <span className="badge bg-tv-amber-dim text-tv-amber border border-tv-amber/30">DRY</span>;
}

// ── Simulation banner ──────────────────────────────────────────────────────────
function SimBanner({ sim }: { sim: SimulationStats }) {
  if (!sim.active) return null;
  const wr  = sim.trades > 0 ? ((sim.wins / sim.trades) * 100).toFixed(1) : "—";
  const dur = sim.startedAt > 0 ? Math.floor((Date.now() - sim.startedAt) / 60000) : 0;
  return (
    <div className="mx-4 mt-2 px-4 py-2 bg-tv-blue-dim border border-tv-blue/30 rounded-lg flex flex-wrap items-center gap-5 text-[12px]">
      <span className="font-bold text-tv-blue">◎ SIMULATION ACTIVE</span>
      <span className="text-tv-text2">Trades <strong className="text-tv-text font-mono">{sim.trades}</strong></span>
      <span className="text-tv-text2">W / L <strong className="text-tv-green font-mono">{sim.wins}</strong> / <strong className="text-tv-red font-mono">{sim.losses}</strong></span>
      <span className="text-tv-text2">Win% <strong className="text-tv-text font-mono">{wr}%</strong></span>
      <span className={cn("font-bold font-mono", pnlCls(sim.pnlUsdt))}>{fmtPct(sim.pnlPct)} ({fmtSign(sim.pnlUsdt)} USDT)</span>
      <span className="text-tv-text3 text-[11px]">{dur}m · virtual ${fmt2(sim.startEquity)}</span>
    </div>
  );
}

// ── Card wrapper ──────────────────────────────────────────────────────────────
function Card({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="panel">
      <div className="flex items-center justify-between mb-3">
        <span className="label">{title}</span>
        {action}
      </div>
      {children}
    </div>
  );
}

// ── Stat cell ─────────────────────────────────────────────────────────────────
function Stat({ label, value, cls }: { label: string; value: string; cls?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[11px] text-tv-text3 uppercase font-medium tracking-wide">{label}</span>
      <span className={cn("text-sm font-bold font-mono tabular-nums", cls ?? "text-tv-text")}>{value}</span>
    </div>
  );
}

// ── Pill ──────────────────────────────────────────────────────────────────────
function Pill({ label, ok, warn }: { label: string; ok?: boolean; warn?: boolean }) {
  return (
    <span className={cn(
      "badge",
      ok   ? "bg-tv-green-dim text-tv-green border border-tv-green/30" :
      warn ? "bg-tv-amber-dim text-tv-amber border border-tv-amber/30" :
             "bg-tv-red-dim text-tv-red border border-tv-red/30"
    )}>{label}</span>
  );
}

// ── Producer health panel ──────────────────────────────────────────────────────
function ProducerPanel({ h, bot7AgeMs, confluenceMin }: {
  h: ProducerHealth;
  bot7AgeMs: number;
  confluenceMin: number;
}) {
  const confluenceOk   = bot7AgeMs >= 0 && bot7AgeMs < 120_000;
  const confluenceWarn = bot7AgeMs >= 0 && bot7AgeMs >= 120_000;
  const confluenceAge  = bot7AgeMs >= 0
    ? bot7AgeMs < 60_000 ? `${Math.round(bot7AgeMs / 1000)}s ago`
    : `${Math.round(bot7AgeMs / 60_000)}m ago`
    : "–";

  return (
    <Card title="Data Producer">
      <div className="flex items-center gap-4 flex-wrap">
        <Pill label={h.alive ? "ALIVE" : "DEAD"} ok={h.alive} />
        <span className="text-[12px] text-tv-text2">
          Lag <span className={cn("font-mono font-bold", h.lagMs > 5000 ? "text-tv-red" : "text-tv-text")}>
            {h.lagMs < 0 ? "?" : `${h.lagMs}ms`}
          </span>
        </span>
        <span className="text-[12px] text-tv-text2">
          Cycles <span className="font-mono font-bold text-tv-text">{h.cycleCount.toLocaleString()}</span>
        </span>
        {h.errorCount > 0 && (
          <span className="text-[12px] text-tv-text2">
            Errors <span className="font-mono font-bold text-tv-amber">{h.errorCount}</span>
          </span>
        )}
        {h.shmRoot && <span className="text-[11px] text-tv-text3 truncate max-w-xs">{h.shmRoot}</span>}
      </div>
      {/* Bot7 confluence status */}
      <div className="flex items-center gap-3 mt-2 pt-2 border-t border-tv-border">
        <span className="text-[11px] text-tv-text3 uppercase tracking-wide font-semibold">Bot7 confluence</span>
        <Pill
          label={bot7AgeMs < 0 ? "NO DATA" : confluenceOk ? `OK · ${confluenceAge}` : `STALE · ${confluenceAge}`}
          ok={confluenceOk}
          warn={confluenceWarn}
        />
        <span className="text-[11px] text-tv-text3">
          {confluenceMin === 0
            ? "off — set in Settings → Parametrit → Bot7 confluence"
            : `min score ${confluenceMin}/13 required`}
        </span>
      </div>
    </Card>
  );
}

// ── Risk state panel ───────────────────────────────────────────────────────────
function RiskPanel({ r, onKill, onUnkill, busy }: {
  r: RiskState; onKill: () => void; onUnkill: () => void; busy: boolean;
}) {
  return (
    <Card title="Risk State">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-4">
        <Stat label="Equity"       value={`$${fmt2(r.accountEquity)}`} />
        <Stat label="Daily P&L"    value={fmtPct(r.dailyPnlPct)}    cls={pnlCls(r.dailyPnlPct)} />
        <Stat label="Daily P&L $"  value={`${fmtSign(r.dailyPnlUsdt)} $`} cls={pnlCls(r.dailyPnlUsdt)} />
        <Stat label="Max DD"       value={`${r.maxDrawdownPct.toFixed(2)}%`} cls={r.maxDrawdownPct > 3 ? "text-tv-red" : "text-tv-text"} />
        <Stat label="Trades today" value={String(r.totalTradesDay)} />
        <Stat label="W / L"        value={`${r.winsDay} / ${r.lossesDay}`} />
        <Stat label="Open pos"     value={String(r.openPositions)} />
        <Stat label="Updated"      value={fmtTime(r.lastUpdated)} />
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Pill label={r.circuitBreakerActive ? "CIRCUIT BREAKER" : "CB OFF"} ok={!r.circuitBreakerActive} />
        <Pill label={r.killSwitchActive ? "KILL SWITCH ON" : "KS OFF"}      ok={!r.killSwitchActive} />
        {r.killSwitchActive
          ? <button disabled={busy} onClick={onUnkill}
              className="ml-2 px-3 py-1.5 rounded text-[12px] font-semibold bg-tv-green-dim text-tv-green border border-tv-green/30 hover:bg-tv-green hover:text-white transition disabled:opacity-50">
              Deactivate Kill
            </button>
          : <button disabled={busy} onClick={onKill}
              className="ml-2 px-3 py-1.5 rounded text-[12px] font-semibold bg-tv-red-dim text-tv-red border border-tv-red/30 hover:bg-tv-red hover:text-white transition disabled:opacity-50">
              ⚠ Kill Switch
            </button>
        }
      </div>
    </Card>
  );
}

// ── Open positions ─────────────────────────────────────────────────────────────
function OpenPositions({ positions }: { positions: Position[] }) {
  const totalUnrealized = positions.reduce((s, p) => s + (p.unrealizedPnlUsdt ?? 0), 0);
  return (
    <Card title={`Open Positions (${positions.length})`}
      action={positions.length > 0 ? (
        <span className={cn("text-[12px] font-mono font-bold", pnlCls(totalUnrealized))}>
          Unrealized: {totalUnrealized >= 0 ? "+" : ""}{totalUnrealized.toFixed(2)} USDT
        </span>
      ) : undefined}
    >
      {positions.length === 0
        ? <div className="text-tv-text3 text-[12px] italic py-2">No open positions</div>
        : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[11px] text-tv-text3 border-b border-tv-border">
                  {["Symbol","Dir","Entry","SL","TP","Size $","Unreal. P&L","Score","BE","Age"].map(h => (
                    <th key={h} className={cn("pb-1.5 font-semibold uppercase tracking-wide", h === "Symbol" || h === "Dir" ? "text-left pr-3" : "text-right pr-3 last:pr-0")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {positions.map(p => {
                  const uPnl = p.unrealizedPnlUsdt ?? 0;
                  const uPct = p.unrealizedPct ?? 0;
                  return (
                    <tr key={p.id} className={cn(
                      "border-b border-tv-border2 hover:bg-tv-hover transition text-[12px]",
                      uPnl > 0 ? "bg-tv-green-dim/30" : uPnl < 0 ? "bg-tv-red-dim/30" : ""
                    )}>
                      <td className="py-1.5 pr-3 font-bold text-tv-text">{p.symbol.replace("-USDT","")}</td>
                      <td className={cn("py-1.5 pr-3 font-bold", dirCls(p.direction))}>{p.direction}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-tv-text">{fmtPrice(p.entryPrice)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-tv-red">{fmtPrice(p.stopLossPrice)}</td>
                      <td className={cn("py-1.5 pr-3 text-right font-mono", p.tp1Hit ? "text-tv-green line-through opacity-60" : "text-tv-amber")}>{fmtPrice(p.tp1Price)}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-tv-text">{fmt2(p.size)}</td>
                      <td className={cn("py-1.5 pr-3 text-right font-mono font-bold", pnlCls(uPnl))}>
                        {uPnl !== 0 ? `${uPnl >= 0 ? "+" : ""}${uPnl.toFixed(2)}` : "—"}
                        {uPct !== 0 && <span className="text-[10px] ml-1 font-normal opacity-70">({uPct >= 0 ? "+" : ""}{uPct.toFixed(2)}%)</span>}
                      </td>
                      <td className={cn("py-1.5 pr-3 text-right font-mono font-bold", scoreCls(p.signalScore, 3))}>{p.signalScore}/3</td>
                      <td className="py-1.5 pr-3 text-right">{p.tp1Hit ? <span className="badge bg-tv-green-dim text-tv-green text-[10px]">BE</span> : "—"}</td>
                      <td className="py-1.5 text-right font-mono text-tv-text2">{fmtAge(p.entryTime)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      }
    </Card>
  );
}

// ── Active signals ─────────────────────────────────────────────────────────────
function ActiveSignals({ signals, blocked }: { signals: BreakoutSignal[]; blocked: number }) {
  const title = signals.length > 0
    ? `Active Signals (${signals.length})`
    : blocked > 0
      ? `Active Signals (0 — ${blocked} blocked)`
      : "Active Signals (0)";
  return (
    <Card title={title}>
      {signals.length === 0
        ? (
          <div className="text-tv-text3 text-[12px] italic py-2">
            {blocked > 0
              ? `${blocked} breakout${blocked > 1 ? "s" : ""} detected but filtered by score gate (RSI overbought / low volume) — waiting for better setup`
              : "No breakout patterns detected — market inside Bollinger Bands"}
          </div>
        )
        : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {signals.slice(0, 10).map((s, i) => <SignalCard key={i} s={s} />)}
          </div>
        )
      }
    </Card>
  );
}

function SignalCard({ s }: { s: BreakoutSignal }) {
  const isBuy = s.direction === "BUY";
  return (
    <div className={cn(
      "border rounded-lg p-2.5",
      isBuy ? "border-tv-green/30 bg-tv-green-dim" : "border-tv-red/30 bg-tv-red-dim"
    )}>
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold text-tv-text text-[13px]">{s.symbol.replace("-USDT","")}</span>
        <span className={cn("text-[13px] font-black", dirCls(s.direction))}>{s.direction}</span>
        <span className={cn("font-bold text-[11px] font-mono", scoreCls(s.score, s.maxScore))}>{s.score}/{s.maxScore}</span>
      </div>
      <div className="text-[11px] text-tv-text2 mb-1">{s.timeframe} · @{fmtPrice(s.entryPrice)}</div>
      <div className="text-[11px] text-tv-text3 space-y-0.5">
        {s.reasons.map((r, i) => <div key={i}>· {r}</div>)}
      </div>
      <div className="flex gap-3 mt-1 text-[11px] text-tv-text3 font-mono">
        <span>OB {(s.obImbalance * 100).toFixed(0)}%</span>
        <span>ATR {fmtPrice(s.atr)}</span>
        {s.bbSqueeze && <span className="text-tv-purple font-bold">SQZ</span>}
      </div>
    </div>
  );
}

// ── Performance metrics panel ──────────────────────────────────────────────────
function PerformancePanel({ trades }: { trades: Position[] }) {
  const closed = trades.filter(p => p.state === "CLOSED" && p.pnlUsdt != null);
  if (closed.length === 0) {
    return (
      <Card title="Performance Metrics">
        <div className="text-tv-text3 text-[12px] italic py-1">No closed trades yet</div>
      </Card>
    );
  }

  const wins   = closed.filter(p => (p.pnlUsdt ?? 0) > 0);
  const losses = closed.filter(p => (p.pnlUsdt ?? 0) <= 0);
  const grossWin  = wins.reduce((s, p)   => s + (p.pnlUsdt ?? 0), 0);
  const grossLoss = losses.reduce((s, p) => s + Math.abs(p.pnlUsdt ?? 0), 0);
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;
  const avgWin  = wins.length   > 0 ? grossWin   / wins.length   : 0;
  const avgLoss = losses.length > 0 ? grossLoss / losses.length : 0;
  const rrRatio = avgLoss > 0 ? avgWin / avgLoss : 0;
  const winRate = (wins.length / closed.length) * 100;
  const expectancy = winRate / 100 * avgWin - (1 - winRate / 100) * avgLoss;
  const best  = closed.reduce((b, p) => (p.pnlUsdt ?? 0) > (b.pnlUsdt ?? 0) ? p : b, closed[0]);
  const worst = closed.reduce((b, p) => (p.pnlUsdt ?? 0) < (b.pnlUsdt ?? 0) ? p : b, closed[0]);

  // Current streak
  let streak = 0; let streakType: "W" | "L" | "—" = "—";
  for (let i = closed.length - 1; i >= 0; i--) {
    const w = (closed[i].pnlUsdt ?? 0) > 0;
    if (streak === 0) { streakType = w ? "W" : "L"; streak = 1; }
    else if ((w && streakType === "W") || (!w && streakType === "L")) streak++;
    else break;
  }

  // Heitkoetter benchmark colour coding
  const pfOk  = profitFactor >= 1.3 && profitFactor <= 2.5;
  const pfWarn = profitFactor > 2.5;
  const wrOk  = winRate >= 60 && winRate <= 80;
  const wrWarn = winRate > 80;

  return (
    <Card title="Performance Metrics">
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-3">
        <Stat label="Trades"       value={String(closed.length)} />
        <Stat label="Win Rate"     value={`${winRate.toFixed(1)}%`}
          cls={wrWarn ? "text-tv-amber" : wrOk ? "text-tv-green" : "text-tv-red"} />
        <Stat label="Profit Factor"
          value={isFinite(profitFactor) ? profitFactor.toFixed(2) : "∞"}
          cls={pfWarn ? "text-tv-amber" : pfOk ? "text-tv-green" : "text-tv-red"} />
        <Stat label="Expectancy $" value={`${expectancy >= 0 ? "+" : ""}${expectancy.toFixed(2)}`}
          cls={pnlCls(expectancy)} />
        <Stat label="Avg Winner"   value={`+${avgWin.toFixed(2)}`}   cls="text-tv-green" />
        <Stat label="Avg Loser"    value={`-${avgLoss.toFixed(2)}`}   cls="text-tv-red" />
        <Stat label="R:R Ratio"    value={rrRatio.toFixed(2)}
          cls={rrRatio >= 1.5 ? "text-tv-green" : rrRatio >= 1.0 ? "text-tv-amber" : "text-tv-red"} />
        <Stat label={`Streak (${streakType})`} value={String(streak)}
          cls={streakType === "W" ? "text-tv-green" : streakType === "L" ? "text-tv-red" : "text-tv-text3"} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-tv-border">
        <Stat label="Best Trade"  value={`+${fmt2(best.pnlUsdt)}`}  cls="text-tv-green" />
        <Stat label="Worst Trade" value={`${fmt2(worst.pnlUsdt)}`}  cls="text-tv-red" />
        <Stat label="Total Win $" value={`+${grossWin.toFixed(2)}`} cls="text-tv-green" />
        <Stat label="Total Loss $" value={`-${grossLoss.toFixed(2)}`} cls="text-tv-red" />
      </div>
      {/* Heitkoetter benchmark guide */}
      <div className="mt-2 text-[10px] text-tv-text3 flex gap-4 flex-wrap">
        <span>Heitkoetter benchmarks: PF 1.3–2.5 · WR 60–80% · above = curve-fit</span>
        {pfWarn && <span className="text-tv-amber font-bold">⚠ PF {profitFactor.toFixed(2)} &gt; 2.5 — possible curve-fit</span>}
        {wrWarn && <span className="text-tv-amber font-bold">⚠ WR {winRate.toFixed(1)}% &gt; 80% — possible curve-fit</span>}
      </div>
    </Card>
  );
}

// ── Trade log ──────────────────────────────────────────────────────────────────
function TradeLog({ trades }: { trades: Position[] }) {
  return (
    <Card title={`Trade Log (${trades.length})`}>
      {trades.length === 0
        ? <div className="text-tv-text3 text-[12px] italic py-2">No closed trades yet</div>
        : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="text-[11px] text-tv-text3 border-b border-tv-border">
                  {["Symbol","Dir","Entry","Exit","Net P&L $","Net %","Reason","Closed"].map(h => (
                    <th key={h} className={cn("pb-1.5 font-semibold uppercase tracking-wide",
                      h === "Symbol" || h === "Dir" || h === "Reason" ? "text-left pr-3" : "text-right pr-3 last:pr-0")}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {trades.slice(0, 50).map(p => (
                  <tr key={p.id} className="border-b border-tv-border2 hover:bg-tv-hover transition text-[12px]">
                    <td className="py-1.5 pr-3 font-bold text-tv-text">{p.symbol.replace("-USDT","")}</td>
                    <td className={cn("py-1.5 pr-3 font-bold", dirCls(p.direction))}>{p.direction}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-tv-text">{fmtPrice(p.entryPrice)}</td>
                    <td className="py-1.5 pr-3 text-right font-mono text-tv-text">{fmtPrice(p.exitPrice)}</td>
                    <td className={cn("py-1.5 pr-3 text-right font-mono font-bold", pnlCls(p.pnlUsdt ?? 0))}>{fmtSign(p.pnlUsdt)}</td>
                    <td className={cn("py-1.5 pr-3 text-right font-mono", pnlCls(p.pnlPct ?? 0))}>{fmtPct(p.pnlPct)}</td>
                    <td className={cn("py-1.5 pr-3 text-[11px] font-bold",
                      p.exitReason === "TP1" || p.exitReason === "TP2" ? "text-tv-green" :
                      p.exitReason === "SL"          ? "text-tv-red"   :
                      p.exitReason === "TIME_STOP"   ? "text-tv-amber" :
                      p.exitReason === "KILL_SWITCH" ? "text-tv-red font-black" : "text-tv-text2"
                    )}>{p.exitReason}</td>
                    <td className="py-1.5 text-right font-mono text-tv-text2">{p.exitTime ? fmtTime(p.exitTime) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Card>
  );
}

// ── Settings modal ─────────────────────────────────────────────────────────────
function SettingsModal({ config, onClose, onSave, busy }: {
  config: TraderConfig | null;
  onClose: () => void;
  onSave: (patch: Partial<TraderConfig>) => Promise<void>;
  busy: boolean;
}) {
  const [activeTab, setActiveTab]       = useState<"api" | "params">("api");
  const [draft,     setDraft]           = useState<Partial<TraderConfig>>({});

  // ── API key state ──────────────────────────────────────────────────────────
  const [apiKey,        setApiKey]        = useState("");
  const [apiSecret,     setApiSecret]     = useState("");
  const [apiPassphrase, setApiPassphrase] = useState("");
  const [sandboxMode,   setSandboxMode]   = useState(false);
  const [apiSaving,     setApiSaving]     = useState(false);
  const [apiTesting,    setApiTesting]    = useState(false);
  const [apiStatus,     setApiStatus]     = useState<{ ok: boolean; msg: string } | null>(null);

  // Load stored credentials on modal open
  useEffect(() => {
    void fetch("/api/config")
      .then(r => r.json())
      .then((c: { apiKey?: string; apiSecret?: string; apiPassphrase?: string; sandboxMode?: boolean }) => {
        setApiKey(c.apiKey ?? "");
        setApiSecret(c.apiSecret ?? "");
        setApiPassphrase(c.apiPassphrase ?? "");
        setSandboxMode(c.sandboxMode ?? false);
      });
  }, []);

  async function saveApiKeys() {
    setApiSaving(true); setApiStatus(null);
    try {
      const res = await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey:        apiKey.trim(),
          apiSecret:     apiSecret.trim(),
          apiPassphrase: apiPassphrase.trim(),
          sandboxMode,
        }),
      });
      const j = await res.json() as { ok?: boolean; error?: string };
      if (j.ok) setApiStatus({ ok: true,  msg: "Tallennettu ✓" });
      else      setApiStatus({ ok: false, msg: j.error ?? "Tallennus epäonnistui" });
    } catch (e) { setApiStatus({ ok: false, msg: String(e) }); }
    finally { setApiSaving(false); }
  }

  async function testConnection() {
    setApiTesting(true); setApiStatus(null);
    try {
      // Save first so kucoinExec gets the latest keys, then test
      await fetch("/api/config", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey:        apiKey.trim(),
          apiSecret:     apiSecret.trim(),
          apiPassphrase: apiPassphrase.trim(),
          sandboxMode,
        }),
      });
      const res = await fetch("/api/config/test");
      const j   = await res.json() as { ok?: boolean; usdtBalance?: number; error?: string };
      if (j.ok) setApiStatus({ ok: true,  msg: `Yhteys OK ✓  USDT: $${j.usdtBalance?.toFixed(2) ?? "—"}` });
      else      setApiStatus({ ok: false, msg: j.error ?? "Yhteys epäonnistui" });
    } catch (e) { setApiStatus({ ok: false, msg: String(e) }); }
    finally { setApiTesting(false); }
  }

  // ── Param fields ───────────────────────────────────────────────────────────
  type Field = { key: keyof TraderConfig; label: string; min: number; max: number; step: number };
  const fields: Field[] = [
    { key: "feeRatePct",       label: "Exchange fee % / order", min: 0.0, max: 0.5, step: 0.01 },
    { key: "minScore",         label: "Min signal score",   min: 1,   max: 3,    step: 1    },
    { key: "maxSpreadPct",     label: "Max spread %",       min: 0.1, max: 2.0,  step: 0.05 },
    { key: "emaTrendFast",     label: "EMA fast period",    min: 3,   max: 20,   step: 1    },
    { key: "emaTrendSlow",     label: "EMA slow period",    min: 10,  max: 50,   step: 1    },
    { key: "rsiBullLo",        label: "RSI bull lo",        min: 40,  max: 70,   step: 1    },
    { key: "rsiBullHi",        label: "RSI bull hi",        min: 60,  max: 90,   step: 1    },
    { key: "rsiBearLo",        label: "RSI bear lo",        min: 10,  max: 40,   step: 1    },
    { key: "rsiBearHi",        label: "RSI bear hi",        min: 30,  max: 60,   step: 1    },
    { key: "slAtrMult",        label: "SL ATR mult",        min: 0.5, max: 4.0,  step: 0.1  },
    { key: "tpAtrMult",        label: "TP ATR mult",        min: 0.5, max: 6.0,  step: 0.1  },
    { key: "beBroughtAt",      label: "Break-even ATR",     min: 0.5, max: 3.0,  step: 0.1  },
    { key: "maxHoldMinutes",   label: "Max hold (min)",     min: 5,   max: 480,  step: 5    },
    { key: "riskPctPerTrade",  label: "Risk % / trade",     min: 0.1, max: 5.0,  step: 0.1  },
    { key: "dailyDrawdownPct", label: "Daily DD limit %",   min: 1.0, max: 20,   step: 0.5  },
    { key: "maxTradesPerDay",  label: "Max trades/day",     min: 1,   max: 50,   step: 1    },
    { key: "maxOpenPositions", label: "Max open positions", min: 1,   max: 10,   step: 1    },
    { key: "maxNotionalPct",      label: "Max notional %",        min: 5,   max: 50,  step: 1  },
    { key: "minTradeUsdt",        label: "Min trade USDT",        min: 5,   max: 100, step: 1  },
    { key: "confluenceMinScore",  label: "Bot7 confluence min score (0=off)", min: 0, max: 13, step: 1 },
  ];

  const inputCls = "border border-tv-border rounded px-2.5 py-1.5 text-[13px] font-mono bg-tv-bg2 focus:outline-none focus:border-tv-blue focus:ring-1 focus:ring-tv-blue/20 text-tv-text w-full";
  const tabCls   = (t: "api" | "params") =>
    cn("px-4 py-1.5 text-[13px] font-semibold rounded-t border-b-2 transition",
      activeTab === t
        ? "border-tv-blue text-tv-blue bg-tv-bg2"
        : "border-transparent text-tv-text2 hover:text-tv-text");

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white border border-tv-border rounded-xl shadow-lg w-full max-w-2xl mx-4 p-6 max-h-[90vh] overflow-y-auto"
        onClick={e => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-[15px] font-bold text-tv-text">⚙ Settings</h2>
          <button onClick={onClose} className="text-tv-text3 hover:text-tv-text text-xl leading-none">×</button>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b border-tv-border mb-5">
          <button className={tabCls("api")}    onClick={() => setActiveTab("api")}>API-avaimet</button>
          <button className={tabCls("params")} onClick={() => setActiveTab("params")}>Parametrit</button>
        </div>

        {/* ── API tab ──────────────────────────────────────────────────────── */}
        {activeTab === "api" && (
          <div className="flex flex-col gap-4">
            <div className="grid grid-cols-1 gap-3">

              {/* API Key */}
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-tv-text2 uppercase font-semibold tracking-wide flex items-center gap-2">
                  API Key
                  {apiKey.trim() ? <span className="text-tv-green text-[10px] normal-case font-normal">✓ Asetettu</span>
                                 : <span className="text-tv-red   text-[10px] normal-case font-normal">✗ Puuttuu</span>}
                </label>
                <input type="text" value={apiKey} placeholder="KuCoin API Key"
                  onChange={e => { setApiKey(e.target.value); setApiStatus(null); }}
                  className={inputCls} autoComplete="off" />
              </div>

              {/* API Secret */}
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-tv-text2 uppercase font-semibold tracking-wide flex items-center gap-2">
                  API Secret
                  {apiSecret.trim() ? <span className="text-tv-green text-[10px] normal-case font-normal">✓ Asetettu</span>
                                    : <span className="text-tv-red   text-[10px] normal-case font-normal">✗ Puuttuu</span>}
                </label>
                <input type="password" value={apiSecret} placeholder="API Secret"
                  onChange={e => { setApiSecret(e.target.value); setApiStatus(null); }}
                  className={inputCls} autoComplete="new-password" />
              </div>

              {/* Passphrase */}
              <div className="flex flex-col gap-1">
                <label className="text-[11px] text-tv-text2 uppercase font-semibold tracking-wide flex items-center gap-2">
                  API Passphrase
                  {apiPassphrase.trim() ? <span className="text-tv-green text-[10px] normal-case font-normal">✓ Asetettu</span>
                                        : <span className="text-tv-red   text-[10px] normal-case font-normal">✗ Puuttuu</span>}
                </label>
                <input type="password" value={apiPassphrase} placeholder="API Passphrase"
                  onChange={e => { setApiPassphrase(e.target.value); setApiStatus(null); }}
                  className={inputCls} autoComplete="new-password" />
              </div>

              {/* Sandbox toggle */}
              <div className="flex items-center gap-3 py-1">
                <label className="text-[13px] text-tv-text font-semibold cursor-pointer select-none flex items-center gap-2">
                  <input type="checkbox" checked={sandboxMode} onChange={e => setSandboxMode(e.target.checked)}
                    className="w-4 h-4 rounded accent-tv-amber" />
                  Sandbox-moodi
                </label>
                {sandboxMode && (
                  <span className="text-[11px] text-tv-amber font-semibold bg-tv-amber-dim px-2 py-0.5 rounded border border-tv-amber/30">
                    ⚠ Sandbox — ei oikeaa kaupankäyntiä
                  </span>
                )}
              </div>
            </div>

            {/* Status message */}
            {apiStatus && (
              <div className={cn("px-3 py-2 rounded text-[13px] font-semibold border",
                apiStatus.ok
                  ? "bg-tv-green-dim text-tv-green border-tv-green/30"
                  : "bg-tv-red-dim text-tv-red border-tv-red/30")}>
                {apiStatus.msg}
              </div>
            )}

            {/* Info box */}
            <div className="text-[11px] text-tv-text3 bg-tv-bg2 border border-tv-border rounded px-3 py-2 leading-relaxed">
              Avaimet tallennetaan palvelimelle <code className="font-mono">data/api-config.json</code> — ei git-hakemistoon.
              Tarvitset KuCoin-avaimelta: Trade-oikeus. Osoite <code className="font-mono">192.168.1.30</code> IP-rajoitukseen.
            </div>

            {/* Buttons */}
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-tv-border">
              <button onClick={onClose} className="px-4 py-1.5 text-[13px] text-tv-text2 hover:text-tv-text transition">
                Peruuta
              </button>
              <button
                disabled={apiTesting || apiSaving}
                onClick={() => void testConnection()}
                className="px-4 py-1.5 text-[13px] font-semibold border border-tv-blue text-tv-blue rounded hover:bg-tv-blue hover:text-white transition disabled:opacity-50">
                {apiTesting ? "Testataan…" : "Testaa yhteys"}
              </button>
              <button
                disabled={apiSaving || apiTesting}
                onClick={() => void saveApiKeys()}
                className="px-5 py-1.5 text-[13px] font-semibold bg-tv-blue text-white rounded hover:opacity-90 transition disabled:opacity-50">
                {apiSaving ? "Tallennetaan…" : "Tallenna avaimet"}
              </button>
            </div>
          </div>
        )}

        {/* ── Params tab ────────────────────────────────────────────────────── */}
        {activeTab === "params" && (
          <>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {config ? fields.map(f => {
                const val = f.key in draft ? (draft[f.key] as number) : (config[f.key] as number);
                return (
                  <div key={f.key} className="flex flex-col gap-1">
                    <label className="text-[11px] text-tv-text2 uppercase font-semibold tracking-wide">{f.label}</label>
                    <input
                      type="number" min={f.min} max={f.max} step={f.step} value={val}
                      onChange={e => setDraft(d => ({ ...d, [f.key]: parseFloat(e.target.value) }))}
                      className={inputCls}
                    />
                  </div>
                );
              }) : (
                <div className="col-span-3 text-tv-text3 text-[13px] italic py-4">Ladataan parametrejä…</div>
              )}
            </div>

            <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t border-tv-border">
              <button onClick={onClose} className="px-4 py-1.5 text-[13px] text-tv-text2 hover:text-tv-text transition">
                Peruuta
              </button>
              <button
                disabled={busy || Object.keys(draft).length === 0 || !config}
                onClick={() => void onSave(draft)}
                className="px-5 py-1.5 text-[13px] font-semibold bg-tv-blue text-white rounded hover:opacity-90 transition disabled:opacity-50">
                {busy ? "Sovelletaan…" : "Käytä muutokset"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Wallet panel ──────────────────────────────────────────────────────────────
function WalletPanel({ wallet, mode }: { wallet: WalletState; mode: string }) {
  const hasData = wallet.lastUpdated > 0;
  const isLive  = mode === "LIVE";

  return (
    <Card title={`Wallet${isLive ? " · Live KuCoin" : " · Virtual"}`}>
      {!hasData ? (
        <div className="text-tv-text3 text-[12px] italic py-2">Wallet data not yet available</div>
      ) : (
        <>
          {/* Summary row */}
          <div className="grid grid-cols-3 gap-4 mb-3 pb-3 border-b border-tv-border">
            <Stat label="Total value"  value={`$${wallet.totalUsdt.toFixed(2)}`} />
            <Stat label="USDT free"    value={`$${wallet.usdtFree.toFixed(2)}`}   cls="text-tv-green" />
            <Stat label="USDT locked"  value={`$${wallet.usdtLocked.toFixed(2)}`} cls={wallet.usdtLocked > 0 ? "text-tv-amber" : "text-tv-text"} />
          </div>

          {/* Per-currency rows */}
          {wallet.entries.length === 0 ? (
            <div className="text-tv-text3 text-[12px] italic">No holdings</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead>
                  <tr className="text-[11px] text-tv-text3 border-b border-tv-border">
                    {["Currency", "Balance", "Price", "Value (USDT)", "Status"].map(h => (
                      <th key={h} className={cn(
                        "pb-1.5 font-semibold uppercase tracking-wide",
                        h === "Currency" || h === "Status" ? "text-left pr-3" : "text-right pr-3 last:pr-0"
                      )}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {wallet.entries.map((e, i) => (
                    <tr key={i} className="border-b border-tv-border2 hover:bg-tv-hover transition text-[12px]">
                      <td className="py-1.5 pr-3 font-bold text-tv-text">{e.currency}</td>
                      <td className="py-1.5 pr-3 text-right font-mono text-tv-text">
                        {e.currency === "USDT" ? e.balance.toFixed(2) : e.balance.toFixed(6)}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono text-tv-text2">
                        {e.priceUsdt != null ? `$${fmtPrice(e.priceUsdt)}` : "—"}
                      </td>
                      <td className={cn("py-1.5 pr-3 text-right font-mono font-bold", e.valueUsdt > 0 ? "text-tv-text" : "text-tv-text3")}>
                        ${e.valueUsdt.toFixed(2)}
                      </td>
                      <td className="py-1.5 text-left">
                        {e.inOpenPos
                          ? <span className="badge bg-tv-amber-dim text-tv-amber border border-tv-amber/30 text-[10px]">Locked</span>
                          : <span className="badge bg-tv-green-dim text-tv-green border border-tv-green/30 text-[10px]">Free</span>
                        }
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-2 text-[10px] text-tv-text3 text-right">
            {isLive ? "Live KuCoin balance" : "Virtual balance (paper trading)"} · updated {fmtTime(wallet.lastUpdated)}
          </div>
        </>
      )}
    </Card>
  );
}

// ── Activity feed — shows entries AND exits in chronological order ─────────────
function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  if (events.length === 0) {
    return (
      <Card title="Activity Feed — Entries & Exits">
        <div className="text-tv-text3 text-[12px] italic py-2">No activity yet — entries and exits will appear here</div>
      </Card>
    );
  }
  return (
    <Card title={`Activity Feed (${events.length})`}>
      <div className="space-y-0.5 max-h-72 overflow-y-auto pr-1">
        {events.map((e, i) => {
          const isEntry  = e.type === "ENTERED";
          const isBuy    = e.direction === "BUY";
          const entryBg  = isBuy ? "bg-tv-green-dim border-tv-green/20" : "bg-tv-red-dim border-tv-red/20";
          const exitBg   = (e.netPnl ?? 0) >= 0 ? "bg-tv-green-dim border-tv-green/20" : "bg-tv-red-dim border-tv-red/20";
          const rowBg    = isEntry ? entryBg : exitBg;

          return (
            <div key={i} className={cn("flex items-center gap-3 px-2.5 py-1.5 rounded border text-[12px]", rowBg)}>
              {/* Time */}
              <span className="text-tv-text3 font-mono text-[11px] w-16 flex-shrink-0">
                {fmtTime(e.time)}
              </span>

              {/* Event type badge */}
              {isEntry ? (
                <span className={cn("font-bold text-[11px] w-16 flex-shrink-0", isBuy ? "text-tv-green" : "text-tv-red")}>
                  ▶ {e.direction}
                </span>
              ) : (
                <span className={cn("font-bold text-[11px] w-16 flex-shrink-0",
                  e.exitReason === "TP1" || e.exitReason === "TP2" ? "text-tv-green" :
                  e.exitReason === "SL"        ? "text-tv-red" :
                  e.exitReason === "TIME_STOP" ? "text-tv-amber" : "text-tv-text2"
                )}>
                  ◀ {e.exitReason}
                </span>
              )}

              {/* Symbol */}
              <span className="font-bold text-tv-text w-16 flex-shrink-0">
                {e.symbol.replace("-USDT", "")}
              </span>

              {/* Price */}
              <span className="font-mono text-tv-text2 w-20 flex-shrink-0">
                @{fmtPrice(e.price)}
              </span>

              {/* Size */}
              <span className="font-mono text-tv-text3 text-[11px] w-16 flex-shrink-0">
                ${fmt2(e.sizeUsdt)}
              </span>

              {/* P&L (exits only) */}
              {!isEntry && e.netPnl != null && (
                <span className={cn("font-mono font-bold ml-auto flex-shrink-0", pnlCls(e.netPnl))}>
                  {e.netPnl >= 0 ? "+" : ""}{e.netPnl.toFixed(2)} USDT
                  {e.feesUsdt != null && (
                    <span className="text-tv-text3 font-normal text-[10px] ml-1">
                      (fee −{e.feesUsdt.toFixed(2)})
                    </span>
                  )}
                </span>
              )}

              {/* Entry: show score / direction indicator */}
              {isEntry && (
                <span className="text-tv-text3 font-mono text-[10px] ml-auto flex-shrink-0">
                  ${fmt2(e.sizeUsdt)} notional
                </span>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Top bar ────────────────────────────────────────────────────────────────────
function TopBar({ ts, mode, simActive, busy, riskState, onStartSim, onStopSim, onStartLive, onStopLive, onOpenSettings }: {
  ts: number; mode: string; simActive: boolean; busy: boolean;
  riskState?: { dailyPnlUsdt: number; dailyPnlPct: number; killSwitchActive: boolean; circuitBreakerActive: boolean };
  onStartSim: () => void; onStopSim: () => void;
  onStartLive: () => void; onStopLive: () => void;
  onOpenSettings: () => void;
}) {
  const buildRaw  = process.env.NEXT_PUBLIC_BUILD_TIME;
  const buildName = process.env.NEXT_PUBLIC_APP_NAME ?? "Day Trader · v7";
  const buildLabel = buildRaw ? (() => {
    const d = new Date(buildRaw);
    return `${buildName} · ${String(d.getDate()).padStart(2,"0")}.${String(d.getMonth()+1).padStart(2,"0")} ${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`;
  })() : buildName;

  return (
    <div className="h-[44px] flex-shrink-0 flex items-center gap-3 px-4 bg-white border-b border-tv-border flex-wrap">

      {/* Logo + stamp */}
      <div className="flex items-center gap-2 select-none">
        <div className="w-6 h-6 rounded bg-tv-green-dim flex items-center justify-center">
          <svg viewBox="0 0 16 16" className="w-3.5 h-3.5 text-tv-green fill-current">
            <path d="M8 1L1 14h14L8 1z" />
          </svg>
        </div>
        <div className="flex flex-col leading-none">
          <span className="text-[13px] font-bold text-tv-text tracking-tight">Day-Trader Bot C</span>
          <span className="text-[9px] text-tv-text3 font-mono">{buildLabel}</span>
        </div>
      </div>

      <div className="h-4 w-px bg-tv-border" />
      <ModeBadge mode={mode} />
      <div className="h-4 w-px bg-tv-border" />

      {/* Control buttons */}
      <div className="flex items-center gap-1.5">
        {simActive
          ? <button disabled={busy} onClick={onStopSim}
              className="px-3 py-1 text-[12px] font-semibold rounded border bg-tv-blue-dim text-tv-blue border-tv-blue/30 hover:bg-tv-blue hover:text-white transition disabled:opacity-50">
              ◼ Stop Sim
            </button>
          : <button disabled={busy || mode === "LIVE"} onClick={onStartSim}
              className="px-3 py-1 text-[12px] font-semibold rounded border bg-tv-bg2 text-tv-text2 border-tv-border hover:bg-tv-bg3 hover:text-tv-text transition disabled:opacity-50"
              title={mode === "LIVE" ? "Stop live trading first" : "Paper-trade with virtual $1000"}>
              ▶ Simulation
            </button>
        }

        {mode === "LIVE"
          ? <button disabled={busy} onClick={onStopLive}
              className="px-3 py-1 text-[12px] font-semibold rounded border bg-tv-red-dim text-tv-red border-tv-red/30 hover:bg-tv-red hover:text-white transition disabled:opacity-50">
              ◼ Stop Live
            </button>
          : <button disabled={busy || simActive} onClick={onStartLive}
              className="px-3 py-1 text-[12px] font-semibold rounded border bg-tv-green text-white border-tv-green hover:opacity-90 transition disabled:opacity-50"
              title={simActive ? "Stop simulation first" : "Trade with real KuCoin USDT"}>
              ● Go Live
            </button>
        }

        <button onClick={onOpenSettings}
          className="px-2.5 py-1 text-[13px] text-tv-text2 hover:text-tv-text hover:bg-tv-bg3 rounded transition"
          title="Settings">
          ⚙
        </button>
      </div>

      <div className="flex-1" />

      {/* Session P&L — visible at a glance */}
      {riskState && (riskState.dailyPnlUsdt !== 0 || riskState.dailyPnlPct !== 0) && (
        <div className={cn(
          "flex items-center gap-1.5 px-2.5 py-1 rounded text-[12px] font-mono font-bold border",
          riskState.dailyPnlUsdt >= 0
            ? "bg-tv-green-dim text-tv-green border-tv-green/30"
            : "bg-tv-red-dim text-tv-red border-tv-red/30"
        )}>
          <span className="text-[10px] font-normal text-tv-text3 uppercase tracking-wide mr-0.5">Day P&L</span>
          {riskState.dailyPnlUsdt >= 0 ? "+" : ""}{riskState.dailyPnlUsdt.toFixed(2)} USDT
          <span className="text-[10px] opacity-70">({fmtPct(riskState.dailyPnlPct)})</span>
        </div>
      )}

      {/* Kill switch / circuit breaker warning */}
      {riskState?.killSwitchActive && (
        <span className="badge bg-tv-red text-white text-[11px] font-black animate-pulse px-2">⛔ KILL SWITCH</span>
      )}
      {riskState?.circuitBreakerActive && !riskState.killSwitchActive && (
        <span className="badge bg-tv-amber-dim text-tv-amber border border-tv-amber/50 text-[11px] font-bold">⚠ CIRCUIT BREAKER</span>
      )}

      {/* Timestamp */}
      <div className="flex items-center gap-1 text-tv-text2 text-[11px]">
        <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round"/>
          <path d="M13.5 2.5v3h-3" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        {ts > 0 ? fmtTime(ts) : "…"}
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────
export default function DayTraderPage() {
  const [data,         setData]         = useState<DashboardState | null>(null);
  const [err,          setErr]          = useState<string | null>(null);
  const [busy,         setBusy]         = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [config,       setConfig]       = useState<TraderConfig | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch("/api/dashboard");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData(await res.json() as DashboardState);
      setErr(null);
    } catch (e) { setErr(String(e)); }
  }, []);

  useEffect(() => {
    void poll();
    timerRef.current = setInterval(() => void poll(), POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [poll]);

  useEffect(() => {
    if (!showSettings) return;
    void fetch("/api/settings").then(r => r.json()).then(c => setConfig(c as TraderConfig));
  }, [showSettings]);

  async function postAction(action: string, extra?: Record<string, unknown>) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/trading", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...extra }),
      });
      const j = await res.json() as { ok?: boolean; error?: string };
      if (!j.ok) setErr(j.error ?? "Unknown error");
      else await poll();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  async function saveSettings(patch: Partial<TraderConfig>) {
    setBusy(true); setErr(null);
    try {
      const res = await fetch("/api/settings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const j = await res.json() as { ok?: boolean; config?: TraderConfig; error?: string };
      if (j.config) setConfig(j.config);
      if (!j.ok) setErr(j.error ?? "Save failed");
      else setShowSettings(false);
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  }

  const mode      = data?.mode             ?? "DRY";
  const simActive = data?.simulation?.active ?? false;

  return (
    <div className="min-h-screen bg-tv-bg flex flex-col">
      <TopBar
        ts={data?.timestamp ?? 0}
        mode={mode}
        simActive={simActive}
        busy={busy}
        riskState={data?.riskState}
        onStartSim={() => void postAction("start_sim", { startEquity: 1000 })}
        onStopSim={() => void postAction("stop_sim")}
        onStartLive={() => void postAction("start_live")}
        onStopLive={() => void postAction("stop_live")}
        onOpenSettings={() => setShowSettings(true)}
      />

      {data?.simulation && <SimBanner sim={data.simulation} />}

      {err && (
        <div className="mx-4 mt-2 px-4 py-2 bg-tv-red-dim border border-tv-red/30 rounded-lg text-tv-red text-[12px] flex items-center justify-between">
          <span>{err}</span>
          <button onClick={() => setErr(null)} className="ml-3 text-tv-red/60 hover:text-tv-red">×</button>
        </div>
      )}

      <main className="flex-1 p-4 flex flex-col gap-3 max-w-screen-2xl mx-auto w-full">
        {/* Row 1: producer + risk side by side */}
        {data && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            <ProducerPanel h={data.producerHealth} bot7AgeMs={data.bot7SignalsAgeMs ?? -1} confluenceMin={config?.confluenceMinScore ?? 0} />
            <RiskPanel
              r={data.riskState} busy={busy}
              onKill={() => !busy && void postAction("kill")}
              onUnkill={() => !busy && void postAction("unkill")}
            />
          </div>
        )}

        {/* Row 2: Cumulative P&L chart */}
        {data && <PnlChart trades={data.recentTrades} />}

        {/* Row 3: wallet */}
        {data?.wallet && <WalletPanel wallet={data.wallet} mode={mode} />}

        {/* Row 4: signals + open positions */}
        {data && (
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 items-start">
            <ActiveSignals signals={data.activeSignals} blocked={data.blockedSignals ?? 0} />
            <OpenPositions positions={data.openPositions} />
          </div>
        )}

        {/* Row 5: activity feed (entries + exits in one place) */}
        {data && <ActivityFeed events={data.activityLog ?? []} />}

        {/* Row 6: performance metrics (profit factor, win rate, R:R, streak) */}
        {data && <PerformancePanel trades={data.recentTrades} />}

        {/* Row 7: full trade log (closed round-trips with net P&L) */}
        {data && <TradeLog trades={data.recentTrades} />}

        {!data && !err && (
          <div className="text-tv-text3 text-sm text-center mt-24">Connecting…</div>
        )}
      </main>

      {showSettings && (
        <SettingsModal config={config} onClose={() => setShowSettings(false)} onSave={saveSettings} busy={busy} />
      )}
    </div>
  );
}
