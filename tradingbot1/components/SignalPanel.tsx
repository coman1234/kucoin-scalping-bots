'use client';

interface SignalData {
  score: number;
  direction: string;
  breakdown: Record<string, number>;
  wick: { pattern: string; direction: string; strength: number };
  confidence: number;
}

const INDICATORS = [
  { key: 'ema',    label: 'EMA 9/21',  desc: 'Trend alignment' },
  { key: 'bb',     label: 'Bol. Bands', desc: 'BB position' },
  { key: 'rsi',    label: 'RSI 14',    desc: 'Momentum/exhaustion' },
  { key: 'macd',   label: 'MACD',      desc: '12/26/9 cross' },
  { key: 'volume', label: 'Volume',    desc: 'vs MA(20)' },
  { key: 'fib',    label: 'Fibonacci', desc: 'Key level proximity' },
];

export default function SignalPanel({ signal }: { signal: SignalData | null }) {
  const dir = signal?.direction ?? 'NEUTRAL';
  const isBull = dir === 'LONG';

  return (
    <div className="panel" style={{ padding: '14px 16px', height: '100%', display: 'flex', flexDirection: 'column', gap: 10 }}>
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.06em', color: '#e2e8f0' }}>
          SIGNAL ENGINE
        </span>
        {signal && (
          <span className={isBull ? 'badge badge-long' : dir === 'SHORT' ? 'badge badge-short' : 'badge'} style={dir === 'NEUTRAL' ? { background: 'var(--panel2)', color: 'var(--dim)' } : {}}>
            {dir}
          </span>
        )}
      </div>

      {/* Score display */}
      <div style={{ background: 'var(--panel2)', borderRadius: 6, padding: '10px 12px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
          <span className="dim" style={{ fontSize: 11 }}>SCORE</span>
          <span style={{ fontWeight: 800, fontSize: 16, color: signal ? (isBull ? 'var(--bull)' : dir === 'SHORT' ? 'var(--bear)' : 'var(--text)') : 'var(--dim)' }}>
            {signal?.score ?? '—'}<span className="dim" style={{ fontSize: 11 }}>/6</span>
          </span>
        </div>
        <div className="score-bar">
          {[0,1,2,3,4,5].map((i) => (
            <div
              key={i}
              className={`score-pip${(signal?.score ?? 0) > i ? ' active' + (dir === 'SHORT' ? ' bear-dir' : '') : ''}`}
            />
          ))}
        </div>
      </div>

      {/* Indicator breakdown */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {INDICATORS.map(({ key, label, desc }) => {
          const active = signal ? (signal.breakdown[key] ?? 0) > 0 : false;
          return (
            <div key={key} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '5px 8px', borderRadius: 4,
              background: active ? 'rgba(34,197,94,0.06)' : 'transparent',
            }}>
              <div style={{
                width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                background: active
                  ? (dir === 'SHORT' ? 'var(--bear)' : 'var(--bull)')
                  : 'var(--border)',
                boxShadow: active ? `0 0 6px ${dir === 'SHORT' ? 'var(--bear)' : 'var(--bull)'}` : 'none',
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: active ? '#e2e8f0' : 'var(--dim)' }}>{label}</div>
                <div style={{ fontSize: 9, color: 'var(--dim)', marginTop: 1 }}>{desc}</div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700,
                color: active ? (dir === 'SHORT' ? 'var(--bear)' : 'var(--bull)') : 'var(--border)',
              }}>
                {active ? '+1' : '0'}
              </span>
            </div>
          );
        })}
      </div>

      {/* Wick detection */}
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div className="dim" style={{ fontSize: 10, marginBottom: 6, letterSpacing: '0.06em' }}>WICK DETECTION</div>
        {signal?.wick && signal.wick.pattern !== 'NONE' ? (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontWeight: 600, fontSize: 12, color: signal.wick.direction === 'BULLISH' ? 'var(--bull)' : signal.wick.direction === 'BEARISH' ? 'var(--bear)' : 'var(--dim)' }}>
              {signal.wick.pattern.replace('_', ' ')}
            </span>
            <span className="dim" style={{ fontSize: 11 }}>
              {(signal.wick.strength * 100).toFixed(0)}% strength
            </span>
          </div>
        ) : (
          <span className="dim" style={{ fontSize: 11 }}>No pattern detected</span>
        )}

        {/* Confidence */}
        {signal && (
          <div style={{ marginTop: 8 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
              <span className="dim" style={{ fontSize: 10 }}>CONFIDENCE</span>
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>
                {(signal.confidence * 100).toFixed(0)}%
              </span>
            </div>
            <div style={{ height: 4, background: 'var(--border)', borderRadius: 2, overflow: 'hidden' }}>
              <div style={{
                height: '100%', borderRadius: 2,
                width: `${(signal.confidence * 100).toFixed(0)}%`,
                background: `linear-gradient(90deg, var(--accent), ${isBull ? 'var(--bull)' : 'var(--bear)'})`,
                transition: 'width 0.5s ease',
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
