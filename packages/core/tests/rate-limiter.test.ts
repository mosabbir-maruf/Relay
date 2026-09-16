import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, NoopRateLimiter } from '../src/index.js';

describe('InMemoryRateLimiter', () => {
  it('allows the first request with correct remaining and limit', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 5,
      getTime: () => mockTime,
    });

    const decision = limiter.check({ key: 'client-1' });

    expect(decision.allowed).toBe(true);
    expect(decision.limit).toBe(5);
    expect(decision.remaining).toBe(4);
    expect(decision.resetAt).toBe(1_060_000);
    expect(decision.retryAfterSeconds).toBeUndefined();
  });

  it('allows multiple requests within the configured limit and decrements remaining', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 3,
      getTime: () => mockTime,
    });

    const d1 = limiter.check({ key: 'client-1' });
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(2);

    const d2 = limiter.check({ key: 'client-1' });
    expect(d2.allowed).toBe(true);
    expect(d2.remaining).toBe(1);

    const d3 = limiter.check({ key: 'client-1' });
    expect(d3.allowed).toBe(true);
    expect(d3.remaining).toBe(0);
  });

  it('denies requests exceeding the limit and calculates accurate retryAfterSeconds', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      getTime: () => mockTime,
    });

    limiter.check({ key: 'client-1' });
    limiter.check({ key: 'client-1' });

    // Advance time 20 seconds into the 60 second window
    mockTime += 20_000;

    const denied = limiter.check({ key: 'client-1' });
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.limit).toBe(2);
    // 40 seconds remaining in the window: Math.ceil((1_060_000 - 1_020_000) / 1000) = 40
    expect(denied.retryAfterSeconds).toBe(40);
  });

  it('resets rate limit window after expiration', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 30_000,
      maxRequests: 1,
      getTime: () => mockTime,
    });

    const d1 = limiter.check({ key: 'client-1' });
    expect(d1.allowed).toBe(true);

    const denied = limiter.check({ key: 'client-1' });
    expect(denied.allowed).toBe(false);

    // Advance clock past the 30s window
    mockTime += 30_001;

    const renewed = limiter.check({ key: 'client-1' });
    expect(renewed.allowed).toBe(true);
    expect(renewed.remaining).toBe(0); // 1 request allowed, remaining is 0
  });

  it('tracks limits separately for separate keys/clients', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
      getTime: () => mockTime,
    });

    const d1 = limiter.check({ key: 'client-a' });
    expect(d1.allowed).toBe(true);

    const d2 = limiter.check({ key: 'client-a' });
    expect(d2.allowed).toBe(false);

    // client-b should have its own separate limit
    const d3 = limiter.check({ key: 'client-b' });
    expect(d3.allowed).toBe(true);
  });

  it('enforces bounded memory capacity (maxKeys) and evicts oldest keys on overflow', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 2,
      maxKeys: 3,
      getTime: () => mockTime,
    });

    limiter.check({ key: 'client-1' });
    limiter.check({ key: 'client-2' });
    limiter.check({ key: 'client-3' });

    expect(limiter.size).toBe(3);

    // Adding a 4th key should trigger eviction of the oldest (client-1)
    limiter.check({ key: 'client-4' });

    expect(limiter.size).toBeLessThanOrEqual(3);

    // client-1 was evicted; checking it again should treat it as a fresh window
    const dClient1 = limiter.check({ key: 'client-1' });
    expect(dClient1.allowed).toBe(true);
    expect(dClient1.remaining).toBe(1);
  });

  it('cleans up expired entries deterministically via cleanupExpired()', () => {
    let mockTime = 1_000_000;
    const limiter = new InMemoryRateLimiter({
      windowMs: 10_000,
      maxRequests: 5,
      getTime: () => mockTime,
    });

    limiter.check({ key: 'client-1' });
    limiter.check({ key: 'client-2' });

    expect(limiter.size).toBe(2);

    // Before expiration
    expect(limiter.cleanupExpired(mockTime + 5_000)).toBe(0);
    expect(limiter.size).toBe(2);

    // After expiration
    expect(limiter.cleanupExpired(mockTime + 11_000)).toBe(2);
    expect(limiter.size).toBe(0);
  });

  it('resets specific key or all keys', () => {
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 1,
    });

    limiter.check({ key: 'client-1' });
    limiter.check({ key: 'client-2' });

    limiter.reset('client-1');
    expect(limiter.check({ key: 'client-1' }).allowed).toBe(true);
    expect(limiter.check({ key: 'client-2' }).allowed).toBe(false);

    limiter.reset();
    expect(limiter.size).toBe(0);
  });

  it('supports custom request cost weights', () => {
    const limiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 10,
    });

    const d1 = limiter.check({ key: 'client-heavy', cost: 7 });
    expect(d1.allowed).toBe(true);
    expect(d1.remaining).toBe(3);

    const d2 = limiter.check({ key: 'client-heavy', cost: 4 });
    expect(d2.allowed).toBe(false);
  });

  it('NoopRateLimiter permits all requests without restriction', () => {
    const noop = new NoopRateLimiter();
    const d = noop.check({ key: 'any-key' });
    expect(d.allowed).toBe(true);
    expect(d.remaining).toBe(Number.MAX_SAFE_INTEGER);
  });
});
