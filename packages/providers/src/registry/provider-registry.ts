import type { LLMProvider, ModelInfo, ProviderHealth } from '@relay/core';
import { RelayInvalidRequestError } from '@relay/core';

export interface ModelProviderBinding {
  readonly provider: LLMProvider;
  readonly modelInfo: ModelInfo;
}

/**
 * In-memory registry for LLM providers and model mappings.
 * Maps model IDs to concrete provider implementations without hardcoding.
 */
export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();
  private readonly modelsById = new Map<string, ModelInfo>();
  private readonly modelsByQualifiedName = new Map<string, ModelInfo>();
  private readonly ambiguousModelProviders = new Map<string, Set<string>>();

  // Cached health check state and in-flight coalescing to prevent upstream hammering
  private cachedHealth: Record<string, ProviderHealth> | null = null;
  private inFlightHealthCheck: Promise<Record<string, ProviderHealth>> | null = null;
  private lastHealthCheckTime = 0;
  private readonly healthCacheTtlMs = 15000;
  private registryVersion = 0;

  getVersion(): number {
    return this.registryVersion;
  }

  registerProvider(provider: LLMProvider): void {
    this.providers.set(provider.id, provider);
    this.cachedHealth = null;
    this.registryVersion++;
  }

  getProvider(providerId: string): LLMProvider | undefined {
    return this.providers.get(providerId);
  }

  registerModel(modelInfo: ModelInfo): void {
    if (!this.providers.has(modelInfo.provider)) {
      throw new Error(
        `Cannot register model "${modelInfo.id}": provider "${modelInfo.provider}" has not been registered.`,
      );
    }

    this.cachedHealth = null;
    this.registryVersion++;

    // Always register under qualified name: "provider/modelId"
    const qualifiedName = `${modelInfo.provider}/${modelInfo.id}`;
    this.modelsByQualifiedName.set(qualifiedName, modelInfo);

    // Track bare model ID and handle collisions
    const existing = this.modelsById.get(modelInfo.id);
    if (existing && existing.provider !== modelInfo.provider) {
      // Mark bare model ID as ambiguous
      let providers = this.ambiguousModelProviders.get(modelInfo.id);
      if (!providers) {
        providers = new Set<string>([existing.provider]);
        this.ambiguousModelProviders.set(modelInfo.id, providers);
      }
      providers.add(modelInfo.provider);
      // Remove from unambiguous bare map
      this.modelsById.delete(modelInfo.id);
    } else if (!this.ambiguousModelProviders.has(modelInfo.id)) {
      this.modelsById.set(modelInfo.id, modelInfo);
    }
  }

  getProviderForModel(modelId: string): ModelProviderBinding {
    // 1. Direct qualified name match (e.g. "qwen/qwen3-coder-30b")
    if (this.modelsByQualifiedName.has(modelId)) {
      const modelInfo = this.modelsByQualifiedName.get(modelId)!;
      const provider = this.providers.get(modelInfo.provider)!;
      return { provider, modelInfo };
    }

    // 2. Check for collision / ambiguity
    const ambiguousProviders = this.ambiguousModelProviders.get(modelId);
    if (ambiguousProviders && ambiguousProviders.size > 1) {
      const providerList = Array.from(ambiguousProviders).join(', ');
      throw new RelayInvalidRequestError(
        `Model "${modelId}" is ambiguous because it is provided by multiple providers: [${providerList}]. Please specify as "${Array.from(ambiguousProviders)[0]}/${modelId}".`,
        { details: { requestedModel: modelId, providers: Array.from(ambiguousProviders) } },
      );
    }

    // 3. Unambiguous bare model match
    const modelInfo = this.modelsById.get(modelId);
    if (!modelInfo) {
      const availableModels = this.listModels()
        .map((m) => m.id)
        .join(', ');
      throw new RelayInvalidRequestError(
        `Model "${modelId}" is not recognized or configured. Available models: [${availableModels}]`,
        { details: { requestedModel: modelId } },
      );
    }

    const provider = this.providers.get(modelInfo.provider);
    if (!provider) {
      throw new RelayInvalidRequestError(
        `Configured provider "${modelInfo.provider}" for model "${modelId}" was not found in registry.`,
        { details: { modelId, providerId: modelInfo.provider } },
      );
    }

    return { provider, modelInfo };
  }

  listModels(): ModelInfo[] {
    const unique = new Map<string, ModelInfo>();
    // Include all bare models
    for (const [id, m] of this.modelsById) {
      unique.set(id, m);
    }
    // For ambiguous models, list their qualified names so clients can see both
    for (const [qualified, m] of this.modelsByQualifiedName) {
      if (this.ambiguousModelProviders.has(m.id)) {
        unique.set(qualified, m);
      }
    }
    return Array.from(unique.values());
  }

  async healthCheck(options?: { forceRefresh?: boolean }): Promise<Record<string, ProviderHealth>> {
    const now = Date.now();
    if (
      !options?.forceRefresh &&
      this.cachedHealth &&
      now - this.lastHealthCheckTime < this.healthCacheTtlMs
    ) {
      return this.cachedHealth;
    }

    // Coalesce concurrent health check calls into a single in-flight Promise
    if (this.inFlightHealthCheck) {
      return this.inFlightHealthCheck;
    }

    this.inFlightHealthCheck = (async () => {
      try {
        const results: Record<string, ProviderHealth> = {};
        const checks = Array.from(this.providers.entries()).map(async ([id, provider]) => {
          try {
            const health = await provider.healthCheck();
            results[id] = health;
          } catch (err) {
            results[id] = {
              isHealthy: false,
              latencyMs: 0,
              lastChecked: new Date(),
              errorMessage: err instanceof Error ? err.message : String(err),
            };
          }
        });

        await Promise.all(checks);
        this.cachedHealth = results;
        this.lastHealthCheckTime = Date.now();
        return results;
      } finally {
        this.inFlightHealthCheck = null;
      }
    })();

    return this.inFlightHealthCheck;
  }
}
