import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ProviderRegistry } from '@relay/providers';

export interface HealthRoutesOptions {
  readonly registry: ProviderRegistry;
}

export function createHealthRoutes(options: HealthRoutesOptions): FastifyPluginAsync {
  return async function healthRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { refresh?: string } }>('/health', async (request, reply) => {
      const forceRefresh = request.query?.refresh === 'true';
      const providerHealth = await options.registry.healthCheck({
        forceRefresh,
        minIntervalMs: 2000,
      });
      const allHealthy = Object.values(providerHealth).every((h) => h.isHealthy);

      const statusCode = allHealthy ? 200 : 207; // 207 Multi-Status if any provider is degraded

      return reply.status(statusCode).send({
        status: allHealthy ? 'ok' : 'degraded',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        providers: providerHealth,
      });
    });

    app.get('/health/liveness', async (_request, reply) => {
      return reply.status(200).send({
        status: 'ok',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    });

    app.get('/health/readiness', async (_request, reply) => {
      const models = options.registry.listModels();
      if (models.length === 0) {
        return reply.status(503).send({
          status: 'not_ready',
          reason: 'No models configured or registered in gateway.',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          providers: {},
        });
      }

      const providerHealth = await options.registry.healthCheck();
      const providersList = Object.values(providerHealth);
      const isAnyHealthy = providersList.length > 0 && providersList.some((h) => h.isHealthy);

      if (!isAnyHealthy) {
        return reply.status(503).send({
          status: 'not_ready',
          reason: 'No healthy upstream providers available.',
          uptimeSeconds: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
          providers: providerHealth,
        });
      }

      return reply.status(200).send({
        status: 'ready',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        providers: providerHealth,
      });
    });
  };
}
