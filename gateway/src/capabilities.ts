import type { GatewayConfig } from './config.js'

export function buildCapabilities(config: GatewayConfig) {
  const aiConfigured = Boolean(config.upstreams.ai.baseUrl && config.upstreams.ai.apiKeyConfigured)
  const embeddingProvider = config.upstreams.embeddings.provider
  const embeddingsConfigured = Boolean(
    config.upstreams.embeddings.baseUrl &&
      (embeddingProvider === 'ollama' || config.upstreams.embeddings.apiKeyConfigured),
  )
  return {
    service: 'novel-reader-gateway',
    version: '0.1.0',
    auth: {
      requiredByDefault: true,
      mode: config.auth.adminAccessToken || config.auth.mobileAccessToken ? 'development-static-token' : 'not-configured',
      adminTokenConfigured: Boolean(config.auth.adminAccessToken),
      mobileTokenConfigured: Boolean(config.auth.mobileAccessToken),
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
        available: true,
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
        reason: embeddingsConfigured
          ? undefined
          : embeddingProvider === 'ollama'
            ? 'Ollama embedding upstream base URL is not configured'
            : 'embedding upstream base URL and API key are not configured',
      },
      audio: {
        available: true,
        mode: 'local-directory',
      },
    },
  }
}
