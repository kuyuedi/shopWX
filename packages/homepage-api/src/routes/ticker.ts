import type { FastifyInstance } from 'fastify';
import { buildTickerItems } from '../services/tickerBuilder.js';
import type { TickerResponse } from '../types.js';

export async function tickerRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: { limit?: string };
  }>('/api/v1/markets/ticker', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          limit: { type: 'string', description: 'Number of ticker items (1-50, default 10)' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  tag: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const limit = Math.min(Math.max(parseInt(request.query.limit || '10', 10) || 10, 1), 50);
    const items = await buildTickerItems(limit, fastify.apiPool);
    const response: TickerResponse = { items };
    return reply.send(response);
  });
}
