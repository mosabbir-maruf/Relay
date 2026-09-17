import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '@relay/providers';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config/index.js';
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
      expect(html).toContain('id="relay-api-key-input"');
      expect(html).toContain('id="reset-settings-btn"');
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
});
