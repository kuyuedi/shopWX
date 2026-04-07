import { pino, Logger } from 'pino';

const level = process.env.LOG_LEVEL || 'info';

const baseLogger = pino({
  level,
  formatters: {
    level: (label: string) => ({ level: label }),
  },
});

export function createLogger(name: string): Logger {
  return baseLogger.child({ service: name });
}

export { baseLogger as logger };
export type { Logger };
