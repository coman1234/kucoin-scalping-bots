// ─── KuCoin WebSocket Feed ───────────────────────────────────────────────────
//
// Maintains a single authenticated WebSocket connection.
// Emits live candle updates to registered callbacks.
// Auto-reconnects on drop with exponential back-off (max 30s).
// Handles KuCoin's ping/pong keepalive protocol.

import WebSocket from 'ws';
import { getPublicWsToken, WsToken } from './kuCoinClient';
import { Candle } from './types';

export type CandleCallback = (candle: Candle, symbol: string, isClosed: boolean) => void;
export type TickerCallback = (price: number, symbol: string) => void;

interface KuCoinCandleMsg {
  type: 'message';
  topic: string;
  subject: 'trade.candles.update' | 'trade.candles.add';
  data: {
    symbol: string;
    candles: [string, string, string, string, string, string, string]; // ts,open,close,high,low,vol,turnover
    time: number;
  };
}

interface KuCoinTickerMsg {
  type: 'message';
  topic: string;
  subject: 'trade.ticker';
  data: { price: string; time: number; symbol?: string };
}

export class KuCoinFeed {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1000;
  private readonly maxReconnectDelay = 30_000;
  private isRunning = false;

  private candleCallbacks = new Map<string, CandleCallback[]>();
  private tickerCallbacks = new Map<string, TickerCallback[]>();
  private subscribedTopics = new Set<string>();

  // ── Public API ──────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    this.isRunning = true;
    await this.connect();
  }

  stop(): void {
    this.isRunning = false;
    this.clearPing();
    this.ws?.close();
    this.ws = null;
  }

  onCandle(symbol: string, interval: string, cb: CandleCallback): void {
    const topic = `/market/candles:${symbol}_${interval}`;
    if (!this.candleCallbacks.has(topic)) this.candleCallbacks.set(topic, []);
    this.candleCallbacks.get(topic)!.push(cb);
    this.subscribe(topic);
  }

  onTicker(symbol: string, cb: TickerCallback): void {
    const topic = `/market/ticker:${symbol}`;
    if (!this.tickerCallbacks.has(topic)) this.tickerCallbacks.set(topic, []);
    this.tickerCallbacks.get(topic)!.push(cb);
    this.subscribe(topic);
  }

  // ── Connection lifecycle ────────────────────────────────────────────────────

  private async connect(): Promise<void> {
    let token: WsToken;
    try {
      token = await getPublicWsToken();
    } catch (err) {
      console.error('[WS] Failed to get token:', err);
      this.scheduleReconnect();
      return;
    }

    const url = `${token.endpoint}?token=${token.token}&connectId=${Date.now()}`;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[WS] Connected to KuCoin');
      this.reconnectDelay = 1000;
      this.startPing(token.pingInterval);
      // Resubscribe to all topics after reconnect
      for (const topic of this.subscribedTopics) {
        this.sendSubscribe(topic);
      }
    });

    this.ws.on('message', (raw: Buffer) => {
      try {
        this.handleMessage(JSON.parse(raw.toString()));
      } catch {
        // malformed message — ignore
      }
    });

    this.ws.on('close', () => {
      console.warn('[WS] Connection closed');
      this.clearPing();
      if (this.isRunning) this.scheduleReconnect();
    });

    this.ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
    });
  }

  private scheduleReconnect(): void {
    setTimeout(async () => {
      console.log(`[WS] Reconnecting in ${this.reconnectDelay}ms…`);
      await this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  // ── Message handling ────────────────────────────────────────────────────────

  private handleMessage(msg: Record<string, unknown>): void {
    if (msg.type === 'pong') return;
    if (msg.type === 'welcome') return;
    if (msg.type === 'ack') return;

    if (msg.type === 'message') {
      const topic = msg.topic as string;

      if (topic?.includes('/market/candles')) {
        this.handleCandle(msg as unknown as KuCoinCandleMsg);
      } else if (topic?.includes('/market/ticker')) {
        this.handleTicker(msg as unknown as KuCoinTickerMsg);
      }
    }
  }

  private handleCandle(msg: KuCoinCandleMsg): void {
    const { candles, symbol } = msg.data;
    // KuCoin candle array: [timestamp, open, close, high, low, volume, turnover]
    const candle: Candle = {
      timestamp: parseInt(candles[0]) * 1000,
      open: parseFloat(candles[1]),
      close: parseFloat(candles[2]),
      high: parseFloat(candles[3]),
      low: parseFloat(candles[4]),
      volume: parseFloat(candles[5]),
    };

    const isClosed = msg.subject === 'trade.candles.add';
    const cbs = this.candleCallbacks.get(msg.topic);
    if (cbs) cbs.forEach((cb) => cb(candle, symbol, isClosed));
  }

  private handleTicker(msg: KuCoinTickerMsg): void {
    const price = parseFloat(msg.data.price);
    const symbol = msg.data.symbol ?? msg.topic.split(':')[1];
    const cbs = this.tickerCallbacks.get(msg.topic);
    if (cbs) cbs.forEach((cb) => cb(price, symbol));
  }

  // ── Subscription management ─────────────────────────────────────────────────

  private subscribe(topic: string): void {
    this.subscribedTopics.add(topic);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.sendSubscribe(topic);
    }
  }

  private sendSubscribe(topic: string): void {
    this.ws?.send(JSON.stringify({
      id: Date.now().toString(),
      type: 'subscribe',
      topic,
      privateChannel: false,
      response: true,
    }));
  }

  // ── Ping keepalive ──────────────────────────────────────────────────────────

  private startPing(intervalMs: number): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ id: Date.now().toString(), type: 'ping' }));
      }
    }, intervalMs);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }
}

// Singleton for the process lifetime
let feed: KuCoinFeed | null = null;

export function getFeed(): KuCoinFeed {
  if (!feed) feed = new KuCoinFeed();
  return feed;
}
