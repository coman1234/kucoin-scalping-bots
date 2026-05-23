/**
 * kucoinExec.ts — KuCoin private REST API for order execution (Bot C / day-trader)
 *
 * Handles HMAC-SHA256 signing, market/limit order placement, stop-loss orders,
 * position queries, and account balance reads.
 *
 * All public endpoints use the shared cache — this module is ONLY for writes
 * (orders) and authenticated reads (balance, open orders).
 */

import * as crypto from "node:crypto";
import * as https  from "node:https";
import * as fs     from "node:fs";
import * as path   from "node:path";

// ── Config ────────────────────────────────────────────────────────────────────
const BASE_URL = "https://api.kucoin.com";

// Mutable credentials — loaded from env at startup, overridden by data/api-config.json
// when saved via Settings UI.  reloadCredentials() is called by /api/config POST.
let _apiKey    = process.env.KUCOIN_API_KEY    ?? "";
let _apiSecret = process.env.KUCOIN_API_SECRET ?? "";
let _apiPassph = process.env.KUCOIN_PASSPHRASE ?? "";

const API_CONFIG_PATH = path.join(process.cwd(), "data", "api-config.json");

/** Load credentials from data/api-config.json (if present) — overwrites env defaults. */
export function reloadCredentials(): Promise<void> {
  return new Promise(resolve => {
    fs.readFile(API_CONFIG_PATH, "utf8", (err, raw) => {
      if (!err && raw) {
        try {
          const cfg = JSON.parse(raw) as {
            apiKey?: string; apiSecret?: string; apiPassphrase?: string;
          };
          if (cfg.apiKey)        _apiKey    = cfg.apiKey.trim();
          if (cfg.apiSecret)     _apiSecret = cfg.apiSecret.trim();
          if (cfg.apiPassphrase) _apiPassph = cfg.apiPassphrase.trim();
          const ok = !!(_apiKey && _apiSecret && _apiPassph);
          console.log(`[kucoinExec] Credentials reloaded — configured=${ok}`);
        } catch { /* malformed JSON — keep existing */ }
      }
      resolve();
    });
  });
}

// Load from disk on module startup (non-blocking)
reloadCredentials().catch(() => {});

// ── Order mode flags ──────────────────────────────────────────────────────────
/** True when the BOT6_DRY_RUN env var was set at startup. */
export const DRY_RUN = process.env.BOT6_DRY_RUN === "true";

/** Runtime simulation toggle (paper trading, UI-controlled). */
let _simMode  = false;
/** Runtime live override (explicit "Go Live" from UI, overrides DRY_RUN). */
let _liveMode = false;

export function setSimulationMode(v: boolean): void {
  _simMode  = v;
  if (v) _liveMode = false;
  console.log(`[kucoinExec] SimMode=${v}`);
}
export function setLiveMode(v: boolean): void {
  _liveMode = v;
  if (v) _simMode = false;
  console.log(`[kucoinExec] LiveMode=${v}`);
}
/** Returns true when orders should be simulated (not sent to exchange). */
export function isEffectiveDryRun(): boolean {
  if (_liveMode) return false;        // explicit live always wins
  return DRY_RUN || _simMode;
}
export function getCurrentMode(): "LIVE" | "SIM" | "DRY" {
  if (_liveMode)  return "LIVE";
  if (_simMode)   return "SIM";
  if (DRY_RUN)    return "DRY";
  return "LIVE";
}

if (!_apiKey || !_apiSecret || !_apiPassph) {
  console.warn("[kucoinExec] WARNING: credentials not set — configure via Settings UI or env vars");
}

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OrderParams {
  symbol:    string;         // e.g. "BTC-USDT"
  side:      "buy" | "sell";
  type:      "market" | "limit";
  size?:     string;         // base currency qty (for market sell)
  funds?:    string;         // quote currency qty (for market buy)
  price?:    string;         // required for limit
  clientOid?: string;        // idempotency key
  remark?:   string;
}

export interface StopOrderParams {
  symbol:    string;
  side:      "buy" | "sell";
  size:      string;         // base currency qty
  stopPrice: string;         // trigger price
  price?:    string;         // limit price (if type=limit); omit for market stop
  clientOid?: string;
  remark?:   string;
}

export interface PlaceOrderResult {
  orderId:  string;
  clientOid?: string;
}

export interface AccountBalance {
  currency:  string;
  balance:   string;   // total (available + holds)
  available: string;
  holds:     string;
}

export interface OpenOrder {
  id:          string;
  symbol:      string;
  side:        "buy" | "sell";
  type:        "market" | "limit";
  size:        string;
  price:       string;
  dealFunds:   string;
  dealSize:    string;
  isActive:    boolean;
  createdAt:   number;
}

export interface KuCoinError {
  code:    string;
  message: string;
}

// ── HMAC signing ──────────────────────────────────────────────────────────────
function sign(timestamp: string, method: string, reqPath: string, body: string): string {
  const str = `${timestamp}${method}${reqPath}${body}`;
  return crypto.createHmac("sha256", _apiSecret).update(str).digest("base64");
}

function passphraseSign(): string {
  return crypto.createHmac("sha256", _apiSecret).update(_apiPassph).digest("base64");
}

function authHeaders(method: "GET" | "POST" | "DELETE", reqPath: string, body = ""): Record<string, string> {
  const ts = String(Date.now());
  return {
    "KC-API-KEY":         _apiKey,
    "KC-API-SIGN":        sign(ts, method, reqPath, body),
    "KC-API-TIMESTAMP":   ts,
    "KC-API-PASSPHRASE":  passphraseSign(),
    "KC-API-KEY-VERSION": "2",
    "Content-Type":       "application/json",
  };
}

// ── Raw HTTP helper ───────────────────────────────────────────────────────────
function request<T>(
  method:   "GET" | "POST" | "DELETE",
  reqPath:  string,
  body?:    Record<string, unknown>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const bodyStr  = body ? JSON.stringify(body) : "";
    const headers  = authHeaders(method, reqPath, bodyStr);
    const url      = new URL(BASE_URL + reqPath);
    const options  = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method,
      headers:  {
        ...headers,
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr).toString() } : {}),
      },
    };

    const req = https.request(options, res => {
      let raw = "";
      res.on("data", chunk => { raw += chunk; });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(raw) as { code: string; data?: T; msg?: string };
          if (parsed.code !== "200000") {
            reject(new Error(`KuCoin error ${parsed.code}: ${parsed.msg ?? raw}`));
          } else {
            resolve(parsed.data as T);
          }
        } catch {
          reject(new Error(`JSON parse error: ${raw.slice(0, 200)}`));
        }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── Order placement ───────────────────────────────────────────────────────────

/**
 * Place a spot market or limit order.
 * For market BUY  → supply `funds`  (USDT notional)
 * For market SELL → supply `size`   (base currency)
 * For limit  → supply both `price` and `size`
 */
export async function placeOrder(params: OrderParams): Promise<PlaceOrderResult> {
  const clientOid = params.clientOid ?? `bot6-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const body: Record<string, unknown> = {
    clientOid,
    symbol: params.symbol,
    side:   params.side,
    type:   params.type,
  };
  if (params.size)   body.size   = params.size;
  if (params.funds)  body.funds  = params.funds;
  if (params.price)  body.price  = params.price;
  if (params.remark) body.remark = params.remark;

  const result = await request<{ orderId: string }>("POST", "/api/v1/orders", body);
  return { orderId: result.orderId, clientOid };
}

/**
 * Place a stop-loss order (stop-market or stop-limit).
 * Uses KuCoin's stop order endpoint (`/api/v1/stop-order`).
 * side = "sell" for long SL, "buy" for short SL.
 */
export async function placeStopOrder(params: StopOrderParams): Promise<PlaceOrderResult> {
  const clientOid = params.clientOid ?? `sl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const isLimit   = !!params.price;
  const body: Record<string, unknown> = {
    clientOid,
    symbol:    params.symbol,
    side:      params.side,
    type:      isLimit ? "limit" : "market",
    size:      params.size,
    stop:      params.side === "sell" ? "loss" : "entry",   // "loss" triggers when price falls
    stopPrice: params.stopPrice,
    ...(isLimit ? { price: params.price } : {}),
    ...(params.remark ? { remark: params.remark } : {}),
  };

  const result = await request<{ orderId: string }>("POST", "/api/v1/stop-order", body);
  return { orderId: result.orderId, clientOid };
}

/**
 * Cancel a regular order by KuCoin orderId.
 */
export async function cancelOrder(orderId: string): Promise<{ cancelledOrderIds: string[] }> {
  return request("DELETE", `/api/v1/orders/${orderId}`);
}

/**
 * Cancel a stop order by KuCoin orderId.
 */
export async function cancelStopOrder(orderId: string): Promise<{ cancelledOrderIds: string[] }> {
  return request("DELETE", `/api/v1/stop-order/${orderId}`);
}

// ── Account queries ───────────────────────────────────────────────────────────

/**
 * Fetch USDT trading account balance.
 */
export async function getUsdtBalance(): Promise<number> {
  const accounts = await request<AccountBalance[]>("GET", "/api/v1/accounts?currency=USDT&type=trade");
  const usdt = accounts.find(a => a.currency === "USDT" && a.available !== undefined);
  return usdt ? parseFloat(usdt.available) : 0;
}

/**
 * Fetch all trading account balances.
 */
export async function getAllBalances(): Promise<AccountBalance[]> {
  return request<AccountBalance[]>("GET", "/api/v1/accounts?type=trade");
}

/**
 * Fetch all currently open (active) orders for a given symbol.
 */
export async function getOpenOrders(symbol: string): Promise<OpenOrder[]> {
  const path   = `/api/v1/orders?status=active&symbol=${encodeURIComponent(symbol)}&tradeType=TRADE`;
  const result = await request<{ items: OpenOrder[] }>("GET", path);
  return result.items ?? [];
}

/**
 * Fetch a single order by its KuCoin orderId.
 */
export async function getOrder(orderId: string): Promise<OpenOrder> {
  return request<OpenOrder>("GET", `/api/v1/orders/${orderId}`);
}

// ── Convenience: market buy/sell with USDT notional ──────────────────────────

/**
 * Market buy `fundsUsdt` worth of `symbol`.
 * Returns the KuCoin orderId.
 */
export async function marketBuy(symbol: string, fundsUsdt: number, remark?: string): Promise<string> {
  const res = await placeOrder({
    symbol, side: "buy", type: "market",
    funds:  fundsUsdt.toFixed(2),
    remark: remark ?? "bot6-buy",
  });
  return res.orderId;
}

/**
 * Market sell `sizeBase` of `symbol`.
 * Returns the KuCoin orderId.
 */
export async function marketSell(symbol: string, sizeBase: string, remark?: string): Promise<string> {
  const res = await placeOrder({
    symbol, side: "sell", type: "market",
    size:   sizeBase,
    remark: remark ?? "bot6-sell",
  });
  return res.orderId;
}

// ── Dry-run / paper-trade guard ───────────────────────────────────────────────
// DRY_RUN is now declared above near the config block. Wrappers below.

/**
 * Wrapped order placement that respects BOT6_DRY_RUN=true.
 * In dry-run mode returns a fake orderId and logs the intent.
 */
export async function safePlaceOrder(params: OrderParams): Promise<PlaceOrderResult> {
  if (isEffectiveDryRun()) {
    const fakeId = `DRY-${Date.now()}`;
    console.log(`[${getCurrentMode()}] placeOrder:`, JSON.stringify(params), "→", fakeId);
    return { orderId: fakeId, clientOid: params.clientOid };
  }
  return placeOrder(params);
}

export async function safeMarketBuy(symbol: string, fundsUsdt: number, remark?: string): Promise<string> {
  if (isEffectiveDryRun()) {
    const fakeId = `${getCurrentMode()}-BUY-${Date.now()}`;
    console.log(`[${getCurrentMode()}] marketBuy: ${symbol} $${fundsUsdt.toFixed(2)} → ${fakeId}`);
    return fakeId;
  }
  return marketBuy(symbol, fundsUsdt, remark);
}

export async function safeMarketSell(symbol: string, sizeBase: string, remark?: string): Promise<string> {
  if (isEffectiveDryRun()) {
    const fakeId = `${getCurrentMode()}-SELL-${Date.now()}`;
    console.log(`[${getCurrentMode()}] marketSell: ${symbol} ${sizeBase} → ${fakeId}`);
    return fakeId;
  }
  return marketSell(symbol, sizeBase, remark);
}

export async function safePlaceStopOrder(params: StopOrderParams): Promise<PlaceOrderResult> {
  if (isEffectiveDryRun()) {
    const fakeId = `${getCurrentMode()}-SL-${Date.now()}`;
    console.log(`[${getCurrentMode()}] placeStopOrder:`, JSON.stringify(params), "→", fakeId);
    return { orderId: fakeId, clientOid: params.clientOid };
  }
  return placeStopOrder(params);
}

/**
 * Place a take-profit LIMIT order on KuCoin.
 * This is a resting limit order — it fills automatically when price reaches the TP.
 * Using a limit order (not stop-limit) so it shows on the book and fills at the
 * target price rather than triggering a new market order at potentially worse fill.
 *
 * Principle #7 / Secret #2: profit target placed ON THE EXCHANGE at entry time,
 * not just monitored by the polling loop. Survives process crashes.
 */
export async function safePlaceTpLimitOrder(
  symbol:   string,
  side:     "buy" | "sell",
  sizeBase: string,  // base currency quantity (e.g. "0.001" BTC)
  price:    string,  // limit price
  remark?:  string,
): Promise<PlaceOrderResult> {
  if (isEffectiveDryRun()) {
    const fakeId = `${getCurrentMode()}-TP-${Date.now()}`;
    console.log(`[${getCurrentMode()}] placeTpLimit: ${symbol} ${side} ${sizeBase} @${price} → ${fakeId}`);
    return { orderId: fakeId };
  }
  return placeOrder({
    symbol, side, type: "limit",
    size:   sizeBase,
    price,
    remark: remark ?? "bot6-tp",
  });
}

/**
 * Poll an order until it is filled (isActive = false) and return the average
 * fill price. Returns null if not filled within maxAttempts.
 *
 * Principle #2: verify entry fill before placing exit orders. The actual fill
 * price may differ from the signal price due to slippage — using it for SL/TP
 * calculation ensures exits are anchored to reality, not the pre-trade signal.
 */
export async function pollFillPrice(
  orderId:     string,
  maxAttempts: number = 6,
  delayMs:     number = 500,
): Promise<number | null> {
  if (isEffectiveDryRun()) return null;  // sim/dry: caller uses signal price as fallback

  for (let i = 0; i < maxAttempts; i++) {
    await new Promise<void>(r => setTimeout(r, delayMs));
    try {
      const order = await getOrder(orderId);
      if (!order.isActive) {
        const dealFunds = parseFloat(order.dealFunds ?? "0");
        const dealSize  = parseFloat(order.dealSize  ?? "0");
        if (dealSize > 0) {
          const fill = dealFunds / dealSize;
          if (isFinite(fill) && fill > 0) {
            console.log(`[kucoinExec] Fill confirmed: ${orderId} @${fill.toFixed(6)} (attempt ${i + 1})`);
            return fill;
          }
        }
      }
    } catch (e) {
      // transient error — retry
      console.warn(`[kucoinExec] pollFillPrice attempt ${i + 1} failed:`, e);
    }
  }

  console.warn(`[kucoinExec] pollFillPrice: no fill confirmed after ${maxAttempts} attempts for ${orderId}`);
  return null;
}
