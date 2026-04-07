import type { FastifyInstance } from 'fastify';
import { queryWithPool, fetchArbsV7 } from '@prediction-market/shared';
import type { ArbV7Row } from '@prediction-market/shared';
import { getConfig } from '../config.js';
import type { ArbV7, ArbV7Leg, ArbV7Response } from '../types.js';

interface ArbQuery {
  sort?: string;
  category?: string;
  arb_type?: string;
  subtype?: string;
  limit?: string;
  cursor?: string;
  lang?: string;
}

interface ArbRefreshParams {
  id: string;
}

const EXCHANGE_SHORT: Record<string, string> = {
  KALSHI: 'K',
  POLYMARKET: 'P',
  OPINIONTRADE: 'O',
  PREDICT: 'PR',
};

function exchangeShort(exchangeId: string): string {
  return EXCHANGE_SHORT[exchangeId] ?? exchangeId.substring(0, 2);
}

const LOW_LIQUIDITY_QTY = 100;
const LOW_LIQUIDITY_USD = 50;

const SUBTYPE_NOTES: Record<string, string> = {
  TIME_DECAY: 'Complement arb expiring within 14 days — spread may compress as expiry approaches',
  LIQUIDITY_GAP: 'Same-side price discrepancy across exchanges',
};

function buildTradeUrl(exchangeId: string, marketId: string, eventId: string | null): string | null {
  switch (exchangeId) {
    case 'KALSHI':
      return `https://kalshi.com/markets/${marketId}`;
    case 'POLYMARKET':
      return eventId ? `https://polymarket.com/event/${eventId}` : null;
    case 'PREDICT':
      return `https://predict.fun/market/${marketId}`;
    default:
      return null;
  }
}

function getSpreadDirection(current: number, prev: number | null): 'up' | 'down' | 'flat' {
  if (prev == null) return 'flat';
  if (current > prev) return 'up';
  if (current < prev) return 'down';
  return 'flat';
}

function buildLeg(
  exchangeId: string,
  action: string,
  side: 'YES' | 'NO',
  vwap: number | null,
  depthQty: number | null,
  depthUsd: number | null,
  marketId: string,
  eventId: string | null,
): ArbV7Leg {
  const priceDecimal = vwap != null ? Number(vwap) : 0;
  const dQty = depthQty != null ? Number(depthQty) : null;
  const dUsd = depthUsd != null ? Number(depthUsd) : null;

  return {
    exchange: exchangeId,
    exchange_short: exchangeShort(exchangeId),
    action,
    side,
    price_cents: Math.round(priceDecimal * 100),
    price_decimal: priceDecimal,
    depth_qty: dQty,
    depth_usd: dUsd != null ? Math.round(dUsd * 100) / 100 : null,
    low_liquidity: dQty == null || dQty < LOW_LIQUIDITY_QTY || (dUsd != null && dUsd < LOW_LIQUIDITY_USD),
    trade_url: buildTradeUrl(exchangeId, marketId, eventId),
  };
}

function rowToArbV7(row: ArbV7Row): ArbV7 {
  const grossSpreadPct = Number(row.gross_spread_pct);
  const prevSpreadPct = row.prev_gross_spread_pct != null ? Number(row.prev_gross_spread_pct) : null;
  const subtype = row.arb_subtype ?? 'CROSS_PLATFORM';
  const daysToExpiry = row.days_to_expiry != null ? Number(row.days_to_expiry) : null;
  const apy = row.apy != null ? Math.round(Number(row.apy) * 100) / 100 : null;

  const legs: ArbV7Leg[] = [
    buildLeg(
      row.leg1_exchange_id, row.leg1_action, row.leg1_side, row.leg1_vwap,
      row.leg1_depth_qty, row.leg1_depth_usd,
      row.leg1_market_id, row.leg1_event_id,
    ),
    buildLeg(
      row.leg2_exchange_id, row.leg2_action, row.leg2_side, row.leg2_vwap,
      row.leg2_depth_qty, row.leg2_depth_usd,
      row.leg2_market_id, row.leg2_event_id,
    ),
  ];

  return {
    arb_id: row.arb_id,
    market_title: row.market_title,
    category: row.category,
    arb_type: row.arb_type,
    arb_subtype: subtype,
    gross_spread_pct: grossSpreadPct,
    gross_spread: Number(row.gross_spread),
    gross_profit: row.gross_profit != null ? Number(row.gross_profit) : null,
    executable_qty: row.executable_qty != null ? Number(row.executable_qty) : null,
    apy,
    days_to_expiry: daysToExpiry != null ? Math.round(daysToExpiry) : null,
    expires_at: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    spread_direction: getSpreadDirection(grossSpreadPct, prevSpreadPct),
    updated_at: new Date(row.updated_at).toISOString(),
    detected_at: new Date(row.detected_at).toISOString(),
    mapping_confidence: row.mapping_confidence != null ? Number(row.mapping_confidence) : null,
    subtype_note: SUBTYPE_NOTES[subtype] ?? null,
    legs,
  };
}

export async function arbRoute(fastify: FastifyInstance): Promise<void> {
  // List active arbs (v7)
  fastify.get<{ Querystring: ArbQuery }>('/api/v1/arb', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          sort: { type: 'string', enum: ['spread', 'profit', 'detected', 'apy'], default: 'spread' },
          category: { type: 'string' },
          arb_type: { type: 'string', enum: ['DIRECT', 'COMPLEMENT'] },
          subtype: { type: 'string', enum: ['CROSS_PLATFORM', 'TIME_DECAY', 'LIQUIDITY_GAP'] },
          limit: { type: 'string' },
          cursor: { type: 'string' },
          lang: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            arbs: { type: 'array', items: { type: 'object', additionalProperties: true } },
            next_cursor: { type: ['string', 'null'] },
            has_more: { type: 'boolean' },
            total: { type: 'integer' },
            counts: {
              type: 'object',
              properties: {
                all: { type: 'integer' },
                cross_platform: { type: 'integer' },
                time_decay: { type: 'integer' },
                liquidity_gap: { type: 'integer' },
              },
            },
            meta: {
              type: 'object',
              properties: {
                last_scan_at: { type: ['string', 'null'] },
                total_markets_streaming: { type: 'integer' },
                volume_24h: { type: 'number' },
                exchange_count: { type: 'integer' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const config = getConfig();
    const {
      sort = 'spread',
      category,
      arb_type,
      subtype,
      limit: limitStr,
      cursor,
      lang,
    } = request.query;

    const limit = Math.min(Math.max(parseInt(limitStr || '20', 10) || 20, 1), config.maxPageSize);

    const result = await fetchArbsV7({
      sort: sort as 'spread' | 'profit' | 'detected' | 'apy',
      category,
      arb_type,
      subtype,
      limit,
      cursor: cursor ? parseInt(cursor, 10) : undefined,
    }, fastify.apiPool);

    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const arbs = rows.map(rowToArbV7);

    // Translate market titles if lang specified
    if (lang && lang !== 'en' && rows.length > 0) {
      const cmIds = rows.map(r => r.canonical_market_id).filter(Boolean) as string[];
      if (cmIds.length > 0) {
        try {
          const tResult = await queryWithPool<{ source_id: string; translated_text: string }>(
            fastify.apiPool,
            `SELECT source_id, translated_text FROM direct_exchanges_data.translations
             WHERE source_id = ANY($1) AND source_table = 'market_titles'
             AND field = 'kalshi_title' AND language = $2`,
            [cmIds, lang]
          );
          const tMap = new Map(tResult.rows.map(r => [r.source_id, r.translated_text]));
          for (let i = 0; i < arbs.length; i++) {
            const cmId = rows[i]?.canonical_market_id;
            if (cmId && tMap.has(cmId)) {
              arbs[i]!.market_title = tMap.get(cmId)!;
            }
          }
        } catch { /* translation failure is non-fatal */ }
      }
    }

    let nextCursor: string | null = null;
    if (hasMore && arbs.length > 0) {
      nextCursor = String(arbs[arbs.length - 1]!.arb_id);
    }

    const response: ArbV7Response = {
      arbs,
      next_cursor: nextCursor,
      has_more: hasMore,
      total: result.total,
      counts: result.counts,
      meta: {
        last_scan_at: result.meta.last_scan_at ? new Date(result.meta.last_scan_at).toISOString() : null,
        total_markets_streaming: result.meta.total_markets_streaming,
        volume_24h: result.meta.volume_24h,
        exchange_count: result.meta.exchange_count,
      },
    };

    return reply.send(response);
  });

  // Refresh single arb — recompute spread from latest market_latest_data
  fastify.get<{ Params: ArbRefreshParams }>('/api/v1/arb/:id/refresh', {
    schema: {
      params: {
        type: 'object',
        properties: {
          id: { type: 'string' },
        },
        required: ['id'],
      },
      response: {
        200: {
          type: 'object',
          additionalProperties: true,
        },
      },
    },
  }, async (request, reply) => {
    const arbId = parseInt(request.params.id, 10);
    if (isNaN(arbId)) {
      return reply.status(400).send({ error: 'Invalid arb ID' });
    }

    // Fetch the arb record
    const arbResult = await queryWithPool<Record<string, unknown>>(
      fastify.apiPool,
      'SELECT * FROM arb_opportunities WHERE arb_id = $1',
      [arbId],
    );

    if (arbResult.rows.length === 0) {
      return reply.status(404).send({ error: 'Arb not found' });
    }

    const arb = arbResult.rows[0]!;

    // Fetch fresh market_latest_data for both legs
    const [leg1Result, leg2Result] = await Promise.all([
      queryWithPool<Record<string, unknown>>(
        fastify.apiPool,
        `SELECT band_vwap_ask, band_vwap_bid, band_liquidity_qty_ask, band_liquidity_qty_bid,
                reference_price, updated_at
         FROM market_latest_data
         WHERE source_id = $1 AND exchange_id = $2 AND market_id = $3 AND outcome_side = $4`,
        [arb.leg1_source_id, arb.leg1_exchange_id, arb.leg1_market_id, arb.leg1_side],
      ),
      queryWithPool<Record<string, unknown>>(
        fastify.apiPool,
        `SELECT band_vwap_ask, band_vwap_bid, band_liquidity_qty_ask, band_liquidity_qty_bid,
                reference_price, updated_at
         FROM market_latest_data
         WHERE source_id = $1 AND exchange_id = $2 AND market_id = $3 AND outcome_side = $4`,
        [arb.leg2_source_id, arb.leg2_exchange_id, arb.leg2_market_id, arb.leg2_side],
      ),
    ]);

    const leg1 = leg1Result.rows[0];
    const leg2 = leg2Result.rows[0];

    if (!leg1 || !leg2) {
      return reply.send({
        still_valid: false,
        error: 'Missing market data for one or both legs',
      });
    }

    const now = Date.now();
    const leg1Age = now - new Date(leg1.updated_at as string).getTime();
    const leg2Age = now - new Date(leg2.updated_at as string).getTime();

    let spread: number;
    let leg1Price: number;
    let leg2Price: number;

    if (arb.arb_type === 'DIRECT') {
      leg1Price = leg1.band_vwap_ask as number;
      leg2Price = leg2.band_vwap_bid as number;
      spread = leg2Price - leg1Price;
    } else {
      leg1Price = leg1.band_vwap_ask as number;
      leg2Price = leg2.band_vwap_ask as number;
      spread = 1.0 - leg1Price - leg2Price;
    }

    const execQty = Math.min(
      (arb.arb_type === 'DIRECT'
        ? (leg1.band_liquidity_qty_ask as number ?? 0)
        : (leg1.band_liquidity_qty_ask as number ?? 0)),
      (arb.arb_type === 'DIRECT'
        ? (leg2.band_liquidity_qty_bid as number ?? 0)
        : (leg2.band_liquidity_qty_ask as number ?? 0)),
    );

    const stillValid = spread > 0;

    return reply.send({
      still_valid: stillValid,
      gross_spread: spread,
      gross_spread_pct: arb.arb_type === 'DIRECT'
        ? (Math.max(leg1Price, leg2Price) > 0 ? spread / Math.max(leg1Price, leg2Price) : 0)
        : (leg1Price + leg2Price > 0 ? spread / (leg1Price + leg2Price) : 0),
      executable_qty: execQty,
      gross_profit: spread * execQty,
      data_age_ms: Math.max(leg1Age, leg2Age),
      leg1: {
        vwap: leg1Price,
        liq: leg1.band_liquidity_qty_ask,
        book_age_ms: leg1Age,
      },
      leg2: {
        vwap: leg2Price,
        liq: arb.arb_type === 'DIRECT' ? leg2.band_liquidity_qty_bid : leg2.band_liquidity_qty_ask,
        book_age_ms: leg2Age,
      },
    });
  });
}
