import 'dotenv/config';
import {
  createLogger,
  closePool,
  healthCheck,
  isTransientError,
  resetPool,
  deleteClosedMarkets,
  deleteClosedEvents,
  upsertEventsBatch,
  markStaleEventsAsClosed,
  fetchMatchedMarketIds,
  setMatchedMarketIds,
  POLYMARKET_SOURCE_ID,
  POLYMARKET_EXCHANGE_ID,
} from '@prediction-market/shared';
import { PolymarketWebSocketPool } from './websocket/pool.js';
import { shutdownWriters } from './websocket/handlers.js';
import { fetchEventsWithMarkets, syncMarkets } from './services/gammaApi.js';

const logger = createLogger('polymarket-listener');

const config = {
  wsUrl: process.env.POLYMARKET_WS_URL || 'wss://ws-subscriptions-clob.polymarket.com/ws/market',
  gammaUrl: process.env.POLYMARKET_GAMMA_URL || 'https://gamma-api.polymarket.com',
  marketRefreshIntervalMs: parseInt(process.env.MARKET_REFRESH_INTERVAL_MS || '60000', 10), // 1 minute
  marketsPerSocket: parseInt(process.env.MARKETS_PER_SOCKET || '500', 10), // Polymarket's limit
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10), // 1 hour
  cleanupRetentionMs: parseInt(process.env.CLEANUP_RETENTION_MS || '86400000', 10), // 24 hours
};

let wsPool: PolymarketWebSocketPool | null = null;
let marketRefreshInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

async function refreshMarkets(): Promise<string[]> {
  logger.info('Refreshing market list from Gamma API');
  const syncStartTime = new Date();

  const { events, markets, eventMapping } = await fetchEventsWithMarkets(config.gammaUrl);
  await syncMarkets(markets, eventMapping);

  // Sync events to the events table
  const CHUNK_SIZE = 100;
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE);
    await upsertEventsBatch(chunk);
  }
  logger.info({ totalEvents: events.length }, 'Synced all events to database');

  // Mark stale events as closed
  await markStaleEventsAsClosed(POLYMARKET_SOURCE_ID, POLYMARKET_EXCHANGE_ID, syncStartTime);

  // Load matched market IDs to gate price_change DB writes
  const matchedIds = await fetchMatchedMarketIds(POLYMARKET_EXCHANGE_ID);
  setMatchedMarketIds(matchedIds);
  logger.info({ matchedMarkets: matchedIds.size }, 'Loaded matched market IDs for write filtering');

  const assetIds: string[] = [];
  for (const market of markets) {
    if (market.clobTokenIds) {
      try {
        const tokenIds = JSON.parse(market.clobTokenIds) as string[];
        for (const tokenId of tokenIds) {
          if (tokenId) {
            assetIds.push(tokenId);
          }
        }
      } catch {
        // Skip markets with invalid clobTokenIds
      }
    }
  }

  logger.info({ count: assetIds.length }, 'Market list refreshed');
  return assetIds;
}

async function main(): Promise<void> {
  logger.info('Starting Polymarket listener');

  // Check database connectivity
  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    throw new Error('Database health check failed');
  }
  logger.info('Database connection verified');

  // Initial market sync
  const assetIds = await refreshMarkets();

  // Initialize WebSocket pool
  wsPool = new PolymarketWebSocketPool({ url: config.wsUrl }, config.marketsPerSocket);
  await wsPool.subscribeToMarkets(assetIds);
  logger.info({ subscribed: assetIds.length }, 'Subscribed to markets via pool');

  // Set up periodic market refresh
  marketRefreshInterval = setInterval(async () => {
    try {
      const newAssetIds = await refreshMarkets();
      await wsPool?.subscribeToMarkets(newAssetIds);
    } catch (err) {
      logger.error({ err }, 'Failed to refresh markets');
    }
  }, config.marketRefreshIntervalMs);

  // Set up periodic closed market cleanup
  if (config.cleanupIntervalMs > 0) {
    cleanupInterval = setInterval(async () => {
      try {
        await deleteClosedMarkets(
          POLYMARKET_SOURCE_ID,
          POLYMARKET_EXCHANGE_ID,
          config.cleanupRetentionMs
        );
        await deleteClosedEvents(
          POLYMARKET_SOURCE_ID,
          POLYMARKET_EXCHANGE_ID,
          config.cleanupRetentionMs
        );
      } catch (err) {
        logger.error({ err }, 'Failed to run closed market/event cleanup');
      }
    }, config.cleanupIntervalMs);
    logger.info({
      intervalMs: config.cleanupIntervalMs,
      retentionMs: config.cleanupRetentionMs,
    }, 'Starting closed market cleanup interval');
  }

  logger.info('Polymarket listener started successfully');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down');

  if (marketRefreshInterval) {
    clearInterval(marketRefreshInterval);
    marketRefreshInterval = null;
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  if (wsPool) {
    await wsPool.closeAll();
    wsPool = null;
  }

  await shutdownWriters();
  await closePool();

  logger.info('Shutdown complete');
  process.exit(0);
}

// Handle graceful shutdown
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// Handle uncaught errors
process.on('uncaughtException', async (err) => {
  if (isTransientError(err)) {
    logger.warn({ err }, 'Transient error caught - attempting recovery');
    try {
      await resetPool();
      logger.info('Pool reset successful, continuing operation');
    } catch (resetErr) {
      logger.error({ err: resetErr }, 'Failed to reset pool');
    }
    return; // Don't exit - let the app continue
  }

  logger.fatal({ err }, 'Uncaught exception');
  shutdown('uncaughtException').catch(() => process.exit(1));
});

process.on('unhandledRejection', async (reason) => {
  if (isTransientError(reason)) {
    logger.warn({ reason }, 'Transient rejection caught - attempting recovery');
    try {
      await resetPool();
      logger.info('Pool reset successful, continuing operation');
    } catch (resetErr) {
      logger.error({ err: resetErr }, 'Failed to reset pool');
    }
    return; // Don't exit - let the app continue
  }

  logger.fatal({ reason }, 'Unhandled rejection');
  shutdown('unhandledRejection').catch(() => process.exit(1));
});

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
