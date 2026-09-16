import { describe, expect, it } from 'vitest';
import { GeminiProvider, OpenAICompatibleProvider, ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';

const config = loadConfig();
const hasRealBackend = Boolean(config.env.OPENAI_COMPATIBLE_BASE_URL);

describe.skipIf(!hasRealBackend)(
  'Live OpenAI-Compatible Backend Verification (Runs only when OPENAI_COMPATIBLE_BASE_URL is configured)',
  () => {
    async function setupLiveGateway(customTimeoutMs?: number) {
      const activeConfig = loadConfig({
        LOG_LEVEL: 'silent',
        ...(customTimeoutMs ? { REQUEST_TIMEOUT_MS: customTimeoutMs } : {}),
      });

      const registry = new ProviderRegistry();

      // Register Gemini if configured
      if (activeConfig.env.GEMINI_API_KEY) {
        const gemini = new GeminiProvider({
          apiKey: activeConfig.env.GEMINI_API_KEY,
          baseUrl: activeConfig.env.GEMINI_BASE_URL,
        });
        registry.registerProvider(gemini);
      }

      // Register Real OpenAI-compatible provider
      const openAiProvider = new OpenAICompatibleProvider({
        id: 'openai-compatible',
        name: activeConfig.env.OPENAI_COMPATIBLE_NAME,
        baseUrl: activeConfig.env.OPENAI_COMPATIBLE_BASE_URL!,
        apiKey: activeConfig.env.OPENAI_COMPATIBLE_API_KEY,
      });
      registry.registerProvider(openAiProvider);

      for (const model of activeConfig.defaultModels) {
        if (registry.getProvider(model.provider)) {
          registry.registerModel(model);
        }
      }

      const app = await createApp({
        config: activeConfig,
        registry,
        serverOptions: { logger: false },
      });

      const testModel =
        activeConfig.defaultModels.find((m) => m.provider === 'openai-compatible')?.id ??
        'openai-compatible-default';

      return { app, registry, openAiProvider, testModel, activeConfig };
    }

    it('successfully connects to the real OpenAI-compatible backend health endpoint', async () => {
      const { openAiProvider } = await setupLiveGateway();
      const health = await openAiProvider.healthCheck();

      expect(typeof health.isHealthy).toBe('boolean');
      expect(typeof health.latencyMs).toBe('number');
      expect(health.lastChecked).toBeInstanceOf(Date);
    });

    it('lists the configured real backend model in GET /v1/models', async () => {
      const { app, testModel } = await setupLiveGateway();

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      const modelIds = data.data.map((m: any) => m.id);
      expect(modelIds).toContain(testModel);
    });

    it('performs a real non-streaming chat completion against the backend', async () => {
      const { app, testModel } = await setupLiveGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: testModel,
          messages: [{ role: 'user', content: 'Reply with only the word PONG' }],
          temperature: 0.0,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.object).toBe('chat.completion');
      expect(data.model).toBe(testModel);
      expect(data.choices).toBeInstanceOf(Array);
      expect(data.choices.length).toBeGreaterThan(0);
      expect(typeof data.choices[0].message.content).toBe('string');
      expect(data.choices[0].message.role).toBe('assistant');
      expect(data.usage).toBeDefined();
    });

    it('performs a real streaming chat completion (SSE) against the backend', async () => {
      const { app, testModel } = await setupLiveGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: testModel,
          messages: [{ role: 'user', content: 'Count from 1 to 3' }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');
      expect(response.body).toContain('data: ');
      expect(response.body).toContain('data: [DONE]');
    });

    it('respects request timeout against the real backend', async () => {
      // 1ms timeout is guaranteed to trigger timeout cancellation
      const { app, testModel } = await setupLiveGateway(1);

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: testModel,
          messages: [{ role: 'user', content: 'Write an essay about distributed systems' }],
        },
      });

      expect(response.statusCode).toBe(504);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('request_timeout');
    });

    it('normalizes unconfigured model request to 400 invalid_request error', async () => {
      const { app } = await setupLiveGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'unconfigured-model-xyz',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('invalid_request');
    });

    it('keeps Gemini fully functional concurrently with real OpenAI-compatible backend', async () => {
      const { app, activeConfig } = await setupLiveGateway();

      if (!activeConfig.env.GEMINI_API_KEY) {
        // Skip gemini coexistence assertion if Gemini key is not configured
        return;
      }

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'Reply with only the word PONG' }],
          temperature: 0.0,
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.model).toBe('gemini-2.5-flash');
      expect(data.choices[0].message.content).toContain('PONG');
    });
  },
);
