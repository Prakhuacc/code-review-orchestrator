/**
 * Error handling utilities: typed errors, retry with exponential backoff + jitter,
 * and a Promise.race-based timeout wrapper.
 */

export enum ErrorCodes {
  INVALID_INPUT = 'INVALID_INPUT',
  CONFIGURATION_ERROR = 'CONFIGURATION_ERROR',
  MCP_CONNECTION_ERROR = 'MCP_CONNECTION_ERROR',
  AGENT_FAILURE = 'AGENT_FAILURE',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  RATE_LIMITED = 'RATE_LIMITED',
  TIMEOUT = 'TIMEOUT',
  RETRY_EXHAUSTED = 'RETRY_EXHAUSTED',
}

export class ReviewError extends Error {
  constructor(
    message: string,
    public readonly code: ErrorCodes,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ReviewError';
  }
}

export interface RetryOptions {
  /** Retries after the first attempt (total attempts = maxRetries + 1). Default 3. */
  maxRetries?: number;
  /** Base delay in ms; attempt n waits delayMs * 2^(n - 1). Default 1000. */
  delayMs?: number;
  /** Upper bound for the exponential part of the delay. Default 30 000. */
  maxDelayMs?: number;
  /** Maximum random jitter added to each delay. Default 100 (0-100 ms). */
  jitterMs?: number;
  /** Decide whether an error is worth retrying. Default: isRetryableError. */
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  /** Called before each retry wait (useful for logging). */
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Errors that will fail the same way on every attempt are not retried. */
const NON_RETRYABLE_CODES: ReadonlySet<ErrorCodes> = new Set([
  ErrorCodes.INVALID_INPUT,
  ErrorCodes.CONFIGURATION_ERROR,
  ErrorCodes.MCP_CONNECTION_ERROR,
  ErrorCodes.RETRY_EXHAUSTED,
]);

const NON_RETRYABLE_MESSAGE = /invalid api key|authentication|unauthorized|\b401\b|\b403\b|permission denied/i;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function isRetryableError(error: unknown): boolean {
  if (error instanceof ReviewError) {
    return !NON_RETRYABLE_CODES.has(error.code);
  }
  return !NON_RETRYABLE_MESSAGE.test(errorMessage(error));
}

/**
 * Delay before retry number `attempt` (1-based):
 * min(delayMs * 2^(attempt - 1), maxDelayMs) + random jitter in [0, jitterMs].
 * Jitter spreads simultaneous retries out so clients don't hit the API in lockstep
 * (the "thundering herd" problem).
 */
export function calculateBackoffDelay(
  attempt: number,
  delayMs = 1000,
  maxDelayMs = 30_000,
  jitterMs = 100,
  random: () => number = Math.random,
): number {
  const exponential = delayMs * 2 ** (attempt - 1);
  const jitter = Math.floor(random() * (jitterMs + 1));
  return Math.min(exponential, maxDelayMs) + jitter;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `fn`, retrying transient failures with exponential backoff and jitter.
 * Non-retryable errors are rethrown immediately; when all retries are used up a
 * ReviewError with code RETRY_EXHAUSTED is thrown (the last error is in `details`).
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const {
    maxRetries = 3,
    delayMs = 1000,
    maxDelayMs = 30_000,
    jitterMs = 100,
    shouldRetry = isRetryableError,
    onRetry,
  } = options;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      if (attempt > maxRetries) {
        throw new ReviewError(
          `Operation failed after ${attempt} attempt(s): ${errorMessage(error)}`,
          ErrorCodes.RETRY_EXHAUSTED,
          error,
        );
      }
      const wait = calculateBackoffDelay(attempt, delayMs, maxDelayMs, jitterMs);
      onRetry?.(error, attempt, wait);
      await sleep(wait);
    }
  }
}

/**
 * Races `fn()` against a timer. If the timer wins, the returned promise rejects with a
 * ReviewError(TIMEOUT). The timer is always cleared so it never keeps the process alive.
 * Note: Promise.race cannot cancel `fn`; callers that own cancellable work (such as an
 * Agent SDK query with an AbortController) should abort it when a timeout is thrown.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  operationName = 'Operation',
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new ReviewError(`${operationName} timed out after ${timeoutMs} ms`, ErrorCodes.TIMEOUT, {
          timeoutMs,
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([fn(), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
