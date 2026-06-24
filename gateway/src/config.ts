import { z } from 'zod'

const optionalTrimmedString = z
  .string()
  .trim()
  .transform((value) => (value.length > 0 ? value : undefined))
  .optional()

const envSchema = z.object({
  GATEWAY_HOST: z.string().trim().default('127.0.0.1'),
  GATEWAY_PORT: z.coerce.number().int().min(1).max(65535).default(6180),
  GATEWAY_PUBLIC_BASE_URL: optionalTrimmedString,
  GATEWAY_ENV: z.enum(['development', 'test', 'production']).default('development'),
  GATEWAY_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GATEWAY_DEV_ACCESS_TOKEN: optionalTrimmedString,
  GATEWAY_AUTH_TOKEN_SECRET: optionalTrimmedString,
  GATEWAY_CORS_ORIGINS: z.string().trim().default(''),
  GATEWAY_RATE_LIMIT_MAX: z.coerce.number().int().min(1).default(120),
  GATEWAY_RATE_LIMIT_WINDOW: z.string().trim().default('1 minute'),
  GATEWAY_AI_BASE_URL: optionalTrimmedString,
  GATEWAY_AI_API_KEY: optionalTrimmedString,
  GATEWAY_EMBEDDING_BASE_URL: optionalTrimmedString,
  GATEWAY_EMBEDDING_API_KEY: optionalTrimmedString,
  GATEWAY_OBJECT_STORAGE_ENDPOINT: optionalTrimmedString,
  GATEWAY_OBJECT_STORAGE_BUCKET: optionalTrimmedString,
})

export type GatewayConfig = ReturnType<typeof loadConfig>

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.parse(env)
  const corsOrigins = parsed.GATEWAY_CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)

  return {
    host: parsed.GATEWAY_HOST,
    port: parsed.GATEWAY_PORT,
    publicBaseUrl: parsed.GATEWAY_PUBLIC_BASE_URL,
    environment: parsed.GATEWAY_ENV,
    logLevel: parsed.GATEWAY_LOG_LEVEL,
    auth: {
      devAccessToken: parsed.GATEWAY_DEV_ACCESS_TOKEN,
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
        apiKeyConfigured: Boolean(parsed.GATEWAY_AI_API_KEY),
      },
      embeddings: {
        baseUrl: parsed.GATEWAY_EMBEDDING_BASE_URL,
        apiKeyConfigured: Boolean(parsed.GATEWAY_EMBEDDING_API_KEY),
      },
    },
    objectStorage: {
      endpoint: parsed.GATEWAY_OBJECT_STORAGE_ENDPOINT,
      bucket: parsed.GATEWAY_OBJECT_STORAGE_BUCKET,
    },
  } as const
}
