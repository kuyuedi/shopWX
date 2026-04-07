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
  KALSHI_SOURCE_ID,
  KALSHI_EXCHANGE_ID,
} from '@prediction-market/shared';
import { KalshiWebSocketPool } from './websocket/pool.js';
import { shutdownWriters } from './websocket/handlers.js';
import { fetchActiveMarkets, syncMarkets, syncMarketOHLC } from './services/marketSync.js';

const logger = createLogger('kalshi-listener');

const config = {
  wsUrl: process.env.KALSHI_WS_URL || 'wss://api.elections.kalshi.com/trade-api/ws/v2',
  restUrl: process.env.KALSHI_REST_URL || 'https://api.elections.kalshi.com/trade-api/v2',
  apiKey: process.env.KALSHI_API_KEY,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
  marketRefreshIntervalMs: parseInt(process.env.MARKET_REFRESH_INTERVAL_MS || '60000', 10), // 1 minute
  marketsPerSocket: parseInt(process.env.KALSHI_MARKETS_PER_SOCKET || '2000', 10),
  cleanupIntervalMs: parseInt(process.env.CLEANUP_INTERVAL_MS || '3600000', 10), // 1 hour
  cleanupRetentionMs: parseInt(process.env.CLEANUP_RETENTION_MS || '86400000', 10), // 24 hours
};

let wsPool: KalshiWebSocketPool | null = null;
let marketRefreshInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

async function refreshMarkets(): Promise<string[]> {
  logger.info('Refreshing market list');
  const syncStartTime = new Date();

  const { markets, events } = await fetchActiveMarkets(config.restUrl, config.apiKey);
  await syncMarkets(markets);

  // Sync events to the events table
  const CHUNK_SIZE = 100;
  for (let i = 0; i < events.length; i += CHUNK_SIZE) {
    const chunk = events.slice(i, i + CHUNK_SIZE);
    await upsertEventsBatch(chunk);
  }
  logger.info({ totalEvents: events.length }, 'Synced all events to database');

  // Mark stale events as closed
  await markStaleEventsAsClosed(KALSHI_SOURCE_ID, KALSHI_EXCHANGE_ID, syncStartTime);

  // Sync OHLC data from candlesticks API
  await syncMarketOHLC(config.restUrl, markets, config.apiKey);

  const tickers = markets.map((m) => m.ticker);
  logger.info({ count: tickers.length }, 'Market list refreshed');

  return tickers;
}

async function main(): Promise<void> {
  logger.info('Starting Kalshi listener');

  // Check database connectivity
  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    throw new Error('Database health check failed');
  }
  logger.info('Database connection verified');

  // Initial market sync
  const tickers = await refreshMarkets();

  // Initialize WebSocket pool
  wsPool = new KalshiWebSocketPool(
    {
      url: config.wsUrl,
      apiKey: config.apiKey,
      privateKeyPath: config.privateKeyPath,
    },
    config.marketsPerSocket
  );

  // Subscribe to all active markets using the pool
  await wsPool.subscribeToMarkets(tickers);
  logger.info({ count: tickers.length }, 'Completed initial market subscriptions');

  // Set up periodic market refresh
  marketRefreshInterval = setInterval(async () => {
    try {
      const newTickers = await refreshMarkets();

      // Resubscribe to all markets using the pool
      // The pool will close existing connections and create new ones
      await wsPool?.subscribeToMarkets(newTickers);
    } catch (err) {
      logger.error({ err }, 'Failed to refresh markets');
    }
  }, config.marketRefreshIntervalMs);

  // Set up periodic closed market cleanup
  if (config.cleanupIntervalMs > 0) {
    cleanupInterval = setInterval(async () => {
      try {
        await deleteClosedMarkets(
          KALSHI_SOURCE_ID,
          KALSHI_EXCHANGE_ID,
          config.cleanupRetentionMs
        );
        await deleteClosedEvents(
          KALSHI_SOURCE_ID,
          KALSHI_EXCHANGE_ID,
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

  logger.info('Kalshi listener started successfully');
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
