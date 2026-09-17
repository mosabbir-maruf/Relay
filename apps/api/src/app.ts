import cors from '@fastify/cors';
import fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import {
  InMemoryCircuitBreaker,
  InMemoryRateLimiter,
  InMemoryUsageSink,
  NoopCircuitBreaker,
  type CircuitBreaker,
  type RateLimiter,
  type UsageRecord,
  type UsageSink,
} from '@relay/core';
import { ModelRouter, type ProviderRegistry } from '@relay/providers';
import type { RelayConfig } from './config/index.js';
import { globalErrorHandler } from './errors/error-handler.js';
import { createAuthHook } from './hooks/auth.js';
import { createRateLimitHook } from './hooks/rate-limit.js';
import { registerRequestIdHook } from './hooks/request-id.js';
import { createChatRoutes } from './routes/chat.js';
import { createHealthRoutes } from './routes/health.js';
import { createModelsRoutes } from './routes/models.js';
import { createPlaygroundRoutes } from './routes/playground.js';
import { getNormalizedPath } from './utils/path.js';

export interface AppFactoryOptions {
  readonly config: RelayConfig;
  readonly registry: ProviderRegistry;
  readonly router?: ModelRouter | undefined;
  readonly usageSink?: UsageSink | undefined;
  readonly rateLimiter?: RateLimiter | undefined;
  readonly circuitBreaker?: CircuitBreaker | undefined;
  readonly serverOptions?: FastifyServerOptions;
}

/**
 * Application factory creating a configured Fastify instance.
 * Decoupled from network listeners for easy testing via app.inject().
 */
export async function createApp(options: AppFactoryOptions): Promise<FastifyInstance> {
  const usageSink = options.usageSink ?? new InMemoryUsageSink();
  const router =
    options.router ??
    new ModelRouter({
      registry: options.registry,
      policies: options.config.routingPolicies,
    });
  const rateLimiter =
    options.rateLimiter ??
    new InMemoryRateLimiter({
      windowMs: options.config.env.RATE_LIMIT_WINDOW_MS,
      maxRequests: options.config.env.RATE_LIMIT_MAX_REQUESTS,
      maxKeys: options.config.env.RATE_LIMIT_MAX_KEYS,
    });
  const circuitBreaker =
    options.circuitBreaker ??
    (options.config.env.CIRCUIT_BREAKER_ENABLED
      ? new InMemoryCircuitBreaker({
          failureThreshold: options.config.env.CIRCUIT_BREAKER_FAILURE_THRESHOLD,
          resetTimeoutMs: options.config.env.CIRCUIT_BREAKER_RESET_TIMEOUT_MS,
          halfOpenMaxRequests: options.config.env.CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS,
        })
      : new NoopCircuitBreaker());

  const loggerConfig = options.serverOptions?.logger ?? {
    level: options.config.env.LOG_LEVEL,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.ip,
        };
      },
    },
  };

  const trustProxy =
    options.serverOptions?.trustProxy !== undefined
      ? options.serverOptions.trustProxy
      : options.config.env.TRUST_PROXY;

  const app = fastify({
    logger: loggerConfig,
    disableRequestLogging: false,
    ignoreTrailingSlash: true,
    bodyLimit: 10 * 1024 * 1024,
    trustProxy,
    ...options.serverOptions,
  });

  // Enable CORS
  await app.register(cors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  });

  // Request ID tracking and header injection
  registerRequestIdHook(app);

  // Global standardized error handler
  app.setErrorHandler(globalErrorHandler);

  // Global Auth & Rate Limit hooks (skips public health check)
  const authHandler = createAuthHook(options.config.env.RELAY_API_KEY);
  const rateLimitHandler = createRateLimitHook({
    rateLimiter,
    enabled: options.config.env.RATE_LIMIT_ENABLED,
    keyStrategy: options.config.env.RATE_LIMIT_KEY_STRATEGY,
  });

  app.addHook('preHandler', async (request, reply) => {
    const normalizedPath = getNormalizedPath(request.url);
    if (
      normalizedPath === '/health' ||
      normalizedPath === '/playground' ||
      normalizedPath.startsWith('/playground/')
    ) {
      return;
    }
    await authHandler(request);
    await rateLimitHandler(request, reply);
  });

  // Fallback telemetry hook: captures early failures (e.g. 401 auth, 413 payload limit, 429 rate limit) outside chat handler
  app.addHook('onResponse', async (request, reply) => {
    const normalizedPath = getNormalizedPath(request.url);
    if (normalizedPath === '/v1/chat/completions' && request.method === 'POST') {
      const handledInRoute = Boolean(
        (request as { inChatHandler?: boolean }).inChatHandler ||
        (request.raw as { inChatHandler?: boolean }).inChatHandler,
      );

      if (!handledInRoute) {
        let errorCategory = 'internal_error';
        if (reply.statusCode === 401) {
          errorCategory = 'authentication_error';
        } else if (reply.statusCode === 413) {
          errorCategory = 'payload_too_large';
        } else if (reply.statusCode === 400) {
          errorCategory = 'invalid_request';
        } else if (reply.statusCode === 429) {
          errorCategory = 'rate_limit_exceeded';
        }

        const record: UsageRecord = {
          requestId: request.id,
          provider: 'unknown',
          model: 'unknown',
          stream: false,
          startedAt: new Date(Date.now() - Math.round(reply.elapsedTime)),
          durationMs: Math.round(reply.elapsedTime),
          statusCode: reply.statusCode,
          success: reply.statusCode >= 200 && reply.statusCode < 300,
          errorCategory,
        };

        usageSink.record(record);
        request.log.warn({ usageRecord: record }, 'Chat completion early failure usage recorded');
      }
    }
  });

  // Register core routes
  await app.register(createPlaygroundRoutes());
  await app.register(createHealthRoutes({ registry: options.registry }));
  await app.register(createModelsRoutes({ registry: options.registry, router }));
  await app.register(
    createChatRoutes({
      registry: options.registry,
      router,
      requestTimeoutMs: options.config.env.REQUEST_TIMEOUT_MS,
      usageSink,
      circuitBreaker,
    }),
  );

  return app;
}
