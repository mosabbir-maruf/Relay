import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { RelayInvalidRequestError } from '@relay/core';
import type { ModelRouter, ProviderRegistry } from '@relay/providers';

interface UpstreamModelSource {
  getUpstreamModel?(modelId: string): { id: string; max_model_len?: number } | undefined;
}

function getUpstreamMaxModelLen(provider: unknown, modelId: string): number | undefined {
  if (
    provider &&
    typeof provider === 'object' &&
    'getUpstreamModel' in provider &&
    typeof (provider as UpstreamModelSource).getUpstreamModel === 'function'
  ) {
    return (provider as UpstreamModelSource).getUpstreamModel!(modelId)?.max_model_len;
  }
  return undefined;
}

export interface ModelsRoutesOptions {
  readonly registry: ProviderRegistry;
  readonly router?: ModelRouter | undefined;
}

export function createModelsRoutes(options: ModelsRoutesOptions): FastifyPluginAsync {
  return async function modelsRoutes(app: FastifyInstance): Promise<void> {
    app.get('/v1/models', async (_request, reply) => {
      const models = options.registry.listModels();

      const data = models.map((model) => {
        const provider = options.registry.getProvider(model.provider);
        const caps = provider?.getCapabilities?.(model.id) ?? model.capabilities;
        const maxModelLen = getUpstreamMaxModelLen(provider, model.id) ?? model.max_model_len;

        return {
          id: model.id,
          object: 'model',
          created: model.created ?? 1726500000,
          owned_by: model.provider,
          capabilities: caps,
          ...(maxModelLen !== undefined ? { max_model_len: maxModelLen } : {}),
        };
      });

      if (options.router) {
        for (const policy of options.router.listPolicies()) {
          if (!data.some((d) => d.id === policy.model)) {
            try {
              const plan = options.router.resolvePlan(policy.model);
              const provider = plan.primary.provider;
              const caps =
                provider.getCapabilities?.(plan.primary.modelInfo.id) ??
                plan.primary.modelInfo.capabilities;
              const maxModelLen =
                getUpstreamMaxModelLen(provider, plan.primary.modelInfo.id) ??
                plan.primary.modelInfo.max_model_len;

              data.push({
                id: policy.model,
                object: 'model',
                created: plan.primary.modelInfo.created ?? 1726500000,
                owned_by: plan.primary.provider.id,
                capabilities: caps,
                ...(maxModelLen !== undefined ? { max_model_len: maxModelLen } : {}),
              });
            } catch {
              // Skip invalid alias configs
            }
          }
        }
      }

      return reply.status(200).send({
        object: 'list',
        data,
      });
    });

    app.get<{ Params: { '*': string } }>('/v1/models/*', async (request, reply) => {
      const rawModel = request.params['*'] ?? '';
      const model = decodeURIComponent(rawModel).trim();

      if (!model) {
        return reply.status(400).send({
          error: {
            message: 'Model parameter cannot be empty.',
            type: 'invalid_request_error',
            param: 'model',
            code: 'invalid_request',
          },
        });
      }

      try {
        if (options.router) {
          const plan = options.router.resolvePlan(model);
          const provider = plan.primary.provider;
          const caps =
            provider.getCapabilities?.(plan.primary.modelInfo.id) ??
            plan.primary.modelInfo.capabilities;
          const maxModelLen =
            getUpstreamMaxModelLen(provider, plan.primary.modelInfo.id) ??
            plan.primary.modelInfo.max_model_len;

          return reply.status(200).send({
            id: model,
            object: 'model',
            created: plan.primary.modelInfo.created ?? 1726500000,
            owned_by: plan.primary.provider.id,
            capabilities: caps,
            ...(maxModelLen !== undefined ? { max_model_len: maxModelLen } : {}),
          });
        }

        const { modelInfo, provider } = options.registry.getProviderForModel(model);
        const caps = provider.getCapabilities?.(modelInfo.id) ?? modelInfo.capabilities;
        const maxModelLen =
          getUpstreamMaxModelLen(provider, modelInfo.id) ?? modelInfo.max_model_len;

        return reply.status(200).send({
          id: model,
          object: 'model',
          created: modelInfo.created ?? 1726500000,
          owned_by: provider.id,
          capabilities: caps,
          ...(maxModelLen !== undefined ? { max_model_len: maxModelLen } : {}),
        });
      } catch (err) {
        if (
          err instanceof RelayInvalidRequestError &&
          err.message.toLowerCase().includes('ambiguous')
        ) {
          return reply.status(400).send({
            error: {
              message: err.message,
              type: 'invalid_request_error',
              param: 'model',
              code: 'ambiguous_model',
            },
          });
        }

        return reply.status(404).send({
          error: {
            message: `The model '${model}' does not exist or is not configured.`,
            type: 'invalid_request_error',
            param: 'model',
            code: 'model_not_found',
          },
        });
      }
    });
  };
}
