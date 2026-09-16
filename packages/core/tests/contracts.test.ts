import { describe, expect, it } from 'vitest';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProvider,
  ProviderCapabilities,
  ProviderHealth,
  RequestOptions,
} from '../src/index.js';

describe('LLMProvider Contract Conformance', () => {
  it('allows implementing a compliant provider without type violations', async () => {
    // Minimal compliant test implementation to verify contract completeness
    class MockProvider implements LLMProvider {
      readonly id = 'mock-provider';
      readonly name = 'Mock Provider';

      getCapabilities(_model: string): ProviderCapabilities {
        return {
          supportsStreaming: true,
          supportsToolCalling: false,
          supportsVision: false,
          supportsStructuredOutput: true,
          maxContextTokens: 8192,
          maxOutputTokens: 2048,
        };
      }

      async healthCheck(): Promise<ProviderHealth> {
        return {
          isHealthy: true,
          latencyMs: 12,
          lastChecked: new Date(),
        };
      }

      async chat(
        request: ChatCompletionRequest,
        _options?: RequestOptions,
      ): Promise<ChatCompletionResponse> {
        return {
          id: 'test-completion-id',
          model: request.model,
          provider: this.id,
          message: {
            role: 'assistant',
            content: 'Test mock response',
          },
          finishReason: 'stop',
          usage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
          created: 1726500000,
        };
      }

      async *chatStream(
        request: ChatCompletionRequest,
        _options?: RequestOptions,
      ): AsyncIterable<ChatCompletionChunk> {
        yield {
          id: 'test-chunk-id',
          model: request.model,
          provider: this.id,
          delta: { role: 'assistant', content: 'Test ' },
          finishReason: null,
          created: 1726500000,
        };
        yield {
          id: 'test-chunk-id',
          model: request.model,
          provider: this.id,
          delta: { content: 'chunk' },
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
          created: 1726500000,
        };
      }
    }

    const provider: LLMProvider = new MockProvider();
    expect(provider.id).toBe('mock-provider');
    expect(provider.name).toBe('Mock Provider');

    const capabilities = provider.getCapabilities('mock-model');
    expect(capabilities.supportsStreaming).toBe(true);
    expect(capabilities.maxContextTokens).toBe(8192);

    const health = await provider.healthCheck();
    expect(health.isHealthy).toBe(true);
    expect(health.latencyMs).toBe(12);

    const chatResponse = await provider.chat({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello' }],
    });
    expect(chatResponse.finishReason).toBe('stop');
    expect(chatResponse.message.content).toBe('Test mock response');
    expect(chatResponse.usage.totalTokens).toBe(15);

    const chunks: ChatCompletionChunk[] = [];
    for await (const chunk of provider.chatStream({
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Hello stream' }],
    })) {
      chunks.push(chunk);
    }
    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.delta.content).toBe('Test ');
    expect(chunks[1]?.delta.content).toBe('chunk');
    expect(chunks[1]?.finishReason).toBe('stop');
  });
});
