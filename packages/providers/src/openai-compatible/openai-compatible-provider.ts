import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChunkToolCallDelta,
  FinishReason,
  LLMProvider,
  MessageRole,
  NormalizedMessage,
  ProviderCapabilities,
  ProviderHealth,
  RequestOptions,
  ToolCall,
} from '@relay/core';
import { RelayProviderUnavailableError, RelayTimeoutError } from '@relay/core';
import { mapHttpStatusToRelayError } from '../http/error-mapper.js';
import { parseServerSentEvents } from '../http/sse-parser.js';

export interface OpenAICompatibleConfig {
  readonly id?: string;
  readonly name?: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly defaultCapabilities?: Partial<ProviderCapabilities>;
  readonly customHeaders?: Record<string, string>;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: false,
  supportsStructuredOutput: true,
  maxContextTokens: 32768,
  maxOutputTokens: 4096,
};

/**
 * Generic provider adapter for any OpenAI-compatible inference server.
 * Supports OpenAI, vLLM, Ollama, Kaggle T4x2 remote GPU servers, and local endpoints.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string | undefined;
  private readonly customHeaders: Record<string, string>;
  private readonly capabilities: ProviderCapabilities;

  constructor(config: OpenAICompatibleConfig) {
    this.id = config.id ?? 'openai-compatible';
    this.name = config.name ?? 'OpenAI Compatible';
    // Remove trailing slash if present
    this.baseUrl = config.baseUrl.replace(/\/+$/, '');
    this.apiKey = config.apiKey;
    this.customHeaders = config.customHeaders ?? {};
    this.capabilities = {
      ...DEFAULT_CAPABILITIES,
      ...(config.defaultCapabilities ?? {}),
    };
  }

  getCapabilities(_model: string): ProviderCapabilities {
    return this.capabilities;
  }

  async healthCheck(): Promise<ProviderHealth> {
    const startTime = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);

    try {
      const headers = this.buildHeaders();
      const response = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });

      const latencyMs = Date.now() - startTime;
      if (response.ok) {
        return {
          isHealthy: true,
          latencyMs,
          lastChecked: new Date(),
        };
      }

      return {
        isHealthy: false,
        latencyMs,
        lastChecked: new Date(),
        errorMessage: `Health check returned HTTP ${response.status}: ${response.statusText}`,
      };
    } catch (err) {
      return {
        isHealthy: false,
        latencyMs: Date.now() - startTime,
        lastChecked: new Date(),
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async chat(
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): Promise<ChatCompletionResponse> {
    const payload = this.transformRequest(request, false);
    const headers = this.buildHeaders(options?.headers);

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      };
      if (options?.signal) {
        requestInit.signal = options.signal;
      }

      response = await fetch(`${this.baseUrl}/chat/completions`, requestInit);
    } catch (err) {
      this.handleFetchError(err);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw mapHttpStatusToRelayError({
        provider: this.id,
        status: response.status,
        statusText: response.statusText,
        bodyText,
        retryAfterHeader: response.headers.get('retry-after'),
      });
    }

    let data: Record<string, unknown>;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new RelayProviderUnavailableError(
        `Provider "${this.id}" returned a non-JSON or malformed response (HTTP ${response.status}).`,
      );
    }
    return this.transformResponse(data, request.model);
  }

  async *chatStream(
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    const payload = this.transformRequest(request, true);
    const headers = this.buildHeaders(options?.headers);

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      };
      if (options?.signal) {
        requestInit.signal = options.signal;
      }

      response = await fetch(`${this.baseUrl}/chat/completions`, requestInit);
    } catch (err) {
      this.handleFetchError(err);
    }

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw mapHttpStatusToRelayError({
        provider: this.id,
        status: response.status,
        statusText: response.statusText,
        bodyText,
        retryAfterHeader: response.headers.get('retry-after'),
      });
    }

    if (!response.body) {
      return;
    }

    for await (const sse of parseServerSentEvents(response.body)) {
      if (sse.data === '[DONE]') {
        break;
      }

      try {
        const chunkJson = JSON.parse(sse.data) as Record<string, unknown>;
        const chunk = this.transformChunk(chunkJson, request.model);
        yield chunk;
      } catch {
        // Skip unparseable non-JSON data lines
      }
    }
  }

  private buildHeaders(extraHeaders?: Record<string, string>): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.customHeaders,
      ...(extraHeaders ?? {}),
    };

    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    return headers;
  }

  private transformRequest(
    request: ChatCompletionRequest,
    stream: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      model: request.model,
      messages: request.messages.map((m) => {
        const msg: Record<string, unknown> = {
          role: m.role,
          content: m.content,
        };
        if (m.name) msg['name'] = m.name;
        if (m.toolCallId) msg['tool_call_id'] = m.toolCallId;
        if (m.toolCalls) {
          msg['tool_calls'] = m.toolCalls.map((tc) => ({
            id: tc.id,
            type: tc.type,
            function: tc.function,
          }));
        }
        return msg;
      }),
      stream,
    };

    if (request.temperature !== undefined) payload['temperature'] = request.temperature;
    if (request.topP !== undefined) payload['top_p'] = request.topP;
    if (request.maxTokens !== undefined) payload['max_tokens'] = request.maxTokens;
    if (request.stop !== undefined) payload['stop'] = request.stop;
    if (request.tools !== undefined) payload['tools'] = request.tools;
    if (request.toolChoice !== undefined) payload['tool_choice'] = request.toolChoice;
    if (request.responseFormat !== undefined) payload['response_format'] = request.responseFormat;
    if (request.user !== undefined) payload['user'] = request.user;

    return payload;
  }

  private transformResponse(
    data: Record<string, unknown>,
    requestedModel: string,
  ): ChatCompletionResponse {
    const choices = (data['choices'] as Array<Record<string, unknown>>) ?? [];
    const firstChoice = choices[0] ?? {};
    const rawMessage = (firstChoice['message'] as Record<string, unknown>) ?? {};

    let toolCalls: ToolCall[] | undefined;
    if (Array.isArray(rawMessage['tool_calls'])) {
      toolCalls = rawMessage['tool_calls'].map((tc: Record<string, unknown>) => ({
        id: String(tc['id'] ?? ''),
        type: 'function',
        function: {
          name: String((tc['function'] as Record<string, unknown>)?.['name'] ?? ''),
          arguments: String((tc['function'] as Record<string, unknown>)?.['arguments'] ?? ''),
        },
      }));
    }

    const message: NormalizedMessage = {
      role: (rawMessage['role'] as MessageRole) ?? 'assistant',
      content: typeof rawMessage['content'] === 'string' ? rawMessage['content'] : '',
      ...(toolCalls ? { toolCalls } : {}),
    };

    const usageRaw = (data['usage'] as Record<string, unknown>) ?? {};
    const promptTokens = Number(usageRaw['prompt_tokens'] ?? 0);
    const completionTokens = Number(usageRaw['completion_tokens'] ?? 0);
    const totalTokens = Number(usageRaw['total_tokens'] ?? promptTokens + completionTokens);

    return {
      id: String(data['id'] ?? `relay-${Date.now()}`),
      model: String(data['model'] ?? requestedModel),
      provider: this.id,
      message,
      finishReason: (firstChoice['finish_reason'] as FinishReason) ?? 'stop',
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      created: Number(data['created'] ?? Math.floor(Date.now() / 1000)),
    };
  }

  private transformChunk(
    data: Record<string, unknown>,
    requestedModel: string,
  ): ChatCompletionChunk {
    const choices = (data['choices'] as Array<Record<string, unknown>>) ?? [];
    const firstChoice = choices[0] ?? {};
    const rawDelta = (firstChoice['delta'] as Record<string, unknown>) ?? {};

    let toolCallsDelta: ChunkToolCallDelta[] | undefined;
    if (Array.isArray(rawDelta['tool_calls'])) {
      toolCallsDelta = rawDelta['tool_calls'].map((tc: Record<string, unknown>, idx: number) => {
        const item: {
          index: number;
          id?: string;
          type?: 'function';
          function?: { name?: string; arguments?: string };
        } = {
          index: typeof tc['index'] === 'number' ? tc['index'] : idx,
        };
        if (tc['id']) item.id = String(tc['id']);
        if (tc['type'] === 'function') item.type = 'function';
        if (tc['function'] && typeof tc['function'] === 'object') {
          const fn = tc['function'] as Record<string, unknown>;
          const fnDelta: { name?: string; arguments?: string } = {};
          if (fn['name']) fnDelta.name = String(fn['name']);
          if (fn['arguments']) fnDelta.arguments = String(fn['arguments']);
          item.function = fnDelta;
        }
        return item;
      });
    }

    const delta: ChatCompletionChunkDelta = {
      ...(rawDelta['role'] ? { role: rawDelta['role'] as MessageRole } : {}),
      ...(typeof rawDelta['content'] === 'string' ? { content: rawDelta['content'] } : {}),
      ...(toolCallsDelta ? { toolCalls: toolCallsDelta } : {}),
    };

    const usageRaw = (data['usage'] as Record<string, unknown>) ?? undefined;
    const chunkUsage = usageRaw
      ? {
          promptTokens: Number(usageRaw['prompt_tokens'] ?? 0),
          completionTokens: Number(usageRaw['completion_tokens'] ?? 0),
          totalTokens: Number(usageRaw['total_tokens'] ?? 0),
        }
      : undefined;

    return {
      id: String(data['id'] ?? `relay-${Date.now()}`),
      model: String(data['model'] ?? requestedModel),
      provider: this.id,
      delta,
      finishReason: (firstChoice['finish_reason'] as FinishReason) ?? null,
      ...(chunkUsage ? { usage: chunkUsage } : {}),
      created: Number(data['created'] ?? Math.floor(Date.now() / 1000)),
    };
  }

  private handleFetchError(err: unknown): never {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new RelayTimeoutError('Request was aborted or timed out', { cause: err });
    }
    if (err instanceof Error && err.name === 'AbortError') {
      throw new RelayTimeoutError('Request was aborted or timed out', { cause: err });
    }
    const isNetworkError =
      err instanceof TypeError ||
      (err instanceof Error &&
        (err.message.includes('fetch failed') ||
          (err.cause instanceof Error && 'code' in err.cause)));
    if (isNetworkError) {
      const causeCode = (err as { cause?: { code?: string } })?.cause?.code;
      const details = causeCode ? ` (${causeCode})` : '';
      throw new RelayProviderUnavailableError(
        `Failed to reach provider "${this.id}" at ${this.baseUrl}${details}. Check connectivity or endpoint configuration.`,
        { cause: err },
      );
    }
    throw err;
  }
}
