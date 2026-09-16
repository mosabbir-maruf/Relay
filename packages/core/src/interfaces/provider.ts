import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
} from '../types/chat.js';
import type { ModelCapabilities } from '../types/model.js';

export interface RequestOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly headers?: Record<string, string>;
}

export type ProviderCapabilities = ModelCapabilities;

export interface ProviderHealth {
  readonly isHealthy: boolean;
  readonly latencyMs: number;
  readonly lastChecked: Date;
  readonly errorMessage?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;

  getCapabilities(model: string): ProviderCapabilities;
  healthCheck(): Promise<ProviderHealth>;
  chat(request: ChatCompletionRequest, options?: RequestOptions): Promise<ChatCompletionResponse>;
  chatStream(
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): AsyncIterable<ChatCompletionChunk>;
}
