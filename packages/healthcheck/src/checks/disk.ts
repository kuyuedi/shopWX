import { exec } from 'child_process';
import { promisify } from 'util';
import { createLogger } from '@prediction-market/shared';
import type { CheckResult, Config } from '../types.js';

const execAsync = promisify(exec);
const logger = createLogger('disk-check');

export async function checkDisk(config: Config): Promise<CheckResult> {
  try {
    // Get disk usage for root filesystem
    const { stdout } = await execAsync("df -h / | tail -1 | awk '{print $5}'");
    const usageStr = stdout.trim().replace('%', '');
    const usage = parseInt(usageStr, 10);

    if (isNaN(usage)) {
      return {
        name: 'disk',
        healthy: false,
        level: 'warning',
        message: `Could not parse disk usage: ${stdout}`,
      };
    }

    logger.debug({ usage }, 'Disk usage checked');

    if (usage >= config.diskCriticalThreshold) {
      return {
        name: 'disk',
        healthy: false,
        level: 'critical',
        message: `Disk usage at ${usage}% (critical threshold: ${config.diskCriticalThreshold}%)`,
        details: {
          Usage: `${usage}%`,
          Action: 'Immediate cleanup or expansion required',
        },
      };
    }

    if (usage >= config.diskWarningThreshold) {
      return {
        name: 'disk',
        healthy: false,
        level: 'warning',
        message: `Disk usage at ${usage}% (warning threshold: ${config.diskWarningThreshold}%)`,
        details: {
          Usage: `${usage}%`,
          Action: 'Consider cleanup or expansion',
        },
      };
    }

    return {
      name: 'disk',
      healthy: true,
      message: `Disk usage at ${usage}%`,
    };
  } catch (err) {
    logger.error({ err }, 'Failed to check disk usage');
    return {
      name: 'disk',
      healthy: false,
      level: 'warning',
      message: `Failed to check disk: ${err instanceof Error ? err.message : 'Unknown error'}`,
    };
  }
}
