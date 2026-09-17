import type {
  FallbackTarget,
  ModelRoutingRule,
  RoutingDecision,
  RoutingPolicy,
  RoutingRequest,
} from '@relay/core';
import { RelayInvalidRequestError } from '@relay/core';
import type { ModelProviderBinding, ProviderRegistry } from '../registry/provider-registry.js';

export interface ModelRouterOptions {
  readonly registry: ProviderRegistry;
  readonly policies?: readonly ModelRoutingRule[] | undefined;
}

export interface ResolvedRoutingPlan {
  readonly requestedModel: string;
  readonly primary: ModelProviderBinding;
  readonly fallbacks: readonly ModelProviderBinding[];
  readonly decision: RoutingDecision;
}

/**
 * Production-oriented model routing policy engine.
 * Decouples client model requests from concrete provider execution, supporting
 * logical model aliases, cycle detection, and fallback targets for retryable errors.
 */
export class ModelRouter implements RoutingPolicy {
  private readonly registry: ProviderRegistry;
  private readonly policies = new Map<string, ModelRoutingRule>();
  private readonly planCache = new Map<string, ResolvedRoutingPlan>();
  private lastObservedRegistryVersion = -1;

  constructor(options: ModelRouterOptions) {
    this.registry = options.registry;
    if (options.policies) {
      for (const rule of options.policies) {
        if (rule.model && rule.primary) {
          this.policies.set(rule.model.trim(), {
            model: rule.model.trim(),
            primary: rule.primary.trim(),
            fallbacks: rule.fallbacks?.map((f) => f.trim()).filter(Boolean),
          });
        }
      }
    }
  }

  /**
   * Implements the core RoutingPolicy contract.
   */
  resolve(request: RoutingRequest): RoutingDecision {
    return this.resolvePlan(request.requestedModel).decision;
  }

  /**
   * Clears the resolved routing plan cache.
   */
  clearCache(): void {
    this.planCache.clear();
  }

  /**
   * Resolves a model identifier into concrete provider-model bindings
   * for primary execution and ordered fallbacks.
   */
  resolvePlan(requestedModel: string): ResolvedRoutingPlan {
    const trimmedModel = requestedModel.trim();
    if (!trimmedModel) {
      throw new RelayInvalidRequestError('Missing required model identifier in routing request.');
    }

    // Invalidate plan cache if provider registry has been mutated
    const currentVersion = this.registry.getVersion();
    if (currentVersion !== this.lastObservedRegistryVersion) {
      this.planCache.clear();
      this.lastObservedRegistryVersion = currentVersion;
    } else {
      const cached = this.planCache.get(trimmedModel);
      if (cached) {
        return cached;
      }
    }

    // 1. Resolve alias chain with cycle detection
    const { finalTargetModel, initialRule } = this.resolveAliasChain(trimmedModel);

    // 2. Validate and resolve primary target against ProviderRegistry
    const primaryBinding = this.registry.getProviderForModel(finalTargetModel);

    // 3. Resolve fallback targets with deduplication and loop prevention
    const fallbackBindings: ModelProviderBinding[] = [];
    const fallbackTargets: FallbackTarget[] = [];
    const seenTargets = new Set<string>();

    // Mark primary target as seen to prevent duplicate execution
    const primaryKey = `${primaryBinding.provider.id}/${primaryBinding.modelInfo.id}`;
    seenTargets.add(primaryKey);

    if (initialRule?.fallbacks && Array.isArray(initialRule.fallbacks)) {
      for (const fallbackModelName of initialRule.fallbacks) {
        // Resolve fallback through alias chain if it is also an alias
        const { finalTargetModel: resolvedFallbackTarget } = this.resolveAliasChain(
          fallbackModelName,
          new Set([trimmedModel, fallbackModelName]),
        );

        try {
          const binding = this.registry.getProviderForModel(resolvedFallbackTarget);
          const targetKey = `${binding.provider.id}/${binding.modelInfo.id}`;

          // Avoid duplicate provider attempts and self-cycles
          if (seenTargets.has(targetKey)) {
            continue;
          }

          seenTargets.add(targetKey);
          fallbackBindings.push(binding);
          fallbackTargets.push({
            provider: binding.provider.id,
            model: binding.modelInfo.id,
          });

          // Enforce strict limit on fallbacks (maximum 3 attempts)
          if (fallbackBindings.length >= 3) {
            break;
          }
        } catch (err) {
          // If a configured fallback target is invalid or unconfigured, re-throw with context
          throw new RelayInvalidRequestError(
            `Configured fallback model "${fallbackModelName}" for model "${trimmedModel}" could not be resolved: ${err instanceof Error ? err.message : String(err)}`,
            { details: { requestedModel: trimmedModel, fallbackModel: fallbackModelName } },
          );
        }
      }
    }

    const decision: RoutingDecision = {
      requestedModel: trimmedModel,
      provider: primaryBinding.provider.id,
      model: primaryBinding.modelInfo.id,
      ...(fallbackTargets.length > 0 ? { fallbacks: fallbackTargets } : {}),
    };

    const plan: ResolvedRoutingPlan = {
      requestedModel: trimmedModel,
      primary: primaryBinding,
      fallbacks: fallbackBindings,
      decision,
    };

    this.planCache.set(trimmedModel, plan);
    return plan;
  }

  /**
   * Follows alias pointers to the terminal target model while detecting cycles.
   */
  private resolveAliasChain(
    startModel: string,
    initialVisited?: Set<string>,
  ): { finalTargetModel: string; initialRule: ModelRoutingRule | undefined } {
    const visited = initialVisited ?? new Set<string>();
    visited.add(startModel);

    let current = startModel;
    const initialRule = this.policies.get(startModel);

    while (this.policies.has(current)) {
      const nextTarget = this.policies.get(current)!.primary;
      if (visited.has(nextTarget)) {
        const cycle = [...visited, nextTarget].join(' -> ');
        throw new RelayInvalidRequestError(
          `Routing policy cycle detected for model "${startModel}": ${cycle}`,
          { details: { requestedModel: startModel, cycle } },
        );
      }
      visited.add(nextTarget);
      current = nextTarget;
    }

    return {
      finalTargetModel: current,
      initialRule,
    };
  }

  /**
   * Checks if an identifier is a configured logical alias.
   */
  isAlias(modelId: string): boolean {
    return this.policies.has(modelId.trim());
  }

  /**
   * Lists all configured routing policy rules.
   */
  listPolicies(): readonly ModelRoutingRule[] {
    return Array.from(this.policies.values());
  }
}
