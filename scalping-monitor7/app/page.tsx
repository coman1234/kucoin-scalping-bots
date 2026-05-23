"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { generateSignal, generateHumanAdvice, type SignalResult } from "@/lib/signalEngine";
import type { KuCoinCandle } from "@/lib/kucoinPublic";
import { format } from "date-fns";
import { useMonitorContext } from "@/lib/monitorContext";
import SettingsModal from "@/components/SettingsModal";

// ── Timing constants ──────────────────────────────────────────────────────────
const CANDLE_REFRESH_SEC  = 15;   // full candle + signal recompute for selected pair
const PRICE_POLL_SEC      = 5;    // lightweight price-only update for selected pair
const SCAN_PAIR_DELAY_MS  = 200;  // ms between each pair in continuous scan loop

const TIMEFRAMES = ["1min","3min","5min","15min","30min","1hour","4hour"];

const WATCH_PAIRS = [
  "BTC-USDT","ETH-USDT","SOL-USDT","XRP-USDT","BNB-USDT",
  "DOGE-USDT","ADA-USDT","AVAX-USDT","LINK-USDT","DOT-USDT",
  "POL-USDT","UNI-USDT","LTC-USDT","ATOM-USDT","ARB-USDT",
  "NEAR-USDT","APT-USDT","OP-USDT","TRX-USDT","INJ-USDT",
];

interface LogEntry { time: number; symbol: string; tf: string; signal: SignalResult; }
interface PairSignal {
  signal: SignalResult | null;
  loading: boolean;
  updatedAt: number;
  prevDirection?: "BUY" | "SELL" | "NEUTRAL";
  changedAt?: number;   // ms timestamp when direction last changed
}

// Direction → sort weight (higher = shown first)
function dirWeight(p: PairSignal): number {
  if (!p.signal) return 0;
  const s = p.signal.score;
  const d = p.signal.direction;
  if (d === "BUY")  return 1000 + s;
  if (d === "SELL") return 500  + s;
  return 200;
}

function cn(...classes: (string | false | undefined | null)[]) {
  return classes.filter(Boolean).join(" ");
}

// ── Build stamp ───────────────────────────────────────────────────────────────
function BuildStamp() {
  const raw  = process.env.NEXT_PUBLIC_BUILD_TIME;
  const name = process.env.NEXT_PUBLIC_APP_NAME ?? "Monitor";
  const label = raw
    ? (() => {
        const d   = new Date(raw);
        const dd  = String(d.getDate()).padStart(2, "0");
        const mm  = String(d.getMonth() + 1).padStart(2, "0");
        const hh  = String(d.getHours()).padStart(2, "0");
        const min = String(d.getMinutes()).padStart(2, "0");
        return `${name} · ${dd}.${mm} ${hh}:${min}`;
      })()
    : name;
  return <span className="text-[9px] text-text2">{label}</span>;
}

// ── Mini signal card ──────────────────────────────────────────────────────────
function MiniSignalCard({ sym, data, selected, onClick, language }: {
  sym: string; data: PairSignal; selected: boolean; onClick: () => void; language: "fi" | "en";
}) {
  const dir   = data.signal?.direction ?? "NEUTRAL";
  const score = data.signal?.score ?? 0;
  const label = data.signal?.label ?? "";
  const name  = sym.replace("-USDT", "");
  const isFi  = language === "fi";
  const isStrong = label === "STRONG BUY" || label === "STRONG SELL";

  // Was signal direction recently changed? Flash for 4s
  const justChanged = data.changedAt && (Date.now() - data.changedAt < 4000);

  const displayLabel = isFi
    ? label === "STRONG BUY"  ? "Vahva osto"   :
      label === "WEAK BUY"    ? "Heikko osto"  :
      label === "STRONG SELL" ? "Vahva myynti" :
      label === "WEAK SELL"   ? "Heikko myynti":
      label === "NEUTRAL"     ? "Neutraali"    : label
    : label === "STRONG BUY"  ? "Strong Buy"   :
      label === "WEAK BUY"    ? "Weak Buy"     :
      label === "STRONG SELL" ? "Strong Sell"  :
      label === "WEAK SELL"   ? "Weak Sell"    :
      label === "NEUTRAL"     ? "Neutral"      : label;

  const displayDir = isFi
    ? dir === "BUY"  ? "OSTO" : dir === "SELL" ? "MYYNTI" : "NEUTR."
    : dir === "BUY"  ? "BUY"  : dir === "SELL" ? "SELL"   : "NEUTRAL";

  const bg = dir === "BUY"  ? "bg-green-dim border-green/40" :
             dir === "SELL" ? "bg-red-dim border-red/40"     : "bg-bg2 border-border";
  const dirColor = dir === "BUY" ? "text-green" : dir === "SELL" ? "text-red" : "text-text2";
  const ringClass = selected
    ? "ring-2 ring-blue"
    : justChanged
    ? (dir === "BUY" ? "ring-2 ring-green animate-pulse" : dir === "SELL" ? "ring-2 ring-red animate-pulse" : "")
    : "";

  // Age of signal
  const ageSec = data.updatedAt ? Math.floor((Date.now() - data.updatedAt) / 1000) : null;

  return (
    <button onClick={onClick}
      className={cn(
        "rounded border px-1.5 py-1 text-center transition-all hover:opacity-90 w-full relative",
        bg, ringClass
      )}>
      {isStrong && (
        <div className={cn(
          "absolute -top-1 -right-1 w-2 h-2 rounded-full",
          dir === "BUY" ? "bg-green animate-pulse" : "bg-red animate-pulse"
        )} />
      )}
      <div className="text-[10px] font-bold text-text tracking-wide leading-none">{name}</div>
      {data.loading && !data.signal ? (
        <div className="text-[9px] text-text3 animate-pulse">{isFi ? "…" : "…"}</div>
      ) : (
        <>
          <div className={`text-xs font-black tracking-wider leading-tight mt-0.5 ${dirColor}`}>{displayDir}</div>
          <div className="text-[9px] text-text2 leading-none">{score}/{data.signal?.maxScore ?? 13}</div>
        </>
      )}
    </button>
  );
}

// ── Progress bar countdown ────────────────────────────────────────────────────
function CountdownBar({ current, total, label, color = "bg-blue" }: {
  current: number; total: number; label: string; color?: string;
}) {
  const pct = Math.max(0, Math.min(100, (current / total) * 100));
  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <span className="text-[10px] text-text3 whitespace-nowrap">{label} {current}s</span>
      <div className="flex-1 h-1 bg-bg3 rounded-full overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Gauge bar ─────────────────────────────────────────────────────────────────
function Bar({ value, min, max, low, high, label, fmt }: {
  value: number; min: number; max: number;
  low?: number; high?: number;
  label: string; fmt: (v: number) => string;
}) {
  const pct = Math.max(0, Math.min(100, ((value - min) / (max - min)) * 100));
  const color = high !== undefined && value >= high ? "bg-red" :
                low  !== undefined && value <= low  ? "bg-green" : "bg-blue";
  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px]">
        <span className="text-text2">{label}</span>
        <span className={cn("font-mono font-semibold",
          high !== undefined && value >= high ? "text-red" :
          low  !== undefined && value <= low  ? "text-green" : "text-text"
        )}>{fmt(value)}</span>
      </div>
      <div className="h-1.5 bg-bg3 rounded-full overflow-hidden relative">
        {low  !== undefined && <div className="absolute top-0 bottom-0 w-px bg-green/40" style={{ left: `${((low  - min) / (max - min)) * 100}%` }} />}
        {high !== undefined && <div className="absolute top-0 bottom-0 w-px bg-red/40"   style={{ left: `${((high - min) / (max - min)) * 100}%` }} />}
        <div className={cn("h-full rounded-full transition-all", color)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

// ── Candle sparkline ──────────────────────────────────────────────────────────
function CandleSparkline({ candles }: { candles: KuCoinCandle[] }) {
  const last = candles.slice(-40);
  if (last.length < 2) return null;
  const allHigh = Math.max(...last.map(c => c.high));
  const allLow  = Math.min(...last.map(c => c.low));
  const range   = allHigh - allLow || 1;
  const W = 320, H = 60, P = 2;
  const bw = (W - P * 2) / last.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 60 }}>
      {last.map((c, i) => {
        const x      = P + i * bw + bw * 0.1;
        const cw     = bw * 0.8;
        const isGreen = c.close >= c.open;
        const top    = P + ((allHigh - Math.max(c.open, c.close)) / range) * (H - P * 2);
        const bot    = P + ((allHigh - Math.min(c.open, c.close)) / range) * (H - P * 2);
        const wickT  = P + ((allHigh - c.high) / range) * (H - P * 2);
        const wickB  = P + ((allHigh - c.low)  / range) * (H - P * 2);
        const fill   = isGreen ? "#3fb950" : "#f85149";
        return (
          <g key={i}>
            <line x1={x + cw / 2} y1={wickT} x2={x + cw / 2} y2={wickB} stroke={fill} strokeWidth="0.5" />
            <rect x={x} y={top} width={cw} height={Math.max(1, bot - top)} fill={fill} />
          </g>
        );
      })}
    </svg>
  );
}

// ── MACD histogram ────────────────────────────────────────────────────────────
function MacdHistogram({ histogram }: { histogram: number[] }) {
  const last = histogram.slice(-30);
  if (last.length < 2) return null;
  const maxAbs = Math.max(...last.map(Math.abs), 0.0001);
  const W = 320, H = 40, mid = H / 2;
  const bw = W / last.length;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 40 }}>
      <line x1={0} y1={mid} x2={W} y2={mid} stroke="#30363d" strokeWidth="0.5" />
      {last.map((v, i) => {
        const barH = Math.abs(v) / maxAbs * (mid - 2);
        const y    = v >= 0 ? mid - barH : mid;
        return <rect key={i} x={i * bw + 0.5} y={y} width={bw - 1} height={barH} fill={v >= 0 ? "#3fb950" : "#f85149"} />;
      })}
    </svg>
  );
}

// ── OBV sparkline ─────────────────────────────────────────────────────────────
function ObvSparkline({ obv, obvMA }: { obv: number[]; obvMA: number[] }) {
  const n    = Math.min(obv.length, obvMA.length, 40);
  const obvSlice  = obv.slice(-n);
  const maSlice   = obvMA.slice(-n);
  if (n < 2) return null;

  const allVals = [...obvSlice, ...maSlice.filter(v => !isNaN(v))];
  const hi = Math.max(...allVals), lo = Math.min(...allVals);
  const range = hi - lo || 1;
  const W = 320, H = 36, P = 2;
  const bw = (W - P * 2) / n;

  const toY = (v: number) => P + ((hi - v) / range) * (H - P * 2);

  // polyline for OBV line
  const obvPts = obvSlice.map((v, i) => `${P + i * bw + bw / 2},${toY(v)}`).join(" ");
  const maPts  = maSlice
    .map((v, i) => (!isNaN(v) ? `${P + i * bw + bw / 2},${toY(v)}` : null))
    .filter(Boolean).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 36 }}>
      <line x1={0} y1={H / 2} x2={W} y2={H / 2} stroke="#30363d" strokeWidth="0.5" />
      {maPts && <polyline points={maPts} fill="none" stroke="#e3b341" strokeWidth="1.5" strokeDasharray="3 2" />}
      {obvPts && <polyline points={obvPts} fill="none" stroke="#58a6ff" strokeWidth="1.5" />}
    </svg>
  );
}

// ── Main dashboard ────────────────────────────────────────────────────────────
export default function Monitor() {
  const { language } = useMonitorContext();
  const isFi = language === "fi";

  const [showSettings, setShowSettings] = useState(false);
  const [symbol, setSymbol]       = useState("BTC-USDT");
  const [symInput, setSymInput]   = useState("BTC-USDT");
  const [symOpen, setSymOpen]     = useState(false);
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [tf, setTf]               = useState("5min");
  const [candles, setCandles]     = useState<KuCoinCandle[]>([]);
  const [signal, setSignal]       = useState<SignalResult | null>(null);
  const [price, setPrice]         = useState(0);
  const [change24h, setChange24h] = useState(0);
  const [candleCountdown, setCandleCountdown] = useState(CANDLE_REFRESH_SEC);
  const [priceCountdown,  setPriceCountdown]  = useState(PRICE_POLL_SEC);
  const [log, setLog]             = useState<LogEntry[]>([]);
  const [loading, setLoading]     = useState(false);
  const [lastScanAt, setLastScanAt] = useState<number>(0);   // epoch ms of last full scan
  const [scanAge, setScanAge]     = useState(0);              // seconds since last full scan
  const symRef = useRef<HTMLDivElement>(null);

  // Direction change flash (for selected pair card)
  const [signalFlash, setSignalFlash] = useState(false);
  const prevDirRef = useRef<string>("NEUTRAL");

  // Multi-pair state
  const [pairSignals, setPairSignals] = useState<Record<string, PairSignal>>(
    () => Object.fromEntries(WATCH_PAIRS.map(s => [s, { signal: null, loading: false, updatedAt: 0 }]))
  );
  const scanAbortRef = useRef(false);

  // Tracks the LAST KNOWN direction per symbol — used to detect direction changes
  // across ALL 20 pairs in the scan loop. Stored as a ref (not state) to avoid
  // triggering re-renders on every scan tick.
  const prevDirectionsRef = useRef<Map<string, string>>(new Map());

  // ── Continuous scan loop (runs forever, 200ms between pairs) ─────────────
  const runScanLoop = useCallback((timeframe: string) => {
    scanAbortRef.current = false;
    // Clear remembered directions so TF-switch doesn't produce false "change" log entries.
    // Each symbol will be re-seeded silently on its first scan of the new timeframe.
    prevDirectionsRef.current.clear();
    let idx = 0;

    const tick = async () => {
      if (scanAbortRef.current) return;
      const sym = WATCH_PAIRS[idx];
      idx = (idx + 1) % WATCH_PAIRS.length;

      try {
        const res  = await fetch(`/api/candles?symbol=${sym}&timeframe=${timeframe}`);
        const data = await res.json();
        const c: KuCoinCandle[] = data.candles ?? [];
        const sig = c.length >= 50 ? generateSignal(c, 1) : null;
        const newDir = sig?.direction ?? "NEUTRAL";

        // ── Direction-change detection (all 20 pairs) ─────────────────────
        // prevDirectionsRef tracks the LAST COMMITTED direction per symbol.
        // We only write to the log when the direction actually changes.
        // On the very first scan of a symbol (no prior entry) we just seed
        // the ref — we don't log it (no "change" has happened yet).
        const knownDir = prevDirectionsRef.current.get(sym);
        if (knownDir !== undefined && knownDir !== newDir && sig) {
          // Direction changed — append to the global signal-change log
          setLog(prev => [
            { time: Date.now(), symbol: sym, tf: timeframe, signal: sig },
            ...prev,
          ].slice(0, 200));
        }
        prevDirectionsRef.current.set(sym, newDir);

        setPairSignals(prev => {
          const prevEntry = prev[sym];
          const prevDir   = prevEntry?.signal?.direction ?? "NEUTRAL";
          const changed   = prevDir !== newDir && prevEntry?.updatedAt > 0;
          return {
            ...prev,
            [sym]: {
              signal:        sig,
              loading:       false,
              updatedAt:     Date.now(),
              prevDirection: prevDir as "BUY" | "SELL" | "NEUTRAL",
              changedAt:     changed ? Date.now() : (prevEntry?.changedAt ?? 0),
            },
          };
        });

        if (idx === 0) setLastScanAt(Date.now()); // completed full cycle
      } catch { /* ignore transient fetch errors */ }

      if (!scanAbortRef.current) setTimeout(tick, SCAN_PAIR_DELAY_MS);
    };

    tick();
    return () => { scanAbortRef.current = true; };
  }, []);

  // Start / restart scan loop when timeframe changes.
  // Also reset pairSignals so stale changedAt timestamps from the previous TF
  // don't cause mini-cards to flash incorrectly on the new timeframe.
  useEffect(() => {
    setPairSignals(
      Object.fromEntries(WATCH_PAIRS.map(s => [s, { signal: null, loading: true, updatedAt: 0 }]))
    );
    const stop = runScanLoop(tf);
    return stop;
  }, [tf, runScanLoop]);

  // ── Scan age counter ──────────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      setScanAge(lastScanAt > 0 ? Math.floor((Date.now() - lastScanAt) / 1000) : 0);
    }, 1000);
    return () => clearInterval(t);
  }, [lastScanAt]);

  // ── Full candle refresh for selected pair ─────────────────────────────────
  const refreshCandles = useCallback(async (sym: string, timeframe: string) => {
    setLoading(true);
    try {
      const res  = await fetch(`/api/candles?symbol=${sym}&timeframe=${timeframe}`);
      const data = await res.json();
      const c: KuCoinCandle[] = data.candles ?? [];
      setCandles(c);
      if (c.length >= 50) {
        const sig = generateSignal(c, 1);
        setSignal(prev => {
          if (prev?.direction !== sig.direction) {
            setSignalFlash(true);
            setTimeout(() => setSignalFlash(false), 1500);
          }
          prevDirRef.current = sig.direction;
          return sig;
        });
        // NOTE: log is written by the scan loop when direction changes across all pairs.
        // refreshCandles only updates the detail view — do NOT log here.
      }
    } catch { /* ignore */ }
    finally { setLoading(false); }
  }, []);

  // ── Price-only poll (lightweight, every PRICE_POLL_SEC) ───────────────────
  const pollPrice = useCallback(async (sym: string) => {
    try {
      const res  = await fetch(`/api/price?symbol=${sym}`);
      const data = await res.json();
      setPrice(parseFloat(data.orderBook?.price ?? "0"));
      setChange24h(parseFloat(data.stats?.changeRate ?? "0") * 100);
    } catch { /* ignore */ }
  }, []);

  // On symbol or timeframe change → immediate full refresh
  useEffect(() => { refreshCandles(symbol, tf); }, [symbol, tf, refreshCandles]);

  // ── Candle refresh timer ──────────────────────────────────────────────────
  useEffect(() => {
    setCandleCountdown(CANDLE_REFRESH_SEC);
    const t = setInterval(() => {
      setCandleCountdown(c => {
        if (c <= 1) { refreshCandles(symbol, tf); return CANDLE_REFRESH_SEC; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [symbol, tf, refreshCandles]);

  // ── Price poll timer ──────────────────────────────────────────────────────
  useEffect(() => {
    pollPrice(symbol);
    setPriceCountdown(PRICE_POLL_SEC);
    const t = setInterval(() => {
      setPriceCountdown(c => {
        if (c <= 1) { pollPrice(symbol); return PRICE_POLL_SEC; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [symbol, pollPrice]);

  // ── Load symbol list ──────────────────────────────────────────────────────
  useEffect(() => {
    fetch("/api/symbols").then(r => r.json()).then(d => {
      setAllSymbols((d.symbols ?? []).map((s: { symbol: string }) => s.symbol).sort());
    }).catch(() => {});
  }, []);

  // ── Close symbol dropdown on outside click ────────────────────────────────
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (symRef.current && !symRef.current.contains(e.target as Node)) {
        setSymOpen(false); setSymInput(symbol);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [symbol]);

  // ── Sort pair grid by signal strength ─────────────────────────────────────
  const sortedPairs = [...WATCH_PAIRS].sort((a, b) =>
    dirWeight(pairSignals[b] ?? { signal: null, loading: false, updatedAt: 0 }) -
    dirWeight(pairSignals[a] ?? { signal: null, loading: false, updatedAt: 0 })
  );

  const filtered = allSymbols.filter(s => s.includes(symInput.toUpperCase())).slice(0, 80);

  // ── Derived display values ────────────────────────────────────────────────
  const ind  = signal?.indicators;
  const rsi  = ind?.rsi.at(-1)   ?? 0;
  const ema9 = ind?.ema9.at(-1)  ?? 0;
  const ema21= ind?.ema21.at(-1) ?? 0;
  const bbU  = ind?.bb.upper.at(-1)   ?? 0;
  const bbM  = ind?.bb.middle.at(-1)  ?? 0;
  const bbL  = ind?.bb.lower.at(-1)   ?? 0;
  const macdVal  = ind?.macd.macd.at(-1)      ?? 0;
  const macdSig  = ind?.macd.signal.at(-1)    ?? 0;
  const macdHist = ind?.macd.histogram.at(-1) ?? 0;
  const atr  = ind?.atr.at(-1)       ?? 0;
  const vol  = candles.at(-1)?.volume ?? 0;
  const volMA= ind?.volumeMA.at(-1)  ?? 0;
  const gc   = ind?.gaussianChannel;
  const gcLower = gc?.lower.at(-1) ?? 0;
  const gcUpper = gc?.upper.at(-1) ?? 0;
  const gcBull  = gc?.isBullish.at(-1) ?? false;

  // OBV
  const obvVal  = ind?.obv?.at(-1)   ?? 0;
  const obvMAVal= ind?.obvMA?.at(-1) ?? 0;
  const obvBull = obvVal > obvMAVal && obvMAVal !== 0;

  const dir   = signal?.direction ?? "NEUTRAL";
  const score = signal?.score ?? 0;
  const dirColor = dir === "BUY" ? "text-green" : dir === "SELL" ? "text-red" : "text-text2";
  const dirBg    = dir === "BUY"  ? "bg-green-dim border-green/30" :
                   dir === "SELL" ? "bg-red-dim border-red/30"     : "bg-bg2 border-border";

  const displayDir = isFi
    ? dir === "BUY"  ? "OSTO" : dir === "SELL" ? "MYYNTI" : "NEUTRAALI"
    : dir === "BUY"  ? "BUY"  : dir === "SELL" ? "SELL"   : "NEUTRAL";

  const rawLabel = signal?.label ?? "";
  const displayLabel = isFi
    ? rawLabel === "STRONG BUY"  ? "Vahva osto"   :
      rawLabel === "WEAK BUY"    ? "Heikko osto"  :
      rawLabel === "STRONG SELL" ? "Vahva myynti" :
      rawLabel === "WEAK SELL"   ? "Heikko myynti":
      rawLabel === "NEUTRAL"     ? "Neutraali"    : "—"
    : rawLabel === "STRONG BUY"  ? "Strong Buy"   :
      rawLabel === "WEAK BUY"    ? "Weak Buy"     :
      rawLabel === "STRONG SELL" ? "Strong Sell"  :
      rawLabel === "WEAK SELL"   ? "Weak Sell"    :
      rawLabel === "NEUTRAL"     ? "Neutral"      : "—";

  const isStrong = rawLabel === "STRONG BUY" || rawLabel === "STRONG SELL";

  // Human advice
  const advice = signal
    ? generateHumanAdvice(signal, 100, 0, language)
    : null;

  // Count strong signals in grid
  const strongBuys  = Object.values(pairSignals).filter(p => p.signal?.label === "STRONG BUY").length;
  const strongSells = Object.values(pairSignals).filter(p => p.signal?.label === "STRONG SELL").length;

  return (
    <div className="min-h-screen bg-bg text-text">

      {/* ── Top bar ────────────────────────────────────────────────────────── */}
      <div className="h-12 bg-bg2 border-b border-border flex items-center gap-3 px-4 flex-shrink-0">
        <div className="flex flex-col leading-none">
          <span className="text-sm font-bold text-blue tracking-tight">{isFi ? "📡 TA-monitori" : "📡 TA Monitor"}</span>
          <BuildStamp />
        </div>
        <div className="w-px h-4 bg-border" />

        {/* Symbol combobox */}
        <div ref={symRef} className="relative">
          <input
            value={symInput}
            onFocus={() => setSymOpen(true)}
            onChange={e => { setSymInput(e.target.value.toUpperCase()); setSymOpen(true); }}
            className="bg-bg3 border border-border rounded px-2 py-1 text-xs font-semibold text-text w-32 focus:outline-none focus:border-blue"
            placeholder="BTC-USDT"
          />
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-text3 text-[10px] pointer-events-none">▾</span>
          {symOpen && (
            <div className="absolute top-full left-0 mt-1 w-48 max-h-60 overflow-y-auto bg-bg2 border border-border rounded shadow-2xl z-50">
              {filtered.length === 0 && (
                <div className="px-3 py-2 text-xs text-text2">
                  {allSymbols.length === 0 ? (isFi ? "Ladataan…" : "Loading…") : (isFi ? "Ei tuloksia" : "No match")}
                </div>
              )}
              {filtered.map(s => (
                <button key={s} onMouseDown={e => { e.preventDefault(); setSymbol(s); setSymInput(s); setSymOpen(false); }}
                  className={cn("w-full text-left px-3 py-1.5 text-xs hover:bg-bg3 transition-colors",
                    s === symbol ? "text-blue font-semibold" : "text-text")}>
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Timeframe buttons */}
        <div className="flex gap-0.5">
          {TIMEFRAMES.map(t => (
            <button key={t} onClick={() => setTf(t)}
              className={cn("px-2 py-1 rounded text-[11px] font-semibold transition-all",
                tf === t ? "bg-blue text-bg font-bold" : "text-text2 hover:bg-bg3 hover:text-text")}>
              {t}
            </button>
          ))}
        </div>

        <div className="w-px h-4 bg-border" />

        {/* Live price */}
        {price > 0 && (
          <div className="flex items-baseline gap-2">
            <span className="text-lg font-bold font-mono text-text">
              ${price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}
            </span>
            <span className={cn("text-xs font-semibold", change24h >= 0 ? "text-green" : "text-red")}>
              {change24h >= 0 ? "▲" : "▼"} {Math.abs(change24h).toFixed(2)}%
            </span>
          </div>
        )}

        <div className="flex-1" />

        {/* Strong signal counters */}
        {(strongBuys > 0 || strongSells > 0) && (
          <div className="flex gap-2 text-[10px] font-semibold">
            {strongBuys  > 0 && <span className="text-green bg-green-dim border border-green/30 rounded px-1.5 py-0.5">🔥 {strongBuys} {isFi ? "vahva osto" : "strong buy"}</span>}
            {strongSells > 0 && <span className="text-red   bg-red-dim   border border-red/30   rounded px-1.5 py-0.5">🔥 {strongSells} {isFi ? "vahva myynti" : "strong sell"}</span>}
          </div>
        )}

        {/* Countdown bars */}
        <div className="flex items-center gap-3">
          {loading && <span className="w-1.5 h-1.5 rounded-full bg-blue animate-pulse" />}
          <CountdownBar current={priceCountdown}  total={PRICE_POLL_SEC}     label={isFi ? "Hinta" : "Price"} color="bg-amber" />
          <CountdownBar current={candleCountdown} total={CANDLE_REFRESH_SEC} label={isFi ? "Data"  : "Data"}  color="bg-blue"  />
        </div>

        {/* Scan age */}
        <div className="text-[10px] text-text3">
          {isFi ? `Skannaus ${scanAge}s sitten` : `Scanned ${scanAge}s ago`}
          <span className="ml-1 opacity-50">· {candles.length} {isFi ? "kynttilää" : "candles"}</span>
        </div>

        <button onClick={() => setShowSettings(true)}
          className="ml-1 px-2 py-1 rounded text-text2 hover:text-text hover:bg-bg3 transition-colors text-base"
          title={isFi ? "Asetukset" : "Settings"}>
          ⚙️
        </button>
        {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}
      </div>

      {/* ── All-pairs grid (TOP20 order) ─────────────────────────────────────── */}
      <div className="bg-bg2 border-b border-border px-4 py-2">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[10px] text-text2 uppercase tracking-wide font-semibold">
            {isFi ? "Kaikki parit" : "All Pairs"} — {tf} · TOP20
          </span>
          <div className="flex items-center gap-1.5">
            {/* Spinning scan indicator */}
            <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" title={isFi ? "Jatkuva skannaus käynnissä" : "Continuous scan active"} />
            <span className="text-[10px] text-text3">{isFi ? "Jatkuva skannaus" : "Live scanning"}</span>
          </div>
        </div>
        <div className="grid grid-cols-10 gap-1.5">
          {WATCH_PAIRS.map(sym => (
            <MiniSignalCard
              key={sym}
              sym={sym}
              data={pairSignals[sym] ?? { signal: null, loading: true, updatedAt: 0 }}
              selected={symbol === sym}
              onClick={() => { setSymbol(sym); setSymInput(sym); }}
              language={language}
            />
          ))}
        </div>
      </div>

      {/* ── Main content ─────────────────────────────────────────────────────── */}
      <div className="p-4 grid grid-cols-[1fr_1fr_1fr] gap-4">

        {/* ── Column 1: Signal ─────────────────────────────────────────────── */}
        <div className="space-y-4">

          {/* Big signal card with flash animation */}
          <div className={cn(
            "rounded-xl border p-5 text-center space-y-3 transition-all duration-300",
            dirBg,
            signalFlash && "ring-4 " + (dir === "BUY" ? "ring-green/60" : dir === "SELL" ? "ring-red/60" : "ring-blue/60"),
          )}>
            {/* Strong signal pulsing header */}
            {isStrong && (
              <div className={cn("text-[10px] font-bold tracking-widest animate-pulse",
                dir === "BUY" ? "text-green" : "text-red")}>
                {isFi ? "⚡ VAHVA SIGNAALI" : "⚡ STRONG SIGNAL"}
              </div>
            )}

            <div className={cn("text-4xl font-black tracking-wider", dirColor)}>{displayDir}</div>
            <div className={cn("text-lg font-bold", dirColor)}>{displayLabel}</div>

            {/* Score dots */}
            <div className="flex justify-center gap-1.5">
              {Array.from({ length: signal?.maxScore ?? 13 }).map((_, i) => (
                <div key={i} className={cn("w-4 h-4 rounded-full border-2 transition-all",
                  i < score
                    ? dir === "BUY" ? "bg-green border-green" : dir === "SELL" ? "bg-red border-red" : "bg-blue border-blue"
                    : "bg-transparent border-border"
                )} />
              ))}
            </div>
            <div className="text-xs text-text2">
              {score}/{signal?.maxScore ?? 13} {isFi ? "kriteerit täyttyvät" : "conditions met"} · {signal?.strengthPct ?? 0}% {isFi ? "vahvuus" : "strength"}
            </div>

            {/* TP / SL grid */}
            {signal && (
              <div className="grid grid-cols-2 gap-2 text-xs pt-1">
                <div className="bg-bg/50 rounded px-2 py-1.5">
                  <div className="text-text3 text-[10px]">{isFi ? "Sisääntulo" : "Entry"}</div>
                  <div className="font-mono font-semibold text-text">${signal.entryPrice.toFixed(4)}</div>
                </div>
                <div className="bg-bg/50 rounded px-2 py-1.5">
                  <div className="text-text3 text-[10px]">Take Profit</div>
                  <div className="font-mono font-semibold text-green">${signal.takeProfitPrice.toFixed(4)}</div>
                </div>
                <div className="bg-bg/50 rounded px-2 py-1.5">
                  <div className="text-text3 text-[10px]">Stop Loss</div>
                  <div className="font-mono font-semibold text-red">${signal.stopLossPrice.toFixed(4)}</div>
                </div>
                <div className="bg-bg/50 rounded px-2 py-1.5">
                  <div className="text-text3 text-[10px]">{isFi ? "Osto / Myynti" : "Buy / Sell score"}</div>
                  <div className="font-mono font-semibold text-text">{signal.rawBuyScore}B · {signal.rawSellScore}S</div>
                </div>
              </div>
            )}

            {/* Regime badge */}
            {signal && (
              <div className="text-[10px] text-text3">
                {isFi ? "Markkinaregime: " : "Market regime: "}
                <span className={cn("font-semibold",
                  signal.regime === "TRENDING_UP"   ? "text-green" :
                  signal.regime === "TRENDING_DOWN" ? "text-red"   :
                  signal.regime === "VOLATILE"      ? "text-amber" : "text-text2"
                )}>{signal.regime}</span>
              </div>
            )}
          </div>

          {/* Human advice box */}
          {advice && dir !== "NEUTRAL" && (
            <div className={cn("rounded-lg border p-3 space-y-2",
              dir === "BUY" ? "bg-green-dim border-green/20" : "bg-red-dim border-red/20")}>
              <div className={cn("text-sm font-bold", dirColor)}>{advice.headline}</div>
              <div className="text-[11px] text-text2">{advice.detail}</div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-text3">{isFi ? "Luottamus" : "Confidence"}:</span>
                <div className="flex gap-0.5">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <span key={i} className={cn("text-xs", i < advice.confidence ? "text-amber" : "text-border")}>★</span>
                  ))}
                </div>
                <span className="text-[10px] font-semibold text-text">${advice.recommendedRiskUSDT}</span>
              </div>
              {advice.warnings.map((w, i) => (
                <div key={i} className="text-[10px] text-amber bg-amber/10 border border-amber/20 rounded px-2 py-1">⚠ {w}</div>
              ))}
            </div>
          )}

          {/* Candle sparkline */}
          <div className="bg-bg2 rounded-lg border border-border p-3">
            <div className="text-[10px] text-text2 uppercase tracking-wide mb-2">{isFi ? "Viimeiset 40 kynttilää" : "Last 40 Candles"}</div>
            <CandleSparkline candles={candles} />
          </div>

          {/* MACD histogram */}
          <div className="bg-bg2 rounded-lg border border-border p-3">
            <div className="flex justify-between items-center mb-2">
              <div className="text-[10px] text-text2 uppercase tracking-wide">{isFi ? "MACD-histogrammi" : "MACD Histogram"}</div>
              <div className="text-[10px] font-mono">
                <span className={macdHist >= 0 ? "text-green" : "text-red"}>{macdHist >= 0 ? "+" : ""}{macdHist.toFixed(4)}</span>
                <span className="text-text3 ml-2">M {macdVal.toFixed(4)} · S {macdSig.toFixed(4)}</span>
              </div>
            </div>
            <MacdHistogram histogram={ind?.macd.histogram ?? []} />
          </div>

          {/* Fibonacci levels */}
          {ind?.fibonacci && (
            <div className="bg-bg2 rounded-lg border border-border p-3">
              <div className="text-[10px] text-text2 uppercase tracking-wide mb-2">
                {isFi ? "Fibonacci-tasot (viimeiset 100 kynttilää)" : "Fibonacci Levels (last 100 candles)"}
              </div>
              <div className="space-y-1">
                {Object.entries(ind.fibonacci.levels).map(([key, lvl]) => {
                  const isNear = price > 0 && Math.abs((price - lvl) / lvl) * 100 < 0.5;
                  return (
                    <div key={key} className={cn("flex justify-between text-xs px-2 py-0.5 rounded", isNear ? "bg-amber-dim border border-amber/30" : "")}>
                      <span className={cn("text-text3", isNear && "text-amber font-semibold")}>Fib {key}</span>
                      <span className={cn("font-mono", isNear ? "text-amber font-semibold" : "text-text2")}>
                        ${lvl.toFixed(4)}{isNear ? (isFi ? " ← lähellä" : " ← nearby") : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Gaussian Channel */}
          {gc && (
            <div className="bg-bg2 rounded-lg border border-border p-3 space-y-2">
              <div className="text-[10px] text-text2 uppercase tracking-wide">{isFi ? "Gaussinen kanava" : "Gaussian Channel"}</div>
              <div className={cn("text-sm font-bold", gcBull ? "text-green" : "text-red")}>
                {gcBull ? (isFi ? "▲ NOUSEVA" : "▲ BULLISH") : (isFi ? "▼ LASKEVA" : "▼ BEARISH")}
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div className="bg-bg3 rounded px-2 py-1">
                  <div className="text-text3 text-[10px]">{isFi ? "Yläkaista" : "Upper Band"}</div>
                  <div className="font-mono text-red">${gcUpper.toFixed(4)}</div>
                </div>
                <div className="bg-bg3 rounded px-2 py-1">
                  <div className="text-text3 text-[10px]">{isFi ? "Alakaista" : "Lower Band"}</div>
                  <div className="font-mono text-green">${gcLower.toFixed(4)}</div>
                </div>
              </div>
              <div className="text-[10px] text-text2">
                {isFi ? "Hinta on" : "Price is"}{" "}
                <span className={cn("font-semibold", price > gcLower ? "text-green" : "text-red")}>
                  {isFi
                    ? (price > gcLower ? "YLÄPUOLELLA alakaistaa" : "ALAPUOLELLA alakaistaa")
                    : (price > gcLower ? "ABOVE lower band" : "BELOW lower band")}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* ── Column 2: Conditions ─────────────────────────────────────────── */}
        <div className="space-y-4">
          <div className="bg-bg2 rounded-lg border border-border p-3 space-y-1">
            <div className="text-[10px] text-text2 uppercase tracking-wide mb-2">
              {dir === "BUY" ? "🟢" : dir === "SELL" ? "🔴" : "⚪"}{" "}
              {isFi
                ? (dir === "BUY" ? "OSTO" : dir === "SELL" ? "MYYNTI" : "NEUTRAALI")
                : (dir === "BUY" ? "BUY"  : dir === "SELL" ? "SELL"   : "NEUTRAL")
              }{" "}
              {isFi ? "Kriteerit" : "Conditions"}
            </div>

            {signal?.conditionsMet.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-xs bg-green-dim rounded px-2 py-1.5 border border-green/20">
                <span className="text-green font-bold mt-0.5 flex-shrink-0">✓</span>
                <span className="text-text">{c}</span>
              </div>
            ))}

            {signal?.conditionsFailed.map((c, i) => (
              <div key={i} className="flex items-start gap-2 text-xs bg-bg3 rounded px-2 py-1.5 border border-border">
                <span className="text-text3 font-bold mt-0.5 flex-shrink-0">✗</span>
                <span className="text-text2">{c}</span>
              </div>
            ))}
          </div>

          {/* Signal change log — ALL pairs, direction changes only */}
          <div className="bg-bg2 rounded-lg border border-border p-3">
            <div className="flex items-center justify-between mb-2">
              <div className="text-[10px] text-text2 uppercase tracking-wide">
                {isFi ? "Signaalimuutokset" : "Signal Changes"}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
                <span className="text-[9px] text-text3">{isFi ? "Kaikki parit" : "All pairs"}</span>
              </div>
            </div>
            {log.length === 0 ? (
              <div className="text-[10px] text-text3 italic py-2 text-center">
                {isFi ? "Odottaa suositusmuutosta…" : "Waiting for direction changes…"}
              </div>
            ) : (
              <div className="space-y-1 max-h-52 overflow-y-auto">
                {log.slice(0, 20).map((entry, i) => {
                  const eDir   = entry.signal.direction;
                  const eColor = eDir === "BUY" ? "text-green" : eDir === "SELL" ? "text-red" : "text-text3";
                  const eLabel = entry.signal.label ?? "";
                  const isStrong = eLabel === "STRONG BUY" || eLabel === "STRONG SELL";
                  const isSelected = entry.symbol === symbol;
                  return (
                    <div key={i} className={cn(
                      "flex items-center gap-2 text-[10px] rounded px-1.5 py-1",
                      isSelected ? "bg-blue/10" : "hover:bg-bg3/50",
                    )}>
                      <span className="text-text3 font-mono w-14 flex-shrink-0">{format(entry.time, "HH:mm:ss")}</span>
                      <span className={cn("font-bold w-10 flex-shrink-0", isSelected ? "text-blue" : "text-text")}>
                        {entry.symbol.replace("-USDT", "")}
                      </span>
                      <span className={cn("font-black flex-shrink-0", eColor)}>
                        {isFi
                          ? eDir === "BUY" ? "OSTO" : eDir === "SELL" ? "MYYNTI" : "NEUTR."
                          : eDir}
                      </span>
                      {isStrong && <span className={cn("text-[9px] flex-shrink-0", eColor)}>⚡</span>}
                      <span className={cn("text-[9px]", eColor)}>{entry.signal.score}/{entry.signal.maxScore}</span>
                      <span className="text-text3 text-[9px] ml-auto truncate">{
                        isFi
                          ? eLabel === "STRONG BUY"  ? "Vahva osto"   :
                            eLabel === "WEAK BUY"    ? "Heikko osto"  :
                            eLabel === "STRONG SELL" ? "Vahva myynti" :
                            eLabel === "WEAK SELL"   ? "Heikko myynti":
                            eLabel
                          : eLabel
                      }</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Indikaattorit */}
          <div className="bg-bg2 rounded-lg border border-border p-3 space-y-3">
            <div className="text-[10px] text-text2 uppercase tracking-wide">{isFi ? "Indikaattorit" : "Indicators"}</div>

            <Bar label="RSI (14)" value={rsi} min={0} max={100} low={45} high={55} fmt={v => v.toFixed(1)} />

            {/* EMA 9/21 */}
            <div className="space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="text-text2">EMA 9 / 21</span>
                <span className={cn("font-mono font-semibold text-[10px]", ema9 > ema21 ? "text-green" : "text-red")}>
                  {ema9 > ema21 ? (isFi ? "▲ Nouseva" : "▲ Bullish") : (isFi ? "▼ Laskeva" : "▼ Bearish")}
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1 text-[10px]">
                <div className="bg-bg3 rounded px-2 py-1">
                  <span className="text-text3">EMA9 </span>
                  <span className="font-mono text-blue">${ema9.toFixed(4)}</span>
                </div>
                <div className="bg-bg3 rounded px-2 py-1">
                  <span className="text-text3">EMA21 </span>
                  <span className="font-mono text-purple">${ema21.toFixed(4)}</span>
                </div>
              </div>
            </div>

            {/* BB */}
            <div className="space-y-0.5">
              <div className="text-[10px] text-text2 mb-1">Bollinger Bands (20,2)</div>
              <div className="grid grid-cols-3 gap-1 text-[10px]">
                {(isFi
                  ? [["Ylä", bbU, "text-red"], ["Keski", bbM, "text-text2"], ["Ala", bbL, "text-green"]]
                  : [["Upper", bbU, "text-red"], ["Middle", bbM, "text-text2"], ["Lower", bbL, "text-green"]]
                ).map(([l, v, c]) => (
                  <div key={l as string} className="bg-bg3 rounded px-1.5 py-1">
                    <div className="text-text3">{l as string}</div>
                    <div className={cn("font-mono", c as string)}>${(v as number).toFixed(4)}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* OBV */}
            <div className="space-y-1">
              <div className="flex justify-between text-[10px]">
                <span className="text-text2">OBV (20 MA)</span>
                <span className={cn("font-semibold text-[10px]", obvBull ? "text-green" : "text-red")}>
                  {obvBull
                    ? (isFi ? "▲ Akkumulaatio" : "▲ Accumulation")
                    : (isFi ? "▼ Distribuutio"  : "▼ Distribution")}
                </span>
              </div>
              {ind?.obv && ind?.obvMA && <ObvSparkline obv={ind.obv} obvMA={ind.obvMA} />}
              <div className="grid grid-cols-2 gap-1 text-[10px]">
                <div className="bg-bg3 rounded px-2 py-1">
                  <span className="text-text3">OBV </span>
                  <span className={cn("font-mono font-semibold", obvBull ? "text-green" : "text-red")}>
                    {obvVal > 0 ? "+" : ""}{obvVal >= 1e6 ? (obvVal / 1e6).toFixed(2) + "M" : obvVal >= 1e3 ? (obvVal / 1e3).toFixed(1) + "K" : obvVal.toFixed(0)}
                  </span>
                </div>
                <div className="bg-bg3 rounded px-2 py-1">
                  <span className="text-text3">MA20 </span>
                  <span className="font-mono text-amber">
                    {obvMAVal >= 1e6 ? (obvMAVal / 1e6).toFixed(2) + "M" : obvMAVal >= 1e3 ? (obvMAVal / 1e3).toFixed(1) + "K" : obvMAVal.toFixed(0)}
                  </span>
                </div>
              </div>
            </div>

            {/* Volume */}
            <div className="space-y-0.5">
              <div className="flex justify-between text-[10px]">
                <span className="text-text2">{isFi ? "Volyymi" : "Volume"}</span>
                <span className={cn("font-mono font-semibold text-[10px]",
                  volMA > 0 && vol > volMA * 1.5 ? "text-amber" : "text-text2")}>
                  {volMA > 0 ? `${(vol / volMA).toFixed(1)}× MA` : vol.toFixed(0)}
                </span>
              </div>
              <div className="h-1.5 bg-bg3 rounded-full overflow-hidden">
                <div className={cn("h-full rounded-full transition-all",
                  volMA > 0 && vol > volMA * 1.5 ? "bg-amber" : "bg-blue")}
                  style={{ width: `${Math.min(100, volMA > 0 ? (vol / volMA) * 50 : 50)}%` }} />
              </div>
            </div>

            {/* ATR */}
            <div className="flex justify-between text-[10px]">
              <span className="text-text2">ATR (14)</span>
              <span className="font-mono text-text">
                ${atr.toFixed(4)}
                {price > 0 && <span className="text-text3 ml-1">({((atr / price) * 100).toFixed(2)}%)</span>}
              </span>
            </div>
          </div>
        </div>

        {/* ── Column 3: Patterns · ADX · Live Recommendations ──────────────── */}
        <div className="space-y-4">

          {/* Wick pattern */}
          {signal?.wickSignal && (
            <div className={cn("bg-bg2 rounded-lg border p-3",
              signal.wickSignal.aligns ? "border-green/30" : signal.wickSignal.type === "DOJI" ? "border-amber/30" : "border-border")}>
              <div className="text-[10px] text-text2 uppercase tracking-wide mb-1">
                {isFi ? "Kynttilänmuoto" : "Candle Pattern"}
              </div>
              <div className={cn("text-sm font-bold",
                signal.wickSignal.aligns ? dirColor : signal.wickSignal.type === "DOJI" ? "text-amber" : "text-text2")}>
                {signal.wickSignal.type.replace(/_/g, " ")}
              </div>
              <div className="text-[10px] text-text3 mt-1">
                {isFi ? "Vahvuus" : "Strength"}: {(signal.wickSignal.strength * 100).toFixed(0)}%
                {" · "}
                {signal.wickSignal.aligns
                  ? (isFi ? "✓ Vahvistaa suunnan" : "✓ Confirms direction")
                  : signal.wickSignal.type === "DOJI"
                  ? (isFi ? "⚠ Epäselvyys" : "⚠ Indecision")
                  : (isFi ? "↔ Vastoin suuntaa" : "↔ Counter-directional")}
              </div>
            </div>
          )}

          {/* ADX/Regime */}
          <div className="bg-bg2 rounded-lg border border-border p-3 space-y-2">
            <div className="text-[10px] text-text2 uppercase tracking-wide">{isFi ? "Trendin vahvuus (ADX)" : "Trend Strength (ADX)"}</div>
            {ind && (() => {
              const adxV = ind.adx?.[ind.adx.length - 1] ?? 0;
              const pdi  = (ind as { plusDI?: number[] }).plusDI?.at(-1) ?? 0;
              const mdi  = (ind as { minusDI?: number[] }).minusDI?.at(-1) ?? 0;
              return (
                <>
                  <Bar label="ADX" value={adxV} min={0} max={60} low={20} high={40} fmt={v => v.toFixed(1)} />
                  <div className="grid grid-cols-2 gap-1 text-[10px]">
                    <div className="bg-bg3 rounded px-2 py-1">
                      <div className="text-text3">+DI</div>
                      <div className={cn("font-mono font-semibold", pdi > mdi ? "text-green" : "text-text2")}>{pdi.toFixed(1)}</div>
                    </div>
                    <div className="bg-bg3 rounded px-2 py-1">
                      <div className="text-text3">-DI</div>
                      <div className={cn("font-mono font-semibold", mdi > pdi ? "text-red" : "text-text2")}>{mdi.toFixed(1)}</div>
                    </div>
                  </div>
                </>
              );
            })()}
          </div>

          {/* ── LIVE RECOMMENDATIONS — all top-20 pairs, sorted by strength ── */}
          <LiveRecommendations
            pairSignals={pairSignals}
            sortedPairs={sortedPairs}
            selectedSymbol={symbol}
            onSelect={(sym) => { setSymbol(sym); setSymInput(sym); }}
            isFi={isFi}
          />

        </div>
      </div>
    </div>
  );
}

// ── Live Recommendations panel ────────────────────────────────────────────────
// Shows every top-20 pair with direction, score, entry price and "Ns ago" stamp.
// Updates automatically as pairSignals React state changes — no extra polling needed.

function fmtAge(ms: number): string {
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60)  return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60}s`;
  return `${Math.floor(s / 3600)}h`;
}

function fmtPrice(p: number): string {
  if (p === 0) return "—";
  if (p >= 1000) return p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  if (p >= 1)    return p.toFixed(4);
  return p.toFixed(6);
}

function LiveRecommendations({ pairSignals, sortedPairs, selectedSymbol, onSelect, isFi }: {
  pairSignals: Record<string, PairSignal>;
  sortedPairs: string[];
  selectedSymbol: string;
  onSelect: (sym: string) => void;
  isFi: boolean;
}) {
  // Re-render every second so "age" stamps stay fresh
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick(n => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="bg-bg2 rounded-lg border border-border flex flex-col" style={{ minHeight: 320 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse flex-shrink-0" />
          <span className="text-[10px] font-semibold text-text2 uppercase tracking-wide">
            {isFi ? "Reaaliaikaiset suositukset" : "Live Recommendations"}
          </span>
        </div>
        <span className="text-[9px] text-text3">Top 20 · {isFi ? "vahvuuden mukaan" : "by strength"}</span>
      </div>

      {/* Column headers */}
      <div className="grid text-[9px] text-text3 uppercase tracking-wide px-3 py-1 border-b border-border/50"
           style={{ gridTemplateColumns: "3fr 2.5fr 1fr 2fr 1.5fr" }}>
        <span>{isFi ? "Pari" : "Pair"}</span>
        <span>{isFi ? "Suositus" : "Signal"}</span>
        <span className="text-center">{isFi ? "Pist." : "Score"}</span>
        <span className="text-right">{isFi ? "Hinta" : "Price"}</span>
        <span className="text-right">{isFi ? "Aika" : "Age"}</span>
      </div>

      {/* Rows */}
      <div className="overflow-y-auto flex-1">
        {sortedPairs.map(sym => {
          const p    = pairSignals[sym];
          const sig  = p?.signal;
          const dir  = sig?.direction ?? "NEUTRAL";
          const lbl  = sig?.label ?? "";
          const score = sig?.score ?? 0;
          const max   = sig?.maxScore ?? 13;
          const entry = sig?.entryPrice ?? 0;
          const isSelected = sym === selectedSymbol;

          const dirColor = dir === "BUY"  ? "text-green" :
                           dir === "SELL" ? "text-red"   : "text-text3";
          const rowBg    = isSelected
            ? "bg-blue/10 border-l-2 border-l-blue"
            : dir === "BUY"  ? "hover:bg-green/5"
            : dir === "SELL" ? "hover:bg-red/5" : "hover:bg-bg3/50";

          const displayDir = isFi
            ? dir === "BUY"  ? "OSTO"   : dir === "SELL" ? "MYYNTI" : "NEUTR."
            : dir;

          const displayLbl = isFi
            ? lbl === "STRONG BUY"  ? "Vahva osto"    :
              lbl === "WEAK BUY"    ? "Heikko osto"   :
              lbl === "STRONG SELL" ? "Vahva myynti"  :
              lbl === "WEAK SELL"   ? "Heikko myynti" :
              lbl === "NEUTRAL"     ? "Neutraali"     : "—"
            : lbl || "—";

          const isStrong = lbl === "STRONG BUY" || lbl === "STRONG SELL";
          const age = p?.updatedAt ? fmtAge(p.updatedAt) : "—";

          return (
            <button key={sym}
              onClick={() => onSelect(sym)}
              className={cn(
                "w-full grid text-left px-3 py-1.5 transition-colors cursor-pointer",
                rowBg,
                !isSelected && "border-l-2 border-l-transparent",
              )}
              style={{ gridTemplateColumns: "3fr 2.5fr 1fr 2fr 1.5fr" }}>

              {/* Symbol */}
              <span className={cn("text-[11px] font-semibold", isSelected ? "text-blue" : "text-text")}>
                {sym.replace("-USDT", "")}
              </span>

              {/* Direction + label */}
              <span className="flex items-center gap-1">
                {p?.loading && !sig && (
                  <span className="text-[10px] text-text3 animate-pulse">…</span>
                )}
                {sig && (
                  <>
                    <span className={cn("text-[10px] font-black", dirColor)}>{displayDir}</span>
                    {isStrong && <span className={cn("text-[8px] font-bold", dirColor)}>⚡</span>}
                    <span className={cn("text-[9px] hidden xl:inline", dirColor)}>{displayLbl}</span>
                  </>
                )}
              </span>

              {/* Score dots */}
              <span className="flex items-center justify-center gap-0.5">
                {sig ? (
                  <>
                    {Array.from({ length: max }).map((_, i) => (
                      <span key={i} className={cn("w-1 h-1 rounded-full inline-block",
                        i < score
                          ? dir === "BUY" ? "bg-green" : dir === "SELL" ? "bg-red" : "bg-blue"
                          : "bg-border"
                      )} />
                    ))}
                  </>
                ) : <span className="text-[9px] text-text3">—</span>}
              </span>

              {/* Entry price */}
              <span className={cn("text-right text-[10px] font-mono", dirColor)}>
                {entry > 0 ? `$${fmtPrice(entry)}` : "—"}
              </span>

              {/* Age */}
              <span className={cn("text-right text-[9px]",
                p?.updatedAt && Date.now() - p.updatedAt < 10_000 ? "text-green" : "text-text3")}>
                {age}
              </span>
            </button>
          );
        })}
      </div>

      {/* Footer summary */}
      <div className="px-3 py-1.5 border-t border-border/50 flex items-center gap-3 text-[9px] text-text3">
        {(() => {
          const buys    = sortedPairs.filter(s => pairSignals[s]?.signal?.direction === "BUY").length;
          const sells   = sortedPairs.filter(s => pairSignals[s]?.signal?.direction === "SELL").length;
          const neutral = sortedPairs.length - buys - sells;
          const strongB = sortedPairs.filter(s => pairSignals[s]?.signal?.label === "STRONG BUY").length;
          const strongS = sortedPairs.filter(s => pairSignals[s]?.signal?.label === "STRONG SELL").length;
          return (
            <>
              <span className="text-green font-semibold">{isFi ? `${buys} osto` : `${buys} buy`}</span>
              {strongB > 0 && <span className="text-green opacity-70">({strongB} {isFi ? "vahva" : "strong"})</span>}
              <span className="text-red font-semibold">{isFi ? `${sells} myynti` : `${sells} sell`}</span>
              {strongS > 0 && <span className="text-red opacity-70">({strongS} {isFi ? "vahva" : "strong"})</span>}
              <span className="text-text3">{isFi ? `${neutral} neutraali` : `${neutral} neutral`}</span>
            </>
          );
        })()}
      </div>
    </div>
  );
}
