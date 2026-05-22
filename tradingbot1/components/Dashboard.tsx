'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import dynamic from 'next/dynamic';
import Header from './Header';
import SignalPanel from './SignalPanel';
import PositionCard from './PositionCard';
import MetricsBar from './MetricsBar';
import TradeTable from './TradeTable';
import ControlPanel from './ControlPanel';

const CandleChart = dynamic(() => import('./CandleChart'), { ssr: false });

interface BotStatus {
  isRunning: boolean;
  startError: string | null;
  symbol: string;
  interval: string;
  paperMode: boolean;
  openPosition: null | {
    id: string;
    direction: string;
    entryPrice: number;
    stopLoss: number;
    tp1: number;
    tp2: number;
    size: number;
    remainingSize: number;
    breakEvenActive: boolean;
    pnl: number;
    signalScore: number;
    entryTime: number;
  };
  completedTradesCount: number;
  capital: number;
  dailyDrawdown: number;
  drawdownBreached: boolean;
  lastPrice: number;
  latestSignal: null | {
    score: number;
    direction: string;
    breakdown: Record<string, number>;
    wick: { pattern: string; direction: string; strength: number };
    confidence: number;
  };
  performance: null | {
    winRate: number;
    ev: number;
    totalPnL: number;
    avgWin: number;
    avgLoss: number;
    maxDrawdown: number;
    sharpeRatio: number;
  };
}

interface ChartData {
  candles: {
    timestamp: number; open: number; high: number; low: number; close: number; volume: number;
  }[];
  overlays: {
    ema9: number | null; ema21: number | null;
    bbUpper: number | null; bbLower: number | null; bbMiddle: number | null;
  }[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Trade = any;

export default function Dashboard() {
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [chartData, setChartData] = useState<ChartData>({ candles: [], overlays: [] });
  const [trades, setTrades] = useState<Trade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const tickRef = useRef(0);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/status');
      const data = await res.json();
      if (data.error) { setError(data.error); return; }
      setStatus(data);
      setError(null);
    } catch (e) { setError(String(e)); }
  }, []);

  const fetchChartData = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/candles?limit=200');
      const data = await res.json();
      if (data.candles) setChartData(data);
    } catch { /* silent */ }
  }, []);

  const fetchTrades = useCallback(async () => {
    try {
      const res = await fetch('/api/bot/trades');
      const data = await res.json();
      if (data.trades) setTrades(data.trades);
    } catch { /* silent */ }
  }, []);

  // Polling loop
  useEffect(() => {
    fetchStatus();
    fetchChartData();
    fetchTrades();

    const id = setInterval(() => {
      tickRef.current++;
      fetchStatus();
      if (tickRef.current % 5 === 0) fetchChartData();
      if (tickRef.current % 3 === 0) fetchTrades();
    }, 2000);

    return () => clearInterval(id);
  }, [fetchStatus, fetchChartData, fetchTrades]);

  const handleStart = async (cfg: { symbol: string; interval: string; paperMode: boolean; signalThreshold: number }) => {
    const res = await fetch('/api/bot/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    });
    const data = await res.json();
    if (data.status) setStatus(data.status);
    fetchChartData();
  };

  const handleStop = async () => {
    await fetch('/api/bot/stop', { method: 'POST' });
    fetchStatus();
  };

  const handleBacktest = async () => {
    const res = await fetch('/api/bot/backtest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    const data = await res.json();
    console.log('Backtest:', data);
  };

  const handleOptimise = async () => {
    const res = await fetch('/api/bot/backtest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ optimise: true }),
    });
    const data = await res.json();
    console.log('Optimise:', data);
    fetchStatus();
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', overflow: 'hidden' }}>
      {/* Header */}
      <Header
        isRunning={status?.isRunning ?? false}
        symbol={status?.symbol ?? 'BTC-USDT'}
        interval={status?.interval ?? '15min'}
        lastPrice={status?.lastPrice ?? 0}
        paperMode={status?.paperMode ?? true}
        capital={status?.capital ?? 0}
      />

      {/* Error banner */}
      {(error || status?.startError) && (
        <div style={{
          background: 'rgba(239,68,68,0.15)', borderBottom: '1px solid rgba(239,68,68,0.3)',
          padding: '6px 20px', fontSize: 11, color: '#fca5a5',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontWeight: 700 }}>⚠</span>
          {error ?? status?.startError}
        </div>
      )}

      {/* Metrics bar */}
      <div style={{ padding: '6px 10px 0' }}>
        <MetricsBar
          performance={status?.performance ?? null}
          completedTrades={status?.completedTradesCount ?? 0}
          dailyDrawdown={status?.dailyDrawdown ?? 0}
          drawdownBreached={status?.drawdownBreached ?? false}
        />
      </div>

      {/* Main body */}
      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1fr 280px',
        gridTemplateRows: '1fr 220px',
        gap: 8,
        padding: '6px 10px',
        overflow: 'hidden',
        minHeight: 0,
      }}>
        {/* Chart — spans both rows on the left */}
        <div className="panel" style={{ overflow: 'hidden', gridRow: '1 / 2' }}>
          <CandleChart
            candles={chartData.candles}
            overlays={chartData.overlays}
            openPosition={status?.openPosition ?? null}
          />
        </div>

        {/* Signal panel — right column, top */}
        <SignalPanel signal={status?.latestSignal ?? null} />

        {/* Bottom row: Position + Control */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, gridRow: '2 / 3', minHeight: 0 }}>
          <PositionCard
            position={status?.openPosition ?? null}
            lastPrice={status?.lastPrice ?? 0}
          />
          <ControlPanel
            isRunning={status?.isRunning ?? false}
            paperMode={status?.paperMode ?? true}
            symbol={status?.symbol ?? 'BTC-USDT'}
            interval={status?.interval ?? '15min'}
            onStart={handleStart}
            onStop={handleStop}
            onBacktest={handleBacktest}
            onOptimise={handleOptimise}
          />
        </div>

        {/* Control panel stacked under signal — right column, bottom */}
        <div style={{ gridRow: '2 / 3', gridColumn: '2 / 3', display: 'none' }} />
      </div>

      {/* Trade history — full width footer */}
      <div style={{ height: 180, padding: '0 10px 8px' }}>
        <TradeTable trades={trades} />
      </div>
    </div>
  );
}
