import { describe, expect, it } from 'vitest';
import {
  InMemoryCircuitBreaker,
  InMemoryRateLimiter,
  InMemoryUsageSink,
  RelayAuthenticationError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRateLimitError,
} from '@relay/core';
import { ModelRouter, ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('Circuit Breaker Gateway Integration', () => {
  function setupTestHarness(options?: {
    failureThreshold?: number;
    resetTimeoutMs?: number;
    halfOpenMaxRequests?: number;
    enabled?: boolean;
    rateLimitEnabled?: boolean;
    getTime?: () => number;
  }) {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      CIRCUIT_BREAKER_ENABLED: options?.enabled !== false ? 'true' : 'false',
      CIRCUIT_BREAKER_FAILURE_THRESHOLD: String(options?.failureThreshold ?? 2),
      CIRCUIT_BREAKER_RESET_TIMEOUT_MS: String(options?.resetTimeoutMs ?? 5000),
      CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS: String(options?.halfOpenMaxRequests ?? 1),
      ROUTING_POLICIES: JSON.stringify([
        {
          model: 'coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
      RATE_LIMIT_ENABLED: options?.rateLimitEnabled ? 'true' : 'false',
      RATE_LIMIT_MAX_REQUESTS: '5',
      RATE_LIMIT_WINDOW_MS: '60000',
    });

    const registry = new ProviderRegistry();
    const primaryProvider = new TestMockProvider('qwen-provider', 'Qwen Provider');
    const fallbackProvider = new TestMockProvider('gemini-provider', 'Gemini Provider');

    registry.registerProvider(primaryProvider);
    registry.registerProvider(fallbackProvider);

    registry.registerModel({
      id: 'qwen3-coder-30b',
      name: 'Qwen 30B',
      provider: 'qwen-provider',
      capabilities: primaryProvider.getCapabilities('qwen3-coder-30b'),
    });

    registry.registerModel({
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      provider: 'gemini-provider',
      capabilities: fallbackProvider.getCapabilities('gemini-2.5-flash'),
    });

    const router = new ModelRouter({
      registry,
      policies: config.routingPolicies,
    });

    const sink = new InMemoryUsageSink();
    const rateLimiter = new InMemoryRateLimiter({
      windowMs: 60_000,
      maxRequests: 5,
    });

    const circuitBreaker =
      options?.enabled !== false
        ? new InMemoryCircuitBreaker({
            failureThreshold: options?.failureThreshold ?? 2,
            resetTimeoutMs: options?.resetTimeoutMs ?? 5000,
            halfOpenMaxRequests: options?.halfOpenMaxRequests ?? 1,
            getTime: options?.getTime,
          })
        : undefined;

    return {
      config,
      registry,
      router,
      sink,
      rateLimiter,
      circuitBreaker,
      primaryProvider,
      fallbackProvider,
      createApp: () =>
        createApp({
          config,
          registry,
          router,
          usageSink: sink,
          rateLimiter,
          circuitBreaker,
          serverOptions: { logger: false },
        }),
    };
  }

  it('skips open primary and routes directly to fallback without calling primary', async () => {
    const harness = setupTestHarness({ failureThreshold: 1 });
    // Manually trip the primary breaker to OPEN
    harness.circuitBreaker!.onFailure('qwen-provider', new RelayProviderUnavailableError('Down'));
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    let primaryCalled = false;
    const origChat = harness.primaryProvider.chat.bind(harness.primaryProvider);
    harness.primaryProvider.chat = async (...args) => {
      primaryCalled = true;
      return origChat(...args);
    };

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'Write code' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.choices[0].message.content).toContain('Echo: Write code');
    // Primary was completely skipped
    expect(primaryCalled).toBe(false);

    // Telemetry shows fallback provider was used
    expect(harness.sink.records).toHaveLength(1);
    expect(harness.sink.records[0]!.provider).toBe('gemini-provider');
  });

  it('trips circuit after failureThreshold qualifying failures and then skips primary', async () => {
    const harness = setupTestHarness({ failureThreshold: 2 });
    const app = await harness.createApp();

    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError('Service Down', {
      statusCode: 503,
    });

    let primaryAttempts = 0;
    const origChat = harness.primaryProvider.chat.bind(harness.primaryProvider);
    harness.primaryProvider.chat = async (...args) => {
      primaryAttempts++;
      return origChat(...args);
    };

    // Request 1: primary fails (failure #1), falls back to secondary (200)
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'req 1' }],
      },
    });
    expect(res1.statusCode).toBe(200);
    expect(primaryAttempts).toBe(1);
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('closed');

    // Request 2: primary fails (failure #2), falls back to secondary (200). Breaker trips!
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'req 2' }],
      },
    });
    expect(res2.statusCode).toBe(200);
    expect(primaryAttempts).toBe(2);
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    // Request 3: primary breaker is OPEN -> skipped directly, primaryAttempts does NOT increase!
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'req 3' }],
      },
    });
    expect(res3.statusCode).toBe(200);
    expect(primaryAttempts).toBe(2); // Still 2! Primary was NOT called.
  });

  it('returns normalized 503 Service Unavailable when all candidates are OPEN', async () => {
    const harness = setupTestHarness({ failureThreshold: 1 });
    harness.circuitBreaker!.onFailure('qwen-provider', new RelayProviderUnavailableError('503'));
    harness.circuitBreaker!.onFailure('gemini-provider', new RelayProviderUnavailableError('503'));

    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');
    expect(harness.circuitBreaker!.getState('gemini-provider')).toBe('open');

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'Hello' }],
      },
    });

    expect(res.statusCode).toBe(503);
    const body = JSON.parse(res.body);
    expect(body.error.type).toBe('provider_unavailable');
    expect(body.error.message).toContain('circuit breaker is open');
  });

  it('non-qualifying errors (400, 401, 429) do not trip the circuit breaker', async () => {
    const harness = setupTestHarness({ failureThreshold: 2 });
    const app = await harness.createApp();

    // 1. Invalid request (400)
    harness.primaryProvider.shouldFailWith = new RelayInvalidRequestError('Invalid prompt');
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'test' }],
      },
    });
    expect(res1.statusCode).toBe(400);
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('closed');

    // 2. Authentication error (401)
    harness.primaryProvider.shouldFailWith = new RelayAuthenticationError('Invalid key');
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'test' }],
      },
    });
    expect(res2.statusCode).toBe(401);
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('closed');

    // 3. Upstream rate limit (429)
    harness.primaryProvider.shouldFailWith = new RelayRateLimitError('Too many requests');
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'test' }],
      },
    });
    expect(res3.statusCode).toBe(429);
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('closed');
  });

  it('recovers from OPEN to HALF_OPEN and closes on successful trial request', async () => {
    let mockTime = 1000;
    const getTime = () => mockTime;

    const harness = setupTestHarness({
      failureThreshold: 1,
      resetTimeoutMs: 5000,
      getTime,
    });
    const app = await harness.createApp();

    // Trip the primary circuit
    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError('503');
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'trip' }],
      },
    });
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    // Clear the error on primary so it can succeed
    harness.primaryProvider.shouldFailWith = undefined;

    // Advance time past resetTimeoutMs (5000ms)
    mockTime += 5001;
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('half_open');

    // Trial request should be sent to primary and succeed
    let primaryCalled = false;
    const origChat = harness.primaryProvider.chat.bind(harness.primaryProvider);
    harness.primaryProvider.chat = async (...args) => {
      primaryCalled = true;
      return origChat(...args);
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'trial' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(primaryCalled).toBe(true);
    // Circuit is now CLOSED
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('closed');
  });

  it('re-opens immediately if trial request in HALF_OPEN fails', async () => {
    let mockTime = 1000;
    const getTime = () => mockTime;

    const harness = setupTestHarness({
      failureThreshold: 1,
      resetTimeoutMs: 5000,
      getTime,
    });
    const app = await harness.createApp();

    // Trip the primary circuit
    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError('503');
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'trip' }],
      },
    });
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    // Advance time to HALF_OPEN
    mockTime += 5001;
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('half_open');

    // Primary still fails
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'trial failed' }],
      },
    });

    expect(res.statusCode).toBe(200); // Fell back to secondary
    // Breaker is back to OPEN immediately!
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');
  });

  it('limits concurrent trial requests in HALF_OPEN state', async () => {
    let mockTime = 1000;
    const getTime = () => mockTime;

    const harness = setupTestHarness({
      failureThreshold: 1,
      resetTimeoutMs: 5000,
      halfOpenMaxRequests: 1,
      getTime,
    });
    const app = await harness.createApp();

    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError('503');
    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'trip' }],
      },
    });
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    // Make primary slow so trial request stays in-flight
    harness.primaryProvider.shouldFailWith = undefined;
    harness.primaryProvider.delayMs = 100;

    mockTime += 5001;
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('half_open');

    // Launch trial request (Request 1)
    const p1 = app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'trial 1' }],
      },
    });

    // Launch Request 2 concurrently while Request 1 is in-flight:
    // Trial limit is reached, so Request 2 skips primary and goes directly to fallback!
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'concurrent 2' }],
      },
    });

    const res1 = await p1;

    expect(res1.statusCode).toBe(200);
    expect(res2.statusCode).toBe(200);

    // res1 used primary, res2 used fallback
    const records = harness.sink.records;
    expect(records.find((r) => r.provider === 'qwen-provider')).toBeDefined();
    expect(records.find((r) => r.provider === 'gemini-provider')).toBeDefined();
  });

  it('supports streaming: skips open primary directly to fallback stream', async () => {
    const harness = setupTestHarness({ failureThreshold: 1 });
    harness.circuitBreaker!.onFailure('qwen-provider', new RelayProviderUnavailableError('Down'));
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    let primaryStreamCalled = false;
    const origStream = harness.primaryProvider.chatStream.bind(harness.primaryProvider);
    harness.primaryProvider.chatStream = async function* (...args) {
      primaryStreamCalled = true;
      yield* origStream(...args);
    };

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'coder',
        stream: true,
        messages: [{ role: 'user', content: 'Stream this' }],
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: ');
    expect(primaryStreamCalled).toBe(false);

    // Telemetry shows fallback
    expect(harness.sink.records[0]!.provider).toBe('gemini-provider');
    expect(harness.sink.records[0]!.stream).toBe(true);
  });

  it('charges rate limiter only ONCE when circuit breaker skips primary or triggers fallback', async () => {
    const harness = setupTestHarness({
      failureThreshold: 1,
      rateLimitEnabled: true,
    });
    // Trip primary circuit to OPEN
    harness.circuitBreaker!.onFailure('qwen-provider', new RelayProviderUnavailableError('503'));
    expect(harness.circuitBreaker!.getState('qwen-provider')).toBe('open');

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-forwarded-for': '198.51.100.1' },
      payload: {
        model: 'coder',
        messages: [{ role: 'user', content: 'rate limit test' }],
      },
    });

    expect(res.statusCode).toBe(200);
    // Rate limit remaining should be 4 (5 - 1 = 4), not 3!
    expect(res.headers['x-ratelimit-remaining']).toBe('4');
  });

  it('bypasses circuit breaking when CIRCUIT_BREAKER_ENABLED=false', async () => {
    const harness = setupTestHarness({
      enabled: false,
    });
    const app = await harness.createApp();

    let attempts = 0;
    const origChat = harness.primaryProvider.chat.bind(harness.primaryProvider);
    harness.primaryProvider.chat = async (...args) => {
      attempts++;
      return origChat(...args);
    };

    // Even if requests fail, it never trips because circuit breaker is Noop
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'coder',
          messages: [{ role: 'user', content: `test ${i}` }],
        },
      });
      expect(res.statusCode).toBe(200);
    }

    expect(attempts).toBe(5);
  });
});
