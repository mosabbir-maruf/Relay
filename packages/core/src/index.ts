// Domain Types
export type {
  ChatCompletionChunk,
  ChatCompletionChunkDelta,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChunkToolCallDelta,
  ContentPart,
  FinishReason,
  ImageContentPart,
  MessageRole,
  NormalizedMessage,
  ResponseFormat,
  TextContentPart,
  TokenUsage,
  ToolCall,
  ToolChoice,
  ToolDefinition,
} from './types/chat.js';

export type { ModelCapabilities, ModelInfo } from './types/model.js';
export { isMultimodalModelId } from './types/model.js';

// Interfaces & Contracts
export type {
  LLMProvider,
  ProviderCapabilities,
  ProviderHealth,
  RequestOptions,
} from './interfaces/provider.js';

// Error Hierarchy & Type Guards
export {
  RelayAuthenticationError,
  RelayContextWindowExceededError,
  RelayError,
  RelayInvalidRequestError,
  RelayProviderUnavailableError,
  RelayRateLimitError,
  RelayRequestCancelledError,
  RelayTimeoutError,
  isRateLimitError,
  isRelayError,
  isRequestCancelledError,
} from './errors/relay-error.js';

export type {
  OpenAIErrorResponse,
  OpenAIErrorShape,
  RelayErrorOptions,
} from './errors/relay-error.js';

// Telemetry & Observability
export type { InMemoryUsageSinkOptions, UsageRecord, UsageSink } from './telemetry/usage-record.js';
export { InMemoryUsageSink, NoopUsageSink } from './telemetry/usage-record.js';

// Rate Limiting
export type {
  InMemoryRateLimiterOptions,
  RateLimitDecision,
  RateLimitInput,
  RateLimiter,
} from './rate-limiting/rate-limiter.js';
export { InMemoryRateLimiter, NoopRateLimiter } from './rate-limiting/rate-limiter.js';

// Routing & Fallback Policy
export type {
  FallbackTarget,
  ModelRoutingRule,
  RoutingDecision,
  RoutingPolicy,
  RoutingRequest,
} from './routing/routing-policy.js';
export { isRetryableError } from './routing/routing-policy.js';

// Circuit Breaker
export type {
  CircuitBreaker,
  CircuitBreakerDecision,
  CircuitState,
  InMemoryCircuitBreakerOptions,
} from './circuit-breaker/circuit-breaker.js';
export {
  InMemoryCircuitBreaker,
  NoopCircuitBreaker,
  isCircuitBreakerFailure,
} from './circuit-breaker/circuit-breaker.js';
