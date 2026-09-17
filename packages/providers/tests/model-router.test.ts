import { describe, expect, it } from 'vitest';
import type { LLMProvider, ModelInfo } from '@relay/core';
import { RelayInvalidRequestError } from '@relay/core';
import { ModelRouter, ProviderRegistry } from '../src/index.js';

function createMockProvider(id: string): LLMProvider {
  return {
    id,
    name: `Mock ${id}`,
    chat: async (req) => ({
      id: 'mock-resp',
      created: Date.now(),
      model: req.model,
      message: { role: 'assistant', content: `Echo from ${id}` },
      finishReason: 'stop',
    }),
    chatStream: async function* (req) {
      yield {
        id: 'mock-chunk',
        created: Date.now(),
        model: req.model,
        delta: { content: `Echo from ${id}` },
      };
    },
    getCapabilities: () => ({
      supportsStreaming: true,
      supportsToolCalling: false,
      supportsVision: false,
      supportsStructuredOutput: false,
      maxContextTokens: 4096,
      maxOutputTokens: 1024,
    }),
    healthCheck: async () => ({ isHealthy: true, latencyMs: 10, lastChecked: new Date() }),
  };
}

function setupRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  const qwen = createMockProvider('qwen');
  const gemini = createMockProvider('gemini');
  registry.registerProvider(qwen);
  registry.registerProvider(gemini);

  registry.registerModel({
    id: 'qwen3-coder-30b',
    name: 'Qwen 30B',
    provider: 'qwen',
    capabilities: qwen.getCapabilities('qwen3-coder-30b'),
  });

  registry.registerModel({
    id: 'gemini-2.5-flash',
    name: 'Gemini 2.5 Flash',
    provider: 'gemini',
    capabilities: gemini.getCapabilities('gemini-2.5-flash'),
  });

  return registry;
}

describe('ModelRouter', () => {
  it('preserves exact bare model resolution when no policies are configured', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({ registry });

    const plan = router.resolvePlan('qwen3-coder-30b');
    expect(plan.requestedModel).toBe('qwen3-coder-30b');
    expect(plan.primary.provider.id).toBe('qwen');
    expect(plan.primary.modelInfo.id).toBe('qwen3-coder-30b');
    expect(plan.fallbacks).toHaveLength(0);

    expect(plan.decision.provider).toBe('qwen');
    expect(plan.decision.model).toBe('qwen3-coder-30b');
    expect(plan.decision.fallbacks).toBeUndefined();
  });

  it('preserves qualified model resolution (provider/model)', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({ registry });

    const plan = router.resolvePlan('gemini/gemini-2.5-flash');
    expect(plan.requestedModel).toBe('gemini/gemini-2.5-flash');
    expect(plan.primary.provider.id).toBe('gemini');
    expect(plan.primary.modelInfo.id).toBe('gemini-2.5-flash');
    expect(plan.fallbacks).toHaveLength(0);
  });

  it('resolves logical model aliases to target models', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({
      registry,
      policies: [
        {
          model: 'fast-coder',
          primary: 'qwen/qwen3-coder-30b',
          fallbacks: ['gemini/gemini-2.5-flash'],
        },
      ],
    });

    expect(router.isAlias('fast-coder')).toBe(true);

    const plan = router.resolvePlan('fast-coder');
    expect(plan.requestedModel).toBe('fast-coder');
    expect(plan.primary.provider.id).toBe('qwen');
    expect(plan.primary.modelInfo.id).toBe('qwen3-coder-30b');

    // Fallbacks
    expect(plan.fallbacks).toHaveLength(1);
    expect(plan.fallbacks[0]!.provider.id).toBe('gemini');
    expect(plan.fallbacks[0]!.modelInfo.id).toBe('gemini-2.5-flash');

    expect(plan.decision.fallbacks).toEqual([{ provider: 'gemini', model: 'gemini-2.5-flash' }]);
  });

  it('resolves chained model aliases (alias-1 -> alias-2 -> target)', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({
      registry,
      policies: [
        { model: 'coding-assistant', primary: 'fast-coder' },
        { model: 'fast-coder', primary: 'qwen/qwen3-coder-30b' },
      ],
    });

    const plan = router.resolvePlan('coding-assistant');
    expect(plan.primary.provider.id).toBe('qwen');
    expect(plan.primary.modelInfo.id).toBe('qwen3-coder-30b');
  });

  it('detects and rejects alias cycles (A -> B -> A)', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({
      registry,
      policies: [
        { model: 'model-a', primary: 'model-b' },
        { model: 'model-b', primary: 'model-a' },
      ],
    });

    expect(() => router.resolvePlan('model-a')).toThrowError(RelayInvalidRequestError);
    expect(() => router.resolvePlan('model-a')).toThrow(/Routing policy cycle detected/);
  });

  it('detects and rejects self loops (A -> A)', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({
      registry,
      policies: [{ model: 'model-self', primary: 'model-self' }],
    });

    expect(() => router.resolvePlan('model-self')).toThrowError(RelayInvalidRequestError);
    expect(() => router.resolvePlan('model-self')).toThrow(/Routing policy cycle detected/);
  });

  it('rejects unknown models and aliases', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({ registry });

    expect(() => router.resolvePlan('unknown-model')).toThrowError(RelayInvalidRequestError);
  });

  it('deduplicates fallback targets and eliminates targets identical to primary', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({
      registry,
      policies: [
        {
          model: 'resilient-coder',
          primary: 'qwen/qwen3-coder-30b',
          fallbacks: [
            'qwen/qwen3-coder-30b', // duplicate of primary, should be excluded
            'gemini/gemini-2.5-flash',
            'gemini/gemini-2.5-flash', // duplicate fallback, should be excluded
          ],
        },
      ],
    });

    const plan = router.resolvePlan('resilient-coder');
    expect(plan.fallbacks).toHaveLength(1);
    expect(plan.fallbacks[0]!.provider.id).toBe('gemini');
  });

  it('enforces maximum 3 fallback targets', () => {
    const registry = setupRegistry();
    // Register extra dummy models for test
    const qwen = registry.getProvider('qwen')!;
    for (let i = 1; i <= 5; i++) {
      registry.registerModel({
        id: `qwen-fallback-${i}`,
        name: `Qwen Fallback ${i}`,
        provider: 'qwen',
        capabilities: qwen.getCapabilities('qwen3-coder-30b'),
      });
    }

    const router = new ModelRouter({
      registry,
      policies: [
        {
          model: 'many-fallbacks',
          primary: 'qwen/qwen3-coder-30b',
          fallbacks: [
            'qwen/qwen-fallback-1',
            'qwen/qwen-fallback-2',
            'qwen/qwen-fallback-3',
            'qwen/qwen-fallback-4',
            'qwen/qwen-fallback-5',
          ],
        },
      ],
    });

    const plan = router.resolvePlan('many-fallbacks');
    expect(plan.fallbacks).toHaveLength(3);
  });

  it('memoizes resolved routing plans and invalidates on registry mutation', () => {
    const registry = setupRegistry();
    const router = new ModelRouter({
      registry,
      policies: [{ model: 'cached-coder', primary: 'qwen3-coder-30b' }],
    });

    const plan1 = router.resolvePlan('cached-coder');
    const plan2 = router.resolvePlan('cached-coder');
    // Exact same cached reference (O(1) memoized return)
    expect(plan2).toBe(plan1);

    // Explicit cache clearing
    router.clearCache();
    const plan3 = router.resolvePlan('cached-coder');
    expect(plan3).not.toBe(plan1);
    expect(plan3.primary.modelInfo.id).toBe('qwen3-coder-30b');

    // Registering a new model in registry increments registry version and invalidates cache
    const qwen = registry.getProvider('qwen')!;
    registry.registerModel({
      id: 'new-model',
      name: 'New Model',
      provider: 'qwen',
      capabilities: qwen.getCapabilities('qwen3-coder-30b'),
    });

    const plan4 = router.resolvePlan('cached-coder');
    expect(plan4).not.toBe(plan3);
    expect(plan4.primary.modelInfo.id).toBe('qwen3-coder-30b');
  });
});
