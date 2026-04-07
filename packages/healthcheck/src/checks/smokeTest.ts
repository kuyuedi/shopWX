import { getPool, createLogger } from '@prediction-market/shared';

const logger = createLogger('smoke-test');

/**
 * Escape HTML entities for Telegram HTML parsing
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export interface SmokeTestResult {
  name: string;
  passed: boolean;
  message: string;
  details?: Record<string, unknown>;
}

export interface SmokeTestSummary {
  totalTests: number;
  passed: number;
  failed: number;
  results: SmokeTestResult[];
  overallPassed: boolean;
}

interface QualityRow {
  exchange_id: string;
  total_markets: string;
  has_ref_price_pct: string;
  has_both_bands: string;
  negative_spreads: string;
  ref_outside_band: string;
  arb_ready_markets: string;
  arb_ready_pct: string;
}

interface OutcomeSideRow {
  outcome_side: string;
  count: string;
}

interface InvalidPriceRow {
  count: string;
}

interface NegativeSpreadRow {
  exchange_id: string;
  negative_spreads: string;
}

interface RefOutsideBandRow {
  exchange_id: string;
  ref_outside_band: string;
}

/**
 * Run all smoke tests for band metrics data integrity
 */
export async function runSmokeTests(): Promise<SmokeTestSummary> {
  const results: SmokeTestResult[] = [];
  const pool = getPool();

  // Test 1: Outcome Side Validation
  try {
    const query = `
      SELECT outcome_side, COUNT(*) as count
      FROM direct_exchanges_data.market_latest_data
      WHERE updated_at > NOW() - INTERVAL '1 hour'
      GROUP BY outcome_side
    `;
    const result = await pool.query<OutcomeSideRow>(query);
    const sides = result.rows.map(r => r.outcome_side);
    const hasUnknown = sides.includes('UNKNOWN');
    const hasOnlyValidSides = sides.every(s => s === 'YES' || s === 'NO');

    results.push({
      name: 'Outcome Sides',
      passed: !hasUnknown && hasOnlyValidSides,
      message: hasUnknown
        ? `Found UNKNOWN outcome_side in data`
        : hasOnlyValidSides
          ? `Only YES/NO outcome sides present`
          : `Unexpected outcome sides: ${sides.join(', ')}`,
      details: Object.fromEntries(result.rows.map(r => [r.outcome_side, parseInt(r.count, 10)])),
    });
  } catch (err) {
    results.push({
      name: 'Outcome Sides',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 2: Invalid Prices Check
  try {
    const query = `
      SELECT COUNT(*) as count
      FROM direct_exchanges_data.market_latest_data
      WHERE updated_at > NOW() - INTERVAL '1 hour'
        AND (
          reference_price < 0 OR reference_price > 1
          OR band_vwap_ask < 0 OR band_vwap_ask > 1
          OR band_vwap_bid < 0 OR band_vwap_bid > 1
        )
    `;
    const result = await pool.query<InvalidPriceRow>(query);
    const count = parseInt(result.rows[0]?.count || '0', 10);

    results.push({
      name: 'Invalid Prices',
      passed: count === 0,
      message: count === 0 ? 'All prices in valid range [0,1]' : `${count} records with invalid prices`,
      details: { invalidCount: count },
    });
  } catch (err) {
    results.push({
      name: 'Invalid Prices',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 3: Negative Spreads Check
  try {
    const query = `
      SELECT
        exchange_id,
        COUNT(*) as negative_spreads
      FROM direct_exchanges_data.market_latest_data
      WHERE band_vwap_ask IS NOT NULL
        AND band_vwap_bid IS NOT NULL
        AND band_vwap_ask < band_vwap_bid
        AND updated_at > NOW() - INTERVAL '1 hour'
      GROUP BY exchange_id
    `;
    const result = await pool.query<NegativeSpreadRow>(query);
    const totalNegativeSpreads = result.rows.reduce((sum, r) => sum + parseInt(r.negative_spreads, 10), 0);

    results.push({
      name: 'Negative Spreads',
      passed: totalNegativeSpreads === 0,
      message: totalNegativeSpreads === 0
        ? 'No negative spreads detected'
        : `${totalNegativeSpreads} markets with negative spreads (ask < bid)`,
      details: Object.fromEntries(result.rows.map(r => [r.exchange_id, parseInt(r.negative_spreads, 10)])),
    });
  } catch (err) {
    results.push({
      name: 'Negative Spreads',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 4: Reference Price Outside Band Check
  try {
    const query = `
      SELECT
        exchange_id,
        COUNT(*) as ref_outside_band
      FROM direct_exchanges_data.market_latest_data
      WHERE reference_price IS NOT NULL
        AND band_vwap_ask IS NOT NULL
        AND band_vwap_bid IS NOT NULL
        AND reference_price NOT BETWEEN band_vwap_bid AND band_vwap_ask
        AND updated_at > NOW() - INTERVAL '1 hour'
      GROUP BY exchange_id
    `;
    const result = await pool.query<RefOutsideBandRow>(query);
    const totalOutside = result.rows.reduce((sum, r) => sum + parseInt(r.ref_outside_band, 10), 0);

    results.push({
      name: 'Ref Outside Band',
      passed: totalOutside === 0,
      message: totalOutside === 0
        ? 'All reference prices within band'
        : `${totalOutside} markets with reference_price outside [vwap_bid, vwap_ask]`,
      details: Object.fromEntries(result.rows.map(r => [r.exchange_id, parseInt(r.ref_outside_band, 10)])),
    });
  } catch (err) {
    results.push({
      name: 'Ref Outside Band',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 5: Overall Quality Score
  try {
    const query = `
      SELECT
        exchange_id,
        COUNT(*) as total_markets,
        ROUND(100.0 * COUNT(reference_price) / COUNT(*), 1) as has_ref_price_pct,
        COUNT(CASE WHEN band_vwap_ask IS NOT NULL AND band_vwap_bid IS NOT NULL THEN 1 END) as has_both_bands,
        COUNT(CASE WHEN band_vwap_ask < band_vwap_bid THEN 1 END) as negative_spreads,
        COUNT(CASE WHEN reference_price NOT BETWEEN COALESCE(band_vwap_bid, 0) AND COALESCE(band_vwap_ask, 1)
                        AND band_vwap_ask IS NOT NULL AND band_vwap_bid IS NOT NULL THEN 1 END) as ref_outside_band,
        COUNT(CASE WHEN reference_price IS NOT NULL
                   AND band_vwap_ask IS NOT NULL
                   AND band_vwap_bid IS NOT NULL
                   AND band_vwap_ask >= band_vwap_bid THEN 1 END) as arb_ready_markets,
        ROUND(100.0 * COUNT(CASE WHEN reference_price IS NOT NULL
                                 AND band_vwap_ask IS NOT NULL
                                 AND band_vwap_bid IS NOT NULL
                                 AND band_vwap_ask >= band_vwap_bid THEN 1 END) / COUNT(*), 1) as arb_ready_pct
      FROM direct_exchanges_data.market_latest_data
      WHERE updated_at > NOW() - INTERVAL '1 hour'
      GROUP BY exchange_id
    `;
    const result = await pool.query<QualityRow>(query);

    let allPassed = true;
    const details: Record<string, unknown> = {};

    for (const row of result.rows) {
      const arbReadyPct = parseFloat(row.arb_ready_pct);
      const negativeSpreads = parseInt(row.negative_spreads, 10);
      const refOutsideBand = parseInt(row.ref_outside_band, 10);

      // Check thresholds based on exchange
      const minArbReadyPct = row.exchange_id === 'POLYMARKET' ? 3 : 5;
      const passed = arbReadyPct >= minArbReadyPct && negativeSpreads === 0 && refOutsideBand === 0;

      if (!passed) allPassed = false;

      details[row.exchange_id] = {
        totalMarkets: parseInt(row.total_markets, 10),
        arbReadyMarkets: parseInt(row.arb_ready_markets, 10),
        arbReadyPct,
        negativeSpreads,
        refOutsideBand,
        passed,
      };
    }

    results.push({
      name: 'Overall Quality',
      passed: allPassed,
      message: allPassed
        ? 'All exchanges meet quality thresholds'
        : 'Some exchanges below quality thresholds',
      details,
    });
  } catch (err) {
    results.push({
      name: 'Overall Quality',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 6: Arb-Ready Markets Count
  try {
    const query = `
      SELECT COUNT(*) as count
      FROM direct_exchanges_data.market_latest_data
      WHERE reference_price IS NOT NULL
        AND band_vwap_ask IS NOT NULL
        AND band_vwap_bid IS NOT NULL
        AND band_vwap_ask >= band_vwap_bid
        AND updated_at > NOW() - INTERVAL '1 hour'
    `;
    const result = await pool.query<{ count: string }>(query);
    const count = parseInt(result.rows[0]?.count || '0', 10);

    results.push({
      name: 'Arb-Ready Markets',
      passed: count >= 5000,
      message: count >= 5000
        ? `${count.toLocaleString()} arb-ready markets available`
        : `Only ${count.toLocaleString()} arb-ready markets (expected 5,000+)`,
      details: { arbReadyCount: count },
    });
  } catch (err) {
    results.push({
      name: 'Arb-Ready Markets',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 7: Open Market Count
  try {
    const query = `
      SELECT COUNT(*) as count
      FROM direct_exchanges_data.prediction_markets
      WHERE status = 'Open'
    `;
    const result = await pool.query<{ count: string }>(query);
    const count = parseInt(result.rows[0]?.count || '0', 10);

    results.push({
      name: 'Open Market Count',
      passed: count >= 40000,
      message: count >= 40000
        ? `${count.toLocaleString()} open markets (healthy)`
        : `Only ${count.toLocaleString()} open markets (expected 40,000+)`,
      details: { openMarketCount: count },
    });
  } catch (err) {
    results.push({
      name: 'Open Market Count',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 8: Both Exchanges Active
  try {
    const query = `
      SELECT exchange_id, COUNT(*) as count
      FROM direct_exchanges_data.market_latest_data
      WHERE updated_at > NOW() - INTERVAL '1 hour'
      GROUP BY exchange_id
    `;
    const result = await pool.query<{ exchange_id: string; count: string }>(query);
    const exchanges = result.rows.map(r => r.exchange_id);
    const hasKalshi = exchanges.includes('KALSHI');
    const hasPolymarket = exchanges.includes('POLYMARKET');
    const bothActive = hasKalshi && hasPolymarket;

    results.push({
      name: 'Both Exchanges Active',
      passed: bothActive,
      message: bothActive
        ? 'Both KALSHI and POLYMARKET have recent data'
        : `Missing exchanges: ${!hasKalshi ? 'KALSHI ' : ''}${!hasPolymarket ? 'POLYMARKET' : ''}`.trim(),
      details: Object.fromEntries(result.rows.map(r => [r.exchange_id, parseInt(r.count, 10)])),
    });
  } catch (err) {
    results.push({
      name: 'Both Exchanges Active',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 9: Data Freshness (market_latest_data updated within last 5 minutes)
  try {
    const query = `
      SELECT MAX(updated_at) as latest
      FROM direct_exchanges_data.market_latest_data
    `;
    const result = await pool.query<{ latest: Date | null }>(query);
    const latest = result.rows[0]?.latest ?? null;
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const isFresh = latest !== null && latest > fiveMinAgo;

    results.push({
      name: 'Data Freshness',
      passed: isFresh,
      message: isFresh
        ? `Latest update: ${latest.toISOString()}`
        : latest
          ? `Stale data - latest update: ${latest.toISOString()} (over 5 min ago)`
          : 'No data found in market_latest_data',
      details: { latestUpdate: latest?.toISOString() ?? null },
    });
  } catch (err) {
    results.push({
      name: 'Data Freshness',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  // Test 10: Order Book Freshness (order_books updated within last 5 minutes)
  try {
    const query = `
      SELECT MAX(created_at) as latest
      FROM direct_exchanges_data.order_books
    `;
    const result = await pool.query<{ latest: Date | null }>(query);
    const latest = result.rows[0]?.latest ?? null;
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
    const isFresh = latest !== null && latest > fiveMinAgo;

    results.push({
      name: 'Order Book Freshness',
      passed: isFresh,
      message: isFresh
        ? `Latest order book: ${latest.toISOString()}`
        : latest
          ? `Stale order books - latest: ${latest.toISOString()} (over 5 min ago)`
          : 'No order books found',
      details: { latestOrderBook: latest?.toISOString() ?? null },
    });
  } catch (err) {
    results.push({
      name: 'Order Book Freshness',
      passed: false,
      message: `Query failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
    });
  }

  const passed = results.filter(r => r.passed).length;
  const failed = results.filter(r => !r.passed).length;

  logger.info({ passed, failed, total: results.length }, 'Smoke tests completed');

  return {
    totalTests: results.length,
    passed,
    failed,
    results,
    overallPassed: failed === 0,
  };
}

/**
 * Format smoke test results for Telegram message
 */
export function formatSmokeTestMessage(summary: SmokeTestSummary, serverIp: string): string {
  const timestamp = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
  const overallEmoji = summary.overallPassed ? '✅' : '❌';

  let message = `${overallEmoji} <b>Deployment Smoke Test</b>\n`;
  message += `Server: ${serverIp}\n`;
  message += `Time: ${timestamp}\n`;
  message += `Results: ${summary.passed}/${summary.totalTests} passed\n\n`;

  for (const result of summary.results) {
    const emoji = result.passed ? '✅' : '❌';
    message += `${emoji} <b>${escapeHtml(result.name)}</b>: ${escapeHtml(result.message)}\n`;
  }

  if (!summary.overallPassed) {
    message += `\n⚠️ <b>Action Required:</b> Review failed tests`;
  }

  return message;
}
