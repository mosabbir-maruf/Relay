export interface ModelCapabilities {
  readonly supportsStreaming: boolean;
  readonly supportsToolCalling: boolean;
  readonly supportsVision: boolean;
  readonly supportsStructuredOutput: boolean;
  readonly maxContextTokens: number;
  readonly maxOutputTokens: number;
}

export interface ModelInfo {
  readonly id: string;
  readonly name: string;
  readonly provider: string;
  readonly capabilities: ModelCapabilities;
  readonly created?: number;
  readonly ownedBy?: string;
}
