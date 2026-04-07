import { createLogger } from '@prediction-market/shared';
import type { CheckResult, Config } from '../types.js';
import { checkDisk } from './disk.js';
import { checkContainers } from './containers.js';
import { checkDatabaseConnection, checkDataFlow } from './database.js';

const logger = createLogger('checks');

export async function runAllChecks(config: Config): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  logger.info('Running health checks');

  // Run checks in parallel where possible
  const [diskResult, containerResults, dbConnectionResult] = await Promise.all([
    checkDisk(config),
    checkContainers(),
    checkDatabaseConnection(),
  ]);

  results.push(diskResult);
  results.push(...containerResults);
  results.push(dbConnectionResult);

  // Only check data flow if database is reachable
  if (dbConnectionResult.healthy) {
    const dataFlowResults = await checkDataFlow(config);
    results.push(...dataFlowResults);
  }

  const healthyCount = results.filter((r) => r.healthy).length;
  const unhealthyCount = results.filter((r) => !r.healthy).length;

  logger.info({ healthy: healthyCount, unhealthy: unhealthyCount }, 'Health checks completed');

  return results;
}

export { checkDisk } from './disk.js';
export { checkContainers } from './containers.js';
export { checkDatabaseConnection, checkDataFlow } from './database.js';
