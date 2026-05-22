'use client';

interface Trade {
  id: string;
  direction: string;
  entryPrice: number;
  exitPrice?: number;
  pnl: number;
  size: number;
  signalScore: number;
  entryTime: number;
  exitTime?: number;
  status: string;
}

function timeAgo(ts?: number): string {
  if (!ts) return '—';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(ts).toLocaleDateString('fi-FI');
}

function rMultiple(trade: Trade): string {
  if (!trade.exitPrice) return '—';
  const risk = Math.abs(trade.entryPrice - trade.exitPrice);
  if (risk === 0) return '0R';
  const r = trade.pnl / (trade.size * (risk / trade.entryPrice));
  return `${r >= 0 ? '+' : ''}${r.toFixed(2)}R`;
}

export default function TradeTable({ trades }: { trades: Trade[] }) {
  return (
    <div className="panel" style={{ padding: '12px 16px', height: '100%', display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', color: '#e2e8f0' }}>
          TRADE HISTORY
        </span>
        <span className="dim" style={{ fontSize: 10 }}>{trades.length} records</span>
      </div>

      {trades.length === 0 ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <span className="dim" style={{ fontSize: 11 }}>No completed trades yet</span>
        </div>
      ) : (
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>DIR</th>
                <th>ENTRY</th>
                <th>EXIT</th>
                <th>P&L</th>
                <th>R</th>
                <th>SCORE</th>
                <th>TIME</th>
              </tr>
            </thead>
            <tbody>
              {trades.map((t) => {
                const isWin = t.pnl > 0;
                return (
                  <tr key={t.id}>
                    <td style={{ color: 'var(--dim)', fontSize: 11 }}>{t.id}</td>
                    <td>
                      <span className={t.direction === 'LONG' ? 'badge badge-long' : 'badge badge-short'}
                        style={{ fontSize: 10, padding: '1px 6px' }}>
                        {t.direction}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>
                      {t.entryPrice.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                    </td>
                    <td style={{ color: 'var(--dim)' }}>
                      {t.exitPrice ? t.exitPrice.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}
                    </td>
                    <td style={{ fontWeight: 700, color: isWin ? 'var(--bull)' : 'var(--bear)' }}>
                      {t.pnl >= 0 ? '+' : ''}{t.pnl.toFixed(2)}
                    </td>
                    <td style={{ color: isWin ? 'var(--bull)' : 'var(--bear)', fontSize: 11 }}>
                      {rMultiple(t)}
                    </td>
                    <td style={{ color: 'var(--accent)' }}>{t.signalScore}/6</td>
                    <td style={{ color: 'var(--dim)', fontSize: 11 }}>{timeAgo(t.exitTime ?? t.entryTime)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
