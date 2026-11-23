import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  calculateBackoffDelay,
  ErrorCodes,
  isRetryableError,
  ReviewError,
  withRetry,
  withTimeout,
} from '../src/utils/error-handler.js';
import { RATE_LIMIT_WINDOW_MS, RateLimiter } from '../src/utils/rate-limiter.js';

describe('calculateBackoffDelay', () => {
  it('doubles the delay on every attempt (exponential backoff)', () => {
    const noJitter = () => 0;
    expect(calculateBackoffDelay(1, 1000, 30_000, 100, noJitter)).toBe(1000);
    expect(calculateBackoffDelay(2, 1000, 30_000, 100, noJitter)).toBe(2000);
    expect(calculateBackoffDelay(3, 1000, 30_000, 100, noJitter)).toBe(4000);
    expect(calculateBackoffDelay(4, 1000, 30_000, 100, noJitter)).toBe(8000);
  });

  it('adds 0-100 ms of jitter', () => {
    expect(calculateBackoffDelay(1, 1000, 30_000, 100, () => 0)).toBe(1000);
    expect(calculateBackoffDelay(1, 1000, 30_000, 100, () => 0.999)).toBe(1100);
    for (let i = 0; i < 50; i++) {
      const delay = calculateBackoffDelay(2, 1000);
      expect(delay).toBeGreaterThanOrEqual(2000);
      expect(delay).toBeLessThanOrEqual(2100);
    }
  });

  it('caps the exponential part at maxDelayMs', () => {
    expect(calculateBackoffDelay(20, 1000, 30_000, 100, () => 0)).toBe(30_000);
  });
});

describe('withRetry', () => {
  it('returns the result immediately when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    await expect(withRetry(fn, { delayMs: 1, jitterMs: 0 })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures and then succeeds', async () => {
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockRejectedValueOnce(new Error('503 overloaded'))
      .mockResolvedValue('recovered');
    const onRetry = vi.fn();

    await expect(withRetry(fn, { maxRetries: 3, delayMs: 1, jitterMs: 0, onRetry })).resolves.toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls.map((call) => call[2])).toEqual([1, 2]); // 1ms, then 2ms
  });

  it('throws RETRY_EXHAUSTED after maxRetries + 1 attempts', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('still failing'));
    const error = await withRetry(fn, { maxRetries: 2, delayMs: 1, jitterMs: 0 }).catch((e: unknown) => e);

    expect(fn).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ReviewError);
    expect((error as ReviewError).code).toBe(ErrorCodes.RETRY_EXHAUSTED);
    expect((error as ReviewError).message).toContain('still failing');
  });

  it('does not retry non-retryable errors', async () => {
    const configError = new ReviewError('missing model', ErrorCodes.CONFIGURATION_ERROR);
    const fn = vi.fn().mockRejectedValue(configError);

    await expect(withRetry(fn, { maxRetries: 5, delayMs: 1 })).rejects.toBe(configError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('waits with growing delays between attempts', async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('a')).mockRejectedValueOnce(new Error('b')).mockResolvedValue('done');
      const promise = withRetry(fn, { maxRetries: 3, delayMs: 1000, jitterMs: 0 });

      await vi.advanceTimersByTimeAsync(0);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(2000);
      expect(fn).toHaveBeenCalledTimes(3);
      await expect(promise).resolves.toBe('done');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('isRetryableError', () => {
  it('classifies errors', () => {
    expect(isRetryableError(new Error('socket hang up'))).toBe(true);
    expect(isRetryableError(new ReviewError('t', ErrorCodes.TIMEOUT))).toBe(true);
    expect(isRetryableError(new ReviewError('v', ErrorCodes.VALIDATION_ERROR))).toBe(true);
    expect(isRetryableError(new ReviewError('c', ErrorCodes.CONFIGURATION_ERROR))).toBe(false);
    expect(isRetryableError(new ReviewError('m', ErrorCodes.MCP_CONNECTION_ERROR))).toBe(false);
    expect(isRetryableError(new Error('401 Invalid API key'))).toBe(false);
  });
});

describe('withTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves when the operation finishes in time', async () => {
    const promise = withTimeout(() => new Promise((resolve) => setTimeout(() => resolve('fast'), 100)), 1000);
    await vi.advanceTimersByTimeAsync(100);
    await expect(promise).resolves.toBe('fast');
  });

  it('rejects with a TIMEOUT ReviewError when the operation is too slow', async () => {
    const promise = withTimeout(
      () => new Promise((resolve) => setTimeout(() => resolve('late'), 5000)),
      1000,
      'Slow operation',
    );
    const assertion = expect(promise).rejects.toMatchObject({
      code: ErrorCodes.TIMEOUT,
      message: expect.stringContaining('Slow operation timed out after 1000 ms'),
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('passes through errors thrown by the operation', async () => {
    const boom = new Error('boom');
    await expect(withTimeout(() => Promise.reject(boom), 1000)).rejects.toBe(boom);
  });

  it('clears its timer once the race is decided', async () => {
    await withTimeout(() => Promise.resolve('done'), 10_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('RateLimiter', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('allows requests while under every limit', () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 2, maxTokensPerMinute: 1000, maxConcurrent: 2 });
    expect(limiter.canProceed(100)).toBe(true);
  });

  it('blocks when requests per minute are used up and frees them after 60 s (sliding window)', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 2, maxTokensPerMinute: 100_000, maxConcurrent: 5 });
    await limiter.acquire(10);
    limiter.release();
    vi.advanceTimersByTime(30_000);
    await limiter.acquire(10);
    limiter.release();

    expect(limiter.canProceed(10)).toBe(false);

    vi.advanceTimersByTime(RATE_LIMIT_WINDOW_MS - 30_000 + 1); // first record leaves the window
    expect(limiter.canProceed(10)).toBe(true);
    expect(limiter.getStatus().requestsInWindow).toBe(1);
  });

  it('tracks tokens separately from request count', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 100, maxTokensPerMinute: 1000, maxConcurrent: 5 });
    await limiter.acquire(600);
    limiter.release();

    expect(limiter.canProceed(500)).toBe(false);
    expect(limiter.canProceed(400)).toBe(true);
    expect(limiter.getStatus().tokensInWindow).toBe(600);
  });

  it('pruneOldRecords removes only records older than the window', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 10, maxTokensPerMinute: 10_000, maxConcurrent: 5 });
    await limiter.acquire(1);
    limiter.release();
    vi.advanceTimersByTime(40_000);
    await limiter.acquire(2);
    limiter.release();
    vi.advanceTimersByTime(20_001);

    limiter.pruneOldRecords();
    expect(limiter.getStatus()).toMatchObject({ requestsInWindow: 1, tokensInWindow: 2 });
  });

  it('respects maxConcurrent: the next caller waits until release()', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 100, maxTokensPerMinute: 100_000, maxConcurrent: 1 });
    await limiter.acquire(1);

    let secondStarted = false;
    const second = limiter.acquire(1).then(() => {
      secondStarted = true;
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(secondStarted).toBe(false);
    expect(limiter.getStatus().queuedRequests).toBe(1);

    limiter.release();
    await vi.advanceTimersByTimeAsync(0);
    await second;
    expect(secondStarted).toBe(true);
    expect(limiter.getStatus().activeRequests).toBe(1);
  });

  it('waitForRateLimit sleeps until the oldest request expires', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 1, maxTokensPerMinute: 100_000, maxConcurrent: 5 });
    await limiter.acquire(1);
    limiter.release();

    let done = false;
    const waiting = limiter.acquire(1).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1_100);
    await waiting;
    expect(done).toBe(true);
  });

  it('lets a request bigger than the whole token budget run once the window is empty', async () => {
    const limiter = new RateLimiter({ maxRequestsPerMinute: 10, maxTokensPerMinute: 1000, maxConcurrent: 1 });
    await expect(limiter.acquire(5000)).resolves.toBeUndefined();
  });

  it('rejects invalid configuration', () => {
    expect(() => new RateLimiter({ maxConcurrent: 0 })).toThrow();
    expect(() => new RateLimiter({ maxRequestsPerMinute: -1 })).toThrow();
  });
});
