import { createLogger } from './logger.js';

const logger = createLogger('retry');

export interface RetryOptions {
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  backoffMultiplier?: number;
  onRetry?: (attempt: number, error: Error) => void;
}

const DEFAULT_OPTIONS: Required<Omit<RetryOptions, 'onRetry'>> = {
  maxAttempts: 5,
  initialDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const {
    maxAttempts,
    initialDelayMs,
    maxDelayMs,
    backoffMultiplier,
  } = { ...DEFAULT_OPTIONS, ...options };

  let lastError: Error | undefined;
  let delay = initialDelayMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (attempt === maxAttempts) {
        logger.error({ attempt, maxAttempts, err: lastError }, 'All retry attempts exhausted');
        throw lastError;
      }

      logger.warn(
        { attempt, maxAttempts, delay, err: lastError.message },
        'Operation failed, retrying'
      );

      options.onRetry?.(attempt, lastError);

      await sleep(delay);
      delay = Math.min(delay * backoffMultiplier, maxDelayMs);
    }
  }

  throw lastError;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class ExponentialBackoff {
  private delay: number;
  private attempt = 0;

  constructor(
    private readonly initialDelayMs: number = 1000,
    private readonly maxDelayMs: number = 30000,
    private readonly multiplier: number = 2
  ) {
    this.delay = initialDelayMs;
  }

  async wait(): Promise<void> {
    this.attempt++;
    const jitter = Math.random() * 0.3 * this.delay;
    const waitTime = Math.min(this.delay + jitter, this.maxDelayMs);

    logger.debug({ attempt: this.attempt, waitTime }, 'Backing off');
    await sleep(waitTime);

    this.delay = Math.min(this.delay * this.multiplier, this.maxDelayMs);
  }

  reset(): void {
    this.delay = this.initialDelayMs;
    this.attempt = 0;
  }

  getAttempt(): number {
    return this.attempt;
  }
}
