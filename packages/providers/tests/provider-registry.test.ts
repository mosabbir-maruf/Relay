import { describe, expect, it } from 'vitest';
import type { LLMProvider, ProviderCapabilities, ProviderHealth } from '@relay/core';
import { RelayInvalidRequestError } from '@relay/core';
import { ProviderRegistry } from '../src/registry/provider-registry.js';

class MockTestProvider implements LLMProvider {
  constructor(
    public readonly id: string,
    public readonly name: string,
  ) {}

  getCapabilities(_model: string): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsVision: false,
      supportsStructuredOutput: true,
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      isHealthy: true,
      latencyMs: 10,
      lastChecked: new Date(),
    };
  }

  async chat(): Promise<any> {
    throw new Error('Not implemented in mock');
  }

  async *chatStream(): AsyncIterable<any> {}
}

describe('ProviderRegistry', () => {
  it('registers and retrieves providers and models correctly', () => {
    const registry = new ProviderRegistry();
    const provider1 = new MockTestProvider('prov-1', 'Provider One');
    registry.registerProvider(provider1);

    expect(registry.getProvider('prov-1')).toBe(provider1);

    registry.registerModel({
      id: 'model-a',
      name: 'Model A',
      provider: 'prov-1',
      capabilities: provider1.getCapabilities('model-a'),
    });

    const binding = registry.getProviderForModel('model-a');
    expect(binding.provider).toBe(provider1);
    expect(binding.modelInfo.id).toBe('model-a');

    const allModels = registry.listModels();
    expect(allModels).toHaveLength(1);
    expect(allModels[0]?.id).toBe('model-a');
  });

  it('throws RelayInvalidRequestError when requesting an unregistered model', () => {
    const registry = new ProviderRegistry();
    expect(() => registry.getProviderForModel('non-existent')).toThrow(RelayInvalidRequestError);
  });

  it('throws an error if registering a model for an unregistered provider', () => {
    const registry = new ProviderRegistry();
    expect(() =>
      registry.registerModel({
        id: 'model-b',
        name: 'Model B',
        provider: 'unregistered-provider',
        capabilities: {} as any,
      }),
    ).toThrow('has not been registered');
  });

  it('resolves models by qualified name "provider/model"', () => {
    const registry = new ProviderRegistry();
    const provider1 = new MockTestProvider('prov-1', 'Provider One');
    registry.registerProvider(provider1);
    registry.registerModel({
      id: 'model-a',
      name: 'Model A',
      provider: 'prov-1',
      capabilities: provider1.getCapabilities('model-a'),
    });

    const binding = registry.getProviderForModel('prov-1/model-a');
    expect(binding.provider).toBe(provider1);
    expect(binding.modelInfo.id).toBe('model-a');
  });

  it('detects model name collisions and requires qualified name resolution', () => {
    const registry = new ProviderRegistry();
    const prov1 = new MockTestProvider('prov-1', 'Provider One');
    const prov2 = new MockTestProvider('prov-2', 'Provider Two');
    registry.registerProvider(prov1);
    registry.registerProvider(prov2);

    registry.registerModel({
      id: 'common-model',
      name: 'Common Model 1',
      provider: 'prov-1',
      capabilities: prov1.getCapabilities('common-model'),
    });
    registry.registerModel({
      id: 'common-model',
      name: 'Common Model 2',
      provider: 'prov-2',
      capabilities: prov2.getCapabilities('common-model'),
    });

    // Bare model should throw RelayInvalidRequestError detailing ambiguity
    expect(() => registry.getProviderForModel('common-model')).toThrow(RelayInvalidRequestError);

    // Qualified names resolve cleanly
    const binding1 = registry.getProviderForModel('prov-1/common-model');
    expect(binding1.provider).toBe(prov1);

    const binding2 = registry.getProviderForModel('prov-2/common-model');
    expect(binding2.provider).toBe(prov2);

    // List models lists the qualified versions of ambiguous models
    const allModels = registry.listModels();
    expect(allModels.map((m) => m.id)).toContain('common-model');
  });

  it('caches health checks and supports forceRefresh', async () => {
    const registry = new ProviderRegistry();
    let callCount = 0;
    class CountingProvider extends MockTestProvider {
      override async healthCheck(): Promise<ProviderHealth> {
        callCount++;
        return super.healthCheck();
      }
    }
    registry.registerProvider(new CountingProvider('prov-1', 'One'));

    await registry.healthCheck();
    expect(callCount).toBe(1);

    // Second call within TTL should be served from cache
    await registry.healthCheck();
    expect(callCount).toBe(1);

    // forceRefresh should trigger a new check
    await registry.healthCheck({ forceRefresh: true });
    expect(callCount).toBe(2);
  });
});
