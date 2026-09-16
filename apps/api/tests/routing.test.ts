import { describe, expect, it } from 'vitest';
import {
  InMemoryRateLimiter,
  InMemoryUsageSink,
  RelayAuthenticationError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
} from '@relay/core';
import { ModelRouter, ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('Relay Routing Policy & Fallback Foundation', () => {
  function setupTestHarness(options?: {
    routingPolicies?: string;
    requestTimeoutMs?: number;
    rateLimitEnabled?: boolean;
  }) {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      ROUTING_POLICIES: options?.routingPolicies,
      REQUEST_TIMEOUT_MS: String(options?.requestTimeoutMs ?? 60_000),
      RATE_LIMIT_ENABLED: options?.rateLimitEnabled ? 'true' : 'false',
      RATE_LIMIT_MAX_REQUESTS: '2',
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
      maxRequests: 2,
    });

    return {
      config,
      registry,
      router,
      sink,
      rateLimiter,
      primaryProvider,
      fallbackProvider,
      createApp: () =>
        createApp({
          config,
          registry,
          router,
          usageSink: sink,
          rateLimiter,
          serverOptions: { logger: false },
        }),
    };
  }

  it('exact model routing continues working normally without policies', async () => {
    const harness = setupTestHarness();
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'qwen3-coder-30b',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.model).toBe('qwen3-coder-30b');
    expect(body.choices[0].message.content).toContain('Echo: Hi');
  });

  it('qualified model routing continues working normally (provider/model)', async () => {
    const harness = setupTestHarness();
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gemini-provider/gemini-2.5-flash',
        messages: [{ role: 'user', content: 'Hello Gemini' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.model).toBe('gemini-provider/gemini-2.5-flash');
  });

  it('routes logical model alias to configured target', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'fast-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
        },
      ]),
    });
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fast-coder',
        messages: [{ role: 'user', content: 'Write code' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.model).toBe('fast-coder');
    expect(body.choices[0].message.content).toContain('Echo: Write code');
  });

  it('rejects unknown model or alias with 400 Bad Request', async () => {
    const harness = setupTestHarness();
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'non-existent-model',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('not recognized or configured');
  });

  it('detects and rejects alias cycle with 400 Bad Request', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        { model: 'model-a', primary: 'model-b' },
        { model: 'model-b', primary: 'model-a' },
      ]),
    });
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'model-a',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('invalid_request');
    expect(body.error.message).toContain('Routing policy cycle detected');
  });

  it('primary success: executes only primary and records attemptCount = 1', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(200);

    const records = harness.sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.requestedModel).toBe('resilient-coder');
    expect(records[0]?.provider).toBe('qwen-provider');
    expect(records[0]?.attemptCount).toBe(1);
    expect(records[0]?.success).toBe(true);
  });

  it('primary retryable failure -> fallback success', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Make primary provider fail with retryable 502 error
    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError(
      'Qwen backend is temporarily unavailable',
    );

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Hello Fallback' }],
      },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.model).toBe('resilient-coder');
    expect(body.choices[0].message.content).toContain('Echo: Hello Fallback');

    const records = harness.sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.requestedModel).toBe('resilient-coder');
    expect(records[0]?.provider).toBe('gemini-provider'); // Fallback provider served the request
    expect(records[0]?.attemptCount).toBe(2);
    expect(records[0]?.success).toBe(true);
  });

  it('primary non-retryable failure (401 Auth / 400 Invalid) does NOT attempt fallback', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Non-retryable error
    harness.primaryProvider.shouldFailWith = new RelayAuthenticationError(
      'Upstream API key invalid',
    );

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('authentication_error');

    const records = harness.sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.attemptCount).toBe(1);
    expect(records[0]?.success).toBe(false);
  });

  it('all fallbacks fail: returns normalized error from last attempt', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Both primary and fallback fail with retryable 502
    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError('Primary down');
    harness.fallbackProvider.shouldFailWith = new RelayProviderUnavailableError('Fallback down');

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(502);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('provider_unavailable');

    const records = harness.sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.attemptCount).toBe(2);
    expect(records[0]?.success).toBe(false);
  });

  it('timeout budget applies across all attempts', async () => {
    const harness = setupTestHarness({
      requestTimeoutMs: 50,
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Primary hangs longer than timeout budget
    harness.primaryProvider.delayMs = 100;

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Hi' }],
      },
    });

    expect(res.statusCode).toBe(504);
    const body = JSON.parse(res.body);
    expect(body.error.code).toBe('request_timeout');
  });

  it('streaming success with model alias', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'fast-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
        },
      ]),
    });
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'fast-coder',
        messages: [{ role: 'user', content: 'Stream hi' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: [DONE]');

    const records = harness.sink.getRecords();
    expect(records[0]?.stream).toBe(true);
    expect(records[0]?.requestedModel).toBe('fast-coder');
    expect(records[0]?.attemptCount).toBe(1);
  });

  it('streaming primary failure before first chunk triggers fallback to secondary', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-streamer',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Primary streaming fails before first chunk is emitted (headers not sent yet)
    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError(
      'Primary streaming failed to connect',
    );

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-streamer',
        messages: [{ role: 'user', content: 'Stream fallback' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.body).toContain('data: [DONE]');

    const records = harness.sink.getRecords();
    expect(records[0]?.provider).toBe('gemini-provider');
    expect(records[0]?.attemptCount).toBe(2);
    expect(records[0]?.success).toBe(true);
  });

  it('streaming failure AFTER first chunk does NOT switch providers mid-stream', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-streamer',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Primary yields chunk 1 (headers committed!), then fails mid-stream
    harness.primaryProvider.failAfterFirstChunk = new Error('Socket abruptly severed mid-stream');

    const app = await harness.createApp();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-streamer',
        messages: [{ role: 'user', content: 'Stream' }],
        stream: true,
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    // Emits mid-stream error event rather than switching providers
    expect(res.body).toContain('"type":"stream_error"');
    expect(res.body).not.toContain('data: [DONE]');

    const records = harness.sink.getRecords();
    expect(records[0]?.provider).toBe('qwen-provider'); // Stayed on primary
    expect(records[0]?.attemptCount).toBe(1);
    expect(records[0]?.success).toBe(false);
  });

  it('rate limiter counts only ONCE per client request even when fallback executes', async () => {
    const harness = setupTestHarness({
      rateLimitEnabled: true,
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    // Primary fails, fallback succeeds
    harness.primaryProvider.shouldFailWith = new RelayProviderUnavailableError('Primary down');

    const app = await harness.createApp();

    // First client request: 2 provider attempts internally, but 1 request against rate limiter
    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Req 1' }],
      },
    });

    expect(res1.statusCode).toBe(200);
    // Limit was 2; after 1 client request, remaining must be 1 (NOT 0!)
    expect(res1.headers['x-ratelimit-remaining']).toBe('1');

    // Second client request consumes remaining 1
    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Req 2' }],
      },
    });

    expect(res2.statusCode).toBe(200);
    expect(res2.headers['x-ratelimit-remaining']).toBe('0');

    // Third client request is rate limited (429)
    const res3 = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Req 3' }],
      },
    });

    expect(res3.statusCode).toBe(429);
  });

  it('cancellation during primary attempt halts execution and does not trigger fallback', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'resilient-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
          fallbacks: ['gemini-provider/gemini-2.5-flash'],
        },
      ]),
    });

    let rawRequest: { raw: { emit(event: string): void } } | undefined;
    const app = await harness.createApp();
    app.addHook('preHandler', async (req) => {
      rawRequest = req;
    });

    let fallbackAttempted = false;
    harness.fallbackProvider.chat = async () => {
      fallbackAttempted = true;
      throw new Error('Fallback should not be called!');
    };

    harness.primaryProvider.chat = async () => {
      // Simulate client disconnecting during primary execution
      rawRequest?.raw.emit('close');
      throw new Error('Connection closed by client');
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'resilient-coder',
        messages: [{ role: 'user', content: 'Cancel test' }],
      },
    });

    // Fallback must not have been attempted
    expect(fallbackAttempted).toBe(false);

    const records = harness.sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.statusCode).toBe(499);
    expect(records[0]?.errorCategory).toBe('cancelled');
    expect(records[0]?.attemptCount).toBe(1);
  });

  it('GET /v1/models lists configured logical aliases alongside concrete models', async () => {
    const harness = setupTestHarness({
      routingPolicies: JSON.stringify([
        {
          model: 'fast-coder',
          primary: 'qwen-provider/qwen3-coder-30b',
        },
      ]),
    });
    const app = await harness.createApp();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const modelIds = body.data.map((m: { id: string }) => m.id);

    expect(modelIds).toContain('qwen3-coder-30b');
    expect(modelIds).toContain('gemini-2.5-flash');
    expect(modelIds).toContain('fast-coder'); // Alias included

    // Single model lookup for alias
    const aliasRes = await app.inject({
      method: 'GET',
      url: '/v1/models/fast-coder',
    });
    expect(aliasRes.statusCode).toBe(200);
    const aliasBody = JSON.parse(aliasRes.body);
    expect(aliasBody.id).toBe('fast-coder');
    expect(aliasBody.owned_by).toBe('qwen-provider');
  });
});
