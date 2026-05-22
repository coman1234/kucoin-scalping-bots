'use client';

interface Props {
  isRunning: boolean;
  symbol: string;
  interval: string;
  lastPrice: number;
  paperMode: boolean;
  capital: number;
}

export default function Header({ isRunning, symbol, interval, lastPrice, paperMode, capital }: Props) {
  const now = new Date().toLocaleTimeString('fi-FI', { hour12: false });

  return (
    <header style={{
      background: 'var(--panel)',
      borderBottom: '1px solid var(--border)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 20px',
      height: 52,
      gap: 20,
    }}>
      {/* Logo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{
          width: 28, height: 28, borderRadius: 6,
          background: 'linear-gradient(135deg, #3b82f6, #22c55e)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 14, fontWeight: 900, color: '#000',
        }}>E</div>
        <span style={{ fontWeight: 800, fontSize: 15, letterSpacing: '0.03em', color: '#e2e8f0' }}>
          EV-MOMENTUM <span style={{ color: 'var(--accent)' }}>PRO</span>
        </span>
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--border)' }} />

      {/* Status dot */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span className={isRunning ? 'pulse' : ''} style={{
          width: 8, height: 8, borderRadius: '50%',
          background: isRunning ? 'var(--bull)' : 'var(--dim)',
          display: 'inline-block',
        }} />
        <span style={{ color: isRunning ? 'var(--bull)' : 'var(--dim)', fontSize: 11, fontWeight: 600 }}>
          {isRunning ? 'LIVE' : 'OFFLINE'}
        </span>
      </div>

      {/* Mode badge */}
      <span className={paperMode ? 'badge badge-paper' : 'badge badge-live'}>
        {paperMode ? 'PAPER' : 'LIVE TRADING'}
      </span>

      <div style={{ width: 1, height: 24, background: 'var(--border)' }} />

      {/* Symbol + interval */}
      <span style={{ fontWeight: 700, fontSize: 14, color: '#e2e8f0' }}>{symbol}</span>
      <span className="dim" style={{ fontSize: 12 }}>{interval}</span>

      {/* Last price */}
      {lastPrice > 0 && (
        <span style={{ fontSize: 15, fontWeight: 700, color: '#e2e8f0' }}>
          ${lastPrice.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </span>
      )}

      <div style={{ flex: 1 }} />

      {/* Capital */}
      <div style={{ textAlign: 'right' }}>
        <div className="dim" style={{ fontSize: 10, marginBottom: 1 }}>CAPITAL</div>
        <div style={{ fontWeight: 700, color: '#e2e8f0' }}>
          ${capital.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
        </div>
      </div>

      <div style={{ width: 1, height: 24, background: 'var(--border)' }} />

      {/* Clock */}
      <span className="dim" style={{ fontSize: 12, minWidth: 60 }}>{now}</span>
    </header>
  );
}
