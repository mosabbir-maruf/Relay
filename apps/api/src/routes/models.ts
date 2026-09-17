import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { RelayInvalidRequestError } from '@relay/core';
import type { ModelRouter, ProviderRegistry } from '@relay/providers';

export interface ModelsRoutesOptions {
  readonly registry: ProviderRegistry;
  readonly router?: ModelRouter | undefined;
}

export function createModelsRoutes(options: ModelsRoutesOptions): FastifyPluginAsync {
  return async function modelsRoutes(app: FastifyInstance): Promise<void> {
    app.get('/v1/models', async (_request, reply) => {
      const models = options.registry.listModels();

      const data = models.map((model) => ({
        id: model.id,
        object: 'model',
        created: model.created ?? 1726500000,
        owned_by: model.provider,
        capabilities: model.capabilities,
      }));

      if (options.router) {
        for (const policy of options.router.listPolicies()) {
          if (!data.some((d) => d.id === policy.model)) {
            try {
              const plan = options.router.resolvePlan(policy.model);
              data.push({
                id: policy.model,
                object: 'model',
                created: plan.primary.modelInfo.created ?? 1726500000,
                owned_by: plan.primary.provider.id,
                capabilities: plan.primary.modelInfo.capabilities,
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
          return reply.status(200).send({
            id: model,
            object: 'model',
            created: plan.primary.modelInfo.created ?? 1726500000,
            owned_by: plan.primary.provider.id,
            capabilities: plan.primary.modelInfo.capabilities,
          });
        }

        const { modelInfo, provider } = options.registry.getProviderForModel(model);
        return reply.status(200).send({
          id: model,
          object: 'model',
          created: modelInfo.created ?? 1726500000,
          owned_by: provider.id,
          capabilities: modelInfo.capabilities,
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
