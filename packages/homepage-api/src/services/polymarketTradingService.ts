import { ClobClient, Side, OrderType, AssetType } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { createLogger } from '@prediction-market/shared';

const logger = createLogger('polymarket-trading');

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon 主网

// Polymarket API 配置
export interface PolymarketApiConfig {
  privateKey: string;
  apiKey: string;
  secret: string;
  passphrase: string;
  funderAddress?: string; // 代理钱包地址（Gnosis Safe）
}

// 自定义错误类
export class PolymarketApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'PolymarketApiError';
  }
}

// 创建 CLOB 客户端（L2 认证，Gnosis Safe 模式）
function createClient(config: PolymarketApiConfig): ClobClient {
  const wallet = new ethers.Wallet(config.privateKey);

  // ethers v6 适配器
  const signer = {
    getAddress: () => wallet.getAddress(),
    _signTypedData: (
      domain: Record<string, unknown>,
      types: Record<string, Array<{ name: string; type: string }>>,
      value: Record<string, unknown>
    ) => wallet.signTypedData(
      domain as Parameters<typeof wallet.signTypedData>[0],
      types as Parameters<typeof wallet.signTypedData>[1],
      value
    ),
  };

  return new ClobClient(
    CLOB_URL,
    CHAIN_ID,
    signer as never,
    { key: config.apiKey, secret: config.secret, passphrase: config.passphrase },
    0, // EOA 签名类型
  );
}

// 从环境变量获取配置
export function getPolymarketConfig(): PolymarketApiConfig {
  const privateKey = process.env['POLYMARKET_PRIVATE_KEY'];
  const apiKey = process.env['POLYMARKET_API_KEY'];
  const secret = process.env['POLYMARKET_API_SECRET'];
  const passphrase = process.env['POLYMARKET_API_PASSPHRASE'];
  const funderAddress = process.env['POLYMARKET_FUNDER_ADDRESS'];

  if (!privateKey) throw new PolymarketApiError(500, '缺少环境变量 POLYMARKET_PRIVATE_KEY');
  if (!apiKey) throw new PolymarketApiError(500, '缺少环境变量 POLYMARKET_API_KEY');
  if (!secret) throw new PolymarketApiError(500, '缺少环境变量 POLYMARKET_API_SECRET');
  if (!passphrase) throw new PolymarketApiError(500, '缺少环境变量 POLYMARKET_API_PASSPHRASE');

  return { privateKey, apiKey, secret, passphrase, funderAddress };
}

// 下单请求
export interface CreatePolymarketOrderRequest {
  token_id: string;        // 市场的 token_id（YES 或 NO token）
  side: 'BUY' | 'SELL';
  price: number;           // 0-1 之间的小数，如 0.65
  size: number;            // USDC 金额
  order_type?: 'GTC' | 'FOK';  // 默认 GTC
}

/**
 * 查询 USDC 余额和授权额度
 */
export async function getPolymarketBalance(config: PolymarketApiConfig): Promise<unknown> {
  try {
    const client = createClient(config);
    const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return result;
  } catch (err) {
    logger.error({ err }, '查询余额失败');
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(500, msg);
  }
}

/**
 * 下单
 */
export async function createPolymarketOrder(
  body: CreatePolymarketOrderRequest,
  config: PolymarketApiConfig
): Promise<unknown> {
  try {
    const client = createClient(config);
    const side = body.side === 'BUY' ? Side.BUY : Side.SELL;

    const result = await client.createAndPostOrder({
      tokenID: body.token_id,
      price: body.price,
      side,
      size: body.size,
    });
    return result;
  } catch (err) {
    logger.error({ err }, '下单失败');
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(500, msg);
  }
}

/**
 * 查询挂单列表
 */
export async function getPolymarketOrders(
  config: PolymarketApiConfig,
  market?: string
): Promise<unknown[]> {
  try {
    const client = createClient(config);
    const params = market ? { market } : {};
    const orders = await client.getOpenOrders(params);
    return Array.isArray(orders) ? orders : [];
  } catch (err) {
    logger.error({ err }, '查询订单失败');
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(500, msg);
  }
}

/**
 * 查询单个订单
 */
export async function getPolymarketOrder(
  orderId: string,
  config: PolymarketApiConfig
): Promise<unknown> {
  try {
    const client = createClient(config);
    const order = await client.getOrder(orderId);
    return order;
  } catch (err) {
    logger.error({ err }, '查询订单失败');
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(500, msg);
  }
}

/**
 * 取消订单
 */
export async function cancelPolymarketOrder(
  orderId: string,
  config: PolymarketApiConfig
): Promise<unknown> {
  try {
    const client = createClient(config);
    const result = await client.cancelOrder({ orderID: orderId });
    return result;
  } catch (err) {
    logger.error({ err }, '取消订单失败');
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(500, msg);
  }
}

/**
 * 查询成交记录
 */
export async function getPolymarketTrades(
  config: PolymarketApiConfig,
  market?: string
): Promise<unknown[]> {
  try {
    const client = createClient(config);
    const params = market ? { market } : {};
    const trades = await client.getTrades(params);
    return Array.isArray(trades) ? trades : [];
  } catch (err) {
    logger.error({ err }, '查询成交记录失败');
    const msg = err instanceof Error ? err.message : String(err);
    throw new PolymarketApiError(500, msg);
  }
}
