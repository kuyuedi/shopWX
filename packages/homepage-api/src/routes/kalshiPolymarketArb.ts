import type { FastifyInstance } from 'fastify';
import { createLogger } from '@prediction-market/shared';
import {
  scanKalshiPolymarket,
  arbCache,
  type ArbitrageReport,
} from '../services/kalshiPolymarketScanner.js';
import {
  getKalshiBalance,
  createKalshiOrder,
  KalshiApiError,
  type ApiConfig,
} from '../services/kalshiTradingService.js';
import {
  getPolymarketBalance,
  createPolymarketOrder,
  getPolymarketConfig,
  PolymarketApiError,
} from '../services/polymarketTradingService.js';

const logger = createLogger('kalshi-polymarket-arb-route');

// 价格数据新鲜度阈值（秒）
const DATA_FRESHNESS_SEC = 60;

// 从环境变量构造 Kalshi API 配置
function getKalshiConfig(): ApiConfig {
  const apiKey = process.env['KALSHI_API_KEY'];
  const privateKeyPath = process.env['KALSHI_PRIVATE_KEY_PATH'];
  const restUrl = process.env['KALSHI_REST_URL'] ?? 'https://trading-api.kalshi.com/trade-api/v2';

  if (!apiKey) throw new Error('缺少环境变量 KALSHI_API_KEY');
  if (!privateKeyPath) throw new Error('缺少环境变量 KALSHI_PRIVATE_KEY_PATH');

  return { apiKey, privateKeyPath, restUrl };
}

// GET 接口查询参数类型
interface ScanQuerystring {
  min_spread_pct?: number;
  arb_type?: 'DIRECT' | 'COMPLEMENT';
}

// POST 执行接口路径参数类型
interface ExecuteParams {
  arbId: string;
}

// POST 执行接口请求体类型
interface ExecuteBody {
  qty?: number;
}

// 执行结果响应类型
interface ExecuteResponse {
  arb_id: string;
  kalshi_order_id: string | null;
  polymarket_order_id: string | null;
  executed_qty: number;
  kalshi_success: boolean;
  polymarket_success: boolean;
  kalshi_error: string | null;
  polymarket_error: string | null;
}

// 从 Polymarket 余额响应中提取 USDC 余额（单位：美元）
function extractPolymarketBalance(raw: unknown): number {
  // getBalanceAllowance 返回 { balance: string, allowance: string }，单位为 USDC（6 位小数）
  if (raw && typeof raw === 'object' && 'balance' in raw) {
    const balance = (raw as Record<string, unknown>)['balance'];
    if (typeof balance === 'string') return parseFloat(balance) / 1_000_000;
    if (typeof balance === 'number') return balance / 1_000_000;
  }
  return 0;
}

// 从 Polymarket 下单响应中提取订单 ID
function extractPolymarketOrderId(raw: unknown): string | null {
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    // createAndPostOrder 返回 { orderID: string } 或 { order: { id: string } }
    if (typeof obj['orderID'] === 'string') return obj['orderID'];
    if (obj['order'] && typeof obj['order'] === 'object') {
      const order = obj['order'] as Record<string, unknown>;
      if (typeof order['id'] === 'string') return order['id'];
    }
  }
  return null;
}

export async function kalshiPolymarketArbRoute(fastify: FastifyInstance): Promise<void> {
  // ── GET /api/v1/arb/kalshi-polymarket — 触发扫描，返回套利机会列表 ──────────

  fastify.get<{ Querystring: ScanQuerystring }>(
    '/api/v1/arb/kalshi-polymarket',
    {
      schema: {
        description: '触发 Kalshi-Polymarket 跨平台套利扫描，返回当前所有待确认机会',
        tags: ['Arbitrage'],
        querystring: {
          type: 'object',
          properties: {
            min_spread_pct: {
              type: 'number',
              description: '最小价差百分比过滤（如 0.05 表示 5%）',
            },
            arb_type: {
              type: 'string',
              enum: ['DIRECT', 'COMPLEMENT'],
              description: '套利类型过滤',
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // 触发实时扫描
        const result = await scanKalshiPolymarket();

        // 应用查询参数过滤
        let opportunities: ArbitrageReport[] = result.reports;

        const { min_spread_pct, arb_type } = request.query;

        if (min_spread_pct !== undefined) {
          opportunities = opportunities.filter(o => o.grossSpreadPct >= min_spread_pct);
        }

        if (arb_type !== undefined) {
          opportunities = opportunities.filter(o => o.arbType === arb_type);
        }

        return reply.status(200).send({
          opportunities,
          scanned_at: result.scannedAt.toISOString(),
          opportunity_ttl_sec: result.opportunityTtlSec,
          count: opportunities.length,
        });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error({ err: error }, '套利扫描失败');
        return reply.status(500).send({ error: `扫描失败：${msg}` });
      }
    }
  );

  // ── POST /api/v1/arb/kalshi-polymarket/:arbId/execute — 执行双腿下单 ────────

  fastify.post<{ Params: ExecuteParams; Body: ExecuteBody }>(
    '/api/v1/arb/kalshi-polymarket/:arbId/execute',
    {
      schema: {
        description: '执行指定套利机会的双腿下单',
        tags: ['Arbitrage'],
        params: {
          type: 'object',
          required: ['arbId'],
          properties: {
            arbId: { type: 'string', description: '套利机会唯一标识符（UUID）' },
          },
        },
        body: {
          type: 'object',
          properties: {
            qty: { type: 'number', description: '执行数量（可选，不填则使用 executableQty）' },
          },
        },
      },
    },
    async (request, reply) => {
      const { arbId } = request.params;

      // ── 步骤 1：从缓存查找套利机会 ──────────────────────────────────────────
      const cached = arbCache.get(arbId);

      if (cached === null) {
        return reply.status(404).send({ error: '套利机会不存在，请重新扫描' });
      }

      if ('expired' in cached && cached.expired === true) {
        return reply.status(410).send({ error: '套利机会已过期，请重新调用扫描接口' });
      }

      const report = cached as ArbitrageReport;

      // ── 步骤 2：验证价格数据新鲜度（60 秒内） ───────────────────────────────
      const now = Date.now();
      const leg1Age = (now - report.leg1DataAt.getTime()) / 1000;
      const leg2Age = (now - report.leg2DataAt.getTime()) / 1000;

      if (leg1Age > DATA_FRESHNESS_SEC || leg2Age > DATA_FRESHNESS_SEC) {
        return reply.status(422).send({ error: '价格数据已过期，请重新扫描' });
      }

      // ── 步骤 3：解析执行数量 ─────────────────────────────────────────────────
      const executableQty = report.executableQty;
      const requestedQty = request.body?.qty;

      if (requestedQty !== undefined && requestedQty > executableQty) {
        return reply.status(400).send({
          error: `执行数量超过可执行上限 ${executableQty}`,
        });
      }

      const qty = requestedQty ?? executableQty;

      // ── 步骤 4：确定两腿参数 ─────────────────────────────────────────────────
      // 找出 Kalshi 腿和 Polymarket 腿
      const kalshiLeg = report.leg1.platform === 'KALSHI' ? report.leg1 : report.leg2;
      const polymarketLeg = report.leg1.platform === 'POLYMARKET' ? report.leg1 : report.leg2;

      // ── 步骤 5：并发查询两平台余额 ───────────────────────────────────────────
      let kalshiConfig: ApiConfig;
      try {
        kalshiConfig = getKalshiConfig();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: `Kalshi 配置错误：${msg}` });
      }

      let polymarketConfig;
      try {
        polymarketConfig = getPolymarketConfig();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return reply.status(500).send({ error: `Polymarket 配置错误：${msg}` });
      }

      const [kalshiBalanceResult, polymarketBalanceResult] = await Promise.allSettled([
        getKalshiBalance(kalshiConfig),
        getPolymarketBalance(polymarketConfig),
      ]);

      // 验证 Kalshi 余额（单位：美分，需转换为美元）
      if (kalshiBalanceResult.status === 'rejected') {
        const msg = kalshiBalanceResult.reason instanceof Error
          ? kalshiBalanceResult.reason.message
          : String(kalshiBalanceResult.reason);
        return reply.status(500).send({ error: `查询 Kalshi 余额失败：${msg}` });
      }

      // Kalshi 余额单位为美分，转换为美元
      const kalshiBalanceCents = kalshiBalanceResult.value.balance;
      const kalshiBalanceUsd = kalshiBalanceCents / 100;
      // 各腿成本 = qty × normalizedPrice（美元）
      const kalshiCostUsd = qty * kalshiLeg.normalizedPrice;

      if (kalshiBalanceUsd < kalshiCostUsd) {
        return reply.status(402).send({
          error: `Kalshi 余额不足，需要 ${kalshiCostUsd.toFixed(2)}，当前 ${kalshiBalanceUsd.toFixed(2)}`,
        });
      }

      // 验证 Polymarket 余额
      if (polymarketBalanceResult.status === 'rejected') {
        const msg = polymarketBalanceResult.reason instanceof Error
          ? polymarketBalanceResult.reason.message
          : String(polymarketBalanceResult.reason);
        return reply.status(500).send({ error: `查询 Polymarket 余额失败：${msg}` });
      }

      const polymarketBalanceUsd = extractPolymarketBalance(polymarketBalanceResult.value);
      const polymarketCostUsd = qty * polymarketLeg.normalizedPrice;

      if (polymarketBalanceUsd < polymarketCostUsd) {
        return reply.status(402).send({
          error: `Polymarket 余额不足，需要 ${polymarketCostUsd.toFixed(2)}，当前 ${polymarketBalanceUsd.toFixed(2)}`,
        });
      }

      // ── 步骤 6：并发向两平台下单 ─────────────────────────────────────────────
      // Kalshi 价格：归一化价格 × 100 取整（美分整数）
      const kalshiPriceCents = Math.round(kalshiLeg.normalizedPrice * 100);
      // Polymarket 价格：直接使用归一化价格（0-1 小数）
      const polymarketPrice = polymarketLeg.normalizedPrice;

      const [kalshiOrderResult, polymarketOrderResult] = await Promise.allSettled([
        createKalshiOrder(
          {
            ticker: kalshiLeg.marketId,
            side: kalshiLeg.side === 'YES' ? 'yes' : 'no',
            action: kalshiLeg.action === 'BUY' ? 'buy' : 'sell',
            type: 'limit',
            count: qty,
            yes_price: kalshiPriceCents,
            // 使用 arbId 派生的幂等 ID，防止重复下单
            client_order_id: `arb-${arbId}-kalshi`,
          },
          kalshiConfig
        ),
        createPolymarketOrder(
          {
            token_id: polymarketLeg.marketId,
            side: polymarketLeg.action === 'BUY' ? 'BUY' : 'SELL',
            price: polymarketPrice,
            size: qty,
          },
          polymarketConfig
        ),
      ]);

      // ── 步骤 7：构造响应 ─────────────────────────────────────────────────────
      const response: ExecuteResponse = {
        arb_id: arbId,
        kalshi_order_id: null,
        polymarket_order_id: null,
        executed_qty: qty,
        kalshi_success: false,
        polymarket_success: false,
        kalshi_error: null,
        polymarket_error: null,
      };

      // 处理 Kalshi 下单结果
      if (kalshiOrderResult.status === 'fulfilled') {
        response.kalshi_success = true;
        response.kalshi_order_id = kalshiOrderResult.value.order_id;
      } else {
        const err = kalshiOrderResult.reason;
        response.kalshi_error = err instanceof KalshiApiError || err instanceof Error
          ? err.message
          : String(err);
        logger.warn({ arbId, err }, 'Kalshi 下单失败');
      }

      // 处理 Polymarket 下单结果
      if (polymarketOrderResult.status === 'fulfilled') {
        response.polymarket_success = true;
        response.polymarket_order_id = extractPolymarketOrderId(polymarketOrderResult.value);
      } else {
        const err = polymarketOrderResult.reason;
        response.polymarket_error = err instanceof PolymarketApiError || err instanceof Error
          ? err.message
          : String(err);
        logger.warn({ arbId, err }, 'Polymarket 下单失败');
      }

      // 无论两腿是否均成功，均返回 HTTP 200（部分失败是有效业务状态）
      return reply.status(200).send(response);
    }
  );
}
