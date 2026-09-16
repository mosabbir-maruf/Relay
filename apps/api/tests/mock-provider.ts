import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  LLMProvider,
  ProviderCapabilities,
  ProviderHealth,
  RequestOptions,
  TokenUsage,
} from '@relay/core';

export class TestMockProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  delayMs = 0;
  shouldFailWith?: Error;
  failAfterFirstChunk?: Error;
  customUsage?: TokenUsage | null;

  constructor(id = 'mock-provider', name = 'Mock Provider') {
    this.id = id;
    this.name = name;
  }

  getCapabilities(_model: string): ProviderCapabilities {
    return {
      supportsStreaming: true,
      supportsToolCalling: true,
      supportsVision: true,
      supportsStructuredOutput: true,
      maxContextTokens: 32768,
      maxOutputTokens: 4096,
    };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      isHealthy: true,
      latencyMs: 5,
      lastChecked: new Date(),
    };
  }

  async chat(
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): Promise<ChatCompletionResponse> {
    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error('Aborted'));
        });
      });
    }

    if (this.shouldFailWith) {
      throw this.shouldFailWith;
    }

    const usage =
      this.customUsage === null
        ? undefined
        : (this.customUsage ?? {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          });

    return {
      id: 'mock-chat-123',
      model: request.model,
      provider: this.id,
      message: {
        role: 'assistant',
        content: `Echo: ${typeof request.messages[0]?.content === 'string' ? request.messages[0].content : 'content'}`,
      },
      finishReason: 'stop',
      ...(usage ? { usage } : ({} as { usage: TokenUsage })),
      created: 1726500000,
    };
  }

  async *chatStream(
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    if (this.delayMs > 0) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        options?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(options.signal?.reason ?? new Error('Aborted'));
        });
      });
    }

    if (this.shouldFailWith) {
      throw this.shouldFailWith;
    }

    yield {
      id: 'mock-chunk-1',
      model: request.model,
      provider: this.id,
      delta: { role: 'assistant', content: 'Hello' },
      finishReason: null,
      created: 1726500000,
    };

    if (this.failAfterFirstChunk) {
      throw this.failAfterFirstChunk;
    }

    const streamUsage =
      this.customUsage === null
        ? undefined
        : (this.customUsage ?? { promptTokens: 5, completionTokens: 2, totalTokens: 7 });

    yield {
      id: 'mock-chunk-2',
      model: request.model,
      provider: this.id,
      delta: { content: ' world' },
      finishReason: 'stop',
      ...(streamUsage ? { usage: streamUsage } : {}),
      created: 1726500000,
    };
  }
}
