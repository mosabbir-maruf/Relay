import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GeminiProvider, OpenAICompatibleProvider, ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
import { MockGeminiServer } from './fixtures/mock-gemini-server.js';
import { MockOpenAIServer } from './fixtures/mock-openai-server.js';

describe('Multi-Provider Gateway Integration (Gemini + OpenAI-Compatible)', () => {
  let mockOpenAIServer: MockOpenAIServer;
  let mockGeminiServer: MockGeminiServer;

  beforeAll(async () => {
    mockOpenAIServer = new MockOpenAIServer();
    await mockOpenAIServer.start();

    mockGeminiServer = new MockGeminiServer();
    await mockGeminiServer.start();
  });

  afterAll(async () => {
    await mockOpenAIServer.close();
    await mockGeminiServer.close();
  });

  beforeEach(() => {
    mockOpenAIServer.recordedRequests = [];
    mockOpenAIServer.delayMs = 0;
    mockGeminiServer.recordedRequests = [];
    mockGeminiServer.delayMs = 0;
  });

  async function createTestGateway(customTimeoutMs = 10000) {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      REQUEST_TIMEOUT_MS: customTimeoutMs,
    });

    const registry = new ProviderRegistry();

    // Instantiate and register REAL GeminiProvider targeting mock Gemini HTTP server
    const geminiProvider = new GeminiProvider({
      apiKey: 'test-gemini-key',
      baseUrl: mockGeminiServer.baseUrl,
    });
    registry.registerProvider(geminiProvider);

    // Instantiate and register REAL OpenAICompatibleProvider targeting mock OpenAI HTTP server
    const openAIProvider = new OpenAICompatibleProvider({
      id: 'openai-compatible',
      name: 'OpenAI-Compatible Test Provider',
      baseUrl: mockOpenAIServer.baseUrl,
      apiKey: 'test-openai-key',
    });
    registry.registerProvider(openAIProvider);

    // Register multiple models under each provider to verify coexistence
    registry.registerModel({
      id: 'gemini-2.5-flash',
      name: 'Gemini 2.5 Flash',
      provider: 'gemini',
      capabilities: geminiProvider.getCapabilities('gemini-2.5-flash'),
    });

    registry.registerModel({
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      provider: 'gemini',
      capabilities: geminiProvider.getCapabilities('gemini-2.5-pro'),
    });

    registry.registerModel({
      id: 'mock-llama-3',
      name: 'Llama 3 8B Instruct',
      provider: 'openai-compatible',
      capabilities: openAIProvider.getCapabilities('mock-llama-3'),
    });

    registry.registerModel({
      id: 'mock-mistral-7b',
      name: 'Mistral 7B Instruct',
      provider: 'openai-compatible',
      capabilities: openAIProvider.getCapabilities('mock-mistral-7b'),
    });

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    return { app, registry, geminiProvider, openAIProvider };
  }

  describe('Model Resolution & Non-Streaming Execution', () => {
    it('routes Gemini model to GeminiProvider and returns normalized response', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'Say hello from Gemini' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.object).toBe('chat.completion');
      expect(data.model).toBe('gemini-2.5-flash');
      expect(data.choices[0].message.role).toBe('assistant');
      expect(data.choices[0].message.content).toContain(
        'Mock Gemini response: Say hello from Gemini',
      );
      expect(data.choices[0].finish_reason).toBe('stop');
      expect(data.usage.total_tokens).toBe(15);

      // Verify Gemini mock server received the request with query key
      expect(mockGeminiServer.recordedRequests).toHaveLength(1);
      const req = mockGeminiServer.recordedRequests[0]!;
      expect(req.url).toContain(
        '/v1beta/models/gemini-2.5-flash:generateContent?key=test-gemini-key',
      );
      expect(req.body.contents[0].parts[0].text).toBe('Say hello from Gemini');

      // OpenAI mock server should NOT have received anything
      expect(mockOpenAIServer.recordedRequests).toHaveLength(0);
    });

    it('routes OpenAI-compatible model to OpenAICompatibleProvider and returns normalized response', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-llama-3',
          messages: [{ role: 'user', content: 'Say hello from Llama' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.object).toBe('chat.completion');
      expect(data.model).toBe('mock-llama-3');
      expect(data.choices[0].message.role).toBe('assistant');
      expect(data.choices[0].message.content).toContain(
        'Mock OpenAI response: Say hello from Llama',
      );
      expect(data.choices[0].finish_reason).toBe('stop');
      expect(data.usage.total_tokens).toBe(20);

      // Verify OpenAI mock server received request with Authorization header
      expect(mockOpenAIServer.recordedRequests).toHaveLength(1);
      const req = mockOpenAIServer.recordedRequests[0]!;
      expect(req.url).toContain('/chat/completions');
      expect(req.headers['authorization']).toBe('Bearer test-openai-key');
      expect(req.body.messages[0].content).toBe('Say hello from Llama');

      // Gemini mock server should NOT have received anything
      expect(mockGeminiServer.recordedRequests).toHaveLength(0);
    });

    it('routes secondary OpenAI-compatible model to OpenAICompatibleProvider correctly', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-mistral-7b',
          messages: [{ role: 'user', content: 'Hello Mistral' }],
        },
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.model).toBe('mock-mistral-7b');
      expect(mockOpenAIServer.recordedRequests).toHaveLength(1);
      expect(mockOpenAIServer.recordedRequests[0]!.body.model).toBe('mock-mistral-7b');
    });
  });

  describe('Streaming Execution (SSE) for Both Providers', () => {
    it('streams SSE chunks from Gemini and ends with [DONE]', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'Stream test' }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      const body = response.body;
      expect(body).toContain('data: {"id":');
      expect(body).toContain('"delta":{"role":"assistant","content":"Mock Gemini "}');
      expect(body).toContain('"content":"streaming response"');
      expect(body).toContain('data: [DONE]\n\n');

      expect(mockGeminiServer.recordedRequests).toHaveLength(1);
      expect(mockGeminiServer.recordedRequests[0]!.url).toContain('streamGenerateContent');
    });

    it('streams SSE chunks from OpenAI-compatible provider and ends with [DONE]', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-llama-3',
          messages: [{ role: 'user', content: 'Stream test' }],
          stream: true,
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('text/event-stream');

      const body = response.body;
      expect(body).toContain('data: {"id":"chatcmpl-mock-chunk-1"');
      expect(body).toContain('"delta":{"role":"assistant","content":"Mock "}');
      expect(body).toContain('"delta":{"content":"streaming response"}');
      expect(body).toContain('data: [DONE]\n\n');

      expect(mockOpenAIServer.recordedRequests).toHaveLength(1);
      expect(mockOpenAIServer.recordedRequests[0]!.body.stream).toBe(true);
    });
  });

  describe('Provider-Specific Error Normalization', () => {
    it('normalizes OpenAI-compatible 429 to RelayRateLimitError with retry-after header', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-llama-3',
          messages: [{ role: 'user', content: 'simulate_rate_limit' }],
        },
      });

      expect(response.statusCode).toBe(429);
      expect(response.headers['retry-after']).toBe('30');
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('rate_limit_exceeded');
      expect(data.error.message).toContain('Rate limit reached');
    });

    it('normalizes OpenAI-compatible 401 to RelayAuthenticationError', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-llama-3',
          messages: [{ role: 'user', content: 'simulate_auth_error' }],
        },
      });

      expect(response.statusCode).toBe(401);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('authentication_error');
    });

    it('normalizes Gemini 429 to RelayRateLimitError', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'simulate_rate_limit' }],
        },
      });

      expect(response.statusCode).toBe(429);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('rate_limit_exceeded');
    });

    it('normalizes Gemini 400 to RelayInvalidRequestError', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'gemini-2.5-flash',
          messages: [{ role: 'user', content: 'simulate_invalid_request' }],
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('invalid_request');
    });
  });

  describe('Cancellation, Unknown Models & Model Listing', () => {
    it('aborts and returns 504 Timeout when upstream exceeds configured deadline', async () => {
      const { app } = await createTestGateway(50); // 50ms deadline
      mockOpenAIServer.delayMs = 200; // Will exceed deadline

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'mock-llama-3',
          messages: [{ role: 'user', content: 'Slow request' }],
        },
      });

      expect(response.statusCode).toBe(504);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('request_timeout');
    });

    it('rejects unknown model with 400 and lists available models', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'claude-3-opus',
          messages: [{ role: 'user', content: 'hi' }],
        },
      });

      expect(response.statusCode).toBe(400);
      const data = JSON.parse(response.body);
      expect(data.error.code).toBe('invalid_request');
      expect(data.error.message).toContain('Model "claude-3-opus" is not recognized');
      expect(data.error.message).toContain('gemini-2.5-flash');
      expect(data.error.message).toContain('mock-llama-3');
    });

    it('GET /v1/models returns every configured model across providers with capability metadata', async () => {
      const { app } = await createTestGateway();

      const response = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });

      expect(response.statusCode).toBe(200);
      const data = JSON.parse(response.body);
      expect(data.object).toBe('list');
      expect(data.data).toHaveLength(4);

      const modelIds = data.data.map((m: any) => m.id);
      expect(modelIds).toEqual(
        expect.arrayContaining([
          'gemini-2.5-flash',
          'gemini-2.5-pro',
          'mock-llama-3',
          'mock-mistral-7b',
        ]),
      );

      // Verify ownership and capabilities
      const geminiModel = data.data.find((m: any) => m.id === 'gemini-2.5-flash');
      expect(geminiModel.owned_by).toBe('gemini');
      expect(geminiModel.capabilities.supportsVision).toBe(true);

      const llamaModel = data.data.find((m: any) => m.id === 'mock-llama-3');
      expect(llamaModel.owned_by).toBe('openai-compatible');
      expect(llamaModel.capabilities.supportsStreaming).toBe(true);
    });
  });
});
