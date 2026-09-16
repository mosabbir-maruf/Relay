import { describe, expect, it } from 'vitest';
import { RelayProviderUnavailableError, RelayRateLimitError } from '@relay/core';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('POST /v1/chat/completions', () => {
  it('handles non-streaming chat completion successfully', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
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
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'Hello Relay' }],
        temperature: 0.5,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe('chat.completion');
    expect(body.model).toBe('mock-model');
    expect(body.choices[0].message.role).toBe('assistant');
    expect(body.choices[0].message.content).toBe('Echo: Hello Relay');
    expect(body.choices[0].finish_reason).toBe('stop');
    expect(body.usage.total_tokens).toBe(15);
  });

  it('handles SSE streaming completion successfully', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
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
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');

    const rawText = response.body;
    expect(rawText).toContain('data: {"id":"mock-chunk-1"');
    expect(rawText).toContain('data: {"id":"mock-chunk-2"');
    expect(rawText).toContain('data: [DONE]');
  });

  it('propagates custom x-request-id and generates one if absent', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
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
      serverOptions: { logger: false },
    });

    // Custom request ID
    const customRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: {
        'x-request-id': 'custom-req-id-789',
      },
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(customRes.headers['x-request-id']).toBe('custom-req-id-789');

    // Generated request ID
    const generatedRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(typeof generatedRes.headers['x-request-id']).toBe('string');
    expect((generatedRes.headers['x-request-id'] as string).length).toBeGreaterThan(10);
  });

  it('rejects invalid request payloads with 400 Bad Request', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    // Missing model
    const noModelRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(noModelRes.statusCode).toBe(400);
    const body1 = JSON.parse(noModelRes.body);
    expect(body1.error.code).toBe('invalid_request');

    // Missing messages
    const noMessagesRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'any-model',
      },
    });
    expect(noMessagesRes.statusCode).toBe(400);

    // Unregistered model
    const unregisteredRes = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'unregistered-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });
    expect(unregisteredRes.statusCode).toBe(400);
  });

  it('normalizes upstream RelayRateLimitError with 429 and retry-after header', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.shouldFailWith = new RelayRateLimitError('Rate limit exceeded', {
      retryAfterSeconds: 60,
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
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('60');
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('rate_limit_exceeded');
  });

  it('aborts and returns 504 Timeout when upstream exceeds configured deadline', async () => {
    const config = loadConfig({
      REQUEST_TIMEOUT_MS: 50, // very tight deadline for test
      LOG_LEVEL: 'silent',
    });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.delayMs = 200; // Will exceed 50ms

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
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'hi' }],
      },
    });

    expect(response.statusCode).toBe(504);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('request_timeout');
  });

  it('propagates pre-stream errors with correct HTTP status instead of 200 SSE', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.shouldFailWith = new RelayRateLimitError('Streaming rate limit exceeded', {
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
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(429);
    expect(response.headers['retry-after']).toBe('30');
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('rate_limit_exceeded');
    expect(body.error.message).toContain('Streaming rate limit exceeded');
  });

  it('emits standard OpenAI SSE error payload if error occurs mid-stream', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.failAfterFirstChunk = new Error('Upstream socket terminated unexpectedly');

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
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      payload: {
        model: 'mock-model',
        messages: [{ role: 'user', content: 'stream please' }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.body).toContain('mock-chunk-1');
    expect(response.body).toContain('stream_error');
    expect(response.body).toContain('Upstream socket terminated unexpectedly');
  });

  it('normalizes upstream 502/unavailable errors with OpenAI error format', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    mockProvider.shouldFailWith = new RelayProviderUnavailableError(
      'Upstream backend is currently unreachable',
    );

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

    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('provider_unavailable');
    expect(body.error.message).toContain('Upstream backend is currently unreachable');
  });

  it('rejects payloads exceeding the 10MB limit with HTTP 413 Payload Too Large', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
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
      serverOptions: { logger: false },
    });

    // Create a payload > 10MB
    const largeContent = 'a'.repeat(10 * 1024 * 1024 + 1024);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({
        model: 'mock-model',
        messages: [{ role: 'user', content: largeContent }],
      }),
    });

    expect(response.statusCode).toBe(413);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('payload_too_large');
  });

  it('rejects malformed raw JSON request body with 400 Bad Request', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      payload: '{ "model": "mock-model", invalid json here }',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('invalid_request');
  });
});
