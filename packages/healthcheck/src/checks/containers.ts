import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@prediction-market/shared';
import type { CheckResult } from '../types.js';

const execAsync = promisify(exec);
const logger = createLogger('container-check');

const REQUIRED_CONTAINERS = ['kalshi-listener', 'polymarket-listener', 'predict-listener'];

interface ContainerInfo {
  Names: string;
  State: string;
  Status: string;
}

export async function checkContainers(): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  try {
    // Get container status in JSON format
    const { stdout } = await execAsync('docker ps -a --format "{{json .}}"');
    const lines = stdout.trim().split('\n').filter(Boolean);

    const containers: ContainerInfo[] = lines.map((line) => JSON.parse(line) as ContainerInfo);
    const containerMap = new Map<string, ContainerInfo>();

    for (const container of containers) {
      containerMap.set(container.Names, container);
    }

    for (const name of REQUIRED_CONTAINERS) {
      const container = containerMap.get(name);

      if (!container) {
        results.push({
          name: `container:${name}`,
          healthy: false,
          level: 'critical',
          message: `Container ${name} not found`,
          details: {
            Container: name,
            Status: 'Not found',
          },
        });
        continue;
      }

      if (container.State !== 'running') {
        results.push({
          name: `container:${name}`,
          healthy: false,
          level: 'critical',
          message: `Container ${name} is ${container.State}`,
          details: {
            Container: name,
            State: container.State,
            Status: container.Status,
          },
        });
        continue;
      }

      logger.debug({ name, status: container.Status }, 'Container running');
      results.push({
        name: `container:${name}`,
        healthy: true,
        message: `Container ${name} is running`,
      });
    }

    return results;
  } catch (err) {
    logger.error({ err }, 'Failed to check containers');

    // Return critical for all containers if docker command fails
    return REQUIRED_CONTAINERS.map((name) => ({
      name: `container:${name}`,
      healthy: false,
      level: 'critical' as const,
      message: `Failed to check container: ${err instanceof Error ? err.message : 'Unknown error'}`,
    }));
  }
}
