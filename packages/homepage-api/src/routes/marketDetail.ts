import type { FastifyInstance } from 'fastify';
import { queryWithPool, createLogger } from '@prediction-market/shared';
import type { OrderBookLevel } from '@prediction-market/shared';
import { getTranslations } from '../services/translationService.js';
import { fetchKalshiOrderbook, fetchPolymarketOrderbook } from '../services/orderbookRefresher.js';

const logger = createLogger('market-detail');

// Response cache for expensive event detail / history queries
const responseCache = new Map<string, { data: unknown; ts: number }>();
const RESPONSE_CACHE_TTL_MS = 30_000; // 30 seconds

function getCachedResponse<T>(key: string): T | null {
  const entry = responseCache.get(key);
  if (entry && Date.now() - entry.ts < RESPONSE_CACHE_TTL_MS) return entry.data as T;
  return null;
}

function setCachedResponse(key: string, data: unknown): void {
  responseCache.set(key, { data, ts: Date.now() });
  // Evict old entries periodically
  if (responseCache.size > 200) {
    const now = Date.now();
    for (const [k, v] of responseCache) {
      if (now - v.ts > RESPONSE_CACHE_TTL_MS) responseCache.delete(k);
    }
  }
}

// Live orderbook cache: key = "exchange:marketId:side" → { data, timestamp }
const liveObCache = new Map<string, { bids: OrderBookLevel[]; asks: OrderBookLevel[]; ts: number }>();
const LIVE_OB_CACHE_TTL_MS = 10_000; // 10 seconds

async function getLiveOrderbook(
  exchangeId: string, marketId: string, side: 'YES' | 'NO', tokenId?: string | null
): Promise<{ bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null> {
  const cacheKey = `${exchangeId}:${marketId}:${side}`;
  const cached = liveObCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LIVE_OB_CACHE_TTL_MS) {
    return { bids: cached.bids, asks: cached.asks };
  }

  let book: { bids: OrderBookLevel[]; asks: OrderBookLevel[] } | null = null;
  try {
    logger.info({ exchangeId, marketId, side }, 'Attempting live orderbook fetch');
    if (exchangeId === 'KALSHI') {
      book = await fetchKalshiOrderbook(marketId, side, 5000);
    } else if (exchangeId === 'POLYMARKET' && tokenId) {
      book = await fetchPolymarketOrderbook(tokenId, 5000);
    } else {
      logger.info({ exchangeId, marketId, tokenId }, 'No live fetch handler for this exchange');
    }
    if (book) {
      logger.info({ exchangeId, marketId, bids: book.bids.length, asks: book.asks.length }, 'Live orderbook fetched successfully');
    } else {
      logger.warn({ exchangeId, marketId }, 'Live orderbook fetch returned null');
    }
  } catch (err: any) {
    logger.warn({ err: err?.message || err, exchangeId, marketId }, 'Live orderbook fetch failed');
  }

  if (book) {
    liveObCache.set(cacheKey, { bids: book.bids, asks: book.asks, ts: Date.now() });
  }
  return book;
}

function exchangeKey(exchangeId: string): string {
  switch (exchangeId) {
    case 'KALSHI': return 'kal';
    case 'POLYMARKET': return 'poly';
    default: return exchangeId.toLowerCase().substring(0, 3);
  }
}

function exchangeLabel(key: string): string {
  switch (key) {
    case 'kal': return 'Kalshi';
    case 'poly': return 'Polymarket';
    default: return key;
  }
}

function buildTradeUrl(exchangeId: string, marketId: string, seriesId: string | null, eventSlug: string | null): string | null {
  switch (exchangeId) {
    case 'KALSHI':
      // Kalshi URL format: /markets/{series_id_lowercase}/{slug}/{event_id_lowercase}
      // We don't have the slug, so use the market page which also works
      return `https://kalshi.com/markets/${(seriesId || marketId).toLowerCase()}`;
    case 'POLYMARKET':
      return eventSlug ? `https://polymarket.com/event/${eventSlug}` : null;
    default:
      return null;
  }
}

function formatVolume(vol: number | null): string {
  if (vol == null || vol === 0) return '$0';
  if (vol >= 1e9) return `$${(vol / 1e9).toFixed(1)}B`;
  if (vol >= 1e6) return `$${(vol / 1e6).toFixed(1)}M`;
  if (vol >= 1e3) return `$${(vol / 1e3).toFixed(1)}K`;
  return `$${vol.toFixed(0)}`;
}

function normalizePrice(price: number | null, exchangeId: string): number | null {
  if (price == null) return null;
  const p = Number(price);
  // All prices should be decimal (0-1), convert to cents for display
  return Math.round(p * 1000) / 10; // e.g., 0.243 → 24.3
}

// ─────────────────────────────────────────────────────
// Extract outcome label from market title
// ─────────────────────────────────────────────────────
function extractOutcomeLabel(title: string): string {
  // Kalshi em-dash: "Question? — OutcomeName"
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
  // Colon-separated: "Event Title: Outcome Name"
  const colonIdx = title.lastIndexOf(':');
  if (colonIdx >= 0 && colonIdx < title.length - 1) {
    const afterColon = title.substring(colonIdx + 1).trim();
    if (afterColon.length > 0 && afterColon.length < 50) return afterColon;
  }
  return title;
}

// ─────────────────────────────────────────────────────
// Handle CE-xxx event detail — returns ALL outcomes
// ─────────────────────────────────────────────────────
async function handleEventDetail(fastify: FastifyInstance, eventId: string, reply: any) {
  const lang = (reply.request?.query as Record<string, string>)?.lang || 'en';
  const cacheKey = `event-detail:${eventId}:${lang}`;
  const cached = getCachedResponse(cacheKey);
  if (cached) return reply.send(cached);

  // 1. Get all canonical market IDs + event metadata in parallel
  const [allMarkets, eventResult] = await Promise.all([
    queryWithPool<{
      canonical_market_id: string;
      exchange_id: string;
      market_id: string;
      title: string;
      outcome_name: string | null;
      rules_primary: string | null;
      series_id: string | null;
      event_id: string | null;
      category: string | null;
      reference_price: number | null;
      band_vwap_ask: number | null;
      band_vwap_bid: number | null;
      band_liquidity_qty_ask: number | null;
      band_liquidity_qty_bid: number | null;
      volume_traded: number | null;
    }>(
      fastify.apiPool,
      `WITH open_markets AS (
         SELECT pm.source_id, pm.exchange_id, pm.market_id,
                pm.title, pm.outcome_name, pm.rules_primary, pm.series_id, pm.event_id, pm.category
         FROM direct_exchanges_data.event_mappings em
         JOIN direct_exchanges_data.prediction_markets pm
           ON em.source_id = pm.source_id AND em.exchange_id = pm.exchange_id AND em.event_id = pm.event_id
         WHERE em.canonical_event_id = $1
           AND pm.status = 'Open' AND pm.outcome_side = 'YES'
       )
       SELECT DISTINCT mm.canonical_market_id, mm.exchange_id, mm.market_id,
              om.title, om.outcome_name, om.rules_primary, om.series_id, om.event_id, om.category,
              mld.reference_price, mld.band_vwap_ask, mld.band_vwap_bid,
              mld.band_liquidity_qty_ask, mld.band_liquidity_qty_bid, mld.volume_traded
       FROM open_markets om
       JOIN direct_exchanges_data.market_mappings mm
         ON om.source_id = mm.source_id AND om.exchange_id = mm.exchange_id
         AND om.market_id = mm.market_id AND mm.outcome_side = 'YES'
       LEFT JOIN direct_exchanges_data.market_latest_data mld
         ON mm.source_id = mld.source_id AND mm.exchange_id = mld.exchange_id
         AND mm.market_id = mld.market_id AND mm.outcome_side = 'YES'
       ORDER BY mld.reference_price DESC NULLS LAST`,
      [eventId]
    ),
    // 2. Get event metadata
    queryWithPool<{
      exchange_id: string;
      event_id: string;
      title: string;
      image_url: string | null;
      end_date: Date | null;
      category: string | null;
      source_specific_data: Record<string, unknown> | null;
    }>(
      fastify.apiPool,
      `SELECT e.exchange_id, e.event_id, e.title, e.image_url, e.end_date, e.category,
              e.source_specific_data::jsonb as source_specific_data
       FROM direct_exchanges_data.event_mappings em
       JOIN direct_exchanges_data.events e
         ON em.source_id = e.source_id AND em.exchange_id = e.exchange_id AND em.event_id = e.event_id
       WHERE em.canonical_event_id = $1`,
      [eventId]
    ),
  ]);

  if (allMarkets.rows.length === 0) {
    return reply.status(404).send({ error: 'No matched markets found for this event' });
  }

  const kalshiEvent = eventResult.rows.find(e => e.exchange_id === 'KALSHI');
  const polyEvent = eventResult.rows.find(e => e.exchange_id === 'POLYMARKET');
  const ev = kalshiEvent || polyEvent;

  // 3. Group by canonical_market_id to build outcomes
  const outcomeMap = new Map<string, {
    label: string;
    canonical_market_id: string;
    prices: Record<string, { price: number | null; bid: number | null; ask: number | null; depth_bid: number | null; depth_ask: number | null }>;
    exchange_links: { exchange: string; market_id: string; trade_url: string | null }[];
  }>();

  const exchangeSet = new Set<string>();
  let totalVolume = 0;

  // Collect resolution rules (one per exchange, from any market)
  const rulesMap = new Map<string, string>();

  const polySlug = polyEvent?.source_specific_data && typeof polyEvent.source_specific_data === 'object'
    ? (polyEvent.source_specific_data as Record<string, unknown>).slug as string | undefined
    : undefined;

  // Get poly volume
  const polyVolume = polyEvent?.source_specific_data && typeof polyEvent.source_specific_data === 'object'
    ? Number((polyEvent.source_specific_data as Record<string, unknown>).volume) || 0
    : 0;

  for (const row of allMarkets.rows) {
    const cmId = row.canonical_market_id;
    const exKey = exchangeKey(row.exchange_id);
    exchangeSet.add(exKey);

    if (!outcomeMap.has(cmId)) {
      // Extract outcome label from Kalshi title (after em-dash) or use outcome_name
      const label = row.exchange_id === 'KALSHI'
        ? extractOutcomeLabel(row.title)
        : (row.outcome_name && row.outcome_name !== 'Yes' && row.outcome_name !== 'No' ? row.outcome_name : extractOutcomeLabel(row.title));

      outcomeMap.set(cmId, {
        label,
        canonical_market_id: cmId,
        prices: {},
        exchange_links: [],
      });
    }

    const outcome = outcomeMap.get(cmId)!;

    // Update label from Kalshi if available (preferred)
    if (row.exchange_id === 'KALSHI') {
      outcome.label = extractOutcomeLabel(row.title);
    }

    // Add price data — will be overridden by orderbook-derived prices below
    outcome.prices[exKey] = {
      price: normalizePrice(row.reference_price, row.exchange_id),
      bid: normalizePrice(row.band_vwap_bid, row.exchange_id),
      ask: normalizePrice(row.band_vwap_ask, row.exchange_id),
      depth_bid: row.band_liquidity_qty_bid != null ? Number(row.band_liquidity_qty_bid) : null,
      depth_ask: row.band_liquidity_qty_ask != null ? Number(row.band_liquidity_qty_ask) : null,
    };

    // Add exchange link (deduplicate by exchange)
    const tradeUrl = buildTradeUrl(row.exchange_id, row.market_id, row.series_id, polySlug || null);
    if (!outcome.exchange_links.some(l => l.exchange === exKey)) {
      outcome.exchange_links.push({ exchange: exKey, market_id: row.market_id, trade_url: tradeUrl });
    }

    // Track volume
    totalVolume += Number(row.volume_traded) || 0;

    // Collect rules
    if (row.rules_primary && !rulesMap.has(exKey)) {
      rulesMap.set(exKey, row.rules_primary);
    }
  }

  // Level 1 bid/ask already populated from band metrics (market_latest_data) above.
  // Full orderbook detail is fetched on-demand via the /orderbook endpoint only.

  // Sort outcomes by best price descending
  const outcomes = Array.from(outcomeMap.values()).sort((a, b) => {
    const bestA = Math.max(...Object.values(a.prices).map(p => p.price ?? 0));
    const bestB = Math.max(...Object.values(b.prices).map(p => p.price ?? 0));
    return bestB - bestA;
  });

  // Use poly volume if available (more accurate)
  const displayVolume = polyVolume > totalVolume ? polyVolume : totalVolume;

  const resolution = Array.from(rulesMap.entries()).map(([exKey, rules]) => ({
    exchange: exKey,
    exchange_label: exchangeLabel(exKey),
    rules,
  }));

  const endDate = ev?.end_date
    ? new Date(ev.end_date).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  const eventTitle = kalshiEvent?.title || polyEvent?.title || 'Unknown Event';

  // Fetch translations if language is specified
  let translationsData: Record<string, Record<string, string>> = {};
  if (lang !== 'en') {
    const cmIds = [...new Set(allMarkets.rows.map(r => r.canonical_market_id))];
    const ruleKeys = cmIds.flatMap(cm =>
      Array.from(exchangeSet).map(ex => `${cm}:${ex === 'kal' ? 'KALSHI' : 'POLYMARKET'}`)
    );

    // Run all translation queries in parallel
    const [titleTranslations, ruleTranslations, eventTitleTranslations] = await Promise.all([
      getTranslations('market_titles', cmIds, lang),
      getTranslations('prediction_markets', ruleKeys, lang),
      getTranslations('events', [eventId], lang),
    ]);

    // Build a flat translations object for the response
    const t: Record<string, string> = {};
    for (const [cmId, fields] of titleTranslations) {
      if (fields.title) t[`title:${cmId}`] = fields.title;
      if (fields.kalshi_title) t[`outcome:${cmId}`] = fields.kalshi_title;
    }
    for (const [key, fields] of ruleTranslations) {
      if (fields.rules_primary) t[`rules:${key}`] = fields.rules_primary;
    }
    const eventTrans = eventTitleTranslations.get(eventId);
    if (eventTrans?.title) {
      t['event_title'] = eventTrans.title;
    }
    translationsData = { [lang]: t } as any;
  }

  const responseData = {
    id: eventId,
    type: 'event',
    title: eventTitle,
    category: (ev?.category || 'Unknown').toLowerCase(),
    end_date: endDate,
    image_url: ev?.image_url || null,
    volume: formatVolume(displayVolume),
    status: 'Open',
    exchanges: Array.from(exchangeSet).sort(),
    exchange_links: Array.from(exchangeSet).map(exKey => {
      const exRows = allMarkets.rows.filter(r => exchangeKey(r.exchange_id) === exKey);
      const firstRow = exRows[0];
      return {
        exchange: exKey,
        market_id: firstRow?.market_id || '',
        event_id: firstRow?.event_id || '',
        series_id: firstRow?.series_id || null,
        trade_url: firstRow ? buildTradeUrl(firstRow.exchange_id, firstRow.market_id, firstRow.series_id, polySlug || null) : null,
      };
    }).sort((a, b) => a.exchange.localeCompare(b.exchange)),
    outcomes,
    resolution,
    related: [],
    translations: translationsData,
  };

  setCachedResponse(cacheKey, responseData);
  return reply.send(responseData);
}

// ─────────────────────────────────────────────────────
// Handle CE-xxx event history — returns multi-outcome series
// ─────────────────────────────────────────────────────
async function handleEventHistory(fastify: FastifyInstance, eventId: string, tf: string, split: boolean, reply: any) {
  const historyCacheKey = `event-history:${eventId}:${tf}:${split}`;
  const cachedHistory = getCachedResponse(historyCacheKey);
  if (cachedHistory) return reply.send(cachedHistory);

  // Get top outcomes by reference price (smart filtering)
  const allOutcomes = await queryWithPool<{
    canonical_market_id: string;
    label: string;
    max_ref: number;
    market_ids: string[];
    exchange_ids: string[];
  }>(
    fastify.apiPool,
    `WITH open_markets AS (
       SELECT pm.source_id, pm.exchange_id, pm.market_id, pm.title
       FROM direct_exchanges_data.event_mappings em
       JOIN direct_exchanges_data.prediction_markets pm
         ON em.source_id = pm.source_id AND em.exchange_id = pm.exchange_id AND em.event_id = pm.event_id
       WHERE em.canonical_event_id = $1
         AND pm.status = 'Open' AND pm.outcome_side = 'YES'
     )
     SELECT mm.canonical_market_id,
            COALESCE(mt.generated_title, MIN(om.title)) as label,
            MAX(mld.reference_price)::float as max_ref,
            array_agg(DISTINCT mm.market_id) as market_ids,
            array_agg(DISTINCT mm.exchange_id) as exchange_ids
     FROM open_markets om
     JOIN direct_exchanges_data.market_mappings mm
       ON om.source_id = mm.source_id AND om.exchange_id = mm.exchange_id
       AND om.market_id = mm.market_id AND mm.outcome_side = 'YES'
     LEFT JOIN direct_exchanges_data.market_latest_data mld
       ON mm.source_id = mld.source_id AND mm.exchange_id = mld.exchange_id
       AND mm.market_id = mld.market_id AND mm.outcome_side = 'YES'
     LEFT JOIN direct_exchanges_data.market_titles mt
       ON mm.canonical_market_id = mt.canonical_market_id
     GROUP BY mm.canonical_market_id, mt.generated_title
     HAVING MAX(mld.reference_price) < 0.95 AND MAX(mld.reference_price) > 0.01
     ORDER BY MAX(mld.reference_price) DESC NULLS LAST
     LIMIT 10`,
    [eventId]
  );

  if (allOutcomes.rows.length === 0) {
    return reply.send({ timeframe: tf, labels: [], series: [], data_points: 0 });
  }

  // Smart filter: always top 3, then include if within 3x of #3's probability, max 6
  const topOutcomes = allOutcomes.rows.slice(0, 3);
  if (allOutcomes.rows.length > 3) {
    const thirdProb = allOutcomes.rows[2]!.max_ref;
    const cutoff = thirdProb * 3;
    for (let i = 3; i < allOutcomes.rows.length && topOutcomes.length < 6; i++) {
      if (allOutcomes.rows[i]!.max_ref * 3 >= thirdProb) {
        topOutcomes.push(allOutcomes.rows[i]!);
      }
    }
  }

  const intervalHours = tf === 'today' ? 2 : 6;
  const lookback = tf === 'today' ? '24 hours' : '7 days';
  const colors = ['#3b82f6', '#f59e0b', '#ef4444', '#22c55e', '#8b5cf6', '#ec4899'];

  // Query trades for all top outcome market_ids, grouped by exchange too (for split)
  const allMarketIds = topOutcomes.flatMap(r => r.market_ids);
  const allExchangeIds = topOutcomes.flatMap(r => r.exchange_ids);

  const histResult = await queryWithPool<{
    bucket: Date;
    market_id: string;
    exchange_id: string;
    avg_price: number;
  }>(
    fastify.apiPool,
    `SELECT
       date_trunc('hour', timestamp) +
         (EXTRACT(HOUR FROM timestamp)::int / ${intervalHours} * ${intervalHours} || ' hours')::interval AS bucket,
       t.market_id,
       t.exchange_id,
       AVG(t.price) AS avg_price
     FROM direct_exchanges_data.trades t
     WHERE t.market_id = ANY($1) AND t.exchange_id = ANY($2)
       AND t.timestamp >= NOW() - INTERVAL '${lookback}'
       AND t.outcome IN ('YES', 'Yes', 'yes')
     GROUP BY bucket, t.market_id, t.exchange_id
     ORDER BY bucket ASC`,
    [allMarketIds, allExchangeIds]
  );

  // Build bucket set
  const bucketSet = new Set<string>();
  for (const row of histResult.rows) {
    bucketSet.add(new Date(row.bucket).toISOString());
  }
  const labels = Array.from(bucketSet).sort();
  const formattedLabels = labels.map(l => {
    const d = new Date(l);
    if (tf === 'today') return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
    return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  });

  // Build series
  const series: { name: string; color: string; exchange?: string; data: (number | null)[] }[] = [];

  for (let i = 0; i < topOutcomes.length; i++) {
    const outcome = topOutcomes[i]!;
    const outcomeMktIds = new Set(outcome.market_ids);
    const label = extractOutcomeLabel(outcome.label);
    const color = colors[i % colors.length]!;

    if (!split) {
      // Combined: average across exchanges per bucket
      const bucketPrices = new Map<string, number[]>();
      for (const row of histResult.rows) {
        if (!outcomeMktIds.has(row.market_id)) continue;
        const key = new Date(row.bucket).toISOString();
        if (!bucketPrices.has(key)) bucketPrices.set(key, []);
        bucketPrices.get(key)!.push(Math.round(Number(row.avg_price) * 1000) / 10);
      }
      const data = labels.map(l => {
        const vals = bucketPrices.get(l);
        if (!vals || vals.length === 0) return null;
        return Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
      });
      series.push({ name: label, color, data });
    } else {
      // Split: separate line per exchange
      const exchanges = new Set<string>();
      for (const row of histResult.rows) {
        if (outcomeMktIds.has(row.market_id)) exchanges.add(row.exchange_id);
      }
      for (const ex of exchanges) {
        const exKey = exchangeKey(ex);
        const bucketPrices = new Map<string, number>();
        for (const row of histResult.rows) {
          if (!outcomeMktIds.has(row.market_id) || row.exchange_id !== ex) continue;
          const key = new Date(row.bucket).toISOString();
          bucketPrices.set(key, Math.round(Number(row.avg_price) * 1000) / 10);
        }
        const data = labels.map(l => bucketPrices.get(l) ?? null);
        series.push({
          name: `${label} (${exchangeLabel(exKey)})`,
          color,
          exchange: exKey,
          data,
        });
      }
    }
  }

  const historyResponse = {
    timeframe: tf,
    labels: formattedLabels,
    series,
    data_points: histResult.rows.length,
  };

  setCachedResponse(historyCacheKey, historyResponse);
  return reply.send(historyResponse);
}

export async function marketDetailRoute(fastify: FastifyInstance): Promise<void> {

  // ═══════════════════════════════════════════════════
  // GET /api/v1/markets/:id — Full market detail
  // ═══════════════════════════════════════════════════
  fastify.get<{ Params: { id: string } }>('/api/v1/markets/:id', {
    schema: {
      params: {
        type: 'object',
        properties: { id: { type: 'string' } },
        required: ['id'],
      },
    },
  }, async (request, reply) => {
    let { id } = request.params;

    try {
      // Resolve event IDs (CE-xxx) — return ALL outcomes for the event
      if (id.startsWith('CE-')) {
        return await handleEventDetail(fastify, id, reply);
      }

      // Resolve non-canonical IDs (K:xxx, P:xxx) to canonical
      if (!id.startsWith('CM-')) {
        const parts = id.split(':');
        if (parts.length === 2) {
          const lookup = await queryWithPool<{ canonical_market_id: string }>(
            fastify.apiPool,
            `SELECT canonical_market_id FROM direct_exchanges_data.market_mappings
             WHERE market_id = $1 AND outcome_side = 'YES' LIMIT 1`,
            [parts[1]]
          );
          if (lookup.rows.length > 0) {
            id = lookup.rows[0]!.canonical_market_id;
          } else {
            return reply.status(404).send({ error: 'Market not found or not matched across exchanges' });
          }
        } else {
          return reply.status(400).send({ error: 'Invalid market ID format' });
        }
      }

      // 1. Fetch all mapped markets for this canonical ID
      const mappingsResult = await queryWithPool<{
        canonical_market_id: string;
        exchange_id: string;
        source_id: string;
        market_id: string;
        outcome_side: string;
        confidence_score: number;
      }>(
        fastify.apiPool,
        `SELECT canonical_market_id, exchange_id, source_id, market_id, outcome_side, confidence_score
         FROM direct_exchanges_data.market_mappings
         WHERE canonical_market_id = $1`,
        [id]
      );

      if (mappingsResult.rows.length === 0) {
        return reply.status(404).send({ error: 'Market not found' });
      }

      // 2. Fetch prediction_markets, market_latest_data, and title in parallel
      const marketIds = mappingsResult.rows
        .filter(r => r.outcome_side === 'YES')
        .map(r => r.market_id);
      const exchangeIds = mappingsResult.rows
        .filter(r => r.outcome_side === 'YES')
        .map(r => r.exchange_id);

      const [marketsResult, mldResult, titleResult] = await Promise.all([
        queryWithPool<{
          exchange_id: string;
          market_id: string;
          title: string;
          outcome_name: string | null;
          rules_primary: string | null;
          series_id: string | null;
          event_id: string | null;
          price: number | null;
          category: string | null;
          expires_at: Date | null;
        }>(
          fastify.apiPool,
          `SELECT pm.exchange_id, pm.market_id, pm.title, pm.outcome_name,
                  pm.rules_primary, pm.series_id, pm.event_id, pm.price,
                  pm.category, pm.expires_at
           FROM direct_exchanges_data.prediction_markets pm
           WHERE pm.market_id = ANY($1) AND pm.exchange_id = ANY($2)
             AND pm.outcome_side = 'YES'`,
          [marketIds, exchangeIds]
        ),
        queryWithPool<{
          exchange_id: string;
          market_id: string;
          reference_price: number | null;
          band_vwap_ask: number | null;
          band_vwap_bid: number | null;
          band_liquidity_qty_ask: number | null;
          band_liquidity_qty_bid: number | null;
          volume_traded: number | null;
          updated_at: Date;
        }>(
          fastify.apiPool,
          `SELECT mld.exchange_id, mld.market_id, mld.reference_price,
                  mld.band_vwap_ask, mld.band_vwap_bid,
                  mld.band_liquidity_qty_ask, mld.band_liquidity_qty_bid,
                  mld.volume_traded, mld.updated_at
           FROM direct_exchanges_data.market_latest_data mld
           WHERE mld.market_id = ANY($1) AND mld.exchange_id = ANY($2)
             AND mld.outcome_side = 'YES'`,
          [marketIds, exchangeIds]
        ),
        queryWithPool<{ generated_title: string }>(
          fastify.apiPool,
          `SELECT generated_title FROM direct_exchanges_data.market_titles WHERE canonical_market_id = $1`,
          [id]
        ),
      ]);

      // 3. Fetch event data and related markets in parallel (both depend on marketsResult)
      const eventIds = marketsResult.rows.map(r => r.event_id).filter(Boolean);
      const kalshiPmForEvents = marketsResult.rows.find(r => r.exchange_id === 'KALSHI');

      const [eventsResult, relResultRaw] = await Promise.all([
        eventIds.length > 0 ? queryWithPool<{
          exchange_id: string;
          event_id: string;
          title: string;
          image_url: string | null;
          end_date: Date | null;
          category: string | null;
          source_specific_data: Record<string, unknown> | null;
        }>(
          fastify.apiPool,
          `SELECT exchange_id, event_id, title, image_url, end_date, category,
                  source_specific_data::jsonb as source_specific_data
           FROM direct_exchanges_data.events
           WHERE event_id = ANY($1)`,
          [eventIds]
        ) : Promise.resolve({ rows: [] as any[] }),
        kalshiPmForEvents?.event_id ? queryWithPool<{
          canonical_market_id: string;
          title: string;
          reference_price: number | null;
        }>(
          fastify.apiPool,
          `SELECT DISTINCT mm.canonical_market_id,
                  COALESCE(mt.generated_title, pm.title) as title,
                  mld.reference_price
           FROM direct_exchanges_data.market_mappings mm
           JOIN direct_exchanges_data.prediction_markets pm
             ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
             AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
           LEFT JOIN direct_exchanges_data.market_titles mt
             ON mm.canonical_market_id = mt.canonical_market_id
           LEFT JOIN direct_exchanges_data.market_latest_data mld
             ON mm.source_id = mld.source_id AND mm.exchange_id = mld.exchange_id
             AND mm.market_id = mld.market_id AND mm.outcome_side = mld.outcome_side
           WHERE pm.event_id = $1 AND mm.outcome_side = 'YES' AND mm.exchange_id = 'KALSHI'
             AND mm.canonical_market_id != $2
           ORDER BY mld.reference_price DESC NULLS LAST
           LIMIT 8`,
          [kalshiPmForEvents.event_id, id]
        ) : Promise.resolve({ rows: [] as any[] }),
      ]);

      // Build response
      const exchangeSet = new Set<string>();
      const exchangeLinks: { exchange: string; market_id: string; event_id: string | null; series_id: string | null; trade_url: string | null }[] = [];

      for (const pm of marketsResult.rows) {
        const exKey = exchangeKey(pm.exchange_id);
        exchangeSet.add(exKey);

        const ev = eventsResult.rows.find(e => e.exchange_id === pm.exchange_id && e.event_id === pm.event_id);
        const polySlug = ev?.source_specific_data && typeof ev.source_specific_data === 'object'
          ? (ev.source_specific_data as Record<string, unknown>).slug as string | undefined
          : undefined;

        exchangeLinks.push({
          exchange: exKey,
          market_id: pm.market_id,
          event_id: pm.event_id,
          series_id: pm.series_id,
          trade_url: buildTradeUrl(pm.exchange_id, pm.market_id, pm.series_id, polySlug || null),
        });
      }

      // Build outcome label
      const kalshiPm = marketsResult.rows.find(r => r.exchange_id === 'KALSHI');
      const anyPm = marketsResult.rows[0];
      const outcomeLabel = kalshiPm
        ? extractOutcomeLabel(kalshiPm.title)
        : (anyPm?.outcome_name && anyPm.outcome_name !== 'Yes' && anyPm.outcome_name !== 'No'
            ? anyPm.outcome_name
            : (anyPm ? extractOutcomeLabel(anyPm.title) : 'Yes'));

      // Build prices per exchange
      const prices: Record<string, { price: number | null; bid: number | null; ask: number | null; depth_bid: number | null; depth_ask: number | null }> = {};
      for (const mld of mldResult.rows) {
        const exKey = exchangeKey(mld.exchange_id);
        prices[exKey] = {
          price: normalizePrice(mld.reference_price, mld.exchange_id),
          bid: normalizePrice(mld.band_vwap_bid, mld.exchange_id),
          ask: normalizePrice(mld.band_vwap_ask, mld.exchange_id),
          depth_bid: mld.band_liquidity_qty_bid != null ? Number(mld.band_liquidity_qty_bid) : null,
          depth_ask: mld.band_liquidity_qty_ask != null ? Number(mld.band_liquidity_qty_ask) : null,
        };
      }

      // Volume
      const totalVolume = mldResult.rows.reduce((sum, r) => sum + (Number(r.volume_traded) || 0), 0);

      // Event metadata
      const kalshiEvent = eventsResult.rows.find(e => e.exchange_id === 'KALSHI');
      const polyEvent = eventsResult.rows.find(e => e.exchange_id === 'POLYMARKET');
      const ev = kalshiEvent || polyEvent;

      // Resolution rules
      const resolution = marketsResult.rows
        .filter(r => r.rules_primary)
        .map(r => ({
          exchange: exchangeKey(r.exchange_id),
          exchange_label: exchangeLabel(exchangeKey(r.exchange_id)),
          rules: r.rules_primary!,
        }));

      // Related markets (already fetched in parallel above)
      const related = relResultRaw.rows.map((r: any) => ({
        id: r.canonical_market_id,
        title: extractOutcomeLabel(r.title),
        best_price: normalizePrice(r.reference_price, 'KALSHI'),
      }));

      // Format end date
      const endDate = ev?.end_date
        ? new Date(ev.end_date).toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })
        : null;

      // Category
      const category = (ev?.category || anyPm?.category || 'Unknown').toLowerCase();

      const response = {
        id,
        title: titleResult.rows[0]?.generated_title || (kalshiPm ? kalshiPm.title.split('\u2014')[0]!.trim() : anyPm?.title || 'Unknown Market'),
        category,
        end_date: endDate,
        image_url: ev?.image_url || null,
        volume: formatVolume(totalVolume),
        status: 'Open',
        exchanges: Array.from(exchangeSet).sort(),
        exchange_links: exchangeLinks,
        outcomes: [{
          label: outcomeLabel,
          prices,
        }],
        resolution,
        related,
      };

      return reply.send(response);
    } catch (err) {
      logger.error({ err, marketId: id }, 'Failed to fetch market detail');
      return reply.status(500).send({ error: 'Internal server error' });
    }
  });

  // ═══════════════════════════════════════════════════
  // GET /api/v1/markets/:id/orderbook — Orderbook depth
  // ═══════════════════════════════════════════════════
  fastify.get<{ Params: { id: string }; Querystring: { exchange?: string } }>(
    '/api/v1/markets/:id/orderbook',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            exchange: { type: 'string', enum: ['combined', 'kalshi', 'polymarket', 'kal', 'poly'], default: 'combined' },
          },
        },
      },
    },
    async (request, reply) => {
      let { id } = request.params;
      const exchange = request.query.exchange || 'combined';

      try {
        // Resolve CE-xxx to first CM-xxx
        if (id.startsWith('CE-')) {
          const lookup = await queryWithPool<{ canonical_market_id: string }>(
            fastify.apiPool,
            `SELECT DISTINCT mm.canonical_market_id
             FROM direct_exchanges_data.event_mappings em
             JOIN direct_exchanges_data.prediction_markets pm
               ON em.source_id = pm.source_id AND em.exchange_id = pm.exchange_id AND em.event_id = pm.event_id
             JOIN direct_exchanges_data.market_mappings mm
               ON pm.source_id = mm.source_id AND pm.exchange_id = mm.exchange_id
               AND pm.market_id = mm.market_id AND mm.outcome_side = 'YES'
             WHERE em.canonical_event_id = $1
               AND pm.status = 'Open' AND pm.outcome_side = 'YES'
             ORDER BY mm.canonical_market_id LIMIT 1`,
            [id]
          );
          if (lookup.rows.length > 0) id = lookup.rows[0]!.canonical_market_id;
          else return reply.status(404).send({ error: 'No matched markets for this event' });
        }

        // Get mapped market IDs for this canonical market
        const mappings = await queryWithPool<{ exchange_id: string; market_id: string; token_id: string | null }>(
          fastify.apiPool,
          `SELECT mm.exchange_id, mm.market_id,
                  pm.source_specific_data::jsonb->>'token_id' as token_id
           FROM direct_exchanges_data.market_mappings mm
           LEFT JOIN direct_exchanges_data.prediction_markets pm
             ON mm.source_id = pm.source_id AND mm.exchange_id = pm.exchange_id
             AND mm.market_id = pm.market_id AND mm.outcome_side = pm.outcome_side
           WHERE mm.canonical_market_id = $1 AND mm.outcome_side = 'YES'`,
          [id]
        );

        if (mappings.rows.length === 0) {
          return reply.status(404).send({ error: 'No orderbook data found' });
        }

        const bids: { price: number; qty: number; exchange: string }[] = [];
        const asks: { price: number; qty: number; exchange: string }[] = [];
        let latestUpdate: Date | null = null;
        const MAX_LEVELS = 15;

        // Get reference price for filtering levels near mid
        const refResult = await queryWithPool<{ reference_price: number | null }>(
          fastify.apiPool,
          `SELECT AVG(reference_price)::numeric as reference_price
           FROM direct_exchanges_data.market_latest_data
           WHERE market_id = ANY($1) AND exchange_id = ANY($2) AND outcome_side = 'YES'
             AND reference_price IS NOT NULL`,
          [mappings.rows.map(r => r.market_id), mappings.rows.map(r => r.exchange_id)]
        );
        const midPrice = refResult.rows[0]?.reference_price ? Number(refResult.rows[0].reference_price) : 0.5;

        for (const mapping of mappings.rows) {
          const exKey = exchangeKey(mapping.exchange_id);
          // Filter by exchange: map query param to our key format
          const filterMap: Record<string, string> = { 'kalshi': 'kal', 'polymarket': 'poly', 'kal': 'kal', 'poly': 'poly' };
          if (exchange !== 'combined' && exKey !== (filterMap[exchange] || exchange)) continue;

          const isKalshi = mapping.exchange_id === 'KALSHI';

          // Try live REST fetch first (10s cache), fall back to DB snapshot
          let rawBids: { price: number; quantity: number }[] = [];
          let rawAsks: { price: number; quantity: number }[] = [];
          let usedSide: 'YES' | 'NO' = 'YES';
          let gotLiveData = false;

          // Attempt live REST fetch
          const liveBook = await getLiveOrderbook(mapping.exchange_id, mapping.market_id, 'YES', mapping.token_id);
          if (liveBook && (liveBook.bids.length > 0 || liveBook.asks.length > 0)) {
            rawBids = liveBook.bids.filter(b => Number(b.quantity) > 0);
            rawAsks = liveBook.asks.filter(a => Number(a.quantity) > 0);
            latestUpdate = new Date();
            gotLiveData = true;
          }

          // Fall back to DB if live fetch failed or returned empty
          if (!gotLiveData) {
            for (const side of ['YES', 'NO'] as const) {
              const obResult = await queryWithPool<{
                bids: { price: number; quantity: number }[];
                asks: { price: number; quantity: number }[];
                time_exchange: Date;
              }>(
                fastify.apiPool,
                `SELECT bids, asks, time_exchange FROM direct_exchanges_data.order_books
                 WHERE market_id = $1 AND exchange_id = $2 AND outcome_side = $3
                 ORDER BY time_exchange DESC LIMIT 1`,
                [mapping.market_id, mapping.exchange_id, side]
              );

              if (obResult.rows.length === 0) continue;

              const ob = obResult.rows[0]!;
              if (!latestUpdate || ob.time_exchange > latestUpdate) latestUpdate = ob.time_exchange;

              rawBids = (ob.bids || []).filter((b: any) => Number(b.quantity) > 0);
              rawAsks = (ob.asks || []).filter((a: any) => Number(a.quantity) > 0);
              usedSide = side;
              break;
            }
          }

          if (rawBids.length > 0 || rawAsks.length > 0) {
            const side = gotLiveData ? 'YES' : usedSide;

            if (side === 'YES') {
              // Direct YES orderbook — prices may be decimal (0-1) or cents (0-100)
              for (const b of rawBids) {
                const p = Number(b.price);
                const pCents = p <= 1 ? Math.round(p * 1000) / 10 : Math.round(p * 10) / 10;
                bids.push({ price: pCents, qty: Math.round(Number(b.quantity)), exchange: exKey });
              }
              for (const a of rawAsks) {
                const p = Number(a.price);
                const pCents = p <= 1 ? Math.round(p * 1000) / 10 : Math.round(p * 10) / 10;
                asks.push({ price: pCents, qty: Math.round(Number(a.quantity)), exchange: exKey });
              }
            } else {
              // NO-side orderbook — invert to get YES prices
              // YES bid = 100 - NO ask, YES ask = 100 - NO bid
              for (const a of rawAsks) {
                const noPrice = Number(a.price);
                const yesPriceCents = noPrice <= 1
                  ? Math.round((1 - noPrice) * 1000) / 10
                  : Math.round((100 - noPrice) * 10) / 10;
                if (yesPriceCents > 0 && yesPriceCents < 100) {
                  bids.push({ price: yesPriceCents, qty: Math.round(Number(a.quantity)), exchange: exKey });
                }
              }
              for (const b of rawBids) {
                const noPrice = Number(b.price);
                const yesPriceCents = noPrice <= 1
                  ? Math.round((1 - noPrice) * 1000) / 10
                  : Math.round((100 - noPrice) * 10) / 10;
                if (yesPriceCents > 0 && yesPriceCents < 100) {
                  asks.push({ price: yesPriceCents, qty: Math.round(Number(b.quantity)), exchange: exKey });
                }
              }
            }

          }

          // Fallback to band metrics if no orderbook data was found for this exchange
          const foundForExchange = bids.some(b => b.exchange === exKey) || asks.some(a => a.exchange === exKey);
          if (!foundForExchange) {
            const mldResult = await queryWithPool<{
              band_vwap_ask: number | null; band_vwap_bid: number | null;
              band_liquidity_qty_ask: number | null; band_liquidity_qty_bid: number | null;
              updated_at: Date;
            }>(
              fastify.apiPool,
              `SELECT band_vwap_ask, band_vwap_bid, band_liquidity_qty_ask, band_liquidity_qty_bid, updated_at
               FROM direct_exchanges_data.market_latest_data
               WHERE market_id = $1 AND exchange_id = $2 AND outcome_side = 'YES'`,
              [mapping.market_id, mapping.exchange_id]
            );
            if (mldResult.rows.length > 0) {
              const mld = mldResult.rows[0]!;
              if (!latestUpdate || mld.updated_at > latestUpdate) latestUpdate = mld.updated_at;
              if (mld.band_vwap_bid != null)
                bids.push({ price: Math.round(Number(mld.band_vwap_bid) * 1000) / 10, qty: Number(mld.band_liquidity_qty_bid) || 0, exchange: exKey });
              if (mld.band_vwap_ask != null)
                asks.push({ price: Math.round(Number(mld.band_vwap_ask) * 1000) / 10, qty: Number(mld.band_liquidity_qty_ask) || 0, exchange: exKey });
            }
          }
        }

        // Filter to levels near the mid price (within 25 cents)
        const midCents = Math.round(midPrice * 1000) / 10;
        const range = 25; // cents
        const filteredBids = bids
          .filter(b => b.price >= midCents - range && b.price <= midCents + 5)
          .sort((a, b) => b.price - a.price)
          .slice(0, MAX_LEVELS);
        const filteredAsks = asks
          .filter(a => a.price >= midCents - 5 && a.price <= midCents + range)
          .sort((a, b) => a.price - b.price)
          .slice(0, MAX_LEVELS);

        const bestBid = filteredBids.length > 0 ? filteredBids[0]!.price : 0;
        const bestAsk = filteredAsks.length > 0 ? filteredAsks[0]!.price : 0;
        const spread = bestAsk > 0 && bestBid > 0 ? Math.round((bestAsk - bestBid) * 10) / 10 : 0;

        // Build per-exchange ask ladders for the calculator (walk the book)
        const askLadder: Record<string, { price: number; qty: number }[]> = {};
        for (const a of asks) {
          const ex = a.exchange || 'combined';
          if (!askLadder[ex]) askLadder[ex] = [];
          askLadder[ex].push({ price: a.price, qty: a.qty });
        }
        // Sort each ladder by price ascending
        for (const ex of Object.keys(askLadder)) {
          askLadder[ex]!.sort((a, b) => a.price - b.price);
        }

        return reply.send({
          mid: Math.round(midCents * 10) / 10,
          spread,
          bids: filteredBids,
          asks: filteredAsks,
          ask_ladder: askLadder,
          updated_at: latestUpdate?.toISOString() || null,
        });
      } catch (err) {
        logger.error({ err, marketId: id }, 'Failed to fetch orderbook');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // ═══════════════════════════════════════════════════
  // GET /api/v1/markets/:id/history — Price history
  // ═══════════════════════════════════════════════════
  fastify.get<{ Params: { id: string }; Querystring: { tf?: string; split?: string } }>(
    '/api/v1/markets/:id/history',
    {
      schema: {
        params: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
        querystring: {
          type: 'object',
          properties: {
            tf: { type: 'string', enum: ['today', '7d'], default: 'today' },
            split: { type: 'string', enum: ['true', 'false'], default: 'false' },
          },
        },
      },
    },
    async (request, reply) => {
      let { id } = request.params;
      const tf = request.query.tf || 'today';
      const split = request.query.split === 'true';

      try {
        // For CE-xxx events, get top outcomes and return multi-series history
        if (id.startsWith('CE-')) {
          return await handleEventHistory(fastify, id, tf, split, reply);
        }

        // Get mapped market IDs for this canonical market
        const mappings = await queryWithPool<{
          exchange_id: string;
          market_id: string;
        }>(
          fastify.apiPool,
          `SELECT exchange_id, market_id
           FROM direct_exchanges_data.market_mappings
           WHERE canonical_market_id = $1 AND outcome_side = 'YES'`,
          [id]
        );

        if (mappings.rows.length === 0) {
          return reply.status(404).send({ error: 'Market not found' });
        }

        const intervalHours = tf === 'today' ? 2 : 6;
        const lookback = tf === 'today' ? '24 hours' : '7 days';

        // Aggregate trades into time buckets per exchange
        const marketIdArr = mappings.rows.map(r => r.market_id);
        const exchangeIdArr = mappings.rows.map(r => r.exchange_id);

        const histResult = await queryWithPool<{
          bucket: Date;
          exchange_id: string;
          avg_price: number;
          trade_count: number;
        }>(
          fastify.apiPool,
          `SELECT
             date_trunc('hour', timestamp) +
               (EXTRACT(HOUR FROM timestamp)::int / ${intervalHours} * ${intervalHours} || ' hours')::interval AS bucket,
             t.exchange_id,
             AVG(t.price) AS avg_price,
             COUNT(*)::int AS trade_count
           FROM direct_exchanges_data.trades t
           WHERE t.market_id = ANY($1) AND t.exchange_id = ANY($2)
             AND t.timestamp >= NOW() - INTERVAL '${lookback}'
             AND t.outcome IN ('YES', 'Yes', 'yes')
           GROUP BY bucket, t.exchange_id
           ORDER BY bucket ASC`,
          [marketIdArr, exchangeIdArr]
        );

        // Build labels and series
        const bucketSet = new Set<string>();
        const seriesByExchange = new Map<string, Map<string, number>>();

        for (const row of histResult.rows) {
          const bucketKey = new Date(row.bucket).toISOString();
          bucketSet.add(bucketKey);

          const exKey = exchangeKey(row.exchange_id);
          if (!seriesByExchange.has(exKey)) {
            seriesByExchange.set(exKey, new Map());
          }
          seriesByExchange.get(exKey)!.set(bucketKey, Math.round(Number(row.avg_price) * 1000) / 10);
        }

        const labels = Array.from(bucketSet).sort();
        const formattedLabels = labels.map(l => {
          const d = new Date(l);
          if (tf === 'today') {
            return d.toLocaleTimeString('en', { hour: '2-digit', minute: '2-digit', hour12: false });
          }
          return d.toLocaleDateString('en', { month: 'short', day: 'numeric' });
        });

        // Combined series (average of exchanges) + per-exchange
        const series: { name: string; data: (number | null)[]; exchange?: string }[] = [];

        // Combined
        const combinedData = labels.map(l => {
          const vals: number[] = [];
          for (const [_, exMap] of seriesByExchange) {
            const v = exMap.get(l);
            if (v != null) vals.push(v);
          }
          return vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10 : null;
        });
        series.push({ name: 'Combined', data: combinedData });

        // Per exchange
        for (const [exKey, exMap] of seriesByExchange) {
          series.push({
            name: exchangeLabel(exKey),
            exchange: exKey,
            data: labels.map(l => exMap.get(l) ?? null),
          });
        }

        return reply.send({
          timeframe: tf,
          labels: formattedLabels,
          series,
          data_points: histResult.rows.length,
        });
      } catch (err) {
        logger.error({ err, marketId: id }, 'Failed to fetch price history');
        return reply.status(500).send({ error: 'Internal server error' });
      }
    }
  );

  // ─── GET /api/v1/translations/bulk ───
  // Bulk translation lookup for homepage market cards
  fastify.get<{
    Querystring: { ids: string; lang?: string };
  }>('/api/v1/translations/bulk', async (request, reply) => {
    const { ids, lang } = request.query;
    if (!ids || !lang || lang === 'en') {
      return reply.send({ translations: {} });
    }

    const idList = ids.split(',').slice(0, 100); // max 100 IDs per request
    if (idList.length === 0) {
      return reply.send({ translations: {} });
    }

    try {
      const result = await queryWithPool<{
        source_id: string;
        field: string;
        translated_text: string;
      }>(
        fastify.apiPool,
        `SELECT source_id, field, translated_text
         FROM direct_exchanges_data.translations
         WHERE source_id = ANY($1) AND language = $2`,
        [idList, lang]
      );

      // Group by source_id → { title: "...", kalshi_title: "..." }
      const translations: Record<string, Record<string, string>> = {};
      for (const row of result.rows) {
        if (!translations[row.source_id]) translations[row.source_id] = {};
        translations[row.source_id]![row.field] = row.translated_text;
      }

      // For CE-xxx event IDs, also fetch translated outcome labels from market titles
      const ceIds = idList.filter(id => id.startsWith('CE-'));
      if (ceIds.length > 0) {
        try {
          const outcomeResult = await queryWithPool<{
            canonical_event_id: string;
            canonical_market_id: string;
            translated_text: string;
          }>(
            fastify.apiPool,
            `SELECT DISTINCT em.canonical_event_id, mm.canonical_market_id,
                    COALESCE(tk.translated_text, t.translated_text) AS translated_text
             FROM direct_exchanges_data.event_mappings em
             JOIN direct_exchanges_data.prediction_markets pm
               ON em.event_id = pm.event_id AND em.exchange_id = pm.exchange_id
             JOIN direct_exchanges_data.market_mappings mm
               ON pm.market_id = mm.market_id AND pm.exchange_id = mm.exchange_id AND pm.outcome_side = mm.outcome_side
             LEFT JOIN direct_exchanges_data.translations tk
               ON tk.source_id = mm.canonical_market_id AND tk.source_table = 'market_titles' AND tk.field = 'kalshi_title' AND tk.language = $2
             LEFT JOIN direct_exchanges_data.translations t
               ON t.source_id = mm.canonical_market_id AND t.source_table = 'market_titles' AND t.field = 'title' AND t.language = $2
             WHERE em.canonical_event_id = ANY($1)
               AND pm.outcome_side = 'YES'
               AND mm.outcome_side = 'YES'
               AND (tk.translated_text IS NOT NULL OR t.translated_text IS NOT NULL)`,
            [ceIds, lang]
          );

          // Extract outcome name from translated title
          for (const row of outcomeResult.rows) {
            if (!translations[row.canonical_event_id]) translations[row.canonical_event_id] = {};
            const translated = row.translated_text || '';
            // Try em-dash format: "Question? — OutcomeName"
            const dashIdx = translated.lastIndexOf('\u2014');
            let outcomeName = dashIdx >= 0 ? translated.substring(dashIdx + 1).trim() : null;
            // Try "Will X win..." pattern (translated: "X会赢得...吗？")
            if (!outcomeName) {
              const willMatch = translated.match(/^(.+?)(?:会|将|能)(?:赢得|成为|获得|晋级|打进|达到|超过|推出)/);
              if (willMatch && willMatch[1]) {
                outcomeName = willMatch[1].trim();
              }
            }
            // Try colon pattern: "Title: OutcomeName"
            if (!outcomeName) {
              const colonIdx = translated.lastIndexOf('：') >= 0 ? translated.lastIndexOf('：') : translated.lastIndexOf(':');
              if (colonIdx >= 0 && colonIdx < translated.length - 1) {
                outcomeName = translated.substring(colonIdx + 1).trim();
              }
            }
            if (outcomeName) {
              translations[row.canonical_event_id]![`outcome_${row.canonical_market_id}`] = outcomeName;
            }
          }
        } catch (err) {
          logger.debug({ err }, 'Failed to fetch outcome translations for events');
        }
      }

      return reply.send({ translations });
    } catch (err) {
      logger.error({ err }, 'Failed to fetch bulk translations');
      return reply.send({ translations: {} });
    }
  });
}
