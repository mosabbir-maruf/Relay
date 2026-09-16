import { resolve } from 'node:path';
import { z } from 'zod';
import type { ModelInfo, ModelRoutingRule } from '@relay/core';

function tryLoadEnv(): void {
  if (typeof process.loadEnvFile !== 'function') return;

  try {
    process.loadEnvFile('.env');
    return;
  } catch {
    // Continue
  }

  let currentDir = process.cwd();
  for (let i = 0; i < 3; i++) {
    const parentDir = resolve(currentDir, '..');
    const envPath = resolve(parentDir, '.env');
    try {
      process.loadEnvFile(envPath);
      return;
    } catch {
      currentDir = parentDir;
    }
  }
}

const optionalTrimmedString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().min(1).optional(),
);

/**
 * Checks if a hostname targets known cloud metadata services or link-local ranges (RFC 3927).
 */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'metadata.google.internal' || host === 'metadata.google') {
    return true;
  }
  if (host === '169.254.169.254' || host === '100.100.100.200' || host === 'fd00:ec2::254') {
    return true;
  }
  if (host.startsWith('fe80:')) {
    return true;
  }
  // Check IPv4 link-local (169.254.0.0/16)
  const parts = host.split('.');
  if (parts.length === 4) {
    const p0 = parseInt(parts[0]!, 10);
    const p1 = parseInt(parts[1]!, 10);
    if (p0 === 169 && p1 === 254) {
      return true;
    }
  }
  return false;
}

/**
 * Checks if a hostname targets RFC 1918 private IP ranges or loopback destinations.
 */
export function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '0.0.0.0' || host === '::1') {
    return true;
  }
  const parts = host.split('.');
  if (parts.length === 4) {
    const p0 = parseInt(parts[0]!, 10);
    const p1 = parseInt(parts[1]!, 10);
    if (p0 === 127) return true; // 127.0.0.0/8
    if (p0 === 10) return true; // 10.0.0.0/8
    if (p0 === 172 && p1 >= 16 && p1 <= 31) return true; // 172.16.0.0/12
    if (p0 === 192 && p1 === 168) return true; // 192.168.0.0/16
  }
  return false;
}

const httpUrlSchema = z
  .string()
  .url()
  .refine(
    (val) => {
      try {
        const u = new URL(val);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          return false;
        }
        if (isCloudMetadataHost(u.hostname)) {
          return false;
        }
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        'URL must use http: or https: protocol and must not target cloud metadata endpoints.',
    },
  );

const optionalHttpUrlString = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  httpUrlSchema.optional(),
);

export const EnvironmentSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(60000),
  RELAY_API_KEY: optionalTrimmedString,
  ENFORCE_PUBLIC_PROVIDERS: z.preprocess(
    (val) => val === 'true' || val === true || val === '1',
    z.boolean().default(false),
  ),

  // Google Gemini Configuration
  GEMINI_API_KEY: optionalTrimmedString,
  GEMINI_BASE_URL: httpUrlSchema.default('https://generativelanguage.googleapis.com'),
  GEMINI_MODELS: optionalTrimmedString,

  // Generic OpenAI-Compatible Configuration
  OPENAI_COMPATIBLE_BASE_URL: optionalHttpUrlString,
  OPENAI_COMPATIBLE_API_KEY: optionalTrimmedString,
  OPENAI_COMPATIBLE_NAME: z.preprocess(
    (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
    z.string().default('openai-compatible'),
  ),
  OPENAI_COMPATIBLE_MODELS: optionalTrimmedString,

  // Qwen (vLLM OpenAI-Compatible) Configuration
  QWEN_BASE_URL: optionalHttpUrlString,
  QWEN_API_KEY: optionalTrimmedString,
  QWEN_MODEL: optionalTrimmedString,
  QWEN_MODELS: optionalTrimmedString,

  // Additional Extensible OpenAI-Compatible Backends (JSON format)
  ADDITIONAL_PROVIDERS: optionalTrimmedString,

  // Rate Limiting Configuration
  RATE_LIMIT_ENABLED: z.preprocess(
    (val) => val === 'true' || val === true || val === '1',
    z.boolean().default(false),
  ),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_KEY_STRATEGY: z
    .enum(['client_or_ip', 'client_only', 'ip_only'])
    .default('client_or_ip'),
  RATE_LIMIT_MAX_KEYS: z.coerce.number().int().positive().default(10000),

  // Network & Reverse Proxy Security
  TRUST_PROXY: z.preprocess(
    (val) => val === 'true' || val === true || val === '1',
    z.boolean().default(false),
  ),

  // Model Routing & Fallback Policies (JSON format)
  ROUTING_POLICIES: optionalTrimmedString,

  // Circuit Breaker Configuration
  CIRCUIT_BREAKER_ENABLED: z.preprocess(
    (val) => val === 'true' || val === true || val === '1',
    z.boolean().default(false),
  ),
  CIRCUIT_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_RESET_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  CIRCUIT_BREAKER_HALF_OPEN_MAX_REQUESTS: z.coerce.number().int().positive().default(1),
});

export type EnvironmentConfig = z.infer<typeof EnvironmentSchema>;

export interface OpenAiCompatibleBackendConfig {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly models: readonly string[];
}

export interface RelayConfig {
  readonly env: EnvironmentConfig;
  readonly defaultModels: readonly ModelInfo[];
  readonly openAiCompatibleBackends: readonly OpenAiCompatibleBackendConfig[];
  readonly routingPolicies: readonly ModelRoutingRule[];
}

/**
 * Validates environment variables and constructs an immutable RelayConfig.
 */
export function loadConfig(
  envInput: Record<string, string | undefined> = process.env,
): RelayConfig {
  if (envInput === process.env) {
    tryLoadEnv();
  }
  const parsed = EnvironmentSchema.safeParse(envInput);
  if (!parsed.success) {
    const errorDetails = parsed.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join(', ');
    throw new Error(`Invalid environment configuration: ${errorDetails}`);
  }

  const env = parsed.data;

  // Build configured model list dynamically based on enabled providers
  const defaultModels: ModelInfo[] = [];

  if (env.GEMINI_API_KEY) {
    const modelIds = env.GEMINI_MODELS
      ? env.GEMINI_MODELS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : ['gemini-2.5-flash', 'gemini-flash-latest', 'gemini-2.5-pro', 'gemini-3.8-flash'];

    for (const modelId of modelIds) {
      defaultModels.push({
        id: modelId,
        name: modelId,
        provider: 'gemini',
        capabilities: {
          supportsStreaming: true,
          supportsToolCalling: true,
          supportsVision: true,
          supportsStructuredOutput: true,
          maxContextTokens: 1048576,
          maxOutputTokens: 8192,
        },
      });
    }
  }

  // Extensible OpenAI-compatible backends list
  const openAiCompatibleBackends: OpenAiCompatibleBackendConfig[] = [];

  if (env.OPENAI_COMPATIBLE_BASE_URL) {
    const modelIds = env.OPENAI_COMPATIBLE_MODELS
      ? env.OPENAI_COMPATIBLE_MODELS.split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : ['openai-compatible-default'];

    const backend: {
      id: string;
      name: string;
      baseUrl: string;
      apiKey?: string;
      models: readonly string[];
    } = {
      id: 'openai-compatible',
      name: env.OPENAI_COMPATIBLE_NAME,
      baseUrl: env.OPENAI_COMPATIBLE_BASE_URL,
      models: modelIds,
    };
    if (env.OPENAI_COMPATIBLE_API_KEY) {
      backend.apiKey = env.OPENAI_COMPATIBLE_API_KEY;
    }
    openAiCompatibleBackends.push(backend);
  }

  if (env.QWEN_BASE_URL) {
    const rawModels: string[] = [];
    if (env.QWEN_MODEL) {
      rawModels.push(env.QWEN_MODEL);
    }
    if (env.QWEN_MODELS) {
      const split = env.QWEN_MODELS.split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const m of split) {
        if (!rawModels.includes(m)) {
          rawModels.push(m);
        }
      }
    }
    const modelIds = rawModels.length > 0 ? rawModels : ['qwen3-coder-30b'];

    const backend: {
      id: string;
      name: string;
      baseUrl: string;
      apiKey?: string;
      models: readonly string[];
    } = {
      id: 'qwen',
      name: 'Qwen',
      baseUrl: env.QWEN_BASE_URL,
      models: modelIds,
    };
    if (env.QWEN_API_KEY) {
      backend.apiKey = env.QWEN_API_KEY;
    }
    openAiCompatibleBackends.push(backend);
  }

  if (env.ADDITIONAL_PROVIDERS) {
    try {
      const parsedBackends = JSON.parse(env.ADDITIONAL_PROVIDERS);
      if (Array.isArray(parsedBackends)) {
        for (const b of parsedBackends) {
          if (b && typeof b.id === 'string' && typeof b.baseUrl === 'string') {
            const models = Array.isArray(b.models)
              ? b.models.filter((m: unknown) => typeof m === 'string')
              : [b.id];
            const backend: {
              id: string;
              name: string;
              baseUrl: string;
              apiKey?: string;
              models: readonly string[];
            } = {
              id: b.id,
              name: typeof b.name === 'string' ? b.name : b.id,
              baseUrl: b.baseUrl,
              models,
            };
            if (typeof b.apiKey === 'string') {
              backend.apiKey = b.apiKey;
            }
            openAiCompatibleBackends.push(backend);
          }
        }
      }
    } catch {
      throw new Error('Invalid JSON format in ADDITIONAL_PROVIDERS environment variable.');
    }
  }

  for (const backend of openAiCompatibleBackends) {
    for (const modelId of backend.models) {
      defaultModels.push({
        id: modelId,
        name: modelId,
        provider: backend.id,
        capabilities: {
          supportsStreaming: true,
          supportsToolCalling: true,
          supportsVision: false,
          supportsStructuredOutput: true,
          maxContextTokens: 32768,
          maxOutputTokens: 4096,
        },
      });
    }
  }

  if (env.ENFORCE_PUBLIC_PROVIDERS) {
    const checkUrl = (urlStr: string | undefined, fieldName: string) => {
      if (!urlStr) return;
      try {
        const u = new URL(urlStr);
        if (isPrivateOrLoopbackHost(u.hostname)) {
          throw new Error(
            `"${fieldName}" (${urlStr}) targets a private or loopback destination while ENFORCE_PUBLIC_PROVIDERS is enabled.`,
          );
        }
      } catch (err) {
        if (err instanceof Error && err.message.includes('targets a private or loopback')) {
          throw err;
        }
      }
    };

    checkUrl(env.GEMINI_BASE_URL, 'GEMINI_BASE_URL');
    checkUrl(env.OPENAI_COMPATIBLE_BASE_URL, 'OPENAI_COMPATIBLE_BASE_URL');
    checkUrl(env.QWEN_BASE_URL, 'QWEN_BASE_URL');
    for (const b of openAiCompatibleBackends) {
      checkUrl(b.baseUrl, `ADDITIONAL_PROVIDERS backend "${b.id}"`);
    }
  }

  // Parse optional routing policies and model aliases
  const routingPolicies: ModelRoutingRule[] = [];
  if (env.ROUTING_POLICIES) {
    try {
      const parsedPolicies = JSON.parse(env.ROUTING_POLICIES);
      if (Array.isArray(parsedPolicies)) {
        for (const p of parsedPolicies) {
          if (p && typeof p.model === 'string' && typeof p.primary === 'string') {
            const fallbacks = Array.isArray(p.fallbacks)
              ? p.fallbacks.filter((f: unknown) => typeof f === 'string')
              : undefined;
            routingPolicies.push({
              model: p.model.trim(),
              primary: p.primary.trim(),
              ...(fallbacks ? { fallbacks } : {}),
            });
          }
        }
      }
    } catch {
      throw new Error('Invalid JSON format in ROUTING_POLICIES environment variable.');
    }
  }

  return {
    env,
    defaultModels,
    openAiCompatibleBackends,
    routingPolicies,
  };
}
