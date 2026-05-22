'use client';

interface Performance {
  winRate: number;
  ev: number;
  totalPnL: number;
  avgWin: number;
  avgLoss: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

interface Props {
  performance: Performance | null;
  completedTrades: number;
  dailyDrawdown: number;
  drawdownBreached: boolean;
}

function Metric({
  label, value, sub, color,
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div style={{ textAlign: 'center', padding: '0 12px' }}>
      <div className="dim" style={{ fontSize: 9, letterSpacing: '0.07em', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: color ?? 'var(--text)', letterSpacing: '-0.01em' }}>
        {value}
      </div>
      {sub && <div className="dim" style={{ fontSize: 9, marginTop: 2 }}>{sub}</div>}
    </div>
  );
}

export default function MetricsBar({ performance, completedTrades, dailyDrawdown, drawdownBreached }: Props) {
  const p = performance;

  return (
    <div className="panel" style={{
      padding: '10px 0',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-around',
    }}>
      <Metric
        label="WIN RATE"
        value={p ? `${(p.winRate * 100).toFixed(1)}%` : '—'}
        color={p ? (p.winRate >= 0.5 ? 'var(--bull)' : 'var(--bear)') : undefined}
      />
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Metric
        label="EXP. VALUE"
        value={p ? `$${p.ev.toFixed(2)}` : '—'}
        color={p ? (p.ev >= 0 ? 'var(--bull)' : 'var(--bear)') : undefined}
      />
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Metric
        label="TOTAL P&L"
        value={p ? `${p.totalPnL >= 0 ? '+' : ''}$${p.totalPnL.toFixed(2)}` : '—'}
        color={p ? (p.totalPnL >= 0 ? 'var(--bull)' : 'var(--bear)') : undefined}
      />
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Metric
        label="AVG WIN"
        value={p ? `$${p.avgWin.toFixed(2)}` : '—'}
        sub={p ? `Loss: $${p.avgLoss.toFixed(2)}` : undefined}
        color="var(--bull)"
      />
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Metric
        label="TRADES"
        value={String(completedTrades)}
        color="var(--accent)"
      />
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Metric
        label="MAX DRAWDOWN"
        value={p ? `${(p.maxDrawdown * 100).toFixed(1)}%` : '—'}
        color={p && p.maxDrawdown > 0.05 ? 'var(--bear)' : 'var(--warn)'}
      />
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <div style={{ textAlign: 'center', padding: '0 12px' }}>
        <div className="dim" style={{ fontSize: 9, letterSpacing: '0.07em', marginBottom: 4 }}>DAILY DD</div>
        <div style={{ fontSize: 16, fontWeight: 800, color: drawdownBreached ? 'var(--bear)' : 'var(--text)' }}>
          {(dailyDrawdown * 100).toFixed(2)}%
        </div>
        {drawdownBreached && (
          <div style={{ fontSize: 9, color: 'var(--bear)', fontWeight: 700, marginTop: 2 }}>HALTED</div>
        )}
      </div>
      <div style={{ width: 1, height: 32, background: 'var(--border)' }} />
      <Metric
        label="SHARPE"
        value={p ? p.sharpeRatio.toFixed(2) : '—'}
        color={p && p.sharpeRatio > 1 ? 'var(--bull)' : 'var(--dim)'}
      />
    </div>
  );
}
