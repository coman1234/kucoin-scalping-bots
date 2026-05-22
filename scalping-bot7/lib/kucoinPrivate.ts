import crypto from "crypto";
import { promises as fs } from "fs";
import path from "path";

const CONFIG_PATH = path.join(process.cwd(), "data", "api-config.json");

async function loadCreds(): Promise<{ apiKey: string; apiSecret: string; apiPassphrase: string; sandboxMode: boolean }> {
  try {
    const raw = await fs.readFile(CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);
    if (cfg.apiKey && cfg.apiSecret && cfg.apiPassphrase) return cfg;
  } catch { /* fall through */ }
  return {
    apiKey:        process.env.KUCOIN_API_KEY        ?? "",
    apiSecret:     process.env.KUCOIN_API_SECRET      ?? "",
    apiPassphrase: process.env.KUCOIN_API_PASSPHRASE  ?? "",
    sandboxMode:   false,
  };
}

function sign(
  timestamp: string,
  method: string,
  endpoint: string,
  body: string,
  secret: string
): string {
  const message = timestamp + method.toUpperCase() + endpoint + body;
  return crypto.createHmac("sha256", secret).update(message).digest("base64");
}

function signPassphrase(passphrase: string, secret: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(passphrase)
    .digest("base64");
}

// Monotonically increasing timestamp — prevents signature collision under rapid requests
let _lastTs = 0;
function nextTimestamp(): string {
  let ts = Date.now();
  if (ts <= _lastTs) ts = _lastTs + 1;
  _lastTs = ts;
  return ts.toString();
}

async function buildHeaders(
  method: string,
  endpoint: string,
  body: string = ""
): Promise<Record<string, string>> {
  const creds = await loadCreds();
  const { apiKey, apiSecret, apiPassphrase } = creds;
  const timestamp = nextTimestamp();

  return {
    "Content-Type": "application/json",
    "KC-API-KEY": apiKey,
    "KC-API-TIMESTAMP": timestamp,
    "KC-API-PASSPHRASE": signPassphrase(apiPassphrase, apiSecret),
    "KC-API-SIGN": sign(timestamp, method, endpoint, body, apiSecret),
    "KC-API-KEY-VERSION": "2",
  };
}

async function getBaseUrl(): Promise<string> {
  const creds = await loadCreds();
  if (creds.sandboxMode) return "https://openapi-sandbox.kucoin.com";
  return process.env.KUCOIN_BASE_URL || "https://api.kucoin.com";
}

async function privateRequest<T>(
  method: string,
  path: string,
  body?: object
): Promise<T> {
  const bodyStr = body ? JSON.stringify(body) : "";
  const headers = await buildHeaders(method, path, bodyStr);
  const baseUrl = await getBaseUrl();
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyStr || undefined,
    next: { revalidate: 0 },
  });
  const json = await res.json();
  if (json.code !== "200000") {
    throw new Error(`KuCoin API ${method} ${path}: ${json.code} — ${json.msg}`);
  }
  if (json.data === undefined || json.data === null) {
    throw new Error(`KuCoin API ${method} ${path}: response missing data field`);
  }
  return json.data as T;
}

export interface AccountBalance {
  id: string;
  currency: string;
  type: string;
  balance: string;
  available: string;
  holds: string;
}

export interface PlaceOrderParams {
  clientOid: string;
  side: "buy" | "sell";
  symbol: string;
  type: "market" | "limit";
  size?: string;
  funds?: string;
  price?: string;
  timeInForce?: "GTC" | "GTT" | "IOC" | "FOK";
}

export interface PlaceOrderResult {
  orderId: string;
}

export interface StopOrderParams {
  clientOid: string;
  side: "buy" | "sell";
  symbol: string;
  type: "market" | "limit";
  size: string;
  price?: string;
  stopPrice: string;
  stop: "loss" | "entry";
  stopPriceType: "TP" | "IP" | "MP";
}

export interface OrderDetail {
  id: string;
  symbol: string;
  opType: string;
  type: string;
  side: string;
  price: string;
  size: string;
  funds: string;
  dealFunds: string;
  dealSize: string;
  fee: string;
  feeCurrency: string;
  stp: string;
  stop: string;
  stopTriggered: boolean;
  stopPrice: string;
  timeInForce: string;
  postOnly: boolean;
  hidden: boolean;
  iceberg: boolean;
  visibleSize: string;
  cancelAfter: number;
  channel: string;
  clientOid: string;
  remark: string | null;
  tags: string | null;
  isActive: boolean;
  cancelExist: boolean;
  createdAt: number;
  tradeType: string;
}

export async function getTradeAccounts(): Promise<AccountBalance[]> {
  return privateRequest<AccountBalance[]>(
    "GET",
    "/api/v1/accounts?type=trade"
  );
}

export async function placeOrder(
  params: PlaceOrderParams
): Promise<PlaceOrderResult> {
  return privateRequest<PlaceOrderResult>("POST", "/api/v1/orders", params);
}

export async function placeStopOrder(
  params: StopOrderParams
): Promise<PlaceOrderResult> {
  return privateRequest<PlaceOrderResult>(
    "POST",
    "/api/v1/stop-order",
    params
  );
}

export async function cancelAllOrders(symbol?: string): Promise<{ cancelledOrderIds: string[] }> {
  const path = symbol
    ? `/api/v1/orders?symbol=${encodeURIComponent(symbol)}`
    : "/api/v1/orders";
  return privateRequest("DELETE", path);
}

export async function cancelStopOrder(orderId: string): Promise<void> {
  await privateRequest("DELETE", `/api/v1/stop-order/${orderId}`);
}

export async function getOrderHistory(
  symbol?: string,
  limit = 50
): Promise<{ items: OrderDetail[]; totalNum: number }> {
  let path = `/api/v1/orders?status=done&pageSize=${limit}`;
  if (symbol) path += `&symbol=${encodeURIComponent(symbol)}`;
  return privateRequest("GET", path);
}

export async function getOrderDetail(orderId: string): Promise<OrderDetail> {
  return privateRequest<OrderDetail>("GET", `/api/v1/orders/${orderId}`);
}

export async function credentialsConfigured(): Promise<boolean> {
  const creds = await loadCreds();
  return Boolean(creds.apiKey && creds.apiSecret && creds.apiPassphrase);
}
