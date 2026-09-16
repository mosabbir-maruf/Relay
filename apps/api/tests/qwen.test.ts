import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { createRegistry } from '../src/server.js';
import { MockOpenAIServer } from './fixtures/mock-openai-server.js';

describe('Qwen Provider & Model Gateway Integration', () => {
  let mockVllmServer: MockOpenAIServer;

  beforeAll(async () => {
    mockVllmServer = new MockOpenAIServer();
    await mockVllmServer.start();
  });

  afterAll(async () => {
    await mockVllmServer.close();
  });

  beforeEach(() => {
    mockVllmServer.recordedRequests = [];
    mockVllmServer.delayMs = 0;
  });

  describe('A. Configuration Parsing', () => {
    it('parses Qwen configuration with default model when QWEN_MODEL is omitted', () => {
      const config = loadConfig({
        QWEN_BASE_URL: 'http://localhost:8000/v1',
      });

      expect(config.env.QWEN_BASE_URL).toBe('http://localhost:8000/v1');
      expect(config.env.QWEN_API_KEY).toBeUndefined();

      const qwenModels = config.defaultModels.filter((m) => m.provider === 'qwen');
      expect(qwenModels).toHaveLength(1);
      expect(qwenModels[0]?.id).toBe('qwen3-coder-30b');
      expect(qwenModels[0]?.capabilities.supportsStreaming).toBe(true);
    });

    it('parses custom QWEN_MODEL and optional QWEN_API_KEY', () => {
      const config = loadConfig({
        QWEN_BASE_URL: 'http://localhost:8000/v1',
        QWEN_MODEL: 'qwen3-coder-30b-custom',
        QWEN_API_KEY: 'test-qwen-token',
      });

      expect(config.env.QWEN_BASE_URL).toBe('http://localhost:8000/v1');
      expect(config.env.QWEN_API_KEY).toBe('test-qwen-token');
      expect(config.env.QWEN_MODEL).toBe('qwen3-coder-30b-custom');

      const qwenModels = config.defaultModels.filter((m) => m.provider === 'qwen');
      expect(qwenModels).toHaveLength(1);
      expect(qwenModels[0]?.id).toBe('qwen3-coder-30b-custom');
    });

    it('parses multiple models from QWEN_MODELS', () => {
      const config = loadConfig({
        QWEN_BASE_URL: 'http://localhost:8000/v1',
        QWEN_MODELS: 'qwen3-coder-30b, qwen2.5-coder-7b',
      });

      const qwenModels = config.defaultModels.filter((m) => m.provider === 'qwen');
      expect(qwenModels.map((m) => m.id)).toEqual(['qwen3-coder-30b', 'qwen2.5-coder-7b']);
    });

    it('does not register Qwen models when QWEN_BASE_URL is missing', () => {
      const config = loadConfig({
        QWEN_BASE_URL: '',
        QWEN_MODEL: 'qwen3-coder-30b',
      });

      expect(config.env.QWEN_BASE_URL).toBeUndefined();
      const qwenModels = config.defaultModels.filter((m) => m.provider === 'qwen');
      expect(qwenModels).toHaveLength(0);
    });

    it('rejects URLs with non-http/https protocols for SSRF safety', () => {
      expect(() =>
        loadConfig({
          QWEN_BASE_URL: 'ftp://localhost:8000/v1',
        }),
      ).toThrow('URL must use http: or https: protocol');

      expect(() =>
        loadConfig({
          GEMINI_BASE_URL: 'file:///etc/passwd',
        }),
      ).toThrow('URL must use http: or https: protocol');
    });

    it('parses extensible OpenAI-compatible backends from ADDITIONAL_PROVIDERS', () => {
      const additional = JSON.stringify([
        {
          id: 'deepseek',
          name: 'DeepSeek Inference',
          baseUrl: 'https://api.deepseek.com/v1',
          apiKey: 'test-deepseek-key',
          models: ['deepseek-coder', 'deepseek-chat'],
        },
      ]);

      const config = loadConfig({
        ADDITIONAL_PROVIDERS: additional,
      });

      expect(config.openAiCompatibleBackends).toHaveLength(1);
      expect(config.openAiCompatibleBackends[0]?.id).toBe('deepseek');
      expect(config.openAiCompatibleBackends[0]?.models).toEqual([
        'deepseek-coder',
        'deepseek-chat',
      ]);

      const deepseekModels = config.defaultModels.filter((m) => m.provider === 'deepseek');
      expect(deepseekModels).toHaveLength(2);
      expect(deepseekModels[0]?.id).toBe('deepseek-coder');
    });
  });

  describe('B. Provider Registry & Model Resolution', () => {
    it('registers qwen provider with OpenAICompatibleProvider and resolves model', () => {
      const config = loadConfig({
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });

      const registry = createRegistry(config);
      const qwenProvider = registry.getProvider('qwen');

      expect(qwenProvider).toBeDefined();
      expect(qwenProvider?.id).toBe('qwen');
      expect(qwenProvider?.name).toBe('Qwen');

      const binding = registry.getProviderForModel('qwen3-coder-30b');
      expect(binding.provider).toBe(qwenProvider);
      expect(binding.modelInfo.id).toBe('qwen3-coder-30b');
      expect(binding.modelInfo.provider).toBe('qwen');
    });

    it('does not register qwen provider in registry when QWEN_BASE_URL is omitted', () => {
      const config = loadConfig({});
      const registry = createRegistry(config);

      expect(registry.getProvider('qwen')).toBeUndefined();
      expect(() => registry.getProviderForModel('qwen3-coder-30b')).toThrowError(/not recognized/);
    });
  });

  describe('C. Model Discovery (GET /v1/models)', () => {
    it('exposes qwen3-coder-30b with owned_by: qwen and capabilities', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.object).toBe('list');

      const qwenModel = body.data.find((m: any) => m.id === 'qwen3-coder-30b');
      expect(qwenModel).toBeDefined();
      expect(qwenModel.owned_by).toBe('qwen');
      expect(qwenModel.capabilities.supportsStreaming).toBe(true);
      expect(qwenModel.capabilities.supportsToolCalling).toBe(true);
    });
  });

  describe('D. Non-Streaming Chat Completion', () => {
    it('routes request for qwen3-coder-30b to mock vLLM and returns normalized response', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'Reply with only the word PONG' }],
          temperature: 0,
          max_tokens: 10,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.object).toBe('chat.completion');
      expect(body.model).toBe('qwen3-coder-30b');
      expect(body.choices).toHaveLength(1);
      expect(body.choices[0].message.role).toBe('assistant');
      expect(typeof body.choices[0].message.content).toBe('string');
      expect(body.usage).toBeDefined();

      // Verify mock server received the request with correct path and no auth header
      expect(mockVllmServer.recordedRequests).toHaveLength(1);
      const recorded = mockVllmServer.recordedRequests[0];
      expect(recorded?.url).toContain('/chat/completions');
      expect(recorded?.body.model).toBe('qwen3-coder-30b');
      expect(recorded?.headers['authorization']).toBeUndefined();
    });

    it('attaches Bearer token to upstream request when QWEN_API_KEY is configured', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
        QWEN_API_KEY: 'secret-vllm-token',
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'Test' }],
        },
      });

      expect(res.statusCode).toBe(200);
      expect(mockVllmServer.recordedRequests).toHaveLength(1);
      expect(mockVllmServer.recordedRequests[0]?.headers['authorization']).toBe(
        'Bearer secret-vllm-token',
      );
    });
  });

  describe('E. Streaming Chat Completion (SSE)', () => {
    it('streams SSE chunks through Relay ending with data: [DONE]', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'Stream test' }],
          stream: true,
        },
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/event-stream');

      const raw = res.body;
      expect(raw).toContain('data: ');
      expect(raw).toContain('data: [DONE]');

      // Parse SSE chunks
      const lines = raw.split('\n\n').filter(Boolean);
      const dataLines = lines.map((line) => line.replace(/^data: /, '').trim());

      expect(dataLines[dataLines.length - 1]).toBe('[DONE]');
      const jsonChunks = dataLines.slice(0, -1).map((s) => JSON.parse(s));
      expect(jsonChunks.length).toBeGreaterThan(0);
      expect(jsonChunks[0].object).toBe('chat.completion.chunk');
      expect(jsonChunks[0].model).toBe('qwen3-coder-30b');
    });
  });

  describe('F. Error Normalization', () => {
    it('normalizes upstream 429 Rate Limit into RelayRateLimitError with 429 status', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'simulate_rate_limit' }],
        },
      });

      expect(res.statusCode).toBe(429);
      const body = res.json();
      expect(body.error.code).toBe('rate_limit_exceeded');
    });

    it('normalizes upstream 401 Unauthorized into RelayAuthenticationError with 401 status', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'simulate_auth_error' }],
        },
      });

      expect(res.statusCode).toBe(401);
      const body = res.json();
      expect(body.error.code).toBe('authentication_error');
    });

    it('normalizes upstream 500 into 502 Bad Gateway', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'simulate_upstream_500' }],
        },
      });

      expect(res.statusCode).toBe(502);
      const body = res.json();
      expect(body.error.code).toBe('provider_unavailable');
    });
  });

  describe('G. Cancellation & Timeout', () => {
    it('aborts and returns 504 Timeout when Qwen backend exceeds request timeout', async () => {
      const config = loadConfig({
        LOG_LEVEL: 'silent',
        REQUEST_TIMEOUT_MS: 50,
        QWEN_BASE_URL: mockVllmServer.baseUrl,
      });
      const registry = createRegistry(config);
      const app = await createApp({ config, registry, serverOptions: { logger: false } });

      mockVllmServer.delayMs = 200;

      const res = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        payload: {
          model: 'qwen3-coder-30b',
          messages: [{ role: 'user', content: 'timeout test' }],
        },
      });

      expect(res.statusCode).toBe(504);
      const body = res.json();
      expect(body.error.code).toBe('request_timeout');
    });
  });
});
