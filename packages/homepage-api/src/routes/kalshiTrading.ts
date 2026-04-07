import type { FastifyInstance } from 'fastify';
import {
  createKalshiOrder,
  getKalshiOrder,
  getKalshiBalance,
  getKalshiOrders,
  getKalshiPositions,
  KalshiApiError,
  type ApiConfig,
  type CreateOrderRequest,
} from '../services/kalshiTradingService.js';

// 从环境变量构造 Kalshi API 配置
function getApiConfig(): ApiConfig {
  const apiKey = process.env['KALSHI_API_KEY'];
  const privateKeyPath = process.env['KALSHI_PRIVATE_KEY_PATH'];
  const restUrl = process.env['KALSHI_REST_URL'] ?? 'https://trading-api.kalshi.com';

  if (!apiKey) throw new Error('缺少环境变量 KALSHI_API_KEY');
  if (!privateKeyPath) throw new Error('缺少环境变量 KALSHI_PRIVATE_KEY_PATH');

  return { apiKey, privateKeyPath, restUrl };
}

// 将 KalshiApiError 状态码映射为对外响应状态码
function mapStatusCode(statusCode: number): number {
  if (statusCode === 401) return 401;
  if (statusCode === 403) return 403;
  if (statusCode === 404) return 404;
  if (statusCode === 429) return 429;
  if (statusCode === 400) return 400;
  if (statusCode >= 500) return 502;
  return 500;
}

// 统一错误处理
function handleError(error: unknown, reply: { status: (code: number) => { send: (data: unknown) => void } }): void {
  if (error instanceof KalshiApiError) {
    reply.status(mapStatusCode(error.statusCode)).send({ error: String(error.message) });
  } else if (error instanceof Error) {
    reply.status(500).send({ error: error.message });
  } else {
    reply.status(500).send({ error: String(error) });
  }
}

export async function kalshiTradingRoute(fastify: FastifyInstance): Promise<void> {
  // POST /api/v1/kalshi/orders — 下单
  fastify.post<{ Body: CreateOrderRequest }>(
    '/api/v1/kalshi/orders',
    {
      schema: {
        description: '向 Kalshi 提交订单',
        tags: ['Kalshi Trading'],
      },
    },
    async (request, reply) => {
      try {
        const config = getApiConfig();
        const order = await createKalshiOrder(request.body, config);
        return reply.status(201).send(order);
      } catch (error) {
        handleError(error, reply);
      }
    }
  );

  // GET /api/v1/kalshi/orders/:orderId — 查询订单状态
  fastify.get<{ Params: { orderId: string } }>(
    '/api/v1/kalshi/orders/:orderId',
    {
      schema: {
        description: '查询 Kalshi 订单状态',
        tags: ['Kalshi Trading'],
        params: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: '订单 ID' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const config = getApiConfig();
        const order = await getKalshiOrder(request.params.orderId, config);
        return reply.send(order);
      } catch (error) {
        handleError(error, reply);
      }
    }
  );

  // GET /api/v1/kalshi/balance — 查询钱包余额
  fastify.get(
    '/api/v1/kalshi/balance',
    {
      schema: {
        description: '查询 Kalshi 账户余额',
        tags: ['Kalshi Trading'],
      },
    },
    async (_request, reply) => {
      try {
        const config = getApiConfig();
        const balance = await getKalshiBalance(config);
        return reply.send(balance);
      } catch (error) {
        handleError(error, reply);
      }
    }
  );

  // GET /api/v1/kalshi/orders — 查询订单列表
  fastify.get<{ Querystring: { status?: string } }>(
    '/api/v1/kalshi/orders',
    {
      schema: {
        description: '查询 Kalshi 订单列表',
        tags: ['Kalshi Trading'],
        querystring: {
          type: 'object',
          properties: {
            status: { type: 'string', description: '订单状态：resting/executed/canceled，默认 resting' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const config = getApiConfig();
        const status = request.query.status ?? 'resting';
        const orders = await getKalshiOrders(config, status);
        return reply.send({ orders });
      } catch (error) {
        handleError(error, reply);
      }
    }
  );

  // GET /api/v1/kalshi/positions — 查询持仓列表
  fastify.get<{ Querystring: { settlement_status?: string } }>(
    '/api/v1/kalshi/positions',
    {
      schema: {
        description: '查询 Kalshi 持仓列表',
        tags: ['Kalshi Trading'],
        querystring: {
          type: 'object',
          properties: {
            settlement_status: { type: 'string', description: '结算状态：all/settled/unsettled，默认 all' },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const config = getApiConfig();
        const settlementStatus = request.query.settlement_status ?? 'all';
        const positions = await getKalshiPositions(config, settlementStatus);
        return reply.send({ positions });
      } catch (error) {
        handleError(error, reply);
      }
    }
  );
}