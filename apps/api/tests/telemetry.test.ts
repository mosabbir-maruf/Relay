import { describe, expect, it } from 'vitest';
import { InMemoryUsageSink, RelayProviderUnavailableError, RelayRateLimitError } from '@relay/core';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('Relay Observability & Usage Telemetry', () => {
  it('captures normalized usage telemetry for successful non-streaming requests', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();
    const mockProvider = new TestMockProvider('mock-provider');

    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('mock-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-request-id': 'test-req-nonstream' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello world' }],
      },
    });

    expect(response.statusCode).toBe(200);

    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;

    expect(record.requestId).toBe('test-req-nonstream');
    expect(record.provider).toBe('mock-provider');
    expect(record.model).toBe('mock-model');
    expect(record.stream).toBe(false);
    expect(record.statusCode).toBe(200);
    expect(record.success).toBe(true);
    expect(record.promptTokens).toBe(10);
    expect(record.completionTokens).toBe(5);
    expect(record.totalTokens).toBe(15);
    expect(record.durationMs).toBeGreaterThanOrEqual(0);
    expect(record.startedAt).toBeInstanceOf(Date);
    expect(record.errorCategory).toBeUndefined();
  });

  it('captures normalized usage telemetry for successful streaming responses', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();
    const mockProvider = new TestMockProvider('mock-provider');

    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('mock-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'x-request-id': 'test-req-stream' },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Stream this' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;

    expect(record.requestId).toBe('test-req-stream');
    expect(record.provider).toBe('mock-provider');
    expect(record.model).toBe('mock-model');
    expect(record.stream).toBe(true);
    expect(record.statusCode).toBe(200);
    expect(record.success).toBe(true);
    expect(record.promptTokens).toBe(5);
    expect(record.completionTokens).toBe(2);
    expect(record.totalTokens).toBe(7);
    expect(record.errorCategory).toBeUndefined();
  });

  it('captures failure telemetry with normalized error category on provider errors', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.shouldFailWith = new RelayRateLimitError('Rate limit exceeded', {
      retryAfterSeconds: 30,
    });

    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('mock-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hello' }],
      },
    });

    expect(response.statusCode).toBe(429);

    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;

    expect(record.provider).toBe('mock-provider');
    expect(record.model).toBe('mock-model');
    expect(record.statusCode).toBe(429);
    expect(record.success).toBe(false);
    expect(record.errorCategory).toBe('rate_limit_exceeded');
  });

  it('captures failure telemetry on request timeouts (504)', async () => {
    const config = loadConfig({
      REQUEST_TIMEOUT_MS: 50,
      LOG_LEVEL: 'silent',
    });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.delayMs = 150;

    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('mock-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'slow request' }],
      },
    });

    expect(response.statusCode).toBe(504);

    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    const record = records[0]!;

    expect(record.statusCode).toBe(504);
    expect(record.success).toBe(false);
    expect(record.errorCategory).toBe('request_timeout');
  });

  it('accurately extracts arbitrary usage counts from provider responses', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.customUsage = {
      promptTokens: 128,
      completionTokens: 64,
      totalTokens: 192,
    };

    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('mock-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'calculate tokens' }],
      },
    });

    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.promptTokens).toBe(128);
    expect(records[0]?.completionTokens).toBe(64);
    expect(records[0]?.totalTokens).toBe(192);
  });

  it('gracefully handles missing usage metadata without errors', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.customUsage = null; // No usage metadata returned

    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'mock-model',
      name: 'Mock Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('mock-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    // Non-streaming with missing usage
    const nonStreamResp = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'no usage nonstream' }],
      },
    });
    expect(nonStreamResp.statusCode).toBe(200);

    // Streaming with missing usage
    const streamResp = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'no usage stream' }],
        stream: true,
      },
    });
    expect(streamResp.statusCode).toBe(200);

    const records = sink.getRecords();
    expect(records).toHaveLength(2);
    expect(records[0]?.promptTokens).toBeUndefined();
    expect(records[0]?.completionTokens).toBeUndefined();
    expect(records[0]?.totalTokens).toBeUndefined();
    expect(records[1]?.promptTokens).toBeUndefined();
  });

  it('captures telemetry across multiple different providers', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();

    const provA = new TestMockProvider('gemini-provider', 'Gemini');
    const provB = new TestMockProvider('qwen-provider', 'Qwen');

    registry.registerProvider(provA);
    registry.registerProvider(provB);

    registry.registerModel({
      id: 'gemini-model',
      name: 'Gemini Model',
      provider: 'gemini-provider',
      capabilities: provA.getCapabilities('gemini-model'),
    });

    registry.registerModel({
      id: 'qwen-model',
      name: 'Qwen Model',
      provider: 'qwen-provider',
      capabilities: provB.getCapabilities('qwen-model'),
    });

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'gemini-model',
        messages: [{ role: 'user', content: 'to gemini' }],
      },
    });

    await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'qwen-model',
        messages: [{ role: 'user', content: 'to qwen' }],
      },
    });

    const records = sink.getRecords();
    expect(records).toHaveLength(2);
    expect(records[0]?.provider).toBe('gemini-provider');
    expect(records[0]?.model).toBe('gemini-model');
    expect(records[1]?.provider).toBe('qwen-provider');
    expect(records[1]?.model).toBe('qwen-model');
  });

  it('captures early failure telemetry on unauthorized requests (401)', async () => {
    const config = loadConfig({
      RELAY_API_KEY: 'secret-key-123',
      LOG_LEVEL: 'silent',
    });
    const registry = new ProviderRegistry();
    const sink = new InMemoryUsageSink();

    const app = await createApp({
      config,
      registry,
      usageSink: sink,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        authorization: 'Bearer wrong-key',
      },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'unauthorized' }],
      },
    });

    expect(response.statusCode).toBe(401);

    const records = sink.getRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.statusCode).toBe(401);
    expect(records[0]?.success).toBe(false);
    expect(records[0]?.errorCategory).toBe('authentication_error');
  });

  describe('SSRF Protection Safeguards', () => {
    it('strictly rejects cloud metadata endpoints in provider URLs', () => {
      expect(() =>
        loadConfig({
          QWEN_BASE_URL: 'http://169.254.169.254/latest/meta-data',
        }),
      ).toThrow('cloud metadata endpoints');

      expect(() =>
        loadConfig({
          GEMINI_BASE_URL: 'http://metadata.google.internal/computeMetadata/v1',
        }),
      ).toThrow('cloud metadata endpoints');
    });

    it('rejects private/loopback URLs when ENFORCE_PUBLIC_PROVIDERS is enabled', () => {
      expect(() =>
        loadConfig({
          ENFORCE_PUBLIC_PROVIDERS: 'true',
          QWEN_BASE_URL: 'http://localhost:8000/v1',
        }),
      ).toThrow('targets a private or loopback destination');

      expect(() =>
        loadConfig({
          ENFORCE_PUBLIC_PROVIDERS: 'true',
          OPENAI_COMPATIBLE_BASE_URL: 'http://192.168.1.100:8000/v1',
        }),
      ).toThrow('targets a private or loopback destination');
    });

    it('allows loopback and local development URLs when ENFORCE_PUBLIC_PROVIDERS is false (default)', () => {
      const config = loadConfig({
        ENFORCE_PUBLIC_PROVIDERS: 'false',
        QWEN_BASE_URL: 'http://localhost:8000/v1',
      });

      expect(config.env.QWEN_BASE_URL).toBe('http://localhost:8000/v1');
    });
  });
});
