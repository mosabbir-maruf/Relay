import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { TestMockProvider } from './mock-provider.js';

describe('GET /health', () => {
  it('returns 200 OK and health status of gateway and registered providers', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider', 'Mock Provider');
    registry.registerProvider(mockProvider);

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(body.providers['mock-provider']?.isHealthy).toBe(true);
    expect(typeof body.uptimeSeconds).toBe('number');
  });
});
