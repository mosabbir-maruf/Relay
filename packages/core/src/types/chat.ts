export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

export interface TextContentPart {
  readonly type: 'text';
  readonly text: string;
}

export interface ImageContentPart {
  readonly type: 'image_url';
  readonly imageUrl: {
    readonly url: string;
    readonly detail?: 'auto' | 'low' | 'high';
  };
}

export type ContentPart = TextContentPart | ImageContentPart;

export interface ToolCall {
  readonly id: string;
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly arguments: string;
  };
}

export interface NormalizedMessage {
  readonly role: MessageRole;
  readonly content: string | readonly ContentPart[];
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolDefinition {
  readonly type: 'function';
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export type ResponseFormat =
  | { readonly type: 'text' }
  | { readonly type: 'json_object' }
  | { readonly type: 'json_schema'; readonly jsonSchema: Record<string, unknown> };

export type ToolChoice =
  | 'none'
  | 'auto'
  | 'required'
  | { readonly type: 'function'; readonly function: { readonly name: string } };

export interface ChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly NormalizedMessage[];
  readonly temperature?: number;
  readonly topP?: number;
  readonly maxTokens?: number;
  readonly stream?: boolean;
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: ToolChoice;
  readonly responseFormat?: ResponseFormat;
  readonly stop?: readonly string[];
  readonly user?: string;
}

export interface TokenUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'error';

export interface ChatCompletionResponse {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly message: NormalizedMessage;
  readonly finishReason: FinishReason;
  readonly usage: TokenUsage;
  readonly created: number;
}

export interface ChunkToolCallDelta {
  readonly index: number;
  readonly id?: string;
  readonly type?: 'function';
  readonly function?: {
    readonly name?: string;
    readonly arguments?: string;
  };
}

export interface ChatCompletionChunkDelta {
  readonly role?: MessageRole;
  readonly content?: string;
  readonly toolCalls?: readonly ChunkToolCallDelta[];
}

export interface ChatCompletionChunk {
  readonly id: string;
  readonly model: string;
  readonly provider: string;
  readonly delta: ChatCompletionChunkDelta;
  readonly finishReason: FinishReason | null;
  readonly usage?: TokenUsage;
  readonly created: number;
}
