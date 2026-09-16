import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('GET /v1/models', () => {
  it('lists all registered models with capability metadata in OpenAI format', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    registry.registerProvider(mockProvider);

    registry.registerModel({
      id: 'test-model-1',
      name: 'Test Model 1',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('test-model-1'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.object).toBe('list');
    expect(body.data).toHaveLength(1);
    expect(body.data[0].id).toBe('test-model-1');
    expect(body.data[0].owned_by).toBe('mock-provider');
    expect(body.data[0].capabilities.supportsStreaming).toBe(true);
  });

  it('retrieves a single model by ID via GET /v1/models/:model', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    registry.registerProvider(mockProvider);

    registry.registerModel({
      id: 'test-model-1',
      name: 'Test Model 1',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('test-model-1'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models/test-model-1',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe('test-model-1');
    expect(body.object).toBe('model');
    expect(body.owned_by).toBe('mock-provider');
    expect(body.capabilities.supportsStreaming).toBe(true);
  });

  it('returns 404 for an unknown model via GET /v1/models/:model', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models/unknown-model',
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('model_not_found');
  });
});
