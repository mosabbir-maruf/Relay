import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { RelayAuthenticationError } from '@relay/core';

const AUTH_ERROR_MESSAGE = 'Invalid or missing API key provided.';

/**
 * Lightweight authentication preHandler hook.
 * Verifies Bearer token against configured static key using constant-time hashing.
 * Precomputes the expected key hash once at setup time to halve cryptographic hashing overhead per request.
 */
export function createAuthHook(expectedApiKey?: string) {
  const normalizedExpectedKey = expectedApiKey?.trim();
  const expectedKeyHash = normalizedExpectedKey
    ? createHash('sha256').update(normalizedExpectedKey).digest()
    : null;

  return async function authHook(request: FastifyRequest): Promise<void> {
    // If no API key is configured on the gateway, authentication is disabled (local dev mode)
    if (!expectedKeyHash) {
      return;
    }

    const authHeader = request.headers.authorization;
    if (!authHeader) {
      throw new RelayAuthenticationError(AUTH_ERROR_MESSAGE);
    }

    const providedKey = extractBearerToken(authHeader);
    if (!providedKey) {
      throw new RelayAuthenticationError(AUTH_ERROR_MESSAGE);
    }

    const providedKeyHash = createHash('sha256').update(providedKey).digest();
    if (!timingSafeEqual(providedKeyHash, expectedKeyHash)) {
      throw new RelayAuthenticationError(AUTH_ERROR_MESSAGE);
    }
  };
}

/**
 * Safely extracts the Bearer token from an Authorization header without regex.
 * Returns null if the header is missing, malformed, or contains whitespace within the token.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) {
    return null;
  }

  const trimmed = authHeader.trim();
  if (trimmed.length < 8 || trimmed.slice(0, 6).toLowerCase() !== 'bearer') {
    return null;
  }

  let tokenStart = 6;
  while (tokenStart < trimmed.length) {
    const code = trimmed.charCodeAt(tokenStart);
    if (code === 32 || code === 9 || code === 10 || code === 13) {
      tokenStart++;
    } else {
      break;
    }
  }

  // Must have at least one whitespace character after 'bearer' and non-empty token
  if (tokenStart === 6 || tokenStart >= trimmed.length) {
    return null;
  }

  const token = trimmed.slice(tokenStart);
  if (hasWhitespace(token)) {
    return null;
  }

  return token;
}

/**
 * Checks if a string contains any whitespace characters.
 */
function hasWhitespace(str: string): boolean {
  for (let i = 0; i < str.length; i++) {
    const code = str.charCodeAt(i);
    if (code <= 32 || code === 160) {
      return true;
    }
  }
  return false;
}
