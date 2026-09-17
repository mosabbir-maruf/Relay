import type { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ModelRouter, type ProviderRegistry } from '@relay/providers';
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  CircuitBreaker,
  ContentPart,
  NormalizedMessage,
  ResponseFormat,
  ToolCall,
  ToolChoice,
  ToolDefinition,
  UsageRecord,
  UsageSink,
} from '@relay/core';
import {
  NoopCircuitBreaker,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRequestCancelledError,
  RelayTimeoutError,
  isCircuitBreakerFailure,
  isRelayError,
  isRequestCancelledError,
  isRetryableError,
} from '@relay/core';
import { writeSseStream, type SseStreamResult } from '../sse/sse-writer.js';

export interface ChatRoutesOptions {
  readonly registry: ProviderRegistry;
  readonly router?: ModelRouter | undefined;
  readonly requestTimeoutMs: number;
  readonly usageSink?: UsageSink | undefined;
  readonly circuitBreaker?: CircuitBreaker | undefined;
}

export function createChatRoutes(options: ChatRoutesOptions): FastifyPluginAsync {
  const router = options.router ?? new ModelRouter({ registry: options.registry });
  const circuitBreaker = options.circuitBreaker ?? new NoopCircuitBreaker();

  return async function chatRoutes(app: FastifyInstance): Promise<void> {
    app.post('/v1/chat/completions', async (request, reply) => {
      (request as { inChatHandler?: boolean }).inChatHandler = true;
      (request.raw as { inChatHandler?: boolean }).inChatHandler = true;
      const startedAt = new Date();
      const startTime = startedAt.getTime();
      let resolvedModel = 'unknown';
      let actualProvider = 'unknown';
      let actualModel = 'unknown';
      let isStream = false;
      let attemptCount = 0;

      const recordUsage = (record: UsageRecord) => {
        (request as { usageRecorded?: boolean }).usageRecorded = true;
        options.usageSink?.record(record);
        if (record.success) {
          request.log.info({ usageRecord: record }, 'Chat completion completed');
        } else {
          request.log.warn({ usageRecord: record }, 'Chat completion failed');
        }
      };

      // Setup combined cancellation: client disconnect and request timeout
      const controller = new AbortController();
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort('request_timeout');
      }, options.requestTimeoutMs);

      const onSocketClose = () => {
        if (!reply.raw.writableEnded) {
          controller.abort('client_disconnect');
        }
      };
      request.raw.on('close', onSocketClose);

      try {
        const body = request.body as Record<string, unknown> | undefined;

        if (!body || typeof body !== 'object') {
          throw new RelayInvalidRequestError('Request body must be a valid JSON object.');
        }

        if (!body['model'] || typeof body['model'] !== 'string') {
          throw new RelayInvalidRequestError('Missing required field "model" in request body.');
        }
        resolvedModel = body['model'];

        if (!Array.isArray(body['messages']) || body['messages'].length === 0) {
          throw new RelayInvalidRequestError('Field "messages" must be a non-empty array.');
        }

        if (typeof body['stream'] === 'boolean') {
          isStream = body['stream'];
        }

        // Map raw body to strongly typed ChatCompletionRequest
        const normalizedRequest = parseChatCompletionRequest(body);

        // Resolve routing plan (primary target and optional fallbacks) via ModelRouter
        const routingPlan = router.resolvePlan(normalizedRequest.model);
        const candidates = [routingPlan.primary, ...routingPlan.fallbacks];
        actualProvider = routingPlan.primary.provider.id;
        actualModel = routingPlan.primary.modelInfo.id;

        if (normalizedRequest.stream) {
          let streamResult: SseStreamResult | undefined;
          let lastStreamError: unknown;

          for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i]!;
            attemptCount = i + 1;
            actualProvider = candidate.provider.id;
            actualModel = candidate.modelInfo.id;

            if (controller.signal.aborted) {
              break;
            }

            const decision = circuitBreaker.beforeRequest(candidate.provider.id);
            if (!decision.allow) {
              request.log.warn(
                {
                  provider: candidate.provider.id,
                  state: decision.state,
                  reason: decision.reason,
                  retryAfterMs: decision.retryAfterMs,
                },
                'Circuit breaker rejected streaming request for provider, skipping candidate',
              );
              lastStreamError = new RelayProviderUnavailableError(
                `Provider "${candidate.provider.id}" circuit breaker is ${decision.state}.`,
                { statusCode: 503, details: { provider: candidate.provider.id } },
              );
              continue;
            }

            try {
              const candidateRequest = { ...normalizedRequest, model: candidate.modelInfo.id };
              const stream = candidate.provider.chatStream(candidateRequest, {
                signal: controller.signal,
              });
              streamResult = await writeSseStream(reply, stream, controller.signal);

              if (streamResult.error) {
                if (isCircuitBreakerFailure(streamResult.error)) {
                  circuitBreaker.onFailure(candidate.provider.id, streamResult.error);
                }
              } else if (!streamResult.aborted && !controller.signal.aborted) {
                circuitBreaker.onSuccess(candidate.provider.id);
              }
              break; // Stream handled (completed or mid-stream error emitted)
            } catch (err) {
              lastStreamError = err;
              if (isCircuitBreakerFailure(err)) {
                circuitBreaker.onFailure(candidate.provider.id, err);
              }

              const canFallback =
                !reply.raw.headersSent &&
                i + 1 < candidates.length &&
                !controller.signal.aborted &&
                !timedOut &&
                isRetryableError(err);

              if (canFallback) {
                request.log.warn(
                  {
                    err,
                    attempt: attemptCount,
                    failedProvider: candidate.provider.id,
                    nextProvider: candidates[i + 1]?.provider.id,
                  },
                  'Streaming provider failed before headers committed with retryable error, attempting fallback',
                );
                continue;
              }

              throw err;
            }
          }

          if (!streamResult) {
            if (lastStreamError) {
              throw lastStreamError;
            }
            throw new RelayProviderUnavailableError(
              'No provider candidate was able to start the stream.',
              { statusCode: 503 },
            );
          }

          const durationMs = Date.now() - startTime;
          const isCancelled = streamResult.aborted || (controller.signal.aborted && !timedOut);
          const isFailed = Boolean(streamResult.error) || isCancelled;
          const statusCode = isCancelled ? 499 : 200;
          const errorCategory = streamResult.error?.code ?? (isCancelled ? 'cancelled' : undefined);

          recordUsage({
            requestId: request.id,
            provider: actualProvider,
            model: actualModel,
            requestedModel: resolvedModel,
            attemptCount,
            stream: true,
            startedAt,
            durationMs,
            statusCode,
            success: !isFailed,
            ...(streamResult.usage?.promptTokens !== undefined
              ? { promptTokens: streamResult.usage.promptTokens }
              : {}),
            ...(streamResult.usage?.completionTokens !== undefined
              ? { completionTokens: streamResult.usage.completionTokens }
              : {}),
            ...(streamResult.usage?.totalTokens !== undefined
              ? { totalTokens: streamResult.usage.totalTokens }
              : {}),
            ...(errorCategory ? { errorCategory } : {}),
          });

          return reply;
        }

        // Non-streaming execution with fallback loop
        let response: ChatCompletionResponse | undefined;
        let lastChatError: unknown;

        for (let i = 0; i < candidates.length; i++) {
          const candidate = candidates[i]!;
          attemptCount = i + 1;
          actualProvider = candidate.provider.id;
          actualModel = candidate.modelInfo.id;

          if (controller.signal.aborted) {
            break;
          }

          const decision = circuitBreaker.beforeRequest(candidate.provider.id);
          if (!decision.allow) {
            request.log.warn(
              {
                provider: candidate.provider.id,
                state: decision.state,
                reason: decision.reason,
                retryAfterMs: decision.retryAfterMs,
              },
              'Circuit breaker rejected request for provider, skipping candidate',
            );
            lastChatError = new RelayProviderUnavailableError(
              `Provider "${candidate.provider.id}" circuit breaker is ${decision.state}.`,
              { statusCode: 503, details: { provider: candidate.provider.id } },
            );
            continue;
          }

          try {
            const candidateRequest = { ...normalizedRequest, model: candidate.modelInfo.id };
            response = await candidate.provider.chat(candidateRequest, {
              signal: controller.signal,
            });
            circuitBreaker.onSuccess(candidate.provider.id);
            break; // Success!
          } catch (err) {
            lastChatError = err;
            if (isCircuitBreakerFailure(err)) {
              circuitBreaker.onFailure(candidate.provider.id, err);
            }

            const canFallback =
              i + 1 < candidates.length &&
              !controller.signal.aborted &&
              !timedOut &&
              isRetryableError(err);

            if (canFallback) {
              request.log.warn(
                {
                  err,
                  attempt: attemptCount,
                  failedProvider: candidate.provider.id,
                  nextProvider: candidates[i + 1]?.provider.id,
                },
                'Non-streaming provider failed with retryable error, attempting fallback',
              );
              continue;
            }

            throw err;
          }
        }

        if (!response) {
          if (lastChatError) {
            throw lastChatError;
          }
          throw new RelayProviderUnavailableError(
            'No provider candidate was able to fulfill the request.',
            { statusCode: 503 },
          );
        }

        const durationMs = Date.now() - startTime;

        recordUsage({
          requestId: request.id,
          provider: actualProvider,
          model: actualModel,
          requestedModel: resolvedModel,
          attemptCount,
          stream: false,
          startedAt,
          durationMs,
          statusCode: 200,
          success: true,
          ...(response.usage?.promptTokens !== undefined
            ? { promptTokens: response.usage.promptTokens }
            : {}),
          ...(response.usage?.completionTokens !== undefined
            ? { completionTokens: response.usage.completionTokens }
            : {}),
          ...(response.usage?.totalTokens !== undefined
            ? { totalTokens: response.usage.totalTokens }
            : {}),
        });

        const openAiResponse = {
          id: response.id,
          object: 'chat.completion',
          created: response.created,
          model: resolvedModel,
          choices: [
            {
              index: 0,
              message: {
                role: response.message.role,
                content: response.message.content,
                ...(response.message.toolCalls ? { tool_calls: response.message.toolCalls } : {}),
              },
              finish_reason: response.finishReason,
            },
          ],
          ...(response.usage
            ? {
                usage: {
                  prompt_tokens: response.usage.promptTokens,
                  completion_tokens: response.usage.completionTokens,
                  total_tokens: response.usage.totalTokens,
                },
              }
            : {}),
        };

        return reply.status(200).send(openAiResponse);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        let statusCode = 500;
        let errorCategory = 'internal_error';

        const isClientCancelled =
          !timedOut &&
          (controller.signal.reason === 'client_disconnect' || isRequestCancelledError(err));

        if (timedOut) {
          statusCode = 504;
          errorCategory = 'request_timeout';
        } else if (isClientCancelled) {
          statusCode = 499;
          errorCategory = 'cancelled';
        } else if (isRelayError(err)) {
          statusCode = err.statusCode;
          errorCategory = err.code;
        }

        recordUsage({
          requestId: request.id,
          provider: actualProvider,
          model: actualModel,
          requestedModel: resolvedModel,
          attemptCount,
          stream: isStream,
          startedAt,
          durationMs,
          statusCode,
          success: false,
          errorCategory,
        });

        if (timedOut) {
          throw new RelayTimeoutError(
            `Request exceeded configured timeout of ${options.requestTimeoutMs}ms.`,
            {
              cause: err,
            },
          );
        }
        if (isClientCancelled && !isRequestCancelledError(err)) {
          throw new RelayRequestCancelledError('Client disconnected or request was cancelled.', {
            cause: err,
          });
        }
        throw err;
      } finally {
        clearTimeout(timer);
        request.raw.off('close', onSocketClose);
      }
    });
  };
}

function parseChatCompletionRequest(body: Record<string, unknown>): ChatCompletionRequest {
  const rawMessages = body['messages'] as Array<Record<string, unknown>>;
  const messages: NormalizedMessage[] = rawMessages.map((m) => {
    let content: string | readonly ContentPart[];
    if (typeof m['content'] === 'string') {
      content = m['content'];
    } else if (Array.isArray(m['content'])) {
      content = (m['content'] as Array<Record<string, unknown>>).map((part) => {
        if (part && part['type'] === 'image_url') {
          const imgObj = (part['imageUrl'] ?? part['image_url']) as
            Record<string, unknown> | undefined;
          const url = typeof imgObj?.['url'] === 'string' ? imgObj['url'] : '';
          const detail = imgObj?.['detail'] as 'auto' | 'low' | 'high' | undefined;
          return {
            type: 'image_url' as const,
            imageUrl: {
              url,
              ...(detail ? { detail } : {}),
            },
          };
        }
        if (part && part['type'] === 'text') {
          return {
            type: 'text' as const,
            text: String(part['text'] ?? ''),
          };
        }
        return part as unknown as ContentPart;
      });
    } else {
      content = '';
    }

    const msg: {
      role: NormalizedMessage['role'];
      content: string | readonly ContentPart[];
      name?: string;
      toolCallId?: string;
      toolCalls?: readonly ToolCall[];
    } = {
      role: String(m['role'] ?? 'user') as NormalizedMessage['role'],
      content,
    };
    if (typeof m['name'] === 'string') msg.name = m['name'];
    if (typeof m['tool_call_id'] === 'string') msg.toolCallId = m['tool_call_id'];
    if (Array.isArray(m['tool_calls'])) {
      msg.toolCalls = m['tool_calls'].map((tc: Record<string, unknown>) => ({
        id: String(tc['id'] ?? ''),
        type: 'function' as const,
        function: {
          name: String((tc['function'] as Record<string, unknown>)?.['name'] ?? ''),
          arguments: String((tc['function'] as Record<string, unknown>)?.['arguments'] ?? ''),
        },
      }));
    }
    return msg;
  });

  const req: {
    model: string;
    messages: readonly NormalizedMessage[];
    temperature?: number;
    topP?: number;
    maxTokens?: number;
    stream?: boolean;
    tools?: readonly ToolDefinition[];
    toolChoice?: ToolChoice;
    responseFormat?: ResponseFormat;
    stop?: readonly string[];
    user?: string;
  } = {
    model: String(body['model']),
    messages,
  };

  if (typeof body['temperature'] === 'number') req.temperature = body['temperature'];
  if (typeof body['top_p'] === 'number') req.topP = body['top_p'];
  if (typeof body['max_tokens'] === 'number') req.maxTokens = body['max_tokens'];
  if (typeof body['stream'] === 'boolean') req.stream = body['stream'];
  if (Array.isArray(body['tools'])) req.tools = body['tools'] as ToolDefinition[];
  if (body['tool_choice']) req.toolChoice = body['tool_choice'] as ToolChoice;
  if (body['response_format']) req.responseFormat = body['response_format'] as ResponseFormat;
  if (Array.isArray(body['stop'])) req.stop = body['stop'] as string[];
  if (typeof body['user'] === 'string') req.user = body['user'];

  return req;
}
