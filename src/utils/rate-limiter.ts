/**
 * Token-bucket style rate limiter with a 60-second sliding window.
 *
 * Three limits are enforced together:
 *  - maxRequestsPerMinute: requests started in the last 60 s
 *  - maxTokensPerMinute:   estimated tokens used by those requests
 *  - maxConcurrent:        requests in flight at the same time
 *
 * Requests and tokens are tracked separately because the API limits both: a few huge
 * prompts can exhaust the token budget long before the request count is reached.
 *
 * Usage:
 *   await limiter.acquire(estimatedTokens);
 *   try { await doWork(); } finally { limiter.release(); }
 */

export interface RateLimiterConfig {
  maxRequestsPerMinute: number;
  maxTokensPerMinute: number;
  maxConcurrent: number;
}

export interface RequestRecord {
  timestamp: number;
  tokens: number;
}

export interface RateLimiterStatus {
  activeRequests: number;
  queuedRequests: number;
  requestsInWindow: number;
  tokensInWindow: number;
  config: RateLimiterConfig;
}

export const RATE_LIMIT_WINDOW_MS = 60_000;

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  maxRequestsPerMinute: 50,
  maxTokensPerMinute: 400_000,
  maxConcurrent: 3,
};

/** Small extra wait so we wake just after the oldest record has left the window. */
const WAKE_BUFFER_MS = 10;
const MIN_POLL_MS = 50;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RateLimiter {
  private readonly config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  /** Requests that acquired and have not been released yet. */
  private activeRequests = 0;
  /** Requests holding a concurrency slot while they wait for the rate window. */
  private reservedSlots = 0;
  /** Resolvers of callers waiting for a concurrency slot (FIFO). */
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
    for (const [key, value] of Object.entries(this.config)) {
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`RateLimiter: ${key} must be a positive number (got ${value})`);
      }
    }
  }

  /** Main entry point: resolves once the request may start. Always pair with release(). */
  async acquire(estimatedTokens = 1000): Promise<void> {
    await this.waitForSlot();
    try {
      await this.waitForRateLimit(estimatedTokens);
    } catch (error) {
      this.reservedSlots--;
      this.dispatchNextWaiter();
      throw error;
    }
    this.reservedSlots--;
    this.activeRequests++;
    this.requestHistory.push({ timestamp: Date.now(), tokens: estimatedTokens });
  }

  /** Frees a concurrency slot and wakes the next queued caller. */
  release(): void {
    if (this.activeRequests === 0) return;
    this.activeRequests--;
    this.dispatchNextWaiter();
  }

  /** True when a request with `estimatedTokens` could start right now. */
  canProceed(estimatedTokens = 0): boolean {
    this.pruneOldRecords();

    const underConcurrency = this.activeRequests < this.config.maxConcurrent;
    const underRequestLimit = this.requestHistory.length < this.config.maxRequestsPerMinute;
    const tokensInWindow = this.getTokensInWindow();
    // A single request larger than the whole budget may run once the window is empty;
    // otherwise it could never run and would wait forever.
    const underTokenLimit =
      tokensInWindow + estimatedTokens <= this.config.maxTokensPerMinute ||
      this.requestHistory.length === 0;

    return underConcurrency && underRequestLimit && underTokenLimit;
  }

  /** Waits for a free concurrency slot. The slot is reserved for the caller. */
  async waitForSlot(): Promise<void> {
    const slotsInUse = this.activeRequests + this.reservedSlots;
    if (this.waitQueue.length === 0 && slotsInUse < this.config.maxConcurrent) {
      this.reservedSlots++;
      return;
    }
    // release() -> dispatchNextWaiter() reserves the slot and then calls this resolver.
    await new Promise<void>((resolve) => this.waitQueue.push(resolve));
  }

  /** Sleeps until the sliding window has room for the request. */
  async waitForRateLimit(estimatedTokens = 0): Promise<void> {
    while (!this.canProceed(estimatedTokens)) {
      await pause(this.getWaitTimeMs());
    }
  }

  /** Drops records older than 60 s: this is what makes the window "slide". */
  pruneOldRecords(): void {
    const cutoff = Date.now() - RATE_LIMIT_WINDOW_MS;
    this.requestHistory = this.requestHistory.filter((record) => record.timestamp > cutoff);
  }

  getStatus(): RateLimiterStatus {
    this.pruneOldRecords();
    return {
      activeRequests: this.activeRequests,
      queuedRequests: this.waitQueue.length,
      requestsInWindow: this.requestHistory.length,
      tokensInWindow: this.getTokensInWindow(),
      config: { ...this.config },
    };
  }

  /** Clears the window and active count, then hands free slots to queued callers. */
  reset(): void {
    this.requestHistory = [];
    this.activeRequests = 0;
    while (
      this.waitQueue.length > 0 &&
      this.activeRequests + this.reservedSlots < this.config.maxConcurrent
    ) {
      this.dispatchNextWaiter();
    }
  }

  private getTokensInWindow(): number {
    return this.requestHistory.reduce((sum, record) => sum + record.tokens, 0);
  }

  /** Time until the oldest record expires, which is the earliest moment capacity frees up. */
  private getWaitTimeMs(): number {
    const oldest = this.requestHistory[0];
    if (!oldest) return MIN_POLL_MS;
    const untilExpiry = oldest.timestamp + RATE_LIMIT_WINDOW_MS - Date.now() + WAKE_BUFFER_MS;
    return Math.max(untilExpiry, MIN_POLL_MS);
  }

  private dispatchNextWaiter(): void {
    const slotsInUse = this.activeRequests + this.reservedSlots;
    if (this.waitQueue.length === 0 || slotsInUse >= this.config.maxConcurrent) return;
    const next = this.waitQueue.shift();
    if (next) {
      this.reservedSlots++;
      next();
    }
  }
}
