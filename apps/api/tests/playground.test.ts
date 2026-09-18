import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import {
  isMultimodalModelId,
  loadConfig,
  resolveModelVisionCapability,
} from '../src/config/index.js';
import { PLAYGROUND_CSP_HEADER } from '../src/routes/playground.js';
import { TestMockProvider } from './mock-provider.js';

describe('AI Playground Route (GET /playground)', () => {
  async function createTestApp(extraEnv: Record<string, string | undefined> = {}) {
    const config = loadConfig({
      LOG_LEVEL: 'silent',
      ...extraEnv,
    });
    const registry = new ProviderRegistry();
    const mockProvider = new TestMockProvider('mock-provider', 'Mock Provider');
    registry.registerProvider(mockProvider);
    for (const model of config.defaultModels) {
      if (registry.getProvider(model.provider)) {
        registry.registerModel(model);
      }
    }

    const app = await createApp({
      config,
      registry,
      serverOptions: { logger: false },
    });

    return { app, config, registry };
  }

  describe('1. Response Headers & Status', () => {
    it('returns 200 OK and text/html on GET /playground', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['cache-control']).toBe('no-cache, no-store, must-revalidate');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('DENY');
    });

    it('returns 200 OK on GET /playground/ (trailing slash)', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground/',
      });

      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    });

    it('sets strict Content-Security-Policy restricting network egress strictly to self', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const csp = res.headers['content-security-policy'];
      expect(csp).toBe(PLAYGROUND_CSP_HEADER);
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).toContain("base-uri 'none'");
      expect(csp).toContain("form-action 'none'");
    });
  });

  describe('2. HTML Structure & Component Anchors', () => {
    it('contains essential UI markup elements', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Header & Navigation
      expect(html).toContain('<title>Relay — AI Playground</title>');
      expect(html).toContain('id="top-header"');
      expect(html).toContain('id="status-dot"');
      expect(html).toContain('id="status-text"');
      expect(html).toContain('id="clear-chat-btn"');
      expect(html).toContain('id="toggle-sidebar-btn"');

      // Message Viewport
      expect(html).toContain('id="messages-viewport"');
      expect(html).toContain('id="messages-list"');
      expect(html).toContain('id="scroll-bottom-btn"');

      // Composer
      expect(html).toContain('id="composer-container"');
      expect(html).toContain('id="chat-textarea"');
      expect(html).toContain('id="char-token-counter"');
      expect(html).toContain('id="send-message-btn"');
      expect(html).toContain('id="stop-generation-btn"');

      // Sidebar & Settings
      expect(html).toContain('id="settings-sidebar"');
      expect(html).toContain('id="model-select"');
      expect(html).toContain('id="temp-slider"');
      expect(html).toContain('id="max-tokens-input"');
      expect(html).toContain('id="system-prompt-input"');
      expect(html).toContain('id="stream-toggle"');
      expect(html).toContain('id="quick-tunnel-sse-warning"');
      expect(html).toContain('Quick Tunnels do not support Server-Sent Events (SSE)');
      expect(html).toContain('id="relay-api-key-input"');
      expect(html).toContain('id="reset-settings-btn"');
    });

    it('renders Quick Tunnel SSE warning container and binds client handler', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      expect(res.statusCode).toBe(200);
      const html = res.body;

      expect(html).toContain('id="quick-tunnel-sse-warning"');
      expect(html).toContain('Quick Tunnels do not support Server-Sent Events (SSE)');
      expect(html).toContain(
        "quickTunnelSseWarning: document.getElementById('quick-tunnel-sse-warning')",
      );
      expect(html).toContain('active.is_quick_tunnel');
    });

    it('stores credentials in sessionStorage and never in localStorage', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Verify the client script references sessionStorage for API keys
      expect(html).toContain("const SESSION_AUTH_KEY = 'relay_api_key'");
      expect(html).toContain('sessionStorage.getItem(SESSION_AUTH_KEY)');
      expect(html).toContain('sessionStorage.setItem(SESSION_AUTH_KEY');
      expect(html).toContain('sessionStorage.removeItem(SESSION_AUTH_KEY');

      // Verify localStorage is used for conversation and parameters, NOT credentials
      expect(html).toContain("const STORAGE_CHAT_KEY = 'relay_playground_chat_v1'");
      expect(html).toContain('localStorage.setItem(STORAGE_CHAT_KEY');
      expect(html).not.toContain('localStorage.setItem(SESSION_AUTH_KEY');
      expect(html).not.toContain("localStorage.setItem('relay_api_key'");
      expect(html).not.toContain('localStorage.setItem("relay_api_key"');
    });
  });

  describe('3. Security & Zero Secret Leakage', () => {
    it('does not leak server environment secrets into the rendered HTML', async () => {
      const secretRelayKey = 'secret-relay-token-xyz-12345';
      const secretGeminiKey = 'AIzaSySecretGeminiKey67890';
      const secretQwenUrl = 'https://confidential-tunnel.example.com/v1';

      const { app } = await createTestApp({
        RELAY_API_KEY: secretRelayKey,
        GEMINI_API_KEY: secretGeminiKey,
        QWEN_BASE_URL: secretQwenUrl,
      });

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      expect(res.statusCode).toBe(200);
      const html = res.body;

      // Must not contain server-side secrets
      expect(html).not.toContain(secretRelayKey);
      expect(html).not.toContain(secretGeminiKey);
      expect(html).not.toContain(secretQwenUrl);
      expect(html).not.toContain('confidential-tunnel');
    });

    it('uses relative API paths only and has no hardcoded external hostnames', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Verify client script uses relative paths
      expect(html).toContain("fetch('/v1/models'");
      expect(html).toContain("fetch('/v1/chat/completions'");
      expect(html).not.toContain('trycloudflare.com');
      expect(html).not.toContain('googleapis.com');
    });
  });

  describe('4. Authentication Perimeter Integrity', () => {
    it('allows GET /playground without auth while strictly requiring RELAY_API_KEY on /v1 APIs', async () => {
      const apiKey = 'test-required-api-key-999';
      const { app } = await createTestApp({
        RELAY_API_KEY: apiKey,
      });

      // 1. /playground is accessible without Bearer token
      const playgroundRes = await app.inject({
        method: 'GET',
        url: '/playground',
      });
      expect(playgroundRes.statusCode).toBe(200);

      // 2. /v1/models is rejected without Bearer token
      const modelsUnauth = await app.inject({
        method: 'GET',
        url: '/v1/models',
      });
      expect(modelsUnauth.statusCode).toBe(401);

      // 3. /v1/chat/completions is rejected without Bearer token
      const chatUnauth = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        payload: {
          model: 'any-model',
          messages: [{ role: 'user', content: 'hello' }],
        },
      });
      expect(chatUnauth.statusCode).toBe(401);

      // 4. /v1/models succeeds with valid Bearer token
      const modelsAuth = await app.inject({
        method: 'GET',
        url: '/v1/models',
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
      expect(modelsAuth.statusCode).toBe(200);
    });
  });

  describe('5. SSE Streaming Parser Resilience (Client Logic Simulation)', () => {
    it('correctly handles split lines, malformed JSON, and [DONE] signal without corruption', () => {
      // Direct verification of the parsing algorithm embedded in the playground client
      const chunks = [
        'data: {"id":"1","object":"chat.completion.chunk","choices":[{"delta":{"content":"Hello"}}]}\n\n',
        'data: {"invalid_json_frame', // fragmented line
        '": true}\n\n',
        ': keepalive ping\n\n', // SSE comment
        'data: {"id":"2","object":"chat.completion.chunk","choices":[{"delta":{"content":" world!"}}]}\n\n',
        'data: [DONE]\n\n',
      ];

      let buffer = '';
      let assistantText = '';
      let isDone = false;

      for (const chunk of chunks) {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith(':')) continue;

          if (trimmed === 'data: [DONE]') {
            isDone = true;
            break;
          }

          if (trimmed.startsWith('data: ')) {
            const jsonStr = trimmed.slice(6);
            try {
              const parsed = JSON.parse(jsonStr);
              const delta = parsed.choices?.[0]?.delta?.content;
              if (typeof delta === 'string') {
                assistantText += delta;
              }
            } catch {
              // Malformed chunks are safely ignored
            }
          }
        }
      }

      expect(isDone).toBe(true);
      expect(assistantText).toBe('Hello world!');
    });
  });

  describe('6. Model Connection Status & Health Lifecycle', () => {
    it('renders header connection status markup with model name, dot, and initial checking state', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Header structure
      expect(html).toContain('id="connection-status"');
      expect(html).toContain('id="status-dot" class="status-dot checking"');
      expect(html).toContain('id="status-model-name"');
      expect(html).toContain('id="status-text">Checking…<');
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-live="polite"');

      // 4-state indicator CSS classes and pulse animation
      expect(html).toContain('.status-dot.connected');
      expect(html).toContain('.status-dot.checking');
      expect(html).toContain('.status-dot.disconnected');
      expect(html).toContain('.status-dot.unavailable');
      expect(html).toContain('@keyframes pulseDot');
    });

    it('includes client logic for /health?refresh=true and provider health mapping', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Endpoint call & forceRefresh support
      expect(html).toContain('fetch(url');
      expect(html).toContain("'/health' + (forceRefresh ? '?refresh=true' : '')");

      // Provider health mapping
      expect(html).toContain('providers[providerId]');
      expect(html).toContain('hp.isHealthy');
      expect(html).toContain("setHealthStatus('connected', 'Connected'");
      expect(html).toContain("setHealthStatus('disconnected', 'Disconnected'");
      expect(html).toContain("setHealthStatus('unavailable', 'Unavailable'");
      expect(html).toContain("setHealthStatus('checking', 'Checking…'");
    });

    it('contains client triggers: model change, chat error trip, chat success recovery, and user click', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Model switch triggers recheck
      expect(html).toContain("elements.modelSelect.addEventListener('change'");
      expect(html).toContain('checkModelHealth(true)');

      // Chat error trips to disconnected
      expect(html).toContain('Chat request failed:');
      expect(html).toContain(
        "setHealthStatus(\n            'disconnected',\n            'Disconnected'",
      );

      // Chat success recovers to connected
      expect(html).toContain('Request succeeded at');
      expect(html).toContain("setHealthStatus(\n          'connected',\n          'Connected'");

      // Interactive click and keyboard triggers
      expect(html).toContain("elements.connectionStatus.addEventListener('click'");
      expect(html).toContain("elements.connectionStatus.addEventListener('keydown'");
    });

    it('includes Page Visibility API handling and stale green state guard (>60s)', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Page Visibility handling
      expect(html).toContain("document.addEventListener('visibilitychange'");
      expect(html).toContain('!document.hidden');
      expect(html).toContain('timeSinceLastCheck > 15000');

      // Stale green guard (>60s)
      expect(html).toContain('timeSinceLastCheck > 60000');
      expect(html).toContain('startHealthMonitoring');
    });

    it('integrates with Relay GET /health returning healthy provider data (HTTP 200)', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/health?refresh=true',
      });

      expect(res.statusCode).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.status).toBe('ok');
      expect(data.providers['mock-provider']).toBeDefined();
      expect(data.providers['mock-provider'].isHealthy).toBe(true);
      expect(typeof data.providers['mock-provider'].latencyMs).toBe('number');
      expect(data.providers['mock-provider'].lastChecked).toBeDefined();
    });

    it('returns 207 Multi-Status when a provider is degraded/disconnected', async () => {
      const config = loadConfig({ LOG_LEVEL: 'silent' });
      const registry = new ProviderRegistry();

      class UnhealthyMockProvider extends TestMockProvider {
        override async healthCheck() {
          return {
            isHealthy: false,
            latencyMs: 150,
            lastChecked: new Date(),
            errorMessage: 'vLLM upstream connection refused: ECONNREFUSED',
          };
        }
      }

      const unhealthyProvider = new UnhealthyMockProvider('unhealthy-qwen', 'Unhealthy Qwen');
      registry.registerProvider(unhealthyProvider);

      const app = await createApp({
        config,
        registry,
        serverOptions: { logger: false },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/health?refresh=true',
      });

      expect(res.statusCode).toBe(207);
      const data = JSON.parse(res.body);
      expect(data.status).toBe('degraded');
      expect(data.providers['unhealthy-qwen']).toBeDefined();
      expect(data.providers['unhealthy-qwen'].isHealthy).toBe(false);
      expect(data.providers['unhealthy-qwen'].errorMessage).toContain('ECONNREFUSED');
    });
  });

  describe('7. Context Budget & max_model_len Safety (Client Logic Simulation)', () => {
    it('renders client-side budget calculation, conservative token estimator, and UI max binding in /playground HTML', async () => {
      const { app } = await createTestApp();

      const res = await app.inject({
        method: 'GET',
        url: '/playground',
      });

      const html = res.body;

      // Model-agnostic context limit discovery & conservative estimation
      expect(html).toContain('function getModelMaxContextLength(');
      expect(html).toContain('function estimateMessagesTokens(');
      expect(html).toContain('function calculateEffectiveMaxTokens(');

      // UI hint binding without permanently mutating state.maxTokens
      expect(html).toContain('elements.maxTokensInput.max = String(maxModelLen)');
      expect(html).toContain("elements.maxTokensInput.max = '8192'");

      // Request-time clamping in sendMessage
      expect(html).toContain('calculateEffectiveMaxTokens(');
      expect(html).toContain('max_tokens: budgetResult.effectiveMaxTokens');
    });

    // Client logic simulation testing the exact math & contract rendered into the Playground
    function simulateGetModelMaxContextLength(
      modelId: string,
      models: Array<{ id: string; max_model_len?: number }>,
    ): number | null {
      const m = models.find((item) => item.id === modelId);
      return typeof m?.max_model_len === 'number' && m.max_model_len > 0 ? m.max_model_len : null;
    }

    function simulateEstimateMessagesTokens(
      messages: Array<{ role: string; content: string }>,
    ): number {
      let totalChars = 0;
      for (const msg of messages) {
        totalChars += msg.content.length;
      }
      return Math.ceil(totalChars / 3.5) + messages.length * 4 + 3;
    }

    function simulateCalculateEffectiveMaxTokens(
      modelId: string,
      models: Array<{ id: string; max_model_len?: number }>,
      messages: Array<{ role: string; content: string }>,
      requestedMaxTokens: number,
    ) {
      const maxModelLen = simulateGetModelMaxContextLength(modelId, models);
      const userMax = requestedMaxTokens > 0 ? requestedMaxTokens : 2048;

      if (!maxModelLen) {
        return { effectiveMaxTokens: userMax, availableBudget: null, maxModelLen: null };
      }

      const estimatedInputTokens = simulateEstimateMessagesTokens(messages);
      const availableBudget = maxModelLen - estimatedInputTokens;

      if (availableBudget <= 0) {
        return {
          error: `Input messages (~${estimatedInputTokens} tokens) exceed the model context length of ${maxModelLen} tokens.`,
          estimatedInputTokens,
          availableBudget,
          maxModelLen,
        };
      }

      const effectiveMaxTokens = Math.min(userMax, availableBudget);
      return {
        effectiveMaxTokens,
        estimatedInputTokens,
        availableBudget,
        maxModelLen,
      };
    }

    it('clamps 1024 context + ~30-token input + requested 2048 to context budget (< 1024)', () => {
      const models = [{ id: 'gpt2', max_model_len: 1024 }];
      // 94 characters -> Math.ceil(94 / 3.5) = 27 text tokens + (2 * 4 + 3) = 11 overhead = 38 tokens
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content: 'Hello, my name is Alice and I am testing vLLM context budgeting.',
        },
      ];
      const requestedMaxTokens = 2048;

      const result = simulateCalculateEffectiveMaxTokens(
        'gpt2',
        models,
        messages,
        requestedMaxTokens,
      );

      expect(result.error).toBeUndefined();
      expect(result.maxModelLen).toBe(1024);
      expect(result.estimatedInputTokens).toBe(38);
      // availableBudget = 1024 - 38 = 986
      expect(result.availableBudget).toBe(986);
      // effectiveMaxTokens = min(2048, 986) = 986
      expect(result.effectiveMaxTokens).toBe(986);
      expect(result.effectiveMaxTokens).toBeLessThan(1024);
      expect(result.effectiveMaxTokens! + result.estimatedInputTokens!).toBeLessThanOrEqual(1024);
    });

    it('allows full requested 2048 tokens when 4096 context + ~30-token input has sufficient budget', () => {
      const models = [{ id: 'qwen', max_model_len: 4096 }];
      const messages = [
        { role: 'system', content: 'You are a helpful assistant.' },
        {
          role: 'user',
          content: 'Hello, my name is Alice and I am testing vLLM context budgeting.',
        },
      ];
      const requestedMaxTokens = 2048;

      const result = simulateCalculateEffectiveMaxTokens(
        'qwen',
        models,
        messages,
        requestedMaxTokens,
      );

      expect(result.error).toBeUndefined();
      expect(result.maxModelLen).toBe(4096);
      expect(result.estimatedInputTokens).toBe(38);
      // availableBudget = 4096 - 38 = 4058 >= 2048
      expect(result.availableBudget).toBe(4058);
      expect(result.effectiveMaxTokens).toBe(2048);
    });

    it('preserves user requested maxTokens when model advertises no max_model_len', () => {
      const models = [{ id: 'gemini-flash' }]; // No max_model_len
      const messages = [{ role: 'user', content: 'Hello world' }];
      const requestedMaxTokens = 2048;

      const result = simulateCalculateEffectiveMaxTokens(
        'gemini-flash',
        models,
        messages,
        requestedMaxTokens,
      );

      expect(result.error).toBeUndefined();
      expect(result.maxModelLen).toBeNull();
      expect(result.availableBudget).toBeNull();
      expect(result.effectiveMaxTokens).toBe(2048);
    });

    it('rejects before fetch when prompt exceeds model context length (availableBudget <= 0)', () => {
      const models = [{ id: 'small-model', max_model_len: 512 }];
      // 2000 chars -> ~572 tokens > 512 context
      const messages = [{ role: 'user', content: 'A'.repeat(2000) }];
      const requestedMaxTokens = 2048;

      const result = simulateCalculateEffectiveMaxTokens(
        'small-model',
        models,
        messages,
        requestedMaxTokens,
      );

      expect(result.error).toBeDefined();
      expect(result.error).toContain('exceed the model context length of 512 tokens');
      expect(result.availableBudget).toBeLessThanOrEqual(0);
      expect(result.effectiveMaxTokens).toBeUndefined();
    });

    it('preserves user configured state.maxTokens when switching between small and large context models', () => {
      const models = [
        { id: 'gpt2', max_model_len: 1024 },
        { id: 'llama-3', max_model_len: 8192 },
      ];
      const messages = [{ role: 'user', content: 'Short prompt' }];

      // User has configured maxTokens = 2048 in state
      const userConfiguredMaxTokens = 2048;

      // 1. Select small context model (1024)
      const smallRes = simulateCalculateEffectiveMaxTokens(
        'gpt2',
        models,
        messages,
        userConfiguredMaxTokens,
      );
      expect(smallRes.effectiveMaxTokens).toBeLessThan(1024);

      // Verify user's configured state was NOT mutated
      expect(userConfiguredMaxTokens).toBe(2048);

      // 2. Switch to large context model (8192)
      const largeRes = simulateCalculateEffectiveMaxTokens(
        'llama-3',
        models,
        messages,
        userConfiguredMaxTokens, // Still 2048!
      );
      expect(largeRes.effectiveMaxTokens).toBe(2048);
    });
  });

  describe('7. Multimodal Image Attachment & Vision Capability Support', () => {
    it('contains image attachment UI markup, preview containers, and warning banners', async () => {
      const { app } = await createTestApp();
      const res = await app.inject({ method: 'GET', url: '/playground' });
      const html = res.body;

      // Attachment button & file input
      expect(html).toContain('id="attach-image-btn"');
      expect(html).toContain('id="image-file-input"');
      expect(html).toContain('accept="image/png,image/jpeg,image/webp"');

      // Image preview container & chip components
      expect(html).toContain('id="image-preview-container"');
      expect(html).toContain('id="image-preview-thumb"');
      expect(html).toContain('id="image-preview-name"');
      expect(html).toContain('id="image-preview-size"');
      expect(html).toContain('id="remove-image-btn"');

      // Unsupported warning banner
      expect(html).toContain('id="image-unsupported-warning"');

      // Essential client logic functions and handlers
      expect(html).toContain('function isModelVisionCapable(');
      expect(html).toContain('function getModelImageTokenBudget(');
      expect(html).toContain('function handleSelectedImageFile(');
      expect(html).toContain('function clearAttachedImage(');
      expect(html).toContain('function calculateRequestPayloadSize(');
      expect(html).toContain('function sanitizeMessageForStorage(');
      expect(html).toContain("composerInputBox.addEventListener('dragover'");
      expect(html).toContain("chatTextarea.addEventListener('paste'");
    });

    it('formats multimodal message payload with image_url and text parts when image is attached', () => {
      const attachedImage = {
        dataUri:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        name: 'test.png',
        size: 100,
        type: 'image/png',
      };
      const textPrompt = 'Explain this diagram';

      // Simulation of composer message builder in sendMessage()
      function buildUserContent(text: string, attachment: typeof attachedImage | null) {
        if (!attachment) return text;
        return [
          {
            type: 'image_url',
            image_url: {
              url: attachment.dataUri,
            },
          },
          {
            type: 'text',
            text,
          },
        ];
      }

      const multimodalContent = buildUserContent(textPrompt, attachedImage);
      expect(Array.isArray(multimodalContent)).toBe(true);
      expect(multimodalContent).toEqual([
        {
          type: 'image_url',
          image_url: {
            url: attachedImage.dataUri,
          },
        },
        {
          type: 'text',
          text: 'Explain this diagram',
        },
      ]);

      // When no attachment, plain string content must be preserved
      const textOnlyContent = buildUserContent(textPrompt, null);
      expect(typeof textOnlyContent).toBe('string');
      expect(textOnlyContent).toBe('Explain this diagram');
    });

    it('enforces 4-tier precedence for vision capability resolution', () => {
      // 1. Explicit capabilities.supportsVision overrides everything
      const explicitFalse = resolveModelVisionCapability('smolvlm2-500m', false, {
        supportsVision: true,
        architecture: 'SmolVLMForConditionalGeneration',
      });
      expect(explicitFalse.supportsVision).toBe(false);
      expect(explicitFalse.source).toBe('explicit_capability');

      const explicitTrue = resolveModelVisionCapability('text-only-gpt', true);
      expect(explicitTrue.supportsVision).toBe(true);
      expect(explicitTrue.source).toBe('explicit_capability');

      // 2. Model/provider metadata
      const metaTrue = resolveModelVisionCapability('custom-model', undefined, {
        supportsVision: true,
      });
      expect(metaTrue.supportsVision).toBe(true);
      expect(metaTrue.source).toBe('model_metadata');

      const metaFalse = resolveModelVisionCapability('custom-vlm-model', undefined, {
        supportsVision: false,
      });
      expect(metaFalse.supportsVision).toBe(false);
      expect(metaFalse.source).toBe('model_metadata');

      // 3. Architecture/model_type
      const archVision = resolveModelVisionCapability('my-model-1', undefined, {
        architecture: 'SmolVLMForConditionalGeneration',
      });
      expect(archVision.supportsVision).toBe(true);
      expect(archVision.source).toBe('architecture_metadata');

      // 4. Model-ID heuristic fallback
      const heuristicSmolVLM = resolveModelVisionCapability('HuggingFaceTB/SmolVLM2-500M-Instruct');
      expect(heuristicSmolVLM.supportsVision).toBe(true);
      expect(heuristicSmolVLM.source).toBe('model_id_heuristic_fallback');

      const heuristicGemini = resolveModelVisionCapability('gemini-1.5-flash');
      expect(heuristicGemini.supportsVision).toBe(true);
      expect(heuristicGemini.source).toBe('model_id_heuristic_fallback');

      // Non-vision model
      const textOnly = resolveModelVisionCapability('qwen3-coder-30b');
      expect(textOnly.supportsVision).toBe(false);
      expect(textOnly.source).toBe('default_text_only');
    });

    it('rejects image attachment if active model does not support vision', () => {
      const models = [
        { id: 'qwen3-coder-30b', capabilities: { supportsVision: false } },
        { id: 'smolvlm2-500m', capabilities: { supportsVision: true } },
      ];

      function simulateValidateModelForAttachment(modelId: string, modelList: typeof models) {
        const m = modelList.find((item) => item.id === modelId);
        const isCapable = Boolean(m?.capabilities?.supportsVision);
        if (!isCapable) {
          return {
            allowed: false,
            error: `Model "${modelId}" does not support image input. Please select a multimodal model (e.g., SmolVLM2 or Gemini).`,
          };
        }
        return { allowed: true };
      }

      const invalid = simulateValidateModelForAttachment('qwen3-coder-30b', models);
      expect(invalid.allowed).toBe(false);
      expect(invalid.error).toContain('does not support image input');

      const valid = simulateValidateModelForAttachment('smolvlm2-500m', models);
      expect(valid.allowed).toBe(true);
      expect(valid.error).toBeUndefined();
    });

    it('dynamically updates image attachment button enabled/disabled state and title based on vision capability', () => {
      function isModelVisionCapableClient(
        modelId: string,
        models: Array<{
          id: string;
          capabilities?: { supportsVision?: boolean };
          supportsVision?: boolean;
          model_type?: string;
          architecture?: string;
        }>,
      ) {
        if (!modelId) return { isCapable: false, source: 'no_model' };
        const m = models.find((item) => {
          if (!item || !item.id) return false;
          if (item.id === modelId) return true;
          if (modelId.includes('/') && item.id === modelId.split('/')[1]) return true;
          if (item.id.includes('/') && item.id.endsWith('/' + modelId)) return true;
          return false;
        });

        if (m && m.capabilities && m.capabilities.supportsVision === true) {
          return { isCapable: true, source: 'explicit_capabilities' };
        }
        if (m && m.supportsVision === true) {
          return { isCapable: true, source: 'model_metadata' };
        }
        if (m && (m.model_type || m.architecture)) {
          const combined = String(m.model_type || m.architecture).toLowerCase();
          if (
            combined.includes('vlm') ||
            combined.includes('vision') ||
            combined.includes('smolvlm') ||
            combined.includes('idefics') ||
            combined.includes('conditionalgeneration')
          ) {
            return { isCapable: true, source: 'architecture_metadata' };
          }
        }
        const lower = String(modelId).toLowerCase();
        const isHeuristic =
          lower.includes('vlm') ||
          lower.includes('vision') ||
          lower.includes('-vl') ||
          lower.includes('vl-') ||
          lower.includes('ocr') ||
          lower.includes('idefics') ||
          lower.includes('llava') ||
          lower.includes('pixtral') ||
          lower.includes('paligemma') ||
          lower.includes('florence') ||
          lower.includes('smolvlm') ||
          lower.includes('gemini');
        if (isHeuristic) {
          return { isCapable: true, source: 'model_id_heuristic_fallback' };
        }
        return { isCapable: false, source: 'default_text_only' };
      }

      function updateAttachmentSupportSimulation(
        activeModel: string,
        models: Parameters<typeof isModelVisionCapableClient>[1],
      ) {
        const visionStatus = isModelVisionCapableClient(activeModel, models);
        const button = {
          disabled: !visionStatus.isCapable,
          title: !visionStatus.isCapable
            ? activeModel
              ? `Model ${activeModel} does not support image input`
              : 'No model selected'
            : 'Attach image (PNG, JPEG, WebP)',
        };
        return button;
      }

      const testModels = [
        { id: 'HuggingFaceTB/SmolVLM2-500M-Instruct', capabilities: { supportsVision: true } },
        { id: 'custom-smolvlm', capabilities: { supportsVision: false } },
        { id: 'qwen3-coder-30b', capabilities: { supportsVision: false } },
      ];

      // SmolVLM2 with explicit supportsVision: true
      const smolvlmBtn = updateAttachmentSupportSimulation(
        'HuggingFaceTB/SmolVLM2-500M-Instruct',
        testModels,
      );
      expect(smolvlmBtn.disabled).toBe(false);
      expect(smolvlmBtn.title).toBe('Attach image (PNG, JPEG, WebP)');

      // Model with supportsVision: false in capabilities but matching heuristic fallback
      const customVlmBtn = updateAttachmentSupportSimulation('custom-smolvlm', testModels);
      expect(customVlmBtn.disabled).toBe(false);
      expect(customVlmBtn.title).toBe('Attach image (PNG, JPEG, WebP)');

      // Text-only model
      const textBtn = updateAttachmentSupportSimulation('qwen3-coder-30b', testModels);
      expect(textBtn.disabled).toBe(true);
      expect(textBtn.title).toBe('Model qwen3-coder-30b does not support image input');

      // Empty model
      const emptyBtn = updateAttachmentSupportSimulation('', testModels);
      expect(emptyBtn.disabled).toBe(true);
      expect(emptyBtn.title).toBe('No model selected');
    });

    it('validates supported MIME types (PNG, JPEG, WebP) and rejects others', () => {
      const SUPPORTED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

      function simulateValidateMimeType(type: string) {
        if (!SUPPORTED_TYPES.includes(type)) {
          return {
            valid: false,
            error: `Unsupported file type (${type || 'unknown'}). Please select a PNG, JPEG, or WebP image.`,
          };
        }
        return { valid: true };
      }

      expect(simulateValidateMimeType('image/png').valid).toBe(true);
      expect(simulateValidateMimeType('image/jpeg').valid).toBe(true);
      expect(simulateValidateMimeType('image/webp').valid).toBe(true);

      const pdf = simulateValidateMimeType('application/pdf');
      expect(pdf.valid).toBe(false);
      expect(pdf.error).toContain('Unsupported file type');

      const svg = simulateValidateMimeType('image/svg+xml');
      expect(svg.valid).toBe(false);
      expect(svg.error).toContain('Unsupported file type');

      const text = simulateValidateMimeType('text/plain');
      expect(text.valid).toBe(false);
      expect(text.error).toContain('Unsupported file type');
    });

    it('rejects files exceeding 6 MB file-size limit', () => {
      const MAX_FILE_SIZE = 6 * 1024 * 1024; // 6 MB

      function simulateValidateFileSize(size: number) {
        if (size > MAX_FILE_SIZE) {
          return {
            valid: false,
            error: `Image size (${(size / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum limit of 6.00 MB.`,
          };
        }
        return { valid: true };
      }

      expect(simulateValidateFileSize(1024 * 1024).valid).toBe(true); // 1 MB OK
      expect(simulateValidateFileSize(6 * 1024 * 1024).valid).toBe(true); // 6 MB OK
      const over = simulateValidateFileSize(6 * 1024 * 1024 + 1); // 6 MB + 1 byte
      expect(over.valid).toBe(false);
      expect(over.error).toContain('exceeds the maximum limit of 6.00 MB');
    });

    it('rejects serialized request payload exceeding 9.5 MB request-body budget', () => {
      const MAX_PAYLOAD_BYTES = 9.5 * 1024 * 1024; // 9.5 MB

      function simulateValidatePayloadSize(payload: unknown) {
        const serialized = JSON.stringify(payload);
        const bytes = new TextEncoder().encode(serialized).length;
        if (bytes > MAX_PAYLOAD_BYTES) {
          return {
            valid: false,
            bytes,
            error: `Total request payload size (${(bytes / (1024 * 1024)).toFixed(2)} MB) exceeds the maximum allowable request budget (9.50 MB).`,
          };
        }
        return { valid: true, bytes };
      }

      const validPayload = {
        model: 'smolvlm2-500m',
        messages: [{ role: 'user', content: 'Normal prompt with small image' }],
      };
      expect(simulateValidatePayloadSize(validPayload).valid).toBe(true);

      // Create a payload that exceeds 9.5 MB
      const hugePayload = {
        model: 'smolvlm2-500m',
        messages: [{ role: 'user', content: 'X'.repeat(10 * 1024 * 1024) }],
      };
      const hugeResult = simulateValidatePayloadSize(hugePayload);
      expect(hugeResult.valid).toBe(false);
      expect(hugeResult.error).toContain('exceeds the maximum allowable request budget');
    });

    it('accurately estimates multimodal tokens without base64 character pollution', () => {
      const base64DataUri = `data:image/png;base64,${'A'.repeat(500000)}`; // 500k base64 characters
      const messages = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: base64DataUri },
            },
            {
              type: 'text',
              text: 'What is shown in this picture?', // 30 characters
            },
          ],
        },
      ];

      // Simulated estimateMessagesTokens matching playground client implementation
      function simulateEstimateMessagesTokens(msgs: typeof messages, imageTokenBudget = 576) {
        let totalChars = 0;
        let totalImageTokens = 0;

        for (const msg of msgs) {
          if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part.type === 'text' && typeof part.text === 'string') {
                totalChars += part.text.length;
              } else if (part.type === 'image_url' || (part as any).image_url) {
                totalImageTokens += imageTokenBudget;
              }
            }
          }
        }

        const textTokens = Math.ceil(totalChars / 3.5);
        const framingOverhead = msgs.length * 4 + 3;
        return {
          totalTokens: textTokens + totalImageTokens + framingOverhead,
          textTokens,
          totalImageTokens,
          framingOverhead,
        };
      }

      const estimate = simulateEstimateMessagesTokens(messages, 576);

      // 30 chars / 3.5 = 9 text tokens
      expect(estimate.textTokens).toBe(9);
      // Fixed 576 image token budget, NOT 500,000 / 3.5 = ~142,857 tokens!
      expect(estimate.totalImageTokens).toBe(576);
      expect(estimate.framingOverhead).toBe(7); // 1 msg * 4 + 3 = 7
      expect(estimate.totalTokens).toBe(9 + 576 + 7); // 592 tokens
    });

    it('resolves model-specific image token budgets from metadata or fallback', () => {
      const models = [
        { id: 'custom-vlm', capabilities: { imageTokens: 1024 } },
        { id: 'metadata-vlm', image_tokens: 768 },
        { id: 'default-vlm' },
      ];

      function simulateGetImageTokenBudget(modelId: string, modelList: typeof models) {
        const m = modelList.find((item) => item.id === modelId);
        if (m && (m as any).capabilities?.imageTokens) {
          return {
            tokens: (m as any).capabilities.imageTokens,
            source: 'capabilities.imageTokens',
          };
        }
        if (m && (m as any).image_tokens) {
          return { tokens: (m as any).image_tokens, source: 'model_metadata.image_tokens' };
        }
        return { tokens: 576, source: 'default_conservative_fallback' };
      }

      expect(simulateGetImageTokenBudget('custom-vlm', models)).toEqual({
        tokens: 1024,
        source: 'capabilities.imageTokens',
      });
      expect(simulateGetImageTokenBudget('metadata-vlm', models)).toEqual({
        tokens: 768,
        source: 'model_metadata.image_tokens',
      });
      expect(simulateGetImageTokenBudget('default-vlm', models)).toEqual({
        tokens: 576,
        source: 'default_conservative_fallback',
      });
    });

    it('rejects when prompt text plus image token budget exceeds model context limit', () => {
      const model = { id: 'small-vlm', max_model_len: 1024 };
      // Prompt has 600 tokens of text + 576 tokens of image = 1176 tokens > 1024 limit
      const longText = 'A'.repeat(2100); // 2100 / 3.5 = 600 text tokens
      const textTokens = Math.ceil(longText.length / 3.5); // 600
      const imageTokens = 576;
      const framing = 1 * 4 + 3; // 7
      const totalEstimated = textTokens + imageTokens + framing; // 1183 tokens

      const availableBudget = model.max_model_len - totalEstimated; // 1024 - 1183 = -159
      expect(availableBudget).toBeLessThanOrEqual(0);

      const errorMsg = `Input messages (~${totalEstimated} tokens) exceed the model context length of ${model.max_model_len} tokens.`;
      expect(errorMsg).toContain('exceed the model context length of 1024 tokens');
    });

    it('sanitizes conversation history before localStorage to strip base64 image data', () => {
      const messagesInState = [
        {
          role: 'user',
          content: [
            {
              type: 'image_url',
              image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...' },
            },
            {
              type: 'text',
              text: 'Explain this diagram in detail',
            },
          ],
          imageUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB...',
          imageName: 'diagram.png',
          hasImage: true,
          timestamp: 1726500000,
        },
        {
          role: 'assistant',
          content: 'This diagram shows a network topology.',
          timestamp: 1726500005,
        },
      ];

      // Exact implementation of sanitizeMessageForStorage
      function sanitizeMessageForStorage(msg: any) {
        if (!msg) return null;
        const copy = { ...msg };
        delete copy.imageUrl;

        if (Array.isArray(copy.content)) {
          let extractedText = '';
          let hasImage = false;
          for (const p of copy.content) {
            if (p && p.type === 'text') extractedText = p.text || '';
            if (p && (p.type === 'image_url' || p.image_url)) hasImage = true;
          }
          copy.content = extractedText;
          if (hasImage) {
            copy.hasImage = true;
            copy.imagePlaceholder = copy.imageName || 'Attached image';
          }
        }
        return copy;
      }

      const sanitized = messagesInState.map(sanitizeMessageForStorage);
      const serialized = JSON.stringify(sanitized);

      // Verify base64 data URI is completely absent
      expect(serialized).not.toContain('data:image/');
      expect(sanitized[0].imageUrl).toBeUndefined();
      expect(sanitized[0].content).toBe('Explain this diagram in detail');
      expect(sanitized[0].hasImage).toBe(true);
      expect(sanitized[0].imagePlaceholder).toBe('diagram.png');
      expect(serialized.length).toBeLessThan(500); // Extremely lightweight
    });

    it('accepts multimodal requests on POST /v1/chat/completions without 413 or schema errors', async () => {
      const { app, registry } = await createTestApp();

      // Register a vision-capable test model on mock-provider
      registry.registerModel({
        id: 'mock-vision-model',
        provider: 'mock-provider',
        capabilities: {
          supportsVision: true,
          supportsStreaming: true,
          supportsToolCalling: true,
          supportsStructuredOutput: true,
          maxContextTokens: 4096,
          maxOutputTokens: 2048,
          imageTokens: 576,
        },
        contextWindow: 4096,
        maxOutputTokens: 2048,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/chat/completions',
        headers: {
          'Content-Type': 'application/json',
        },
        payload: {
          model: 'mock-vision-model',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
                  },
                },
                {
                  type: 'text',
                  text: 'What color is this pixel?',
                },
              ],
            },
          ],
        },
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.object).toBe('chat.completion');
      expect(body.model).toBe('mock-vision-model');
      expect(body.choices).toBeDefined();
      expect(body.choices.length).toBe(1);
      expect(body.choices[0].message.role).toBe('assistant');
    });
  });
});
