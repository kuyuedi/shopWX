import { generateAuthHeaders } from '../utils/kalshiAuth.js';

// Kalshi API 配置
export interface ApiConfig {
  apiKey: string;
  privateKeyPath: string;
  restUrl: string;
}

// 自定义错误类，封装 Kalshi API 错误信息
export class KalshiApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'KalshiApiError';
  }
}

// 下单请求体
export interface CreateOrderRequest {
  ticker: string;           // 市场 ticker，例如 "KXBTC-25JAN-T30000"
  side: 'yes' | 'no';      // 买入方向
  action: 'buy' | 'sell';  // 操作类型
  type: 'limit' | 'market'; // 订单类型
  count: number;            // 合约数量（正整数）
  yes_price?: number;       // limit 订单时必填，单位：美分（1-99）
  expiration_ts?: number;   // 可选，Unix 时间戳（秒），订单过期时间
  client_order_id?: string; // 可选，客户端幂等 ID
}

// 下单响应
export interface CreateOrderResponse {
  order_id: string;
  client_order_id?: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: 'resting' | 'executed' | 'canceled' | 'pending';
  yes_price: number;        // 美分
  count: number;
  filled_count: number;
  remaining_count: number;
  created_time: string;     // ISO 8601
}

// 查询订单响应
export interface GetOrderResponse {
  order_id: string;
  ticker: string;
  side: 'yes' | 'no';
  action: 'buy' | 'sell';
  type: 'limit' | 'market';
  status: 'resting' | 'executed' | 'canceled' | 'pending';
  yes_price: number;
  count: number;
  filled_count: number;
  remaining_count: number;
  avg_fill_price?: number;  // 成交均价（美分）
  created_time: string;
  close_time?: string;
}

// 钱包余额响应
export interface GetBalanceResponse {
  balance: number;          // 账户余额，单位：美分
}

// 从 Kalshi API 响应中解析错误消息
async function parseErrorMessage(response: Response): Promise<string> {
  try {
    const body = await response.json() as { error?: unknown; message?: unknown };
    const msg = body.error ?? body.message;
    if (typeof msg === 'string') return msg;
    if (msg !== null && msg !== undefined) return JSON.stringify(msg);
    return `HTTP ${response.status}`;
  } catch {
    return `HTTP ${response.status}`;
  }
}

/**
 * 向 Kalshi 提交订单
 * @throws {KalshiApiError} 当输入校验失败或 Kalshi API 返回错误时
 */
export async function createKalshiOrder(
  body: CreateOrderRequest,
  config: ApiConfig
): Promise<CreateOrderResponse> {
  // 输入校验：count 必须为正整数
  if (!Number.isInteger(body.count) || body.count <= 0) {
    throw new KalshiApiError(400, 'count 必须为正整数');
  }
  // limit 订单时 yes_price 必须在 1-99 之间
  if (body.type === 'limit') {
    if (body.yes_price === undefined || body.yes_price < 1 || body.yes_price > 99) {
      throw new KalshiApiError(400, 'limit 订单的 yes_price 必须在 1 到 99 之间');
    }
  }

  // 签名路径使用完整路径，restUrl 已含 /trade-api/v2 前缀
  const fullPath = '/trade-api/v2/portfolio/orders';
  const apiPath = '/portfolio/orders';
  const authHeaders = generateAuthHeaders(config.apiKey, config.privateKeyPath, 'POST', fullPath);

  const response = await fetch(`${config.restUrl}${apiPath}`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ticker: body.ticker,
      side: body.side,
      action: body.action,
      type: body.type,
      count: body.count,
      ...(body.yes_price !== undefined && { yes_price: body.yes_price }),
      ...(body.expiration_ts !== undefined && { expiration_ts: body.expiration_ts }),
      ...(body.client_order_id !== undefined && { client_order_id: body.client_order_id }),
    }),
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new KalshiApiError(response.status, message);
  }

  const data = await response.json() as { order: CreateOrderResponse };
  return data.order;
}

/**
 * 查询 Kalshi 订单状态
 * @throws {KalshiApiError} 当订单不存在或 Kalshi API 返回错误时
 */
export async function getKalshiOrder(
  orderId: string,
  config: ApiConfig
): Promise<GetOrderResponse> {
  if (!orderId) {
    throw new KalshiApiError(400, 'orderId 不能为空');
  }

  // 签名路径使用完整路径，restUrl 已含 /trade-api/v2 前缀
  const fullPath = `/trade-api/v2/portfolio/orders/${orderId}`;
  const apiPath = `/portfolio/orders/${orderId}`;
  const authHeaders = generateAuthHeaders(config.apiKey, config.privateKeyPath, 'GET', fullPath);

  const response = await fetch(`${config.restUrl}${apiPath}`, {
    method: 'GET',
    headers: authHeaders,
  });

  if (response.status === 404) {
    throw new KalshiApiError(404, 'Order not found');
  }
  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new KalshiApiError(response.status, message);
  }

  const data = await response.json() as { order: GetOrderResponse };
  return data.order;
}

/**
 * 查询 Kalshi 账户余额
 * @throws {KalshiApiError} 当认证失败或 Kalshi API 返回错误时
 */
export async function getKalshiBalance(config: ApiConfig): Promise<GetBalanceResponse> {
  // 签名路径使用完整路径，restUrl 已含 /trade-api/v2 前缀
  const fullPath = '/trade-api/v2/portfolio/balance';
  const apiPath = '/portfolio/balance';
  const authHeaders = generateAuthHeaders(config.apiKey, config.privateKeyPath, 'GET', fullPath);

  const response = await fetch(`${config.restUrl}${apiPath}`, {
    method: 'GET',
    headers: authHeaders,
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new KalshiApiError(response.status, message);
  }

  const data = await response.json() as { balance: number };
  return { balance: data.balance };
}

/**
 * 查询 Kalshi 挂单列表
 * @param status 订单状态过滤，默认 resting（挂单中）
 */
export async function getKalshiOrders(
  config: ApiConfig,
  status: string = 'resting'
): Promise<GetOrderResponse[]> {
  const fullPath = '/trade-api/v2/portfolio/orders';
  const authHeaders = generateAuthHeaders(config.apiKey, config.privateKeyPath, 'GET', fullPath);

  const response = await fetch(`${config.restUrl}/portfolio/orders?status=${status}&limit=100`, {
    method: 'GET',
    headers: authHeaders,
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new KalshiApiError(response.status, message);
  }

  const data = await response.json() as { orders: GetOrderResponse[] };
  return data.orders ?? [];
}

// 持仓响应
export interface PositionResponse {
  ticker: string;
  side: 'yes' | 'no';
  position: number;           // 持仓数量
  market_exposure_dollars: string;
  realized_pnl_dollars: string;
  unrealized_pnl_dollars: string;
  total_traded_dollars: string;
  fees_paid_dollars: string;
  settlement_status?: string;
  settled_pnl_dollars?: string;
}

/**
 * 查询 Kalshi 持仓列表
 * @param settlementStatus 结算状态：all/settled/unsettled，默认 all
 */
export async function getKalshiPositions(
  config: ApiConfig,
  settlementStatus: string = 'all'
): Promise<PositionResponse[]> {
  const fullPath = '/trade-api/v2/portfolio/positions';
  const authHeaders = generateAuthHeaders(config.apiKey, config.privateKeyPath, 'GET', fullPath);

  const params = settlementStatus !== 'all' ? `?settlement_status=${settlementStatus}&limit=100` : '?limit=100';
  const response = await fetch(`${config.restUrl}/portfolio/positions${params}`, {
    method: 'GET',
    headers: authHeaders,
  });

  if (!response.ok) {
    const message = await parseErrorMessage(response);
    throw new KalshiApiError(response.status, message);
  }

  const data = await response.json() as { market_positions: PositionResponse[] };
  return data.market_positions ?? [];
}
