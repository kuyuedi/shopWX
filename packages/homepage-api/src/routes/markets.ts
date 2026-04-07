import type { FastifyInstance } from 'fastify';
import { queryWithPool } from '@prediction-market/shared';
import { VALID_CATEGORIES } from '../categoryMap.js';
import { decodeCursor, encodeCursor } from '../utils/cursor.js';
import type { ScoreCursor, ClosesSoonCursor } from '../utils/cursor.js';
import { buildPaginationQuery } from '../utils/pagination.js';
import { assembleOutcomes } from '../services/outcomeAssembler.js';
import type { MarketsListResponse } from '../types.js';
import { getConfig } from '../config.js';

interface MarketsQuery {
  category?: string;
  exchange?: string;
  matched?: string;
  search?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
}

export async function marketsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: MarketsQuery;
  }>('/api/v1/markets', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category slug' },
          exchange: { type: 'string', description: 'Filter by exchange (kal, poly, or comma-separated)' },
          matched: { type: 'string', enum: ['true', 'false', 'all'], description: 'Filter: true (default, cross-exchange only), false (single-exchange only), all (both)' },
          search: { type: 'string', description: 'Full-text search on market title' },
          sort: { type: 'string', enum: ['score', 'closes_soon'], default: 'score', description: 'Sort order' },
          limit: { type: 'string', description: 'Page size (1-100)' },
          cursor: { type: 'string', description: 'Opaque pagination cursor from next_cursor' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            markets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  thumb: { type: ['string', 'null'] },
                  category: { type: ['string', 'null'] },
                  end_date: { type: ['string', 'null'] },
                  volume: { type: ['string', 'null'] },
                  exchanges: { type: 'array', items: { type: 'string' } },
                  outcomes: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        label: { type: 'string' },
                        prices: { type: 'object', additionalProperties: { type: 'number' } },
                      },
                    },
                  },
                  updated_at: { type: ['string', 'null'] },
                },
              },
            },
            next_cursor: { type: ['string', 'null'] },
            has_more: { type: 'boolean' },
            total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const config = getConfig();
    const {
      category,
      exchange,
      matched,
      search,
      sort = 'score',
      limit: limitStr,
      cursor: cursorStr,
    } = request.query;

    // Validate sort
    if (sort !== 'score' && sort !== 'closes_soon') {
      return reply.status(400).send({ error: 'Invalid sort. Must be "score" or "closes_soon"' });
    }

    // Validate limit
    const limit = parseInt(limitStr || String(config.defaultPageSize), 10);
    if (isNaN(limit) || limit < 1 || limit > config.maxPageSize) {
      return reply.status(400).send({ error: `Invalid limit. Must be 1-${config.maxPageSize}` });
    }

    // Validate category
    if (category && !VALID_CATEGORIES.includes(category as typeof VALID_CATEGORIES[number])) {
      return reply.status(400).send({ error: `Invalid category. Must be one of: ${VALID_CATEGORIES.join(', ')}` });
    }

    // Validate cursor
    let cursorData = null;
    if (cursorStr) {
      cursorData = decodeCursor(cursorStr);
      if (!cursorData) {
        return reply.status(400).send({ error: 'Invalid cursor' });
      }
    }

    // Build query
    const whereClauses: string[] = [];
    const params: unknown[] = [];
    let paramIndex = 1;

    if (category) {
      whereClauses.push(`ms.category = $${paramIndex}`);
      params.push(category);
      paramIndex++;
    }

    if (exchange) {
      // Exchange filter: market must be available on at least one of the listed exchanges
      const exchangeKeys = exchange.split(',').map(e => e.trim().toLowerCase());
      const exchangeMap: Record<string, string> = {
        'kal': 'KALSHI',
        'poly': 'POLYMARKET',
        'pre': 'PREDICT',
        'pred': 'PREDICT',
        'opinion': 'OPINIONTRADE',
      };

      const exchangeIds = exchangeKeys
        .map(k => exchangeMap[k])
        .filter(Boolean);

      if (exchangeIds.length > 0) {
        // For matched markets: check market_mappings for the exchange
        // For unmatched: check exchange_id directly
        whereClauses.push(`(
          (ms.is_matched = true AND ms.canonical_market_id IN (
            SELECT canonical_market_id FROM market_mappings WHERE exchange_id = ANY($${paramIndex})
          ))
          OR (ms.is_matched = false AND ms.exchange_id = ANY($${paramIndex}))
        )`);
        params.push(exchangeIds);
        paramIndex++;
      }
    }

    // Default to matched-only (cross-exchange markets) unless explicitly set to false or all
    if (matched === 'false') {
      whereClauses.push('ms.is_matched = false');
    } else if (matched !== 'all') {
      whereClauses.push('ms.is_matched = true');
    }

    if (search) {
      whereClauses.push(`ms.title ILIKE '%' || $${paramIndex} || '%'`);
      params.push(search);
      paramIndex++;
    }

    // Cursor pagination
    if (cursorData) {
      const pagination = buildPaginationQuery(cursorData, sort, paramIndex);
      whereClauses.push(pagination.whereClause);
      params.push(...pagination.params);
      paramIndex = pagination.paramOffset;
    }

    const whereStr = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    // Order by (Spec V1: score DESC, updated_at DESC, id ASC)
    let orderBy: string;
    if (sort === 'closes_soon') {
      orderBy = 'ORDER BY ms.end_date ASC NULLS LAST, ms.updated_at DESC, ms.id ASC';
    } else {
      orderBy = 'ORDER BY ms.score DESC, ms.updated_at DESC, ms.id ASC';
    }

    // Fetch one extra to determine has_more
    const dataQuery = `
      SELECT ms.id, ms.title, ms.thumb, ms.category, ms.end_date, ms.end_date_formatted,
             ms.volume_formatted, ms.is_matched, ms.canonical_market_id,
             ms.exchange_id, ms.source_id, ms.market_id, ms.event_id,
             ms.updated_at, ms.notional_24h, ms.score
      FROM market_scores ms
      ${whereStr}
      ${orderBy}
      LIMIT $${paramIndex}
    `;
    params.push(limit + 1);

    // Build a simplified count query without cursor clauses
    const countParams: unknown[] = [];
    const countClauses: string[] = [];
    let countParamIndex = 1;

    if (category) {
      countClauses.push(`ms.category = $${countParamIndex}`);
      countParams.push(category);
      countParamIndex++;
    }
    if (exchange) {
      const exchangeKeys = exchange.split(',').map(e => e.trim().toLowerCase());
      const exchangeMap: Record<string, string> = { 'kal': 'KALSHI', 'poly': 'POLYMARKET' };
      const exchangeIds = exchangeKeys.map(k => exchangeMap[k]).filter(Boolean);
      if (exchangeIds.length > 0) {
        countClauses.push(`(
          (ms.is_matched = true AND ms.canonical_market_id IN (
            SELECT canonical_market_id FROM market_mappings WHERE exchange_id = ANY($${countParamIndex})
          ))
          OR (ms.is_matched = false AND ms.exchange_id = ANY($${countParamIndex}))
        )`);
        countParams.push(exchangeIds);
        countParamIndex++;
      }
    }
    if (matched === 'false') countClauses.push('ms.is_matched = false');
    else if (matched !== 'all') countClauses.push('ms.is_matched = true');
    if (search) {
      countClauses.push(`ms.title ILIKE '%' || $${countParamIndex} || '%'`);
      countParams.push(search);
      countParamIndex++;
    }

    const countWhereStr = countClauses.length > 0 ? 'WHERE ' + countClauses.join(' AND ') : '';
    const countQuery = `SELECT COUNT(*)::int AS total FROM market_scores ms ${countWhereStr}`;

    // Run data and count queries in parallel
    const [dataResult, countResult] = await Promise.all([
      queryWithPool<Record<string, unknown>>(fastify.apiPool, dataQuery, params),
      queryWithPool<{ total: number }>(fastify.apiPool, countQuery, countParams),
    ]);

    const hasMore = dataResult.rows.length > limit;
    const rows = dataResult.rows.slice(0, limit);
    const total = countResult.rows[0]?.total ?? 0;

    // Build next_cursor from the last row
    let nextCursor: string | null = null;
    if (hasMore && rows.length > 0) {
      const lastRow = rows[rows.length - 1]!;
      if (sort === 'score') {
        nextCursor = encodeCursor({
          s: lastRow.score as number,
          t: lastRow.updated_at ? new Date(lastRow.updated_at as string).toISOString() : '',
          i: lastRow.id as string,
        } satisfies ScoreCursor);
      } else {
        nextCursor = encodeCursor({
          d: lastRow.end_date ? new Date(lastRow.end_date as string).toISOString() : '',
          t: lastRow.updated_at ? new Date(lastRow.updated_at as string).toISOString() : '',
          i: lastRow.id as string,
        } satisfies ClosesSoonCursor);
      }
    }

    // Assemble outcomes for each market
    const markets = await assembleOutcomes(rows as unknown as Parameters<typeof assembleOutcomes>[0], fastify.apiPool);

    const response: MarketsListResponse = {
      markets,
      next_cursor: nextCursor,
      has_more: hasMore,
      total,
    };

    return reply.send(response);
  });
}
