import type { FastifyInstance } from 'fastify';
import { queryWithPool } from '@prediction-market/shared';
import { getLastComputedAt } from '../services/scoreComputer.js';
import type { HealthResponse } from '../types.js';

const startTime = Date.now();

export async function healthRoute(fastify: FastifyInstance): Promise<void> {
  const healthResponseSchema = {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['ok', 'degraded'] },
      uptime_seconds: { type: 'integer' },
      db_connected: { type: 'boolean' },
      last_score_computation: { type: ['string', 'null'] },
    },
  } as const;

  fastify.get('/health', {
    schema: {
      response: {
        200: healthResponseSchema,
        503: healthResponseSchema,
      },
    },
  }, async (_request, reply) => {
    let dbConnected = false;
    try {
      await queryWithPool(fastify.apiPool, 'SELECT 1');
      dbConnected = true;
    } catch {
      // db not connected
    }

    const lastComputed = getLastComputedAt();
    const response: HealthResponse = {
      status: dbConnected ? 'ok' : 'degraded',
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      db_connected: dbConnected,
      last_score_computation: lastComputed?.toISOString() ?? null,
    };

    return reply.status(dbConnected ? 200 : 503).send(response);
  });
}
