import type { GatewayConfig } from './config.js'

export function buildCapabilities(config: GatewayConfig) {
  const aiConfigured = Boolean(config.upstreams.ai.baseUrl && config.upstreams.ai.apiKeyConfigured)
  const embeddingsConfigured = Boolean(
    config.upstreams.embeddings.baseUrl && config.upstreams.embeddings.apiKeyConfigured,
  )
  const objectStorageConfigured = Boolean(config.objectStorage.endpoint && config.objectStorage.bucket)

  return {
    service: 'novel-reader-gateway',
    version: '0.1.0',
    auth: {
      requiredByDefault: true,
      mode: config.auth.devAccessToken ? 'development-static-token' : 'not-configured',
      tokenSecretConfigured: config.auth.tokenSecretConfigured,
    },
    limits: {
      globalRateLimit: {
        max: config.rateLimit.max,
        timeWindow: config.rateLimit.timeWindow,
      },
    },
    features: {
      books: {
        available: false,
        reason: 'book data API is planned for Phase 3',
      },
      progress: {
        available: false,
        reason: 'reading progress API is planned for Phase 3',
      },
      aiSearch: {
        available: aiConfigured,
        reason: aiConfigured ? undefined : 'AI upstream base URL and API key are not configured',
      },
      embeddings: {
        available: embeddingsConfigured,
        reason: embeddingsConfigured ? undefined : 'embedding upstream base URL and API key are not configured',
      },
      audio: {
        available: objectStorageConfigured,
        reason: objectStorageConfigured ? undefined : 'object storage endpoint and bucket are not configured',
      },
    },
  }
}
