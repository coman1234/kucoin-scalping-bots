'use client';

interface Position {
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
}

function fmt(n: number, dec = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}

function elapsed(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

export default function PositionCard({ position, lastPrice }: { position: Position | null; lastPrice: number }) {
  if (!position) {
    return (
      <div className="panel" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', color: '#e2e8f0' }}>
          OPEN POSITION
        </span>
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 6, padding: '20px 0' }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', border: '2px solid var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span className="dim">—</span>
          </div>
          <span className="dim" style={{ fontSize: 11 }}>No open position</span>
        </div>
      </div>
    );
  }

  const isLong = position.direction === 'LONG';
  const unrealizedPnL = lastPrice > 0
    ? (isLong ? lastPrice - position.entryPrice : position.entryPrice - lastPrice) / position.entryPrice * position.remainingSize
    : position.pnl;
  const pnlColor = unrealizedPnL >= 0 ? 'var(--bull)' : 'var(--bear)';

  // Progress towards TP1
  const range = Math.abs(position.tp1 - position.entryPrice);
  const progress = range > 0
    ? Math.max(0, Math.min(1, Math.abs((lastPrice - position.entryPrice)) / range))
    : 0;

  return (
    <div className="panel" style={{ padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', color: '#e2e8f0' }}>OPEN POSITION</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {position.breakEvenActive && (
            <span className="badge" style={{ background: 'rgba(59,130,246,0.15)', color: 'var(--accent)', border: '1px solid rgba(59,130,246,0.3)', fontSize: 9 }}>
              BE
            </span>
          )}
          <span className={isLong ? 'badge badge-long' : 'badge badge-short'}>{position.direction}</span>
        </div>
      </div>

      {/* P&L */}
      <div style={{ background: 'var(--panel2)', borderRadius: 6, padding: '10px 12px', textAlign: 'center' }}>
        <div className="dim" style={{ fontSize: 10, marginBottom: 4 }}>UNREALIZED P&L</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: pnlColor, letterSpacing: '-0.02em' }}>
          {unrealizedPnL >= 0 ? '+' : ''}{fmt(unrealizedPnL)}
          <span style={{ fontSize: 11, marginLeft: 4 }}>USDT</span>
        </div>
      </div>

      {/* Price levels */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { label: 'ENTRY',  value: fmt(position.entryPrice, 4), color: 'var(--text)' },
          { label: 'CURRENT', value: lastPrice > 0 ? fmt(lastPrice, 4) : '—', color: 'var(--accent)' },
          { label: 'STOP LOSS', value: fmt(position.stopLoss, 4), color: 'var(--bear)' },
          { label: 'TP1', value: fmt(position.tp1, 4), color: 'var(--bull)' },
          { label: 'TP2', value: fmt(position.tp2, 4), color: '#86efac' },
          { label: 'SIZE', value: `$${fmt(position.remainingSize)}`, color: 'var(--text)' },
        ].map(({ label, value, color }) => (
          <div key={label} style={{ background: 'var(--panel2)', borderRadius: 4, padding: '6px 8px' }}>
            <div className="dim" style={{ fontSize: 9, marginBottom: 2 }}>{label}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color }}>{value}</div>
          </div>
        ))}
      </div>

      {/* Progress to TP1 */}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
          <span className="dim" style={{ fontSize: 10 }}>PROGRESS → TP1</span>
          <span style={{ fontSize: 10, color: 'var(--bull)' }}>{(progress * 100).toFixed(0)}%</span>
        </div>
        <div style={{ height: 5, background: 'var(--border)', borderRadius: 3, overflow: 'hidden' }}>
          <div style={{
            height: '100%', borderRadius: 3,
            width: `${(progress * 100).toFixed(0)}%`,
            background: 'linear-gradient(90deg, var(--accent), var(--bull))',
            transition: 'width 0.5s',
          }} />
        </div>
      </div>

      {/* Footer */}
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        <span className="dim" style={{ fontSize: 10 }}>
          Signal {position.signalScore}/6 · {position.id}
        </span>
        <span className="dim" style={{ fontSize: 10 }}>{elapsed(position.entryTime)} ago</span>
      </div>
    </div>
  );
}
