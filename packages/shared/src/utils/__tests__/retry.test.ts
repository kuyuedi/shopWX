import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, ExponentialBackoff } from '../retry.js';

// Mock logger to suppress output during tests
vi.mock('../logger.js', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on 3rd attempt', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockRejectedValueOnce(new Error('fail-2'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxAttempts: 5, initialDelayMs: 100 });

    // Advance through the retry delays
    await vi.advanceTimersByTimeAsync(100); // after attempt 1
    await vi.advanceTimersByTimeAsync(200); // after attempt 2

    const result = await promise;
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('throws after maxAttempts exhausted', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockImplementation(async () => { throw new Error('always-fail'); });

    await expect(
      withRetry(fn, { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 1 })
    ).rejects.toThrow('always-fail');
    expect(fn).toHaveBeenCalledTimes(3);
    vi.useFakeTimers();
  });

  it('calls onRetry callback with attempt and error', async () => {
    const onRetry = vi.fn();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('fail-1'))
      .mockResolvedValue('ok');

    const promise = withRetry(fn, { maxAttempts: 3, initialDelayMs: 100, onRetry });
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('respects custom maxAttempts', async () => {
    vi.useRealTimers();
    const fn = vi.fn().mockImplementation(async () => { throw new Error('fail'); });

    await expect(
      withRetry(fn, { maxAttempts: 2, initialDelayMs: 1, maxDelayMs: 1 })
    ).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(2);
    vi.useFakeTimers();
  });
});

describe('ExponentialBackoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0); // zero jitter for deterministic tests
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('increases delay with multiplier', async () => {
    const backoff = new ExponentialBackoff(100, 10000, 2);

    const wait1 = backoff.wait();
    await vi.advanceTimersByTimeAsync(100); // 100 + 0 jitter
    await wait1;
    expect(backoff.getAttempt()).toBe(1);

    const wait2 = backoff.wait();
    await vi.advanceTimersByTimeAsync(200); // 200 + 0 jitter
    await wait2;
    expect(backoff.getAttempt()).toBe(2);

    const wait3 = backoff.wait();
    await vi.advanceTimersByTimeAsync(400); // 400 + 0 jitter
    await wait3;
    expect(backoff.getAttempt()).toBe(3);
  });

  it('caps delay at maxDelayMs', async () => {
    const backoff = new ExponentialBackoff(100, 300, 2);

    // attempt 1: delay=100
    const wait1 = backoff.wait();
    await vi.advanceTimersByTimeAsync(100);
    await wait1;

    // attempt 2: delay=200
    const wait2 = backoff.wait();
    await vi.advanceTimersByTimeAsync(200);
    await wait2;

    // attempt 3: delay=min(400, 300)=300
    const wait3 = backoff.wait();
    await vi.advanceTimersByTimeAsync(300);
    await wait3;
    expect(backoff.getAttempt()).toBe(3);
  });

  it('reset() restores initial state', async () => {
    const backoff = new ExponentialBackoff(100, 10000, 2);

    const wait1 = backoff.wait();
    await vi.advanceTimersByTimeAsync(100);
    await wait1;
    expect(backoff.getAttempt()).toBe(1);

    backoff.reset();
    expect(backoff.getAttempt()).toBe(0);

    // After reset, delay should be back to initial
    const wait2 = backoff.wait();
    await vi.advanceTimersByTimeAsync(100);
    await wait2;
    expect(backoff.getAttempt()).toBe(1);
  });

  it('getAttempt() starts at 0', () => {
    const backoff = new ExponentialBackoff();
    expect(backoff.getAttempt()).toBe(0);
  });
});
