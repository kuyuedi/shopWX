import {
  createLogger,
  fetchArbConfig,
  fetchMatchedMarketLegs,
  upsertArbOpportunities,
  expireEvaluatedArbs,
} from '@prediction-market/shared';
import type { MarketLeg, ArbOpportunity, ArbSubtype } from '@prediction-market/shared';
import { refreshStaleLegs } from './orderbookRefresher.js';

const logger = createLogger('arb-scanner');

type ArbOppInsert = Omit<ArbOpportunity, 'arb_id' | 'detected_at' | 'updated_at' | 'last_checked_at' | 'expired_at' | 'prev_gross_spread_pct'>;

const TIME_DECAY_THRESHOLD_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

function classifySubtype(arbType: 'DIRECT' | 'COMPLEMENT', expiresAt: Date | null): ArbSubtype {
  if (arbType === 'DIRECT') return 'LIQUIDITY_GAP';
  if (expiresAt != null) {
    const msToExpiry = expiresAt.getTime() - Date.now();
    if (msToExpiry > 0 && msToExpiry <= TIME_DECAY_THRESHOLD_MS) return 'TIME_DECAY';
  }
  return 'CROSS_PLATFORM';
}

let cachedConfig: Map<string, string> | null = null;
let cycleCount = 0;

function getConfigNum(config: Map<string, string>, key: string, fallback: number): number {
  const val = config.get(key);
  return val !== undefined ? parseFloat(val) : fallback;
}

let scanInProgress = false;

export async function scanForArbs(): Promise<number> {
  if (scanInProgress) {
    logger.debug('Scan already in progress, skipping this cycle');
    return 0;
  }
  scanInProgress = true;
  try {
    return await _scanForArbsInner();
  } finally {
    scanInProgress = false;
  }
}

async function _scanForArbsInner(): Promise<number> {
  // Reload config every 30 cycles (~5 min at 10s interval)
  if (!cachedConfig || cycleCount % 30 === 0) {
    try {
      cachedConfig = await fetchArbConfig();
      logger.debug({ configSize: cachedConfig.size }, 'Loaded arb config');
    } catch (err) {
      logger.error({ err }, 'Failed to load arb config, using defaults');
      if (!cachedConfig) cachedConfig = new Map();
    }
  }
  cycleCount++;

  const config = cachedConfig;
  const minArbPct = getConfigNum(config, 'min_arb_pct', 0.02);
  const minConfidence = getConfigNum(config, 'min_confidence', 0.95);
  const maxStalenessSec = getConfigNum(config, 'max_staleness_sec', 30);
  const minExecutableQty = getConfigNum(config, 'min_executable_qty', 10);
  const minLiquidityUsd = getConfigNum(config, 'min_liquidity_usd', 5);
  const expireGraceSec = getConfigNum(config, 'expire_grace_sec', 30);
  const maxPlausibleSpread = getConfigNum(config, 'max_plausible_spread_pct', 0.30);

  // REST fallback config
  const restFallbackEnabled = config.get('rest_fallback_enabled') !== 'false';
  const restCooldownSec = getConfigNum(config, 'rest_refresh_cooldown_sec', 60);
  const restConcurrency = getConfigNum(config, 'rest_concurrency', 10);
  const restTimeoutMs = getConfigNum(config, 'rest_timeout_ms', 5000);

  // Fetch ALL matched market legs (no staleness filter when REST fallback enabled)
  const rawLegs = await fetchMatchedMarketLegs(
    restFallbackEnabled ? null : maxStalenessSec,
    minConfidence,
  );
  const allLegs = rawLegs.map(l => ({
    ...l,
    band_vwap_ask: l.band_vwap_ask != null ? Number(l.band_vwap_ask) : null,
    band_vwap_bid: l.band_vwap_bid != null ? Number(l.band_vwap_bid) : null,
    band_liquidity_qty_ask: l.band_liquidity_qty_ask != null ? Number(l.band_liquidity_qty_ask) : null,
    band_liquidity_qty_bid: l.band_liquidity_qty_bid != null ? Number(l.band_liquidity_qty_bid) : null,
    confidence_score: Number(l.confidence_score),
  }));

  // Partition into fresh/stale legs
  const stalenessMs = maxStalenessSec * 1000;
  const now = Date.now();
  const freshLegs: MarketLeg[] = [];
  const staleLegs: MarketLeg[] = [];

  for (const leg of allLegs) {
    const age = now - new Date(leg.data_updated_at).getTime();
    if (age <= stalenessMs) {
      freshLegs.push(leg);
    } else {
      staleLegs.push(leg);
    }
  }

  // Refresh stale legs via REST if enabled
  // Only refresh stale legs that have a fresh counterpart on the OTHER exchange —
  // no point refreshing a stale Kalshi leg if Polymarket is also stale.
  if (restFallbackEnabled && staleLegs.length > 0) {
    const freshCanonicalIds = new Set<string>();
    for (const leg of freshLegs) {
      freshCanonicalIds.add(leg.canonical_market_id);
    }
    const refreshableStaleLegs = staleLegs.filter(leg =>
      freshCanonicalIds.has(leg.canonical_market_id)
    );
    logger.info({
      totalStale: staleLegs.length,
      refreshable: refreshableStaleLegs.length,
      skippedNoPair: staleLegs.length - refreshableStaleLegs.length,
    }, 'Filtered stale legs for REST refresh');

    const { refreshed, failed, emptyBooks } = await refreshStaleLegs(refreshableStaleLegs, restConcurrency, restCooldownSec, restTimeoutMs);
    for (const leg of refreshed) {
      freshLegs.push(leg);
    }
    logger.info({
      staleLegsCount: staleLegs.length,
      refreshedCount: refreshed.length,
      emptyBooks,
      failedCount: failed,
    }, 'REST orderbook refresh complete');
  }

  const legs = freshLegs;
  if (legs.length === 0) {
    const longGraceSec = getConfigNum(config, 'expire_long_grace_sec', 90);
    const expired = await expireEvaluatedArbs([], expireGraceSec, longGraceSec);
    if (expired > 0) logger.info({ expired }, 'Expired stale arbs (no legs found)');
    return 0;
  }

  // Group legs by canonical_market_id
  const marketGroups = new Map<string, MarketLeg[]>();
  for (const leg of legs) {
    const group = marketGroups.get(leg.canonical_market_id);
    if (group) {
      group.push(leg);
    } else {
      marketGroups.set(leg.canonical_market_id, [leg]);
    }
  }

  const evaluatedCanonicalIds: string[] = [];
  for (const [canonicalId, marketLegs] of marketGroups) {
    const exchangeSides = new Map<string, Set<string>>();
    for (const leg of marketLegs) {
      if (!exchangeSides.has(leg.exchange_id)) {
        exchangeSides.set(leg.exchange_id, new Set());
      }
      exchangeSides.get(leg.exchange_id)!.add(leg.outcome_side);
    }
    const completeExchanges = [...exchangeSides.values()].filter(
      sides => sides.has('YES') && sides.has('NO'),
    ).length;
    if (completeExchanges >= 2) {
      evaluatedCanonicalIds.push(canonicalId);
    }
  }

  const opportunities: ArbOppInsert[] = [];

  for (const [canonicalId, marketLegs] of marketGroups) {
    // Get unique exchanges for this market
    const exchanges = [...new Set(marketLegs.map(l => l.exchange_id))];
    if (exchanges.length < 2) continue;

    // Type A: Direct arbs — same side, different exchanges
    // Buy on exchange with lower ask, sell on exchange with higher bid
    for (const side of ['YES', 'NO'] as const) {
      const sideLegs = marketLegs.filter(l => l.outcome_side === side);

      for (let i = 0; i < sideLegs.length; i++) {
        for (let j = 0; j < sideLegs.length; j++) {
          if (i === j) continue;
          const buyLeg = sideLegs[i]!;
          const sellLeg = sideLegs[j]!;
          if (buyLeg.exchange_id === sellLeg.exchange_id) continue;

          const askPrice = buyLeg.band_vwap_ask;
          const bidPrice = sellLeg.band_vwap_bid;
          if (askPrice == null || bidPrice == null || askPrice === 0) continue;

          // Bug 6: skip expired markets
          if (buyLeg.expires_at && buyLeg.expires_at <= new Date()) continue;
          if (sellLeg.expires_at && sellLeg.expires_at <= new Date()) continue;

          // Bug 6: skip resolved markets (VWAP near 0 or 1)
          if (askPrice <= 0.01 || askPrice >= 0.99) continue;
          if (bidPrice <= 0.01 || bidPrice >= 0.99) continue;

          const spread = bidPrice - askPrice;
          if (spread <= 0) continue;

          const spreadPct = spread / Math.max(askPrice, bidPrice);
          if (spreadPct < minArbPct) continue;

          // Bug 7: reject implausibly large spreads
          if (spreadPct > maxPlausibleSpread) {
            logger.warn({
              canonicalMarketId: canonicalId,
              leg1: `${buyLeg.exchange_id}:${buyLeg.market_id}`,
              leg2: `${sellLeg.exchange_id}:${sellLeg.market_id}`,
              spreadPct,
              askPrice,
              bidPrice,
            }, 'Arb rejected: spread exceeds max plausible threshold');
            continue;
          }

          const execQty = Math.min(
            buyLeg.band_liquidity_qty_ask ?? 0,
            sellLeg.band_liquidity_qty_bid ?? 0,
          );
          if (execQty < minExecutableQty) continue;

          const grossProfit = spread * execQty;
          if (grossProfit < minLiquidityUsd) continue;

          opportunities.push({
            canonical_market_id: canonicalId,
            canonical_event_id: buyLeg.canonical_event_id,
            arb_type: 'DIRECT',
            arb_subtype: classifySubtype('DIRECT', buyLeg.expires_at),
            leg1_exchange_id: buyLeg.exchange_id,
            leg1_source_id: buyLeg.source_id,
            leg1_market_id: buyLeg.market_id,
            leg1_side: side,
            leg1_action: 'BUY',
            leg1_vwap: askPrice,
            leg1_liquidity_qty: buyLeg.band_liquidity_qty_ask,
            leg2_exchange_id: sellLeg.exchange_id,
            leg2_source_id: sellLeg.source_id,
            leg2_market_id: sellLeg.market_id,
            leg2_side: side,
            leg2_action: 'SELL',
            leg2_vwap: bidPrice,
            leg2_liquidity_qty: sellLeg.band_liquidity_qty_bid,
            gross_spread: spread,
            gross_spread_pct: spreadPct,
            executable_qty: execQty,
            gross_profit: grossProfit,
            market_title: buyLeg.market_title,
            category: buyLeg.category,
            expires_at: buyLeg.expires_at,
            mapping_confidence: buyLeg.confidence_score,
            status: 'ACTIVE',
            leg1_data_at: buyLeg.data_updated_at,
            leg2_data_at: sellLeg.data_updated_at,
          });
        }
      }
    }

    // Type B: Complement arbs — buy YES on one exchange, buy NO on another
    // If combined cost < 1.00, guaranteed profit at settlement
    const yesLegs = marketLegs.filter(l => l.outcome_side === 'YES');
    const noLegs = marketLegs.filter(l => l.outcome_side === 'NO');

    for (const yesLeg of yesLegs) {
      for (const noLeg of noLegs) {
        if (yesLeg.exchange_id === noLeg.exchange_id) continue;

        const yesAsk = yesLeg.band_vwap_ask;
        const noAsk = noLeg.band_vwap_ask;
        if (yesAsk == null || noAsk == null) continue;

        // Bug 6: skip expired markets
        if (yesLeg.expires_at && yesLeg.expires_at <= new Date()) continue;
        if (noLeg.expires_at && noLeg.expires_at <= new Date()) continue;

        // Bug 6: skip resolved markets (VWAP near 0 or 1)
        if (yesAsk <= 0.01 || yesAsk >= 0.99) continue;
        if (noAsk <= 0.01 || noAsk >= 0.99) continue;

        const combinedCost = yesAsk + noAsk;
        if (combinedCost >= 1.0 || combinedCost <= 0) continue;

        const spread = 1.0 - combinedCost;
        const spreadPct = spread / combinedCost;
        if (spreadPct < minArbPct) continue;

        // Bug 7: reject implausibly large spreads
        if (spreadPct > maxPlausibleSpread) {
          logger.warn({
            canonicalMarketId: canonicalId,
            leg1: `${yesLeg.exchange_id}:${yesLeg.market_id}`,
            leg2: `${noLeg.exchange_id}:${noLeg.market_id}`,
            spreadPct,
            yesAsk,
            noAsk,
          }, 'Complement arb rejected: spread exceeds max plausible threshold');
          continue;
        }

        const execQty = Math.min(
          yesLeg.band_liquidity_qty_ask ?? 0,
          noLeg.band_liquidity_qty_ask ?? 0,
        );
        if (execQty < minExecutableQty) continue;

        const grossProfit = spread * execQty;
        if (grossProfit < minLiquidityUsd) continue;

        opportunities.push({
          canonical_market_id: canonicalId,
          canonical_event_id: yesLeg.canonical_event_id,
          arb_type: 'COMPLEMENT',
          arb_subtype: classifySubtype('COMPLEMENT', yesLeg.expires_at),
          leg1_exchange_id: yesLeg.exchange_id,
          leg1_source_id: yesLeg.source_id,
          leg1_market_id: yesLeg.market_id,
          leg1_side: 'YES',
          leg1_action: 'BUY',
          leg1_vwap: yesAsk,
          leg1_liquidity_qty: yesLeg.band_liquidity_qty_ask,
          leg2_exchange_id: noLeg.exchange_id,
          leg2_source_id: noLeg.source_id,
          leg2_market_id: noLeg.market_id,
          leg2_side: 'NO',
          leg2_action: 'BUY',
          leg2_vwap: noAsk,
          leg2_liquidity_qty: noLeg.band_liquidity_qty_ask,
          gross_spread: spread,
          gross_spread_pct: spreadPct,
          executable_qty: execQty,
          gross_profit: grossProfit,
          market_title: yesLeg.market_title,
          category: yesLeg.category,
          expires_at: yesLeg.expires_at,
          mapping_confidence: Math.min(yesLeg.confidence_score, noLeg.confidence_score),
          status: 'ACTIVE',
          leg1_data_at: yesLeg.data_updated_at,
          leg2_data_at: noLeg.data_updated_at,
        });
      }
    }
  }

  // Bug 4: Dedup DIRECT arbs — for each canonical_market_id, keep only the one with highest spread
  const directBest = new Map<string, ArbOppInsert>();
  const nonDirect: ArbOppInsert[] = [];

  for (const opp of opportunities) {
    if (opp.arb_type !== 'DIRECT') {
      nonDirect.push(opp);
      continue;
    }
    const key = `${opp.canonical_market_id}:DIRECT:${[opp.leg1_exchange_id, opp.leg2_exchange_id].sort().join(':')}`;
    const existing = directBest.get(key);
    if (!existing || opp.gross_spread_pct > existing.gross_spread_pct) {
      directBest.set(key, opp);
    }
  }

  const deduped = [...nonDirect, ...directBest.values()];

  // Upsert opportunities
  if (deduped.length > 0) {
    await upsertArbOpportunities(deduped);
  }

  // Expire stale arbs not refreshed this cycle
  const longGraceSec = getConfigNum(config, 'expire_long_grace_sec', 90);
  const expired = await expireEvaluatedArbs(evaluatedCanonicalIds, expireGraceSec, longGraceSec);

  logger.info({
    legsQueried: legs.length,
    marketsScanned: marketGroups.size,
    arbsFound: deduped.length,
    arbsDedupRemoved: opportunities.length - deduped.length,
    arbsExpired: expired,
  }, 'Arb scan complete');

  return deduped.length;
}
