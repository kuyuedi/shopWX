import type { FastifyInstance } from 'fastify';
import { queryWithPool, fetchArbConfig } from '@prediction-market/shared';
import { VALID_CATEGORIES } from '../categoryMap.js';
import { encodeCursor } from '../utils/cursor.js';
import type { EventCursor } from '../utils/cursor.js';
import { formatVolume, formatDate, normalizePrice } from '../utils/formatters.js';
import type { EventsListResponse, EventMarket, EventResponse } from '../types.js';
import { getConfig } from '../config.js';

// DB config cache — reloaded every 5 minutes
let dbConfigCache: Map<string, string> | null = null;
let dbConfigLastLoad = 0;
const DB_CONFIG_TTL_MS = 300_000; // 5 min

async function getDbConfig(): Promise<Map<string, string>> {
  const now = Date.now();
  if (!dbConfigCache || now - dbConfigLastLoad > DB_CONFIG_TTL_MS) {
    try {
      dbConfigCache = await fetchArbConfig();
      dbConfigLastLoad = now;
    } catch {
      if (!dbConfigCache) dbConfigCache = new Map();
    }
  }
  return dbConfigCache;
}

interface EventsQuery {
  category?: string;
  matched?: string;
  search?: string;
  sort?: string;
  limit?: string;
  cursor?: string;
}

const EXCHANGE_KEY: Record<string, string> = {
  KALSHI: 'kal',
  POLYMARKET: 'poly',
  PREDICT: 'pre',
  OPINIONTRADE: 'opinion',
};

// Maps category slug → raw DB values (Kalshi uses PascalCase)
const CATEGORY_DB_VALUES: Record<string, string[]> = {
  politics: ['Politics', 'Elections', 'politics'],
  economics: ['Economics', 'Financials', 'Companies', 'economics'],
  crypto: ['Crypto', 'crypto'],
  sports: ['Sports', 'sports'],
  entertainment: ['Entertainment', 'entertainment'],
};

const CATEGORY_NORMALIZE: Record<string, string> = {
  Politics: 'politics',
  Elections: 'politics',
  Economics: 'economics',
  Financials: 'economics',
  Companies: 'economics',
  Crypto: 'crypto',
  Sports: 'sports',
  Entertainment: 'entertainment',
};

function normalizeCategory(raw: string | null): string | null {
  if (!raw) return null;
  return CATEGORY_NORMALIZE[raw] ?? raw.toLowerCase();
}

interface EventRow {
  id: string;
  is_matched: boolean;
  title: string;
  subtitle: string | null;
  category: string | null;
  end_date: Date | null;
  image_url: string | null;
  total_volume: string; // numeric comes as string from pg
  market_count: string; // bigint comes as string from pg
  updated_at: Date | null;
  exchange_event_ids: Record<string, string>;
  max_spread: string | null; // numeric, only present when sort=spread
}

interface MarketRow {
  exchange_id: string;
  event_id: string;
  market_id: string;
  outcome_name: string | null;
  sub_title: string | null;
  market_title: string | null;
  price: number | null;
  canonical_market_id: string | null;
}

/**
 * Extract outcome name from Kalshi-style title: "Question? — OutcomeName"
 */
function extractOutcomeFromTitle(title: string): string | null {
  // Kalshi em-dash format: "Will X win? — OutcomeName"
  const dashIdx = title.lastIndexOf('—');
  if (dashIdx >= 0) {
    const name = title.substring(dashIdx + 1).trim();
    if (name.length > 0) return name;
  }
  // Predict-style: "Will X win the Y?" → extract X
  const willMatch = title.match(/^Will\s+(.+?)\s+(?:win|be|become|qualify|advance|hit|reach|exceed|dip|launch|make)\b/i);
  if (willMatch && willMatch[1]) {
    const subject = willMatch[1]!.replace(/^(?:the|a|an)\s+/i, '').trim();
    if (subject.length > 0 && subject.length < 50) return subject;
  }
  // Colon-separated: "Event Title: Outcome Name" → extract after last colon
  const colonIdx = title.lastIndexOf(':');
  if (colonIdx >= 0 && colonIdx < title.length - 1) {
    const afterColon = title.substring(colonIdx + 1).trim();
    if (afterColon.length > 0 && afterColon.length < 50) return afterColon;
  }
  return null;
}

function getMarketLabel(outcomeName: string | null, subTitle: string | null, marketTitle: string | null): string {
  // 1. Prefer outcome_name if it's meaningful (not just Yes/No)
  if (outcomeName && outcomeName !== 'Yes' && outcomeName !== 'No') {
    return outcomeName;
  }
  // 2. Use sub_title if available (Polymarket multi-outcome: "After April 30", "April 1-4", etc.)
  if (subTitle && subTitle.length > 0) {
    return subTitle;
  }
  // 3. Try to extract outcome from title (Kalshi em-dash format, etc.)
  if (marketTitle) {
    return extractOutcomeFromTitle(marketTitle) ?? marketTitle;
  }
  return '';
}

function buildEventMarkets(
  eventRow: EventRow,
  marketRows: MarketRow[],
  hideUnmatchedInMatchedEvents: boolean,
): EventMarket[] {
  const eventIds = eventRow.exchange_event_ids || {};
  const eventMarkets = marketRows.filter(m => eventIds[m.exchange_id] === m.event_id);

  const merged = new Map<string, EventMarket>();

  for (const m of eventMarkets) {
    const exKey = EXCHANGE_KEY[m.exchange_id] ?? m.exchange_id.toLowerCase();
    const price = normalizePrice(m.price, m.exchange_id);
    if (price == null) continue;

    if (m.canonical_market_id) {
      let existing = merged.get(m.canonical_market_id);
      const newLabel = getMarketLabel(m.outcome_name, m.sub_title, m.market_title);
      if (!existing) {
        existing = { id: m.canonical_market_id, title: newLabel, prices: {} };
        merged.set(m.canonical_market_id, existing);
      } else if (newLabel.length < existing.title.length && newLabel.length > 0 && !newLabel.startsWith('Will ')) {
        // Prefer shorter label (Kalshi em-dash name) over long Polymarket question title
        existing.title = newLabel;
      }
      existing.prices[exKey] = price;
    } else {
      const key = `${m.exchange_id}:${m.market_id}`;
      let existing = merged.get(key);
      if (!existing) {
        existing = { id: m.market_id, title: getMarketLabel(m.outcome_name, m.sub_title, m.market_title), prices: {} };
        merged.set(key, existing);
      }
      existing.prices[exKey] = price;
    }
  }

  let markets = Array.from(merged.values());

  // Fix C: For matched events, hide markets that only have prices from a single exchange.
  // These are unmatched markets that create confusing single-side cards on the frontend.
  // Controlled by HIDE_EMPTY_MATCHED_EVENTS env var (default: true).
  if (hideUnmatchedInMatchedEvents && eventRow.is_matched) {
    markets = markets.filter(m => Object.keys(m.prices).length > 1);
  }

  return markets.sort((a, b) => {
    // Matched markets (multiple exchanges) sort above unmatched (single exchange)
    const matchedA = Object.keys(a.prices).length > 1 ? 1 : 0;
    const matchedB = Object.keys(b.prices).length > 1 ? 1 : 0;
    if (matchedA !== matchedB) return matchedB - matchedA;
    // Secondary sort by max price descending
    const maxA = Math.max(...Object.values(a.prices));
    const maxB = Math.max(...Object.values(b.prices));
    return maxB - maxA;
  });
}

export async function eventsRoute(fastify: FastifyInstance): Promise<void> {
  fastify.get<{
    Querystring: EventsQuery;
  }>('/api/v1/events', {
    schema: {
      querystring: {
        type: 'object',
        properties: {
          category: { type: 'string', description: 'Filter by category slug (politics, economics, crypto, sports, entertainment)' },
          matched: { type: 'string', enum: ['true', 'false', 'all'], description: 'Filter: true (matched only), false (unmatched only), all (default)' },
          search: { type: 'string', description: 'Full-text search on event title' },
          sort: { type: 'string', enum: ['volume', 'volume24h', 'spread'], default: 'volume', description: 'Sort order: volume (all-time), volume24h (24h trading volume), spread (price divergence)' },
          limit: { type: 'string', description: 'Page size (1-100)' },
          cursor: { type: 'string', description: 'Opaque pagination cursor from next_cursor' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            events: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  title: { type: 'string' },
                  subtitle: { type: ['string', 'null'] },
                  category: { type: ['string', 'null'] },
                  end_date: { type: ['string', 'null'] },
                  image_url: { type: ['string', 'null'] },
                  is_matched: { type: 'boolean' },
                  exchanges: { type: 'array', items: { type: 'string' } },
                  total_volume: { type: 'string' },
                  market_count: { type: 'integer' },
                  markets: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        title: { type: 'string' },
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
            matched_total: { type: 'integer' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const config = getConfig();
    const dbConfig = await getDbConfig();
    const hideEmptyMatched = dbConfig.get('hide_empty_matched_events') !== 'false';
    const {
      category,
      matched,
      search,
      sort = 'volume',
      limit: limitStr,
      cursor: cursorStr,
    } = request.query;

    // Validate sort
    if (sort !== 'volume' && sort !== 'volume24h' && sort !== 'spread') {
      return reply.status(400).send({ error: 'Invalid sort. Must be "volume", "volume24h", or "spread"' });
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

    // Decode cursor (page-based offset pagination)
    let page = 0;
    if (cursorStr) {
      try {
        const json = Buffer.from(cursorStr, 'base64').toString('utf-8');
        const data = JSON.parse(json) as EventCursor;
        if (typeof data?.p !== 'number' || data.p < 0) {
          return reply.status(400).send({ error: 'Invalid cursor' });
        }
        page = data.p;
      } catch {
        return reply.status(400).send({ error: 'Invalid cursor' });
      }
    }

    const offset = page * limit;

    // ── Build shared filter fragments ──
    const filterParams: unknown[] = [];
    let paramIndex = 1;

    let categoryFilter = '';
    if (category) {
      const rawValues = CATEGORY_DB_VALUES[category];
      if (rawValues) {
        categoryFilter = `AND e.category = ANY($${paramIndex})`;
        filterParams.push(rawValues);
        paramIndex++;
      }
    }

    let searchFilter = '';
    if (search) {
      searchFilter = `AND (e.title ILIKE '%' || $${paramIndex} || '%' OR COALESCE(e.subtitle, '') ILIKE '%' || $${paramIndex} || '%')`;
      filterParams.push(search);
      paramIndex++;
    }

    let matchedFilter = '';
    if (matched === 'true') {
      matchedFilter = 'WHERE is_matched = TRUE';
    } else if (matched === 'false') {
      matchedFilter = 'WHERE is_matched = FALSE';
    }

    // ── Build shared CTEs ──
    const ctesSQL = `
      WITH event_volumes AS (
        SELECT e.source_id, e.exchange_id, e.event_id,
               COALESCE(SUM(mld.volume_traded), 0) AS total_volume
        FROM events e
        LEFT JOIN prediction_markets pm
          ON e.source_id = pm.source_id AND e.exchange_id = pm.exchange_id
          AND e.event_id = pm.event_id AND pm.outcome_side = 'YES' AND pm.status = 'Open'
        LEFT JOIN market_latest_data mld
          ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
          AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
        WHERE e.status = 'Open'
        GROUP BY e.source_id, e.exchange_id, e.event_id
      ),
      matched_events AS (
        SELECT
          em.canonical_event_id AS id,
          TRUE AS is_matched,
          COALESCE(
            MAX(CASE WHEN e.exchange_id = 'KALSHI' THEN e.title END),
            MAX(e.title)
          ) AS title,
          MAX(CASE WHEN e.exchange_id = 'KALSHI' THEN e.subtitle END) AS subtitle,
          MAX(CASE WHEN e.exchange_id = 'KALSHI' THEN e.category END) AS category,
          MIN(e.end_date) AS end_date,
          MAX(e.image_url) AS image_url,
          SUM(ev.total_volume) AS total_volume,
          SUM(e.market_count) AS market_count,
          MAX(e.updated_at) AS updated_at,
          jsonb_object_agg(e.exchange_id, e.event_id) AS exchange_event_ids
        FROM event_mappings em
        JOIN events e
          ON em.source_id = e.source_id AND em.exchange_id = e.exchange_id AND em.event_id = e.event_id
        JOIN event_volumes ev
          ON e.source_id = ev.source_id AND e.exchange_id = ev.exchange_id AND e.event_id = ev.event_id
        WHERE em.is_active = TRUE AND e.status = 'Open'
          ${categoryFilter}
          ${searchFilter}
        GROUP BY em.canonical_event_id
      ),
      unmatched_events AS (
        SELECT
          e.exchange_id || ':' || e.event_id AS id,
          FALSE AS is_matched,
          e.title,
          e.subtitle,
          e.category,
          e.end_date,
          e.image_url,
          ev.total_volume,
          e.market_count::bigint AS market_count,
          e.updated_at,
          jsonb_build_object(e.exchange_id, e.event_id) AS exchange_event_ids
        FROM events e
        JOIN event_volumes ev
          ON e.source_id = ev.source_id AND e.exchange_id = ev.exchange_id AND e.event_id = ev.event_id
        WHERE e.status = 'Open'
          AND NOT EXISTS (
            SELECT 1 FROM event_mappings em
            WHERE em.source_id = e.source_id AND em.exchange_id = e.exchange_id
              AND em.event_id = e.event_id AND em.is_active = TRUE
          )
          ${categoryFilter}
          ${searchFilter}
      )
    `;

    // ── Spread CTEs (only when sort=spread) ──
    let spreadCTE = '';
    let spreadSelect = '0::numeric AS max_spread';
    let spreadJoin = '';
    if (sort === 'spread') {
      spreadCTE = `,
        market_spreads AS (
          SELECT mm_s.canonical_market_id,
                 MAX(pm_s.price) - MIN(pm_s.price) AS spread
          FROM market_mappings mm_s
          JOIN prediction_markets pm_s
            ON mm_s.source_id = pm_s.source_id AND mm_s.exchange_id = pm_s.exchange_id
            AND mm_s.market_id = pm_s.market_id AND pm_s.outcome_side = 'YES' AND pm_s.status = 'Open'
          WHERE mm_s.outcome_side = 'YES'
          GROUP BY mm_s.canonical_market_id
          HAVING COUNT(DISTINCT mm_s.exchange_id) > 1
        ),
        event_spreads AS (
          SELECT emm.canonical_event_id,
                 COALESCE(MAX(ms.spread), 0) AS max_spread
          FROM event_mappings emm
          JOIN prediction_markets pms
            ON emm.source_id = pms.source_id AND emm.exchange_id = pms.exchange_id
            AND emm.event_id = pms.event_id AND pms.outcome_side = 'YES' AND pms.status = 'Open'
          JOIN market_mappings mms
            ON pms.source_id = mms.source_id AND pms.exchange_id = mms.exchange_id
            AND pms.market_id = mms.market_id AND mms.outcome_side = 'YES'
          LEFT JOIN market_spreads ms ON mms.canonical_market_id = ms.canonical_market_id
          WHERE emm.is_active = TRUE
          GROUP BY emm.canonical_event_id
        )`;
      spreadSelect = 'COALESCE(es.max_spread, 0)::numeric AS max_spread';
      spreadJoin = 'LEFT JOIN event_spreads es ON combined.id = es.canonical_event_id';
    }

    let orderBy: string;
    if (search) {
      // When searching, sort by relevance: title-starts-with first, then volume
      const searchParamRef = `$${paramIndex - 1}`;  // search param was already added
      orderBy = `ORDER BY
        CASE WHEN title ILIKE ${searchParamRef} || '%' THEN 0
             WHEN title ILIKE '% ' || ${searchParamRef} || '%' THEN 1
             ELSE 2
        END ASC,
        is_matched DESC, total_volume DESC, id ASC`;
    } else if (sort === 'spread') {
      orderBy = 'ORDER BY max_spread DESC NULLS LAST, is_matched DESC, total_volume DESC, id ASC';
    } else if (sort === 'volume24h') {
      orderBy = 'ORDER BY is_matched DESC, vol_24h DESC NULLS LAST, total_volume DESC, id ASC';
    } else {
      orderBy = 'ORDER BY is_matched DESC, total_volume DESC, id ASC';
    }

    // ── Data query (paginated) ──
    const limitIdx = paramIndex;
    const offsetIdx = paramIndex + 1;

    // 24h volume: join to materialized view when needed
    const vol24hSelect = sort === 'volume24h'
      ? ', COALESCE(v24.vol_24h, 0) AS vol_24h'
      : ', 0::numeric AS vol_24h';
    const vol24hJoin = sort === 'volume24h'
      ? `LEFT JOIN (
           SELECT
             COALESCE(em2.canonical_event_id, ev24.exchange_id || ':' || ev24.event_id) AS event_key,
             SUM(ev24.volume_24h) AS vol_24h
           FROM event_volume_24h ev24
           LEFT JOIN event_mappings em2
             ON ev24.source_id = em2.source_id AND ev24.exchange_id = em2.exchange_id
             AND ev24.event_id = em2.event_id AND em2.is_active = TRUE
           GROUP BY event_key
         ) v24 ON combined.id = v24.event_key`
      : '';

    const dataSQL = `
      ${ctesSQL}
      ${spreadCTE}
      SELECT combined.*, ${spreadSelect} ${vol24hSelect}
      FROM (
        SELECT * FROM matched_events
        UNION ALL
        SELECT * FROM unmatched_events
      ) combined
      ${spreadJoin}
      ${vol24hJoin}
      ${matchedFilter}
      ${orderBy}
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const dataParams = [...filterParams, limit, offset];

    // ── Count query (lightweight — skips volume computation) ──
    const countMatchedSQL = `
      SELECT COUNT(DISTINCT em.canonical_event_id)::int AS cnt
      FROM event_mappings em
      JOIN events e
        ON em.source_id = e.source_id AND em.exchange_id = e.exchange_id AND em.event_id = e.event_id
      WHERE em.is_active = TRUE AND e.status = 'Open'
        ${categoryFilter}
        ${searchFilter}
    `;
    const countUnmatchedSQL = `
      SELECT COUNT(*)::int AS cnt
      FROM events e
      WHERE e.status = 'Open'
        AND NOT EXISTS (
          SELECT 1 FROM event_mappings em
          WHERE em.source_id = e.source_id AND em.exchange_id = e.exchange_id
            AND em.event_id = e.event_id AND em.is_active = TRUE
        )
        ${categoryFilter}
        ${searchFilter}
    `;
    let countSQL: string;
    if (matched === 'true') {
      countSQL = `SELECT cnt AS total FROM (${countMatchedSQL}) t`;
    } else if (matched === 'false') {
      countSQL = `SELECT cnt AS total FROM (${countUnmatchedSQL}) t`;
    } else {
      countSQL = `SELECT (m.cnt + u.cnt)::int AS total FROM (${countMatchedSQL}) m, (${countUnmatchedSQL}) u`;
    }

    // ── Run data + count + matched count in parallel ──
    const [dataResult, countResult, matchedCountResult] = await Promise.all([
      queryWithPool<EventRow>(fastify.apiPool, dataSQL, dataParams),
      queryWithPool<{ total: number }>(fastify.apiPool, countSQL, filterParams),
      queryWithPool<{ cnt: number }>(fastify.apiPool, countMatchedSQL, filterParams),
    ]);

    const rows = dataResult.rows;
    const total = countResult.rows[0]?.total ?? 0;
    const matchedTotal = matchedCountResult.rows[0]?.cnt ?? 0;
    const hasMore = offset + rows.length < total;

    // ── Query 3: Batch fetch markets for the page ──
    // Collect all (exchange_id, event_id) pairs from page rows
    const exchangeEventPairs = new Map<string, Set<string>>();
    for (const row of rows) {
      const ids = row.exchange_event_ids || {};
      for (const [exchangeId, eventId] of Object.entries(ids)) {
        if (!exchangeEventPairs.has(exchangeId)) exchangeEventPairs.set(exchangeId, new Set());
        exchangeEventPairs.get(exchangeId)!.add(eventId);
      }
    }

    let allMarkets: MarketRow[] = [];
    if (exchangeEventPairs.size > 0) {
      const marketConditions: string[] = [];
      const marketParams: unknown[] = [];
      let mIdx = 1;

      for (const [exchangeId, eventIds] of exchangeEventPairs) {
        marketConditions.push(`(pm.exchange_id = $${mIdx} AND pm.event_id = ANY($${mIdx + 1}))`);
        marketParams.push(exchangeId, [...eventIds]);
        mIdx += 2;
      }

      const marketSQL = `
        SELECT pm.exchange_id, pm.event_id, pm.market_id,
               pm.outcome_name, pm.sub_title, pm.title AS market_title,
               COALESCE(mld.reference_price, mld.band_vwap_bid, pm.price) AS price,
               mm.canonical_market_id
        FROM prediction_markets pm
        LEFT JOIN market_mappings mm
          ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
          AND pm.market_id = mm.market_id AND mm.outcome_side = 'YES'
        LEFT JOIN market_latest_data mld
          ON pm.source_id = mld.source_id AND pm.exchange_id = mld.exchange_id
          AND pm.market_id = mld.market_id AND pm.outcome_side = mld.outcome_side
        WHERE pm.outcome_side = 'YES'
          AND pm.status = 'Open'
          AND (${marketConditions.join(' OR ')})
        ORDER BY COALESCE(pm.price, mld.reference_price, mld.band_vwap_bid) DESC NULLS LAST
      `;

      const marketResult = await queryWithPool<MarketRow>(fastify.apiPool, marketSQL, marketParams);
      allMarkets = marketResult.rows;
    }

    // ── Assemble response ──
    const events: EventResponse[] = rows.map(row => {
      const markets = buildEventMarkets(row, allMarkets, hideEmptyMatched);
      // Only include exchanges that have at least one price in the displayed markets.
      // This prevents showing exchange badges with all dashes (e.g., Kalshi badge
      // when its markets aren't matched to the Poly/Predict canonical groups).
      const exchangesWithPrices = new Set<string>();
      for (const m of markets) {
        for (const exKey of Object.keys(m.prices)) {
          exchangesWithPrices.add(exKey);
        }
      }
      const exchanges = Object.keys(row.exchange_event_ids || {})
        .map(eid => EXCHANGE_KEY[eid] ?? eid.toLowerCase().substring(0, 4))
        .filter(exKey => exchangesWithPrices.has(exKey));

      return {
        id: row.id,
        title: row.title,
        subtitle: row.subtitle ?? null,
        category: normalizeCategory(row.category),
        end_date: formatDate(row.end_date),
        image_url: row.image_url ?? null,
        is_matched: row.is_matched,
        exchanges,
        total_volume: formatVolume(parseFloat(row.total_volume) || 0),
        market_count: markets.length,
        markets,
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      };
    // Fix C: hide matched events that ended up with zero displayable markets
    }).filter(e => !hideEmptyMatched || !e.is_matched || e.markets.length > 0);

    // ── Build next cursor ──
    let nextCursor: string | null = null;
    if (hasMore) {
      nextCursor = encodeCursor({ p: page + 1 } satisfies EventCursor);
    }

    const response: EventsListResponse = {
      events,
      next_cursor: nextCursor,
      has_more: hasMore,
      total,
      matched_total: matchedTotal,
    };

    return reply.send(response);
  });
}
