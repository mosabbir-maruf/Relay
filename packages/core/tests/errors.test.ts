import { describe, expect, it } from 'vitest';
import {
  RelayAuthenticationError,
  RelayContextWindowExceededError,
  RelayError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRateLimitError,
  RelayTimeoutError,
  isRateLimitError,
  isRelayError,
} from '../src/index.js';

describe('RelayError Hierarchy', () => {
  it('correctly sets properties on RelayInvalidRequestError', () => {
    const error = new RelayInvalidRequestError('Missing model parameter', {
      details: { field: 'model' },
    });

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RelayError);
    expect(error).toBeInstanceOf(RelayInvalidRequestError);
    expect(error.name).toBe('RelayInvalidRequestError');
    expect(error.message).toBe('Missing model parameter');
    expect(error.code).toBe('invalid_request');
    expect(error.statusCode).toBe(400);
    expect(error.details).toEqual({ field: 'model' });
  });

  it('correctly sets properties on RelayAuthenticationError', () => {
    const error = new RelayAuthenticationError('Invalid API key provided');

    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe('authentication_error');
    expect(error.statusCode).toBe(401);
  });

  it('correctly sets properties on RelayRateLimitError including retryAfterSeconds', () => {
    const error = new RelayRateLimitError('Rate limit exceeded', {
      retryAfterSeconds: 30,
      details: { provider: 'gemini' },
    });

    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe('rate_limit_exceeded');
    expect(error.statusCode).toBe(429);
    expect(error.retryAfterSeconds).toBe(30);
    expect(error.details).toEqual({ provider: 'gemini' });
  });

  it('correctly sets properties on RelayContextWindowExceededError', () => {
    const error = new RelayContextWindowExceededError('Context length 40000 exceeds limit 32768');

    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe('context_window_exceeded');
    expect(error.statusCode).toBe(400);
  });

  it('correctly sets properties on RelayTimeoutError', () => {
    const error = new RelayTimeoutError('Request timed out after 60000ms');

    expect(error).toBeInstanceOf(RelayError);
    expect(error.code).toBe('request_timeout');
    expect(error.statusCode).toBe(504);
  });

  it('correctly sets properties on RelayProviderUnavailableError with custom 502/503 status', () => {
    const error502 = new RelayProviderUnavailableError('Bad gateway from upstream');
    expect(error502.statusCode).toBe(502);
    expect(error502.code).toBe('provider_unavailable');

    const error503 = new RelayProviderUnavailableError('Upstream service unavailable', {
      statusCode: 503,
    });
    expect(error503.statusCode).toBe(503);
    expect(error503.code).toBe('provider_unavailable');
  });

  it('preserves error cause when provided', () => {
    const originalError = new Error('Underlying network socket reset');
    const relayError = new RelayProviderUnavailableError('Provider failed to respond', {
      cause: originalError,
    });

    expect(relayError.cause).toBe(originalError);
  });

  it('formats to JSON correctly', () => {
    const error = new RelayRateLimitError('Quota exhausted', {
      retryAfterSeconds: 45,
      details: { quota: 'tokens_per_minute' },
    });

    const json = error.toJSON();
    expect(json).toEqual({
      name: 'RelayRateLimitError',
      message: 'Quota exhausted',
      code: 'rate_limit_exceeded',
      statusCode: 429,
      retryAfterSeconds: 45,
      details: { quota: 'tokens_per_minute' },
    });
  });

  it('formats to OpenAI error specification correctly', () => {
    const error = new RelayInvalidRequestError('Unrecognized parameter "foo"', {
      details: { unrecognized: ['foo'] },
    });

    const openAIError = error.toOpenAIError();
    expect(openAIError).toEqual({
      error: {
        message: 'Unrecognized parameter "foo"',
        type: 'invalid_request',
        code: 'invalid_request',
        param: null,
        details: { unrecognized: ['foo'] },
      },
    });
  });

  describe('Type Guards', () => {
    it('identifies RelayError instances correctly with isRelayError', () => {
      const relayError = new RelayInvalidRequestError('Test');
      const standardError = new Error('Test');
      const plainObject = { message: 'Test', code: 'test' };

      expect(isRelayError(relayError)).toBe(true);
      expect(isRelayError(standardError)).toBe(false);
      expect(isRelayError(plainObject)).toBe(false);
      expect(isRelayError(null)).toBe(false);
      expect(isRelayError(undefined)).toBe(false);
    });

    it('identifies RelayRateLimitError instances correctly with isRateLimitError', () => {
      const rateLimitError = new RelayRateLimitError('Rate limit');
      const authError = new RelayAuthenticationError('Auth');

      expect(isRateLimitError(rateLimitError)).toBe(true);
      expect(isRateLimitError(authError)).toBe(false);
      expect(isRateLimitError(new Error())).toBe(false);
    });
  });
});
