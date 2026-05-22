'use client';

import { useState } from 'react';

const SYMBOLS = ['BTC-USDT', 'ETH-USDT', 'SOL-USDT', 'BNB-USDT', 'XRP-USDT'];
const INTERVALS = ['1min', '5min', '15min', '30min', '1hour', '4hour', '1day'];

interface Props {
  isRunning: boolean;
  paperMode: boolean;
  symbol: string;
  interval: string;
  onStart: (cfg: { symbol: string; interval: string; paperMode: boolean; signalThreshold: number }) => void;
  onStop: () => void;
  onBacktest: () => void;
  onOptimise: () => void;
}

export default function ControlPanel({ isRunning, paperMode, symbol, interval, onStart, onStop, onBacktest, onOptimise }: Props) {
  const [cfg, setCfg] = useState({ symbol, interval, paperMode, signalThreshold: 4 });
  const [loading, setLoading] = useState(false);
  const [btLoading, setBtLoading] = useState(false);
  const [btResult, setBtResult] = useState<string | null>(null);

  const handleStart = async () => {
    setLoading(true);
    try { await onStart(cfg); } finally { setLoading(false); }
  };

  const handleBacktest = async () => {
    setBtLoading(true);
    setBtResult(null);
    try { await onBacktest(); setBtResult('Done — check metrics'); } catch { setBtResult('Error'); } finally { setBtLoading(false); }
  };

  const handleOptimise = async () => {
    setBtLoading(true);
    setBtResult(null);
    try { await onOptimise(); setBtResult('Optimised params applied'); } catch { setBtResult('Error'); } finally { setBtLoading(false); }
  };

  return (
    <div className="panel" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 12 }}>
      <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', color: '#e2e8f0' }}>CONTROLS</span>

      {/* Symbol */}
      <div>
        <div className="dim" style={{ fontSize: 10, marginBottom: 4 }}>SYMBOL</div>
        <select
          value={cfg.symbol}
          onChange={(e) => setCfg({ ...cfg, symbol: e.target.value })}
          disabled={isRunning}
          style={{
            width: '100%', background: 'var(--panel2)', border: '1px solid var(--border)',
            color: 'var(--text)', borderRadius: 4, padding: '6px 8px', fontSize: 12,
          }}
        >
          {SYMBOLS.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      {/* Interval */}
      <div>
        <div className="dim" style={{ fontSize: 10, marginBottom: 4 }}>INTERVAL</div>
        <select
          value={cfg.interval}
          onChange={(e) => setCfg({ ...cfg, interval: e.target.value })}
          disabled={isRunning}
          style={{
            width: '100%', background: 'var(--panel2)', border: '1px solid var(--border)',
            color: 'var(--text)', borderRadius: 4, padding: '6px 8px', fontSize: 12,
          }}
        >
          {INTERVALS.map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </div>

      {/* Signal threshold */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span className="dim" style={{ fontSize: 10 }}>MIN SCORE</span>
          <span style={{ fontSize: 11, color: 'var(--accent)', fontWeight: 700 }}>{cfg.signalThreshold}/6</span>
        </div>
        <input
          type="range" min={2} max={6} step={1}
          value={cfg.signalThreshold}
          onChange={(e) => setCfg({ ...cfg, signalThreshold: Number(e.target.value) })}
          disabled={isRunning}
          style={{ width: '100%', accentColor: 'var(--accent)' }}
        />
      </div>

      {/* Paper mode toggle */}
      <div className="toggle-wrap">
        <label className="toggle">
          <input
            type="checkbox"
            checked={cfg.paperMode}
            onChange={(e) => setCfg({ ...cfg, paperMode: e.target.checked })}
            disabled={isRunning}
          />
          <span className="toggle-slider" />
        </label>
        <span style={{ fontSize: 12 }}>Paper Mode</span>
        {!cfg.paperMode && (
          <span style={{ fontSize: 10, color: 'var(--bear)', fontWeight: 700 }}>⚠ LIVE</span>
        )}
      </div>

      {/* Start / Stop */}
      {!isRunning ? (
        <button className="btn btn-green" onClick={handleStart} disabled={loading} style={{ width: '100%', justifyContent: 'center' }}>
          {loading ? '…' : '▶ START BOT'}
        </button>
      ) : (
        <button className="btn btn-red" onClick={onStop} style={{ width: '100%', justifyContent: 'center' }}>
          ■ STOP BOT
        </button>
      )}

      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div className="dim" style={{ fontSize: 10, marginBottom: 2 }}>ANALYSIS</div>
        <button className="btn btn-ghost" onClick={handleBacktest} disabled={btLoading} style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}>
          {btLoading ? '…' : '⚡ Quick Backtest'}
        </button>
        <button className="btn btn-ghost" onClick={handleOptimise} disabled={btLoading} style={{ width: '100%', justifyContent: 'center', fontSize: 11 }}>
          {btLoading ? '…' : '⚙ Optimise Params'}
        </button>
        {btResult && <div style={{ fontSize: 10, color: 'var(--bull)', textAlign: 'center' }}>{btResult}</div>}
      </div>
    </div>
  );
}
