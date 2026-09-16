/**
 * Outcome of a rate limit check.
 */
export interface RateLimitDecision {
  /**
   * Whether the request is permitted.
   */
  readonly allowed: boolean;
  /**
   * Number of remaining requests allowed within the current window.
   */
  readonly remaining: number;
  /**
   * Maximum allowed requests in the window.
   */
  readonly limit: number;
  /**
   * Seconds to wait before retrying when denied.
   */
  readonly retryAfterSeconds?: number | undefined;
  /**
   * Milliseconds timestamp (epoch ms) when the current window resets.
   */
  readonly resetAt?: number | undefined;
}

/**
 * Input parameters for a rate limit check.
 */
export interface RateLimitInput {
  /**
   * Unique client or IP identifier key.
   */
  readonly key: string;
  /**
   * Cost/weight of this request (default: 1).
   */
  readonly cost?: number | undefined;
}

/**
 * Provider-agnostic rate limiter contract.
 * Decoupled from any specific storage mechanism (in-memory, Redis, Memcached).
 */
export interface RateLimiter {
  /**
   * Checks if a request should be allowed and records consumption.
   */
  check(input: RateLimitInput): Promise<RateLimitDecision> | RateLimitDecision;

  /**
   * Resets rate limit for a specific key, or all keys if omitted.
   */
  reset?(key?: string): Promise<void> | void;

  /**
   * Cleans up any resources or background handles.
   */
  destroy?(): Promise<void> | void;
}

export interface InMemoryRateLimiterOptions {
  /**
   * Time window in milliseconds. Default: 60,000 (1 minute).
   */
  readonly windowMs?: number | undefined;
  /**
   * Maximum allowed requests within the window. Default: 60.
   */
  readonly maxRequests?: number | undefined;
  /**
   * Maximum number of keys to retain in memory to prevent exhaustion attacks. Default: 10,000.
   */
  readonly maxKeys?: number | undefined;
  /**
   * Custom clock for deterministic testing. Default: Date.now.
   */
  readonly getTime?: (() => number) | undefined;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

/**
 * High-performance, process-local in-memory rate limiter using a fixed window with reset.
 * Features strict bounded memory capacity, LRU eviction on overflow, and deterministic cleanup.
 */
export class InMemoryRateLimiter implements RateLimiter {
  readonly windowMs: number;
  readonly maxRequests: number;
  readonly maxKeys: number;
  private readonly getTime: () => number;
  private readonly buckets: Map<string, RateLimitBucket> = new Map();

  constructor(options: InMemoryRateLimiterOptions = {}) {
    this.windowMs = options.windowMs ?? 60_000;
    this.maxRequests = options.maxRequests ?? 60;
    this.maxKeys = options.maxKeys ?? 10_000;
    this.getTime = options.getTime ?? Date.now;
  }

  /**
   * Synchronously checks and increments rate limit for a given key.
   */
  check(input: RateLimitInput): RateLimitDecision {
    const now = this.getTime();
    const cost = Math.max(1, input.cost ?? 1);
    const key = input.key;

    let bucket = this.buckets.get(key);

    // If key does not exist or previous window has expired, initialize new window
    if (!bucket || now >= bucket.resetAt) {
      bucket = {
        count: cost,
        resetAt: now + this.windowMs,
      };

      this.buckets.set(key, bucket);
      this.enforceCapacity(now);

      const allowed = bucket.count <= this.maxRequests;
      const remaining = allowed ? Math.max(0, this.maxRequests - bucket.count) : 0;
      const retryAfterSeconds = allowed
        ? undefined
        : Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

      return {
        allowed,
        remaining,
        limit: this.maxRequests,
        resetAt: bucket.resetAt,
        ...(retryAfterSeconds !== undefined ? { retryAfterSeconds } : {}),
      };
    }

    // Existing active window: check if within limit
    if (bucket.count + cost <= this.maxRequests) {
      bucket.count += cost;
      // Re-insert to maintain LRU access order
      this.buckets.delete(key);
      this.buckets.set(key, bucket);

      return {
        allowed: true,
        remaining: Math.max(0, this.maxRequests - bucket.count),
        limit: this.maxRequests,
        resetAt: bucket.resetAt,
      };
    }

    // Denied: limit exceeded
    const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - now) / 1000));

    return {
      allowed: false,
      remaining: 0,
      limit: this.maxRequests,
      retryAfterSeconds,
      resetAt: bucket.resetAt,
    };
  }

  /**
   * Resets rate limit for a specific key, or clears all keys.
   */
  reset(key?: string): void {
    if (key !== undefined) {
      this.buckets.delete(key);
    } else {
      this.buckets.clear();
    }
  }

  /**
   * Purges expired entries from memory. Returns number of purged entries.
   */
  cleanupExpired(now: number = this.getTime()): number {
    let purged = 0;
    for (const [key, bucket] of this.buckets.entries()) {
      if (now >= bucket.resetAt) {
        this.buckets.delete(key);
        purged++;
      }
    }
    return purged;
  }

  /**
   * Returns current count of active tracked keys.
   */
  get size(): number {
    return this.buckets.size;
  }

  destroy(): void {
    this.buckets.clear();
  }

  /**
   * Enforces bounded memory limits to prevent attacker memory exhaustion.
   */
  private enforceCapacity(now: number): void {
    if (this.buckets.size <= this.maxKeys) {
      return;
    }

    // Pass 1: Clean expired keys
    this.cleanupExpired(now);

    // Pass 2: If still over maxKeys, evict oldest entries (LRU order)
    while (this.buckets.size > this.maxKeys) {
      const oldestKey = this.buckets.keys().next().value;
      if (oldestKey === undefined) break;
      this.buckets.delete(oldestKey);
    }
  }
}

/**
 * No-op rate limiter that permits all requests.
 */
export class NoopRateLimiter implements RateLimiter {
  check(_input: RateLimitInput): RateLimitDecision {
    return {
      allowed: true,
      remaining: Number.MAX_SAFE_INTEGER,
      limit: Number.MAX_SAFE_INTEGER,
    };
  }
}
