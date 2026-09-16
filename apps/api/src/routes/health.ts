import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import type { ProviderRegistry } from '@relay/providers';

export interface HealthRoutesOptions {
  readonly registry: ProviderRegistry;
}

export function createHealthRoutes(options: HealthRoutesOptions): FastifyPluginAsync {
  return async function healthRoutes(app: FastifyInstance): Promise<void> {
    app.get<{ Querystring: { refresh?: string } }>('/health', async (request, reply) => {
      const forceRefresh = request.query?.refresh === 'true';
      const providerHealth = await options.registry.healthCheck({ forceRefresh });
      const allHealthy = Object.values(providerHealth).every((h) => h.isHealthy);

      const statusCode = allHealthy ? 200 : 207; // 207 Multi-Status if any provider is degraded

      return reply.status(statusCode).send({
        status: allHealthy ? 'ok' : 'degraded',
        uptimeSeconds: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        providers: providerHealth,
      });
    });
  };
}
