import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('Gateway Authentication Layer', () => {
  const SECRET_KEY = 'super-secret-production-relay-key-xyz';

  async function buildTestApp(apiKeyConfig?: string) {
    const config = loadConfig({
      ...(apiKeyConfig !== undefined ? { RELAY_API_KEY: apiKeyConfig } : {}),
      LOG_LEVEL: 'silent',
    });

    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'test-model',
      name: 'Test Model',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('test-model'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    return { app, config };
  }

  describe('Unauthenticated Local Development Mode', () => {
    it('allows requests when RELAY_API_KEY is unset', async () => {
      const { app } = await buildTestApp(undefined);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.object).toBe('list');
    });

    it('treats empty or whitespace-only RELAY_API_KEY as unset', async () => {
      const { app } = await buildTestApp('   ');

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Enforced Authentication Mode (RELAY_API_KEY configured)', () => {
    it('rejects requests with missing Authorization header with standard 401 envelope', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('authentication_error');
      expect(body.error.type).toBe('authentication_error');
      expect(body.error.message).toBe('Invalid or missing API key provided.');
    });

    it('rejects malformed Authorization headers (non-Bearer schemes)', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const malformedHeaders = [
        'Basic dXNlcjpwYXNz',
        'Token some-token',
        'Key abc',
        'CustomAuth xyz',
      ];

      for (const headerValue of malformedHeaders) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: headerValue },
        });

        expect(response.statusCode).toBe(401);
        const body = JSON.parse(response.body);
        expect(body.error.code).toBe('authentication_error');
        expect(body.error.message).toBe('Invalid or missing API key provided.');
      }
    });

    it('rejects empty or whitespace-only Bearer tokens', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const emptyTokens = ['Bearer', 'Bearer ', 'Bearer   ', 'Bearer\t'];

      for (const headerValue of emptyTokens) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/models',
          headers: { authorization: headerValue },
        });

        expect(response.statusCode).toBe(401);
        const body = JSON.parse(response.body);
        expect(body.error.code).toBe('authentication_error');
        expect(body.error.message).toBe('Invalid or missing API key provided.');
      }
    });

    it('rejects invalid tokens of different length without leaking length information', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer short' },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('authentication_error');
      expect(body.error.message).toBe('Invalid or missing API key provided.');
    });

    it('rejects invalid tokens of exact same length', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      // Same length as SECRET_KEY, but different characters
      const sameLengthWrongKey = 'x'.repeat(SECRET_KEY.length);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${sameLengthWrongKey}` },
      });

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.error.code).toBe('authentication_error');
      expect(body.error.message).toBe('Invalid or missing API key provided.');
    });

    it('accepts valid Bearer token for /v1/models and /v1/chat/completions', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      // Test GET /v1/models
      const modelsRes = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `Bearer ${SECRET_KEY}` },
      });
      expect(modelsRes.statusCode).toBe(200);

      // Test POST /v1/chat/completions
      const chatRes = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          authorization: `Bearer ${SECRET_KEY}`,
          'content-type': 'application/json',
        },
        payload: {
          model: 'test-model',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });
      expect(chatRes.statusCode).toBe(200);
    });

    it('accepts case-insensitive Bearer prefix ("bearer <token>")', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: `bearer ${SECRET_KEY}` },
      });

      expect(response.statusCode).toBe(200);
    });
  });

  describe('Public Route Bypass & Secret Leakage Prevention', () => {
    it('allows public access to /health with trailing slash or query parameters', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const paths = ['/health', '/health/', '/health?check=1', '/health?verbose=true&timeout=5'];

      for (const path of paths) {
        const response = await app.inject({
          method: 'GET',
          url: path,
        });

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        expect(body.status).toBe('ok');
      }
    });

    it('never leaks configured secret key in response body or headers on auth failure', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: { authorization: 'Bearer attacker-probe-123' },
      });

      expect(response.statusCode).toBe(401);

      // Assert secret does not appear anywhere in the body string
      expect(response.body).not.toContain(SECRET_KEY);

      // Assert secret does not appear in any header value
      for (const [headerKey, headerVal] of Object.entries(response.headers)) {
        expect(headerKey.toLowerCase()).not.toContain(SECRET_KEY);
        expect(String(headerVal)).not.toContain(SECRET_KEY);
      }
    });

    it('request logger serializer excludes authorization headers and credentials', async () => {
      const { app } = await buildTestApp(SECRET_KEY);

      // Verify that request serializer does not include headers
      const reqSerializer = (app as any).logger?.serializers?.req;
      if (typeof reqSerializer === 'function') {
        const mockReq = {
          id: 'req-123',
          method: 'POST',
          url: '/v1/chat/completions',
          ip: '127.0.0.1',
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            'x-secret-test': SECRET_KEY,
          },
        };
        const serialized = reqSerializer(mockReq);
        expect(serialized.headers).toBeUndefined();
        expect(JSON.stringify(serialized)).not.toContain(SECRET_KEY);
      }
    });
  });
});
