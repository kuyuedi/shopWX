import type { FastifyInstance } from 'fastify';
import { queryWithPool } from '@prediction-market/shared';
import { formatVolume } from '../utils/formatters.js';
import type { StatsResponse } from '../types.js';

export async function statsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/v1/stats', {
    schema: {
      response: {
        200: {
          type: 'object',
          properties: {
            total_markets: { type: 'integer' },
            volume_24h: { type: 'string' },
            exchange_count: { type: 'integer' },
            exchanges: { type: 'array', items: { type: 'string' } },
            last_updated: { type: ['string', 'null'] },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const result = await queryWithPool<{
      total_markets: string;
      total_volume: string;
      last_updated: Date | null;
    }>(
      fastify.apiPool,
      `SELECT
        COUNT(*)::text AS total_markets,
        COALESCE(SUM(notional_24h), 0)::text AS total_volume,
        MAX(computed_at) AS last_updated
       FROM market_scores`
    );

    const row = result.rows[0];
    const totalVolume = parseFloat(row?.total_volume ?? '0');

    // Get distinct exchange count
    const exchangeResult = await queryWithPool<{ exchange_id: string }>(
      fastify.apiPool,
      `SELECT DISTINCT exchange_id FROM market_scores WHERE exchange_id IS NOT NULL
       UNION
       SELECT DISTINCT mm.exchange_id FROM market_mappings mm
       JOIN market_scores ms ON ms.canonical_market_id = mm.canonical_market_id`
    );

    const exchangeNames = exchangeResult.rows.map(r => {
      switch (r.exchange_id) {
        case 'KALSHI': return 'kalshi';
        case 'POLYMARKET': return 'polymarket';
        default: return r.exchange_id.toLowerCase();
      }
    });
    const uniqueExchanges = [...new Set(exchangeNames)].sort();

    const response: StatsResponse = {
      total_markets: parseInt(row?.total_markets ?? '0', 10),
      volume_24h: formatVolume(totalVolume),
      exchange_count: uniqueExchanges.length,
      exchanges: uniqueExchanges,
      last_updated: row?.last_updated?.toISOString() ?? null,
    };

    return reply.send(response);
  });
}
