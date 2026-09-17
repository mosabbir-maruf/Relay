import { createHash } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { RelayRateLimitError, type RateLimiter } from '@relay/core';
import { getNormalizedPath } from '../utils/path.js';
import { extractBearerToken } from './auth.js';

export type RateLimitKeyStrategy = 'client_or_ip' | 'client_only' | 'ip_only';

export interface RateLimitHookOptions {
  readonly rateLimiter: RateLimiter;
  readonly enabled: boolean;
  readonly keyStrategy?: RateLimitKeyStrategy | undefined;
}

/**
 * Resolves an anonymized, collision-resistant rate limit key from the request.
 * Never stores or exposes raw authorization tokens in limiter state or logs.
 */
export function resolveRateLimitKey(
  request: FastifyRequest,
  strategy: RateLimitKeyStrategy = 'client_or_ip',
): string {
  const ip = request.ip || 'unknown-ip';

  if (strategy === 'ip_only') {
    return `ip:${ip}`;
  }

  const token = extractBearerToken(request.headers.authorization);
  if (token) {
    // Cryptographically hash the token to prevent credential exposure in limiter state
    const tokenHash = createHash('sha256').update(token).digest('hex').slice(0, 16);
    return `client:${tokenHash}`;
  }

  return `ip:${ip}`;
}

/**
 * Creates a Fastify preHandler hook for provider-agnostic rate limiting.
 * Protects gateway compute and upstream quotas while exempting health checks.
 */
export function createRateLimitHook(options: RateLimitHookOptions) {
  const { rateLimiter, enabled, keyStrategy = 'client_or_ip' } = options;

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!enabled) {
      return;
    }

    const normalizedPath = getNormalizedPath(request.url);

    // Exempt operational health check endpoints from rate limiting
    if (normalizedPath === '/health') {
      return;
    }

    const key = resolveRateLimitKey(request, keyStrategy);
    const decision = await rateLimiter.check({ key });

    // Expose standard rate limit headers on all evaluated responses
    reply.header('x-ratelimit-limit', String(decision.limit));
    reply.header('x-ratelimit-remaining', String(decision.remaining));
    if (decision.resetAt !== undefined) {
      reply.header('x-ratelimit-reset', String(Math.ceil(decision.resetAt / 1000)));
    }

    if (!decision.allowed) {
      const retryAfter = decision.retryAfterSeconds ?? 1;
      reply.header('retry-after', String(retryAfter));

      request.log.warn(
        {
          key,
          limit: decision.limit,
          remaining: 0,
          retryAfter,
        },
        'Rate limit exceeded for request',
      );

      throw new RelayRateLimitError(
        `Rate limit exceeded. Please retry after ${retryAfter} seconds.`,
        {
          retryAfterSeconds: retryAfter,
          details: {
            limit: decision.limit,
            remaining: 0,
            retryAfterSeconds: retryAfter,
          },
        },
      );
    }
  };
}
