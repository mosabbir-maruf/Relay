import type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionRequest,
  ChatCompletionResponse,
  FinishReason,
  LLMProvider,
  NormalizedMessage,
  ProviderCapabilities,
  ProviderHealth,
  RequestOptions,
  ToolCall,
} from '@relay/core';
import { RelayProviderUnavailableError, RelayTimeoutError } from '@relay/core';
import { mapHttpStatusToRelayError } from '../http/error-mapper.js';
import { parseServerSentEvents } from '../http/sse-parser.js';

export interface GeminiConfig {
  readonly id?: string;
  readonly name?: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly apiVersion?: string;
  readonly defaultCapabilities?: Partial<ProviderCapabilities>;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  supportsStreaming: true,
  supportsToolCalling: true,
  supportsVision: true,
  supportsStructuredOutput: true,
  maxContextTokens: 1048576, // Gemini 1.5/2.0 context window
  maxOutputTokens: 8192,
};

/**
 * Native fetch-based Gemini provider adapter.
 * Communicates directly with Google's Generative Language REST API without third-party SDKs.
 */
export class GeminiProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly apiVersion: string;
  private readonly capabilities: ProviderCapabilities;

  constructor(config: GeminiConfig) {
    this.id = config.id ?? 'gemini';
    this.name = config.name ?? 'Google Gemini';
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com').replace(
      /\/+$/,
      '',
    );
    this.apiVersion = config.apiVersion ?? 'v1beta';
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
      const url = `${this.baseUrl}/${this.apiVersion}/models?key=${this.apiKey}`;
      const response = await fetch(url, {
        method: 'GET',
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
        errorMessage: `Gemini health check returned HTTP ${response.status}: ${response.statusText}`,
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
    const model = this.sanitizeModelName(request.model);
    const url = `${this.baseUrl}/${this.apiVersion}/models/${model}:generateContent?key=${this.apiKey}`;
    const payload = this.transformRequest(request);

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers ?? {}),
        },
        body: JSON.stringify(payload),
      };
      if (options?.signal) {
        requestInit.signal = options.signal;
      }

      response = await fetch(url, requestInit);
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
        `Gemini provider returned a non-JSON or malformed response (HTTP ${response.status}).`,
      );
    }
    return this.transformResponse(data, request.model);
  }

  async *chatStream(
    request: ChatCompletionRequest,
    options?: RequestOptions,
  ): AsyncIterable<ChatCompletionChunk> {
    const model = this.sanitizeModelName(request.model);
    const url = `${this.baseUrl}/${this.apiVersion}/models/${model}:streamGenerateContent?alt=sse&key=${this.apiKey}`;
    const payload = this.transformRequest(request);

    let response: Response;
    try {
      const requestInit: RequestInit = {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(options?.headers ?? {}),
        },
        body: JSON.stringify(payload),
      };
      if (options?.signal) {
        requestInit.signal = options.signal;
      }

      response = await fetch(url, requestInit);
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
        // Skip unparseable lines
      }
    }
  }

  private sanitizeModelName(model: string): string {
    // If model starts with "models/", strip it so it doesn't double in URL
    return model.startsWith('models/') ? model.slice(7) : model;
  }

  private transformRequest(request: ChatCompletionRequest): Record<string, unknown> {
    const contents: Array<Record<string, unknown>> = [];
    let systemInstruction: Record<string, unknown> | undefined;

    for (const msg of request.messages) {
      if (msg.role === 'system') {
        const textContent =
          typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
        systemInstruction = {
          parts: [{ text: textContent }],
        };
        continue;
      }

      const role = msg.role === 'assistant' ? 'model' : 'user';
      const parts: Array<Record<string, unknown>> = [];

      if (typeof msg.content === 'string') {
        if (msg.content.length > 0) {
          parts.push({ text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'text') {
            parts.push({ text: part.text });
          } else if (part.type === 'image_url') {
            // Note: Inline base64 or URL support
            parts.push({
              image_url: { url: part.imageUrl.url },
            });
          }
        }
      }

      if (msg.toolCalls && msg.toolCalls.length > 0) {
        for (const tc of msg.toolCalls) {
          let args = {};
          try {
            args = JSON.parse(tc.function.arguments);
          } catch {
            // Ignore parse errors
          }
          parts.push({
            functionCall: {
              name: tc.function.name,
              args,
            },
          });
        }
      }

      if (parts.length > 0) {
        contents.push({ role, parts });
      }
    }

    const generationConfig: Record<string, unknown> = {};
    if (request.temperature !== undefined) generationConfig['temperature'] = request.temperature;
    if (request.topP !== undefined) generationConfig['topP'] = request.topP;
    if (request.maxTokens !== undefined) generationConfig['maxOutputTokens'] = request.maxTokens;
    if (request.stop !== undefined && request.stop.length > 0) {
      generationConfig['stopSequences'] = request.stop;
    }

    const payload: Record<string, unknown> = {
      contents,
    };

    if (systemInstruction) {
      payload['systemInstruction'] = systemInstruction;
    }

    if (Object.keys(generationConfig).length > 0) {
      payload['generationConfig'] = generationConfig;
    }

    if (request.tools && request.tools.length > 0) {
      payload['tools'] = [
        {
          functionDeclarations: request.tools.map((t) => ({
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          })),
        },
      ];
    }

    return payload;
  }

  private transformResponse(
    data: Record<string, unknown>,
    requestedModel: string,
  ): ChatCompletionResponse {
    const candidates = (data['candidates'] as Array<Record<string, unknown>>) ?? [];
    const firstCandidate = candidates[0] ?? {};
    const rawContent = (firstCandidate['content'] as Record<string, unknown>) ?? {};
    const parts = (rawContent['parts'] as Array<Record<string, unknown>>) ?? [];

    let textContent = '';
    const toolCalls: ToolCall[] = [];

    for (const part of parts) {
      if (typeof part['text'] === 'string') {
        textContent += part['text'];
      }
      if (part['functionCall']) {
        const fc = part['functionCall'] as Record<string, unknown>;
        toolCalls.push({
          id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          type: 'function',
          function: {
            name: String(fc['name'] ?? ''),
            arguments: JSON.stringify(fc['args'] ?? {}),
          },
        });
      }
    }

    const message: NormalizedMessage = {
      role: 'assistant',
      content: textContent,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    const rawFinishReason = String(firstCandidate['finishReason'] ?? 'STOP');
    const finishReason = this.mapGeminiFinishReason(rawFinishReason, toolCalls.length > 0);

    const usageRaw = (data['usageMetadata'] as Record<string, unknown>) ?? {};
    const promptTokens = Number(usageRaw['promptTokenCount'] ?? 0);
    const completionTokens = Number(usageRaw['candidatesTokenCount'] ?? 0);
    const totalTokens = Number(usageRaw['totalTokenCount'] ?? promptTokens + completionTokens);

    return {
      id: `gemini-${Date.now()}`,
      model: requestedModel,
      provider: this.id,
      message,
      finishReason,
      usage: {
        promptTokens,
        completionTokens,
        totalTokens,
      },
      created: Math.floor(Date.now() / 1000),
    };
  }

  private transformChunk(
    data: Record<string, unknown>,
    requestedModel: string,
  ): ChatCompletionChunk {
    const candidates = (data['candidates'] as Array<Record<string, unknown>>) ?? [];
    const firstCandidate = candidates[0] ?? {};
    const rawContent = (firstCandidate['content'] as Record<string, unknown>) ?? {};
    const parts = (rawContent['parts'] as Array<Record<string, unknown>>) ?? [];

    let deltaText = '';
    for (const part of parts) {
      if (typeof part['text'] === 'string') {
        deltaText += part['text'];
      }
    }

    const rawFinishReason = firstCandidate['finishReason']
      ? String(firstCandidate['finishReason'])
      : undefined;
    const finishReason = rawFinishReason
      ? this.mapGeminiFinishReason(rawFinishReason, false)
      : null;

    const delta: ChatCompletionChunkDelta = {
      role: 'assistant',
      ...(deltaText.length > 0 ? { content: deltaText } : {}),
    };

    const usageRaw = (data['usageMetadata'] as Record<string, unknown>) ?? undefined;
    const chunkUsage = usageRaw
      ? {
          promptTokens: Number(usageRaw['promptTokenCount'] ?? 0),
          completionTokens: Number(usageRaw['candidatesTokenCount'] ?? 0),
          totalTokens: Number(usageRaw['totalTokenCount'] ?? 0),
        }
      : undefined;

    return {
      id: `gemini-${Date.now()}`,
      model: requestedModel,
      provider: this.id,
      delta,
      finishReason,
      ...(chunkUsage ? { usage: chunkUsage } : {}),
      created: Math.floor(Date.now() / 1000),
    };
  }

  private mapGeminiFinishReason(raw: string, hasToolCalls: boolean): FinishReason {
    if (hasToolCalls) return 'tool_calls';
    switch (raw) {
      case 'STOP':
        return 'stop';
      case 'MAX_TOKENS':
        return 'length';
      case 'SAFETY':
      case 'RECITATION':
        return 'content_filter';
      default:
        return 'stop';
    }
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
        `Failed to reach Google Gemini API${details}. Check connectivity or endpoint configuration.`,
        { cause: err },
      );
    }
    throw err;
  }
}
