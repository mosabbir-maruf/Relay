import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { RelayAuthenticationError } from '@relay/core';

const AUTH_ERROR_MESSAGE = 'Invalid or missing API key provided.';

/**
 * Lightweight authentication preHandler hook.
 * Verifies Bearer token against configured static key using constant-time hashing.
 */
export function createAuthHook(expectedApiKey?: string) {
  const normalizedExpectedKey = expectedApiKey?.trim();

  return async function authHook(request: FastifyRequest): Promise<void> {
    // If no API key is configured on the gateway, authentication is disabled (local dev mode)
    if (!normalizedExpectedKey) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      throw new RelayAuthenticationError(AUTH_ERROR_MESSAGE);
    }

    // Match "Bearer <token>" strictly (case-insensitive scheme, non-whitespace token)
    const match = /^Bearer\s+(\S+)$/i.exec(authHeader.trim());
    if (!match || !match[1]) {
      throw new RelayAuthenticationError(AUTH_ERROR_MESSAGE);
    }

    const providedKey = match[1];
    if (!safeCompare(providedKey, normalizedExpectedKey)) {
      throw new RelayAuthenticationError(AUTH_ERROR_MESSAGE);
    }
  };
}

/**
 * Constant-time comparison using fixed-length SHA-256 digests to prevent timing attacks
 * and eliminate key length leakage side-channels.
 */
function safeCompare(a: string, b: string): boolean {
  const hashA = createHash('sha256').update(a).digest();
  const hashB = createHash('sha256').update(b).digest();

  return timingSafeEqual(hashA, hashB);
}
