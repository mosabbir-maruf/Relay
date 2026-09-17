import { describe, expect, it } from 'vitest';
import {
  RelayAuthenticationError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRateLimitError,
  RelayTimeoutError,
} from '@relay/core';
import { mapHttpStatusToRelayError } from '../src/http/error-mapper.js';

describe('Upstream Error Mapper Hardening', () => {
  it('never leaks arbitrary rawBody or sensitive credentials in details', () => {
    const sensitiveHtml =
      '<html><head><title>500 Internal Error</title></head><body>Authorization: Bearer secret-token-123456789\nCookie: session=xyz</body></html>';

    const error = mapHttpStatusToRelayError({
      provider: 'qwen',
      status: 502,
      statusText: 'Bad Gateway',
      bodyText: sensitiveHtml,
    });

    expect(error).toBeInstanceOf(RelayProviderUnavailableError);
    expect(error.statusCode).toBe(502);
    // details must NOT contain rawBody
    expect(error.details).toBeDefined();
    expect((error.details as any).rawBody).toBeUndefined();
    expect(JSON.stringify(error.details)).not.toContain('secret-token');
    expect(JSON.stringify(error.details)).not.toContain('Cookie');
    // Allowlist only contains provider and status
    expect(error.details).toEqual({
      provider: 'qwen',
      status: 502,
    });
  });

  it('drops arbitrary nested JSON keys (headers, internal db, debug info) from details', () => {
    const sensitiveJson = JSON.stringify({
      error: {
        message: 'Invalid API key provided: sk-proj-12345678901234567890',
        type: 'invalid_request_error',
        code: 'invalid_api_key',
        internal_stack: 'at /app/node_modules/...',
      },
      debug_info: {
        db_connection: 'postgres://admin:password@internal-db:5432/ai',
      },
      headers: {
        authorization: 'Bearer master-secret',
      },
    });

    const error = mapHttpStatusToRelayError({
      provider: 'openai-compatible',
      status: 401,
      statusText: 'Unauthorized',
      bodyText: sensitiveJson,
    });

    expect(error).toBeInstanceOf(RelayAuthenticationError);
    expect(error.statusCode).toBe(401);

    // Message must have redacted key
    expect(error.message).not.toContain('sk-proj-12345678901234567890');
    expect(error.message).toContain('[REDACTED]');

    // Details must NOT contain arbitrary fields
    const detailsStr = JSON.stringify(error.details);
    expect(detailsStr).not.toContain('postgres://');
    expect(detailsStr).not.toContain('master-secret');
    expect(detailsStr).not.toContain('internal_stack');
    expect(detailsStr).not.toContain('debug_info');

    // Safe details preserved
    expect(error.details).toEqual({
      provider: 'openai-compatible',
      status: 401,
      code: 'invalid_api_key',
      type: 'invalid_request_error',
    });
  });

  it('redacts Google Gemini API keys in error messages and maps status codes correctly', () => {
    const geminiJson = JSON.stringify({
      error: {
        code: 400,
        message:
          'API key not valid. Please pass a valid API key: AIzaSyD1234567890abcdefghijklmnop',
        status: 'INVALID_ARGUMENT',
      },
    });

    const error = mapHttpStatusToRelayError({
      provider: 'gemini',
      status: 400,
      statusText: 'Bad Request',
      bodyText: geminiJson,
    });

    expect(error).toBeInstanceOf(RelayInvalidRequestError);
    expect(error.statusCode).toBe(400);
    expect(error.message).not.toContain('AIzaSyD1234567890abcdefghijklmnop');
    expect(error.message).toContain('[REDACTED]');
    expect(error.details).toEqual({
      provider: 'gemini',
      status: 400,
      code: 'INVALID_ARGUMENT',
    });
  });

  it('correctly maps 429 with retry-after header to RelayRateLimitError', () => {
    const error = mapHttpStatusToRelayError({
      provider: 'qwen',
      status: 429,
      statusText: 'Too Many Requests',
      bodyText: JSON.stringify({ error: { message: 'Rate limit reached' } }),
      retryAfterHeader: '12',
    });

    expect(error).toBeInstanceOf(RelayRateLimitError);
    expect(error.statusCode).toBe(429);
    expect(error.retryAfterSeconds).toBe(12);
    expect(error.message).toBe('Rate limit reached');
  });

  it('correctly maps 504 to RelayTimeoutError', () => {
    const error = mapHttpStatusToRelayError({
      provider: 'qwen',
      status: 504,
      statusText: 'Gateway Timeout',
    });

    expect(error).toBeInstanceOf(RelayTimeoutError);
    expect(error.statusCode).toBe(504);
  });
});
