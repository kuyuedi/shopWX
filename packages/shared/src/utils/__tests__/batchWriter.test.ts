import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BatchWriter } from '../batchWriter.js';

// Mock logger to suppress output during tests
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('BatchWriter', () => {
  let writeFn: ReturnType<typeof vi.fn>;
  let onError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    writeFn = vi.fn().mockResolvedValue(undefined);
    onError = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls writeFn when buffer reaches maxSize', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 3,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    await writer.add(2);
    expect(writeFn).not.toHaveBeenCalled();

    await writer.add(3);
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith([1, 2, 3]);
  });

  it('does not call writeFn before maxSize', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 5,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    await writer.add(2);
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('auto-flushes on timer after maxWaitMs', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 100,
      maxWaitMs: 500,
      writeFn,
      onError,
    });

    await writer.add(1);
    expect(writeFn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(500);
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith([1]);
  });

  it('rejects add() after shutdown()', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 100,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.shutdown();
    await expect(writer.add(1)).rejects.toThrow('shutting down');
  });

  it('flush() is no-op when buffer is empty', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 100,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.flush();
    expect(writeFn).not.toHaveBeenCalled();
  });

  it('retries on deadlock error (code 40P01)', async () => {
    const deadlockError = Object.assign(new Error('deadlock detected'), { code: '40P01' });
    writeFn
      .mockRejectedValueOnce(deadlockError)
      .mockResolvedValue(undefined);

    const writer = new BatchWriter<number>({
      maxSize: 2,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    const addPromise = writer.add(2);

    // Advance past retry delay (1s for first retry)
    await vi.advanceTimersByTimeAsync(1000);
    await addPromise;

    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries on timeout error', async () => {
    const timeoutError = new Error('query timeout exceeded');
    writeFn
      .mockRejectedValueOnce(timeoutError)
      .mockResolvedValue(undefined);

    const writer = new BatchWriter<number>({
      maxSize: 2,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    const addPromise = writer.add(2);

    await vi.advanceTimersByTimeAsync(1000);
    await addPromise;

    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('retries on connection error', async () => {
    const connError = new Error('connection refused');
    writeFn
      .mockRejectedValueOnce(connError)
      .mockResolvedValue(undefined);

    const writer = new BatchWriter<number>({
      maxSize: 2,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    const addPromise = writer.add(2);

    await vi.advanceTimersByTimeAsync(1000);
    await addPromise;

    expect(writeFn).toHaveBeenCalledTimes(2);
    expect(onError).not.toHaveBeenCalled();
  });

  it('calls onError on non-retryable failure', async () => {
    const uniqueError = new Error('unique violation');
    writeFn.mockRejectedValue(uniqueError);

    const writer = new BatchWriter<number>({
      maxSize: 2,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    await writer.add(2);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.any(Error), [1, 2]);
  });

  it('shutdown() flushes remaining items', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 100,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    await writer.add(1);
    await writer.add(2);
    expect(writeFn).not.toHaveBeenCalled();

    await writer.shutdown();
    expect(writeFn).toHaveBeenCalledTimes(1);
    expect(writeFn).toHaveBeenCalledWith([1, 2]);
  });

  it('getPendingCount() reflects buffer size', async () => {
    const writer = new BatchWriter<number>({
      maxSize: 100,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    expect(writer.getPendingCount()).toBe(0);
    await writer.add(1);
    expect(writer.getPendingCount()).toBe(1);
    await writer.add(2);
    expect(writer.getPendingCount()).toBe(2);
    await writer.flush();
    expect(writer.getPendingCount()).toBe(0);
  });

  it('exponential backoff delays: 1s, 2s, 4s, 8s, 10s cap', async () => {
    // This tests that multiple retries use increasing delays
    const retriableError = new Error('connection lost');
    writeFn
      .mockRejectedValueOnce(retriableError) // attempt 1: wait 1s
      .mockRejectedValueOnce(retriableError) // attempt 2: wait 2s
      .mockRejectedValueOnce(retriableError) // attempt 3: wait 4s
      .mockRejectedValueOnce(retriableError) // attempt 4: wait 8s
      .mockResolvedValue(undefined);           // attempt 5: success

    const writer = new BatchWriter<number>({
      maxSize: 1,
      maxWaitMs: 10000,
      writeFn,
      onError,
    });

    const addPromise = writer.add(1);

    // Advance through each retry delay
    await vi.advanceTimersByTimeAsync(1000);  // 1s
    await vi.advanceTimersByTimeAsync(2000);  // 2s
    await vi.advanceTimersByTimeAsync(4000);  // 4s
    await vi.advanceTimersByTimeAsync(8000);  // 8s

    await addPromise;

    expect(writeFn).toHaveBeenCalledTimes(5);
    expect(onError).not.toHaveBeenCalled();
  });
});
