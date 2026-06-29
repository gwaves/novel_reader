import { join } from 'node:path'
import { homedir } from 'node:os'

export type GatewayConfig = ReturnType<typeof loadConfig>

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = {
    GATEWAY_HOST: readString(env, 'GATEWAY_HOST', '127.0.0.1'),
    GATEWAY_PORT: readInteger(env, 'GATEWAY_PORT', 6180, { min: 1, max: 65535 }),
    GATEWAY_PUBLIC_BASE_URL: readOptionalString(env, 'GATEWAY_PUBLIC_BASE_URL'),
    GATEWAY_ENV: readEnum(env, 'GATEWAY_ENV', ['development', 'test', 'production'] as const, 'development'),
    GATEWAY_LOG_LEVEL: readEnum(
      env,
      'GATEWAY_LOG_LEVEL',
      ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const,
      'info',
    ),
    GATEWAY_DATA_DIR: readString(env, 'GATEWAY_DATA_DIR', join(homedir(), '.novel_reader_gateway')),
    GATEWAY_AUDIO_DIR: readOptionalString(env, 'GATEWAY_AUDIO_DIR'),
    GATEWAY_ADMIN_UI_DIR: readOptionalString(env, 'GATEWAY_ADMIN_UI_DIR'),
    GATEWAY_MAX_BODY_BYTES: readInteger(env, 'GATEWAY_MAX_BODY_BYTES', 50 * 1024 * 1024, { min: 1024 }),
    GATEWAY_DEV_ACCESS_TOKEN: readOptionalString(env, 'GATEWAY_DEV_ACCESS_TOKEN'),
    GATEWAY_ADMIN_ACCESS_TOKEN: readOptionalString(env, 'GATEWAY_ADMIN_ACCESS_TOKEN'),
    GATEWAY_MOBILE_ACCESS_TOKEN: readOptionalString(env, 'GATEWAY_MOBILE_ACCESS_TOKEN'),
    GATEWAY_AUTH_TOKEN_SECRET: readOptionalString(env, 'GATEWAY_AUTH_TOKEN_SECRET'),
    GATEWAY_CORS_ORIGINS: readString(env, 'GATEWAY_CORS_ORIGINS', ''),
    GATEWAY_RATE_LIMIT_MAX: readInteger(env, 'GATEWAY_RATE_LIMIT_MAX', 120, { min: 1 }),
    GATEWAY_RATE_LIMIT_WINDOW: readString(env, 'GATEWAY_RATE_LIMIT_WINDOW', '1 minute'),
    GATEWAY_AI_BASE_URL: readOptionalString(env, 'GATEWAY_AI_BASE_URL'),
    GATEWAY_AI_API_KEY: readOptionalString(env, 'GATEWAY_AI_API_KEY'),
    GATEWAY_AI_MODEL: readOptionalString(env, 'GATEWAY_AI_MODEL'),
    GATEWAY_EMBEDDING_PROVIDER: readEnum(
      env,
      'GATEWAY_EMBEDDING_PROVIDER',
      ['openai-compatible', 'openai', 'ollama'] as const,
      'openai-compatible',
    ),
    GATEWAY_EMBEDDING_BASE_URL: readOptionalString(env, 'GATEWAY_EMBEDDING_BASE_URL'),
    GATEWAY_EMBEDDING_API_KEY: readOptionalString(env, 'GATEWAY_EMBEDDING_API_KEY'),
    GATEWAY_EMBEDDING_MODEL: readOptionalString(env, 'GATEWAY_EMBEDDING_MODEL'),
    GATEWAY_UPSTREAM_TIMEOUT_MS: readInteger(env, 'GATEWAY_UPSTREAM_TIMEOUT_MS', 60_000, { min: 1000 }),
    GATEWAY_OBJECT_STORAGE_ENDPOINT: readOptionalString(env, 'GATEWAY_OBJECT_STORAGE_ENDPOINT'),
    GATEWAY_OBJECT_STORAGE_BUCKET: readOptionalString(env, 'GATEWAY_OBJECT_STORAGE_BUCKET'),
  }
  const corsOrigins = parsed.GATEWAY_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return {
    host: parsed.GATEWAY_HOST,
    port: parsed.GATEWAY_PORT,
    publicBaseUrl: parsed.GATEWAY_PUBLIC_BASE_URL,
    environment: parsed.GATEWAY_ENV,
    logLevel: parsed.GATEWAY_LOG_LEVEL,
    dataDir: parsed.GATEWAY_DATA_DIR,
    audioDir: parsed.GATEWAY_AUDIO_DIR ?? join(parsed.GATEWAY_DATA_DIR, 'audio'),
    adminUiDir: parsed.GATEWAY_ADMIN_UI_DIR,
    maxBodyBytes: parsed.GATEWAY_MAX_BODY_BYTES,
    auth: {
      devAccessToken: parsed.GATEWAY_DEV_ACCESS_TOKEN,
      adminAccessToken: parsed.GATEWAY_ADMIN_ACCESS_TOKEN ?? parsed.GATEWAY_DEV_ACCESS_TOKEN,
      mobileAccessToken: parsed.GATEWAY_MOBILE_ACCESS_TOKEN ?? parsed.GATEWAY_DEV_ACCESS_TOKEN,
      tokenSecretConfigured: Boolean(parsed.GATEWAY_AUTH_TOKEN_SECRET),
    },
    cors: {
      origins: corsOrigins,
    },
    rateLimit: {
      max: parsed.GATEWAY_RATE_LIMIT_MAX,
      timeWindow: parsed.GATEWAY_RATE_LIMIT_WINDOW,
    },
    upstreams: {
      ai: {
        baseUrl: parsed.GATEWAY_AI_BASE_URL,
        apiKey: parsed.GATEWAY_AI_API_KEY,
        apiKeyConfigured: Boolean(parsed.GATEWAY_AI_API_KEY),
        model: parsed.GATEWAY_AI_MODEL,
      },
      embeddings: {
        provider: parsed.GATEWAY_EMBEDDING_PROVIDER,
        baseUrl: parsed.GATEWAY_EMBEDDING_BASE_URL,
        apiKey: parsed.GATEWAY_EMBEDDING_API_KEY,
        apiKeyConfigured: Boolean(parsed.GATEWAY_EMBEDDING_API_KEY),
        model: parsed.GATEWAY_EMBEDDING_MODEL,
      },
    },
    upstreamTimeoutMs: parsed.GATEWAY_UPSTREAM_TIMEOUT_MS,
    objectStorage: {
      endpoint: parsed.GATEWAY_OBJECT_STORAGE_ENDPOINT,
      bucket: parsed.GATEWAY_OBJECT_STORAGE_BUCKET,
    },
  } as const
}

function readString(env: NodeJS.ProcessEnv, key: string, fallback: string) {
  return env[key]?.trim() || fallback
}

function readOptionalString(env: NodeJS.ProcessEnv, key: string) {
  const value = env[key]?.trim()
  return value ? value : undefined
}

function readInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  limits: { min?: number; max?: number } = {},
) {
  const rawValue = env[key]?.trim()
  const value = rawValue ? Number(rawValue) : fallback
  if (!Number.isInteger(value)) {
    throw new Error(`${key} must be an integer.`)
  }
  if (limits.min !== undefined && value < limits.min) {
    throw new Error(`${key} must be greater than or equal to ${limits.min}.`)
  }
  if (limits.max !== undefined && value > limits.max) {
    throw new Error(`${key} must be less than or equal to ${limits.max}.`)
  }
  return value
}

function readEnum<TValue extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  values: readonly TValue[],
  fallback: TValue,
) {
  const value = (env[key]?.trim() || fallback) as TValue
  if (!values.includes(value)) {
    throw new Error(`${key} must be one of: ${values.join(', ')}.`)
  }
  return value
}
