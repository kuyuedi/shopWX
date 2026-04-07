import { createLogger } from './logger.js';

const logger = createLogger('batch-writer');

export interface BatchWriterOptions<T> {
  maxSize: number;
  maxWaitMs: number;
  writeFn: (items: T[]) => Promise<void>;
  onError?: (error: Error, items: T[]) => void;
}

export class BatchWriter<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private flushing: Promise<void> | null = null;

  constructor(private readonly options: BatchWriterOptions<T>) {}

  async add(item: T): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('BatchWriter is shutting down');
    }

    this.buffer.push(item);

    if (this.buffer.length >= this.options.maxSize) {
      await this.flush();
    } else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.flush().catch((err) => {
          logger.error({ err }, 'Failed to flush batch on timer');
        });
      }, this.options.maxWaitMs);
    }
  }

  async addMany(items: T[]): Promise<void> {
    for (const item of items) {
      await this.add(item);
    }
  }

  async flush(): Promise<void> {
    // If a flush is already in progress, skip to avoid concurrent DB writes that cause deadlocks.
    // The drain loop below handles items that accumulate during a flush.
    if (this.flushing) {
      return;
    }

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    // Drain loop: keep flushing while buffer has items.
    // Items accumulated during a flush are picked up by the next iteration.
    while (this.buffer.length > 0) {
      const items = this.buffer;
      this.buffer = [];

      this.flushing = this.doFlushChunked(items);
      try {
        await this.flushing;
      } finally {
        this.flushing = null;
      }
    }
  }

  private async doFlushChunked(items: T[]): Promise<void> {
    for (let i = 0; i < items.length; i += this.options.maxSize) {
      const chunk = items.slice(i, i + this.options.maxSize);
      await this.doFlush(chunk);
    }
  }

  private async doFlush(items: T[]): Promise<void> {
    // Retry logic for deadlocks and transient errors
    const maxRetries = 5;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this.options.writeFn(items);
        logger.debug({ count: items.length }, 'Flushed batch');
        return;
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        lastError = error;

        // Check if it's a retryable error
        const isDeadlock = 'code' in error && (error as { code: string }).code === '40P01';
        const isTimeout = error.message.includes('timeout');
        const isConnection = error.message.includes('connection');
        const isRetryable = isDeadlock || isTimeout || isConnection;

        if (isRetryable && attempt < maxRetries) {
          // Wait with exponential backoff before retrying
          const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 10000);
          logger.warn({ attempt, maxRetries, delayMs, count: items.length, error: error.message }, 'Retryable error, waiting before retry');
          await new Promise((resolve) => setTimeout(resolve, delayMs));
          continue;
        }

        logger.error({ err: error, count: items.length }, 'Failed to write batch');

        if (this.options.onError) {
          this.options.onError(error, items);
          return;
        } else {
          throw error;
        }
      }
    }

    // Should not reach here, but handle just in case
    if (lastError) {
      throw lastError;
    }
  }

  async shutdown(): Promise<void> {
    this.isShuttingDown = true;
    await this.flush();
  }

  getPendingCount(): number {
    return this.buffer.length;
  }
}
