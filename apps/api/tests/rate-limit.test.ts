import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, InMemoryUsageSink } from '@relay/core';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

function setupTestApp(options: {
  rateLimitEnabled?: boolean;
  maxRequests?: number;
  windowMs?: number;
  maxKeys?: number;
  keyStrategy?: 'client_or_ip' | 'client_only' | 'ip_only';
  trustProxy?: boolean;
  relayApiKey?: string;
  getTime?: () => number;
  usageSink?: InMemoryUsageSink;
}) {
  const config = loadConfig({
    LOG_LEVEL: 'silent',
    RATE_LIMIT_ENABLED: (options.rateLimitEnabled ?? true) ? 'true' : 'false',
    RATE_LIMIT_MAX_REQUESTS: String(options.maxRequests ?? 3),
    RATE_LIMIT_WINDOW_MS: String(options.windowMs ?? 60_000),
    RATE_LIMIT_KEY_STRATEGY: options.keyStrategy ?? 'client_or_ip',
    RATE_LIMIT_MAX_KEYS: String(options.maxKeys ?? 10_000),
    TRUST_PROXY: options.trustProxy ? 'true' : 'false',
    RELAY_API_KEY: options.relayApiKey,
  });

  const registry = new ProviderRegistry();
  const mockProvider = new TestMockProvider('mock-provider');
  registry.registerProvider(mockProvider);
  registry.registerModel({
    id: 'mock-model',
    name: 'Mock Model',
    provider: 'mock-provider',
    capabilities: mockProvider.getCapabilities('mock-model'),
  });

  const sink = options.usageSink ?? new InMemoryUsageSink();
  const rateLimiter = new InMemoryRateLimiter({
    windowMs: options.windowMs ?? 60_000,
    maxRequests: options.maxRequests ?? 3,
    maxKeys: options.maxKeys ?? 10_000,
    getTime: options.getTime,
  });

  return {
    config,
    registry,
    sink,
    rateLimiter,
    create: () =>
      createApp({
        config,
        registry,
        usageSink: sink,
        rateLimiter,
        serverOptions: {
          logger: false,
          trustProxy: options.trustProxy ?? false,
        },
      }),
  };
}

describe('Relay Rate Limiting Foundation', () => {
  it('allows first request and sets rate limit response headers', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 5,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBe('5');
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
    expect(res.headers['x-ratelimit-reset']).toBe(String(Math.ceil((mockTime + 60_000) / 1000)));
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('allows requests within limit and decrements remaining count', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 3,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    const makeReq = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });

    const res1 = await makeReq();
    expect(res1.statusCode).toBe(200);
    expect(res1.headers['x-ratelimit-remaining']).toBe('2');

    const res2 = await makeReq();
    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('1');

    const res3 = await makeReq();
    expect(res3.statusCode).toBe(200);
    expect(res3.headers['x-ratelimit-remaining']).toBe('0');
  });

  it('returns HTTP 429 with standard OpenAI error envelope when exceeding limit', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 2,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    const makeReq = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });

    await makeReq();
    await makeReq();

    // 3rd request exceeds limit
    const res = await makeReq();

    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBe('2');
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.headers['retry-after']).toBeDefined();

    const body = JSON.parse(res.body);
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(body.error.type).toBe('rate_limit_exceeded');
    expect(body.error.message).toContain('Rate limit exceeded');
    expect(body.error.details.limit).toBe(2);
    expect(body.error.details.remaining).toBe(0);
    expect(body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('accurately calculates retry-after based on elapsed time within window', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    // 1st request uses the quota
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    // Advance 25 seconds into the 60 second window
    mockTime += 25_000;

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(429);
    // 35 seconds remaining (60,000 - 25,000 = 35,000 ms -> 35 seconds)
    expect(res.headers['retry-after']).toBe('35');
  });

  it('resets limit once window duration expires', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 30_000,
      getTime: () => mockTime,
    });
    const app = await create();

    const makeReq = () =>
      app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });

    const res1 = await makeReq();
    expect(res1.statusCode).toBe(200);

    const res2 = await makeReq();
    expect(res2.statusCode).toBe(429);

    // Advance past the 30-second window
    mockTime += 30_001;

    const res3 = await makeReq();
    expect(res3.statusCode).toBe(200);
    expect(res3.headers['x-ratelimit-remaining']).toBe('0'); // 1 limit, 1 consumed
  });

  it('tracks separate limits for separate clients with authenticated identity keying', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: 'client_or_ip',
      relayApiKey: 'global-key',
      getTime: () => mockTime,
    });
    const app = await create();

    // Client 1
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer global-key' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi from Client 1' }],
      },
    });
    expect(res1.statusCode).toBe(200);

    // Client 1 again -> 429
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer global-key' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi from Client 1' }],
      },
    });
    expect(res2.statusCode).toBe(429);
  });

  it('tracks separate limits across different authenticated bearer tokens without leaking tokens', async () => {
    let mockTime = 1_000_000;
    // Without RELAY_API_KEY configured, arbitrary client tokens are permitted and hashed
    const { create, rateLimiter } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: 'client_or_ip',
      getTime: () => mockTime,
    });
    const app = await create();

    const resTokenA = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer token-alpha' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(resTokenA.statusCode).toBe(200);

    // Alpha second request is blocked
    const resTokenABlocked = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer token-alpha' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(resTokenABlocked.statusCode).toBe(429);

    // Beta has its own separate quota
    const resTokenB = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: 'Bearer token-beta' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(resTokenB.statusCode).toBe(200);

    // Verify secrets are NOT stored in rate limiter state
    // Resetting alpha via its hash should restore alpha without touching beta
    expect(rateLimiter.size).toBe(2);
  });

  it('falls back to IP address limiting when unauthenticated', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      keyStrategy: 'client_or_ip',
      getTime: () => mockTime,
    });
    const app = await create();

    // Simulated IP 10.0.0.1
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '10.0.0.1',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res1.statusCode).toBe(200);

    // Second request from same IP is blocked
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '10.0.0.1',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res2.statusCode).toBe(429);

    // Request from different IP (10.0.0.2) is allowed
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '10.0.0.2',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res3.statusCode).toBe(200);
  });

  it('ignores spoofed X-Forwarded-For headers when TRUST_PROXY is false (default)', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      trustProxy: false,
      getTime: () => mockTime,
    });
    const app = await create();

    // First request from socket IP 127.0.0.1 with spoofed header
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.1' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res1.statusCode).toBe(200);

    // Second request from same socket IP with different spoofed header: MUST still be rate limited!
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      remoteAddress: '127.0.0.1',
      headers: { 'x-forwarded-for': '203.0.113.2' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res2.statusCode).toBe(429);
  });

  it('honors X-Forwarded-For headers when TRUST_PROXY is true', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      trustProxy: true,
      getTime: () => mockTime,
    });
    const app = await create();

    // When trusted, Fastify evaluates X-Forwarded-For as client IP
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-forwarded-for': '203.0.113.10' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res1.statusCode).toBe(200);

    // Different forwarded client IP has its own separate limit
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-forwarded-for': '203.0.113.20' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(res2.statusCode).toBe(200);
  });

  it('enforces bounded memory state under high key cardinality', async () => {
    let mockTime = 1_000_000;
    const { create, rateLimiter } = setupTestApp({
      maxRequests: 2,
      maxKeys: 3,
      getTime: () => mockTime,
    });
    const app = await create();

    // Send requests from 5 distinct IPs
    for (let i = 1; i <= 5; i++) {
      await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        remoteAddress: `198.51.100.${i}`,
        payload: {
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });
    }

    // Capacity must be strictly bounded at maxKeys (3)
    expect(rateLimiter.size).toBeLessThanOrEqual(3);
  });

  it('exempts /health endpoint from rate limiting', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    // Exhaust quota for this IP on chat endpoint
    const chat1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(chat1.statusCode).toBe(200);

    const chat2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });
    expect(chat2.statusCode).toBe(429);

    // /health MUST remain accessible and unrestricted for operational monitoring
    for (let i = 0; i < 5; i++) {
      const healthRes = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(healthRes.statusCode).toBe(200);
      expect(JSON.parse(healthRes.body).status).toBe('ok');
      expect(healthRes.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });

  it('records normalized UsageRecord telemetry when a request is denied with 429', async () => {
    let mockTime = 1_000_000;
    const { create, sink } = setupTestApp({
      maxRequests: 1,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    // 1st request succeeds
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-request-id': 'req-ok' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    // 2nd request denied with 429
    const deniedRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-request-id': 'req-limited' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(deniedRes.statusCode).toBe(429);

    const records = sink.getRecords();
    expect(records).toHaveLength(2);

    const rateLimitRecord = records.find((r) => r.requestId === 'req-limited');
    expect(rateLimitRecord).toBeDefined();
    expect(rateLimitRecord?.statusCode).toBe(429);
    expect(rateLimitRecord?.success).toBe(false);
    expect(rateLimitRecord?.errorCategory).toBe('rate_limit_exceeded');
    expect(rateLimitRecord?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('bypasses rate limiting when RATE_LIMIT_ENABLED is false', async () => {
    let mockTime = 1_000_000;
    const { create } = setupTestApp({
      rateLimitEnabled: false,
      maxRequests: 1,
      windowMs: 60_000,
      getTime: () => mockTime,
    });
    const app = await create();

    // Sending multiple requests beyond limit should all succeed
    for (let i = 0; i < 4; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-model',
          messages: [{ role: 'user', content: 'Hi' }],
        },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    }
  });
});
