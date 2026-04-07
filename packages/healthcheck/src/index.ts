import 'dotenv/config';
import { createLogger } from '@prediction-market/shared';
import { getConfig } from './config.js';
import { runAllChecks } from './checks/index.js';
import { sendAlert, sendRecoveryAlert } from './alerting/telegram.js';
import { shouldSendAlert, updateAlertState } from './state.js';
import type { CheckResult, Config } from './types.js';

const logger = createLogger('healthcheck');

async function processCheckResult(result: CheckResult, config: Config): Promise<void> {
  const { shouldSend, isRecovery } = shouldSendAlert(
    result.name,
    result.healthy,
    config.alertCooldownMs
  );

  if (!shouldSend) {
    return;
  }

  if (isRecovery) {
    await sendRecoveryAlert(result.name, config);
  } else if (!result.healthy && result.level) {
    await sendAlert(
      {
        level: result.level,
        title: result.name,
        message: result.message,
        details: result.details,
      },
      config
    );
  }

  updateAlertState(result.name, result.healthy);
}

async function runHealthCheckCycle(config: Config): Promise<void> {
  try {
    const results = await runAllChecks(config);

    for (const result of results) {
      await processCheckResult(result, config);
    }
  } catch (err) {
    logger.error({ err }, 'Error during health check cycle');

    // Send alert about healthcheck failure itself
    await sendAlert(
      {
        level: 'critical',
        title: 'Healthcheck system error',
        message: `Health check cycle failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
      },
      config
    );
  }
}

async function main(): Promise<void> {
  logger.info('Starting healthcheck service');

  const config = getConfig();

  logger.info(
    {
      intervalMs: config.intervalMs,
      diskWarningThreshold: config.diskWarningThreshold,
      diskCriticalThreshold: config.diskCriticalThreshold,
      dataFlowMinRecords: config.dataFlowMinRecords,
      serverIp: config.serverIp,
    },
    'Configuration loaded'
  );

  // Run initial check immediately
  await runHealthCheckCycle(config);

  // Schedule recurring checks
  setInterval(() => {
    runHealthCheckCycle(config).catch((err) => {
      logger.error({ err }, 'Unhandled error in health check cycle');
    });
  }, config.intervalMs);

  logger.info({ intervalMs: config.intervalMs }, 'Healthcheck scheduler started');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    logger.info('Received SIGINT, shutting down');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    logger.info('Received SIGTERM, shutting down');
    process.exit(0);
  });
}

main().catch((err) => {
  logger.error({ err }, 'Fatal error starting healthcheck service');
  process.exit(1);
});
