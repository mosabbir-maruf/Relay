import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

describe('Configuration & Security Hardening', () => {
  describe('ADDITIONAL_PROVIDERS Validation', () => {
    it('parses valid ADDITIONAL_PROVIDERS JSON into openAiCompatibleBackends', () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        ADDITIONAL_PROVIDERS: JSON.stringify([
          {
            id: 'groq',
            name: 'Groq Cloud',
            baseUrl: 'https://api.groq.com/openai/v1',
            apiKey: 'gsk-test',
            models: ['llama-3.3-70b-versatile'],
          },
        ]),
      });

      expect(config.openAiCompatibleBackends).toHaveLength(1);
      expect(config.openAiCompatibleBackends[0]?.id).toBe('groq');
      expect(config.openAiCompatibleBackends[0]?.name).toBe('Groq Cloud');
      expect(config.openAiCompatibleBackends[0]?.baseUrl).toBe('https://api.groq.com/openai/v1');
      expect(config.openAiCompatibleBackends[0]?.apiKey).toBe('gsk-test');
      expect(config.openAiCompatibleBackends[0]?.models).toEqual(['llama-3.3-70b-versatile']);
    });

    it('rejects duplicate provider IDs in ADDITIONAL_PROVIDERS', () => {
      expect(() =>
        loadConfig({
          LOG_LEVEL: 'silent',
          ADDITIONAL_PROVIDERS: JSON.stringify([
            {
              id: 'custom-provider',
              baseUrl: 'https://api1.example.com/v1',
              models: ['model-1'],
            },
            {
              id: 'custom-provider',
              baseUrl: 'https://api2.example.com/v1',
              models: ['model-2'],
            },
          ]),
        }),
      ).toThrow(/Duplicate provider id "custom-provider"/);
    });

    it('rejects collision with built-in provider IDs', () => {
      expect(() =>
        loadConfig({
          LOG_LEVEL: 'silent',
          QWEN_BASE_URL: 'https://qwen.example.com/v1',
          ADDITIONAL_PROVIDERS: JSON.stringify([
            {
              id: 'qwen',
              baseUrl: 'https://other-qwen.example.com/v1',
              models: ['model-q'],
            },
          ]),
        }),
      ).toThrow(/Duplicate provider id "qwen"/);
    });

    it('rejects cloud metadata URLs in ADDITIONAL_PROVIDERS', () => {
      expect(() =>
        loadConfig({
          LOG_LEVEL: 'silent',
          ADDITIONAL_PROVIDERS: JSON.stringify([
            {
              id: 'ssrf-attempt',
              baseUrl: 'http://169.254.169.254/latest/meta-data',
              models: ['bad-model'],
            },
          ]),
        }),
      ).toThrow(/cloud metadata/i);
    });

    it('rejects private IPs in ADDITIONAL_PROVIDERS when ENFORCE_PUBLIC_PROVIDERS is true', () => {
      expect(() =>
        loadConfig({
          LOG_LEVEL: 'silent',
          ENFORCE_PUBLIC_PROVIDERS: 'true',
          ADDITIONAL_PROVIDERS: JSON.stringify([
            {
              id: 'internal-vllm',
              baseUrl: 'http://192.168.1.100:8000/v1',
              models: ['internal-model'],
            },
          ]),
        }),
      ).toThrow(/targets a private or loopback destination/);
    });

    it('rejects non-array or invalid JSON for ADDITIONAL_PROVIDERS', () => {
      expect(() =>
        loadConfig({
          LOG_LEVEL: 'silent',
          ADDITIONAL_PROVIDERS: 'not-json',
        }),
      ).toThrow(/Invalid JSON format in ADDITIONAL_PROVIDERS/);

      expect(() =>
        loadConfig({
          LOG_LEVEL: 'silent',
          ADDITIONAL_PROVIDERS: JSON.stringify({ id: 'not-an-array' }),
        }),
      ).toThrow(/must be a JSON array/);
    });
  });

  describe('CORS_ORIGINS Configuration', () => {
    it('restricts CORS origin when CORS_ORIGINS is configured', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        CORS_ORIGINS: 'https://trusted-app.com,https://dashboard.example.com',
      });
      const registry = new ProviderRegistry();
      const app = await createApp({
        config,
        registry,
        serverOptions: { logger: false },
      });

      // Request from allowed origin
      const allowedRes = await app.inject({
        method: 'GET',
        url: '/health/liveness',
        headers: { origin: 'https://trusted-app.com' },
      });
      expect(allowedRes.headers['access-control-allow-origin']).toBe('https://trusted-app.com');

      // Request from unlisted origin should not receive allow-origin header matching the origin
      const disallowedRes = await app.inject({
        method: 'GET',
        url: '/health/liveness',
        headers: { origin: 'https://malicious-site.com' },
      });
      expect(disallowedRes.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('defaults to origin: true (reflecting request origin) when CORS_ORIGINS is unset', async () => {
      const config = loadConfig({ LOG_LEVEL: 'silent' });
      const registry = new ProviderRegistry();
      const app = await createApp({
        config,
        registry,
        serverOptions: { logger: false },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/health/liveness',
        headers: { origin: 'http://localhost:5173' },
      });
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
    });
  });
});
