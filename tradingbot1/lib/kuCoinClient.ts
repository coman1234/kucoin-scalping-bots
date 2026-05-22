// ─── KuCoin REST Client — HMAC-SHA256 authenticated ─────────────────────────
//
// KuCoin API v2 signature scheme:
//   sign  = base64( HMAC-SHA256( timestamp+method+path+body, secret ) )
//   passphrase = base64( HMAC-SHA256( passphrase, secret ) )   (v2 only)
//
// Credentials are read exclusively from environment variables.
// Never pass secrets as function arguments.

import crypto from 'crypto';
import { Candle } from './types';

// ── Config from environment ───────────────────────────────────────────────────
function getConfig() {
  const key = process.env.KUCOIN_API_KEY;
  const secret = process.env.KUCOIN_API_SECRET;
  const passphrase = process.env.KUCOIN_API_PASSPHRASE;
  const baseUrl = process.env.KUCOIN_BASE_URL ?? 'https://api.kucoin.com';

  if (!key || !secret || !passphrase) {
    throw new Error(
      'Missing KuCoin credentials. Set KUCOIN_API_KEY, KUCOIN_API_SECRET, ' +
      'KUCOIN_API_PASSPHRASE in .env.local'
    );
  }
  return { key, secret, passphrase, baseUrl };
}

// ── HMAC-SHA256 helpers ───────────────────────────────────────────────────────
function hmac256(data: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('base64');
}

function buildHeaders(
  method: string,
  path: string,
  body: string,
  key: string,
  secret: string,
  passphrase: string
): Record<string, string> {
  const timestamp = Date.now().toString();
  const preHash = timestamp + method.toUpperCase() + path + body;
  return {
    'KC-API-KEY': key,
    'KC-API-SIGN': hmac256(preHash, secret),
    'KC-API-TIMESTAMP': timestamp,
    'KC-API-PASSPHRASE': hmac256(passphrase, secret),
    'KC-API-KEY-VERSION': '2',
    'Content-Type': 'application/json',
  };
}

// ── Generic authenticated request ────────────────────────────────────────────
async function request<T>(
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: object
): Promise<T> {
  const { key, secret, passphrase, baseUrl } = getConfig();
  const bodyStr = body ? JSON.stringify(body) : '';
  const headers = buildHeaders(method, path, bodyStr, key, secret, passphrase);

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyStr || undefined,
  });

  const json = await res.json() as { code: string; data: T; msg?: string };

  if (json.code !== '200000') {
    throw new Error(`KuCoin API error [${json.code}]: ${json.msg ?? 'unknown'}`);
  }
  return json.data;
}

// ── Public request (no auth needed) ──────────────────────────────────────────
async function publicRequest<T>(path: string): Promise<T> {
  const { baseUrl } = getConfig();
  const res = await fetch(`${baseUrl}${path}`);
  const json = await res.json() as { code: string; data: T; msg?: string };
  if (json.code !== '200000') {
    throw new Error(`KuCoin API error [${json.code}]: ${json.msg ?? 'unknown'}`);
  }
  return json.data;
}

// ── Market Data ───────────────────────────────────────────────────────────────

export type KuCoinInterval =
  | '1min' | '3min' | '5min' | '15min' | '30min'
  | '1hour' | '2hour' | '4hour' | '6hour' | '8hour' | '12hour'
  | '1day' | '1week';

// Returns candles in ascending time order (oldest first)
export async function fetchCandles(
  symbol: string,
  interval: KuCoinInterval,
  limit = 200
): Promise<Candle[]> {
  const endAt = Math.floor(Date.now() / 1000);
  // KuCoin interval to seconds map
  const intervalSeconds: Record<KuCoinInterval, number> = {
    '1min': 60, '3min': 180, '5min': 300, '15min': 900, '30min': 1800,
    '1hour': 3600, '2hour': 7200, '4hour': 14400, '6hour': 21600,
    '8hour': 28800, '12hour': 43200, '1day': 86400, '1week': 604800,
  };
  const startAt = endAt - intervalSeconds[interval] * limit;

  const path =
    `/api/v1/market/candles?type=${interval}&symbol=${symbol}` +
    `&startAt=${startAt}&endAt=${endAt}`;

  // KuCoin returns [timestamp, open, close, high, low, volume, turnover]
  // Note: KuCoin returns newest-first, so we reverse
  const raw = await publicRequest<string[][]>(path);
  return raw
    .map(([ts, open, close, high, low, volume]) => ({
      timestamp: parseInt(ts) * 1000,
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      volume: parseFloat(volume),
    }))
    .reverse(); // oldest first
}

export async function fetchTicker(symbol: string): Promise<{ price: number; time: number }> {
  const data = await publicRequest<{ price: string; time: number }>(
    `/api/v1/market/orderbook/level1?symbol=${symbol}`
  );
  return { price: parseFloat(data.price), time: data.time };
}

// ── Account ───────────────────────────────────────────────────────────────────

export interface AccountBalance {
  currency: string;
  balance: number;
  available: number;
  holds: number;
}

export async function fetchAccountBalance(currency = 'USDT'): Promise<AccountBalance> {
  const accounts = await request<Array<{
    currency: string;
    balance: string;
    available: string;
    holds: string;
    type: string;
  }>>('GET', '/api/v1/accounts');

  const match = accounts.find(
    (a) => a.currency === currency && a.type === 'trade'
  );
  if (!match) throw new Error(`No trading account found for ${currency}`);

  return {
    currency: match.currency,
    balance: parseFloat(match.balance),
    available: parseFloat(match.available),
    holds: parseFloat(match.holds),
  };
}

// ── Orders ────────────────────────────────────────────────────────────────────

export type OrderSide = 'buy' | 'sell';
export type OrderType = 'market' | 'limit';

export interface PlaceOrderParams {
  symbol: string;
  side: OrderSide;
  type: OrderType;
  size?: string;    // base currency quantity
  funds?: string;   // quote currency amount (for market buy)
  price?: string;   // required for limit orders
  clientOid?: string;
  stopPrice?: string;
  stopDirection?: 'UP' | 'DOWN';
}

export interface OrderResult {
  orderId: string;
}

export async function placeOrder(params: PlaceOrderParams): Promise<OrderResult> {
  const body = {
    clientOid: params.clientOid ?? crypto.randomUUID(),
    side: params.side,
    symbol: params.symbol,
    type: params.type,
    ...(params.size && { size: params.size }),
    ...(params.funds && { funds: params.funds }),
    ...(params.price && { price: params.price }),
  };
  return request<OrderResult>('POST', '/api/v1/orders', body);
}

export async function cancelOrder(orderId: string): Promise<void> {
  await request('DELETE', `/api/v1/orders/${orderId}`);
}

export interface OrderDetail {
  id: string;
  symbol: string;
  side: OrderSide;
  type: OrderType;
  price: string;
  size: string;
  dealSize: string;
  dealFunds: string;
  fee: string;
  isActive: boolean;
  cancelExist: boolean;
  createdAt: number;
}

export async function getOrder(orderId: string): Promise<OrderDetail> {
  return request<OrderDetail>('GET', `/api/v1/orders/${orderId}`);
}

// ── Stop-Loss / Take-Profit orders (KuCoin stop orders) ──────────────────────

export interface StopOrderParams {
  symbol: string;
  side: OrderSide;
  size: string;
  stopPrice: string;
  limitPrice?: string; // if omitted, becomes stop-market
}

export async function placeStopOrder(params: StopOrderParams): Promise<OrderResult> {
  const body = {
    clientOid: crypto.randomUUID(),
    side: params.side,
    symbol: params.symbol,
    type: params.limitPrice ? 'limit' : 'market',
    size: params.size,
    stop: params.side === 'sell' ? 'loss' : 'entry',
    stopPrice: params.stopPrice,
    ...(params.limitPrice && { price: params.limitPrice }),
  };
  return request<OrderResult>('POST', '/api/v1/stop-order', body);
}

export async function cancelStopOrder(orderId: string): Promise<void> {
  await request('DELETE', `/api/v1/stop-order/${orderId}`);
}

// ── WebSocket token (needed before opening WS connection) ────────────────────

export interface WsToken {
  token: string;
  endpoint: string;
  pingInterval: number;
}

export async function getPrivateWsToken(): Promise<WsToken> {
  const data = await request<{
    token: string;
    instanceServers: Array<{ endpoint: string; pingInterval: number }>;
  }>('POST', '/api/v1/bullet-private');

  const server = data.instanceServers[0];
  return {
    token: data.token,
    endpoint: server.endpoint,
    pingInterval: server.pingInterval,
  };
}

export async function getPublicWsToken(): Promise<WsToken> {
  const res = await fetch(`${getConfig().baseUrl}/api/v1/bullet-public`, {
    method: 'POST',
  });
  const json = await res.json() as {
    code: string;
    data: { token: string; instanceServers: Array<{ endpoint: string; pingInterval: number }> };
  };
  const server = json.data.instanceServers[0];
  return {
    token: json.data.token,
    endpoint: server.endpoint,
    pingInterval: server.pingInterval,
  };
}
