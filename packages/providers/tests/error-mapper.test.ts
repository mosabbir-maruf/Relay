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

  it('maps HTTP 530 with Error 1033 to CLOUDFLARE_TUNNEL_DISCONNECTED', () => {
    const cfHtml1033 = `
      <!DOCTYPE html>
      <html>
      <head><title>Argo Tunnel error | error code: 1033</title></head>
      <body>
        <h1>Error 1033</h1>
        <p>Argo Tunnel error</p>
        <p>The tunnel you requested does not exist or has disconnected.</p>
      </body>
      </html>
    `;

    const error = mapHttpStatusToRelayError({
      provider: 'vllm',
      status: 530,
      statusText: 'Origin DNS error',
      bodyText: cfHtml1033,
    });

    expect(error).toBeInstanceOf(RelayProviderUnavailableError);
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Cloudflare tunnel disconnected or inactive');
    expect(error.message).toContain('1033');
    expect(error.details).toEqual({
      provider: 'vllm',
      status: 530,
      code: 'CLOUDFLARE_TUNNEL_DISCONNECTED',
      cloudflareCode: '1033',
    });
  });

  it('maps generic HTTP 530 without 1033 to generic Cloudflare origin-resolution error', () => {
    const cfHtml1016 = `
      <!DOCTYPE html>
      <html>
      <head><title>Origin DNS error | error code: 1016</title></head>
      <body>
        <h1>Error 1016</h1>
        <p>Origin DNS error: DNS lookup failed.</p>
      </body>
      </html>
    `;

    const error = mapHttpStatusToRelayError({
      provider: 'vllm',
      status: 530,
      statusText: 'Origin DNS error',
      bodyText: cfHtml1016,
    });

    expect(error).toBeInstanceOf(RelayProviderUnavailableError);
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Cloudflare origin resolution error');
    expect(error.message).toContain('1016');
    expect(error.details).toEqual({
      provider: 'vllm',
      status: 530,
      code: 'CLOUDFLARE_ERROR_1016',
      cloudflareCode: '1016',
    });
  });

  it('maps generic HTTP 530 without any 1xxx code to CLOUDFLARE_ORIGIN_DNS_ERROR', () => {
    const error = mapHttpStatusToRelayError({
      provider: 'vllm',
      status: 530,
      statusText: 'Origin DNS error',
      bodyText: 'Plain origin error',
    });

    expect(error).toBeInstanceOf(RelayProviderUnavailableError);
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain('Cloudflare origin resolution error');
    expect(error.details).toEqual({
      provider: 'vllm',
      status: 530,
      code: 'CLOUDFLARE_ORIGIN_DNS_ERROR',
    });
  });

  it('redacts CLOUDFLARE_TUNNEL_TOKEN from error messages and details', () => {
    const secretToken = 'eyJhIjoiYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXoxMjM0NTYiLCJ0IjoiZGVmNDU2In0=';
    const jsonWithToken = JSON.stringify({
      error: {
        message: `Failed to connect with tunnel_token: ${secretToken}`,
        code: `token_${secretToken}`,
      },
    });

    const error = mapHttpStatusToRelayError({
      provider: 'vllm',
      status: 502,
      statusText: 'Bad Gateway',
      bodyText: jsonWithToken,
    });

    expect(error.message).not.toContain(secretToken);
    expect(error.message).toContain('[REDACTED]');
    expect(JSON.stringify(error.details)).not.toContain(secretToken);
  });
});
