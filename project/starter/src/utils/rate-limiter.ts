/**
 * Rate Limiter for API requests and token usage
 * Prevents exceeding Anthropic API rate limits
 *
 * This implements a token bucket algorithm with sliding window.
 *
 * Concepts:
 * - Tracks requests and tokens used in the last 60 seconds
 * - Limits concurrent requests
 * - Uses token estimation to prevent exceeding token-per-minute limits
 */

export interface RateLimiterConfig {
  /** Maximum requests per minute */
  maxRequestsPerMinute: number;

  /** Maximum tokens per minute */
  maxTokensPerMinute: number;

  /** Maximum concurrent requests */
  maxConcurrent: number;
}

export const DEFAULT_RATE_LIMITS: RateLimiterConfig = {
  maxRequestsPerMinute: 50,
  maxTokensPerMinute: 100000,
  maxConcurrent: 5,
};

interface RequestRecord {
  timestamp: number;
  tokens: number;
}

/**
 * Token bucket rate limiter with sliding window
 */
export class RateLimiter {
  private config: RateLimiterConfig;
  private requestHistory: RequestRecord[] = [];
  private activeRequests: number = 0;
  private waitQueue: Array<() => void> = [];

  constructor(config: Partial<RateLimiterConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMITS, ...config };
  }

  /**
   * Wait until a request can be made within rate limits.
   */
  async acquire(estimatedTokens: number = 1000): Promise<void> {
    // Wait until a concurrent request slot is available.
    await this.waitForSlot();

    // Wait until request/token rate limits allow the request.
    await this.waitForRateLimit(estimatedTokens);

    // Record the request.
    this.activeRequests++;

    this.requestHistory.push({
      timestamp: Date.now(),
      tokens: estimatedTokens,
    });
  }

  /**
   * Release a request slot after completion.
   *
   * @param actualTokens - Actual tokens used (updates estimate)
   */
  release(actualTokens?: number): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);

    // Update the most recent request with actual token count if provided.
    if (actualTokens !== undefined && this.requestHistory.length > 0) {
      const lastRequest =
        this.requestHistory[this.requestHistory.length - 1];

      // TypeScript strict mode requires checking the indexed value.
      if (lastRequest) {
        lastRequest.tokens = actualTokens;
      }
    }

    // Wake up the next waiting request.
    const next = this.waitQueue.shift();

    if (next) {
      next();
    }
  }

  /**
   * Get current rate limit status.
   */
  getStatus(): {
    activeRequests: number;
    requestsInWindow: number;
    tokensInWindow: number;
    availableRequests: number;
    availableTokens: number;
  } {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;

    const tokensInWindow = this.requestHistory.reduce(
      (sum, record) => sum + record.tokens,
      0
    );

    return {
      activeRequests: this.activeRequests,
      requestsInWindow,
      tokensInWindow,
      availableRequests: Math.max(
        0,
        this.config.maxRequestsPerMinute - requestsInWindow
      ),
      availableTokens: Math.max(
        0,
        this.config.maxTokensPerMinute - tokensInWindow
      ),
    };
  }

  /**
   * Check if request can proceed immediately.
   *
   * @param estimatedTokens - Estimated tokens for the request
   */
  canProceed(estimatedTokens: number = 1000): boolean {
    this.pruneOldRecords();

    const requestsInWindow = this.requestHistory.length;

    const tokensInWindow = this.requestHistory.reduce(
      (sum, record) => sum + record.tokens,
      0
    );

    const concurrentAvailable =
      this.activeRequests < this.config.maxConcurrent;

    const requestLimitAvailable =
      requestsInWindow < this.config.maxRequestsPerMinute;

    const tokenLimitAvailable =
      tokensInWindow + estimatedTokens <= this.config.maxTokensPerMinute;

    return (
      concurrentAvailable &&
      requestLimitAvailable &&
      tokenLimitAvailable
    );
  }

  /**
   * Wait for a concurrent request slot to become available.
   */
  private async waitForSlot(): Promise<void> {
    while (this.activeRequests >= this.config.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.waitQueue.push(resolve);
      });
    }
  }

  /**
   * Wait until request and token rate limits allow the request.
   */
  private async waitForRateLimit(
    estimatedTokens: number
  ): Promise<void> {
    while (!this.canProceed(estimatedTokens)) {
      this.pruneOldRecords();

      if (this.requestHistory.length === 0) {
        break;
      }

      const oldestRequest = this.requestHistory[0];

      if (!oldestRequest) {
        break;
      }

      const expirationTime = oldestRequest.timestamp + 60000;

      const waitTime = Math.min(
        5000,
        Math.max(100, expirationTime - Date.now() + 100)
      );

      await new Promise<void>((resolve) => {
        setTimeout(resolve, waitTime);
      });
    }
  }

  /**
   * Remove request records older than 60 seconds.
   */
  private pruneOldRecords(): void {
    const oneMinuteAgo = Date.now() - 60000;

    this.requestHistory = this.requestHistory.filter(
      (record) => record.timestamp > oneMinuteAgo
    );
  }
}

/**
 * Wrap an async function with rate limiting.
 */
export function withRateLimit<T>(
  rateLimiter: RateLimiter,
  fn: () => Promise<T>,
  estimatedTokens: number = 1000
): Promise<T> {
  return new Promise(async (resolve, reject) => {
    try {
      await rateLimiter.acquire(estimatedTokens);

      const result = await fn();

      rateLimiter.release();

      resolve(result);
    } catch (error) {
      rateLimiter.release();
      reject(error);
    }
  });
}

/**
 * Global rate limiter instance.
 */
export const globalRateLimiter = new RateLimiter();