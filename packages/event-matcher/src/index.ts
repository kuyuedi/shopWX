import 'dotenv/config';
import { createLogger, healthCheck, closePool } from '@prediction-market/shared';
import { getConfig } from './config.js';
import { runMatchingCycle } from './services/matchingCycle.js';

const logger = createLogger('event-matcher');

async function main(): Promise<void> {
  logger.info('Starting event-matcher service');

  const config = getConfig();

  if (!config.apiKey) {
    logger.error('OPENAI_API_KEY environment variable is required');
    process.exit(1);
  }

  logger.info({
    model: config.model,
    intervalMs: config.intervalMs,
    confidenceThreshold: config.confidenceThreshold,
    candidatesPerBatch: config.candidatesPerBatch,
    matchVersion: config.matchVersion,
    minEventVolume: config.minEventVolume,
  }, 'Configuration loaded');

  // Wait for database
  const dbHealthy = await healthCheck();
  if (!dbHealthy) {
    logger.error('Database health check failed, exiting');
    process.exit(1);
  }

  logger.info('Database connected');

  // Run initial cycle
  await runMatchingCycle(config);

  // Schedule recurring cycles
  const interval = setInterval(() => {
    runMatchingCycle(config).catch((err) => {
      logger.error({ err }, 'Unhandled error in matching cycle');
    });
  }, config.intervalMs);

  logger.info({ intervalMs: config.intervalMs }, 'Matching scheduler started');

  // Graceful shutdown
  const shutdown = async () => {
    logger.info('Shutting down...');
    clearInterval(interval);
    await closePool();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting event-matcher');
  process.exit(1);
});
