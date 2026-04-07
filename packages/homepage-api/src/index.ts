import 'dotenv/config';
import type pg from 'pg';
import { createLogger, healthCheck, closePool, createPool } from '@prediction-market/shared';
import { getConfig } from './config.js';
import { buildServer } from './server.js';
import { computeScores } from './services/scoreComputer.js';
import { scanForArbs } from './services/arbScanner.js';
import { initRefresher } from './services/orderbookRefresher.js';
import { translateNewContent } from './services/translationService.js';

const logger = createLogger('homepage-api');

let intervalId: ReturnType<typeof setInterval> | null = null;
let arbIntervalId: ReturnType<typeof setInterval> | null = null;
let translationIntervalId: ReturnType<typeof setInterval> | null = null;
let apiPool: pg.Pool | null = null;

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutting down homepage-api');

  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
  if (arbIntervalId) {
    clearInterval(arbIntervalId);
    arbIntervalId = null;
  }
  if (translationIntervalId) {
    clearInterval(translationIntervalId);
    translationIntervalId = null;
  }

  if (apiPool) {
    await apiPool.end();
    logger.info('API pool closed');
  }
  await closePool();
  logger.info('Shutdown complete');
  process.exit(0);
}

async function main(): Promise<void> {
  logger.info('Starting homepage-api service');

  const config = getConfig();

  logger.info({
    port: config.port,
    host: config.host,
    scoreIntervalMs: config.scoreIntervalMs,
    defaultPageSize: config.defaultPageSize,
  }, 'Configuration loaded');

  // Initialize REST orderbook refresher for arb scanner fallback
  initRefresher({
    kalshiApiKey: config.kalshiApiKey,
    kalshiPrivateKeyPath: config.kalshiPrivateKeyPath,
    kalshiRestUrl: config.kalshiRestUrl,
    polymarketClobUrl: config.polymarketClobUrl,
    predictRestUrl: config.predictRestUrl,
    predictApiKey: config.predictApiKey,
  });

  // Database health check
  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    throw new Error('Database health check failed');
  }
  logger.info('Database connection verified');

  // Create separate DB pool for API routes (isolated from background tasks)
  apiPool = createPool({ maxConnections: 5, label: 'api' });

  // Start HTTP server first so API is available immediately
  const server = await buildServer(apiPool);
  await server.listen({ port: config.port, host: config.host });
  logger.info({ port: config.port, host: config.host }, 'Server listening');

  // Run initial score computation in background (don't block server startup)
  computeScores()
    .then((count) => logger.info({ marketCount: count }, 'Initial score computation complete'))
    .catch((err) => logger.error({ err }, 'Initial score computation failed, continuing with empty scores'));

  // Schedule recurring score computation
  intervalId = setInterval(() => {
    computeScores().catch((err) => {
      logger.error({ err }, 'Unhandled error in score computation');
    });
  }, config.scoreIntervalMs);

  logger.info({ scoreIntervalMs: config.scoreIntervalMs }, 'Score computation scheduler started');

  // Schedule arb scanner
  arbIntervalId = setInterval(() => {
    scanForArbs().catch((err) => {
      logger.error({ err }, 'Unhandled error in arb scanner');
    });
  }, config.arbScanIntervalMs);

  logger.info({ arbScanIntervalMs: config.arbScanIntervalMs }, 'Arb scanner scheduler started');

  // Schedule translation service (every 60 seconds)
  translationIntervalId = setInterval(() => {
    translateNewContent().catch((err) => {
      logger.error({ err }, 'Unhandled error in translation service');
    });
  }, 60_000);

  logger.info('Translation service scheduler started (60s interval)');

  // Handle graceful shutdown
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting homepage-api');
  process.exit(1);
});
