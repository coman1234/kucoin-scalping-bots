"use client";

import { useTradingContext } from "@/lib/context";

const C_UP  = "#00d47e";
const C_DN  = "#ff3355";
const C_AMB = "#f59e0b";
const C_BLU = "#3d8fff";
const C_PUR = "#a855f7";
const C_GRY = "#44445a";

interface Props { mode: "mini" | "detail"; }

export default function SubCharts({ mode }: Props) {
  const { currentSignal, candles, livePrice, language } = useTradingContext();
  const isFi = language === "fi";

  if (!currentSignal || candles.length === 0) {
    if (mode === "mini") return (
      <div className="flex h-full items-center justify-center text-t-muted text-xs">{isFi ? "Odotetaan dataa…" : "Waiting for data…"}</div>
    );
    return null;
  }

  const { indicators: ind, conditionsMet, conditionsFailed, direction, score, maxScore,
    strengthPct, label, rawBuyScore, rawSellScore } = currentSignal;

  const last    = candles[candles.length - 1];
  const price   = last?.close ?? livePrice;
  const isGreen = last ? last.close > last.open : false;

  const rsi     = ind.rsi[ind.rsi.length - 1]                     ?? 50;
  const prevRsi = ind.rsi[ind.rsi.length - 2]                     ?? rsi;
  const hist    = ind.macd.histogram[ind.macd.histogram.length-1] ?? 0;
  const prevH   = ind.macd.histogram[ind.macd.histogram.length-2] ?? 0;
  const macd    = ind.macd.macd[ind.macd.macd.length-1]           ?? 0;
  const sig     = ind.macd.signal[ind.macd.signal.length-1]       ?? 0;
  const volMA   = ind.volumeMA[ind.volumeMA.length-1]             ?? 0;
  const vol     = last?.volume ?? 0;
  const ema9    = ind.ema9[ind.ema9.length-1]                     ?? 0;
  const ema21   = ind.ema21[ind.ema21.length-1]                   ?? 0;
  const bbUp    = ind.bb.upper[ind.bb.upper.length-1]             ?? 0;
  const bbMid   = ind.bb.middle[ind.bb.middle.length-1]           ?? 0;
  const bbLow   = ind.bb.lower[ind.bb.lower.length-1]             ?? 0;
  const atr     = ind.atr[ind.atr.length-1]                       ?? 0;

  const bbW     = bbUp - bbLow;
  const bbPos   = bbW > 0 ? ((price - bbLow) / bbW) * 100 : 50;
  const atrPct  = price > 0 ? (atr / price) * 100 : 0;
  const volR    = volMA > 0 ? vol / volMA : 1;
  const emaDiff = ema9 - ema21;
  const emaDPct = ema21 > 0 ? (emaDiff / ema21) * 100 : 0;

  const gc     = ind.gaussianChannel;
  const gcLen  = gc ? gc.mid.length : 0;
  const gcBull = gc && gcLen > 0 ? gc.isBullish[gcLen-1] : null;
  const gcU    = gc && gcLen > 0 ? gc.upper[gcLen-1] : null;
  const gcL    = gc && gcLen > 0 ? gc.lower[gcLen-1] : null;
  const fib    = ind.fibonacci;

  const rsiC  = rsi < 35 ? C_UP : rsi > 65 ? C_DN : C_AMB;
  const histC = hist >= 0 ? C_UP : C_DN;
  const volC  = volR >= 1.5 ? (isGreen ? C_UP : C_DN) : C_BLU;
  const sigC  = direction === "BUY" ? C_UP : direction === "SELL" ? C_DN : C_GRY;

  // ── MINI-TILA ─────────────────────────────────────────────────────────────
  if (mode === "mini") {
    return (
      <div className="flex h-full divide-x divide-b-border2">

        {/* RSI */}
        <div className="flex-1 px-3 py-1.5 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-t-secondary font-medium">RSI(14)</span>
            <span className="text-[9px] font-bold" style={{ color: rsiC }}>
              {rsi < 35 ? (isFi ? "YLIMYYTY" : "OVERSOLD") : rsi > 65 ? (isFi ? "YLIOSTETTTU" : "OVERBOUGHT") : (isFi ? "NEUTRAALI" : "NEUTRAL")}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold font-mono" style={{ color: rsiC }}>{rsi.toFixed(1)}</span>
            <span className="text-[10px]" style={{ color: rsi > prevRsi ? C_UP : C_DN }}>
              {rsi > prevRsi ? "↑" : "↓"}
            </span>
          </div>
          <div className="relative h-[3px] bg-b-active rounded-full overflow-hidden">
            <div className="absolute left-[35%] right-[35%] top-0 h-full bg-b-border" />
            <div className="h-full rounded-full transition-all" style={{ width: `${rsi}%`, background: rsiC }} />
          </div>
          <Spark values={ind.rsi.slice(-40)} color={rsiC} min={0} max={100} />
        </div>

        {/* MACD */}
        <div className="flex-1 px-3 py-1.5 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-t-secondary font-medium">MACD(12,26,9)</span>
            <span className="text-[9px] font-bold" style={{ color: histC }}>
              {macd > sig ? (isFi ? "NOUSEVA" : "RISING") : (isFi ? "LASKEVA" : "FALLING")}
            </span>
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold font-mono" style={{ color: histC }}>
              {hist >= 0 ? "+" : ""}{hist.toFixed(4)}
            </span>
            <span className="text-[10px]" style={{ color: hist > prevH ? C_UP : C_DN }}>
              {hist > prevH ? "↑" : "↓"}
            </span>
          </div>
          <div className="text-[9px] text-t-muted font-mono">{macd.toFixed(4)} / {sig.toFixed(4)}</div>
          <MacdBars values={ind.macd.histogram.slice(-40)} />
        </div>

        {/* Volyymi */}
        <div className="flex-1 px-3 py-1.5 flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-t-secondary font-medium">{isFi ? "Volyymi" : "Volume"} MA(20)</span>
            {volR >= 1.5 && (
              <span className="text-[9px] font-bold" style={{ color: volC }}>×{volR.toFixed(1)} {isFi ? "PIIKKI" : "SPIKE"}</span>
            )}
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-base font-bold font-mono" style={{ color: volC }}>{fv(vol)}</span>
          </div>
          <div className="text-[9px] text-t-muted">MA {fv(volMA)}</div>
          <VolBars values={ind.volumeMA.slice(-40)} cur={vol} />
        </div>

      </div>
    );
  }

  // ── YKSITYISKOHTAINEN TILA ────────────────────────────────────────────────
  return (
    <div className="p-3 space-y-3">

      {/* Signaaliyhteenvetopalkki */}
      <div className="flex items-center justify-between rounded-lg px-3 py-2 border"
        style={{ background: sigC + "10", borderColor: sigC + "30" }}>
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold" style={{ color: sigC }}>{label}</span>
          <div className="w-32 h-1.5 bg-b-active rounded-full overflow-hidden">
            <div className="h-full rounded-full transition-all" style={{ width: `${strengthPct}%`, background: sigC }} />
          </div>
          <span className="text-[11px] text-t-secondary font-mono">{score}/{maxScore} — {strengthPct}%</span>
        </div>
        <div className="flex gap-4 text-[11px]">
          <span><span className="text-t-secondary">BUY </span><span className="font-mono font-bold" style={{ color: C_UP }}>{rawBuyScore}/{maxScore}</span></span>
          <span><span className="text-t-secondary">SELL </span><span className="font-mono font-bold" style={{ color: C_DN }}>{rawSellScore}/{maxScore}</span></span>
          <span><span className="text-t-secondary">ATR </span><span className="font-mono text-t-primary">{atrPct.toFixed(2)}%</span></span>
        </div>
      </div>

      {/* 4-sarakkeen indikaattoriruudukko */}
      <div className="grid grid-cols-4 gap-2">

        {/* EMA-risteily */}
        <div className="card p-2.5 space-y-1.5">
          <div className="label">{isFi ? "EMA-risteily" : "EMA Crossover"}</div>
          <R label="EMA 9"   val={ema9.toFixed(2)}   color={C_AMB} />
          <R label="EMA 21"  val={ema21.toFixed(2)}  color={C_BLU} />
          <div className="sep pt-1.5">
            <R label={isFi ? "Ero" : "Diff"} val={`${emaDiff >= 0 ? "+" : ""}${emaDPct.toFixed(3)}%`}
              color={emaDiff > 0 ? C_UP : C_DN} />
          </div>
        </div>

        {/* Bollingerin nauhat */}
        <div className="card p-2.5 space-y-1.5">
          <div className="label">Bollinger (20,2)</div>
          <R label={isFi ? "Ylä" : "Upper"} val={bbUp.toFixed(2)}  color={C_DN} />
          <R label={isFi ? "Keski" : "Mid"}   val={bbMid.toFixed(2)} color={C_PUR} />
          <R label={isFi ? "Ala" : "Lower"} val={bbLow.toFixed(2)} color={C_UP} />
          <div className="relative h-[3px] bg-b-active rounded-full overflow-hidden mt-1.5">
            <div className="absolute top-0 h-full w-1.5 bg-t-primary rounded-full"
              style={{ left: `${Math.max(0, Math.min(100, bbPos))}%`, transform: "translateX(-50%)" }} />
          </div>
          <div className="flex justify-between text-[9px]">
            <span style={{ color: C_UP }}>{isFi ? "Ala" : "Lower"}</span>
            <span style={{ color: C_DN }}>{isFi ? "Ylä" : "Upper"}</span>
          </div>
        </div>

        {/* Gaussin kanava */}
        <div className="card p-2.5 space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="label">Gauss (50)</span>
            {gcBull !== null && (
              <span className="badge" style={{ background: (gcBull ? C_UP : C_DN) + "18", color: gcBull ? C_UP : C_DN }}>
                {gcBull ? (isFi ? "NOUSEVA" : "RISING") : (isFi ? "LASKEVA" : "FALLING")}
              </span>
            )}
          </div>
          {gc && gcLen > 0 ? (
            <>
              <R label={isFi ? "Ylä" : "Upper"} val={gcU?.toFixed(2) ?? "—"} color={gcBull ? C_UP : C_DN} />
              <R label={isFi ? "Ala" : "Lower"} val={gcL?.toFixed(2) ?? "—"} color={gcBull ? C_UP : C_DN} />
              <R label={isFi ? "vs Ala" : "vs Lower"} val={price > (gcL ?? 0) ? (isFi ? "Yllä ✓" : "Above ✓") : (isFi ? "Alla ✗" : "Below ✗")}
                color={price > (gcL ?? 0) ? C_UP : C_DN} />
            </>
          ) : (
            <div className="text-t-muted text-[10px]">{isFi ? "Tarvitaan 50+ kynttilää" : "Need 50+ candles"}</div>
          )}
        </div>

        {/* ATR + Fibonacci */}
        <div className="card p-2.5 space-y-1.5">
          <div className="label">ATR / Fibonacci</div>
          <R label="ATR" val={`${atr.toFixed(4)} (${atrPct.toFixed(2)}%)`} color="t-primary" />
          <R label="SL ×1,5"  val={(atr * 1.5).toFixed(4)} color={C_DN} />
          <R label="TP1 ×2,5" val={(atr * 2.5).toFixed(4)} color={C_UP} />
          {fib && (() => {
            const near = (Object.entries(fib.levels) as [string, number][])
              .find(([, v]) => Math.abs((price - v) / v) * 100 < 0.3);
            return near
              ? <R label={`Fib ${near[0]}`} val={near[1].toFixed(2)} color={C_AMB} />
              : <div className="text-[10px] text-t-muted">{isFi ? "Ei Fibonacci-tasoa lähellä hintaa" : "No Fibonacci level near price"}</div>;
          })()}
        </div>

      </div>

      {/* Kriteerit */}
      <div className="card p-2.5">
        <div className="label mb-1.5">{isFi ? `Signaalikriteerit — ${conditionsMet.length} täyttyy · ${conditionsFailed.length} ei täyty` : `Signal criteria — ${conditionsMet.length} met · ${conditionsFailed.length} not met`}</div>
        <div className="flex flex-wrap gap-x-5 gap-y-1">
          {conditionsMet.map((c) => (
            <div key={c} className="flex items-center gap-1 text-[11px]">
              <span style={{ color: C_UP }}>✓</span><span className="text-t-primary">{c}</span>
            </div>
          ))}
          {conditionsFailed.map((c) => (
            <div key={c} className="flex items-center gap-1 text-[11px]">
              <span className="text-t-muted">✗</span><span className="text-t-secondary">{c}</span>
            </div>
          ))}
        </div>
      </div>

    </div>
  );
}

// ── Riviaputoiminto ──────────────────────────────────────────────────────────────
function R({ label, val, color }: { label: string; val: string; color: string }) {
  return (
    <div className="flex justify-between items-center">
      <span className="text-t-secondary text-[10px]">{label}</span>
      <span className="font-mono text-[11px]" style={{ color: color.startsWith("#") ? color : undefined }}>{val}</span>
    </div>
  );
}

// ── SVG-kipinäviivat ────────────────────────────────────────────────────────────
function Spark({ values, color, min, max }: { values: number[]; color: string; min: number; max: number }) {
  if (values.length < 2) return <div className="h-[18px]" />;
  const W = 200, H = 18, P = 1, R = max - min || 1;
  const pts = values.map((v, i) =>
    `${P + (i / (values.length - 1)) * (W - P * 2)},${P + (1 - (v - min) / R) * (H - P * 2)}`
  ).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2" />
    </svg>
  );
}

function MacdBars({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="h-[18px]" />;
  const W = 200, H = 18, P = 1, mx = Math.max(...values.map(Math.abs), 0.00001), mid = H / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      <line x1={P} y1={mid} x2={W - P} y2={mid} stroke="#2a2a3f" strokeWidth="0.5" />
      {values.map((v, i) => {
        const x = P + (i / values.length) * (W - P * 2);
        const h = (Math.abs(v) / mx) * (mid - P);
        return <rect key={i} x={x} y={v >= 0 ? mid - h : mid}
          width={Math.max(1, (W - P * 2) / values.length - 0.5)}
          height={Math.max(0.5, h)} fill={v >= 0 ? C_UP : C_DN} opacity="0.9" />;
      })}
    </svg>
  );
}

function VolBars({ values, cur }: { values: number[]; cur: number }) {
  if (values.length < 2) return <div className="h-[18px]" />;
  const W = 200, H = 18, P = 1, mx = Math.max(...values, cur, 0.00001);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {values.map((v, i) => {
        const x = P + (i / (values.length + 1)) * (W - P * 2);
        const h = (v / mx) * (H - P);
        return <rect key={i} x={x} y={H - h} width={Math.max(1, (W - P * 2) / (values.length + 1) - 0.5)}
          height={Math.max(0.5, h)} fill={`${C_BLU}55`} />;
      })}
      {(() => {
        const h = (cur / mx) * (H - P);
        const x = P + (values.length / (values.length + 1)) * (W - P * 2);
        return <rect x={x} y={H - h} width={Math.max(2, (W - P * 2) / (values.length + 1) - 0.5)}
          height={Math.max(0.5, h)} fill={cur > (values[values.length - 1] ?? 0) * 1.5 ? C_UP : C_BLU} />;
      })()}
    </svg>
  );
}

function fv(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000)     return `${(v / 1_000).toFixed(1)}K`;
  return v.toFixed(2);
}
