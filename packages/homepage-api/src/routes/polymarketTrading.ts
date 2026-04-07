import type { FastifyInstance } from 'fastify';
import {
  getPolymarketBalance,
  createPolymarketOrder,
  getPolymarketOrders,
  getPolymarketOrder,
  cancelPolymarketOrder,
  getPolymarketTrades,
  getPolymarketConfig,
  PolymarketApiError,
  type CreatePolymarketOrderRequest,
} from '../services/polymarketTradingService.js';

// 统一错误处理
function handleError(error: unknown, reply: { status: (code: number) => { send: (data: unknown) => void } }): void {
  if (error instanceof PolymarketApiError) {
    reply.status(error.statusCode >= 400 ? error.statusCode : 500).send({ error: error.message });
  } else if (error instanceof Error) {
    reply.status(500).send({ error: error.message });
  } else {
    reply.status(500).send({ error: String(error) });
  }
}

export async function polymarketTradingRoute(fastify: FastifyInstance): Promise<void> {
  // GET /api/v1/polymarket/balance — 查询 USDC 余额
  fastify.get('/api/v1/polymarket/balance', {
    schema: { description: '查询 Polymarket USDC 余额', tags: ['Polymarket Trading'] },
  }, async (_request, reply) => {
    try {
      const config = getPolymarketConfig();
      const balance = await getPolymarketBalance(config);
      return reply.send(balance);
    } catch (error) { handleError(error, reply); }
  });

  // POST /api/v1/polymarket/orders — 下单
  fastify.post<{ Body: CreatePolymarketOrderRequest }>('/api/v1/polymarket/orders', {
    schema: { description: '向 Polymarket 提交订单', tags: ['Polymarket Trading'] },
  }, async (request, reply) => {
    try {
      const config = getPolymarketConfig();
      const order = await createPolymarketOrder(request.body, config);
      return reply.status(201).send(order);
    } catch (error) { handleError(error, reply); }
  });

  // GET /api/v1/polymarket/orders — 查询订单列表
  fastify.get<{ Querystring: { market?: string } }>('/api/v1/polymarket/orders', {
    schema: {
      description: '查询 Polymarket 订单列表',
      tags: ['Polymarket Trading'],
      querystring: {
        type: 'object',
        properties: { market: { type: 'string', description: '按市场 condition_id 过滤' } },
      },
    },
  }, async (request, reply) => {
    try {
      const config = getPolymarketConfig();
      const orders = await getPolymarketOrders(config, request.query.market);
      return reply.send({ orders });
    } catch (error) { handleError(error, reply); }
  });

  // GET /api/v1/polymarket/orders/:orderId — 查询单个订单
  fastify.get<{ Params: { orderId: string } }>('/api/v1/polymarket/orders/:orderId', {
    schema: { description: '查询 Polymarket 单个订单', tags: ['Polymarket Trading'] },
  }, async (request, reply) => {
    try {
      const config = getPolymarketConfig();
      const order = await getPolymarketOrder(request.params.orderId, config);
      return reply.send(order);
    } catch (error) { handleError(error, reply); }
  });

  // DELETE /api/v1/polymarket/orders/:orderId — 取消订单
  fastify.delete<{ Params: { orderId: string } }>('/api/v1/polymarket/orders/:orderId', {
    schema: { description: '取消 Polymarket 订单', tags: ['Polymarket Trading'] },
  }, async (request, reply) => {
    try {
      const config = getPolymarketConfig();
      const result = await cancelPolymarketOrder(request.params.orderId, config);
      return reply.send(result);
    } catch (error) { handleError(error, reply); }
  });

  // GET /api/v1/polymarket/trades — 查询成交记录
  fastify.get<{ Querystring: { market?: string } }>('/api/v1/polymarket/trades', {
    schema: {
      description: '查询 Polymarket 成交记录',
      tags: ['Polymarket Trading'],
      querystring: {
        type: 'object',
        properties: { market: { type: 'string', description: '按市场 condition_id 过滤' } },
      },
    },
  }, async (request, reply) => {
    try {
      const config = getPolymarketConfig();
      const trades = await getPolymarketTrades(config, request.query.market);
      return reply.send({ trades });
    } catch (error) { handleError(error, reply); }
  });
}
