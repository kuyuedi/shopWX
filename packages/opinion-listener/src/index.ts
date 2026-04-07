import 'dotenv/config';
import {
  createLogger,
  closePool,
  healthCheck,
  isTransientError,
  resetPool,
  deleteClosedMarkets,
  deleteClosedEvents,
  OPINION_SOURCE_ID,
  OPINION_EXCHANGE_ID,
} from '@prediction-market/shared';
import { loadConfig } from './config.js';
import { refreshMarkets } from './services/marketSync.js';
import { OpinionWebSocketPool } from './websocket/pool.js';
import { handleMessage, shutdownWriters } from './websocket/handlers.js';

const logger = createLogger('opinion-listener');

let wsPool: OpinionWebSocketPool | null = null;
let marketRefreshInterval: ReturnType<typeof setInterval> | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

async function main(): Promise<void> {
  const config = loadConfig();
  logger.info({ restUrl: config.restUrl, wsUrl: config.wsUrl }, 'Starting Opinion listener');

  // Check database connectivity
  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    throw new Error('Database health check failed');
  }
  logger.info('Database connection verified');

  // Initial market sync
  const { marketIds, rootMarketIds } = await refreshMarkets(config);

  // Initialize WebSocket pool
  wsPool = new OpinionWebSocketPool(
    config.wsUrl,
    config.apiKey,
    config.marketsPerSocket,
    handleMessage,
  );

  // Subscribe to all active markets
  await wsPool.subscribeToMarkets(marketIds, rootMarketIds);
  logger.info({
    binaryMarkets: marketIds.length,
    categoricalRoots: rootMarketIds.length,
  }, 'Completed initial market subscriptions');

  // Set up periodic market refresh
  marketRefreshInterval = setInterval(async () => {
    try {
      const updated = await refreshMarkets(config);
      await wsPool?.subscribeToMarkets(updated.marketIds, updated.rootMarketIds);
    } catch (err) {
      logger.error({ err }, 'Failed to refresh markets');
    }
  }, config.marketRefreshIntervalMs);

  // Set up periodic closed market cleanup
  if (config.cleanupIntervalMs > 0) {
    cleanupInterval = setInterval(async () => {
      try {
        await deleteClosedMarkets(
          OPINION_SOURCE_ID,
          OPINION_EXCHANGE_ID,
          config.cleanupRetentionMs,
        );
        await deleteClosedEvents(
          OPINION_SOURCE_ID,
          OPINION_EXCHANGE_ID,
          config.cleanupRetentionMs,
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

  logger.info('Opinion listener started successfully');
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
    return;
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
    return;
  }

  logger.fatal({ reason }, 'Unhandled rejection');
  shutdown('unhandledRejection').catch(() => process.exit(1));
});

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
