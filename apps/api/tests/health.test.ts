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

  it('debounces rapid refresh=true requests within 2s to prevent upstream probe storms', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    let healthChecks = 0;
    const mockProvider = new TestMockProvider('mock-provider', 'Mock Provider');
    mockProvider.healthCheck = async () => {
      healthChecks++;
      return { isHealthy: true, latencyMs: 5, lastChecked: new Date() };
    };
    registry.registerProvider(mockProvider);

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    // First request with refresh=true runs the health check
    const res1 = await app.inject({ method: 'GET', url: '/health?refresh=true' });
    expect(res1.statusCode).toBe(200);
    expect(healthChecks).toBe(1);

    // Immediate second request with refresh=true should be debounced and served from cache
    const res2 = await app.inject({ method: 'GET', url: '/health?refresh=true' });
    expect(res2.statusCode).toBe(200);
    expect(healthChecks).toBe(1);
  });

  it('returns 200 OK from GET /health/liveness without checking upstream providers', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/liveness',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.providers).toBeUndefined();
  });

  it('returns 200 ready from GET /health/readiness when providers and models are available', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider');
    registry.registerProvider(mockProvider);
    registry.registerModel({
      id: 'm1',
      name: 'M1',
      provider: 'mock-provider',
      capabilities: mockProvider.getCapabilities('m1'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/readiness',
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('ready');
  });

  it('returns 503 not_ready from GET /health/readiness when no models are registered', async () => {
    const config = loadConfig({ LOG_LEVEL: 'silent' });
    const registry = new ProviderRegistry();

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/health/readiness',
    });

    expect(response.statusCode).toBe(503);
    const body = JSON.parse(response.body);
    expect(body.status).toBe('not_ready');
  });
});
