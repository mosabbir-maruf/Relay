export interface ModelCapabilities {
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsVision: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
  /** Optional estimated tokens consumed per image for context budget calculation */
  readonly imageTokens?: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly capabilities: ModelCapabilities;
  readonly created?: number;
  readonly ownedBy?: string;
  /** Optional backend/vLLM metadata extension */
  readonly max_model_len?: number;
}
