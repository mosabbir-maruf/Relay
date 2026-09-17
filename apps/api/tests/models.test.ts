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

  it('retrieves a qualified model with slash via GET /v1/models/provider/model', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('qwen');
    registry.registerProvider(mockProvider);

    registry.registerModel({
      id: 'qwen3-coder-30b',
      name: 'Qwen 3 Coder',
      provider: 'qwen',
      capabilities: mockProvider.getCapabilities('qwen3-coder-30b'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models/qwen/qwen3-coder-30b',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBe('qwen/qwen3-coder-30b');
    expect(body.owned_by).toBe('qwen');
  });

  it('returns 400 ambiguous_model when un-prefixed model exists on multiple providers', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const p1 = new TestMockProvider('p1');
    const p2 = new TestMockProvider('p2');
    registry.registerProvider(p1);
    registry.registerProvider(p2);

    registry.registerModel({
      id: 'shared-model',
      name: 'Shared Model P1',
      provider: 'p1',
      capabilities: p1.getCapabilities('shared-model'),
    });
    registry.registerModel({
      id: 'shared-model',
      name: 'Shared Model P2',
      provider: 'p2',
      capabilities: p2.getCapabilities('shared-model'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/models/shared-model',
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe('ambiguous_model');
  });

  it('exposes max_model_len in GET /v1/models when advertised or configured', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('vllm');
    registry.registerProvider(mockProvider);

    // Model with max_model_len extension
    registry.registerModel({
      id: 'gpt2',
      name: 'GPT-2',
      provider: 'vllm',
      capabilities: mockProvider.getCapabilities('gpt2'),
      max_model_len: 1024,
    });

    // Model without max_model_len
    registry.registerModel({
      id: 'standard-model',
      name: 'Standard Model',
      provider: 'vllm',
      capabilities: mockProvider.getCapabilities('standard-model'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/models',
    });

    expect(listRes.statusCode).toBe(200);
    const listBody = JSON.parse(listRes.body);
    const gpt2 = listBody.data.find((m: any) => m.id === 'gpt2');
    const standard = listBody.data.find((m: any) => m.id === 'standard-model');

    expect(gpt2).toBeDefined();
    expect(gpt2.max_model_len).toBe(1024);

    expect(standard).toBeDefined();
    expect(standard.max_model_len).toBeUndefined();

    // Test GET /v1/models/:model
    const singleRes = await app.inject({
      method: 'GET',
      url: '/v1/models/gpt2',
    });
    expect(singleRes.statusCode).toBe(200);
    const singleBody = JSON.parse(singleRes.body);
    expect(singleBody.id).toBe('gpt2');
    expect(singleBody.max_model_len).toBe(1024);
  });

  it('propagates upstream max_model_len discovered dynamically by provider', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();

    class DynamicUpstreamProvider extends TestMockProvider {
      getUpstreamModel(modelId: string) {
        if (modelId === 'llama-3') {
          return { id: 'llama-3', max_model_len: 8192 };
        }
        return undefined;
      }
    }

    const provider = new DynamicUpstreamProvider('dynamic-provider');
    registry.registerProvider(provider);

    registry.registerModel({
      id: 'llama-3',
      name: 'Llama 3',
      provider: 'dynamic-provider',
      capabilities: provider.getCapabilities('llama-3'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/models/llama-3',
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.id).toBe('llama-3');
    expect(body.max_model_len).toBe(8192);
  });
});
